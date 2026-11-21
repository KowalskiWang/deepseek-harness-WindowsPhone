// Subagents (upstream dsh-tool-subagent, dsh-tool-subagent-control): children run
// in-process as full agents in their own sessions; results come back to the
// parent as a user message when the child goes idle.
import { makeError, sleep } from '../util.js'
import { textOutput } from './runtime.js'
import { SUBAGENT_PROMPT_SUFFIX } from '../prompt.js'

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/

const SPAWN_DESCRIPTION = "Delegate a self-contained task to a subagent (a separate agent that works in its own context) to offload focused, independent work — research, a scoped implementation, an analysis — so it does not consume this conversation's context. The subagent returns its result, not its intermediate steps. This tool starts an independently managed subagent and immediately returns its name. If you are still online when it finishes, the runtime automatically delivers its completion notice. The notice includes the final answer unless the child sent you a message just before finishing. Use `send_message` to steer it while running or continue its conversation after it finishes."
const FORK_DESCRIPTION = "Delegate a task to a subagent that inherits this conversation: a child agent seeded with all completed turns so far (it does not see the current in-flight turn). Use this when the subtask builds on this conversation's context — a follow-up analysis, a review, a continuation — without consuming this conversation's context for the work itself. You receive its result, not its intermediate steps. This tool starts an independently managed subagent and immediately returns its name. If you are still online when it finishes, the runtime automatically delivers its completion notice. The notice includes the final answer unless the child sent you a message just before finishing. Use `send_message` to steer it while running or continue its conversation after it finishes."

const MODEL_PARAMS = {
  provider: { type: 'string', description: 'LLM provider id for the subagent; requires `model`. Set only when the task needs a different model; omit `provider`, `model`, and `reasoning_effort` to run the subagent on your current model and reasoning effort. Use a provider id listed by `list_subagent_models`.' },
  model: { type: 'string', description: 'Model id within that provider; requires `provider`.' },
  reasoning_effort: { type: 'string', description: 'Reasoning effort id; requires `provider` and `model`. Omit to use that model\'s default effort.' },
}

function rootOf(agent) { let a = agent; while (a.parent) a = a.parent; return a }

function allAgents(root) {
  const out = []
  const walk = (a) => { out.push(a); for (const k in a.children) walk(a.children[k].agent) }
  walk(root)
  return out
}

function findAgent(from, name) {
  return allAgents(rootOf(from)).find(a => a.name === name) || null
}

function delegationTool(rt, fork) {
  const settings = () => rt.settings.get().subagent
  const properties = {
    description: { type: 'string', description: "A short (3-5 word) description of the delegated task, for display. Use the language of the user's current request." },
    name: { type: 'string', description: 'Optional short name for the subagent, unique among the subagents you create: lower-case letters, digits, and hyphens, starting with a letter, at most 32 characters; lead is reserved for the root agent. Omitted names default to agent-1, agent-2, and so on.' },
    prompt: { type: 'string', description: fork ? "The task for the subagent. It already sees this conversation's completed turns, so build on them freely and state only what is new." : "The complete, self-contained task for the subagent. It does not share this conversation's context, so include everything it needs." },
  }
  if (settings().allowModelSelection) Object.assign(properties, MODEL_PARAMS)
  return {
    name: fork ? 'subagent_fork' : 'subagent',
    description: (fork ? FORK_DESCRIPTION : SPAWN_DESCRIPTION) + (fork && settings().allowModelSelection ? ' Changing the route can prevent provider-side reuse of the inherited conversation prefix.' : ''),
    parameters: { type: 'object', properties, required: ['description', 'prompt'] },
    isConcurrencySafe: () => true,
    when: ctx => settings().maxDepth > 0 && ctx.agent.depth < settings().maxDepth,
    guidance: (visible) => {
      const names = visible.filter(n => n === 'subagent' || n === 'subagent_fork').sort()
      if (!names.length || names[0] !== (fork ? 'subagent_fork' : 'subagent')) return ''
      return `Start independent delegations with ${names.map(n => '`' + n + '`').join(' or ')} together in one assistant message and continue useful work while they run. When only waiting for their results remains, end your turn instead of sleeping or polling; the next result starts a new turn. Collect the subagent results required to complete the task before giving the user a final answer.\n\nBash, formatters, code generators, and scripts can overwrite concurrent edits without conflict detection; coordinate their changes explicitly. The agent integrating the work must review the final diff and run relevant tests.`
    },
    async execute(args, exec) {
      const parent = exec.agent
      const s = settings()
      if (parent.depth >= s.maxDepth) throw makeError('SUBAGENT_DEPTH', `delegation depth limit reached (${s.maxDepth})`)
      const active = allAgents(rootOf(parent)).filter(a => a.isSubagent && a.running).length
      if (active >= s.maxParallel) throw makeError('SUBAGENT_CAPACITY', `at most ${s.maxParallel} subagents may run at once; wait for one to finish`)
      let short = args.name
      if (short !== undefined) {
        if (!NAME_RE.test(short) || short === 'lead') throw makeError('INVALID_ARGS', 'invalid arguments: name must be lower-case letters, digits and hyphens, start with a letter, at most 32 characters, and not "lead"')
        if (parent.children[short]) throw makeError('SUBAGENT_NAME_TAKEN', `a subagent named ${short} already exists`)
      } else {
        do { short = 'agent-' + (++parent.childSeq) } while (parent.children[short])
      }
      const fullName = parent.isSubagent ? parent.name + '/' + short : short
      let selection = parent.selection()
      if (args.provider || args.model) {
        if (!args.provider || !args.model) throw makeError('INVALID_ARGS', 'invalid arguments: provider and model go together')
        selection = { provider: args.provider, model: args.model, effort: args.reasoning_effort }
        rt.llm.resolve(selection) // validate early
      }
      const child = await rt.spawnSubagent(parent, {
        shortName: short, name: fullName, description: args.description, fork: !!fork, selection,
      })
      child.prompt({
        content: [{ type: 'text', text: `Agent ${parent.name} sent a message: ` + args.prompt }, { type: 'text', text: SUBAGENT_PROMPT_SUFFIX }],
        source: { kind: 'agent', from: parent.name },
      }, 'queue')
      return textOutput(`started subagent ${fullName}`, { display: { kind: 'subagent', name: fullName, description: args.description, sessionId: child.session.id, fork: !!fork } })
    },
  }
}

export function createSubagentTools(rt) {
  const visibleWithTree = ctx => rt.settings.get().subagent.maxDepth > 0
  return [
    delegationTool(rt, false),
    delegationTool(rt, true),
    {
      name: 'send_message',
      description: 'Send a message to an agent. A working agent receives it at its next step; an idle agent starts a new turn with it. Returns delivery confirmation.',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'The name of another agent in your subagent tree, as shown by list_agents.' },
          message: { type: 'string', description: 'The message to deliver to the agent.' },
        },
        required: ['agent', 'message'],
      },
      isConcurrencySafe: () => true,
      when: visibleWithTree,
      async execute(args, exec) {
        const from = exec.agent
        const target = findAgent(from, args.agent)
        if (!target) throw makeError('AGENT_NOT_FOUND', `no agent named ${args.agent} in your subagent tree; call list_agents`)
        if (target === from) throw makeError('INVALID_ARGS', 'you cannot message yourself')
        target.prompt({ content: [{ type: 'text', text: `Agent ${from.name} sent a message: ${args.message}` }], source: { kind: 'agent', from: from.name } }, target.running ? 'steer' : 'queue')
        if (from.parent && target === from.parent) from.lastSentToParent = true
        return textOutput(`message delivered to agent ${target.name}`, { display: { kind: 'message', to: target.name } })
      },
    },
    {
      name: 'list_agents',
      description: 'List your entire subagent tree: the root agent and all reachable continuable descendants, including yourself. Rows carry names, descriptions, and status. A descendant\'s name is its path from the root, such as reviewer/checker. You can message any other agent in the subagent tree. running means it is working; inactive means no turn is executing; it does not indicate task completion, success, or failure. corrupt, unsupported, or unavailable means this row\'s own descendants could not be read; the row itself is still a member you can message. While you remain active, you will be notified when a direct child finishes; there is no need to keep checking its status. Use send_message to continue the conversation.',
      parameters: { type: 'object', properties: {} },
      readOnly: true,
      isConcurrencySafe: () => true,
      when: visibleWithTree,
      async execute(args, exec) {
        const rows = allAgents(rootOf(exec.agent)).map(a => `${a.name} [${a.running ? 'running' : 'inactive'}] — ${a.isSubagent ? a.description : 'root agent'}`)
        return textOutput(rows.join('\n'))
      },
    },
    {
      name: 'wait_agent',
      description: 'Wait for input at your next step, including agent messages, completion notifications, and user steering. Returns immediately if new input is pending. `timedOut: false` means new input is pending. Pending input is delivered to the model after code execution finishes.',
      parameters: { type: 'object', properties: { timeout_ms: { type: 'integer', description: 'Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000.' } } },
      isConcurrencySafe: () => true,
      when: visibleWithTree,
      async execute(args, exec) {
        const ms = Math.min(3600000, Math.max(10000, args.timeout_ms || 30000))
        const end = Date.now() + ms
        while (Date.now() < end) {
          if (exec.agent.inbox.nextStep.length || exec.agent.inbox.nextTurn.length) return textOutput(JSON.stringify({ timedOut: false }))
          await sleep(500, exec.signal)
        }
        return textOutput(JSON.stringify({ timedOut: true }))
      },
    },
    {
      name: 'list_subagent_models',
      description: 'Inspect the routes available for explicit subagent model selection. No arguments: authorized providers. `provider`: that provider\'s authorized models. `provider` + `model`: that model and its reasoning efforts.',
      parameters: { type: 'object', properties: { provider: { type: 'string', description: 'Provider id from the no-argument listing.' }, model: { type: 'string', description: 'Exact model id; requires provider.' } } },
      readOnly: true,
      isConcurrencySafe: () => true,
      when: () => rt.settings.get().subagent.allowModelSelection && rt.settings.get().subagent.maxDepth > 0,
      async execute(args) {
        const providers = rt.llm.providers().filter(p => rt.llm.apiKeyFor(p) !== undefined)
        if (!args.provider) return textOutput(providers.map(p => `${p.id} — ${p.name}`).join('\n') || '(no authorized providers)')
        const p = providers.find(x => x.id === args.provider)
        if (!p) throw makeError('UNKNOWN_PROVIDER', `unknown or unauthorized provider: ${args.provider}`)
        const models = rt.llm.models(p.id)
        if (!args.model) return textOutput(models.map(m => `${p.id}/${m.id} — ${m.name || m.id}${m.description ? ': ' + m.description : ''}`).join('\n'))
        const m = models.find(x => x.id === args.model)
        if (!m) throw makeError('UNKNOWN_MODEL', `unknown model: ${args.model}`)
        const def = rt.llm.defaultEffort(p.id, m.id)
        return textOutput(`${p.id}/${m.id} — ${m.name || m.id}\nReasoning efforts:\n` + (m.efforts || []).map(e => `${e}${e === def ? ' (default)' : ''} — ${e}`).join('\n'))
      },
    },
  ]
}
