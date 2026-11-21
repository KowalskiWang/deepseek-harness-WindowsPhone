// todo_write, exit_plan_mode, ask_user_question, present (upstream dsh-tool-todo,
// dsh-plan-mode, dsh-tool-ask-user, dsh-tool-present).
import { resolve } from '../paths.js'
import { makeError } from '../util.js'
import { textOutput, errorOutput } from './runtime.js'

export const todoWriteTool = {
  name: 'todo_write',
  description: 'Record and update a task list to plan multi-step work and show progress; skip it for trivial single-step tasks. Add one todo per concrete step before you start. While work remains, keep the todos being worked on `in_progress`, several only when work runs in parallel. Mark each todo `completed` as soon as it is done.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The COMPLETE task list, replacing any previous list.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string', description: 'What the task is — a short imperative line.' },
            status: { type: 'string', description: 'pending (not started) | in_progress (now) | completed (done).', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  async execute(args, exec) {
    const seen = {}
    const todos = args.todos.map((t) => {
      const content = String(t.content).trim()
      if (!content) throw makeError('INVALID_ARGS', 'invalid arguments: todo content must not be empty')
      if (seen[content]) throw makeError('INVALID_ARGS', `invalid arguments: duplicate todo "${content}"`)
      seen[content] = true
      return { content, status: t.status }
    })
    const count = s => todos.filter(t => t.status === s).length
    const previous = exec.session.last('todo/write')
    exec.session.append('todo/write', { todos, turn: exec.turn })
    return textOutput(`Updated todo list: ${count('pending')} pending, ${count('in_progress')} in progress, ${count('completed')} completed.`, {
      display: { kind: 'todo', todos, previous: previous ? previous.data.todos : [] },
    })
  },
}

export const exitPlanModeTool = {
  name: 'exit_plan_mode',
  description: "Use only in plan mode. Present your plan for the user's review and, on approval, leave plan mode. The user may approve (carry out the plan from your next step) or keep planning — their feedback comes back in the tool result; revise and present again.",
  parameters: {
    type: 'object',
    properties: { plan: { type: 'string', description: 'The complete plan, as markdown, starting with a # heading that names it.' } },
    required: ['plan'],
  },
  async execute(args, exec) {
    if (!exec.agent.planMode()) return errorOutput('exit_plan_mode is only available in plan mode', 'NOT_IN_PLAN_MODE')
    if (!/^\s*# /.test(args.plan)) return errorOutput('invalid arguments: plan must start with a "# " heading', 'INVALID_ARGS')
    const answer = await exec.askPlanReview(args.plan)
    if (answer.decision === 'approve') {
      exec.agent.setPlanMode(false, 'approval')
      return textOutput('Plan approved — plan mode exited; carry out the plan starting with your next step.', { display: { kind: 'plan', plan: args.plan, decision: 'approved' } })
    }
    if (answer.decision === 'dismissed') {
      return textOutput('The user dismissed the plan review to reply in their own words; plan mode remains active.', { concludesTurn: true, display: { kind: 'plan', plan: args.plan, decision: 'dismissed' } })
    }
    const fb = answer.feedback && String(answer.feedback).trim()
    return errorOutput(fb ? `The user chose to keep planning; their feedback: ${fb}` : 'The user chose to keep planning; revise the plan and present it again.', 'PLAN_REVISION_REQUESTED', { display: { kind: 'plan', plan: args.plan, decision: 'revise', feedback: fb } })
  },
}

export const askUserQuestionTool = {
  name: 'ask_user_question',
  description: 'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. An answer item with empty selected and no custom means the user skipped that question: continue without it, do not ask it again, and do not treat the skip as permission.',
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: 'Questions to ask the user before continuing.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string', description: 'Stable id for this question; echoed in the answer.' },
            question: { type: 'string', description: 'The specific question to ask the user.' },
            header: { type: 'string', description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".' },
            options: {
              type: 'array',
              description: 'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  label: { type: 'string', description: 'Short user-facing option label.' },
                  description: { type: 'string', description: 'One sentence explaining the tradeoff or impact.' },
                },
                required: ['label'],
              },
            },
            multi_select: { type: 'boolean', description: 'Whether the user may select more than one option. Defaults to false.' },
          },
          required: ['id', 'question'],
        },
      },
    },
    required: ['questions'],
  },
  when: ctx => !ctx.isSubagent,
  async execute(args, exec) {
    if (exec.agent.isSubagent) return errorOutput('ask_user_question is not available to delegated subagents; state the open question in your reply instead', 'DELEGATED_CALLER')
    if (!args.questions.length) return errorOutput('invalid arguments: at least one question is required', 'INVALID_ARGS')
    const answers = await exec.askUser(args.questions)
    return textOutput(JSON.stringify({ answers }), { display: { kind: 'questions', questions: args.questions, answers } })
  },
}

export const presentTool = {
  name: 'present',
  description: 'Declare existing files as final deliverables for the user. '
    + 'Hosts may show presented files only after your turn ends, so call it once the files are final. '
    + 'If the user needs to review files earlier, such as before a tool call that waits for their answer, link them in your message instead. '
    + 'Use it when the user needs a separate file, especially Office documents, spreadsheets, and slide decks; '
    + 'prefer your final response when that suffices. The user opens the current files; their contents are not copied.',
  parameters: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        description: 'Usually the 1-2 most important deliverables; at most 4 per call.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path of an existing regular file. Relative paths use the Session working directory.' },
            description: { type: 'string', description: 'Brief description for the user.' },
          },
          required: ['path'],
        },
      },
    },
    required: ['files'],
  },
  async execute(args, exec) {
    if (!args.files.length || args.files.length > 4) return errorOutput('invalid arguments: present 1 to 4 files per call', 'INVALID_ARGS')
    const files = []
    for (const f of args.files) {
      const path = resolve(exec.cwd, f.path)
      const st = await exec.vfs.stat(path)
      if (!st || st.type !== 'file') return errorOutput(`"${path}" is not an existing regular file`, 'NOT_A_FILE')
      files.push({ path, description: f.description || '', size: st.size })
    }
    exec.session.append('deliverables/present', { files, turn: exec.turn })
    return textOutput(files.map(f => `Presented ${f.path}`).join('\n'), { display: { kind: 'present', files } })
  },
}
