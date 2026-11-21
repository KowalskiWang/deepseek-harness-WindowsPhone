// Live workflow test: a script fans out to subagents with and without schemas.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createNodePlatform } from '../src/platform/node.js'
import { Runtime } from '../src/core/runtime.js'

const key = fs.readFileSync(new URL('../api.txt', import.meta.url), 'utf8').trim()
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wf-'))
const rt = new Runtime(createNodePlatform({ root }))
await rt.init()
await rt.settings.setCredential('deepseek', key)
rt.settings.update({ models: { defaultSelection: { provider: 'deepseek', model: 'deepseek-flash', effort: 'off' } } })
const ws = rt.workspaces.list()[0]
for (const [n, body] of [['a.txt', 'apple banana'], ['b.txt', 'cherry'], ['c.txt', 'date elderberry fig']]) await rt.vfs.writeText(ws.path + '/' + n, body)
const agent = await rt.newSession({ workspaceId: ws.id })
await rt.send(agent, { text: 'Use the workflow tool (not plain subagent calls): for each of a.txt, b.txt, c.txt run one agent (use pipeline) that reads the file and returns {"file": string, "words": number} via opts.schema; return the array. Then tell me the total word count.' })
await new Promise(r => { const c = () => (agent.running || agent.inbox.nextTurn.length ? setTimeout(c, 500) : r()); setTimeout(c, 1500) })
const res = agent.session.events.filter(e => e.type === 'tool/result' && e.data.name === 'workflow')
console.log('workflow results: ' + JSON.stringify(res.map(e => (e.data.isError ? 'ERROR ' : '') + e.data.content[0].text.slice(0, 300))))
const subs = rt.sessions.list().filter(m => m.isSubagent).length
const last = agent.session.events.filter(e => e.type === 'assistant/message').pop()
console.log('subagent sessions:', subs, '| final:', last.data.content.filter(b => b.type === 'text').map(b => b.text).join('').slice(0, 200))
fs.rmSync(root, { recursive: true, force: true })
process.exit(0)
