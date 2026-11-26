#!/usr/bin/env node
// A stand-in for `dsh --profile acp` with the same ACP v1 surface and update
// shapes (see upstream packages/acp/acp): initialize, session/new|list|resume|
// close|prompt|cancel|set_config_option, committed thought/message chunks,
// generic tool_call/tool_call_update, usage_update and one-shot permission
// requests. A prompt containing "ask" requests permission before its tool runs;
// one containing "slow" takes long enough to be cancelled.
// Usage: node tests/acp-mock.mjs --profile acp   (stdio JSON-RPC)
import fs from 'node:fs'
import crypto from 'node:crypto'

const sessions = new Map()
const waiting = new Map() // our request id → resolve
let nextId = 0 // dsh numbers its requests from 0: a falsy id must work
const out = m => process.stdout.write(JSON.stringify(Object.assign({ jsonrpc: '2.0' }, m)) + '\n')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const update = (sessionId, u) => out({ method: 'session/update', params: { sessionId, update: u } })
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); out({ id, method, params }) })

const CONFIG = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'deepseek-flash', options: [{ value: 'deepseek-flash', name: 'DeepSeek Flash' }, { value: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] }]

async function prompt(p) {
  const s = sessions.get(p.sessionId)
  if (!s) throw Object.assign(new Error('Session not found'), { code: -32002 })
  if (s.busy) throw new Error('a prompt is already running')
  s.busy = true
  s.cancelled = false
  const text = (p.prompt || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
  if (!s.title) s.title = text.slice(0, 40)
  s.updatedAt = new Date().toISOString()
  try {
    const m1 = crypto.randomUUID()
    update(s.id, { sessionUpdate: 'agent_thought_chunk', messageId: m1, content: { type: 'text', text: 'The user asked: ' + text } })
    update(s.id, { sessionUpdate: 'agent_message_chunk', messageId: m1, content: { type: 'text', text: 'Let me look at **' + s.cwd + '**.' } })
    update(s.id, { sessionUpdate: 'usage_update', used: 1200, size: 1048576 })
    await sleep(/slow/.test(text) ? 4000 : 250)
    if (s.cancelled) return { stopReason: 'cancelled' }
    const callId = 'call-' + crypto.randomUUID().slice(0, 8)
    update(s.id, { sessionUpdate: 'tool_call', toolCallId: callId, title: 'bash', kind: 'other', status: 'in_progress', rawInput: { command: 'ls -1' } })
    if (/ask/.test(text)) {
      const r = await ask('session/request_permission', { sessionId: s.id, toolCall: { toolCallId: callId }, options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] })
      if (!r || !r.outcome || r.outcome.outcome !== 'selected' || r.outcome.optionId !== 'allow-once') {
        update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: callId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'The user rejected this command.' } }] })
        update(s.id, { sessionUpdate: 'agent_message_chunk', messageId: crypto.randomUUID(), content: { type: 'text', text: 'OK, I did not run it.' } })
        return { stopReason: s.cancelled ? 'cancelled' : 'end_turn' }
      }
    }
    const names = fs.readdirSync(s.cwd).filter(n => !n.startsWith('.')).slice(0, 20)
    update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: callId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: names.join('\n') } }] })
    await sleep(150)
    update(s.id, { sessionUpdate: 'agent_message_chunk', messageId: crypto.randomUUID(), content: { type: 'text', text: 'Found ' + names.length + ' entries.' } })
    return { stopReason: 'end_turn' }
  } finally {
    s.busy = false
  }
}

const handlers = {
  initialize: () => ({ protocolVersion: 1, agentInfo: { name: 'acp-mock', version: '1.0.0' }, authMethods: [], agentCapabilities: { loadSession: false, promptCapabilities: { image: false, embeddedContext: false }, mcpCapabilities: { http: true, sse: false }, sessionCapabilities: { list: {}, resume: {}, close: {} } } }),
  'session/new': (p) => {
    const id = 'session-' + crypto.randomUUID()
    sessions.set(id, { id, cwd: p.cwd, title: '', updatedAt: new Date().toISOString() })
    return { sessionId: id, configOptions: CONFIG }
  },
  'session/list': () => ({ sessions: [...sessions.values()].map(s => ({ sessionId: s.id, cwd: s.cwd, title: s.title || null, updatedAt: s.updatedAt })) }),
  'session/resume': (p) => { if (!sessions.has(p.sessionId)) sessions.set(p.sessionId, { id: p.sessionId, cwd: p.cwd, title: '', updatedAt: new Date().toISOString() }); return { configOptions: CONFIG } },
  'session/close': (p) => { sessions.delete(p.sessionId); return {} },
  'session/set_config_option': (p) => { const o = CONFIG.find(c => c.id === p.configId); if (o) o.currentValue = p.value; return { configOptions: CONFIG } },
  'session/prompt': prompt,
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.method === undefined && m.id !== undefined && waiting.has(m.id)) { const r = waiting.get(m.id); waiting.delete(m.id); r(m.result); continue }
    if (m.method === 'session/cancel') { const s = sessions.get(m.params.sessionId); if (s) s.cancelled = true; for (const [id, r] of waiting) { waiting.delete(id); r({ outcome: { outcome: 'cancelled' } }) } continue }
    const h = handlers[m.method]
    if (m.id === undefined) continue
    if (!h) { out({ id: m.id, error: { code: -32601, message: 'Method not found: ' + m.method } }); continue }
    Promise.resolve().then(() => h(m.params || {})).then(result => out({ id: m.id, result }), e => out({ id: m.id, error: { code: e.code || -32603, message: e.message } }))
  }
})
process.stdin.on('end', () => process.exit(0))
