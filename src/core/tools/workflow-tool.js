// workflow (upstream @deepseek-ai/dsh-tool-workflow): a JavaScript script that
// orchestrates subagents. The script runs in the run_code sandbox; agent() is a
// host call that runs one real subagent to completion.
import { makeError, safeJsonParse, shortId, sleep, clip } from '../util.js'
import { textOutput, errorOutput, validateArgs } from './runtime.js'

const DESCRIPTION = [
  'Run a JavaScript workflow script that orchestrates subagents at scale. Use this for work that fans out across many independent pieces — an audit over many files, a migration, multi-angle research, adversarial verification of findings — where you write the orchestration as a script instead of delegating turn by turn.',
  '',
  'Script-body hooks:',
  '- `agent(prompt, opts?): Promise<any>` — run one subagent to completion. Without `opts.schema` it resolves to the child\'s final text; with `opts.schema` (an object-rooted JSON Schema using ONLY type/properties/required/additionalProperties/items/enum/const/oneOf) it resolves to the validated object. Resolves `null` when the child fails (filter with `.filter(Boolean)`). Other opts: `label` (display), `phase` (progress group), and independent `provider`/`model` LLM target overrides.',
  '- `pipeline(items, ...stages): Promise<any[]>` — run each item through the stages independently with NO barrier between stages (prefer this for multi-stage work). Each stage receives `(prev, item, index)`. A stage throw drops that ITEM to `null` and skips its remaining stages.',
  '- `parallel(thunks): Promise<any[]>` — run zero-argument functions concurrently and await ALL of them (a barrier; use only when a stage genuinely needs every prior result together). A throwing thunk resolves to `null`.',
  '- `phase(title)` — start a progress phase; `log(message)` — narrate progress; `args` — the tool call\'s `args` input, verbatim.',
  '',
  'Misused hooks (bad arguments, unknown options, unsupported schemas, tripped caps) end the whole script instead of producing `null`. The script has no filesystem, network, timer, or Node.js APIs; the agents do the work.',
].join('\n')

const PRELUDE = [
  'const agent = async (prompt, opts) => { if (typeof prompt !== "string" || !prompt) throw new Error("agent(prompt): prompt must be a non-empty string"); const r = await tools.__agent({ prompt: prompt, opts: opts || {} }); return JSON.parse(r).value };',
  'const parallel = async (thunks) => { if (!Array.isArray(thunks)) throw new Error("parallel(thunks): expected an array of functions"); return Promise.all(thunks.map(async (f) => { try { return await f() } catch (e) { return null } })) };',
  'const pipeline = async (items, ...stages) => { if (!Array.isArray(items)) throw new Error("pipeline(items, ...stages): items must be an array"); return Promise.all(items.map(async (item, index) => { let prev = item; for (const stage of stages) { try { prev = await stage(prev, item, index) } catch (e) { return null } } return prev })) };',
  'const phase = (title) => { tools.__log({ phase: String(title) }) };',
  'const log = (message) => { tools.__log({ message: String(message) }) };',
].join('\n')

const ALLOWED_SCHEMA_KEYS = { type: 1, properties: 1, required: 1, additionalProperties: 1, items: 1, enum: 1, const: 1, oneOf: 1, description: 1 }
function checkSchema(s, path) {
  if (!s || typeof s !== 'object') throw makeError('WORKFLOW_SCHEMA', `unsupported schema at ${path}`)
  for (const k in s) if (!ALLOWED_SCHEMA_KEYS[k]) throw makeError('WORKFLOW_SCHEMA', `unsupported schema keyword "${k}" at ${path}`)
  if (s.properties) for (const k in s.properties) checkSchema(s.properties[k], path + '.' + k)
  if (s.items) checkSchema(s.items, path + '[]')
  if (s.oneOf) s.oneOf.forEach((x, i) => checkSchema(x, path + '|' + i))
}

function extractJson(text) {
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/g
  let m, last = null
  while ((m = fence.exec(text))) last = m[1]
  const candidate = last || (text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
  return safeJsonParse(candidate, undefined)
}

const MAX_AGENTS = 64

export function createWorkflowTool(rt) {
  return {
    name: 'workflow',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'The plain JavaScript body, not TypeScript and without an `export const meta` statement; top-level await is allowed. End with `return <value>`; the JSON-serializable value is this tool\'s result.' },
        meta: {
          type: 'object',
          description: 'The workflow identity as plain JSON, not code.',
          additionalProperties: true,
          properties: {
            name: { type: 'string', description: 'Short kebab-case workflow name.' },
            description: { type: 'string', description: 'One-line description of what the workflow does.' },
            whenToUse: { type: 'string', description: 'Optional guidance on when this workflow applies.' },
            phases: { type: 'array', description: 'Optional phase declarations matched by phase() calls.', items: { type: 'object', additionalProperties: true, properties: { title: { type: 'string', description: 'The phase title phase() calls match by exact string.' }, detail: { type: 'string', description: 'Optional one-line description of the phase.' } }, required: ['title'] } },
          },
          required: ['name', 'description'],
        },
        args: { type: 'object', description: 'Optional JSON input exposed to the script as the `args` global (wrap a bare list as a field, e.g. {"files": [...]}).', additionalProperties: true },
        run_in_background: { type: 'boolean', description: 'Run as a background job: return a job id immediately instead of waiting; the return value arrives with the completion notice.' },
      },
      required: ['script', 'meta'],
    },
    when: ctx => !!rt.platform.codeRunner && rt.settings.get().subagent.maxDepth > 0 && ctx.agent.depth < rt.settings.get().subagent.maxDepth,
    async execute(args, exec) {
      const parent = exec.agent
      const progress = { kind: 'workflow', name: args.meta.name, phase: '', logs: [], agents: [] }
      const report = () => { if (exec.progress) exec.progress(Object.assign({}, progress, { agents: progress.agents.slice(), logs: progress.logs.slice(-6) })) }
      let spawned = 0
      let active = 0
      const limit = Math.max(1, rt.settings.get().subagent.maxParallel || 8)

      const runAgent = async ({ prompt, opts }) => {
        const o = opts || {}
        for (const k in o) if (['schema', 'label', 'phase', 'provider', 'model', 'reasoning_effort'].indexOf(k) < 0) throw makeError('WORKFLOW_HOOK', `agent(): unknown option "${k}"`)
        if (o.schema) checkSchema(o.schema, 'schema')
        if (++spawned > MAX_AGENTS) throw makeError('WORKFLOW_CAP', `workflow exceeded ${MAX_AGENTS} agents`)
        while (active >= limit) await sleep(200, exec.signal)
        active++
        const entry = { label: o.label || clip(prompt, 40), phase: o.phase || progress.phase, status: 'running' }
        progress.agents.push(entry)
        report()
        try {
          let selection = parent.selection()
          if (o.provider && o.model) selection = { provider: o.provider, model: o.model, effort: o.reasoning_effort }
          const short = 'wf-' + shortId(6)
          const child = await rt.spawnSubagent(parent, { shortName: short, name: (parent.isSubagent ? parent.name + '/' : '') + short, description: entry.label, fork: false, selection })
          child.workflowChild = true
          let text = prompt
          if (o.schema) text += '\n\nWhen you have your final answer, end your reply with exactly one ```json fenced block containing an object that matches this JSON Schema exactly:\n```json\n' + JSON.stringify(o.schema) + '\n```'
          child.prompt({ content: [{ type: 'text', text: `Agent ${parent.name} sent a message: ${text}` }], source: { kind: 'agent', from: parent.name } }, 'queue')
          const onAbort = () => child.cancel('parent')
          if (exec.signal) exec.signal.addEventListener('abort', onAbort)
          await sleep(50)
          while (child.running || child.inbox.nextTurn.length) await sleep(400)
          if (exec.signal) exec.signal.removeEventListener('abort', onAbort)
          const end = child.session.last('turn/end')
          if (!end || end.data.reason !== 'completed') { entry.status = 'failed'; report(); return JSON.stringify({ value: null }) }
          const final = child.session.last('assistant/message')
          const out = final ? final.data.content.filter(b => b.type === 'text').map(b => b.text).join('').trim() : ''
          if (!o.schema) { entry.status = 'done'; report(); return JSON.stringify({ value: out }) }
          const obj = extractJson(out)
          const valid = obj && typeof obj === 'object' && !validateArgs(o.schema, obj).length
          entry.status = valid ? 'done' : 'failed'
          report()
          return JSON.stringify({ value: valid ? obj : null })
        } finally { active-- }
      }

      const host = async (name, a) => {
        if (name === '__agent') return runAgent(a)
        if (name === '__log') {
          if (a.phase) progress.phase = a.phase
          if (a.message) progress.logs.push(a.message)
          report()
          return 'ok'
        }
        throw makeError('UNKNOWN_TOOL', name)
      }

      const code = PRELUDE + '\nconst args = ' + JSON.stringify(args.args || {}) + ';\n' + args.script
      const runIt = () => rt.platform.codeRunner.run(code, { timeoutMs: 30 * 60 * 1000, signal: exec.signal, callTool: host, toolNames: ['__agent', '__log'] })

      if (args.run_in_background) {
        const jobId = 'wf-job-' + shortId(6)
        runIt().then((r) => {
          const text = r.error ? `Background workflow ${args.meta.name} (${jobId}) failed: ${r.error}` : `Background workflow ${args.meta.name} (${jobId}) finished.\n\nResult:\n${clip(String(r.value), 50000)}`
          parent.prompt({ content: [{ type: 'text', text }], source: { kind: 'workflow', jobId } }, parent.running ? 'steer' : 'queue')
        })
        return textOutput(`started workflow job ${jobId}`, { display: { kind: 'workflow', name: args.meta.name, background: true } })
      }
      const r = await runIt()
      const logs = r.logs && r.logs.length ? r.logs.join('\n') + '\n' : ''
      if (r.error) return errorOutput(`workflow ${args.meta.name} failed: ${r.error}`, 'WORKFLOW_FAILED', { display: progress })
      return textOutput(clip(logs + (r.value === undefined ? '(no return value)' : r.value), 50000), { display: Object.assign({}, progress, { done: true }) })
    },
  }
}
