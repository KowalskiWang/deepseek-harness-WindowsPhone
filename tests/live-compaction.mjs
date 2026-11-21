// Live compaction test: low threshold → automatic compaction mid-session; the
// agent must still answer from facts that now live only in the summary.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createNodePlatform } from '../src/platform/node.js'
import { Runtime } from '../src/core/runtime.js'

const key = fs.readFileSync(new URL('../api.txt', import.meta.url), 'utf8').trim()
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cmp-'))
const rt = new Runtime(createNodePlatform({ root }))
await rt.init()
await rt.settings.setCredential('deepseek', key)
rt.settings.update({ models: { defaultSelection: { provider: 'deepseek', model: 'deepseek-flash', effort: 'off' } }, agent: { compactThreshold: 15000 } })
const ws = rt.workspaces.list()[0]
const big = Array.from({ length: 400 }, (_, i) => `line ${i}: filler text about Windows Phone history and Lumia hardware revisions`).join('\n')
await rt.vfs.writeText(ws.path + '/big.txt', big)
const agent = await rt.newSession({ workspaceId: ws.id })
const waitIdle = () => new Promise(r => { const c = () => (agent.running || agent.inbox.nextTurn.length ? setTimeout(c, 300) : r()); setTimeout(c, 500) })
const turns = [
  'Remember this: the project codename is BLUE-HERON and the deadline is 9 December. Reply "noted".',
  'Read big.txt fully (all lines) and tell me how many lines it has.',
  'Read big.txt again from offset 200 and summarize lines 200-210 in one sentence.',
  'What is the project codename and deadline I told you at the start? Answer in one line.',
]
for (const p of turns.slice(0, 3)) { await rt.send(agent, { text: p }); await waitIdle() }
const forced = await agent.compact({ keep: 300, reason: 'command' })
console.log('forced compaction:', JSON.stringify(forced))
await rt.send(agent, { text: turns[3] }); await waitIdle()
await rt.flush()
const ev = agent.session.events
const summaries = ev.filter(e => e.type === 'compaction/summary')
const last = ev.filter(e => e.type === 'assistant/message').pop()
console.log('compaction events:', JSON.stringify(ev.filter(e => /^compaction/.test(e.type)).map(e => [e.type, e.data.error || e.data.items || ''])))
console.log('usage per request:', ev.filter(e => e.type === 'assistant/message').map(e => (e.data.usage.input + e.data.usage.cacheRead)).join(','))
console.log('compactions:', summaries.length, summaries.map(s => `${s.data.items} items/${s.data.shadowedTokenCount} tok`).join(', '))
console.log('surface messages now:', agent.session.surface().length, 'of', ev.filter(e => /message|tool\/result/.test(e.type)).length, 'logged')
console.log('final answer:', last.data.content.filter(b => b.type === 'text').map(b => b.text).join('').trim())
console.log('turn ends:', ev.filter(e => e.type === 'turn/end').map(e => e.data.reason).join(','))
fs.rmSync(root, { recursive: true, force: true })
process.exit(0)
