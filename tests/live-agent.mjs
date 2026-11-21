// Live end-to-end agent test against the real DeepSeek API.
// Usage: node tests/live-agent.mjs [scenario]   (key read from ./api.txt, never printed)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createNodePlatform } from '../src/platform/node.js'
import { Runtime } from '../src/core/runtime.js'

const key = fs.readFileSync(new URL('../api.txt', import.meta.url), 'utf8').trim()
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-live-'))
const platform = createNodePlatform({ root })
const rt = new Runtime(platform)
await rt.init()
await rt.settings.setCredential('deepseek', key)
rt.settings.update({ models: { defaultSelection: { provider: 'deepseek', model: 'deepseek-flash', effort: 'low' } } })

const ws = rt.workspaces.list()[0]
await rt.vfs.writeText(ws.path + '/notes.txt', 'alpha\nbeta\ngamma\n')
await rt.vfs.writeText(ws.path + '/AGENTS.md', 'Always answer in English. Keep replies under 80 words.\n')

const scenario = process.argv[2] || 'tools'
const prompts = {
  tools: 'Do these steps: 1) use todo_write to plan 3 steps, 2) read notes.txt, 3) edit notes.txt replacing "beta" with "BETA", 4) use run_code to compute the sum of 1..100 and also call tools.read on notes.txt inside the code and return its length, 5) glob for *.txt. Then summarize the results in one short paragraph.',
  web: 'Use web_search to find the release year of the Nokia Lumia 520, then answer in one sentence with a citation.',
  subagent: 'Delegate to a subagent: ask it to read notes.txt and report the number of lines. Wait for its result, then tell me the number.',
  plan: 'hello',
}

const agent = await rt.newSession({ workspaceId: ws.id })
let approvals = 0
rt.on('agent', (a) => {
  if (a.pending && a.pending.kind === 'approval') { approvals++; a.answer('approval', 'allowed-once') }
  if (a.pending && a.pending.kind === 'question') a.answer('question', { answers: a.pending.payload.questions.map(q => ({ id: q.id, selected: q.options && q.options[0] ? [q.options[0].label] : [] })) })
  if (a.pending && a.pending.kind === 'plan') a.answer('plan', { decision: 'approve' })
})
const t0 = Date.now()
await rt.send(agent, { text: prompts[scenario] })
await new Promise((resolve) => {
  const check = () => {
    const kids = Object.values(agent.children).map(c => c.agent)
    if (!agent.running && agent.inbox.nextTurn.length === 0 && kids.every(k => !k.running)) setTimeout(() => (agent.running ? setTimeout(check, 500) : resolve()), 1500)
    else setTimeout(check, 500)
  }
  setTimeout(check, 1000)
})
await rt.flush()
const evs = agent.session.events
const types = {}
for (const e of evs) types[e.type] = (types[e.type] || 0) + 1
console.log('scenario:', scenario, 'time:', ((Date.now() - t0) / 1000).toFixed(1) + 's', 'approvals:', approvals)
console.log('event counts:', JSON.stringify(types))
for (const e of evs) {
  if (e.type === 'tool/result') console.log(`  tool ${e.data.name}${e.data.isError ? ' ERROR' : ''}: ${e.data.content.map(b => b.text || '[img]').join(' ').slice(0, 220).replace(/\n/g, '⏎')}`)
  if (e.type === "turn/end" || e.type === "assistant/attempt" || e.type === "llm/retry") console.log("  " + e.type, JSON.stringify(e.data))
}
const final = evs.filter(e => e.type === 'assistant/message').pop()
console.log('final text:', final && final.data.content.filter(b => b.type === 'text').map(b => b.text).join('').slice(0, 600))
console.log('title:', agent.meta.title, '| file now:', JSON.stringify(await rt.vfs.readText(ws.path + '/notes.txt')))
console.log('usage:', JSON.stringify(agent.usageTotals()), 'context:', JSON.stringify(agent.contextUsage()))
fs.rmSync(root, { recursive: true, force: true })
process.exit(0)
