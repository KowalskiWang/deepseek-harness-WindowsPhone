#!/usr/bin/env node
// DSH gateway — runs on a computer in the same Wi-Fi as the phone.
//
// Windows Phone 8.1's TLS stack (Windows 8.1 schannel) cannot negotiate the
// ECDHE-RSA-AES-GCM cipher suites that api.deepseek.com and most modern sites
// require. The gateway:
//   • serves the DSH Mobile web build (open http://<this-computer>:8787 in IE on the phone)
//   • relays HTTPS for the app:  /x/<base64url(origin)>/<path>  →  https://origin/path
//   • optionally injects the DeepSeek API key (--key-file) so the key never
//     travels over Wi-Fi; clients then authenticate with a short access code
//   • serves the signed APPX + certificate under /download/
//   • with --selftest: collects on-device self-test reports (POST /gateway/selftest
//     → dist/selftest/<id>.json) and serves a tiny MCP test server (/gateway/mcp-test)
//   • with --dsh: runs the desktop DeepSeek Harness (`dsh --profile acp`) and lets
//     the phone drive it (/gateway/dsh/…, see dsh-bridge.mjs): an agent that works
//     on this computer, with approvals answered on the phone
//
// Usage:
//   node gateway/server.mjs [--port 8787] [--key-file ../api.txt] [--code 123456]
//                           [--proxy http://127.0.0.1:1082] [--host 0.0.0.0]
//                           [--selftest [dir]]
//                           [--dsh <dsh or node> [--dsh-arg <bin.js>]… [--dsh-root <dir>]… [--dsh-home <dir>]]
// No dependencies; Node 18+.
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import dns from 'node:dns'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createDshBridge } from './dsh-bridge.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const VERSION = '0.2.3'

// ---------------------------------------------------------------- options
function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return def
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}
function argAll(name) {
  const out = []
  for (let i = 0; i < process.argv.length - 1; i++) if (process.argv[i] === '--' + name) out.push(process.argv[i + 1])
  return out
}
const PORT = parseInt(arg('port', process.env.DSH_GATEWAY_PORT || '8787'), 10)
const HOST = arg('host', '0.0.0.0')
const KEY_FILE = arg('key-file', process.env.DSH_GATEWAY_KEY_FILE || '')
const PROXY = arg('proxy', process.env.DSH_GATEWAY_PROXY || '')
const STATIC_DIR = path.resolve(arg('static', path.join(root, 'dist/web')))
const DOWNLOAD_DIR = path.resolve(arg('downloads', path.join(root, 'dist/package')))
const DEEPSEEK_HOST = 'api.deepseek.com'
const DSH = arg('dsh', '')
const SELFTEST = arg('selftest', '')
const SELFTEST_DIR = SELFTEST ? path.resolve(SELFTEST === true ? path.join(root, 'dist/selftest') : SELFTEST) : ''

let apiKey = ''
if (KEY_FILE) {
  apiKey = fs.readFileSync(path.resolve(KEY_FILE), 'utf8').replace(/\s+/g, '')
  if (!/^sk-[A-Za-z0-9]{16,}$/.test(apiKey)) { console.error('key file does not contain an sk-… key'); process.exit(1) }
}
// Key injection must be protected: generate an access code unless one is given.
let CODE = arg('code', process.env.DSH_GATEWAY_CODE || '')
if (CODE === true) CODE = ''
if (apiKey && !CODE) CODE = String(crypto.randomInt(100000, 1000000))

const mask = s => (s && s.length > 12 ? s.slice(0, 5) + '…' + s.slice(-4) : '***')

// Desktop dsh, driven from the phone (needs the access code like key injection).
let dsh = null
if (DSH) {
  if (!CODE) { console.error('--dsh lets the phone run an agent on this computer: set an access code with --code (or use --key-file)'); process.exit(1) }
  const env = {}
  if (apiKey) env.DEEPSEEK_API_KEY = apiKey
  const home = arg('dsh-home', '')
  if (home && home !== true) env.DSH_HOME = path.resolve(home)
  const roots = argAll('dsh-root')
  dsh = createDshBridge({ exe: DSH === true ? 'dsh' : DSH, args: argAll('dsh-arg'), env, roots: roots.length ? roots : [os.homedir()], version: VERSION })
}

// ---------------------------------------------------------------- SSRF guard
function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  const v = ip.toLowerCase()
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.')
}

function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return cb(err)
    const list = Array.isArray(address) ? address : [{ address, family }]
    for (const a of list) if (privateAddress(a.address)) return cb(new Error(`refusing to relay to private address ${a.address}`))
    cb(null, address, family)
  })
}

// ---------------------------------------------------------------- upstream (optional HTTP proxy)
function connectViaProxy(target, port) {
  return new Promise((resolve, reject) => {
    const p = new URL(PROXY)
    const req = http.request({ host: p.hostname, port: p.port || 80, method: 'CONNECT', path: `${target}:${port}`, headers: { host: `${target}:${port}` } })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error('proxy CONNECT failed: ' + res.statusCode)); return }
      resolve(socket)
    })
    req.on('error', reject)
    req.end()
  })
}

async function upstreamRequest(url, opts) {
  const u = new URL(url)
  const options = { method: opts.method, headers: opts.headers, servername: u.hostname, lookup: safeLookup, timeout: 330000 }
  if (PROXY) {
    const raw = await connectViaProxy(u.hostname, u.port || 443)
    options.createConnection = () => tls.connect({ socket: raw, servername: u.hostname })
    delete options.lookup
  }
  return new Promise((resolve, reject) => {
    const req = https.request(u, options, resolve)
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('upstream timeout')))
    if (opts.body && opts.body.length) req.write(opts.body)
    req.end()
  })
}

// ---------------------------------------------------------------- helpers
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length'])
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.xml': 'application/xml', '.appcache': 'text/cache-manifest', '.appx': 'application/appx', '.appxbundle': 'application/appxbundle', '.cer': 'application/x-x509-ca-cert', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' }

function b64urlDecode(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

function cors(res) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', '*')
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader('access-control-expose-headers', '*')
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let n = 0
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('request body too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// Wrong access codes: 10 within a minute block that address for 10 minutes, so
// a 6-digit code cannot be guessed by brute force.
const codeFailures = new Map() // ip → {n, first, blockedUntil}
function codeBlocked(req) {
  const f = codeFailures.get(req.socket.remoteAddress || '')
  return !!(f && f.blockedUntil > Date.now())
}
function codeOk(req) {
  if (!CODE) return true
  if (codeBlocked(req)) return false
  const given = Buffer.from(String(req.headers['x-dsh-gateway-code'] || ''))
  const want = Buffer.from(CODE)
  const ok = given.length === want.length && crypto.timingSafeEqual(given, want)
  if (!ok && given.length) {
    const ip = req.socket.remoteAddress || ''
    const now = Date.now()
    const prev = codeFailures.get(ip)
    const f = prev && now - prev.first < 60000 ? prev : { n: 0, first: now, blockedUntil: 0 }
    f.n++
    if (f.n >= 10 && !f.blockedUntil) { f.blockedUntil = now + 10 * 60000; console.log(`blocked ${ip} for 10 minutes after ${f.n} wrong access codes`) }
    codeFailures.set(ip, f)
  }
  return ok
}
/** Answer a request whose access code was wrong (or whose address is blocked). */
function denyCode(req, res) {
  return codeBlocked(req)
    ? send(res, 429, { error: 'too many wrong access codes; try again later', code: 'GATEWAY_BLOCKED' })
    : send(res, 401, { error: 'gateway access code required', code: 'GATEWAY_CODE' })
}

// ---------------------------------------------------------------- relay
async function relay(req, res, encodedOrigin, rest) {
  let origin
  try { origin = new URL(b64urlDecode(encodedOrigin)) } catch (e) { return send(res, 400, { error: 'bad origin' }) }
  if (origin.protocol !== 'https:' || origin.pathname !== '/' && origin.pathname !== '') return send(res, 400, { error: 'only https origins are relayed' })
  if (/^(localhost|.*\.local|.*\.localhost)$/i.test(origin.hostname) || (net.isIP(origin.hostname) && privateAddress(origin.hostname))) return send(res, 403, { error: 'private destinations are not relayed' })
  if (!codeOk(req)) return denyCode(req, res)

  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase()
    if (HOP.has(key) || key === 'origin' || key === 'referer' || key === 'x-dsh-gateway-code' || key === 'accept-encoding' || key === 'cookie') continue
    headers[key] = v
  }
  headers['accept-encoding'] = 'identity'
  if (!headers['user-agent']) headers['user-agent'] = 'Mozilla/5.0 (Windows Phone 8.1; DSH Mobile) dsh-gateway/' + VERSION
  if (apiKey && origin.hostname === DEEPSEEK_HOST && !headers['x-api-key'] && !headers.authorization) {
    headers['x-api-key'] = apiKey
    headers.authorization = 'Bearer ' + apiKey
  }
  const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readBody(req)
  let url = origin.origin + rest
  let upstream
  // Follow redirects here: the phone cannot follow them to modern HTTPS hosts itself.
  for (let hop = 0; hop < 6; hop++) {
    upstream = await upstreamRequest(url, { method: req.method, headers, body })
    const loc = upstream.headers.location
    if (![301, 302, 303, 307, 308].includes(upstream.statusCode) || !loc || hop === 5 || (body && upstream.statusCode !== 303)) break
    upstream.resume()
    const next = new URL(loc, url)
    if (next.protocol !== 'https:' && next.protocol !== 'http:') break
    if (next.hostname !== new URL(url).hostname) { delete headers['x-api-key']; delete headers.authorization }
    url = next.toString()
  }
  const out = {}
  for (const [k, v] of Object.entries(upstream.headers)) if (!HOP.has(k.toLowerCase()) && k.toLowerCase() !== 'set-cookie') out[k] = v
  out['x-dsh-final-url'] = url
  out['cache-control'] = out['cache-control'] || 'no-store'
  out['x-accel-buffering'] = 'no'
  res.writeHead(upstream.statusCode, out)
  if (res.socket) res.socket.setNoDelay(true)
  upstream.on('data', c => res.write(c))
  upstream.on('end', () => res.end())
  upstream.on('error', () => res.destroy())
  req.on('close', () => upstream.destroy())
  return upstream.statusCode
}

// ---------------------------------------------------------------- self-test reports & MCP test server
const MARK = { pass: '✓', fail: '✗', skip: '–' }

async function selftestReport(req, res) {
  const body = await readBody(req, 4 * 1024 * 1024)
  let r
  try { r = JSON.parse(body.toString('utf8')) } catch (e) { return send(res, 400, { error: 'bad json' }) }
  const id = String(r.id || '')
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return send(res, 400, { error: 'bad id' })
  fs.mkdirSync(SELFTEST_DIR, { recursive: true })
  const log = path.join(SELFTEST_DIR, id + '.jsonl')
  let size = 0
  try { size = fs.statSync(log).size } catch (e) { size = 0 }
  if (size < 20 * 1024 * 1024) fs.appendFileSync(log, JSON.stringify(Object.assign({ from: req.socket.remoteAddress }, r)) + '\n')
  const clean = s => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  if (r.kind === 'start') console.log(`SELFTEST ${id} started on ${req.socket.remoteAddress}: ${clean(r.env && (r.env.model || r.env.ua)).slice(0, 160)}`)
  else if (r.kind === 'check' && r.check) {
    const c = r.check
    console.log(`SELFTEST ${id} ${MARK[c.status] || '?'} ${clean(c.suite)} / ${clean(c.name)} (${c.ms} ms)${c.status === 'pass' ? '' : '  ' + clean(c.detail).slice(0, 300)}`)
  } else if (r.kind === 'done' && r.result) {
    fs.writeFileSync(path.join(SELFTEST_DIR, id + '.json'), JSON.stringify(r.result, null, 1))
    const sm = r.result.summary || {}
    console.log(`SELFTEST ${id} finished: ${sm.pass} passed, ${sm.fail} failed, ${sm.skip} skipped in ${Math.round((r.result.ms || 0) / 1000)} s`)
  }
  res.writeHead(204, { 'cache-control': 'no-store' })
  res.end()
}

// Self-test requests handed to a phone that cannot read files pushed into its
// app folder: scripts/device-test.mjs registers one (access code required),
// the app fetches it once by id. Its API key is XOR-ed with a one-time pad
// that only reaches the phone through Device Portal (HTTPS).
const selftestRequests = new Map()

async function selftestRequestPut(req, res) {
  if (!codeOk(req)) return denyCode(req, res)
  const body = await readBody(req, 64 * 1024)
  let r
  try { r = JSON.parse(body.toString('utf8')) } catch (e) { return send(res, 400, { error: 'bad json' }) }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(r.id || ''))) return send(res, 400, { error: 'bad id' })
  if (r.apiKey) return send(res, 400, { error: 'send apiKeyXor, never a plain key' })
  selftestRequests.set(r.id, { request: r, at: Date.now() })
  return send(res, 200, { ok: true })
}

function selftestRequestGet(req, res, id) {
  const e = selftestRequests.get(id)
  selftestRequests.delete(id) // served once
  if (!e || Date.now() - e.at > 15 * 60 * 1000) return send(res, 404, { error: 'no such self-test request' })
  console.log(`SELFTEST ${id} request fetched by ${req.socket.remoteAddress}`)
  return send(res, 200, e.request)
}

async function dshRoute(req, res, sub) {
  if (!codeOk(req)) return denyCode(req, res)
  const q = new URL(req.url, 'http://x').searchParams
  const body = async () => { try { return JSON.parse((await readBody(req, 8 * 1024 * 1024)).toString('utf8') || '{}') } catch (e) { return null } }
  try {
    if (sub === 'info' && req.method === 'GET') return send(res, 200, await dsh.info())
    if (sub === 'ls' && req.method === 'GET') return send(res, 200, await dsh.ls(q.get('path') || ''))
    if (sub === 'events' && req.method === 'GET') return send(res, 200, await dsh.events(parseInt(q.get('after') || '0', 10) || 0, Math.min(30000, parseInt(q.get('wait') || '25000', 10) || 0)))
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
    const b = await body()
    if (!b) return send(res, 400, { error: 'bad json' })
    if (sub === 'call') return send(res, 200, await dsh.call(b.method, b.params || {}, { async: !!b.async }))
    if (sub === 'notify') return send(res, 200, await dsh.notify(b.method, b.params || {}))
    if (sub === 'respond') return send(res, 200, await dsh.respond(b.id, b.result))
    return send(res, 404, { error: 'not found' })
  } catch (e) {
    return send(res, e.status || 502, { error: e.message, rpc: e.rpc })
  }
}

const MCP_TOOLS = [
  { name: 'add', description: 'Add two numbers and return the sum.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  { name: 'echo', description: 'Return the given text unchanged.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
]

/** Minimal Streamable-HTTP MCP server (JSON responses) for the self-test. */
async function mcpTest(req, res) {
  const body = await readBody(req, 256 * 1024)
  let m
  try { m = JSON.parse(body.toString('utf8')) } catch (e) { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) }
  if (m.id === undefined || m.id === null) { res.writeHead(202); res.end(); return } // notification
  const reply = result => send(res, 200, { jsonrpc: '2.0', id: m.id, result })
  const fail = (code, message) => send(res, 200, { jsonrpc: '2.0', id: m.id, error: { code, message } })
  const p = m.params || {}
  switch (m.method) {
    case 'initialize':
      res.setHeader('mcp-session-id', crypto.randomUUID())
      return reply({ protocolVersion: p.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'dsh-selftest', version: VERSION }, instructions: 'Test server for the DSH Mobile self-test. The add tool adds two numbers.' })
    case 'ping': return reply({})
    case 'tools/list': return reply({ tools: MCP_TOOLS })
    case 'tools/call': {
      const a = p.arguments || {}
      if (p.name === 'add') return reply({ content: [{ type: 'text', text: String(Number(a.a) + Number(a.b)) }] })
      if (p.name === 'echo') return reply({ content: [{ type: 'text', text: String(a.text) }] })
      return reply({ content: [{ type: 'text', text: 'unknown tool ' + p.name }], isError: true })
    }
    default: return fail(-32601, 'method not found: ' + m.method)
  }
}

// ---------------------------------------------------------------- static
function serveFile(res, file, cacheable) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found', 'text/plain')
    const ext = path.extname(file).toLowerCase()
    res.writeHead(200, {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': cacheable ? 'max-age=60' : 'no-cache',
      'x-content-type-options': 'nosniff',
    })
    fs.createReadStream(file).pipe(res)
  })
}

function safeJoin(dir, p) {
  const decoded = decodeURIComponent(p.split('?')[0])
  const full = path.resolve(dir, '.' + path.posix.normalize('/' + decoded))
  if (!full.startsWith(dir)) return null
  if (path.basename(full).startsWith('._') || path.basename(full) === '.DS_Store') return null
  return full
}

function downloadsPage() {
  let files = []
  try { files = fs.readdirSync(DOWNLOAD_DIR).filter(f => !f.startsWith('._') && !f.startsWith('.')) } catch (e) { files = [] }
  const li = files.map(f => `<li><a href="/download/${encodeURIComponent(f)}">${f}</a> (${(fs.statSync(path.join(DOWNLOAD_DIR, f)).size / 1024).toFixed(0)} KB)</li>`).join('')
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>DSH downloads</title>
<style>body{font-family:Segoe WP,Segoe UI,sans-serif;background:#000;color:#fff;padding:16px}a{color:#7b93ff}li{margin:8px 0}</style></head>
<body><h2>DSH Mobile</h2><ul>${li || '<li>no packages built yet (npm run package:appx)</li>'}</ul>
<p>Windows Phone 8.1 cannot install .appx from the browser: deploy it from a Windows PC with the Windows Phone 8.1 SDK (see INSTALL.md). On this phone you can use the web build right now: <a href="/">open DSH</a>, then pin it to Start.</p></body></html>`
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const t0 = Date.now()
  const urlPath = req.url || '/'
  let status = 0
  try {
    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return }
    if (urlPath === '/gateway/info') {
      cors(res)
      status = 200
      const accepted = codeOk(req)
      return send(res, 200, { name: 'dsh-gateway', version: VERSION, injectsKey: !!apiKey && accepted, codeRequired: !!CODE, codeAccepted: accepted, upstream: 'https://' + DEEPSEEK_HOST })
    }
    if (urlPath === '/gateway/client-log' && req.method === 'POST') {
      // Error reports from DSH Mobile clients, printed so device problems show up here.
      cors(res)
      status = 204
      const body = await readBody(req, 16 * 1024).catch(() => Buffer.from('{}'))
      let r = {}
      try { r = JSON.parse(body.toString('utf8')) } catch (e) { r = { message: body.toString('utf8').slice(0, 500) } }
      const clean = s => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 4000)
      console.log(`CLIENT ${req.socket.remoteAddress} [${clean(r.kind)}] stage=${clean(r.stage)} build=${clean(r.build)}\n  ua: ${clean(r.ua)}\n  ${clean(r.message).replace(/\n/g, '\n  ')}`)
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    const dm = /^\/gateway\/dsh\/([a-z]+)(\?.*)?$/.exec(urlPath)
    if (dsh && dm) { cors(res); status = 200; return await dshRoute(req, res, dm[1]) }
    if (SELFTEST_DIR && urlPath === '/gateway/selftest' && req.method === 'POST') { cors(res); status = 204; return await selftestReport(req, res) }
    if (SELFTEST_DIR && urlPath === '/gateway/mcp-test' && req.method === 'POST') { cors(res); status = 200; return await mcpTest(req, res) }
    if (SELFTEST_DIR && urlPath === '/gateway/selftest-request' && req.method === 'POST') { status = 200; return await selftestRequestPut(req, res) }
    const sr = /^\/gateway\/selftest-request\/([A-Za-z0-9_-]{1,64})$/.exec(urlPath)
    if (SELFTEST_DIR && sr && req.method === 'GET') { cors(res); status = 200; return selftestRequestGet(req, res, sr[1]) }
    const m = /^\/x\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(urlPath)
    if (m) { cors(res); status = await relay(req, res, m[1], m[2] || '/'); return }
    if (urlPath === '/download' || urlPath === '/download/') { status = 200; return send(res, 200, downloadsPage(), 'text/html; charset=utf-8') }
    if (urlPath.startsWith('/download/')) {
      const f = safeJoin(DOWNLOAD_DIR, urlPath.slice('/download'.length))
      status = f ? 200 : 404
      return f ? serveFile(res, f, false) : send(res, 404, 'not found', 'text/plain')
    }
    const pathOnly = urlPath.split('?')[0]
    const p = pathOnly === '/' ? '/index.html' : pathOnly
    const f = safeJoin(STATIC_DIR, p)
    status = f ? 200 : 404
    if (!f) return send(res, 404, 'not found', 'text/plain')
    return serveFile(res, f, !/\.(html|appcache)$/.test(f))
  } catch (e) {
    status = 502
    if (!res.headersSent) send(res, 502, { error: { type: 'api_error', message: 'gateway: ' + e.message }, code: 'GATEWAY_UPSTREAM' })
    else res.destroy()
  } finally {
    const shown = urlPath.replace(/^\/x\/([A-Za-z0-9_-]+)/, (all, o) => { try { return '/x/' + b64urlDecode(o) } catch (e) { return all } })
    if (!/^\/(css|js|img)\//.test(urlPath) && urlPath !== '/gateway/selftest' && !urlPath.startsWith('/gateway/dsh/events')) console.log(`${new Date().toISOString().slice(11, 19)} ${req.socket.remoteAddress} ${req.method} ${shown.slice(0, 120)} → ${status || res.statusCode} ${Date.now() - t0}ms`)
  }
})

server.listen(PORT, HOST, () => {
  const addrs = []
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) addrs.push(a.address)
  console.log('DSH gateway', VERSION)
  console.log('  web build  :', STATIC_DIR)
  for (const a of addrs) console.log(`  open on the phone (same Wi-Fi):  http://${a}:${PORT}/`)
  console.log('  API key    :', apiKey ? `injected from ${KEY_FILE} (${mask(apiKey)})` : 'not injected (the app sends its own key)')
  console.log('  access code:', CODE || '(none)')
  if (PROXY) console.log('  upstream via proxy', PROXY)
  if (dsh) console.log('  desktop dsh: ' + (DSH === true ? 'dsh' : DSH) + ' ' + argAll('dsh-arg').join(' ') + ' --profile acp (started on first use)')
  if (SELFTEST_DIR) console.log('  self-test  : reports → ' + SELFTEST_DIR + ', MCP test server at /gateway/mcp-test')
})
