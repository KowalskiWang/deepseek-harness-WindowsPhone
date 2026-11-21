// Live smoke test of the LLM adapters against the real DeepSeek API.
// Reads the key from ./api.txt (never printed). Usage: node tests/live-llm.mjs
import fs from 'node:fs'
import { createNodeHttp } from '../src/platform/http-node.js'
import { createNet } from '../src/core/net.js'
import { LlmService } from '../src/core/llm/index.js'

const key = fs.readFileSync(new URL('../api.txt', import.meta.url), 'utf8').trim()
const net = createNet(createNodeHttp(), () => null)
const llm = new LlmService({
  net,
  getSettings: () => ({ custom: [{ id: 'deepseek-openai', kind: 'custom', name: 'DS OpenAI', protocol: 'openai-completions', baseURL: 'https://api.deepseek.com', compat: { thinkingFormat: 'deepseek' }, models: [{ id: 'deepseek-flash', contextWindow: 1048576, maxTokens: 8000, input: ['text'], reasoningEfforts: { off: '', low: 'low', high: 'high', max: 'max' } }] }] }),
  getCredential: () => key,
})
await llm.ensureListing(true)
console.log('listing:', llm.models('deepseek').map(m => `${m.id}(${m.contextWindow}/${m.maxTokens}, ${m.input.join('+')}, ${m.systemPromptUpdate})`).join('; '))

const tools = [{ name: 'read', description: 'Read a UTF-8 text file and return line-numbered content.', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }]
for (const [provider, effort] of [['deepseek', 'high'], ['deepseek-openai', 'low']]) {
  const route = llm.resolve({ provider, model: 'deepseek-flash', effort })
  let deltas = 0
  const r1 = await llm.stream(route, {
    messages: [{ role: 'system', content: [{ type: 'text', text: 'You are a terse test agent.' }] }, { role: 'user', content: [{ type: 'text', text: 'Use the read tool to read notes.txt. Think briefly first.' }] }],
    tools, maxTokens: 4000, effort, onEvent: (e) => { if (e.kind === 'delta') deltas++ },
  })
  const call = r1.content.find(b => b.type === 'tool-call')
  console.log(`[${provider}] stop=${r1.stopReason} blocks=${r1.content.map(b => b.type).join(',')} deltas=${deltas} usage=${JSON.stringify(r1.usage)} call=${call && call.name}${call && JSON.stringify(call.input)}`)
  // second turn: answer the tool call, reasoning passed back
  const r2 = await llm.stream(route, {
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'You are a terse test agent.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Use the read tool to read notes.txt. Think briefly first.' }] },
      { role: 'assistant', content: r1.content },
      { role: 'tool', callId: call.id, name: call.name, content: [{ type: 'text', text: '1: The secret word is PELICAN.' }] },
    ],
    tools, maxTokens: 4000, effort,
  })
  console.log(`[${provider}] turn2 stop=${r2.stopReason} text=${JSON.stringify((r2.content.find(b => b.type === 'text') || {}).text)} cacheRead=${r2.usage.cacheRead}`)
}
