// Session log: an append-only event list persisted as JSONL, plus the derived
// model-visible message view (upstream packages/core/session).
//
// Event envelope: {seq, type, time, data, replace?: {startSeq, endSeq}}
// Model-visible types: system/message, user/message, assistant/message, tool/result.
// Everything else is log-only (turn/step lifecycle, compaction, todo, plan,
// approvals, goal, model selection, titles, retries, subagents, feedback…).
import { Emitter, uuid, debounce, clone } from './util.js'

export const FORMAT_VERSION = 4

const VISIBLE = { 'system/message': 1, 'user/message': 1, 'assistant/message': 1, 'tool/result': 1 }

export class Session extends Emitter {
  constructor(meta, events) {
    super()
    this.id = meta.id
    this.meta = meta
    this.events = events || []
    this.seq = this.events.length ? this.events[this.events.length - 1].seq : 0
    this._pending = []
  }

  append(type, data, extra) {
    const ev = { seq: ++this.seq, type, time: Date.now(), data: data === undefined ? {} : data }
    if (extra && extra.replace) ev.replace = extra.replace
    this.events.push(ev)
    this._pending.push(ev)
    this.emit('event', ev)
    return ev
  }

  /** Events not yet flushed to storage. */
  takePending() {
    const p = this._pending
    this._pending = []
    return p
  }

  last(type) {
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i].type === type) return this.events[i]
    return undefined
  }

  bySeq(seq) {
    // events are sorted by seq; binary search
    let lo = 0, hi = this.events.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const s = this.events[mid].seq
      if (s === seq) return this.events[mid]
      if (s < seq) lo = mid + 1; else hi = mid - 1
    }
    return undefined
  }

  /** Surface: model-visible events in order, after compaction replacements. */
  surface() {
    const out = []
    for (const ev of this.events) {
      if (!VISIBLE[ev.type]) continue
      if (ev.replace) {
        let at = -1
        for (let i = out.length - 1; i >= 0; i--) {
          const s = out[i].seq
          if (s >= ev.replace.startSeq && s <= ev.replace.endSeq) { out.splice(i, 1); at = i }
        }
        if (at < 0) at = out.length
        out.splice(at, 0, ev)
      } else out.push(ev)
    }
    return out
  }

  /** Internal LLM messages (role system|user|assistant|tool) derived from the surface. */
  deriveMessages() {
    return this.surface().map(eventToMessage)
  }

  turnCount() {
    let n = 0
    for (const ev of this.events) if (ev.type === 'turn/start') n = ev.data.turn
    return n
  }
}

export function eventToMessage(ev) {
  const d = ev.data
  switch (ev.type) {
    case 'system/message': return { role: 'system', content: [{ type: 'text', text: d.text }], seq: ev.seq }
    case 'user/message': return { role: 'user', content: d.content, source: d.source, seq: ev.seq }
    case 'assistant/message': return { role: 'assistant', content: d.content, model: d.model, provider: d.provider, interrupted: d.interrupted, seq: ev.seq }
    case 'tool/result': return { role: 'tool', callId: d.callId, name: d.name, content: d.content, isError: d.isError, seq: ev.seq }
    default: return null
  }
}

export function textOfBlocks(blocks) {
  return (blocks || []).filter(b => b && b.type === 'text').map(b => b.text).join('\n')
}

// ---------------------------------------------------------------- store

/**
 * Persists sessions under /app/sessions:
 *   index.json            [{id, title, workspaceId, cwd, createdAt, updatedAt, …}]
 *   <id>/events.jsonl     header line + one event per line
 */
export class SessionStore extends Emitter {
  constructor(vfs, root = '/app/sessions') {
    super()
    this.vfs = vfs
    this.root = root
    this.index = []
    this.loaded = {} // id -> Session
    this._saveIndex = debounce(() => this._writeIndex(), 400)
    this._flushTimers = {}
  }

  async init() {
    await this.vfs.mkdirp(this.root)
    this.index = await this.vfs.readJson(this.root + '/index.json', [])
    if (!Array.isArray(this.index)) this.index = []
  }

  list() { return this.index.slice() }

  getMeta(id) { return this.index.find(m => m.id === id) }

  updateMeta(id, patch, { touch = false } = {}) {
    const m = this.getMeta(id)
    if (!m) return
    Object.assign(m, patch)
    if (touch) m.updatedAt = Date.now()
    if (this.loaded[id]) this.loaded[id].meta = m
    this._saveIndex()
    this.emit('index', m)
  }

  async create(opts) {
    const now = Date.now()
    const meta = Object.assign({
      id: 'session-' + uuid(),
      title: '',
      titleSource: null,
      workspaceId: null,
      cwd: '/',
      createdAt: now,
      updatedAt: now,
      pinned: false,
      archived: false,
      unread: false,
      status: 'idle',
      preset: 'standard',
      parentId: null,
      agentName: null,
      isSubagent: false,
      blank: true,
      formatVersion: FORMAT_VERSION,
    }, opts || {})
    this.index.unshift(meta)
    const session = new Session(meta, [])
    this.loaded[meta.id] = session
    this._attach(session)
    await this.vfs.mkdirp(`${this.root}/${meta.id}`)
    await this.vfs.writeText(`${this.root}/${meta.id}/events.jsonl`, JSON.stringify({ header: true, formatVersion: FORMAT_VERSION, id: meta.id, cwd: meta.cwd, createdAt: meta.createdAt, parentId: meta.parentId, isSeeded: !!opts && !!opts.forkOf }) + '\n')
    this._saveIndex()
    this.emit('index', meta)
    return session
  }

  async open(id) {
    if (this.loaded[id]) return this.loaded[id]
    const meta = this.getMeta(id)
    if (!meta) throw new Error('unknown session ' + id)
    let text = ''
    try { text = await this.vfs.readText(`${this.root}/${id}/events.jsonl`) } catch (e) { text = '' }
    const events = []
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const ev = JSON.parse(line)
        if (ev && !ev.header && ev.type) events.push(ev)
      } catch (e) { /* torn tail line after a crash */ }
    }
    if (this.loaded[id]) return this.loaded[id]
    const session = new Session(meta, events)
    this.loaded[id] = session
    this._attach(session)
    return session
  }

  _attach(session) {
    session.on('event', () => this._scheduleFlush(session))
  }

  _scheduleFlush(session) {
    if (this._flushTimers[session.id]) return
    this._flushTimers[session.id] = setTimeout(() => {
      delete this._flushTimers[session.id]
      this.flush(session)
    }, 250)
  }

  async flush(session) {
    if (session.removed) return
    const pending = session.takePending()
    if (!pending.length) return
    const text = pending.map(ev => JSON.stringify(ev)).join('\n') + '\n'
    try {
      await this.vfs.appendText(`${this.root}/${session.id}/events.jsonl`, text)
    } catch (e) {
      session._pending = pending.concat(session._pending) // retry on next flush
      throw e
    }
  }

  async flushAll() {
    for (const id in this.loaded) {
      if (this._flushTimers[id]) { clearTimeout(this._flushTimers[id]); delete this._flushTimers[id] }
      try { await this.flush(this.loaded[id]) } catch (e) { /* keep pending */ }
    }
    this._saveIndex.flush()
  }

  async _writeIndex() {
    try { await this.vfs.writeJson(this.root + '/index.json', this.index) } catch (e) { /* retried on next change */ }
  }

  /** Delete a session and its event log (used by the self-test to clean up). */
  async remove(id) {
    if (this._flushTimers[id]) { clearTimeout(this._flushTimers[id]); delete this._flushTimers[id] }
    if (this.loaded[id]) { this.loaded[id].removed = true; delete this.loaded[id] }
    this.index = this.index.filter(m => m.id !== id)
    this._saveIndex()
    this.emit('index', null)
    await this.vfs.remove(`${this.root}/${id}`).catch(() => {})
  }

  unload(id) {
    const s = this.loaded[id]
    if (!s) return
    this.flush(s).catch(() => {})
    delete this.loaded[id]
  }

  /**
   * Fork: copy the prefix up to the last completed turn (or atSeq) into a new
   * session, close any open turn, and mark the seed boundary.
   */
  async fork(sourceId, opts = {}) {
    const src = await this.open(sourceId)
    let cut = src.events.length
    if (opts.atSeq) cut = src.events.findIndex(e => e.seq > opts.atSeq)
    else {
      for (let i = src.events.length - 1; i >= 0; i--) if (src.events[i].type === 'turn/end') { cut = i + 1; break }
    }
    if (cut < 0) cut = src.events.length
    const prefix = clone(src.events.slice(0, cut))
    const baseTitle = (src.meta.title || 'Untitled').replace(/ \(\d+\)$/, '')
    let n = 1
    const titles = this.index.map(m => m.title)
    while (titles.indexOf(`${baseTitle} (${n})`) >= 0) n++
    const child = await this.create({
      workspaceId: src.meta.workspaceId, cwd: src.meta.cwd, preset: src.meta.preset,
      title: `${baseTitle} (${n})`, titleSource: 'fork', forkOf: sourceId, blank: false,
      model: src.meta.model, permission: src.meta.permission,
    })
    for (const ev of prefix) child.append(ev.type, ev.data, ev.replace ? { replace: ev.replace } : undefined)
    closeOpenTurn(child, 'forked')
    child.append('session/end-seed', { inherited: true, source: sourceId })
    this.updateMeta(child.id, { blank: false }, { touch: true })
    return child
  }

  async exportJsonl(id) {
    const s = await this.open(id)
    await this.flush(s)
    return this.vfs.readText(`${this.root}/${id}/events.jsonl`)
  }
}

// ---------------------------------------------------------------- repair

const CLOSER_TEXT = {
  interrupted: {
    started: 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
    notStarted: 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.',
  },
  forked: {
    started: 'The history inherited by this branch records this tool call starting but does not include its result. The parent session may have completed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
    notStarted: 'The history inherited by this branch has no record of this tool call starting. The parent session may have executed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
  },
}

/** Close a turn left open by a crash/suspend (or at a fork point) with synthetic results. */
export function closeOpenTurn(session, cause) {
  let openTurn = null
  let stepOpen = false
  const calls = {}
  const started = {}
  const answered = {}
  for (const ev of session.events) {
    if (ev.type === 'turn/start') {
      openTurn = ev.data.turn
      stepOpen = false
    } else if (ev.type === 'turn/end') {
      openTurn = null
    } else if (ev.type === 'step/start') {
      stepOpen = true
    } else if (ev.type === 'step/end') {
      stepOpen = false
    } else if (ev.type === 'assistant/message') {
      for (const b of ev.data.content || []) {
        if (b.type === 'tool-call') calls[b.id] = b.name
      }
    } else if (ev.type === 'tool/call') {
      started[ev.data.id] = true
    } else if (ev.type === 'tool/result') {
      answered[ev.data.callId] = true
    }
  }
  if (openTurn === null) return false
  const texts = CLOSER_TEXT[cause] || CLOSER_TEXT.interrupted
  for (const id in calls) {
    if (answered[id]) continue
    session.append('tool/result', {
      callId: id, name: calls[id], isError: true, synthetic: true,
      code: started[id] ? 'TOOL_OUTCOME_UNKNOWN' : 'TOOL_NOT_STARTED',
      content: [{ type: 'text', text: 'Error: ' + (started[id] ? texts.started : texts.notStarted) }],
    })
  }
  if (stepOpen) session.append('step/end', { synthetic: true })
  session.append('turn/end', { turn: openTurn, reason: cause === 'forked' ? 'forked' : 'interrupted' })
  return true
}
