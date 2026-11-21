// Goals (upstream dsh-goal, dsh-tool-goal, dsh-goal-round-driver): a persisted
// objective that keeps a session working across automatic continuation rounds.
import { shortId, makeError } from './util.js'
import { textOutput } from './tools/runtime.js'

export const DEFAULT_MAX_ROUNDS = 256
export const BLOCKED_AFTER = 3

/** Current goal snapshot from the session log (null when none). */
export function currentGoal(session) {
  const ev = session.last('goal/change')
  return ev && ev.data.goal ? ev.data.goal : null
}

export function goalGuidance() {
  return 'create_goal may infer goal intent from a direct human request in any language. '
    + 'After session resume or fork, an active goal is disarmed: when '
    + 'a human asks to continue or resume in any wording or language, use update_goal action '
    + 'resume to rearm it. Mark complete only when the objective is actually achieved. Mark '
    + `blocked only after the same blocking condition persists for at least ${BLOCKED_AFTER} `
    + 'consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, '
    + 'or useful remaining work is not blocked.'
}

export function renderGoalRoundPrompt(goal, round) {
  return '<goal_round>\n'
    + `Objective: ${JSON.stringify(goal.objective)}\n`
    + `Round: ${round}/${goal.maxGoalRounds}\n\n`
    + 'Continue working toward the objective in this same session. Treat the current workspace, '
    + 'tool results, and durable session state as authoritative; inspect them instead of assuming '
    + 'earlier narration is still current. Make concrete progress and verify the result. Before '
    + 'claiming completion, gather evidence that the whole objective is achieved, read the current '
    + 'goal, and mark it complete. If work remains, leave the goal active for the next round. Follow '
    + 'the configured goal-tool policy before reporting a blocker.\n'
    + '</goal_round>'
}

export function goalView(goal, armed) {
  if (!goal) return { goal: null }
  const g = { id: goal.id, revision: goal.revision, objective: goal.objective, phase: goal.phase, roundsStarted: goal.roundsStarted, maxGoalRounds: goal.maxGoalRounds }
  if (goal.blockedReason) g.blockedReason = goal.blockedReason
  return { goal: g, activation: armed ? 'armed' : 'disarmed' }
}

/** Goal controller attached to an agent. */
export class GoalController {
  constructor(agent) {
    this.agent = agent
    this.armed = false // in-memory only: a resumed or forked session starts disarmed
  }

  get session() { return this.agent.session }
  get() { return currentGoal(this.session) }

  commit(goal, reason) {
    this.session.append('goal/change', { goal, reason })
    this.agent.emitChange()
    return goal
  }

  create(objective, maxRounds, by) {
    const text = String(objective || '').trim()
    if (!text) throw makeError('INVALID_ARGS', 'invalid arguments: objective must not be empty')
    const max = maxRounds === undefined ? DEFAULT_MAX_ROUNDS : maxRounds
    if (!(Math.floor(max) === max && max > 0)) throw makeError('INVALID_ARGS', 'invalid arguments: max_goal_rounds must be a positive integer')
    this.armed = true
    return this.commit({ id: 'goal-' + shortId(8), revision: 1, objective: text, phase: 'active', roundsStarted: 0, maxGoalRounds: max, createdBy: by || 'human' }, 'create')
  }

  update(patch, reason) {
    const g = this.get()
    if (!g) throw makeError('GOAL_NOT_FOUND', 'there is no current goal')
    return this.commit(Object.assign({}, g, patch, { revision: g.revision + 1 }), reason)
  }

  clear() { this.armed = false; this.commit(null, 'clear') }

  pause() { this.armed = false; return this.update({ phase: 'paused' }, 'pause') }

  resume() {
    const g = this.get()
    if (!g) throw makeError('GOAL_NOT_FOUND', 'there is no current goal')
    this.armed = true
    if (g.phase === 'active') { this.agent.emitChange(); return g }
    return this.update({ phase: 'active', blockedReason: undefined }, 'resume')
  }

  /** Called by the agent when it becomes idle: queue the next round if armed. */
  maybeContinue() {
    const g = this.get()
    if (!g || g.phase !== 'active' || !this.armed) return false
    if (g.roundsStarted >= g.maxGoalRounds) {
      this.update({ phase: 'blocked', blockedReason: { code: 'round-limit', message: `reached the round limit of ${g.maxGoalRounds}` } }, 'round-limit')
      this.armed = false
      return false
    }
    const round = g.roundsStarted + 1
    this.update({ roundsStarted: round }, 'round')
    this.agent.prompt({ content: [{ type: 'text', text: renderGoalRoundPrompt(g, round) }], source: { kind: 'goal', goalId: g.id, round } }, 'queue')
    return true
  }
}

export function createGoalTools() {
  const humanTurn = exec => !exec.turnSource || exec.turnSource === 'human'
  const out = (exec) => textOutput(JSON.stringify(goalView(exec.agent.goal.get(), exec.agent.goal.armed)), { display: { kind: 'goal', goal: exec.agent.goal.get() } })
  return [
    {
      name: 'create_goal',
      description: 'Create a persisted goal that keeps this session working across automatic continuation rounds. '
        + 'Use it when the direct human request is a long-running objective, even if the user did not say "goal"; '
        + 'not for single-turn work.',
      parameters: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'The concrete completion objective inferred from the direct human request.' },
          max_goal_rounds: { type: 'number', description: 'Optional positive safe-integer limit on automatic continuation rounds.' },
        },
        required: ['objective'],
      },
      guidance: () => goalGuidance(),
      when: ctx => !ctx.isSubagent,
      async execute(args, exec) {
        if (!humanTurn(exec)) throw makeError('GOAL_REQUIRES_HUMAN', 'create_goal requires a direct top-level human request')
        exec.agent.goal.create(args.objective, args.max_goal_rounds, 'model')
        return out(exec)
      },
    },
    {
      name: 'get_goal',
      description: 'Read the current session goal, including the id and revision that update_goal requires.',
      parameters: { type: 'object', properties: {} },
      readOnly: true,
      isConcurrencySafe: () => true,
      when: ctx => !ctx.isSubagent,
      async execute(args, exec) { return out(exec) },
    },
    {
      name: 'update_goal',
      description: 'Update the current goal.',
      parameters: {
        type: 'object',
        properties: {
          goal_id: { type: 'string', description: 'Exact id returned by get_goal.' },
          revision: { type: 'number', description: 'Exact positive revision returned by get_goal.' },
          action: {
            type: 'string',
            enum: ['edit', 'pause', 'resume', 'complete', 'blocked'],
            description: 'edit, pause, and resume require a direct top-level human request. complete and blocked are also allowed '
              + 'during an automatic continuation of this goal; blocked is rejected before the configured minimum round count.',
          },
          objective: { type: 'string', description: 'Replacement objective; valid only with action edit.' },
          max_goal_rounds: { type: 'number', description: 'Replacement cap; valid only with action edit.' },
          blocked_reason: { type: 'string', description: 'Required only with action blocked: the concrete condition that persisted across rounds and blocks progress.' },
        },
        required: ['goal_id', 'revision', 'action'],
      },
      when: ctx => !ctx.isSubagent,
      async execute(args, exec) {
        const ctl = exec.agent.goal
        const g = ctl.get()
        if (!g || g.id !== args.goal_id) throw makeError('GOAL_NOT_FOUND', 'no goal with that id; call get_goal first')
        if (g.revision !== args.revision) throw makeError('GOAL_REVISION_CONFLICT', `the goal changed (current revision ${g.revision}); call get_goal and retry`)
        const human = humanTurn(exec)
        switch (args.action) {
          case 'edit': {
            if (!human) throw makeError('GOAL_REQUIRES_HUMAN', 'edit requires a direct top-level human request')
            const patch = {}
            if (args.objective !== undefined) patch.objective = String(args.objective).trim()
            if (args.max_goal_rounds !== undefined) patch.maxGoalRounds = args.max_goal_rounds
            ctl.update(patch, 'edit')
            break
          }
          case 'pause':
            if (!human) throw makeError('GOAL_REQUIRES_HUMAN', 'pause requires a direct top-level human request')
            ctl.pause(); break
          case 'resume':
            if (!human) throw makeError('GOAL_REQUIRES_HUMAN', 'resume requires a direct top-level human request')
            if (g.phase === 'paused') throw makeError('GOAL_TOOL_RESUME_PAUSED', 'a paused goal can only be resumed by the user (/goal resume)')
            ctl.resume(); break
          case 'complete':
            ctl.update({ phase: 'complete' }, 'complete'); ctl.armed = false; break
          case 'blocked':
            if (g.roundsStarted < BLOCKED_AFTER) throw makeError('GOAL_BLOCKED_TOO_EARLY', `blocked is only allowed after ${BLOCKED_AFTER} goal rounds`)
            if (!args.blocked_reason) throw makeError('INVALID_ARGS', 'invalid arguments: blocked_reason is required with action blocked')
            ctl.update({ phase: 'blocked', blockedReason: { code: 'model', message: String(args.blocked_reason) } }, 'blocked'); ctl.armed = false; break
          default: break
        }
        return out(exec)
      },
    },
  ]
}
