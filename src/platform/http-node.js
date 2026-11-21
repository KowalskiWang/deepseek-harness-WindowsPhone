// Node.js HTTP client with the same contract as http-xhr.js (tests and tools only;
// never bundled into the phone app).
import http from 'node:http'
import https from 'node:https'
import { StringDecoder } from 'node:string_decoder'
import { makeError } from '../core/util.js'

export function createNodeHttp() {
  return {
    request(opts) {
      return new Promise((resolve, reject) => {
        let u
        try { u = new URL(opts.url) } catch (e) { reject(makeError('TRANSPORT', 'bad URL: ' + opts.url)); return }
        const lib = u.protocol === 'https:' ? https : http
        const headers = Object.assign({}, opts.headers)
        let body = opts.body
        if (body != null && typeof body === 'string') body = Buffer.from(body, 'utf8')
        if (body != null) headers['content-length'] = String(body.length)
        let settled = false
        let idleTimer = null, totalTimer = null, onAbort = null
        const finish = (err, value) => {
          if (settled) return
          settled = true
          clearTimeout(idleTimer); clearTimeout(totalTimer)
          if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort)
          if (err) reject(err); else resolve(value)
        }
        const req = lib.request(u, { method: opts.method || 'GET', headers }, (res) => {
          const decoder = new StringDecoder('utf8')
          const chunks = []
          let text = ''
          const armIdle = () => {
            if (!opts.idleTimeoutMs) return
            clearTimeout(idleTimer)
            idleTimer = setTimeout(() => { req.destroy(); finish(makeError('TIMEOUT', 'stream idle timeout')) }, opts.idleTimeoutMs)
          }
          armIdle()
          res.on('data', (buf) => {
            armIdle()
            if (opts.responseType === 'arraybuffer') { chunks.push(buf); return }
            const s = decoder.write(buf)
            text += s
            if (s && opts.onText) opts.onText(s, res.statusCode)
          })
          res.on('end', () => {
            const lowered = {}
            for (const k in res.headers) lowered[k.toLowerCase()] = Array.isArray(res.headers[k]) ? res.headers[k].join(', ') : res.headers[k]
            if (opts.responseType === 'arraybuffer') {
              const all = Buffer.concat(chunks)
              finish(null, { status: res.statusCode, headers: lowered, text: '', bytes: new Uint8Array(all.buffer, all.byteOffset, all.length) })
            } else {
              const tail = decoder.end()
              if (tail) { text += tail; if (opts.onText) opts.onText(tail, res.statusCode) }
              finish(null, { status: res.statusCode, headers: lowered, text })
            }
          })
          res.on('error', e => finish(makeError('TRANSPORT', e.message)))
        })
        req.on('error', e => finish(makeError('TRANSPORT', e.message)))
        if (opts.timeoutMs) totalTimer = setTimeout(() => { req.destroy(); finish(makeError('TIMEOUT', 'request timeout')) }, opts.timeoutMs)
        if (opts.signal) {
          if (opts.signal.aborted) { req.destroy(); finish(makeError('ABORTED', 'aborted')); return }
          onAbort = () => { req.destroy(); finish(makeError('ABORTED', 'aborted')) }
          opts.signal.addEventListener('abort', onAbort)
        }
        if (body != null) req.write(body)
        req.end()
      })
    },
  }
}
