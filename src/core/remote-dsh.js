// Desktop dsh, driven from the phone. A client for the gateway's ACP bridge
// (gateway/dsh-bridge.mjs): the agent runs on the computer under DeepSeek
// Harness (`dsh --profile acp`) with its own tools; the phone sends prompts,
// shows what happens and answers permission requests.
//
// dsh keeps its sessions, but resuming one does not replay its history, so the
// phone keeps its own transcript of every remote session in /app/remote/.
// Items: {kind:'user'|'thought'|'message'|'tool'|'permission'|'end', …}.
import { Emitter, safeJsonParse, makeError, debounce, sleep, clip } from './util.js'

const FILE = '/app/remote/sessions.json'
const MAX_ITEMS = 400

function textOf(content) {
  if (!content) return ''
  if (content.type === 'text') return content.text || ''
  if (content.type === 'resource_link') return '[' + (content.name || content.uri) + '](' + content.uri + ')'
  if (content.type === 'resource') return (content.resource && content.resource.text) || ''
  return ''
}

export class DshRemote extends Emitter {
  /** http: platform http client; gateway: () => {url, code} | null; vfs: app storage. */
  constructor({ http, gateway, vfs }) {
    super()
    this.http = http
    this.gateway = gateway
    this.vfs = vfs
    this.sessions = {}
    this.calls = {} // prompt callId → sessionId
    this.boot = ''
    this.after = 0
    this.epoch = ''
    this.state = 'idle' // idle | connecting | connected | error
    this.error = null
    this.polling = false
    this.info = null
    this._save = debounce(() => { this.vfs.writeJson(FILE, this.serialize()).catch(() => {}) }, 600)
  }

  async init() {
    const d = await this.vfs.readJson(FILE, null)
    if (!d || typeof d !== 'object') return
    this.sessions = d.sessions || {}
    this.calls = d.calls || {}
    this.boot = d.boot || ''
    this.after = d.after || 0
    for (const id in this.sessions) if (this.sessions[id].pending === undefined) this.sessions[id].pending = null
  }

  serialize() {
    const sessions = {}
    for (const id in this.sessions) {
      const s = this.sessions[id]
      sessions[id] = Object.assign({}, s, { items: s.items.slice(-MAX_ITEMS) })
    }
    return { boot: this.boot, after: this.after, calls: this.calls, sessions }
  }

  configured() {
    const g = this.gateway()
    return !!(g && g.url)
  }

  // ------------------------------------------------------------------ transport

  async req(method, path, body, timeoutMs) {
    const g = this.gateway()
    if (!g || !g.url) throw makeError('NO_GATEWAY', 'no gateway is configured')
    const headers = { 'x-dsh-gateway-code': g.code || '' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await this.http.request({ method, url: g.url.replace(/\/+$/, '') + '/gateway/dsh/' + path, headers, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs: timeoutMs || 30000 })
    const json = safeJsonParse(res.text, null)
    if (res.status === 404 && (!json || /not found/.test(json.error || ''))) throw makeError('DSH_UNAVAILABLE', 'the gateway does not run desktop dsh (start it with --dsh)')
    if (res.status === 401) throw makeError('GATEWAY_CODE', 'gateway access code required')
    if (res.status >= 400) throw makeError('DSH_ERROR', (json && json.error) || 'HTTP ' + res.status)
    return json
  }

  async refreshInfo() {
    this.info = await this.req('GET', 'info')
    return this.info
  }

  ls(path) { return this.req('GET', 'ls?path=' + encodeURIComponent(path || '')) }

  call(method, params) { return this.req('POST', 'call', { method, params }, 320000).then(r => r.result) }

  // ------------------------------------------------------------------ event stream

  start() {
    if (this.polling) return
    this.polling = true
    this.setState('connecting')
    let first = true
    const loop = async () => {
      while (this.polling) {
        try {
          // the first call answers at once, so the page knows it is connected
          const r = await this.req('GET', 'events?after=' + this.after + '&wait=' + (first ? 0 : 25000), undefined, 40000)
          first = false
          if (r.boot !== this.boot || r.last < this.after) {
            // a restarted gateway starts counting again
            this.boot = r.boot
            if (r.last < this.after) { this.after = 0; continue }
          }
          if (this.epoch && r.epoch !== this.epoch) this.endAll('dsh restarted')
          this.epoch = r.epoch || ''
          for (const e of r.events) this.apply(e)
          this.after = r.last
          this.setState('connected')
          if (r.events.length) this._save()
        } catch (e) {
          this.setState('error', e)
          await sleep(4000)
        }
      }
    }
    loop()
  }

  stop() { this.polling = false; this.setState('idle') }

  setState(state, err) {
    const msg = err ? err.message || String(err) : null
    if (state === this.state && msg === this.error) return
    this.state = state
    this.error = msg
    this.emit('change', null)
  }

  // ------------------------------------------------------------------ sessions

  list() {
    return Object.keys(this.sessions).map(k => this.sessions[k]).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id) { return this.sessions[id] }

  running() { return this.list().filter(s => s.running) }

  touch(s) {
    s.updatedAt = Date.now()
    if (s.items.length > MAX_ITEMS * 1.5) s.items = s.items.slice(-MAX_ITEMS)
    this._save()
    this.emit('change', s)
  }

  ensureSession(id, cwd) {
    let s = this.sessions[id]
    if (!s) {
      s = { id, cwd: cwd || '', title: '', createdAt: Date.now(), updatedAt: Date.now(), items: [], running: false, usage: null, config: null, epoch: '', pending: null }
      this.sessions[id] = s
    }
    return s
  }

  async newSession(cwd) {
    const r = await this.call('session/new', { cwd, mcpServers: [] })
    const info = await this.refreshInfo()
    const s = this.ensureSession(r.sessionId, cwd)
    s.config = r.configOptions || null
    s.epoch = info.epoch
    this.touch(s)
    this.start()
    return s
  }

  /** Sessions dsh has stored on the computer (this folder or all), newest first. */
  async remoteList(cwd) {
    const r = await this.call('session/list', cwd ? { cwd } : {})
    return (r && r.sessions) || []
  }

  /** Make sure the session is live in the running dsh before prompting it. */
  async attach(s) {
    const info = await this.refreshInfo()
    if (info.running && s.epoch === info.epoch) return
    const r = await this.call('session/resume', { sessionId: s.id, cwd: s.cwd, mcpServers: [] })
    if (r && r.configOptions) s.config = r.configOptions
    s.epoch = (await this.refreshInfo()).epoch
  }

  async prompt(id, text) {
    const s = this.sessions[id]
    if (!s) throw makeError('UNKNOWN_SESSION', 'unknown session')
    if (s.running) throw makeError('BUSY', 'this session is still working')
    s.items.push({ kind: 'user', text, at: Date.now() })
    if (!s.title) s.title = clip(text.replace(/\s+/g, ' '), 40)
    s.running = true
    this.touch(s)
    this.start()
    try {
      await this.attach(s)
      const r = await this.req('POST', 'call', { method: 'session/prompt', params: { sessionId: id, prompt: [{ type: 'text', text }] }, async: true })
      this.calls[r.callId] = id
      this._save()
    } catch (e) {
      s.running = false
      s.items.push({ kind: 'end', error: e.message, at: Date.now() })
      this.touch(s)
      throw e
    }
  }

  async cancel(id) {
    await this.req('POST', 'notify', { method: 'session/cancel', params: { sessionId: id } })
  }

  async answer(id, requestId, optionId) {
    const s = this.sessions[id]
    const result = optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } }
    await this.req('POST', 'respond', { id: requestId, result })
    if (s) {
      for (const it of s.items) if (it.kind === 'permission' && it.requestId === requestId) it.decided = optionId || 'cancelled'
      if (s.pending === requestId) s.pending = null
      this.touch(s)
    }
  }

  async setConfig(id, configId, value) {
    const s = this.sessions[id]
    await this.attach(s)
    const r = await this.call('session/set_config_option', { sessionId: id, configId, value })
    if (r && r.configOptions) s.config = r.configOptions
    this.touch(s)
  }

  async remove(id) {
    const s = this.sessions[id]
    if (!s) return
    if (s.epoch && s.epoch === this.epoch) { try { await this.call('session/close', { sessionId: id }) } catch (e) { /* already gone */ } }
    delete this.sessions[id]
    this._save()
    this.emit('change', null)
  }

  endAll(why) {
    for (const s of this.running()) {
      s.running = false
      s.pending = null
      s.items.push({ kind: 'end', error: why, at: Date.now() })
      this.touch(s)
    }
  }

  // ------------------------------------------------------------------ applying agent events

  // The event stream is shared by every client of the gateway: follow only the
  // sessions this phone opened, never create one from someone else's updates.
  apply(e) {
    if (e.type === 'notification' && e.method === 'session/update' && e.params) {
      const s = this.sessions[e.params.sessionId]
      if (!s) return
      this.applyUpdate(s, e.params.update || {})
      this.touch(s)
    } else if (e.type === 'request' && e.method === 'session/request_permission') {
      const s = e.params && this.sessions[e.params.sessionId]
      if (!s) return
      const toolCallId = e.params.toolCall && e.params.toolCall.toolCallId
      s.items.push({ kind: 'permission', requestId: e.id, toolCallId, options: e.params.options || [], decided: null, at: Date.now() })
      s.pending = e.id
      this.touch(s)
      this.emit('needs-input', s)
    } else if (e.type === 'answered') {
      for (const id in this.sessions) {
        const s = this.sessions[id]
        if (s.pending === e.id) { s.pending = null; this.touch(s) }
      }
    } else if (e.type === 'result') {
      const id = this.calls[e.callId]
      if (!id) return
      delete this.calls[e.callId]
      const s = this.sessions[id]
      if (!s) return
      s.running = false
      s.pending = null
      s.items.push({ kind: 'end', stopReason: e.result && e.result.stopReason, error: e.error && e.error.message, at: Date.now() })
      this.touch(s)
      this.emit('done', s)
    } else if (e.type === 'exit') {
      this.endAll('dsh stopped: ' + e.reason)
    }
  }

  applyUpdate(s, u) {
    const items = s.items
    const find = (kind, key, val) => { for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === kind && items[i][key] === val) return items[i]; return null }
    switch (u.sessionUpdate) {
      case 'agent_thought_chunk':
      case 'agent_message_chunk': {
        const kind = u.sessionUpdate === 'agent_thought_chunk' ? 'thought' : 'message'
        const text = textOf(u.content)
        const image = u.content && u.content.type === 'image' ? { mime: u.content.mimeType, data: u.content.data } : null
        let it = u.messageId ? find(kind, 'messageId', u.messageId) : null
        if (!it || it !== items[items.length - 1]) {
          it = { kind, messageId: u.messageId || null, text: '', images: [], at: Date.now() }
          items.push(it)
        }
        if (text) it.text += (it.text ? '\n\n' : '') + text
        if (image) it.images.push(image)
        break
      }
      case 'user_message_chunk':
        items.push({ kind: 'user', text: textOf(u.content), at: Date.now() })
        break
      case 'tool_call': {
        let it = find('tool', 'toolCallId', u.toolCallId)
        if (!it) { it = { kind: 'tool', toolCallId: u.toolCallId, output: '', at: Date.now() }; items.push(it) }
        it.title = u.title || it.title || 'tool'
        it.status = u.status || it.status || 'in_progress'
        if (u.rawInput !== undefined) it.input = u.rawInput
        break
      }
      case 'tool_call_update': {
        let it = find('tool', 'toolCallId', u.toolCallId)
        if (!it) { it = { kind: 'tool', toolCallId: u.toolCallId, title: u.title || 'tool', output: '', at: Date.now() }; items.push(it) }
        if (u.status) it.status = u.status
        if (u.title) it.title = u.title
        if (u.rawInput !== undefined) it.input = u.rawInput
        if (u.content) it.output = u.content.map(c => (c.type === 'content' ? textOf(c.content) : c.type === 'diff' ? '--- ' + c.path + '\n' + (c.newText || '') : '')).filter(Boolean).join('\n')
        break
      }
      case 'usage_update':
        s.usage = { used: u.used, size: u.size }
        break
      case 'config_option_update':
        if (u.configOptions) s.config = u.configOptions
        break
      default:
        break
    }
  }
}

/**
 * Whether a session waits for the user's answer. Agent request ids are JSON-RPC
 * ids and dsh numbers them from 0, so this is never a truthiness test.
 */
export function hasPending(s) {
  return !!s && s.pending !== null && s.pending !== undefined
}

/** One-line summary of a tool call's input, e.g. the shell command. */
export function toolSummary(it) {
  const i = it.input
  if (!i) return ''
  if (typeof i === 'string') return i
  return i.command || i.cmd || i.file_path || i.path || i.url || i.query || i.pattern || JSON.stringify(i)
}
