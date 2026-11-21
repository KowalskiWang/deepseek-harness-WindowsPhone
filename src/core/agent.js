// The agent loop (upstream packages/core/agent-loop): durable inbox with queue
// and steer, turn → step algorithm, streamed model requests with retries,
// ordered parallel tool execution, abort semantics, context injection,
// compaction and interactive requests (approval, questions, plan review).
import { Emitter, createAbort, sleep, deferred, shortId, isAbortError, abortError, stableStringify, clip, collapseWhitespace, utf8Length, truncateUtf8, throttle } from './util.js'
import { eventToMessage, closeOpenTurn, textOfBlocks } from './session.js'
import { executeBatch } from './tools/runtime.js'
import { retryDecision } from './llm/errors.js'
import { assembleSystemPrompt, runtimeSections, renderRuntimeContext, renderTimeContext, presetOf, POLICY_NOTICE_NAMES, GENTLE_REPEAT, detailedRepeat, titleSystemPrompt, titleFrame, settlementSummary } from './prompt.js'
import { budget, measure, compact } from './compaction.js'
import { GoalController } from './goal.js'
import { renderSkillCatalog, skillCatalogSignature } from './skills.js'
import { loadInstructions, renderInstructions, instructionSignature, additionalInstructions } from './instructions.js'
import { dirname, isWithin } from './paths.js'

const TIME_REFRESH_MS = 10 * 60 * 1000
const REPEAT_THRESHOLDS = [3, 5, 8]

export const PERMISSION_PRESETS = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
}

export class Agent extends Emitter {
  constructor(rt, session, opts) {
    super()
    const o = opts || {}
    this.rt = rt
    this.session = session
    this.name = o.name || 'lead'
    this.parent = o.parent || null
    this.depth = o.depth || 0
    this.isSubagent = !!o.parent
    this.description = o.description || ''
    this.children = {} // short name -> {agent, description, startedAt}
    this.childSeq = 0
    this.inbox = { nextTurn: (session.meta.queued || []).slice(), nextStep: [] }
    this.running = false
    this.status = 'idle'
    this.turnCtl = null
    this.live = null
    this.pending = null // {kind, id, payload, resolve}
    this.pendingNotices = []
    this.goal = new GoalController(this)
    this.repeat = { key: null, count: 0 }
    this.instrSig = null
    this.skillSig = null
    this.touchedDirs = {}
    this.lastTimeContext = undefined
    this.lastVisibleAt = undefined
    this.titleRequested = false
    this.lastSentToParent = false
    this._emitChange = throttle(() => this.emit('change'), 120)
    // A session left mid-turn (app closed, crash) is closed with synthetic results.
    if (closeOpenTurn(session, 'interrupted')) this.rt.sessions.updateMeta(session.id, { status: 'idle' })
  }

  get meta() { return this.session.meta }
  emitChange() { this._emitChange() }

  // ------------------------------------------------------------------ state

  planMode() {
    const ev = this.session.last('plan/mode')
    return !!(ev && ev.data.active)
  }

  setPlanMode(active, by) {
    if (this.planMode() === !!active) return
    this.session.append('plan/mode', { active: !!active, by: by || 'user' })
    if (by !== 'approval') this.pendingNotices.push(active ? 'The user switched this session to plan mode.' : 'The user switched this session back to the default mode.')
    this.emitChange()
  }

  permissionPreset() {
    if (this.isSubagent) return this.meta.permission || 'workspace-write'
    return this.meta.permission || this.rt.settings.get().general.defaultPermission || 'workspace-write'
  }

  permission() {
    const preset = this.permissionPreset()
    const p = PERMISSION_PRESETS[preset] || PERMISSION_PRESETS['workspace-write']
    return { preset, sandbox: p.sandbox, approval: this.isSubagent ? 'never' : p.approval }
  }

  setPermission(preset) {
    if (!PERMISSION_PRESETS[preset]) throw new Error('unknown permission preset ' + preset)
    const before = this.permission()
    this.rt.sessions.updateMeta(this.session.id, { permission: preset })
    this.session.append('permission/preset', { preset })
    const after = this.permission()
    if (before.approval !== after.approval) {
      this.pendingNotices.push(`The user changed the approval policy from "${POLICY_NOTICE_NAMES[before.approval]}" to "${POLICY_NOTICE_NAMES[after.approval]}".`)
    }
    this.emitChange()
  }

  selection() {
    const ev = this.session.last('model/selection')
    if (ev) return ev.data
    if (this.meta.model) return this.meta.model
    return this.rt.defaultSelection()
  }

  setSelection(sel) {
    this.session.append('model/selection', sel)
    this.rt.sessions.updateMeta(this.session.id, { model: sel })
    this.emitChange()
  }

  cwd() { return this.meta.cwd || '/' }

  workspaceRoot() {
    const ws = this.rt.workspaces.get(this.meta.workspaceId)
    return ws ? ws.path : this.cwd()
  }

  setStatus(status) {
    if (this.status === status) return
    this.status = status
    const patch = { status }
    if (status === 'idle' && !this.isSubagent && this.rt.activeSessionId !== this.session.id) patch.unread = true
    this.rt.sessions.updateMeta(this.session.id, patch)
    this.emit('status', status)
    this.emitChange()
  }

  // ------------------------------------------------------------------ input

  /** message: {content:[blocks], source?, displayText?, attachments?}; mode: 'queue' | 'steer'. */
  prompt(message, mode) {
    const msg = Object.assign({ id: shortId(8), at: Date.now() }, message)
    if (mode === 'steer' && this.running) this.inbox.nextStep.push(msg)
    else this.inbox.nextTurn.push(msg)
    this._persistInbox()
    if (this.meta.blank) this.rt.sessions.updateMeta(this.session.id, { blank: false })
    this.rt.sessions.updateMeta(this.session.id, {}, { touch: true })
    this.emitChange()
    this._kick()
    return msg.id
  }

  removeQueued(id) {
    this.inbox.nextTurn = this.inbox.nextTurn.filter(m => m.id !== id)
    this._persistInbox()
    this.emitChange()
  }

  editQueued(id, text) {
    const m = this.inbox.nextTurn.find(x => x.id === id)
    if (!m) return
    m.content = [{ type: 'text', text }].concat((m.content || []).filter(b => b.type !== 'text'))
    this._persistInbox()
    this.emitChange()
  }

  /** Move queued messages (all, or one id) into the running turn. */
  steerQueued(id) {
    const pick = id ? this.inbox.nextTurn.filter(m => m.id === id) : this.inbox.nextTurn.slice()
    if (!pick.length) return
    this.inbox.nextTurn = this.inbox.nextTurn.filter(m => pick.indexOf(m) < 0)
    if (this.running) this.inbox.nextStep.push(...pick)
    else this.inbox.nextTurn.unshift(...pick)
    this._persistInbox()
    this.emitChange()
    this._kick()
  }

  _persistInbox() {
    this.rt.sessions.updateMeta(this.session.id, { queued: this.inbox.nextTurn.map(m => ({ id: m.id, content: m.content, source: m.source, displayText: m.displayText, at: m.at })) })
  }

  /** Stop the running turn. Queued messages stay queued. */
  cancel(reason) {
    if (this.pending) { const p = this.pending; this.pending = null; p.resolve(p.kind === 'approval' ? 'cancelled' : { cancelled: true }) }
    if (this.turnCtl) this.turnCtl.abort(reason || 'user')
    this.inbox.nextStep = []
    for (const k in this.children) {
      const c = this.children[k].agent
      if (c.running) c.cancel('parent')
    }
  }

  _kick() {
    if (this.running) return
    if (!this.inbox.nextTurn.length && !this.inbox.nextStep.length) return
    this.running = true
    setTimeout(() => this._drain(), 0)
  }

  async _drain() {
    this.running = true
    this.setStatus('running')
    try {
      while (this.inbox.nextTurn.length || this.inbox.nextStep.length) {
        await this._turn()
        await this.rt.sessions.flush(this.session).catch(() => {})
      }
    } finally {
      this.running = false
      this.setStatus(this.lastFailed ? 'failed' : 'idle')
      this.emitChange()
      this._afterIdle()
    }
  }

  _afterIdle() {
    if (this.inbox.nextTurn.length || this.inbox.nextStep.length) { this._kick(); return }
    if (this.isSubagent && this.parent && !this.workflowChild) this._settleToParent()
    else if (!this.lastFailed && !this.lastAborted) this.goal.maybeContinue()
    this.rt.onAgentIdle(this)
  }

  // ------------------------------------------------------------------ turn

  async _turn() {
    const turn = this.session.turnCount() + 1
    this.session.append('turn/start', { turn })
    const ctl = createAbort()
    this.turnCtl = ctl
    this.lastFailed = false
    this.lastAborted = false
    let reason = 'completed'
    let error
    let by
    let step = 0
    let sticky = null
    let turnSource = 'human'
    const turnStartedAt = Date.now()
    this.turnStats = { turn, steps: 0, toolCalls: 0, startedAt: turnStartedAt }
    try {
      let first = true
      while (true) {
        const claimed = []
        if (first) {
          claimed.push(...this.inbox.nextStep.splice(0))
          if (this.inbox.nextTurn.length) claimed.push(this.inbox.nextTurn.shift())
          first = false
          const src = claimed.length ? claimed[claimed.length - 1].source : null
          turnSource = src && src.kind ? src.kind : 'human'
        } else claimed.push(...this.inbox.nextStep.splice(0))
        this._persistInbox()
        if (step === 0 && !claimed.length) break
        step++
        this.turnStats.steps = step
        const r = await this._step(turn, step, claimed, ctl.signal, turnSource)
        if (r.maxTokens) { sticky = 'max-tokens'; break }
        if (r.concluded) break
        if (!r.toolCalls && !this.inbox.nextStep.length) break
      }
      reason = sticky || 'completed'
    } catch (e) {
      if (isAbortError(e) || ctl.signal.aborted) {
        reason = 'aborted'
        by = ctl.signal.reason || 'user'
        this.lastAborted = true
      } else {
        reason = 'error'
        error = { code: e.code || 'UNKNOWN', message: e.message || String(e), status: e.status, requestId: e.requestId }
        this.lastFailed = true
      }
    }
    if (this.live) this.live = null
    this._closeOpenStep()
    this.session.append('turn/end', { turn, reason, error, by, durationMs: Date.now() - turnStartedAt })
    this.turnCtl = null
    this.emitChange()
    if (reason === 'error' && !this.isSubagent) this.rt.notify('turn-failed', this, error)
    else if (!this.isSubagent) this.rt.notify('turn-done', this)
  }

  _closeOpenStep() {
    // synthetic results for calls left unanswered by an exception, then step/end
    let stepOpen = false
    const calls = {}
    const started = {}
    const answered = {}
    for (let i = this.session.events.length - 1; i >= 0; i--) {
      const ev = this.session.events[i]
      if (ev.type === 'turn/start') break
      if (ev.type === 'step/end') { if (!stepOpen) break }
      if (ev.type === 'step/start') { stepOpen = true; break }
    }
    if (!stepOpen) return
    for (let i = this.session.events.length - 1; i >= 0; i--) {
      const ev = this.session.events[i]
      if (ev.type === 'step/start') break
      if (ev.type === 'assistant/message') for (const b of ev.data.content || []) if (b.type === 'tool-call') calls[b.id] = b.name
      if (ev.type === 'tool/call') started[ev.data.id] = true
      if (ev.type === 'tool/result') answered[ev.data.callId] = true
    }
    for (const id in calls) {
      if (answered[id]) continue
      this.session.append('tool/result', {
        callId: id, name: calls[id], isError: true, synthetic: true,
        code: started[id] ? 'TOOL_OUTCOME_UNKNOWN' : 'TOOL_NOT_STARTED',
        content: [{ type: 'text', text: started[id] ? 'Error: tool call aborted' : 'Error: tool call aborted before dispatch' }],
      })
    }
    this.session.append('step/end', { synthetic: true })
  }

  // ------------------------------------------------------------------ step

  visibleTools(route) {
    const ctx = { model: route && route.model, isSubagent: this.isSubagent, skills: this._skillsCache || [], agent: this, preset: this.meta.preset }
    return this.rt.toolsFor(this, ctx)
  }

  async _step(turn, step, claimed, signal, turnSource) {
    const settings = this.rt.settings.get()
    let route = this.rt.llm.resolve(this.selection())
    if (step === 1) {
      await Promise.race([this.rt.llm.ensureListing(), sleep(5000)]).catch(() => {})
      route = this.rt.llm.resolve(this.selection())
      this._skillsCache = await this.rt.skillsFor(this).catch(() => [])
      await this.rt.mcp.refresh().catch(() => {})
    }
    const tools = this.visibleTools(route)
    const system = this._systemPrompt(route, tools)
    this.session.append('step/start', { turn, step })
    for (const msg of claimed) {
      this.session.append('user/message', { content: msg.content, source: msg.source, displayText: msg.displayText, queuedAt: msg.at, id: msg.id })
      if (!msg.source || msg.source.kind === 'human') this.lastHumanText = textOfBlocks(msg.content)
    }
    this._reconcileSystem(system)
    await this._injectContext(route, tools, turn, step)

    const maxTokens = route.model.maxTokens
    const b = budget(route.model, maxTokens, settings.agent.compactThreshold)
    if (measure(this.session.surface()) >= b.threshold) {
      await this.compact({ route, tools, system, keep: b.keep, reason: 'pressure', signal })
    }

    let result
    let overflowRetried = false
    const retryPolicy = Object.assign({}, route.provider.retry || {}, settings.models.retry || {})
    for (let attempt = 1; ; attempt++) {
      const messages = this.session.deriveMessages()
      const toolSchemas = tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }))
      const live = { turn, step, startedAt: Date.now(), blocks: [], attempt }
      this.live = live
      this.emitChange()
      try {
        result = await this.rt.llm.stream(route, {
          messages, tools: toolSchemas, effort: route.effort, maxTokens, signal,
          onEvent: (ev) => this._onStreamEvent(live, ev),
        })
      } catch (e) {
        this.live = null
        const partial = e.partial && e.partial.content ? e.partial.content.filter(x => x.type !== 'tool-call' && (x.text || x.signature)) : []
        if (signal.aborted || e.code === 'ABORTED') {
          if (partial.length) this.session.append('assistant/message', { content: partial, interrupted: true, model: route.model.id, provider: route.provider.id, stopReason: 'aborted' })
          else this.session.append('assistant/attempt', { code: 'ABORTED' })
          throw abortError(signal.reason)
        }
        this.session.append('assistant/attempt', { code: e.code, message: e.message, status: e.status })
        if (e.code === 'CONTEXT_WINDOW_EXCEEDED' && !overflowRetried) {
          overflowRetried = true
          await this.compact({ route, tools, system, keep: 0, reason: 'overflow', signal })
          continue
        }
        const d = retryDecision(e, attempt, retryPolicy)
        if (d) {
          this.session.append('llm/retry', { attempt, max: d.max === Infinity ? null : d.max, delayMs: d.delayMs, code: e.code, message: e.message })
          this.emitChange()
          await sleep(d.delayMs, signal)
          continue
        }
        throw e
      }
      break
    }
    this.live = null
    let content = result.content
    if (result.stopReason === 'length') content = content.filter(x => x.type !== 'tool-call')
    this.session.append('assistant/message', {
      content, usage: result.usage, model: route.model.id, provider: route.provider.id, effort: route.effort,
      stopReason: result.stopReason, ttftMs: result.ttftMs, durationMs: result.durationMs, requestId: result.requestId,
    })
    this.lastVisibleAt = Date.now()
    this.emitChange()
    this._maybeTitle(route)
    if (result.stopReason === 'length') { this.session.append('step/end', { turn, step }); return { maxTokens: true } }
    const calls = content.filter(x => x.type === 'tool-call')
    if (!calls.length) { this.session.append('step/end', { turn, step }); return { toolCalls: false } }

    this.turnStats.toolCalls += calls.length
    const byName = {}
    for (const t of tools) byName[t.name] = t
    const exec = this._execContext(route, tools, byName, turn, signal, turnSource)
    const outputs = await executeBatch(calls, {
      resolve: name => byName[name],
      exec,
      signal,
      maxParallel: settings.agent.maxParallelToolCalls || 10,
      onStart: (call) => {
        this.session.append('tool/call', { id: call.id, name: call.name, startedAt: Date.now() })
        this.emitChange()
      },
      onResult: (call, out) => {
        const started = this._toolStartedAt(call.id)
        this.session.append('tool/result', {
          callId: call.id, name: call.name, content: out.content, isError: !!out.isError, code: out.code,
          display: out.display, durationMs: started ? Date.now() - started : undefined, spilledTo: out.spilledTo,
        })
        this.emitChange()
      },
    })
    for (const out of outputs) if (out && out.context) this.inbox.nextStep.push({ id: shortId(8), content: out.context, source: { kind: 'tool-context' } })
    this._repeatGuard(calls)
    await this._instructionUpdates()
    this.session.append('step/end', { turn, step })
    if (signal.aborted) throw abortError(signal.reason)
    return { toolCalls: true, concluded: outputs.some(o => o && o.concludesTurn) }
  }

  _toolStartedAt(id) {
    for (let i = this.session.events.length - 1; i >= 0; i--) {
      const ev = this.session.events[i]
      if (ev.type === 'tool/call' && ev.data.id === id) return ev.data.startedAt
      if (ev.type === 'step/start') break
    }
    return undefined
  }

  _onStreamEvent(live, ev) {
    if (ev.kind === 'block') live.blocks[ev.index] = { type: ev.type, text: '', name: ev.name, id: ev.id }
    else if (ev.kind === 'delta') {
      const b = live.blocks[ev.index] || (live.blocks[ev.index] = { type: ev.type === 'tool-args' ? 'tool-call' : ev.type, text: '' })
      b.text += ev.text
      if (live.firstTokenAt === undefined) live.firstTokenAt = Date.now()
      live.chars = (live.chars || 0) + ev.text.length
    } else if (ev.kind === 'usage') live.usage = ev.usage
    this.emitChange()
  }

  _systemPrompt(route, tools) {
    return assembleSystemPrompt({
      preset: this.meta.preset,
      model: route.model,
      planMode: this.planMode(),
      tools,
      mcpSection: this.rt.mcp.instructionsSection(),
    })
  }

  /** Keep the system prompt as session events: first at position 0, later changes in history. */
  _reconcileSystem(text) {
    const last = this.session.last('system/message')
    if (last && last.data.text === text) return
    this.session.append('system/message', { text })
  }

  async _injectContext(route, tools, turn, step) {
    const add = (text, kind, extra) => {
      if (!text) return
      this.session.append('user/message', { content: [{ type: 'text', text }], source: Object.assign({ kind }, extra || {}) })
    }
    const preset = presetOf(this.meta.preset)
    const names = tools.map(t => t.name)
    // runtime context (cwd, sandbox, approval, identity) — re-sent when changed or compacted away
    if (preset.runtimeContext !== false) {
      const perm = this.permission()
      const maxDepth = this.rt.settings.get().subagent.maxDepth
      const sections = runtimeSections({
        cwd: this.cwd(),
        sandbox: { mode: perm.sandbox, workspaceRoot: this.workspaceRoot() },
        approval: perm.approval,
        agentName: this.name,
        parentName: this.parent ? this.parent.name : undefined,
        isSubagent: this.isSubagent,
        hasMessaging: names.indexOf('send_message') >= 0,
        depth: this.depth,
        maxDepth,
        hasSubagentTool: names.indexOf('subagent') >= 0 || this.depth >= maxDepth,
      })
      const retained = this._retainedSource('runtime-context')
      const sig = JSON.stringify(sections)
      if (!retained || retained.sig !== sig) add(renderRuntimeContext(sections, retained !== null || this._everSent('runtime-context')), 'runtime-context', { sig })
    }
    // workspace instructions (first step of the session, or after compaction removed them)
    if (preset.runtimeContext !== false && step === 1) {
      try {
        const baseline = await loadInstructions(this.rt.vfs, { cwd: this.cwd(), workspaceRoot: this.workspaceRoot() })
        this.projectRoot = baseline.projectRoot
        const sig = instructionSignature(baseline)
        const retained = this._retainedSource('instructions')
        if (!retained ? (baseline.files.length || this._everSent('instructions')) : retained.sig !== sig) {
          const text = renderInstructions(baseline, this._everSent('instructions'))
          if (text) add(text, 'instructions', { sig })
        }
        this.instrSig = sig
      } catch (e) { /* unreadable workspace */ }
    }
    // skill catalog
    const skills = this._skillsCache || []
    if (names.indexOf('skill') >= 0) {
      const sig = skillCatalogSignature(skills)
      const retained = this._retainedSource('skills')
      if (sig && (!retained || retained.sig !== sig)) add(renderSkillCatalog(skills, this._everSent('skills')), 'skills', { sig })
    }
    // plan mode / approval policy notices
    for (const n of this.pendingNotices.splice(0)) add(n, 'notice')
    // time context (at most every 10 minutes)
    if (preset.runtimeContext !== false) {
      const now = Date.now()
      if (this.lastTimeContext === undefined || now - this.lastTimeContext >= TIME_REFRESH_MS) {
        add(renderTimeContext({ turn, step, now, previous: this.lastVisibleAt }), 'time-context')
        this.lastTimeContext = now
      }
    }
  }

  /** The newest surface user/message of a context kind, or null when none is retained. */
  _retainedSource(kind) {
    const surface = this.session.surface()
    for (let i = surface.length - 1; i >= 0; i--) {
      const ev = surface[i]
      if (ev.type === 'user/message' && ev.data.source && ev.data.source.kind === kind) return { sig: ev.data.source.sig, seq: ev.seq }
    }
    return null
  }

  _everSent(kind) {
    for (const ev of this.session.events) if (ev.type === 'user/message' && ev.data.source && ev.data.source.kind === kind) return true
    return false
  }

  async _instructionUpdates() {
    const dirs = Object.keys(this.touchedDirs)
    this.touchedDirs = {}
    const root = this.projectRoot || this.workspaceRoot()
    for (const d of dirs) {
      if (this._instrDirsSeen && this._instrDirsSeen[d]) continue
      ;(this._instrDirsSeen || (this._instrDirsSeen = {}))[d] = true
      if (!isWithin(root, d) || d === this.cwd() || isWithin(d, this.cwd())) continue
      const text = await additionalInstructions(this.rt.vfs, d).catch(() => '')
      if (text) this.inbox.nextStep.push({ id: shortId(8), content: [{ type: 'text', text }], source: { kind: 'instructions-update' } })
    }
  }

  _repeatGuard(calls) {
    for (const c of calls) {
      const key = c.name + ' ' + stableStringify(c.input || c.arguments || {})
      if (this.repeat.key === key) this.repeat.count++
      else { this.repeat.key = key; this.repeat.count = 1 }
      const n = this.repeat.count
      if (REPEAT_THRESHOLDS.indexOf(n) >= 0) {
        const text = n === REPEAT_THRESHOLDS[0] ? GENTLE_REPEAT : detailedRepeat(c.name, n, clip(stableStringify(c.input || {}), 500))
        this.inbox.nextStep.push({ id: shortId(8), content: [{ type: 'text', text }], source: { kind: 'repeat-tool-reminder' } })
      }
    }
  }

  _execContext(route, tools, byName, turn, signal, turnSource) {
    const perm = this.permission()
    const agent = this
    return {
      agent, session: this.session, sessionId: this.session.id, turn, turnSource, route,
      cwd: this.cwd(), vfs: this.rt.vfs, net: this.rt.net, llm: this.rt.llm, images: this.rt.platform.images,
      settings: () => this.rt.settings.get(),
      sandbox: { mode: perm.sandbox, approvalPolicy: perm.approval, workspaceRoot: this.workspaceRoot(), writableRoots: ['/tmp'] },
      signal,
      requestApproval: req => agent.requestApproval(req, signal),
      askUser: qs => agent.askUser(qs, signal),
      askPlanReview: plan => agent.askPlanReview(plan, signal),
      resolveTool: name => byName[name],
      toolNames: () => tools.map(t => t.name).filter(n => n !== 'run_code' && n !== 'exit_plan_mode'),
      latestUserText: () => agent.lastHumanText || '',
      noteRead: (p) => { agent.touchedDirs[dirname(p)] = true },
      noteWrite: (p) => { agent.touchedDirs[dirname(p)] = true; agent.rt.noteFileChanged(agent, p) },
      progress: (display) => { if (agent.live) agent.live.toolProgress = display; agent.emitChange() },
    }
  }

  // ------------------------------------------------------------------ interactions

  _interact(kind, payload, signal) {
    const id = shortId(8)
    this.session.append(kind + '/asked', Object.assign({ id }, payload))
    const d = deferred()
    const entry = { kind, id, payload, resolve: d.resolve }
    this.pending = entry
    this.setStatus(kind === 'approval' ? 'approval' : kind === 'plan' ? 'plan-review' : 'question')
    this.rt.notify('needs-input', this, { kind, payload })
    let onAbort = null
    if (signal) {
      onAbort = () => { if (this.pending === entry) { this.pending = null; d.resolve(kind === 'approval' ? 'cancelled' : { cancelled: true }) } }
      signal.addEventListener('abort', onAbort)
    }
    return d.promise.then((answer) => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      if (this.pending === entry) this.pending = null
      this.session.append(kind + '/decided', { id, answer })
      if (this.running) this.setStatus('running')
      this.emitChange()
      return answer
    })
  }

  requestApproval(req, signal) {
    const perm = this.permission()
    if (perm.approval === 'never' || this.isSubagent) {
      this.session.append('approval/decided', { id: shortId(8), answer: 'rejected', auto: true, payload: req })
      return Promise.resolve('rejected')
    }
    return this._interact('approval', req, signal)
  }

  askUser(questions, signal) {
    return this._interact('question', { questions }, signal).then((answer) => {
      if (answer && answer.cancelled) throw abortError('question cancelled')
      return answer.answers || []
    })
  }

  askPlanReview(plan, signal) {
    return this._interact('plan', { plan }, signal).then((answer) => {
      if (answer && answer.cancelled) throw abortError('plan review cancelled')
      return answer
    })
  }

  /** UI answers the current pending interaction. */
  answer(kind, value) {
    const p = this.pending
    if (!p || p.kind !== kind) return false
    this.pending = null
    p.resolve(value)
    return true
  }

  // ------------------------------------------------------------------ compaction

  async compact({ route, tools, system, keep, reason, signal }) {
    const r = route || this.rt.llm.resolve(this.selection())
    const t = tools || this.visibleTools(r)
    const sys = system || this._systemPrompt(r, t)
    this.compacting = true
    this.emitChange()
    try {
      const keepTokens = keep !== undefined ? keep : budget(r.model, r.model.maxTokens, this.rt.settings.get().agent.compactThreshold).keep
      return await compact(this.session, {
        keep: keepTokens,
        llmCall: async (events, instruction) => {
          const messages = events.map(eventToMessage).concat([{ role: 'user', content: [{ type: 'text', text: instruction }] }])
          const res = await this.rt.llm.stream(r, {
            messages, tools: t.map(x => ({ name: x.name, description: x.description, parameters: x.parameters })),
            maxTokens: 65536, signal, purpose: 'compaction',
          })
          return { content: res.content, usage: res.usage, provider: r.provider.id, model: r.model.id }
        },
        onPhase: () => this.emitChange(),
      }).then((res) => { if (reason) this.session.append('compaction/reason', { reason }); return res })
    } finally {
      this.compacting = false
      this.emitChange()
    }
  }

  // ------------------------------------------------------------------ titles

  _maybeTitle(route) {
    if (this.titleRequested || this.isSubagent || this.meta.titleSource || this.meta.forkOf) return
    this.titleRequested = true
    const human = []
    for (const ev of this.session.events) {
      if (ev.type === 'user/message' && (!ev.data.source || ev.data.source.kind === 'human')) {
        const t = textOfBlocks(ev.data.content)
        if (t) human.push(clip(t, 2000))
      }
      if (human.length >= 3) break
    }
    if (!human.length) return
    const words = collapseWhitespace(human[0]).split(' ').slice(0, 5).join(' ')
    this.rt.sessions.updateMeta(this.session.id, { title: truncateUtf8(words, 40) || 'Untitled', titleSource: 'fallback' })
    const efforts = route.model.efforts || []
    this.rt.llm.stream(route, {
      system: titleSystemPrompt(),
      messages: [{ role: 'user', content: [{ type: 'text', text: titleFrame(human) }] }],
      effort: efforts.length ? efforts[0] : undefined,
      maxTokens: 4096,
      purpose: 'session-title',
    }).then((res) => {
      const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('')
      const line = (text.split(/\r?\n/).map(s => s.trim()).find(Boolean) || '').replace(/^(\*{1,3})(.+)\1$/, '$2').replace(/^["'“”「」]+|["'“”「」]+$/g, '')
      if (line && this.meta.titleSource !== 'user') {
        const title = truncateUtf8(line, 80)
        this.rt.sessions.updateMeta(this.session.id, { title, titleSource: 'llm' })
        this.session.append('session/title', { title, source: 'llm' })
      }
    }).catch(() => {})
  }

  // ------------------------------------------------------------------ subagent settlement

  _settleToParent() {
    const last = this.session.last('turn/end')
    if (!last || this._settledTurn === last.data.turn) return
    this._settledTurn = last.data.turn
    const reason = last.data.reason
    const blocks = [{ type: 'text', text: settlementSummary(this.name, reason, true) }]
    const finalMsg = this.session.last('assistant/message')
    const closing = finalMsg ? textOfBlocks(finalMsg.data.content).trim() : ''
    if (this.lastSentToParent) blocks.push({ type: 'text', text: 'It sent you a message just before finishing, so its closing message is omitted.' })
    else if (!closing) blocks.push({ type: 'text', text: 'It left no closing message.' })
    else blocks.push({ type: 'text', text: 'Its closing message:' }, { type: 'text', text: closing })
    this.lastSentToParent = false
    const p = this.parent
    if (this.parent.children[this.shortName]) this.parent.children[this.shortName].lastReason = reason
    p.session.append('subagent/finished', { name: this.name, sessionId: this.session.id, reason })
    p.prompt({ content: blocks, source: { kind: 'subagent', from: this.name, reason } }, p.running ? 'steer' : 'queue')
  }

  /** Sum of usage across the session (for the stats pills). */
  usageTotals() {
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0 }
    for (const ev of this.session.events) {
      if (ev.type !== 'assistant/message' || !ev.data.usage) continue
      const u = ev.data.usage
      t.input += u.input || 0; t.output += u.output || 0; t.cacheRead += u.cacheRead || 0; t.cacheWrite += u.cacheWrite || 0; t.reasoning += u.reasoning || 0
      t.requests++
    }
    return t
  }

  contextUsage() {
    try {
      const route = this.rt.llm.resolve(this.selection())
      const used = measure(this.session.surface())
      return { used, window: route.model.contextWindow, ratio: Math.min(1, used / route.model.contextWindow) }
    } catch (e) { return { used: 0, window: 0, ratio: 0 } }
  }
}

export { utf8Length }
