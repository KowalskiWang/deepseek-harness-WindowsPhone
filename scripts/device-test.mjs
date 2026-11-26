#!/usr/bin/env node
// Install DSH Mobile on a Windows 10 Mobile phone over Wi-Fi and run the
// on-device self-test (src/selftest/runner.js), all through Windows Device
// Portal. Progress comes from the DSH gateway log (--report) and from the
// result file the app keeps in its LocalState folder.
//
//   node scripts/device-test.mjs --device 192.168.1.35 \
//        [--appx dist/package/DSHMobile_0.2.3.0_neutral.appx] \
//        [--report http://<this computer>:8787] [--gateway-code 123456] \
//        [--suites all|offline|env,storage,…] [--key-file api.txt] [--no-keep-key] \
//        [--model deepseek-flash] [--route off|https] [--timeout 2400] [--keep-data]
//        [--deliver pull|file]
//
// The phone needs Developer mode, Device discovery and Device Portal on (see
// docs/INSTALL.md). Start the gateway with --selftest so it collects reports
// and serves the MCP test server. With --key-file, the DeepSeek API key is
// sent to the phone over the Device Portal HTTPS connection and stored in the
// app's credential vault; --no-keep-key removes it after the run.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Wdp } from './wdp.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return def
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

const DEVICE = arg('device')
if (!DEVICE || DEVICE === true) { console.error('usage: node scripts/device-test.mjs --device <phone address> [options]'); process.exit(2) }
const APPX = arg('appx', '')
const REPORT = String(arg('report', '') || '').replace(/\/+$/, '')
const SUITES = String(arg('suites', 'all'))
const MODEL = arg('model', 'deepseek-flash')
const ROUTE = arg('route', 'off')
const TIMEOUT_S = parseInt(arg('timeout', '2400'), 10)
const KEY_FILE = arg('key-file', '')
const KEEP_KEY = process.argv.indexOf('--no-keep-key') < 0
const KEEP_DATA = process.argv.indexOf('--keep-data') >= 0
const GATEWAY_CODE = arg('gateway-code', '')
// pull: the app fetches the request from the gateway (needed on Windows 10 Mobile,
// where files Device Portal writes into the app folder are unreadable by the app);
// file: the request is written into the app folder directly.
const DELIVER = String(arg('deliver', REPORT ? 'pull' : 'file'))
const OFFLINE = ['env', 'storage', 'images', 'sandbox', 'ui']
const MARK = { pass: '✓', fail: '✗', skip: '–' }
const DATA_DIR = 'LocalState\\app'

function line(c) {
  const detail = c.status === 'pass' ? '' : '  ' + String(c.detail || '').replace(/\s+/g, ' ').slice(0, 220)
  return `  ${MARK[c.status] || '?'} ${c.suite} / ${c.name} (${(c.ms / 1000).toFixed(1)} s)${detail}`
}

async function main() {
  const wdp = new Wdp(DEVICE)
  const os = await wdp.connect()
  console.log(`device   : ${os.ComputerName} · ${os.OsEdition} · ${os.OsVersion} (Device Portal ${wdp.base})`)

  if (APPX) {
    process.stdout.write(`install  : ${path.basename(APPX)} `)
    const t0 = Date.now()
    await wdp.install(APPX, { onTick: () => process.stdout.write('.') })
    console.log(` ok (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
  }
  const pkg = await wdp.findPackage('DSHMobile')
  if (!pkg) throw new Error('DSH Mobile is not installed; pass --appx')
  console.log(`package  : ${pkg.PackageFullName}`)
  const want = APPX && /_(\d+\.\d+\.\d+\.\d+)_/.exec(path.basename(APPX))
  if (want && pkg.PackageFullName.indexOf('_' + want[1] + '_') < 0) throw new Error('installed version differs from ' + want[1] + ': the install did not take effect')

  // The data folder exists once the app has run.
  await wdp.stop(pkg)
  if (!(await wdp.listFiles(pkg, DATA_DIR))) {
    console.log('first run: starting the app once to create its data folder')
    await wdp.launch(pkg)
    for (let i = 0; i < 30 && !(await wdp.listFiles(pkg, DATA_DIR)); i++) await sleep(1000)
    await wdp.stop(pkg)
    await sleep(1500)
  }

  const id = 'st-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12) + '-' + crypto.randomBytes(2).toString('hex')
  const request = {
    id, model: MODEL, route: ROUTE, report: REPORT, keepKey: KEEP_KEY, keepData: KEEP_DATA,
    suites: SUITES === 'all' ? null : SUITES === 'offline' ? OFFLINE : SUITES.split(','),
  }
  if (GATEWAY_CODE && GATEWAY_CODE !== true) request.gatewayCode = String(GATEWAY_CODE)
  const key = KEY_FILE ? fs.readFileSync(path.resolve(KEY_FILE), 'utf8').replace(/\s+/g, '') : ''
  if (key && !wdp.secure) throw new Error('refusing to send key material over plain HTTP; Device Portal HTTPS was not reachable')
  await wdp.deleteFile(pkg, DATA_DIR, 'selftest-result.json')
  let pointer = 'selftest-request.json'
  if (DELIVER === 'pull') {
    if (!REPORT) throw new Error('--deliver pull needs --report (the gateway the app fetches the request from)')
    const u = new URL(REPORT)
    // one-time pad: the key crosses the LAN only XOR-ed with it; the pad goes over Device Portal HTTPS
    const pad = crypto.randomBytes(Buffer.byteLength(key))
    if (key) request.apiKeyXor = Buffer.from(Buffer.from(key).map((b, i) => b ^ pad[i])).toString('hex')
    const headers = { 'content-type': 'application/json' }
    if (request.gatewayCode) headers['x-dsh-gateway-code'] = request.gatewayCode
    const r = await fetch(REPORT + '/gateway/selftest-request', { method: 'POST', headers, body: JSON.stringify(request) })
    if (r.status !== 200) throw new Error('the gateway did not accept the self-test request: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200) + ' (is it running with --selftest and the right --gateway-code?)')
    pointer = `selftest-pull_${u.hostname}_${u.port || 80}_${id}_${pad.toString('hex')}`
    await wdp.putFile(pkg, DATA_DIR, pointer, '1')
  } else {
    if (key) request.apiKey = key
    const put = await wdp.putFile(pkg, DATA_DIR, pointer, JSON.stringify(request))
    if (put.aclWarning) console.log('note: Device Portal wrote the request but could not adjust its permissions; the app may not be able to read it (try --deliver pull)')
  }
  console.log(`self-test: ${id} · suites ${SUITES} · model ${MODEL} · route ${ROUTE}${REPORT ? ' · reports → ' + REPORT : ''}${KEY_FILE ? ' · key from ' + path.basename(KEY_FILE) + (KEEP_KEY ? ' (kept in the app)' : ' (removed afterwards)') : ''}`)
  await wdp.launch(pkg)
  console.log('launched; watching progress…')
  // The app deletes the request once it has read it, then reports and saves progress.
  const progress = path.join(root, 'dist/selftest', id + '.jsonl')
  let consumed = false
  for (let i = 0; i < 40 && !consumed; i++) {
    await sleep(1500)
    if (fs.existsSync(progress)) { consumed = true; break }
    const names = ((await wdp.listFiles(pkg, DATA_DIR)) || []).map(e => e.name)
    consumed = names.indexOf(pointer) < 0 || names.indexOf('selftest-result.json') >= 0
  }
  if (!consumed) {
    await wdp.deleteFile(pkg, DATA_DIR, pointer)
    const boot = await wdp.getFile(pkg, DATA_DIR, 'boot.json').catch(() => null)
    throw new Error('the app did not pick up the self-test request within 60 s (removed it again). Boot log: ' + (boot ? boot.toString('utf8').replace(/\s+/g, ' ').slice(0, 1200) : 'none'))
  }
  console.log('the app picked up the request')

  let shownLines = 0
  let shownChecks = 0
  let result = null
  let lastDevicePoll = 0
  let notRunningSince = 0
  const t0 = Date.now()
  while (Date.now() - t0 < TIMEOUT_S * 1000) {
    await sleep(3000)
    // gateway log (per check, live)
    if (fs.existsSync(progress)) {
      const lines = fs.readFileSync(progress, 'utf8').split('\n').filter(Boolean)
      for (const l of lines.slice(shownLines)) {
        try {
          const m = JSON.parse(l)
          if (m.kind === 'check' && m.check) { console.log(line(m.check)); shownChecks++ }
          if (m.kind === 'done' && m.result) result = m.result
        } catch (e) { /* partial line */ }
      }
      shownLines = lines.length
    }
    if (result) break
    // the app's own result file (per suite), and whether the app is still alive
    if (Date.now() - lastDevicePoll > 20000) {
      lastDevicePoll = Date.now()
      const data = await wdp.getFile(pkg, DATA_DIR, 'selftest-result.json').catch(() => null)
      if (data) {
        try {
          const r = JSON.parse(data.toString('utf8'))
          if (r.id === id) {
            if (!fs.existsSync(progress)) for (const c of r.checks.slice(shownChecks)) { console.log(line(c)); shownChecks++ }
            if (r.state === 'done') { result = r; break }
          }
        } catch (e) { /* being written */ }
      }
      const procs = await wdp.running(pkg).catch(() => [{}])
      if (!procs.length) {
        if (!notRunningSince) notRunningSince = Date.now()
        if (Date.now() - notRunningSince > 60000) throw new Error('the app is no longer running (crashed or closed?); last result file: ' + (data ? data.toString('utf8').slice(0, 300) : 'none'))
      } else notRunningSince = 0
    }
  }
  if (!result) throw new Error('no result within ' + TIMEOUT_S + ' s')

  // The request file (or pointer) holds key material: make sure it is gone.
  if (((await wdp.listFiles(pkg, DATA_DIR)) || []).some(e => e.name === pointer)) {
    await wdp.deleteFile(pkg, DATA_DIR, pointer)
    console.log('note: the app had not removed the request; deleted it')
  }

  fs.mkdirSync(path.join(root, 'dist/selftest'), { recursive: true })
  const out = path.join(root, 'dist/selftest', id + '.device.json')
  fs.writeFileSync(out, JSON.stringify(result, null, 1))
  const s = result.summary
  console.log(`\nresult   : ${s.pass} passed, ${s.fail} failed, ${s.skip} skipped in ${Math.round(result.ms / 1000)} s`)
  const env = result.env || {}
  console.log(`device   : ${env.manufacturer || ''} ${env.model || ''} · ${env.deviceFamily || ''} ${env.osVersion || ''} · hint ${env.hint} · build ${result.build}`)
  for (const c of result.checks.filter(x => x.status !== 'pass')) console.log(line(c))
  console.log('saved    : ' + path.relative(root, out))
  process.exit(s.fail ? 1 : 0)
}

main().catch((e) => { console.error('error:', e.message); process.exit(1) })
