// Scheduled tasks (upstream dsh-schedule + dsh-tool-schedule). Tasks persist in
// /app/schedule.json and are delivered while the app runs; after downtime only
// the latest missed occurrence is delivered.
import { Emitter, shortId, makeError, clone } from './util.js'
import { parseRrule, nextOccurrence, formatLocal } from './rrule.js'
import { textOutput } from './tools/runtime.js'

const FILE = '/app/schedule.json'
const MAX_TITLE = 120

export class ScheduleService extends Emitter {
  /** deliver(task) -> Promise<{sessionId}> is supplied by the agent manager. */
  constructor({ vfs, deliver }) {
    super()
    this.vfs = vfs
    this.deliver = deliver
    this.tasks = []
    this.timer = null
    this.ticking = false
  }

  async init() {
    const data = await this.vfs.readJson(FILE, { tasks: [] })
    this.tasks = Array.isArray(data.tasks) ? data.tasks : []
    for (const t of this.tasks) this._refreshNext(t, new Date(Math.max(t.lastRunAt || 0, (t.createdAt || 0) - 1)))
  }

  save() {
    return this.vfs.writeJson(FILE, { tasks: this.tasks }).catch(() => {}).then(() => this.emit('change'))
  }

  start(intervalMs = 20000) {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), intervalMs)
    setTimeout(() => this.tick(), 1500)
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null } }

  _refreshNext(t, after) {
    try {
      const rule = parseRrule(t.rrule)
      const next = nextOccurrence(rule, after || new Date())
      t.nextAt = next ? next.getTime() : null
      if (!next) { t.active = false; t.ended = true }
    } catch (e) { t.nextAt = null; t.error = e.message }
  }

  view(t) {
    const status = t.ended ? 'ended' : t.active ? 'active' : 'paused'
    return {
      id: t.id, title: t.title, prompt: t.prompt, rrule: t.rrule, target: t.target, status, active: !!t.active,
      scheduledAt: t.nextAt ? new Date(t.nextAt).toISOString() : null,
      scheduledAtLocal: t.nextAt ? formatLocal(new Date(t.nextAt)) : null,
      sessionId: t.sessionId || null, workspaceId: t.workspaceId || null,
      createdAt: new Date(t.createdAt).toISOString(), updatedAt: new Date(t.updatedAt).toISOString(),
      lastRunAt: t.lastRunAt ? new Date(t.lastRunAt).toISOString() : null,
    }
  }

  list(opts = {}) {
    let items = this.tasks.slice()
    if (opts.active === true) items = items.filter(t => t.active)
    if (opts.active === false) items = items.filter(t => !t.active)
    items.sort((a, b) => (b.active - a.active) || ((a.nextAt || Infinity) - (b.nextAt || Infinity)))
    const offset = opts.offset || 0
    const limit = Math.min(opts.limit || 100, 500)
    return { tasks: items.slice(offset, offset + limit).map(t => this.view(t)), total: items.length }
  }

  get(id) { return this.tasks.find(t => t.id === id) }

  create(spec) {
    const title = String(spec.title || '').trim()
    if (!title) throw makeError('INVALID_ARGS', 'invalid arguments: title must not be empty')
    if (title.length > MAX_TITLE) throw makeError('INVALID_ARGS', `invalid arguments: title is longer than ${MAX_TITLE} characters`)
    if (!String(spec.prompt || '').trim()) throw makeError('INVALID_ARGS', 'invalid arguments: prompt must not be empty')
    parseRrule(spec.rrule)
    const now = Date.now()
    const t = {
      id: 'sched-' + shortId(8), title, prompt: spec.prompt, rrule: String(spec.rrule).replace(/\\n/g, '\n'), target: spec.target || 'this_session',
      originSessionId: spec.originSessionId || null, sessionId: spec.target === 'this_session' ? spec.originSessionId : null,
      workspaceId: spec.workspaceId || null, cwd: spec.cwd || null, preset: spec.preset || 'standard',
      active: true, createdAt: now, updatedAt: now, lastRunAt: null, runs: [],
    }
    this._refreshNext(t, new Date(now))
    if (!t.nextAt) throw makeError('SCHEDULE_NO_OCCURRENCE', 'the rule has no future occurrence')
    this.tasks.push(t)
    this.save()
    return t
  }

  edit(id, patch) {
    const t = this.get(id)
    if (!t) return { notFound: true }
    if (patch.expectedUpdatedAt && new Date(t.updatedAt).toISOString() !== patch.expectedUpdatedAt) return { conflict: true, task: this.view(t) }
    if (patch.action === 'delete') {
      this.tasks = this.tasks.filter(x => x !== t)
      this.save()
      return { deleted: true, id }
    }
    if (patch.title !== undefined) t.title = String(patch.title).trim().slice(0, MAX_TITLE)
    if (patch.prompt !== undefined) t.prompt = patch.prompt
    if (patch.rrule !== undefined) { parseRrule(patch.rrule); t.rrule = String(patch.rrule).replace(/\\n/g, '\n'); t.ended = false }
    if (patch.target !== undefined) { t.target = patch.target; t.sessionId = patch.target === 'this_session' ? (patch.originSessionId || t.originSessionId) : null }
    if (patch.active !== undefined) t.active = !!patch.active
    t.updatedAt = Date.now()
    this._refreshNext(t, new Date())
    if (patch.active === true && !t.nextAt) { t.active = false; throw makeError('SCHEDULE_NO_OCCURRENCE', 'the task has no future occurrence; provide a new rrule') }
    if (t.nextAt) { t.ended = false; if (patch.active === undefined && t.active === false && patch.rrule) t.active = true }
    this.save()
    return { task: t }
  }

  clearEnded() { this.tasks = this.tasks.filter(t => !t.ended); this.save() }

  async runNow(id) {
    const t = this.get(id)
    if (!t) throw makeError('SCHEDULE_NOT_FOUND', 'unknown task')
    await this._deliver(t, Date.now(), true)
  }

  async _deliver(t, at, manual) {
    let result = {}
    try { result = (await this.deliver(t)) || {} } catch (e) { result = { error: e.message } }
    if (t.target === 'new_once' && result.sessionId) t.sessionId = result.sessionId
    t.runs = (t.runs || []).concat([{ at, sessionId: result.sessionId || null, status: result.error ? 'failed' : 'delivered', error: result.error, manual: !!manual }]).slice(-50)
    t.lastRunAt = at
    if (!manual) this._refreshNext(t, new Date(at))
    t.updatedAt = Date.now()
    await this.save()
  }

  async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = Date.now()
      for (const t of this.tasks.slice()) {
        if (!t.active || !t.nextAt || t.nextAt > now) continue
        // only the latest missed occurrence is delivered
        await this._deliver(t, now, false)
      }
    } finally { this.ticking = false }
  }
}

const MANAGEMENT_AUTHORIZATION = "Only create or modify scheduled tasks at the user's explicit request; "
  + 'prior explicit user authorization for the running scheduled task remains valid.'

const TITLE_HELP = `Task name of at most ${MAX_TITLE} characters in the user's language: action plus object. `
  + 'Omit timing, status, ids, and bracketed suffixes.'

const RRULE_HELP = 'Supported RFC 5545 subset: one DTSTART line, a newline, and one RRULE line. '
  + 'DTSTART ends in Z for UTC or carries TZID with an IANA time zone; '
  + 'a fixed offset such as UTC+5 is Etc/GMT-5, with the sign reversed. '
  + 'DTSTART must name an existing local time. A TZID rule keeps local clock time across daylight-saving changes; '
  + 'generated nonexistent local times are skipped, and repeated ones occur once, at the earlier instant. '
  + 'DTSTART may be in the past; delivery starts with the first occurrence after creation. '
  + 'A one-time delivery is RRULE:FREQ=DAILY;COUNT=1. '
  + 'No SECONDLY; BYSECOND takes one value. COUNT is at most 1000; use UNTIL for longer rules. '
  + 'MINUTELY and HOURLY accept no BY parts, so select clock times with DAILY or WEEKLY plus BYHOUR and BYMINUTE. '
  + 'BYMONTHDAY and ordinal BYDAY require MONTHLY or YEARLY; BYYEARDAY and BYWEEKNO require YEARLY. '
  + 'Ordinal BYDAY cannot combine with BYWEEKNO. Each FREQ period allows at most 10080 candidates before BYSETPOS, '
  + 'which accepts at most 31 values. '
  + 'UNTIL is a UTC instant ending in Z. '
  + 'On this device TZID times use the phone\'s own time zone. '
  + 'Example: "DTSTART;TZID=Asia/Singapore:20260901T080000\\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1"'

const TARGET_HELP = 'this_session delivers to this session; '
  + 'new_once delivers to the same new session every time, opened at the first delivery; new opens a different '
  + "new session for every delivery. New sessions use this session's working directory and preset. "
  + 'With this_session or new_once, a delivery waits until the previous one finishes, and only the latest occurrence '
  + 'that passed meanwhile is delivered. '
  + 'Use this_session for reminders and for follow-ups to this conversation; use new_once or new for independent work, '
  + 'such as a recurring report, and whenever the user asks for a new conversation.'

const json = (v, display) => textOutput(JSON.stringify(v), { display })

export function createScheduleTools(service) {
  const guard = (exec) => { if (exec.agent.isSubagent) throw makeError('DELEGATED_CALLER', 'scheduled tasks cannot be managed by subagents') }
  const visible = ctx => !ctx.isSubagent
  return [
    {
      name: 'schedule_create',
      description: 'Create a scheduled task. At each occurrence of rrule, prompt is delivered to the target session '
        + 'as a scheduled message from the user. The result includes the task id and the next occurrence as scheduledAt in UTC '
        + 'and scheduledAtLocal in the zone of rrule. '
        + 'After downtime, only the latest missed occurrence is delivered. Delivery can repeat after a crash.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: TITLE_HELP },
          prompt: { type: 'string', description: 'Instruction delivered at each occurrence.' },
          rrule: { type: 'string', description: RRULE_HELP },
          target: { type: 'string', enum: ['this_session', 'new_once', 'new'], description: TARGET_HELP },
        },
        required: ['title', 'prompt', 'rrule', 'target'],
      },
      when: visible,
      guidance: () => MANAGEMENT_AUTHORIZATION,
      async execute(args, exec) {
        guard(exec)
        const t = service.create({ title: args.title, prompt: args.prompt, rrule: args.rrule, target: args.target, originSessionId: exec.session.id, workspaceId: exec.session.meta.workspaceId, cwd: exec.cwd, preset: exec.session.meta.preset })
        return json(service.view(t), { kind: 'schedule', action: 'create', title: t.title })
      },
    },
    {
      name: 'schedule_list',
      description: 'List scheduled tasks, including tasks created from other sessions. Active tasks come first, ordered by scheduledAt.',
      parameters: {
        type: 'object',
        properties: {
          active: { type: 'boolean', description: 'true for active tasks only; false for paused and ended tasks only; omitted for all tasks.' },
          limit: { type: 'integer', description: 'Page size from 1 to 500; defaults to 100.' },
          offset: { type: 'integer', description: 'Number of tasks to skip; defaults to 0.' },
        },
      },
      readOnly: true,
      isConcurrencySafe: () => true,
      when: visible,
      async execute(args, exec) { guard(exec); return json(service.list(args), { kind: 'schedule', action: 'list' }) },
    },
    {
      name: 'schedule_view',
      description: 'View one scheduled task by id.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'Task id.' } }, required: ['id'] },
      readOnly: true,
      isConcurrencySafe: () => true,
      when: visible,
      async execute(args, exec) {
        guard(exec)
        const t = service.get(args.id)
        return json(t ? Object.assign(service.view(t), { runs: clone(t.runs || []).slice(-10) }) : { error: 'schedule_not_found', id: args.id }, { kind: 'schedule', action: 'view' })
      },
    },
    {
      name: 'schedule_edit',
      description: 'Update, pause, resume, or delete one scheduled task by id. Deleting does not retract queued messages.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id.' },
          action: { type: 'string', enum: ['update', 'delete'], description: 'update applies the provided fields, at least one; delete removes the task.' },
          title: { type: 'string', description: TITLE_HELP },
          prompt: { type: 'string', description: 'New instruction delivered at each occurrence.' },
          rrule: { type: 'string', description: 'New recurrence in the schedule_create rrule format.' },
          target: { type: 'string', enum: ['this_session', 'new_once', 'new'], description: "Omit to retain the destination and its creation settings. Providing target replaces them; new_once reserves a different Session. New targets capture this Session's working directory and preset. Choices are the same as schedule_create." },
          active: { type: 'boolean', description: 'false pauses the task; true resumes only if its timing has a future occurrence. Otherwise provide a new rrule.' },
          expectedUpdatedAt: { type: 'string', description: 'updatedAt from the latest result that returned this task; if the task changed after that result, the result is schedule_conflict and nothing changes.' },
        },
        required: ['id', 'action'],
      },
      when: visible,
      async execute(args, exec) {
        guard(exec)
        if (args.action === 'update' && ['title', 'prompt', 'rrule', 'target', 'active'].every(k => args[k] === undefined)) throw makeError('INVALID_ARGS', 'invalid arguments: update needs at least one field')
        const r = service.edit(args.id, Object.assign({}, args, { originSessionId: exec.session.id }))
        if (r.notFound) return json({ error: 'schedule_not_found', id: args.id })
        if (r.conflict) return json({ error: 'schedule_conflict', task: r.task })
        if (r.deleted) return json({ deleted: true, id: args.id }, { kind: 'schedule', action: 'delete' })
        return json(service.view(r.task), { kind: 'schedule', action: 'update', title: r.task.title })
      },
    },
  ]
}
