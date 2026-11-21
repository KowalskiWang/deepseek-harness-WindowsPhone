// XMLHttpRequest client with incremental (streamed) response text.
// IE10+/WWAHost expose responseText progressively while readyState is 3,
// which is what Server-Sent Events from the model API need.
import { makeError } from '../core/util.js'

function parseHeaders(raw) {
  const out = {}
  String(raw || '').split(/\r?\n/).forEach((line) => {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  })
  return out
}

export function createXhrHttp() {
  return {
    /**
     * opts: {method, url, headers, body, signal, timeoutMs, idleTimeoutMs,
     *        onText(chunk, status), responseType: 'text'|'arraybuffer'}
     * Resolves {status, headers, text, bytes?}; rejects with code TRANSPORT,
     * TIMEOUT or ABORTED.
     */
    request(opts) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        let seen = 0
        let settled = false
        let idleTimer = null
        let totalTimer = null
        let onAbort = null
        const finish = (err, value) => {
          if (settled) return
          settled = true
          if (idleTimer) clearTimeout(idleTimer)
          if (totalTimer) clearTimeout(totalTimer)
          if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort)
          if (err) reject(err)
          else resolve(value)
        }
        const armIdle = () => {
          if (!opts.idleTimeoutMs) return
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => {
            try { xhr.abort() } catch (e) { /* already closed */ }
            finish(makeError('TIMEOUT', `no data for ${Math.round(opts.idleTimeoutMs / 1000)} s`))
          }, opts.idleTimeoutMs)
        }
        const pump = () => {
          if (!opts.onText || opts.responseType === 'arraybuffer') return
          let text
          try { text = xhr.responseText } catch (e) { return }
          if (text && text.length > seen) {
            const chunk = text.slice(seen)
            seen = text.length
            armIdle()
            opts.onText(chunk, xhr.status)
          }
        }
        try {
          xhr.open(opts.method || 'GET', opts.url, true)
        } catch (e) {
          finish(makeError('TRANSPORT', 'cannot open request: ' + e.message))
          return
        }
        if (opts.responseType === 'arraybuffer') xhr.responseType = 'arraybuffer'
        const headers = opts.headers || {}
        for (const k in headers) {
          if (!Object.prototype.hasOwnProperty.call(headers, k) || headers[k] == null) continue
          if (/^(user-agent|accept-encoding|connection|content-length|host)$/i.test(k)) continue
          try { xhr.setRequestHeader(k, headers[k]) } catch (e) { /* forbidden header */ }
        }
        xhr.onreadystatechange = () => {
          if (xhr.readyState === 2) armIdle()
          if (xhr.readyState === 3) pump()
          if (xhr.readyState === 4) {
            if (xhr.status === 0) {
              if (!settled) finish(makeError('TRANSPORT', 'network request failed (connection refused, DNS or TLS error)'))
              return
            }
            pump()
            const res = { status: xhr.status, headers: parseHeaders(xhr.getAllResponseHeaders()) }
            if (opts.responseType === 'arraybuffer') {
              res.bytes = xhr.response ? new Uint8Array(xhr.response) : new Uint8Array(0)
              res.text = ''
            } else {
              res.text = xhr.responseText || ''
            }
            finish(null, res)
          }
        }
        xhr.onprogress = pump
        xhr.onerror = () => finish(makeError('TRANSPORT', 'network request failed'))
        if (opts.timeoutMs) {
          totalTimer = setTimeout(() => {
            try { xhr.abort() } catch (e) { /* closed */ }
            finish(makeError('TIMEOUT', `request timed out after ${Math.round(opts.timeoutMs / 1000)} s`))
          }, opts.timeoutMs)
        }
        if (opts.signal) {
          if (opts.signal.aborted) { finish(makeError('ABORTED', 'aborted')); return }
          onAbort = () => {
            try { xhr.abort() } catch (e) { /* closed */ }
            finish(makeError('ABORTED', 'aborted'))
          }
          opts.signal.addEventListener('abort', onAbort)
        }
        armIdle()
        try {
          xhr.send(opts.body == null ? null : opts.body)
        } catch (e) {
          finish(makeError('TRANSPORT', 'send failed: ' + e.message))
        }
      })
    },
  }
}
