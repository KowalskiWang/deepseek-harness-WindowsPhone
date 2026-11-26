#!/usr/bin/env node
// Windows Device Portal client (Windows 10 Mobile and other Windows 10 devices),
// used to install, start and inspect DSH Mobile over Wi-Fi. No dependencies.
//
// Library:  import { Wdp } from './wdp.mjs'
// CLI:      node scripts/wdp.mjs <device> <command> [args]
//   info                      OS and device information
//   apps [filter]             installed packages
//   install <file.appx>       install or update a package
//   launch|stop|uninstall [filter]    (default filter: DSHMobile)
//   ls [path]                 list the app's data folder (path like LocalState\app)
//   get <path\file> [out]     download a file from the app's data folder
//   put <file> <path>         upload a file into an existing folder of the app's data
//   rm <path\file>            delete a file from the app's data folder
//
// <device> is an address such as 192.168.1.35. HTTPS (the phone's self-signed
// certificate) is tried first, then plain HTTP. Turn on Developer mode, Device
// discovery and Device Portal on the phone; when Device Portal authentication is
// on, set WDP_USER and WDP_PASS.
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const sleep = ms => new Promise(r => setTimeout(r, ms))
// Node's HTTP parser error, e.g. for the phone's invalid "204 with a body"
const isParseError = e => /parse error|HPE_/i.test(String(e && e.message) + ' ' + String(e && e.code || ''))
const b64 = s => encodeURIComponent(Buffer.from(String(s), 'utf8').toString('base64'))

function multipart(name, data) {
  const boundary = '----dsh' + Date.now().toString(16) + Math.random().toString(16).slice(2)
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`)
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return { body: Buffer.concat([head, data, tail]), type: 'multipart/form-data; boundary=' + boundary }
}

export class Wdp {
  constructor(device, { user = process.env.WDP_USER, pass = process.env.WDP_PASS } = {}) {
    this.device = String(device)
    this.base = null
    this.cookies = {}
    this.auth = user ? 'Basic ' + Buffer.from(user + ':' + (pass || '')).toString('base64') : null
  }

  get secure() { return /^https:/.test(this.base || '') }

  async connect() {
    const host = this.device.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    const candidates = /^http:\/\//.test(this.device) ? ['http://' + host] : ['https://' + host, 'http://' + host]
    let lastErr = null
    for (const base of candidates) {
      this.base = base
      try {
        const r = await this.request('GET', '/api/os/info', { timeoutMs: 10000 })
        if (r.status === 401) throw Object.assign(new Error('Device Portal asks for sign-in: turn off its authentication in Settings → Update & security → For developers, or set WDP_USER/WDP_PASS'), { fatal: true })
        if (r.status !== 200) throw new Error('HTTP ' + r.status)
        this.os = JSON.parse(r.body.toString('utf8'))
        return this.os
      } catch (e) {
        lastErr = e
        if (e.fatal) throw e
      }
    }
    throw new Error(`cannot reach Device Portal at ${host}: ${lastErr && lastErr.message}`)
  }

  request(method, pathAndQuery, { body, headers = {}, timeoutMs = 60000 } = {}) {
    const u = new URL(this.base + pathAndQuery)
    const mod = u.protocol === 'https:' ? https : http
    const h = Object.assign({}, headers)
    const cookie = Object.keys(this.cookies).map(k => k + '=' + this.cookies[k]).join('; ')
    if (cookie) h.cookie = cookie
    if (method !== 'GET' && this.cookies['CSRF-Token']) h['x-csrf-token'] = this.cookies['CSRF-Token']
    if (this.auth) h.authorization = this.auth
    if (method !== 'GET') h['content-length'] = body ? body.length : 0
    return new Promise((resolve, reject) => {
      // The phone's certificate is self-signed; it is pinned to nothing else.
      // One connection per request: a stray body after an invalid response (see
      // install) must not corrupt the next response on a reused socket.
      h.connection = 'close'
      const req = mod.request(u, { method, headers: h, rejectUnauthorized: false, timeout: timeoutMs, agent: false }, (res) => {
        for (const c of [].concat(res.headers['set-cookie'] || [])) {
          const m = /^([^=;\s]+)=([^;]*)/.exec(c)
          if (m) this.cookies[m[1]] = m[2]
        }
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
        res.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new Error(`Device Portal timed out: ${method} ${pathAndQuery.split('?')[0]}`)))
      req.on('error', reject)
      if (body && body.length) req.write(body)
      req.end()
    })
  }

  async json(method, p, opts) {
    const r = await this.request(method, p, opts)
    const text = r.body.toString('utf8')
    if (r.status >= 400) throw new Error(`${method} ${p.split('?')[0]} → HTTP ${r.status}: ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : null
  }

  async packages() {
    return (await this.json('GET', '/api/app/packagemanager/packages')).InstalledPackages || []
  }

  async findPackage(filter = 'DSHMobile') {
    const f = String(filter).toLowerCase()
    const list = (await this.packages()).filter(p => (p.PackageFullName + ' ' + p.Name + ' ' + p.PackageFamilyName).toLowerCase().indexOf(f) >= 0)
    if (list.length > 1) throw new Error('several packages match "' + filter + '": ' + list.map(p => p.PackageFullName).join(', '))
    return list[0] || null
  }

  async install(file, { timeoutMs = 600000, onTick } = {}) {
    const name = path.basename(file)
    const { body, type } = multipart(name, fs.readFileSync(file))
    let r = null
    try {
      r = await this.request('POST', '/api/app/packagemanager/package?package=' + encodeURIComponent(name), { body, headers: { 'content-type': type }, timeoutMs: 600000 })
    } catch (e) {
      // The deployment state below tells whether the upload was accepted.
      if (!isParseError(e)) throw e
    }
    if (r && r.status !== 202 && r.status !== 200) throw new Error('install upload → HTTP ' + r.status + ': ' + r.body.toString('utf8').slice(0, 300))
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      await sleep(1500)
      let s
      try {
        s = await this.request('GET', '/api/app/packagemanager/state')
      } catch (e) {
        // While a deployment runs, Windows 10 Mobile answers "204 No Content" with a
        // body, which is invalid HTTP and fails Node's parser: still in progress.
        if (!isParseError(e)) throw e
        if (onTick) onTick()
        continue
      }
      if (s.status === 204) { if (onTick) onTick(); continue }
      const text = s.body.toString('utf8')
      let st
      try { st = JSON.parse(text) } catch (e) { st = { Reason: text } }
      if (s.status === 200 && st.Success !== false && (st.Code === 0 || st.Success === true)) return st
      throw new Error('install failed: ' + String(st.CodeText || '').trim() + ' ' + (st.Reason || '') + (st.Code !== undefined ? ' (code ' + st.Code + ')' : ''))
    }
    throw new Error('install did not finish within ' + Math.round(timeoutMs / 1000) + ' s')
  }

  async launch(pkg) {
    const r = await this.request('POST', `/api/taskmanager/app?appid=${b64(pkg.PackageRelativeId)}&package=${b64(pkg.PackageFullName)}`, { body: Buffer.alloc(0) })
    if (r.status >= 400) throw new Error('launch → HTTP ' + r.status + ': ' + r.body.toString('utf8').slice(0, 200))
  }

  async stop(pkg) {
    const r = await this.request('DELETE', `/api/taskmanager/app?package=${b64(pkg.PackageFullName)}`)
    return r.status < 400
  }

  async uninstall(pkg) {
    const r = await this.request('DELETE', '/api/app/packagemanager/package?package=' + encodeURIComponent(pkg.PackageFullName), { timeoutMs: 120000 })
    if (r.status >= 400) throw new Error('uninstall → HTTP ' + r.status + ': ' + r.body.toString('utf8').slice(0, 200))
  }

  async running(pkg) {
    const list = (await this.json('GET', '/api/resourcemanager/processes')).Processes || []
    return list.filter(p => p.PackageFullName === pkg.PackageFullName)
  }

  _q(pkg, dir) {
    const sub = '\\' + String(dir || '').replace(/\//g, '\\').replace(/^\\+/, '')
    return `knownfolderid=LocalAppData&packagefullname=${encodeURIComponent(pkg.PackageFullName)}&path=${encodeURIComponent(sub)}`
  }

  async listFiles(pkg, dir) {
    const r = await this.request('GET', '/api/filesystem/apps/files?' + this._q(pkg, dir))
    if (r.status >= 400) return null
    const j = JSON.parse(r.body.toString('utf8') || '{}')
    return j.Items ? j.Items.map(i => ({ name: i.Name, dir: i.Type === 16 || i.Type === 8208, size: i.FileSize })) : null
  }

  async getFile(pkg, dir, name) {
    const r = await this.request('GET', '/api/filesystem/apps/file?' + this._q(pkg, dir) + '&filename=' + encodeURIComponent(name))
    if (r.status === 404 || r.status >= 400) return null
    return r.body
  }

  /** Upload into an existing folder of the app's data. Returns {aclWarning} when the device complained afterwards. */
  async putFile(pkg, dir, name, data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
    const { body, type } = multipart(name, buf)
    const r = await this.request('POST', '/api/filesystem/apps/file?' + this._q(pkg, dir), { body, headers: { 'content-type': type } })
    if (r.status < 400) return { aclWarning: false }
    const text = r.body.toString('utf8')
    // Windows 10 Mobile writes the file, then fails to adjust its permissions
    // ("Update file access failed", E_ACCESSDENIED): the file is there.
    if (/Update file access failed/i.test(text)) {
      const hit = ((await this.listFiles(pkg, dir)) || []).filter(i => i.name === name)[0]
      if (hit && hit.size === buf.length) return { aclWarning: true }
    }
    throw new Error('upload → HTTP ' + r.status + ': ' + text.slice(0, 200))
  }

  async deleteFile(pkg, dir, name) {
    const r = await this.request('DELETE', '/api/filesystem/apps/file?' + this._q(pkg, dir) + '&filename=' + encodeURIComponent(name))
    return r.status < 400
  }
}

// ------------------------------------------------------------------ CLI
async function cli(argv) {
  const [device, cmd, ...args] = argv
  if (!device || !cmd) {
    console.log('usage: node scripts/wdp.mjs <device> info|apps|install|launch|stop|uninstall|ls|get|put|rm [args]')
    process.exit(2)
  }
  const wdp = new Wdp(device)
  const os = await wdp.connect()
  const need = async (f) => {
    const p = await wdp.findPackage(f || 'DSHMobile')
    if (!p) throw new Error('package not installed: ' + (f || 'DSHMobile'))
    return p
  }
  const split = (p) => { const s = String(p).replace(/\//g, '\\'); const i = s.lastIndexOf('\\'); return i < 0 ? ['', s] : [s.slice(0, i), s.slice(i + 1)] }
  switch (cmd) {
    case 'info': console.log(JSON.stringify(Object.assign({ portal: wdp.base }, os), null, 1)); break
    case 'apps': for (const p of await wdp.packages()) if (!args[0] || JSON.stringify(p).toLowerCase().indexOf(args[0].toLowerCase()) >= 0) console.log(p.PackageFullName, ' ', p.PackageRelativeId); break
    case 'install': console.log(JSON.stringify(await wdp.install(args[0], { onTick: () => process.stdout.write('.') }))); break
    case 'launch': await wdp.launch(await need(args[0])); console.log('launched'); break
    case 'stop': console.log((await wdp.stop(await need(args[0]))) ? 'stopped' : 'not running'); break
    case 'uninstall': await wdp.uninstall(await need(args[0])); console.log('uninstalled'); break
    case 'ls': for (const e of (await wdp.listFiles(await need(), args[0] || 'LocalState')) || []) console.log(e.dir ? e.name + '\\' : e.name + '  ' + e.size); break
    case 'get': {
      const [dir, name] = split(args[0])
      const data = await wdp.getFile(await need(), dir, name)
      if (!data) throw new Error('not found: ' + args[0])
      if (args[1]) fs.writeFileSync(args[1], data); else process.stdout.write(data)
      break
    }
    case 'put': { const r = await wdp.putFile(await need(), args[1], path.basename(args[0]), fs.readFileSync(args[0])); console.log(r.aclWarning ? 'uploaded (the device could not adjust the file\'s permissions)' : 'uploaded'); break }
    case 'rm': { const [dir, name] = split(args[0]); console.log((await wdp.deleteFile(await need(), dir, name)) ? 'deleted' : 'not found'); break }
    default: throw new Error('unknown command ' + cmd)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).catch((e) => { console.error('error:', e.message); process.exit(1) })
}
