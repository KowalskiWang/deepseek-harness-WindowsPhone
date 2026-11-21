// Offline unit tests for the DSH Mobile core (node --test tests/).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSseParser } from '../src/core/llm/sse.js'
import { toWire as anthropicWire, effortFields } from '../src/core/llm/anthropic.js'
import { toWire as openaiWire } from '../src/core/llm/openai.js'
import { parseDeepseekListing } from '../src/core/llm/index.js'
import { retryDecision, classifyHttpError } from '../src/core/llm/errors.js'
import { Vfs, MemoryBackend } from '../src/core/vfs.js'
import { readTool, writeTool, editTool, globTool, grepTool } from '../src/core/tools/fs-tools.js'
import { applyPatchText } from '../src/core/tools/patch.js'
import { runToolCall, executeBatch, validateArgs } from '../src/core/tools/runtime.js'
import { globMatcher, resolve, parseGitignore, isIgnored } from '../src/core/paths.js'
import { parseRrule, nextOccurrence } from '../src/core/rrule.js'
import { Session, closeOpenTurn } from '../src/core/session.js'
import { chooseRange, budget } from '../src/core/compaction.js'
import { maskSecret, deepMerge } from '../src/core/settings.js'
import { htmlToMarkdown } from '../src/core/html-markdown.js'
import { parseFrontmatter, renderSkillCatalog } from '../src/core/skills.js'
import { parseBlocks, parseInline } from '../src/ui/markdown-parse.js'
import { utf8Encode, utf8DecodeStrict, bytesToBase64, base64ToBytes } from '../src/core/util.js'
import { unifiedDiff } from '../src/core/diff.js'
import { runCode } from '../src/sandbox/interp.js'

function fsExec(mode = 'workspace-write') {
  const vfs = new Vfs()
  vfs.mount('/workspaces', new MemoryBackend())
  vfs.mount('/tmp', new MemoryBackend())
  vfs.mount('/app', new MemoryBackend())
  const approvals = []
  return {
    vfs, cwd: '/workspaces/w', sessionId: 's1', toolName: 'edit', approvals,
    sandbox: { mode, approvalPolicy: 'ask', workspaceRoot: '/workspaces/w', writableRoots: ['/tmp'] },
    requestApproval: async (req) => { approvals.push(req); return 'allowed-once' },
  }
}

test('SSE parser handles CRLF, comments and split chunks', () => {
  const events = []
  let activity = 0
  const p = createSseParser(e => events.push(e), () => activity++)
  p.push('\ufeffevent: message_start\r\ndata: {"a"')
  p.push(':1}\r\n\r\n: ping\n\nevent: x\ndata: line1\ndata: line2\n\n')
  p.end()
  assert.equal(events.length, 2)
  assert.equal(events[0].event, 'message_start')
  assert.deepEqual(JSON.parse(events[0].data), { a: 1 })
  assert.equal(events[1].data, 'line1\nline2')
  assert.ok(activity >= 2)
})

test('Anthropic wire: tool results first in user role, merged roles, signatures per model', () => {
  const model = { id: 'deepseek-flash', systemPromptUpdate: 'in-history' }
  const w = anthropicWire([
    { role: 'system', content: [{ type: 'text', text: 'S1' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'thinking', text: 'hmm', signature: 'sig', model: 'deepseek-flash' }, { type: 'text', text: '' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"a"}' }] },
    { role: 'tool', callId: 'c1', name: 'read', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'text', text: 'reminder' }] },
    { role: 'system', content: [{ type: 'text', text: 'S2' }] },
    { role: 'assistant', content: [{ type: 'thinking', text: 'x', signature: 'other', model: 'deepseek-v4-pro' }, { type: 'text', text: 'done' }] },
  ], model)
  assert.equal(w.system, 'S1')
  assert.equal(w.messages[1].role, 'assistant')
  assert.deepEqual(w.messages[1].content.map(b => b.type), ['thinking', 'tool_use'])
  assert.equal(w.messages[1].content[0].signature, 'sig')
  assert.equal(w.messages[2].role, 'user')
  assert.deepEqual(w.messages[2].content.map(b => b.type), ['tool_result', 'text'])
  assert.equal(w.messages[3].role, 'system') // in-history system update
  assert.equal(w.messages[4].content[0].signature, undefined) // different model → no signature
  assert.deepEqual(effortFields({ kind: 'deepseek' }, model, 'off'), { thinking: { type: 'disabled' } })
  assert.deepEqual(effortFields({ kind: 'deepseek' }, model, 'max'), { thinking: { type: 'enabled' }, output_config: { effort: 'max' } })
})

test('OpenAI wire keeps reasoning_content and tool messages', () => {
  const route = { provider: { compat: {} }, model: { id: 'm' } }
  const w = openaiWire([
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: [{ type: 'thinking', text: 'r' }, { type: 'tool-call', id: 't1', name: 'f', arguments: '{}' }] },
    { role: 'tool', callId: 't1', content: [{ type: 'text', text: 'res' }] },
  ], route)
  assert.equal(w[1].reasoning_content, 'r')
  assert.equal(w[1].tool_calls[0].function.name, 'f')
  assert.equal(w[2].role, 'tool')
})

test('DeepSeek listing parse follows upstream gating', () => {
  const models = parseDeepseekListing({ data: [
    { id: 'deepseek-flash', name: 'F', context_window: 100, max_output_tokens: 393216, input_modalities: ['text', 'image'], api_capabilities: { anthropic_messages: { system_prompt_update: 'in-history' } } },
    { id: 'no-caps', api_capabilities: {} },
    { id: 'unknown-new' , api_capabilities: { anthropic_messages: {} } },
  ] })
  assert.equal(models.length, 1)
  assert.equal(models[0].maxTokens, 256000)
  assert.deepEqual(models[0].input, ['text', 'image'])
})

test('errors and retry policy', () => {
  assert.equal(classifyHttpError(401, '{"error":{"message":"bad key"}}', {}).code, 'AUTH')
  assert.equal(classifyHttpError(402, '', {}).code, 'QUOTA')
  assert.equal(classifyHttpError(400, '{"error":{"message":"maximum context length exceeded"}}', {}).code, 'CONTEXT_WINDOW_EXCEEDED')
  const e = classifyHttpError(429, '', { 'retry-after': '2' })
  assert.equal(e.code, 'RATE_LIMIT')
  const d = retryDecision(e, 1)
  assert.ok(d.delayMs >= 2000)
  assert.equal(retryDecision({ code: 'AUTH' }, 1), null)
  assert.equal(retryDecision({ code: 'SERVER' }, 6), null)
})

test('read/write/edit tools match upstream output contracts', async () => {
  const ex = fsExec()
  let out = await runToolCall(writeTool, { name: 'write', input: { file_path: 'a.txt', content: 'one\r\ntwo\r\nthree\r\n' } }, ex)
  assert.match(out.content[0].text, /Created file/)
  out = await runToolCall(readTool, { name: 'read', input: { file_path: 'a.txt', offset: 2, limit: 1 } }, ex)
  assert.match(out.content[0].text, /2: two\n\n\(Showing lines 2-2 of 3\. Use offset=3 to continue\.\)/)
  out = await runToolCall(editTool, { name: 'edit', input: { file_path: 'a.txt', old_string: 'two\nthree', new_string: 'TWO\nTHREE' } }, ex)
  assert.equal(out.content[0].text, 'The file /workspaces/w/a.txt has been updated successfully.')
  assert.equal(await ex.vfs.readText('/workspaces/w/a.txt'), 'one\r\nTWO\r\nTHREE\r\n') // CRLF preserved
  await ex.vfs.writeText('/workspaces/w/b.txt', 'x x')
  out = await runToolCall(editTool, { name: 'edit', input: { file_path: 'b.txt', old_string: 'x', new_string: 'y' } }, ex)
  assert.equal(out.content[0].text, 'Error: old_string matched 2 times in "/workspaces/w/b.txt"; provide a more specific old_string or set replace_all to true')
  out = await runToolCall(readTool, { name: 'read', input: { file_path: 'missing.txt' } }, ex)
  assert.ok(out.isError)
  out = await runToolCall(readTool, { name: 'read', input: { offset: 1 } }, ex)
  assert.equal(out.content[0].text, 'Error: invalid arguments: file_path is required')
})

test('sandbox: read-only denies, escalation asks once; workspace-write blocks outside paths', async () => {
  const ro = fsExec('read-only')
  let out = await runToolCall(writeTool, { name: 'write', input: { file_path: 'x.txt', content: 'a' } }, ro)
  assert.match(out.content[0].text, /\[sandbox: file access denied under read-only mode\]\n\[sandbox: escalation available/)
  out = await runToolCall(writeTool, { name: 'write', input: { file_path: 'x.txt', content: 'a', sandbox_permissions: 'workspace-write', justification: 'needed' } }, ro)
  assert.match(out.content[0].text, /Created file/)
  assert.equal(ro.approvals.length, 1)
  const ww = fsExec('workspace-write')
  out = await runToolCall(writeTool, { name: 'write', input: { file_path: '/workspaces/other/x.txt', content: 'a' } }, ww)
  assert.match(out.content[0].text, /denied under workspace-write/)
  out = await runToolCall(writeTool, { name: 'write', input: { file_path: '/tmp/x.txt', content: 'a' } }, ww)
  assert.ok(!out.isError)
  out = await runToolCall(writeTool, { name: 'write', input: { file_path: '/app/sessions/x', content: 'a', sandbox_permissions: 'danger-full-access', justification: 'x' } }, ww)
  assert.match(out.content[0].text, /belongs to the app/)
})

test('glob and grep', async () => {
  const ex = fsExec()
  await ex.vfs.writeText('/workspaces/w/src/a.ts', 'const a = 1\nfunction foo() {}\n')
  await ex.vfs.writeText('/workspaces/w/src/b.js', 'foo()\n')
  await ex.vfs.writeText('/workspaces/w/.git/config', 'x')
  await ex.vfs.writeText('/workspaces/w/.gitignore', 'dist/\n')
  await ex.vfs.writeText('/workspaces/w/dist/out.js', 'foo')
  let out = await runToolCall(globTool, { name: 'glob', input: { pattern: '*.ts' } }, ex)
  assert.equal(out.content[0].text, 'src/a.ts')
  out = await runToolCall(globTool, { name: 'glob', input: { pattern: '**/*.js' } }, ex)
  assert.deepEqual(out.content[0].text.split('\n').sort(), ['dist/out.js', 'src/b.js'])
  out = await runToolCall(grepTool, { name: 'grep', input: { pattern: 'foo' } }, ex)
  assert.equal(out.content[0].text, 'Found 2 matches\n\nsrc/a.ts\nLine 2: function foo() {}\n\nsrc/b.js\nLine 1: foo()')
  out = await runToolCall(grepTool, { name: 'grep', input: { pattern: '(?i)FOO', include: '*.ts' } }, ex)
  assert.match(out.content[0].text, /^Found 1 match\n/)
})

test('apply_patch applies and rejects atomically', async () => {
  const ex = fsExec()
  await ex.vfs.writeText('/workspaces/w/m.txt', 'a\nb\nc\n')
  const ok = await applyPatchText('*** Begin Patch\n*** Update File: m.txt\n@@\n a\n-b\n+B\n c\n*** Add File: n.txt\n+new\n*** End Patch', ex, async () => null)
  assert.match(ok.content[0].text, /Success\. Updated the following files:\nM m\.txt\nA n\.txt/)
  assert.equal(await ex.vfs.readText('/workspaces/w/m.txt'), 'a\nB\nc\n')
  const bad = await applyPatchText('*** Begin Patch\n*** Update File: m.txt\n@@\n-zzz\n+y\n*** End Patch', ex, async () => null)
  assert.match(bad.content[0].text, /Patch rejected before any change \(1 problems\)/)
})

test('batch runs parallel-safe calls concurrently and commits in order', async () => {
  const order = []
  const slow = { name: 'slow', parameters: { type: 'object', properties: {} }, isConcurrencySafe: () => true, async execute() { await new Promise(r => setTimeout(r, 30)); return 'slow' } }
  const fast = { name: 'fast', parameters: { type: 'object', properties: {} }, isConcurrencySafe: () => true, async execute() { return 'fast' } }
  const defs = { slow, fast }
  const t0 = Date.now()
  await executeBatch([{ id: '1', name: 'slow', arguments: '{}' }, { id: '2', name: 'fast', arguments: '{}' }, { id: '3', name: 'slow', arguments: '{}' }], {
    resolve: n => defs[n], exec: {}, maxParallel: 10, onResult: c => order.push(c.id),
  })
  assert.deepEqual(order, ['1', '2', '3'])
  assert.ok(Date.now() - t0 < 80)
  assert.deepEqual(validateArgs({ type: 'object', properties: { a: { type: 'string', enum: ['x'] } }, required: ['a'] }, { a: 'y' }), ['a must be one of "x"'])
})

test('paths, globs and gitignore', () => {
  assert.equal(resolve('/workspaces/w', '../x/./y'), '/workspaces/x/y')
  assert.equal(resolve('/workspaces/w', 'C:\\a\\b'), '/a/b')
  assert.ok(globMatcher('*.md')('docs/readme.md'))
  assert.ok(globMatcher('src/**/*.js')('src/a/b/c.js'))
  assert.ok(globMatcher('*.{js,ts}')('x/y.ts'))
  const rules = parseGitignore('node_modules/\n*.log\n!keep.log')
  assert.ok(isIgnored(rules, 'node_modules/x/y.js', false))
  assert.ok(isIgnored(rules, 'a/b.log', false))
  assert.ok(!isIgnored(rules, 'keep.log', false))
})

test('rrule subset: daily, weekdays, monthly last weekday, count', () => {
  const daily = parseRrule('DTSTART:20260101T080000Z\nRRULE:FREQ=DAILY')
  assert.equal(nextOccurrence(daily, new Date('2026-03-05T09:00:00Z')).toISOString(), '2026-03-06T08:00:00.000Z')
  const wk = parseRrule('DTSTART:20260105T080000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')
  assert.equal(nextOccurrence(wk, new Date('2026-01-09T09:00:00Z')).toISOString(), '2026-01-12T08:00:00.000Z')
  const last = parseRrule('DTSTART:20260901T080000Z\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1')
  assert.equal(nextOccurrence(last, new Date('2026-09-02T00:00:00Z')).toISOString(), '2026-09-30T08:00:00.000Z')
  const once = parseRrule('DTSTART:20260101T080000Z\nRRULE:FREQ=DAILY;COUNT=1')
  assert.equal(nextOccurrence(once, new Date('2026-01-02T00:00:00Z')), null)
  assert.throws(() => parseRrule('DTSTART:20260101T080000Z\nRRULE:FREQ=HOURLY;BYHOUR=3'))
})

test('session surface applies compaction replacements; open turns are repaired', () => {
  const s = new Session({ id: 's' }, [])
  s.append('system/message', { text: 'sys' })
  const u = s.append('user/message', { content: [{ type: 'text', text: 'q' }] })
  const a = s.append('assistant/message', { content: [{ type: 'text', text: 'a' }] })
  s.append('user/message', { content: [{ type: 'text', text: 'summary' }], source: { kind: 'compaction' } }, { replace: { startSeq: u.seq, endSeq: a.seq } })
  s.append('user/message', { content: [{ type: 'text', text: 'next' }] })
  assert.deepEqual(s.deriveMessages().map(m => m.role + ':' + (m.content[0].text)), ['system:sys', 'user:summary', 'user:next'])
  s.append('turn/start', { turn: 1 })
  s.append('step/start', {})
  s.append('assistant/message', { content: [{ type: 'tool-call', id: 'c9', name: 'read', arguments: '{}' }] })
  s.append('tool/call', { id: 'c9', name: 'read' })
  assert.equal(closeOpenTurn(s, 'interrupted'), true)
  const types = s.events.slice(-3).map(e => e.type)
  assert.deepEqual(types, ['tool/result', 'step/end', 'turn/end'])
  assert.equal(s.events[s.events.length - 3].data.code, 'TOOL_OUTCOME_UNKNOWN')
})

test('compaction budget and range never split tool calls', () => {
  const b = budget({ contextWindow: 1048576, maxTokens: 256000 })
  assert.equal(b.threshold, Math.floor(Math.min(0.8 * 1048576, 1048576 - 256000 - 65536)))
  const ev = (seq, type, data) => ({ seq, type, data })
  const surface = [
    ev(1, 'system/message', { text: 'sys' }),
    ev(2, 'user/message', { content: [{ type: 'text', text: 'x'.repeat(4000) }] }),
    ev(3, 'assistant/message', { content: [{ type: 'tool-call', id: 'a', name: 'read', arguments: '{}' }] }),
    ev(4, 'tool/result', { content: [{ type: 'text', text: 'y'.repeat(40) }] }),
    ev(5, 'assistant/message', { content: [{ type: 'text', text: 'done' }] }),
  ]
  const r = chooseRange(surface, 30)
  assert.ok(r)
  assert.notEqual(surface[r.end] && surface[r.end].type, 'tool/result')
})

test('settings helpers: masked secrets and deep merge', () => {
  assert.equal(maskSecret('sk-0123456789abcdefghijklmnop'), 'sk-01234••••••••mnop')
  assert.equal(maskSecret('short'), '•••••')
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } }), { a: { b: 1, c: 3 } })
})

test('html → markdown for web_fetch', () => {
  const md = htmlToMarkdown('<html><head><title>T</title><script>evil()</script></head><body><h2>Head</h2><p>Hello <b>bold</b> <a href="/x">link</a></p><ul><li>one</li><li>two</li></ul><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table><pre><code class="language-js">let x = 1</code></pre></body></html>', 'https://e.com/p/q')
  assert.match(md, /^# T/)
  assert.match(md, /## Head/)
  assert.match(md, /Hello \*\*bold\*\* \[link\]\(https:\/\/e\.com\/x\)/)
  assert.match(md, /- one\n- two/)
  assert.match(md, /\| a \| b \|\n\| --- \| --- \|\n\| 1 \| 2 \|/)
  assert.match(md, /```js\nlet x = 1\n```/)
  assert.ok(md.indexOf('evil') < 0)
})

test('skills frontmatter and catalog', () => {
  const fm = parseFrontmatter('---\nname: my-skill\ndescription: >\n  Does a\n  thing\nuser-invocable: false\n---\nBody')
  assert.equal(fm.data.name, 'my-skill')
  assert.equal(fm.data.description, 'Does a thing')
  assert.equal(fm.data['user-invocable'], false)
  assert.equal(fm.body, 'Body')
  const cat = renderSkillCatalog([{ name: 'a', description: 'x <y>', modelInvocable: true }])
  assert.match(cat, /- `a`: x &lt;y&gt;/)
})

test('markdown parser blocks and inline', () => {
  const b = parseBlocks('# T\n\n- [x] done\n- todo\n\n```js\ncode\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> q')
  assert.deepEqual(b.map(x => x.type), ['heading', 'list', 'code', 'table', 'quote'])
  assert.equal(b[1].items[0].task, true)
  const inl = parseInline('**b** _i_ `c` [l](https://x.y) https://z.w/a')
  assert.deepEqual(inl.filter(n => n.t !== 'text').map(n => n.t), ['strong', 'em', 'code', 'link', 'link'])
})

test('utf-8 and base64 round trips', () => {
  const s = 'Lumia 920 · 诺基亚 🐳'
  const bytes = utf8Encode(s)
  assert.equal(utf8DecodeStrict(bytes), s)
  assert.equal(utf8DecodeStrict(new Uint8Array([0xff, 0xfe])), null)
  assert.equal(Buffer.from(bytesToBase64(bytes), 'base64').toString(), s)
  assert.deepEqual(Array.from(base64ToBytes(bytesToBase64(bytes))), Array.from(bytes))
})

test('unified diff counts', () => {
  const d = unifiedDiff('f', 'a\nb\nc\n', 'a\nB\nc\nd\n')
  assert.equal(d.added, 2)
  assert.equal(d.removed, 1)
  assert.match(d.text, /^@@ -1,4 \+1,5 @@/)
})

test('run_code interpreter: modern syntax, tool calls, errors', async () => {
  const r = await runCode('const xs = [1, 2, 3]; const t = await tools.echo({ v: 42 }); return { sum: xs.reduce((a, b) => a + b, 0), t, ...{ z: 1 } }', ['echo'], async (name, args) => `echo:${args.v}`)
  assert.equal(r.value, "{ sum: 6, t: 'echo:42', z: 1 }".replace(/'/g, '"'))
  const e = await runCode('throw new TypeError("boom")', [], async () => '')
  assert.equal(e.error, 'TypeError: boom')
})
