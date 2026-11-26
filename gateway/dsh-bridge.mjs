// Desktop dsh bridge. Runs `dsh --profile acp` (DeepSeek Harness speaking the
// Agent Client Protocol: newline-delimited JSON-RPC 2.0 on stdio) on this
// computer and relays it to DSH Mobile over plain HTTP, so the phone can drive
// an agent that works here, with dsh's own tools (shell, terminal, browser,
// computer use), while approvals are answered on the phone.
//
//   GET  /gateway/dsh/info                 → {available, running, epoch, agent, roots, home}
//   GET  /gateway/dsh/ls?path=…            → sub-folders under the allowed roots
//   POST /gateway/dsh/call {method, params, async}
//        A client→agent request. With async:true it returns {callId} at once and
//        the outcome arrives in the event stream as {type:'result', callId, …}
//        (session/prompt settles only when the whole turn has finished).
//   POST /gateway/dsh/notify {method, params}  client→agent notification (session/cancel)
//   GET  /gateway/dsh/events?after=N&epoch=E   agent→client messages, long-polled (25 s)
//   POST /gateway/dsh/respond {id, result}     answer an agent→client request
//
// The server calls these only after checking the gateway access code. Of the
// agent's requests only session/request_permission reaches the phone: the
// client advertises no file-system or terminal capability, so dsh uses its own.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const MAX_EVENTS = 5000

export function createDshBridge({ exe, args = [], env = {}, roots = [os.homedir()], log = console.log, version = 'dev' }) {
  let proc = null
  let epoch = ''
  let lineBuf = ''
  let nextId = 1
  let initResult = null
  let starting = null
  const pending = new Map() // id → {resolve, reject, method}
  const events = [] // {seq, type, …}
  let seq = 0
  const waiters = new Set()
  const realRoots = roots.map(r => fs.realpathSync(path.resolve(r)))
  const boot = crypto.randomBytes(4).toString('hex') // this gateway run: event numbers restart with it

  function push(e) {
    e.seq = ++seq
    e.at = Date.now()
    e.epoch = epoch
    events.push(e)
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
    for (const w of waiters) w()
  }

  function send(msg) {
    if (!proc) throw new Error('dsh is not running')
    proc.stdin.write(JSON.stringify(Object.assign({ jsonrpc: '2.0' }, msg)) + '\n')
  }

  function onMessage(m) {
    if (m.method === undefined && m.id !== undefined) {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      if (m.error) p.reject(Object.assign(new Error(m.error.message || 'dsh error'), { rpc: m.error }))
      else p.resolve(m.result)
      return
    }
    if (m.id !== undefined) {
      if (m.method === 'session/request_permission') push({ type: 'request', id: m.id, method: m.method, params: m.params })
      else send({ id: m.id, error: { code: -32601, message: 'DSH Mobile does not offer ' + m.method } })
      return
    }
    push({ type: 'notification', method: m.method, params: m.params })
  }

  function start() {
    epoch = crypto.randomBytes(4).toString('hex')
    lineBuf = ''
    initResult = null
    const child = spawn(exe, args.concat(['--profile', 'acp']), { env: Object.assign({}, process.env, env), stdio: ['pipe', 'pipe', 'pipe'] })
    proc = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      lineBuf += chunk
      let i
      while ((i = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, i).trim()
        lineBuf = lineBuf.slice(i + 1)
        if (!line) continue
        let m
        try { m = JSON.parse(line) } catch (e) { log('dsh: non-protocol output: ' + line.slice(0, 200)); continue }
        onMessage(m)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { for (const l of String(chunk).split('\n')) if (l.trim()) log('dsh: ' + l.slice(0, 300)) })
    const gone = (why) => {
      if (proc !== child) return
      proc = null
      initResult = null
      for (const [, p] of pending) p.reject(new Error('dsh stopped: ' + why))
      pending.clear()
      push({ type: 'exit', reason: why })
      log('dsh: process ended (' + why + ')')
    }
    child.on('exit', (code, signal) => gone(signal ? 'signal ' + signal : 'exit code ' + code))
    child.on('error', e => gone(e.message))
  }

  function request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = nextId++
      let timer = null
      pending.set(id, {
        method,
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v) },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e) },
      })
      if (timeoutMs) {
        timer = setTimeout(() => {
          if (!pending.has(id)) return
          pending.delete(id)
          reject(new Error(method + ': dsh did not answer within ' + Math.round(timeoutMs / 1000) + ' s'))
        }, timeoutMs)
      }
      try { send({ id, method, params }) } catch (e) { pending.delete(id); reject(e) }
    })
  }

  /** Start dsh (once) and run the ACP handshake. */
  function ensure() {
    if (proc && initResult) return Promise.resolve(initResult)
    if (!starting) {
      starting = (async () => {
        if (!proc) start()
        initResult = await request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'dsh-mobile-gateway', version },
        }, 180000)
        log('dsh: ready (' + ((initResult.agentInfo && (initResult.agentInfo.name + ' ' + initResult.agentInfo.version)) || 'ACP v' + initResult.protocolVersion) + ')')
        return initResult
      })().finally(() => { starting = null })
    }
    return starting
  }

  function inRoots(p) {
    let real
    try { real = fs.realpathSync(p) } catch (e) { return null }
    return realRoots.some(r => real === r || real.startsWith(r + path.sep)) ? real : null
  }

  return {
    async info() {
      return { available: true, running: !!(proc && initResult), boot, epoch: proc ? epoch : '', agent: initResult, roots: realRoots, home: os.homedir(), sep: path.sep }
    },

    async ls(p) {
      const dir = inRoots(path.resolve(p || realRoots[0]))
      if (!dir) throw Object.assign(new Error('outside the allowed folders'), { status: 403 })
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => e.name)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 500)
      const parent = path.dirname(dir)
      return { path: dir, parent: parent !== dir && inRoots(parent) ? parent : null, dirs: entries }
    },

    async call(method, params, { async: background } = {}) {
      if (typeof method !== 'string' || !/^[a-z_/$]+$/i.test(method) || method === 'initialize') throw Object.assign(new Error('bad method'), { status: 400 })
      if (method === 'session/new' || method === 'session/resume') {
        const cwd = params && params.cwd
        if (!cwd || !inRoots(cwd)) throw Object.assign(new Error('the working folder must be inside the allowed folders'), { status: 403 })
      }
      await ensure()
      if (!background) return { result: await request(method, params, 300000) }
      const callId = crypto.randomBytes(6).toString('hex')
      request(method, params, 0).then(
        result => push({ type: 'result', callId, method, result }),
        error => push({ type: 'result', callId, method, error: { message: error.message, data: error.rpc && error.rpc.data } }),
      )
      return { callId, epoch }
    },

    async notify(method, params) {
      if (!proc) return { sent: false }
      send({ method, params })
      return { sent: true }
    },

    async respond(id, result) {
      send({ id, result })
      push({ type: 'answered', id })
      return { ok: true }
    },

    /** Events after `after`; waits up to waitMs for new ones. A different epoch means dsh restarted. */
    events(after, waitMs) {
      const pick = () => events.filter(e => e.seq > after)
      const first = pick()
      if (first.length || !waitMs) return Promise.resolve({ events: first, last: seq, boot, epoch: proc ? epoch : '' })
      return new Promise((resolve) => {
        let done = false
        const finish = () => {
          if (done) return
          done = true
          waiters.delete(wake)
          clearTimeout(timer)
          resolve({ events: pick(), last: seq, boot, epoch: proc ? epoch : '' })
        }
        const wake = () => setTimeout(finish, 30) // gather a burst into one response
        const timer = setTimeout(finish, waitMs)
        waiters.add(wake)
      })
    },

    stop() { if (proc) proc.kill() },
  }
}
