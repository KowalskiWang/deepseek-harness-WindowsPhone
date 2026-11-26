// On-device self-test for DSH Mobile.
//
// Runs on the phone itself and covers the platform layer (storage, credential
// vault, images, the sandbox worker, networking), the DeepSeek API (listing,
// balance, streaming, thinking, tool calls, abort) and the agent runtime end
// to end (tool chain, questions, plan mode, sandbox escalation, web
// search/fetch, subagents, workflow, compaction, schedules, MCP, the gateway
// relay), plus a UI smoke pass over every page.
//
// Each check is posted to the DSH gateway as it finishes (POST
// /gateway/selftest, when a report URL is given). The whole run is saved to
// /app/selftest-result.json, which is LocalState\app on Windows Phone, where
// scripts/device-test.mjs collects it through Windows Device Portal.
import { Emitter, shortId, errorMessage, sleep, clone, clip, utf8Encode, base64ToBytes, createAbort, isAbortError } from '../core/util.js'
import { SessionStore, textOfBlocks } from '../core/session.js'
import { SANDBOX_CASES, SANDBOX_TOOLS, checkSandboxCase } from './sandbox-cases.js'
import { hasPending } from '../core/remote-dsh.js'
import { navigate, back, current } from '../ui/store.js'

export const REQUEST_PATH = '/app/selftest-request.json'
export const RESULT_PATH = '/app/selftest-result.json'

const BUILD = typeof __DSH_BUILD__ !== 'undefined' ? __DSH_BUILD__ : 'dev'
const VERSION = typeof __DSH_VERSION__ !== 'undefined' ? __DSH_VERSION__ : 'dev'

/** Suites in run order. model: needs a usable model; report: needs the gateway (report URL). */
export const SUITES = [
  { id: 'env' }, { id: 'phone' }, { id: 'storage' }, { id: 'images' }, { id: 'sandbox' }, { id: 'network' },
  { id: 'llm', model: true }, { id: 'agent', model: true }, { id: 'interaction', model: true },
  { id: 'web', model: true }, { id: 'subagent', model: true }, { id: 'workflow', model: true },
  { id: 'compaction', model: true }, { id: 'schedule', model: true }, { id: 'mcp', report: true, model: true },
  { id: 'gateway', report: true, model: true }, { id: 'remote', report: true }, { id: 'ui' },
]
export const OFFLINE_SUITES = ['env', 'phone', 'storage', 'images', 'sandbox', 'ui']

let active = null
/** The run in progress or the last one, so the page can come back to it. */
export function activeSelfTest() { return active }

export function startSelfTest(rt, opts) {
  if (active && active.state === 'running') return active
  active = new SelfTest(rt, opts)
  active.promise = active.run().catch(() => null)
  return active
}

/**
 * A pending self-test request, from one of:
 *  • ?selftest=all|offline|<suites> on the web build (optional report=, route=, model=, id=);
 *  • /app/selftest-request.json in the app, pushed over Device Portal (read once, then deleted);
 *  • a pointer file name /app/selftest-pull_<host>_<port>_<id>_<pad>: on Windows 10
 *    Mobile, files Device Portal writes into the app's folder are not readable by
 *    the app, but their names are. The app fetches the request from the gateway;
 *    its API key arrives XOR-ed with the one-time pad (hex) carried in the name.
 * diag (optional) collects what was seen, for the boot log.
 */
export async function readSelfTestRequest(rt, platform, diag) {
  diag = diag || {}
  if (platform.kind === 'web') {
    const search = String(location.search || '')
    if (!/[?&]selftest=/.test(search)) return null
    const q = {}
    search.replace(/^\?/, '').split('&').forEach((kv) => {
      const i = kv.indexOf('=')
      if (i > 0) q[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '))
    })
    try { history.replaceState(history.state, '', location.pathname) } catch (e) { /* old browser */ }
    const which = q.selftest
    return {
      id: q.id, model: q.model, route: q.route,
      suites: which === 'offline' ? OFFLINE_SUITES : which && which !== 'all' && which !== '1' ? which.split(',') : null,
      report: q.report || (platform.servedByGateway ? platform.origin : ''),
    }
  }
  let names = []
  try { names = (await rt.vfs.list('/app')).map(e => e.name) } catch (e) { diag.listError = errText(e) }
  diag.seen = names.filter(n => /^selftest-/.test(n)).map(n => n.replace(/^(selftest-pull_.*_)[0-9a-f]+$/, '$1…'))
  if (names.indexOf('selftest-request.json') >= 0) {
    try {
      const req = JSON.parse(await rt.vfs.readText(REQUEST_PATH))
      await rt.vfs.remove(REQUEST_PATH).catch((e) => { diag.removeError = errText(e) })
      diag.source = 'file'
      return req && typeof req === 'object' ? req : null
    } catch (e) {
      diag.readError = errText(e)
      await rt.vfs.remove(REQUEST_PATH).catch(() => {})
    }
  }
  for (const n of names) {
    const m = /^selftest-pull_([A-Za-z0-9.-]+)_(\d+)_([A-Za-z0-9-]+)_([0-9a-f]*)$/.exec(n)
    if (!m) continue
    // (Windows 10 Mobile lets the app list this file but not open or delete it; the
    //  gateway serves the request only once, and device-test removes the file.)
    // The error text would contain the name, and with it the pad: keep it out of the log.
    await rt.vfs.remove('/app/' + n).catch((e) => { diag.removeError = 'cannot remove the pointer file (' + (e && e.code || 'error') + ')' })
    try {
      const res = await platform.http.request({ method: 'GET', url: 'http://' + m[1] + ':' + m[2] + '/gateway/selftest-request/' + m[3], headers: {}, timeoutMs: 15000 })
      if (res.status !== 200) { diag.pullError = 'HTTP ' + res.status; continue }
      const req = JSON.parse(res.text)
      if (req.apiKeyXor) { req.apiKey = xorHex(req.apiKeyXor, m[4]); delete req.apiKeyXor }
      diag.source = 'pull'
      return req
    } catch (e) { diag.pullError = errText(e) }
  }
  return null
}

function xorHex(cipherHex, padHex) {
  let out = ''
  for (let i = 0; i + 1 < cipherHex.length; i += 2) out += String.fromCharCode(parseInt(cipherHex.substr(i, 2), 16) ^ parseInt(padHex.substr(i, 2), 16))
  return out
}

function errText(e) {
  if (!e) return 'unknown error'
  if (typeof e === 'string') return e
  return errorMessage(e) + (e.code ? ' [' + e.code + ']' : '')
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ': no result within ' + Math.round(ms / 1000) + ' s')), ms)
    promise.then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
  })
}

function fmtDetail(d) {
  if (d === undefined || d === null) return ''
  if (typeof d === 'string') return clip(d, 2000)
  try { return clip(JSON.stringify(d), 2000) } catch (e) { return clip(String(d), 2000) }
}

export function envInfo(rt) {
  const p = rt.platform
  const info = { build: BUILD, version: VERSION, kind: p.kind, hint: p.hint }
  try {
    info.ua = navigator.userAgent
    info.documentMode = document.documentMode
    info.screen = screen.width + 'x' + screen.height
    info.dpr = window.devicePixelRatio
    info.language = navigator.language || navigator.userLanguage
  } catch (e) { /* not a browser */ }
  info.tzOffsetMin = new Date().getTimezoneOffset()
  if (p.deviceInfo) { try { Object.assign(info, p.deviceInfo()) } catch (e) { info.deviceInfo = errText(e) } }
  return info
}

function childAgents(agent) {
  const out = []
  for (const k in agent.children) {
    const c = agent.children[k].agent
    out.push(c)
    out.push(...childAgents(c))
  }
  return out
}

function turnInfo(agent, from) {
  const evs = agent.session.events.slice(from)
  const msgs = evs.filter(e => e.type === 'assistant/message')
  const last = msgs[msgs.length - 1]
  const tools = evs.filter(e => e.type === 'tool/result').map(e => ({ name: e.data.name, isError: !!e.data.isError, text: (e.data.content || []).map(b => b.text || '').join(' ') }))
  const ends = evs.filter(e => e.type === 'turn/end').map(e => e.data.reason + (e.data.error ? ': ' + e.data.error.message : ''))
  return { evs, text: last ? textOfBlocks(last.data.content) : '', tools, names: tools.map(t => t.name), ends }
}

/** Compact description of a turn for the report. */
function brief(r, extra) {
  const errors = r.tools.filter(t => t.isError).map(t => t.name + ': ' + clip(t.text, 160))
  return Object.assign({ tools: r.names, toolErrors: errors.length ? errors : undefined, reply: clip(r.text, 300), turns: r.ends }, extra || {})
}

function textOf(content) { return textOfBlocks(content) }

export class SelfTest extends Emitter {
  /**
   * opts: {id, suites, model, effort, report, route, gatewayCode, apiKey, keepKey, keepData}
   *   report: gateway base URL that receives progress (also used as the MCP test server)
   *   route:  network route for the run ('off' = direct, 'https' = through the gateway);
   *           omitted → the user's own settings
   */
  constructor(rt, opts) {
    super()
    this.rt = rt
    this.opts = { model: 'deepseek-flash', effort: 'low', keepKey: true }
    for (const k in opts || {}) if (opts[k] !== undefined && opts[k] !== null && opts[k] !== '') this.opts[k] = opts[k]
    this.id = String(this.opts.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'st-' + shortId(8)
    this.report = String(this.opts.report || '').replace(/\/+$/, '')
    this.checks = []
    this.current = null
    this.suite = ''
    this.state = 'idle'
    this.startedAt = 0
    this.finishedAt = 0
    this.env = null
    this.ws = null
    this.knownSessions = []
    this.taskIds = []
    this.interactions = []
    this.policy = this.defaultPolicy()
    this._posts = Promise.resolve()
  }

  defaultPolicy() {
    return {
      approval: 'allowed-once',
      plan: { decision: 'approve' },
      pick: q => (q.options && q.options[0] ? [q.options[0].label] : []),
    }
  }

  // ------------------------------------------------------------------ run

  async run() {
    if (this.state === 'running') return this.result()
    const rt = this.rt
    this.state = 'running'
    this.startedAt = Date.now()
    this.emit('change')
    const snapshot = clone(rt.settings.get())
    const hadKey = rt.settings.getCredential('deepseek')
    const wanted = this.opts.suites && this.opts.suites.length ? this.opts.suites : SUITES.map(s => s.id)
    // the whole run keeps the app alive and the screen on, even between agent work
    const p = rt.platform
    if (p.keepRunning) p.keepRunning(true, 'selftest')
    if (p.keepScreenOn) p.keepScreenOn(true)
    try {
      this.env = envInfo(rt)
      this.send('start', { env: this.env, suites: wanted })
      await this.setup()
      for (const s of SUITES) {
        if (wanted.indexOf(s.id) < 0) continue
        this.suite = s.id
        if (s.model && !rt.hasUsableModel()) { this.record(s.id, '(suite)', 'skip', 0, 'no API key is configured'); continue }
        if (s.report && !this.report) { this.record(s.id, '(suite)', 'skip', 0, 'no gateway address was given'); continue }
        try { await this['suite_' + s.id]() } catch (e) { this.record(s.id, '(suite crashed)', 'fail', 0, errText(e)) }
        await this.save()
      }
    } catch (e) {
      this.record('selftest', 'setup', 'fail', 0, errText(e))
    } finally {
      this.suite = 'selftest'
      try { await this.cleanup(snapshot, hadKey) } catch (e) { this.record('selftest', 'cleanup', 'fail', 0, errText(e)) }
      if (p.keepRunning) p.keepRunning(false, 'selftest')
      if (p.keepScreenOn) p.keepScreenOn(false)
      this.state = 'done'
      this.finishedAt = Date.now()
      this.current = null
      await this.save()
      this.send('done', { result: this.result() })
      await this._posts
      this.emit('change')
    }
    return this.result()
  }

  async setup() {
    const rt = this.rt
    const o = this.opts
    if (o.apiKey) await rt.settings.setCredential('deepseek', o.apiKey)
    const patch = { models: { defaultSelection: { provider: 'deepseek', model: o.model, effort: o.effort } } }
    const g = rt.settings.get().gateway
    if (o.route) patch.gateway = { url: this.report || g.url, code: o.gatewayCode || g.code, route: o.route }
    rt.settings.update(patch)
    await rt.probeGateway().catch(() => {})
    this.knownSessions = rt.sessions.list().map(m => m.id)
    this.ws = await rt.workspaces.addAppFolder('DSH-selftest-' + this.id.slice(-6))
    await rt.vfs.writeText(this.ws.path + '/notes.txt', 'alpha\nbeta\ngamma\n')
    await rt.vfs.writeText(this.ws.path + '/AGENTS.md', 'Always answer in English. Keep replies under 80 words.\n')
  }

  newSessionIds() {
    return this.rt.sessions.list().map(m => m.id).filter(id => this.knownSessions.indexOf(id) < 0)
  }

  async cleanup(snapshot, hadKey) {
    const rt = this.rt
    for (const id of this.newSessionIds()) {
      const a = rt.getAgent(id)
      if (a && a.running) a.cancel('selftest')
    }
    for (const tid of this.taskIds) { try { rt.schedule.edit(tid, { action: 'delete' }) } catch (e) { /* gone */ } }
    if (!this.opts.keepData) {
      for (const id of this.newSessionIds()) {
        delete rt.agents[id]
        await rt.sessions.remove(id).catch(() => {})
      }
      if (this.ws) {
        await rt.workspaces.remove(this.ws.id)
        await rt.vfs.remove(this.ws.path).catch(() => {})
      }
    }
    for (const k in snapshot) rt.settings.set(k, snapshot[k])
    if (this.opts.apiKey && !this.opts.keepKey) {
      if (hadKey) await rt.settings.setCredential('deepseek', hadKey)
      else await rt.settings.removeCredential('deepseek')
    }
    await rt.mcp.refresh(true).catch(() => {})
    await rt.probeGateway().catch(() => {})
    await rt.flush()
  }

  // ------------------------------------------------------------------ bookkeeping

  async check(name, fn, timeoutMs) {
    const suite = this.suite
    this.current = { suite, name, startedAt: Date.now() }
    this.emit('change')
    const t0 = Date.now()
    let status = 'pass'
    let detail
    try {
      const out = await withTimeout(Promise.resolve().then(fn), timeoutMs || 120000, name)
      if (out && out.skip) { status = 'skip'; detail = out.skip } else detail = out
    } catch (e) {
      status = 'fail'
      detail = errText(e)
    }
    return this.record(suite, name, status, Date.now() - t0, detail)
  }

  record(suite, name, status, ms, detail) {
    const rec = { suite, name, status, ms, detail: fmtDetail(detail) }
    this.checks.push(rec)
    this.current = null
    this.send('check', { check: rec })
    this.emit('change')
    return rec
  }

  send(kind, data) {
    if (!this.report) return
    const body = JSON.stringify(Object.assign({ id: this.id, kind, at: Date.now() }, data))
    const http = this.rt.platform.http
    const url = this.report + '/gateway/selftest'
    this._posts = this._posts.then(() => http.request({ method: 'POST', url, headers: { 'content-type': 'application/json' }, body, timeoutMs: 15000 })).catch(() => {})
  }

  save() { return this.rt.vfs.writeJson(RESULT_PATH, this.result()).catch(() => {}) }

  result() {
    const count = s => this.checks.filter(c => c.status === s).length
    return {
      id: this.id, state: this.state, build: BUILD, version: VERSION,
      startedAt: this.startedAt, finishedAt: this.finishedAt || null, ms: (this.finishedAt || Date.now()) - this.startedAt,
      env: this.env, summary: { pass: count('pass'), fail: count('fail'), skip: count('skip') },
      interactions: this.interactions.length, checks: this.checks,
    }
  }

  // ------------------------------------------------------------------ agent helpers

  async newAgent(permission) {
    const agent = await this.rt.newSession({ workspaceId: this.ws.id })
    if (permission) agent.setPermission(permission)
    return agent
  }

  async ask(agent, text, timeoutMs) {
    const from = agent.session.events.length
    const r = await this.rt.send(agent, { text })
    assert(!(r && r.ok === false), 'the message was not accepted')
    await this.waitIdle(agent, timeoutMs || 240000)
    return turnInfo(agent, from)
  }

  waitIdle(agent, timeoutMs) {
    const t0 = Date.now()
    return new Promise((resolve, reject) => {
      let quiet = 0
      const tick = () => {
        const kids = childAgents(agent)
        this.answerPending(agent)
        kids.forEach(k => this.answerPending(k))
        const busy = agent.running || agent.inbox.nextTurn.length || agent.inbox.nextStep.length || kids.some(k => k.running)
        quiet = busy ? 0 : quiet + 1
        if (quiet >= 3) { resolve(); return }
        if (Date.now() - t0 > timeoutMs) {
          agent.cancel('selftest timeout')
          reject(new Error('no answer within ' + Math.round(timeoutMs / 1000) + ' s'))
          return
        }
        setTimeout(tick, 500)
      }
      setTimeout(tick, 500)
    })
  }

  /** Answer approvals, questions and plan reviews the way the current policy says. */
  answerPending(agent) {
    const p = agent.pending
    if (!p) return
    let value
    if (p.kind === 'approval') value = this.policy.approval
    else if (p.kind === 'question') value = { answers: (p.payload.questions || []).map(q => ({ id: q.id, selected: this.policy.pick(q) })) }
    else if (p.kind === 'plan') value = this.policy.plan
    else return
    this.interactions.push({ kind: p.kind, sessionId: agent.session.id })
    agent.answer(p.kind, value)
  }

  // ------------------------------------------------------------------ suites

  async suite_env() {
    await this.check('device and app', () => this.env)
    await this.check('engine features', () => {
      const native = f => typeof f === 'function' && /\[native code\]/.test(Function.prototype.toString.call(f))
      const g = typeof window !== 'undefined' ? window : {}
      return {
        worker: typeof Worker !== 'undefined',
        indexedDB: typeof indexedDB !== 'undefined',
        nativePromise: typeof Promise !== 'undefined' && native(Promise),
        nativeMap: typeof Map !== 'undefined' && native(Map),
        typedArrays: typeof Uint8Array !== 'undefined',
        crypto: !!(g.crypto || g.msCrypto),
        fetch: typeof fetch !== 'undefined',
        winrt: typeof Windows !== 'undefined',
      }
    })
  }

  /** Native phone hooks (APPX only): status bar, tile and badge, vibration, background, keyboard. */
  async suite_phone() {
    const p = this.rt.platform
    if (p.kind !== 'winrt') { this.record('phone', '(suite)', 'skip', 0, 'needs the installed app (APPX)'); return }
    await this.check('status bar progress', async () => {
      assert(p.busy && p.busy('DSH self-test…'), 'StatusBar progress indicator unavailable')
      await sleep(1200)
      p.busy(null)
      return 'shown, then hidden'
    })
    await this.check('Start tile and badge', () => {
      assert(p.tile && p.tile('DSH self-test', 'Tile update check'), 'tile update failed')
      assert(p.badge && p.badge(2), 'badge update failed')
      p.badge(0)
      p.tile(null)
      return 'updated, then cleared'
    })
    await this.check('vibration', () => {
      assert(p.vibrate && p.vibrate(30), 'no vibration device')
      return '30 ms'
    })
    await this.check('background execution', async () => {
      if (!p.keepRunning) return { skip: 'not available' }
      const granted = await p.keepRunning(true, 'selftest-check')
      await p.keepRunning(false, 'selftest-check')
      return { granted, screenOn: !!(p.keepScreenOn && p.keepScreenOn(true)) }
    })
    await this.check('keyboard (InputPane)', () => {
      const pane = Windows.UI.ViewManagement.InputPane.getForCurrentView()
      return { available: !!pane, keyboardOpen: !!(pane.occludedRect && pane.occludedRect.height) }
    })
  }

  async suite_storage() {
    const vfs = this.rt.vfs
    const base = '/tmp/dsh-selftest-' + this.id
    await this.check('UTF-8 text round trip', async () => {
      const s = '中文测试 ✓ émoji 😀\r\nline 2\n'
      await vfs.writeText(base + '/utf8.txt', s)
      const got = await vfs.readText(base + '/utf8.txt')
      assert(got === s, 'read back ' + JSON.stringify(got))
      return { bytes: utf8Encode(s).length }
    })
    await this.check('binary round trip', async () => {
      const b = new Uint8Array(256)
      for (let i = 0; i < 256; i++) b[i] = i
      await vfs.writeBytes(base + '/bytes.bin', b)
      const got = await vfs.readBytes(base + '/bytes.bin')
      assert(got.length === 256, 'length ' + got.length)
      for (let i = 0; i < 256; i++) assert(got[i] === i, 'byte ' + i + ' is ' + got[i])
      return { bytes: 256 }
    })
    await this.check('append, rename, list, remove', async () => {
      await vfs.writeText(base + '/log.txt', 'a\n')
      await vfs.appendText(base + '/log.txt', 'b\n')
      await vfs.rename(base + '/log.txt', base + '/sub/moved.txt')
      const names = (await vfs.list(base + '/sub')).map(e => e.name)
      assert(names.indexOf('moved.txt') >= 0, 'listing: ' + names.join(','))
      assert((await vfs.readText(base + '/sub/moved.txt')) === 'a\nb\n', 'append result differs')
      await vfs.remove(base + '/sub/moved.txt')
      assert(!(await vfs.stat(base + '/sub/moved.txt')), 'file still exists after remove')
      return 'ok'
    })
    await this.check('1 MiB file', async () => {
      const line = new Array(64).join('x') + '\n'
      const text = new Array(16385).join(line)
      let t0 = Date.now()
      await vfs.writeText(base + '/big.txt', text)
      const writeMs = Date.now() - t0
      t0 = Date.now()
      const got = await vfs.readText(base + '/big.txt')
      const readMs = Date.now() - t0
      assert(got.length === text.length, 'read ' + got.length + ' of ' + text.length + ' chars')
      return { bytes: text.length, writeMs, readMs }
    }, 180000)
    await this.check('workspace folder', async () => {
      const p = this.ws.path + '/probe.txt'
      await vfs.writeText(p, 'probe')
      const st = await vfs.stat(p)
      assert(st && st.type === 'file' && st.size === 5, 'stat ' + JSON.stringify(st))
      await vfs.remove(p)
      return { path: this.ws.path }
    })
    await this.check('credential vault', async () => {
      const c = this.rt.platform.credentials
      const id = 'selftest-probe'
      const value = 'probe-' + this.id
      await c.set(id, value)
      assert((await c.get(id)) === value, 'read back a different value')
      assert((await c.list()).indexOf(id) >= 0, 'not listed')
      await c.remove(id)
      assert(!(await c.get(id)), 'still present after remove')
      return { store: this.rt.platform.kind === 'winrt' ? 'PasswordVault' : this.rt.platform.kind === 'web' ? 'localStorage' : this.rt.platform.kind }
    })
    await vfs.remove(base).catch(() => {})
  }

  async suite_images() {
    const images = this.rt.platform.images
    if (!images || typeof document === 'undefined') { this.record('images', '(suite)', 'skip', 0, 'no image support on this platform'); return }
    const canvasBytes = (w, hgt, mime, q) => {
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = hgt
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#2a6'
      ctx.fillRect(0, 0, w, hgt)
      ctx.fillStyle = '#fff'
      ctx.fillRect(w / 4, hgt / 4, w / 2, hgt / 2)
      const url = canvas.toDataURL(mime, q)
      return base64ToBytes(url.slice(url.indexOf(',') + 1))
    }
    await this.check('PNG from canvas', async () => {
      const bytes = canvasBytes(64, 32, 'image/png')
      const img = await images.prepare(bytes, 'image/png')
      assert(img.width === 64 && img.height === 32, 'size ' + img.width + 'x' + img.height)
      return { bytes: bytes.length, mime: img.mime }
    })
    await this.check('downscale 3000x1500 photo', async () => {
      const bytes = canvasBytes(3000, 1500, 'image/jpeg', 0.9)
      const t0 = Date.now()
      const img = await images.prepare(bytes, 'image/jpeg')
      assert(img.width <= 2048 && img.height <= 2048, 'not downscaled: ' + img.width + 'x' + img.height)
      return { from: '3000x1500', to: img.width + 'x' + img.height, bytes: img.bytes, ms: Date.now() - t0 }
    }, 60000)
  }

  async suite_sandbox() {
    const runner = this.rt.platform.codeRunner
    if (!runner) { this.record('sandbox', '(suite)', 'skip', 0, 'no code sandbox on this platform'); return }
    const callTool = (name, args) => new Promise((resolve) => { resolve(SANDBOX_TOOLS[name](args)) })
    const run = (code, timeoutMs) => runner.run(code, { timeoutMs: timeoutMs || 60000, callTool, toolNames: Object.keys(SANDBOX_TOOLS) })
    for (const c of SANDBOX_CASES) {
      await this.check(c.name, async () => {
        const r = await run(c.code)
        const problem = checkSandboxCase(c, r)
        assert(!problem, problem)
        return r.error !== undefined ? { error: r.error } : { value: r.value }
      }, 90000)
    }
    await this.check('timeout stops a runaway loop', async () => {
      const r = await run('while (true) {}', 3000)
      assert(r.timedOut, 'expected a timeout, got ' + JSON.stringify(r))
      const again = await run('return 40 + 2')
      assert(String(again.value) === '42', 'sandbox did not recover: ' + JSON.stringify(again))
      return 'stopped after 3 s, worker restarted'
    }, 60000)
  }

  async suite_network() {
    const http = this.rt.platform.http
    const direct = this.rt.platform.kind !== 'web'
    await this.check('direct HTTPS to api.deepseek.com', async () => {
      if (!direct) return { skip: 'the browser build reaches DeepSeek through the gateway' }
      const t0 = Date.now()
      let res
      try {
        res = await http.request({ method: 'GET', url: 'https://api.deepseek.com/models', headers: {}, timeoutMs: 20000 })
      } catch (e) {
        if (this.rt.platform.hint === 'wp81') return { skip: 'Windows Phone 8.1 TLS cannot reach this host (expected; use the gateway): ' + errText(e) }
        throw e
      }
      assert(res.status === 401 || res.status === 200, 'HTTP ' + res.status)
      return { status: res.status, ms: Date.now() - t0 }
    }, 30000)
    await this.check('direct HTTPS to another site', async () => {
      if (!direct) return { skip: 'cross-origin requests go through the gateway in the browser build' }
      const t0 = Date.now()
      const res = await http.request({ method: 'GET', url: 'https://www.bing.com/', headers: {}, timeoutMs: 20000 })
      assert(res.status >= 200 && res.status < 400, 'HTTP ' + res.status)
      return { status: res.status, ms: Date.now() - t0 }
    }, 30000)
    await this.check('gateway reachable', async () => {
      if (!this.report) return { skip: 'no gateway address was given' }
      const res = await http.request({ method: 'GET', url: this.report + '/gateway/info', headers: {}, timeoutMs: 8000 })
      assert(res.status === 200 && /dsh-gateway/.test(res.text), 'HTTP ' + res.status)
      return JSON.parse(res.text)
    }, 20000)
  }

  async suite_llm() {
    const rt = this.rt
    const model = this.opts.model
    const sys = { role: 'system', content: [{ type: 'text', text: 'You are a terse test agent.' }] }
    const user = text => ({ role: 'user', content: [{ type: 'text', text }] })
    await this.check('model listing', async () => {
      await rt.llm.ensureListing(true)
      const ids = rt.llm.models('deepseek').map(m => m.id)
      assert(ids.length, 'no models listed')
      assert(ids.indexOf(model) >= 0, model + ' is not in ' + ids.join(', '))
      return { models: ids }
    }, 45000)
    await this.check('account balance', async () => {
      const b = await rt.llm.balance()
      const json = b && b.json !== undefined ? b.json : b
      assert(json && typeof json === 'object', 'unexpected response')
      return { available: json.is_available, currencies: (json.balance_infos || []).map(x => x.currency) }
    }, 30000)
    await this.check('streaming reply', async () => {
      const route = rt.llm.resolve({ provider: 'deepseek', model, effort: 'off' })
      const attempt = async () => {
        const token = 'PONG-' + shortId(4).toUpperCase()
        let deltas = 0
        let streamed = ''
        let ttft = 0
        const t0 = Date.now()
        const r = await rt.llm.stream(route, {
          messages: [sys, user('Reply with exactly: ' + token)], tools: [], maxTokens: 200, effort: 'off',
          onEvent: (e) => { if (e.kind === 'delta') { deltas++; streamed += e.text || ''; if (!ttft) ttft = Date.now() - t0 } },
        })
        const text = textOf(r.content)
        const out = (r.usage && r.usage.output) || 0
        return { ok: text.indexOf(token) >= 0, text, streamed, out, deltas, ttft, ms: Date.now() - t0, usage: r.usage }
      }
      let a = await attempt()
      let note
      if (!a.ok) {
        // The text must be what the model produced: about 4 characters per output token at
        // most, and the deltas must add up to it. Anything else means the stream was mangled.
        assert(a.streamed === a.text, 'streamed deltas differ from the final text (' + a.streamed.length + ' vs ' + a.text.length + ' chars)')
        assert(!a.out || a.text.length <= a.out * 8 + 16, a.text.length + ' chars for ' + a.out + ' output tokens: ' + clip(a.text, 200))
        note = 'first reply did not follow the instruction (' + a.out + ' tokens): ' + clip(a.text.replace(/\s+/g, ' '), 120)
        a = await attempt()
        assert(a.ok, 'twice off: ' + clip(a.text, 200))
      }
      return { ttftMs: a.ttft, totalMs: a.ms, deltas: a.deltas, usage: a.usage, note }
    }, 120000)
    await this.check('thinking (effort high)', async () => {
      const route = rt.llm.resolve({ provider: 'deepseek', model, effort: 'high' })
      const t0 = Date.now()
      const r = await rt.llm.stream(route, { messages: [sys, user('What is 17 * 23? Answer with just the number.')], tools: [], maxTokens: 4000, effort: 'high' })
      const thinking = r.content.filter(b => b.type === 'thinking')
      assert(thinking.length, 'no thinking block (blocks: ' + r.content.map(b => b.type).join(',') + ')')
      assert(/391/.test(textOf(r.content)), 'reply: ' + clip(textOf(r.content), 200))
      return { thinkingChars: thinking.reduce((n, b) => n + (b.text || '').length, 0), signed: !!thinking[0].signature, ms: Date.now() - t0 }
    }, 120000)
    await this.check('tool call round trip', async () => {
      const route = rt.llm.resolve({ provider: 'deepseek', model, effort: 'off' })
      const tools = [{ name: 'read', description: 'Read a UTF-8 text file and return line-numbered content.', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }]
      const ask = user('Use the read tool to read notes.txt, then tell me the secret word.')
      const r1 = await rt.llm.stream(route, { messages: [sys, ask], tools, maxTokens: 1000, effort: 'off' })
      const call = r1.content.filter(b => b.type === 'tool-call')[0]
      assert(call && call.name === 'read', 'no read call (stop: ' + r1.stopReason + ')')
      const r2 = await rt.llm.stream(route, {
        messages: [sys, ask, { role: 'assistant', content: r1.content }, { role: 'tool', callId: call.id, name: call.name, content: [{ type: 'text', text: '1: The secret word is PELICAN.' }] }],
        tools, maxTokens: 1000, effort: 'off',
      })
      assert(/PELICAN/i.test(textOf(r2.content)), 'reply: ' + clip(textOf(r2.content), 200))
      return { call: call.name + ' ' + JSON.stringify(call.input || call.arguments), cacheRead: r2.usage && r2.usage.cacheRead }
    }, 120000)
    await this.check('abort mid-stream', async () => {
      const route = rt.llm.resolve({ provider: 'deepseek', model, effort: 'off' })
      const ctl = createAbort()
      let deltas = 0
      let abortedAt = 0
      try {
        await rt.llm.stream(route, {
          messages: [sys, user('Count from 1 to 400, one number per line.')], tools: [], maxTokens: 4000, effort: 'off', signal: ctl.signal,
          onEvent: (e) => { if (e.kind === 'delta' && ++deltas === 5) { abortedAt = Date.now(); ctl.abort('selftest') } },
        })
      } catch (e) {
        assert(isAbortError(e) || ctl.signal.aborted, 'unexpected error: ' + errText(e))
        return { deltasBeforeAbort: deltas, stopMs: Date.now() - abortedAt }
      }
      throw new Error('the stream finished without being aborted (' + deltas + ' deltas)')
    }, 90000)
  }

  async suite_agent() {
    const rt = this.rt
    const vfs = rt.vfs
    let main = null
    await this.check('tool chain (todo, read, edit, run_code, glob)', async () => {
      main = await this.newAgent()
      const need = ['todo_write', 'read', 'edit', 'run_code', 'glob']
      const r = await this.ask(main, 'Do these steps: 1) use todo_write to plan 3 steps, 2) read notes.txt, 3) edit notes.txt replacing "beta" with "BETA", 4) use run_code to compute the sum of 1..100 and also call tools.read on notes.txt inside the code and return its length, 5) glob for *.txt. Then summarize the results in one short paragraph.', 300000)
      // Models sometimes skip a step; ask for it the way a user would.
      const missing = need.filter(n => r.names.indexOf(n) < 0)
      let followUp = null
      if (missing.length) {
        followUp = await this.ask(main, 'You skipped ' + missing.join(', ') + '. Use ' + missing.join(' and ') + ' now as described in my previous message, then reply in one sentence.', 180000)
        r.tools = r.tools.concat(followUp.tools)
        r.names = r.names.concat(followUp.names)
        r.text = followUp.text || r.text
      }
      for (const n of need) assert(r.names.indexOf(n) >= 0, n + ' was not used; ' + JSON.stringify(brief(r)))
      const content = await vfs.readText(this.ws.path + '/notes.txt')
      assert(/BETA/.test(content), 'notes.txt was not edited: ' + JSON.stringify(content))
      assert(r.tools.some(t => t.name === 'run_code' && !t.isError), 'run_code failed: ' + JSON.stringify(brief(r)))
      assert(r.text, 'no final reply; ' + JSON.stringify(brief(r)))
      return brief(r, { usage: main.usageTotals(), askedAgainFor: missing.length ? missing : undefined })
    }, 330000)
    await this.check('automatic title', async () => {
      if (!main) return { skip: 'no session' }
      const t0 = Date.now()
      while (!main.meta.title && Date.now() - t0 < 30000) await sleep(500)
      assert(main.meta.title, 'no title after 30 s')
      return { title: main.meta.title }
    }, 40000)
    await this.check('session log persists', async () => {
      if (!main) return { skip: 'no session' }
      await rt.flush()
      const store = new SessionStore(vfs)
      await store.init()
      const s = await store.open(main.session.id)
      assert(s.events.length === main.session.events.length, 'stored ' + s.events.length + ' of ' + main.session.events.length + ' events')
      return { events: s.events.length }
    })
    await this.check('export as Markdown', async () => {
      if (!main) return { skip: 'no session' }
      const md = await rt.exportMarkdown(main.session.id)
      assert(md.indexOf('**User:**') >= 0 && md.indexOf('**Assistant:**') >= 0, 'unexpected export')
      return { chars: md.length }
    })
    await this.check('stop a running turn', async () => {
      const a = await this.newAgent()
      await rt.send(a, { text: 'Write a 500-word story about a lighthouse keeper. Do not use any tools.' })
      const t0 = Date.now()
      // stop once the reply is streaming (live.chars counts streamed characters)
      while (!(a.live && a.live.chars > 20) && a.running && Date.now() - t0 < 60000) await sleep(100)
      assert(a.running, 'the turn finished before it could be stopped')
      const streamed = a.live ? a.live.chars : 0
      a.cancel('user')
      await this.waitIdle(a, 30000)
      const end = a.session.last('turn/end')
      assert(end && end.data.reason === 'aborted', 'turn ended with ' + (end ? end.data.reason : 'nothing'))
      return { streamedChars: streamed, stoppedAfterMs: Date.now() - t0 }
    }, 90000)
    this.mainSessionId = main && main.session.id
  }

  async suite_interaction() {
    const rt = this.rt
    await this.check('ask_user_question', async () => {
      this.policy.pick = q => { const o = (q.options || []).filter(x => /banana/i.test(x.label))[0] || (q.options || [])[0]; return o ? [o.label] : [] }
      const before = this.interactions.length
      const a = await this.newAgent()
      const r = await this.ask(a, 'Use the ask_user_question tool to ask me which fruit I want, with exactly two options: "Apple" and "Banana". After I answer, reply with just the fruit I picked.', 240000)
      assert(this.interactions.slice(before).some(i => i.kind === 'question'), 'no question was asked; ' + JSON.stringify(brief(r)))
      assert(/banana/i.test(r.text), 'reply: ' + clip(r.text, 200))
      return brief(r)
    }, 270000)
    this.policy = this.defaultPolicy()
    await this.check('plan mode and plan approval', async () => {
      const before = this.interactions.length
      const a = await this.newAgent()
      await rt.runCommand(a, 'plan', '')
      assert(a.planMode(), 'plan mode did not turn on')
      const r = await this.ask(a, 'Create a file named plan-check.txt containing exactly the word READY. Keep the plan to one step.', 300000)
      assert(this.interactions.slice(before).some(i => i.kind === 'plan'), 'no plan review was requested; ' + JSON.stringify(brief(r)))
      const st = await rt.vfs.stat(this.ws.path + '/plan-check.txt')
      assert(st, 'plan-check.txt was not created after approval; ' + JSON.stringify(brief(r)))
      return brief(r, { planModeNow: a.planMode() })
    }, 330000)
    await this.check('sandbox escalation approval', async () => {
      const before = this.interactions.length
      const a = await this.newAgent('read-only')
      const r = await this.ask(a, 'Write the word GRANTED into a file named approval-check.txt. The sandbox is read-only: if the write is blocked, retry the same write once with sandbox_permissions "workspace-write" and a one-sentence justification.', 240000)
      assert(this.interactions.slice(before).some(i => i.kind === 'approval'), 'no approval was requested; ' + JSON.stringify(brief(r)))
      const text = await rt.vfs.readText(this.ws.path + '/approval-check.txt').catch(() => '')
      assert(/GRANTED/.test(text), 'file not written after approval; ' + JSON.stringify(brief(r)))
      return brief(r)
    }, 270000)
  }

  async suite_web() {
    await this.check('web_search', async () => {
      const a = await this.newAgent()
      const r = await this.ask(a, 'Use web_search to find the year the Nokia Lumia 950 was announced. Answer with the year only.', 240000)
      assert(r.names.indexOf('web_search') >= 0, 'web_search was not used; ' + JSON.stringify(brief(r)))
      assert(r.tools.some(t => t.name === 'web_search' && !t.isError), 'web_search failed; ' + JSON.stringify(brief(r)))
      assert(/2015/.test(r.text), 'reply: ' + clip(r.text, 200))
      return brief(r)
    }, 270000)
    await this.check('web_fetch', async () => {
      const a = await this.newAgent()
      const r = await this.ask(a, 'Use web_fetch to fetch https://api-docs.deepseek.com/ and tell me the title of the page in a few words.', 240000)
      const fetches = r.tools.filter(t => t.name === 'web_fetch')
      assert(fetches.length, 'web_fetch was not used; ' + JSON.stringify(brief(r)))
      assert(fetches.some(t => !t.isError && /deepseek/i.test(t.text)), 'fetch failed; ' + JSON.stringify(brief(r)))
      return brief(r, { fetched: clip(fetches[0].text, 160) })
    }, 270000)
  }

  async suite_subagent() {
    await this.check('delegate to a subagent', async () => {
      const a = await this.newAgent()
      const r = await this.ask(a, 'Delegate to a subagent: ask it to read notes.txt and report the number of lines. Wait for its result, then tell me the number.', 300000)
      assert(r.names.indexOf('subagent') >= 0, 'no subagent was started; ' + JSON.stringify(brief(r)))
      assert(/\b3\b|three/i.test(r.text), 'reply: ' + clip(r.text, 200))
      return brief(r, { subagents: Object.keys(a.children).length })
    }, 330000)
  }

  async suite_workflow() {
    const vfs = this.rt.vfs
    await this.check('workflow with parallel agents', async () => {
      await vfs.writeText(this.ws.path + '/wf/a.txt', 'apple banana')
      await vfs.writeText(this.ws.path + '/wf/b.txt', 'cherry')
      const a = await this.newAgent()
      const r = await this.ask(a, 'Use the workflow tool (not plain subagent calls): for each of wf/a.txt and wf/b.txt run one agent (use pipeline) that reads the file and returns {"file": string, "words": number} via opts.schema; return the array. Then tell me the total word count.', 420000)
      const wf = r.tools.filter(t => t.name === 'workflow')
      assert(wf.length, 'workflow was not used; ' + JSON.stringify(brief(r)))
      assert(wf.some(t => !t.isError), 'workflow failed; ' + JSON.stringify(brief(r)))
      assert(/\b3\b|three/i.test(r.text), 'reply: ' + clip(r.text, 200))
      return brief(r, { workflow: clip(wf[wf.length - 1].text, 200) })
    }, 450000)
  }

  async suite_compaction() {
    await this.check('compaction keeps earlier facts', async () => {
      const a = await this.newAgent()
      await this.ask(a, 'Remember this: the project codename is BLUE-HERON. Reply "noted".', 120000)
      await this.ask(a, 'Read notes.txt and tell me its first line.', 180000)
      const res = await a.compact({ keep: 300, reason: 'command' })
      assert(res && !res.error, 'compaction failed: ' + JSON.stringify(res))
      assert(a.session.events.some(e => e.type === 'compaction/summary'), 'no compaction summary was recorded')
      const r = await this.ask(a, 'What is the project codename I told you at the start? Answer in one line.', 120000)
      assert(/BLUE-HERON/i.test(r.text), 'reply: ' + clip(r.text, 200))
      return { compaction: res, reply: clip(r.text, 120) }
    }, 480000)
  }

  async suite_schedule() {
    const rt = this.rt
    await this.check('scheduled task runs now', async () => {
      const task = rt.schedule.create({ title: 'DSH self-test', prompt: 'Reply with exactly: SCHEDULED-OK', rrule: 'DTSTART:20990101T000000Z\nRRULE:FREQ=DAILY', target: 'new_once', workspaceId: this.ws.id, cwd: this.ws.path })
      this.taskIds.push(task.id)
      await rt.schedule.runNow(task.id)
      const run = (task.runs || [])[task.runs.length - 1]
      assert(run && run.status === 'delivered' && run.sessionId, 'not delivered: ' + JSON.stringify(run))
      const agent = await rt.agentFor(run.sessionId)
      await this.waitIdle(agent, 180000)
      const r = turnInfo(agent, 0)
      assert(/SCHEDULED-OK/.test(r.text), 'reply: ' + clip(r.text, 200))
      const del = rt.schedule.edit(task.id, { action: 'delete' })
      assert(del && del.deleted, 'could not delete the task')
      return { nextRun: new Date(task.nextAt).toISOString(), reply: clip(r.text, 80) }
    }, 240000)
  }

  async suite_mcp() {
    const rt = this.rt
    const url = this.report + '/gateway/mcp-test'
    let client = null
    await this.check('connect and list tools', async () => {
      rt.settings.update({ mcp: { servers: [{ id: 'selftest', name: 'DSH self-test', url, enabled: true }] } })
      await rt.mcp.refresh(true)
      client = rt.mcp.clients.selftest
      assert(client && client.state === 'ready', 'state ' + (client ? client.state + ' ' + (client.error || '') : 'missing'))
      return { tools: client.tools.map(t => t.name) }
    }, 30000)
    await this.check('call a tool directly', async () => {
      if (!client || client.state !== 'ready') return { skip: 'not connected' }
      const r = await client.callTool('add', { a: 19, b: 23 })
      const text = ((r && r.content) || []).map(c => c.text || '').join(' ')
      assert(/42/.test(text), 'result: ' + text)
      return { result: text }
    }, 30000)
    await this.check('agent uses an MCP tool', async () => {
      if (!client || client.state !== 'ready') return { skip: 'not connected' }
      const a = await this.newAgent()
      const r = await this.ask(a, 'Use the mcp__selftest__add tool to add 19 and 23, then reply with just the result.', 180000)
      assert(r.names.indexOf('mcp__selftest__add') >= 0, 'the MCP tool was not used; ' + JSON.stringify(brief(r)))
      assert(/42/.test(r.text), 'reply: ' + clip(r.text, 200))
      return brief(r)
    }, 210000)
    rt.settings.update({ mcp: { servers: [] } })
    await rt.mcp.refresh(true).catch(() => {})
  }

  async suite_gateway() {
    const rt = this.rt
    const saved = clone(rt.settings.get().gateway)
    rt.settings.update({ gateway: { url: this.report, code: this.opts.gatewayCode || saved.code, route: 'https' } })
    try {
      await this.check('gateway access', async () => {
        const info = await rt.probeGateway()
        assert(info && !info.error, 'gateway: ' + JSON.stringify(info))
        assert(info.codeAccepted !== false, 'the access code was not accepted')
        return info
      }, 20000)
      await this.check('listing through the gateway', async () => {
        await rt.llm.ensureListing(true)
        return { models: rt.llm.models('deepseek').map(m => m.id) }
      }, 45000)
      await this.check('streaming through the gateway', async () => {
        const route = rt.llm.resolve({ provider: 'deepseek', model: this.opts.model, effort: 'off' })
        const t0 = Date.now()
        const r = await rt.llm.stream(route, { messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: RELAY-OK' }] }], tools: [], maxTokens: 100, effort: 'off' })
        assert(/RELAY-OK/.test(textOf(r.content)), 'reply: ' + clip(textOf(r.content), 200))
        return { ms: Date.now() - t0 }
      }, 90000)
    } finally {
      rt.settings.set('gateway', saved)
      await rt.probeGateway().catch(() => {})
    }
  }

  /** Desktop dsh behind the gateway (--dsh): a session that runs on the computer. */
  async suite_remote() {
    const rt = this.rt
    const saved = clone(rt.settings.get().gateway)
    rt.settings.update({ gateway: { url: this.report, code: this.opts.gatewayCode || saved.code } })
    const remote = rt.remote
    let info = null
    let s = null
    const until = (pred, ms) => new Promise((resolve, reject) => {
      const t0 = Date.now()
      const tick = () => {
        if (hasPending(s)) {
          const it = s.items.filter(i => i.kind === 'permission' && !i.decided)[0]
          const allow = it && (it.options || []).filter(o => /^allow_once/.test(o.kind))[0]
          if (it && allow) remote.answer(s.id, it.requestId, allow.optionId).catch(() => {})
        }
        if (pred()) { resolve(); return }
        if (Date.now() - t0 > ms) { reject(new Error('no result within ' + Math.round(ms / 1000) + ' s')); return }
        setTimeout(tick, 300)
      }
      tick()
    })
    try {
      await this.check('bridge reachable', async () => {
        try { info = await remote.refreshInfo() } catch (e) {
          if (e.code === 'DSH_UNAVAILABLE') return { skip: 'the gateway was started without --dsh' }
          throw e
        }
        return { roots: info.roots, running: info.running }
      }, 20000)
      if (!info) return
      const mock = () => remote.info && remote.info.agent && remote.info.agent.agentInfo && remote.info.agent.agentInfo.name === 'acp-mock'
      await this.check('new session on the computer', async () => {
        const ls = await remote.ls(info.roots[0])
        s = await remote.newSession(ls.path)
        assert(s && s.id, 'no session id')
        return { cwd: s.cwd, agent: remote.info.agent && remote.info.agent.agentInfo, model: s.config && s.config.filter(c => c.id === 'model').map(c => c.currentValue)[0] }
      }, 240000)
      if (!s) return
      await this.check('prompt and reply', async () => {
        const token = 'REMOTE-' + shortId(4).toUpperCase()
        await remote.prompt(s.id, 'Reply with exactly: ' + token + '. Do not use any tools.')
        await until(() => !s.running, 180000)
        const end = s.items[s.items.length - 1]
        assert(end.kind === 'end' && !end.error, 'turn ended with ' + JSON.stringify(end))
        const reply = s.items.filter(i => i.kind === 'message').map(i => i.text).join('\n')
        if (!mock()) assert(reply.indexOf(token) >= 0, 'reply: ' + clip(reply, 200))
        return { stopReason: end.stopReason, reply: clip(reply, 120) }
      }, 200000)
      await this.check('run a command on the computer', async () => {
        const from = s.items.length
        await remote.prompt(s.id, 'Use your shell tool to run `echo dsh-mobile-$((6*7))` and tell me what it printed.')
        await until(() => !s.running, 240000)
        const items = s.items.slice(from)
        const tools = items.filter(i => i.kind === 'tool')
        assert(tools.length, 'no tool ran: ' + JSON.stringify(items.map(i => i.kind)))
        assert(tools.some(t => t.status === 'completed'), 'tools: ' + JSON.stringify(tools.map(t => t.title + ' ' + t.status)))
        if (!mock()) assert(/dsh-mobile-42/.test(items.map(i => (i.output || '') + (i.text || '')).join('\n')), 'output not seen')
        return { tools: tools.map(t => t.title + ' ' + t.status), approvals: items.filter(i => i.kind === 'permission').length }
      }, 260000)
      // Opt-in (request field remoteApprovalPath: a file outside dsh's sandbox on the
      // computer): a write there needs approval, answered from the phone; the file is removed again.
      if (this.opts.remoteApprovalPath && !mock()) {
        await this.check('approve a command from the phone', async () => {
          const from = s.items.length
          const p = this.opts.remoteApprovalPath
          await remote.prompt(s.id, 'Use your shell tool to run exactly: echo approved > \'' + p + '\' — if the sandbox blocks it, request the wider permission and retry once. Then delete that file the same way, and reply "done".')
          await until(() => !s.running, 300000)
          const items = s.items.slice(from)
          const perms = items.filter(i => i.kind === 'permission')
          assert(perms.length, 'no permission was requested: ' + JSON.stringify(items.filter(i => i.kind === 'tool').map(t => t.title + ' ' + t.status)))
          assert(perms.every(i => i.decided && /allow/.test(i.decided)), 'not all approved: ' + JSON.stringify(perms.map(i => i.decided)))
          return { approvals: perms.length, tools: items.filter(i => i.kind === 'tool').map(t => t.title + ' ' + t.status) }
        }, 330000)
      }
    } finally {
      if (s) await remote.remove(s.id).catch(() => {})
      rt.settings.set('gateway', saved)
    }
  }

  async suite_ui() {
    if (typeof document === 'undefined') { this.record('ui', '(suite)', 'skip', 0, 'no DOM'); return }
    const errors = []
    const prev = window.onerror
    window.onerror = function (msg) {
      errors.push(String(msg))
      return prev ? prev.apply(this, arguments) : false
    }
    const pages = [
      ['home', {}], ['settings', {}], ['plugins', {}], ['automation', {}], ['about', {}],
      ['files', { root: this.ws ? this.ws.path : '/workspaces', title: 'self-test' }],
    ]
    const sid = this.mainSessionId || this.newSessionIds()[0]
    if (sid) pages.push(['chat', { sessionId: sid }], ['panel', { sessionId: sid }])
    try {
      for (const p of pages) {
        await this.check('page: ' + p[0], async () => {
          const depth = current()
          const before = errors.length
          const t0 = Date.now()
          navigate(p[0], p[1])
          let el = null
          while (Date.now() - t0 < 5000) {
            await sleep(50)
            el = document.querySelector('.app .page .page-body')
            if (el && current() !== depth) break
          }
          await sleep(300)
          const ms = Date.now() - t0
          const text = el ? (el.textContent || '').length : 0
          back()
          await sleep(150)
          assert(el, 'page did not render')
          assert(errors.length === before, 'errors: ' + errors.slice(before).join(' | '))
          return { ms, textChars: text }
        }, 20000)
      }
    } finally {
      window.onerror = prev
    }
  }
}
