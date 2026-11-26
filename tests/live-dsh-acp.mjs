// Live check of the real desktop dsh through the gateway's bridge module:
// starts `dsh --profile acp`, opens a session in a folder, asks for a plain
// reply, then for a shell command (approving any permission request), and
// prints every ACP update it receives.
// Usage: node tests/live-dsh-acp.mjs --dsh <node|dsh> [--dsh-arg <bin.js>] --root <dir> [--home <DSH_HOME>]
// The DeepSeek key comes from ./api.txt (never printed).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDshBridge } from '../gateway/dsh-bridge.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1] }
const argAll = n => process.argv.reduce((a, v, i, all) => (v === '--' + n ? a.concat([all[i + 1]]) : a), [])
const key = fs.readFileSync(path.join(root, 'api.txt'), 'utf8').replace(/\s+/g, '')
const env = { DEEPSEEK_API_KEY: key }
if (arg('home')) env.DSH_HOME = path.resolve(arg('home'))
const workRoot = path.resolve(arg('root'))
const bridge = createDshBridge({ exe: arg('dsh', 'dsh'), args: argAll('dsh-arg'), env, roots: [workRoot], log: l => console.log('  [log] ' + l.replace(key, '***')) })

let after = 0
const t0 = Date.now()
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's'

async function turn(sessionId, text, ms = 300000) {
  console.log(`${stamp()} → prompt: ${text}`)
  const { callId } = await bridge.call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, { async: true })
  const out = { updates: [], tools: [], text: '' }
  const end = Date.now() + ms
  while (Date.now() < end) {
    const r = await bridge.events(after, 20000)
    after = r.last
    for (const e of r.events) {
      if (e.type === 'notification' && e.method === 'session/update') {
        const u = e.params.update
        out.updates.push(u.sessionUpdate)
        if (u.sessionUpdate === 'agent_message_chunk' && u.content && u.content.type === 'text') { out.text += u.content.text; console.log(`${stamp()}   message: ${u.content.text.slice(0, 200).replace(/\n/g, '⏎')}`) }
        else if (u.sessionUpdate === 'agent_thought_chunk') console.log(`${stamp()}   thought: ${(u.content.text || '').slice(0, 100).replace(/\n/g, '⏎')}`)
        else if (u.sessionUpdate === 'tool_call') { out.tools.push(u); console.log(`${stamp()}   tool_call ${u.title} ${JSON.stringify(u.rawInput).slice(0, 160)}`) }
        else if (u.sessionUpdate === 'tool_call_update') {
          const txt = (u.content || []).map(c => (c.content && c.content.text) || '').join(' ').slice(0, 200).replace(/\n/g, '⏎')
          const t = out.tools.find(x => x.toolCallId === u.toolCallId)
          if (t) { t.status = u.status; t.output = txt }
          console.log(`${stamp()}   tool_call_update ${u.status} ${txt}`)
        } else console.log(`${stamp()}   ${u.sessionUpdate} ${JSON.stringify(u).slice(0, 160)}`)
      } else if (e.type === 'request' && e.method === 'session/request_permission') {
        console.log(`${stamp()}   permission requested for ${JSON.stringify(e.params.toolCall)} → allow once`)
        await bridge.respond(e.id, { outcome: { outcome: 'selected', optionId: e.params.options.find(o => o.kind === 'allow_once').optionId } })
        out.permissions = (out.permissions || 0) + 1
      } else if (e.type === 'result' && e.callId === callId) {
        console.log(`${stamp()} ← ${e.error ? 'error ' + e.error.message : 'stopReason ' + e.result.stopReason}`)
        out.result = e.result
        out.error = e.error
        return out
      } else if (e.type === 'exit') throw new Error('dsh exited: ' + e.reason)
    }
  }
  throw new Error('no result within ' + ms / 1000 + ' s')
}

try {
  const cwd = fs.realpathSync(path.join(workRoot, fs.readdirSync(workRoot).find(n => !n.startsWith('.')) || '.'))
  console.log(`${stamp()} starting dsh (cwd ${cwd})`)
  const s = await bridge.call('session/new', { cwd, mcpServers: [] })
  const info = await bridge.info()
  console.log(`${stamp()} agent: ${JSON.stringify(info.agent && info.agent.agentInfo)} caps: ${JSON.stringify(info.agent && info.agent.agentCapabilities)}`)
  const sid = s.result.sessionId
  console.log(`${stamp()} session ${sid}; config: ${JSON.stringify((s.result.configOptions || []).map(c => c.id + '=' + c.currentValue))}`)
  const a = await turn(sid, 'Reply with exactly: ACP-OK. Do not use any tools.')
  console.log(`CHECK plain reply: ${/ACP-OK/.test(a.text) ? 'PASS' : 'FAIL'} (${a.updates.join(',')})`)
  const b = await turn(sid, 'Use your shell tool to run `echo dsh-mobile-$((6*7))` and tell me what it printed.')
  const ran = b.tools.some(t => t.status === 'completed' && /dsh-mobile-42/.test(t.output || ''))
  console.log(`CHECK shell command: ${ran || /dsh-mobile-42/.test(b.text) ? 'PASS' : 'FAIL'} (tools ${b.tools.map(t => t.title + ':' + t.status).join(',')}, permissions ${b.permissions || 0})`)
  if (arg('extra')) {
    const c = await turn(sid, arg('extra'))
    console.log(`EXTRA: permissions ${c.permissions || 0}, tools ${c.tools.map(t => t.title + ':' + t.status).join(',')}, stop ${c.result && c.result.stopReason}`)
  }
  const list = await bridge.call('session/list', { cwd })
  console.log(`${stamp()} session/list: ${(list.result.sessions || []).length} session(s)`)
  await bridge.call('session/close', { sessionId: sid })
  console.log(`${stamp()} closed`)
} catch (e) {
  console.log('ERROR ' + e.message)
  process.exitCode = 1
} finally {
  bridge.stop()
  setTimeout(() => process.exit(), 500)
}
