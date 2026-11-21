// Browser platform: the LAN web build opened in IE11 on Windows Phone 8.1 (or
// any browser). Storage is IndexedDB; the gateway that serves the page also
// relays HTTPS, so the page is same-origin with every request it makes.
import { Vfs, MemoryBackend } from '../core/vfs.js'
import { openDb, IdbBackend } from './idb.js'
import { createXhrHttp } from './http-xhr.js'
import { createWorkerRunner } from '../core/tools/code-tool.js'
import { createImageTools, sniffMime, domClipboardCopy, uaHint } from './dom-common.js'

const CRED_PREFIX = 'dsh.cred.'

function ls() { try { return window.localStorage } catch (e) { return null } }

export async function createWebPlatform() {
  const vfs = new Vfs()
  let persistent = true
  try {
    const db = await openDb()
    vfs.mount('/app', new IdbBackend(db, 'app'), { hidden: true })
    vfs.mount('/workspaces', new IdbBackend(db, 'ws'))
    vfs.mount('/tmp', new IdbBackend(db, 'tmp'))
  } catch (e) {
    persistent = false
    vfs.mount('/app', new MemoryBackend(), { hidden: true })
    vfs.mount('/workspaces', new MemoryBackend())
    vfs.mount('/tmp', new MemoryBackend())
  }
  const origin = location.protocol + '//' + location.host
  const http = createXhrHttp()
  let servedByGateway = false
  if (/^https?:$/.test(location.protocol)) {
    try {
      const res = await http.request({ method: 'GET', url: origin + '/gateway/info', timeoutMs: 4000 })
      servedByGateway = res.status === 200 && /dsh-gateway/.test(res.text)
    } catch (e) { servedByGateway = false }
  }

  const backHandlers = []
  let depth = 0
  window.addEventListener('popstate', () => {
    depth = Math.max(0, depth - 1)
    for (const fn of backHandlers) if (fn()) { try { history.pushState({ dsh: ++depth }, '') } catch (e) { /* old browser */ } return }
  })

  return {
    kind: 'web',
    hint: uaHint(),
    persistent,
    origin,
    servedByGateway,
    vfs,
    http,
    credentials: {
      async get(id) { const s = ls(); return s ? s.getItem(CRED_PREFIX + id) || undefined : undefined },
      async set(id, v) { const s = ls(); if (s) s.setItem(CRED_PREFIX + id, v) },
      async remove(id) { const s = ls(); if (s) s.removeItem(CRED_PREFIX + id) },
      async list() {
        const s = ls(); const out = []
        if (!s) return out
        for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k && k.indexOf(CRED_PREFIX) === 0) out.push(k.slice(CRED_PREFIX.length)) }
        return out
      },
    },
    codeRunner: typeof Worker !== 'undefined' ? createWorkerRunner(() => new Worker('js/sandbox-worker.js')) : null,
    images: createImageTools(),
    pickImages() {
      return new Promise((resolve, reject) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'image/*'
        input.multiple = true
        input.style.position = 'fixed'; input.style.left = '-1000px'
        document.body.appendChild(input)
        input.onchange = () => {
          const files = Array.prototype.slice.call(input.files || [])
          document.body.removeChild(input)
          Promise.all(files.map(f => new Promise((res) => {
            const r = new FileReader()
            r.onload = () => {
              const bytes = new Uint8Array(r.result)
              createImageTools().prepare(bytes, sniffMime(f.name, bytes)).then(img => res(Object.assign({ name: f.name }, img)))
            }
            r.onerror = () => res(null)
            r.readAsArrayBuffer(f)
          }))).then(list => resolve(list.filter(Boolean)), reject)
        }
        input.click()
      })
    },
    pickFolder: null,
    openExternal(url) { window.open(url, '_blank') },
    clipboard: { copy: text => domClipboardCopy(text) },
    saveFile(name, text, mime) {
      const blob = new Blob([text], { type: mime || 'text/plain' })
      if (navigator.msSaveOrOpenBlob) {
        try { navigator.msSaveOrOpenBlob(blob, name); return Promise.resolve(name) } catch (e) { return Promise.resolve(null) }
      }
      const a = document.createElement('a')
      // IE Mobile has neither msSaveOrOpenBlob nor <a download>: let the caller save into the workspace
      if (!('download' in a) || typeof URL === 'undefined' || !URL.createObjectURL) return Promise.resolve(null)
      a.href = URL.createObjectURL(blob)
      a.download = name
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      return Promise.resolve(name)
    },
    notify() { /* the browser build shows in-app toasts only */ },
    onBack(fn) {
      backHandlers.push(fn)
      try { history.replaceState({ dsh: 0 }, ''); history.pushState({ dsh: ++depth }, '') } catch (e) { /* old browser */ }
    },
    onNavigate() { /* history entries are re-armed on popstate */ },
    onSuspend(fn) {
      window.addEventListener('pagehide', fn)
      window.addEventListener('beforeunload', fn)
      document.addEventListener('visibilitychange', () => { if (document.hidden) fn() })
    },
    setStatusBar() {},
  }
}
