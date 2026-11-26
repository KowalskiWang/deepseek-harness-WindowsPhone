// DSH Mobile bootstrap: pick the platform (Windows Runtime APPX or browser),
// start the runtime, render the UI. Client errors are reported to the DSH
// gateway (/gateway/client-log) so device problems show up in its log.
import { h, render } from 'preact'
import { Runtime } from './core/runtime.js'
import { ui, back, toast, navigate } from './ui/store.js'
import { readSelfTestRequest, startSelfTest } from './selftest/runner.js'
import { App, applyTheme, onboarding } from './ui/app.jsx'
import { setLanguage } from './ui/i18n.js'

const BUILD = typeof __DSH_BUILD__ !== 'undefined' ? __DSH_BUILD__ : 'dev'
let stage = 'start'

// Boot log at /app/boot.json (LocalState\app\boot.json in the APPX): the stages
// of the last start and any fatal error, readable over Windows Device Portal
// when no gateway is configured to receive reports.
const bootT0 = Date.now()
const bootLog = { build: BUILD, at: new Date().toISOString(), stages: [] }
let bootWrite = Promise.resolve()
function writeBootLog() {
  const text = JSON.stringify(bootLog, null, 1)
  bootWrite = bootWrite.then(function () {
    if (ui.platform && ui.platform.vfs) return ui.platform.vfs.writeText('/app/boot.json', text)
    if (!isWinrt()) return null
    const S = Windows.Storage
    return S.ApplicationData.current.localFolder.createFolderAsync('app', S.CreationCollisionOption.openIfExists)
      .then(function (f) { return f.createFileAsync('boot.json', S.CreationCollisionOption.replaceExisting) })
      .then(function (file) { return S.FileIO.writeTextAsync(file, text) })
  }).then(null, function () { /* diagnostics only */ })
}
function bootNote(name, extra) {
  bootLog.stages.push(name + ' +' + (Date.now() - bootT0) + 'ms')
  if (extra) for (const k in extra) bootLog[k] = extra[k]
  writeBootLog()
}

function isWinrt() {
  try { return typeof Windows !== 'undefined' && !!Windows.Storage && !!Windows.UI.WebUI } catch (e) { return false }
}

function errText(e) {
  if (!e) return 'unknown error'
  if (typeof e === 'string') return e
  return (e.stack || ((e.name ? e.name + ': ' : '') + (e.message || String(e))))
}

/** Best-effort POST of a client error to the gateway that serves this page (or the configured one). */
function report(kind, e) {
  try {
    let base = ''
    if (/^https?:$/.test(location.protocol)) base = location.protocol + '//' + location.host
    else if (ui.rt && ui.rt.settings.get().gateway.url) base = ui.rt.settings.get().gateway.url
    if (!base) return
    const xhr = new XMLHttpRequest()
    xhr.open('POST', base.replace(/\/+$/, '') + '/gateway/client-log', true)
    xhr.setRequestHeader('content-type', 'application/json')
    xhr.send(JSON.stringify({ kind, stage, build: BUILD, ua: navigator.userAgent, message: errText(e).slice(0, 4000), at: new Date().toISOString() }))
  } catch (err) { /* reporting must never throw */ }
}

function fatal(e) {
  report('fatal', e)
  bootLog.fatal = { stage, error: errText(e).slice(0, 2000) }
  writeBootLog()
  const el = document.getElementById('app')
  if (!el) return
  el.textContent = ''
  const pre = document.createElement('pre')
  pre.className = 'fatal'
  pre.textContent = 'DSH failed to start (' + stage + '):\n' + errText(e) + '\n\nbuild ' + BUILD + '\n' + navigator.userAgent
  el.appendChild(pre)
  const btn = document.createElement('button')
  btn.className = 'btn'
  btn.textContent = '重新加载 / Reload'
  btn.onclick = function () { location.reload() }
  el.appendChild(btn)
}

window.onerror = function (msg, src, line, col, err) {
  report('error', err || (msg + ' @' + src + ':' + line + ':' + col))
  if (!ui.rt) fatal(err || msg + ' @' + src + ':' + line + ':' + col)
}
window.onunhandledrejection = function (e) { report('unhandledrejection', e && (e.reason || e)) }
// Event listeners' exceptions are caught and logged with console.error; forward them too.
try {
  if (typeof console !== 'undefined' && console.error) {
    const origError = console.error
    console.error = function () {
      const parts = Array.prototype.slice.call(arguments).map(errText)
      report('console', parts.join(' '))
      try { origError.apply(console, arguments) } catch (e) { /* IE console quirks */ }
    }
  }
} catch (e) { /* no console */ }

// AppCache (web build): a new build pushed to the gateway reaches the phone over
// Wi-Fi by itself. During startup the fresh version is swapped in immediately;
// once the app is running, it checks every minute and offers a reload (a forced
// reload could interrupt a running turn or lose an unsent draft).
let booted = false
let appCache = null
try {
  appCache = window.applicationCache
  if (appCache && appCache.addEventListener) {
    appCache.addEventListener('updateready', function () {
      try { appCache.swapCache() } catch (e) { /* not swappable */ }
      if (!booted) { location.reload(); return }
      report('update-ready', 'new build downloaded')
      toast('新版本已下载 / Update ready', { action: '重新加载 / Reload', onAction: function () { location.reload() }, ms: 120000 })
    })
  } else appCache = null
} catch (e) { appCache = null }

async function boot() {
  stage = 'platform'
  const platform = isWinrt()
    ? await import('./platform/winrt.js').then(m => m.createWinrtPlatform())
    : await import('./platform/web.js').then(m => m.createWebPlatform())
  ui.platform = platform
  bootNote('platform', { hint: platform.hint, device: platform.deviceInfo ? platform.deviceInfo() : undefined, ua: navigator.userAgent })
  stage = 'runtime'
  const rt = new Runtime(platform)
  ui.rt = null
  await rt.init()
  ui.rt = rt
  bootNote('runtime')
  // The web build served by a DSH gateway configures itself to use it.
  if (platform.servedByGateway && !rt.settings.get().gateway.url) {
    rt.settings.update({ gateway: { url: platform.origin } })
    await rt.probeGateway()
  }
  stage = 'render'
  setLanguage(rt.settings.get().general.language)
  applyTheme()
  const splash = document.getElementById('splash')
  if (splash && splash.parentNode) splash.parentNode.removeChild(splash)
  render(h(App, null), document.getElementById('app'))
  platform.onBack(() => back())
  platform.onSuspend(() => rt.flush())
  rt.on('settings', () => applyTheme())
  rt.llm.ensureListing().catch(() => {})
  // A self-test request (pushed over Device Portal, or ?selftest= on the web
  // build) runs before the first-run dialogs, which would cover its page.
  let selfTest = null
  const selfTestDiag = {}
  try { selfTest = await readSelfTestRequest(rt, platform, selfTestDiag) } catch (e) { selfTestDiag.error = errText(e); report('selftest', e) }
  bootNote('rendered', { selftest: selfTestDiag })
  if (selfTest) {
    navigate('selftest')
    startSelfTest(rt, selfTest).promise.then(() => onboarding().catch(e => report('onboarding', e)))
  } else setTimeout(() => onboarding().catch(e => report('onboarding', e)), 200)
  stage = 'running'
  booted = true
  bootNote('running')
  report('started', 'ok')
  rt.on('diagnostic', d => report(d.kind, JSON.stringify(d.data)))
  if (appCache) setInterval(function () { try { appCache.update() } catch (e) { /* offline or no manifest */ } }, 60000)
  window.__dsh = rt // debugging aid in the browser console
}

boot().catch(fatal)
