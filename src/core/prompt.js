// System prompt sections and runtime-context reminders (upstream
// packages/core/system-prompt, agent-loop/runtime-context.ts, sandbox-policy,
// user-approval, subagent identity, time-context).
import { localIsoWithOffset, deviceTimeZone, formatDuration } from './util.js'

export const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'
export const PERSONA_STANDARD = 'You are a coding agent powered by the {{model}} model.'

export const PLAN_POLICY = [
  "You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.",
  'Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.',
  'The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.',
  'Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.',
  'Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.',
  'When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.',
].join('\n\n')

/** Device surface section: the phone port's counterpart of upstream's web-surface section. */
export const SURFACE_SECTION = [
  '# Device',
  'You are running inside DSH Mobile, a port of DeepSeek Harness to a Windows Phone device. The user reads your replies on a small phone screen: keep answers well structured and reasonably short, and prefer concise Markdown (short paragraphs, lists, small tables).',
  'There is no shell, terminal, Node.js, Python, git or package manager on this device. Work through the available tools: file tools for the workspace, run_code for computation (sandboxed JavaScript that can call other tools), web_search/web_fetch for the internet, and subagents for independent delegated work.',
  'Workspace folders are virtual paths such as /workspaces/<name> (app storage) or /mnt/<id> (a folder on the phone or SD card). /tmp is scratch space. Do not invent other absolute paths.',
].join('\n')

// Tool guidance order (upstream section orders): read 1100, write 1200, edit 1300,
// glob 1400, grep 1500, apply_patch, web_search / web_fetch 1600–2200, goal 2400,
// schedule 2500, subagent 2800, MCP 3100; run_code is this port's addition.
export const GUIDANCE_ORDER = ['read', 'write', 'edit', 'apply_patch', 'glob', 'grep', 'web_search', 'web_fetch', 'create_goal', 'schedule_create', 'subagent', 'run_code']

export const PRESETS = {
  standard: { id: 'standard', persona: PERSONA_STANDARD, runtimeContext: true, tools: 'all' },
  ptc: { id: 'ptc', persona: PERSONA_STANDARD, runtimeContext: true, tools: ['run_code', 'todo_write', 'ask_user_question', 'exit_plan_mode', 'skill'], ptc: true },
  minimal: { id: 'minimal', persona: 'You are a helpful software engineer assistant.', complete: true, runtimeContext: false, tools: ['read', 'write', 'edit', 'glob', 'grep', 'todo_write'] },
}

export function presetOf(id) { return PRESETS[id] || PRESETS.standard }

/** Assemble the system prompt for one step. */
export function assembleSystemPrompt({ preset, model, planMode, tools, mcpSection, extraSections }) {
  const p = presetOf(preset)
  const modelName = (model && (model.name || model.id)) || 'DeepSeek'
  if (p.complete) return p.persona
  const sections = [IDENTITY, p.persona.replace(/\{\{model\}\}/g, modelName)]
  if (planMode) sections.push(PLAN_POLICY)
  const visible = tools.map(t => t.name)
  const byName = {}
  for (const t of tools) byName[t.name] = t
  for (const name of GUIDANCE_ORDER) {
    const t = byName[name]
    if (t && t.guidance) { const g = t.guidance(visible); if (g) sections.push(g) }
  }
  for (const t of tools) {
    if (GUIDANCE_ORDER.indexOf(t.name) >= 0 || !t.guidance) continue
    const g = t.guidance(visible)
    if (g && sections.indexOf(g) < 0) sections.push(g)
  }
  if (mcpSection) sections.push(mcpSection)
  for (const s of extraSections || []) if (s) sections.push(s)
  sections.push(SURFACE_SECTION)
  return sections.filter(Boolean).join('\n\n')
}

// ---------------------------------------------------------------- runtime context

export function sandboxPolicyText(mode, workspaceRoot) {
  switch (mode) {
    case 'read-only':
      return 'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.'
    case 'danger-full-access':
      return 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.'
    default:
      return `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(workspaceRoot)}. Some platform temporary areas may also be writable.`
  }
}

export const APPROVAL_NEVER = 'Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).'
export const APPROVAL_ASK = 'Approval prompts are enabled in this session: operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed.'
export const POLICY_NOTICE_NAMES = { ask: 'ask the user for approval', never: 'never ask the user for approval' }

export const SUBAGENT_DELEGATION_CONTEXT = 'You are a delegated subagent: your permission scope was fixed when you were started and cannot be '
  + 'widened from inside this session — operations that require approval are rejected automatically. '
  + 'When the task needs access beyond that scope, do not retry the denied operation; state the '
  + 'limitation in your reply so the delegating agent can handle it. Messages from other agents begin with '
  + '"Agent <name> sent a message:". Other user messages come from the human user, who reads this conversation '
  + 'directly. You can still message other agents to coordinate, but answer the human user in your reply.'

/** Named runtime-context sections for one step. */
export function runtimeSections({ cwd, sandbox, approval, agentName, parentName, isSubagent, hasMessaging, depth, maxDepth, hasSubagentTool }) {
  const sections = []
  sections.push({ name: 'working-directory:current', text: `Current working directory: ${JSON.stringify(cwd)}.` })
  sections.push({ name: 'sandbox:policy', text: sandboxPolicyText(sandbox.mode, sandbox.workspaceRoot) })
  sections.push({ name: 'approval:policy', text: approval === 'never' ? APPROVAL_NEVER : APPROVAL_ASK })
  let identity = isSubagent
    ? `You are a subagent delegated by agent ${JSON.stringify(parentName)}.\nYour name is ${JSON.stringify(agentName)}.\nThe root agent of your collaboration tree is "lead".`
    : 'You are the root agent. Your name is "lead".'
  if (hasMessaging) {
    const guidance = ['To message other agents, use send_message({ agent: "<agent-name>", message: "..." }).']
    if (isSubagent) guidance.push('When you finish, use send_message to send a self-contained result to the agent that delegated you. Message any agent as soon as a finding changes what it should do next; sending a message does not end your turn.')
    guidance.push('Use list_agents({}) to find your collaborator agents and their names.')
    identity += '\n\n' + guidance.join('\n')
  }
  sections.push({ name: 'subagent:identity', text: identity })
  if (isSubagent) sections.push({ name: 'subagent:delegation', text: SUBAGENT_DELEGATION_CONTEXT })
  if (hasSubagentTool && maxDepth !== undefined && depth >= maxDepth) {
    sections.push({ name: 'tool:subagent:depth', text: `Delegation depth for \`subagent\`: current ${depth}, maximum ${maxDepth}, remaining levels 0. Do not call \`subagent\` at this depth; carry out the work directly.` })
  }
  return sections
}

export function renderRuntimeContext(sections, replacement) {
  if (!sections.length) return 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'
  const intro = replacement
    ? 'The following information describes your current session. It replaces earlier versions of this context, including any retained in conversation summaries.'
    : 'The following information describes your current session:'
  const body = sections.map(s => s.text).join('\n\n').replace(/<\/system-reminder\s*>/gi, t => '<\\' + t.slice(1))
  return `<system-reminder>\n${intro}\n\n${body}\n</system-reminder>`
}

export function renderTimeContext({ turn, step, now, previous }) {
  const tz = deviceTimeZone()
  const elapsed = previous === undefined ? 'unavailable' : formatDuration(now - previous)
  const baseline = step === 1 ? 'model-visible message' : 'step context'
  return '<system-reminder>\n'
    + `Time sampled while preparing turn ${turn}, step ${step}: ${localIsoWithOffset(new Date(now))}[${tz}]\n`
    + `Device time zone for this request: ${tz}. \n`
    + `Elapsed since the preceding ${baseline}: ${elapsed}.\n</system-reminder>`
}

export const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  '- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.',
].join('\n')

export const CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

export function titleSystemPrompt() {
  return [
    'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    'Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    'Aim for about 5 words in non-CJK languages or 10 CJK characters.',
    'If the messages give little to name, still return a short best-effort title, such as Greeting, instead of explaining.',
  ].join('\n')
}

export function titleFrame(messages) {
  return `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages)}`
}

export const GENTLE_REPEAT = 'You are repeating the exact same tool call with identical arguments. '
  + 'Carefully analyze the previous result before calling again: if the task is '
  + 'not complete, try a different approach or different arguments instead of '
  + 'repeating the call.'

export function detailedRepeat(toolName, count, canonicalArguments) {
  return 'Repeated tool call detected:\n'
    + `- tool: ${toolName}\n`
    + `- consecutive_calls: ${count}\n`
    + `- arguments: ${canonicalArguments}\n`
    + 'The repeated calls are not making progress. Do not call this tool with '
    + 'these exact arguments again. Inspect the latest result and choose a '
    + 'different action, different arguments, or finish the task if enough '
    + 'evidence has been gathered.'
}

export const SUBAGENT_PROMPT_SUFFIX = 'Your final answer is delivered automatically if your '
  + 'parent is still online. Include the result and relevant evidence in that answer; the parent does not '
  + 'receive your full transcript, tool output, or reasoning. If your last action is a message to your '
  + 'parent, the completion notice omits your final answer; include the result and relevant evidence in that message.'

export function settlementSummary(name, reason, continuable = true) {
  const subject = `Background subagent ${name}`
  switch (reason) {
    case 'completed': return continuable ? `${subject} finished and will do no further work unless you send it more.` : `${subject} finished. It cannot receive follow-up messages.`
    case 'aborted': return `${subject} was stopped before it finished.`
    case 'max-tokens': return `${subject} ran out of room before it finished.`
    case 'blocked': return `${subject} declined the task.`
    case 'error': return `${subject} failed before it finished.`
    default: return `${subject} ended abnormally (${String(reason)}) before it finished.`
  }
}
