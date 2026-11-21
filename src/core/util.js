// Shared helpers for an ES5 engine (IE11 on Windows Phone 8.1): no AbortController,
// TextEncoder, URL or crypto.getRandomValues without the ms prefix.

export function randomBytes(n) {
  const out = new Uint8Array(n)
  const c = (typeof self !== 'undefined' && (self.crypto || self.msCrypto)) || null
  let ok = false
  // IE11 on Windows Phone 8.1 throws "Invalid argument." from msCrypto.getRandomValues
  // for some arrays; ids only need uniqueness, so fall back to Math.random.
  if (c && c.getRandomValues) {
    try { c.getRandomValues(out); ok = true } catch (e) { ok = false }
  }
  if (!ok) for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256) ^ ((Date.now() >> (i % 8)) & 0xff)
  return out
}

export function uuid() {
  const b = randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = []
  for (let i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1))
  return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') + '-' + h.slice(8, 10).join('') + '-' + h.slice(10).join('')
}

export function shortId(n = 10) {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  const b = randomBytes(n)
  let s = ''
  for (let i = 0; i < n; i++) s += alphabet[b[i] % 36]
  return s
}

// ---------------------------------------------------------------- abort

export function createAbort() {
  const listeners = []
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(type, fn) { if (type === 'abort') listeners.push(fn) },
    removeEventListener(type, fn) {
      const i = listeners.indexOf(fn)
      if (i >= 0) listeners.splice(i, 1)
    },
    throwIfAborted() { if (signal.aborted) throw abortError(signal.reason) },
  }
  return {
    signal,
    abort(reason) {
      if (signal.aborted) return
      signal.aborted = true
      signal.reason = reason === undefined ? 'aborted' : reason
      const copy = listeners.slice()
      listeners.length = 0
      for (const fn of copy) { try { fn() } catch (e) { /* listener errors are not the caller's problem */ } }
    },
  }
}

/** Combine signals: the child aborts when any parent aborts. */
export function linkedAbort(...parents) {
  const ctl = createAbort()
  for (const p of parents) {
    if (!p) continue
    if (p.aborted) { ctl.abort(p.reason); break }
    p.addEventListener('abort', () => ctl.abort(p.reason))
  }
  return ctl
}

export function abortError(reason) {
  const e = new Error(typeof reason === 'string' ? `aborted: ${reason}` : 'aborted')
  e.code = 'ABORTED'
  e.reason = reason
  return e
}

export function isAbortError(e) { return !!e && e.code === 'ABORTED' }

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError(signal.reason))
    let onAbort
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    onAbort = () => { clearTimeout(t); reject(abortError(signal.reason)) }
    if (signal) signal.addEventListener('abort', onAbort)
  })
}

/** A promise plus its resolvers (Promise.withResolvers is not available). */
export function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// ---------------------------------------------------------------- events

export class Emitter {
  constructor() { this._l = {} }
  on(type, fn) {
    (this._l[type] || (this._l[type] = [])).push(fn)
    return () => this.off(type, fn)
  }
  off(type, fn) {
    const arr = this._l[type]
    if (!arr) return
    const i = arr.indexOf(fn)
    if (i >= 0) arr.splice(i, 1)
  }
  emit(type, a, b, c) {
    const arr = this._l[type]
    if (!arr) return
    const copy = arr.slice()
    for (let i = 0; i < copy.length; i++) {
      try { copy[i](a, b, c) } catch (e) { if (typeof console !== 'undefined') console.error(e) }
    }
  }
}

// ---------------------------------------------------------------- errors

export function makeError(code, message, extra) {
  const e = new Error(message)
  e.code = code
  if (extra) for (const k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k]
  return e
}

export function errorMessage(e) {
  if (!e) return 'unknown error'
  if (typeof e === 'string') return e
  return e.message || String(e)
}

// ---------------------------------------------------------------- json

export function safeJsonParse(text, fallback) {
  try { return JSON.parse(text) } catch (e) { return fallback }
}

/** Deterministic JSON with sorted keys (repeat-call detection, equality). */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value).sort()
  const parts = []
  for (const k of keys) {
    if (value[k] === undefined) continue
    parts.push(JSON.stringify(k) + ':' + stableStringify(value[k]))
  }
  return '{' + parts.join(',') + '}'
}

export function deepEqualJson(a, b) { return stableStringify(a) === stableStringify(b) }

export function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)) }

// ---------------------------------------------------------------- utf-8

export function utf8Encode(str) {
  const out = []
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++ }
    }
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return new Uint8Array(out)
}

/**
 * Strict UTF-8 decode. Returns null for invalid input (the read tool reports
 * `invalid UTF-8 text`), or the decoded string.
 */
export function utf8DecodeStrict(bytes) {
  let s = ''
  const chunk = []
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i]
    let cp
    if (b < 0x80) { cp = b; i += 1 }
    else if (b >= 0xc2 && b < 0xe0) {
      const b1 = bytes[i + 1]
      if (i + 1 >= bytes.length || (b1 & 0xc0) !== 0x80) return null
      cp = ((b & 0x1f) << 6) | (b1 & 63); i += 2
    } else if (b >= 0xe0 && b < 0xf0) {
      const b1 = bytes[i + 1], b2 = bytes[i + 2]
      if (i + 2 >= bytes.length || (b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) return null
      cp = ((b & 0x0f) << 12) | ((b1 & 63) << 6) | (b2 & 63)
      if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) return null
      i += 3
    } else if (b >= 0xf0 && b < 0xf5) {
      const b1 = bytes[i + 1], b2 = bytes[i + 2], b3 = bytes[i + 3]
      if (i + 3 >= bytes.length || (b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) return null
      cp = ((b & 0x07) << 18) | ((b1 & 63) << 12) | ((b2 & 63) << 6) | (b3 & 63)
      if (cp < 0x10000 || cp > 0x10ffff) return null
      i += 4
    } else return null
    if (cp >= 0x10000) {
      cp -= 0x10000
      chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
    } else chunk.push(cp)
    if (chunk.length > 8000) { s += String.fromCharCode.apply(null, chunk); chunk.length = 0 }
  }
  if (chunk.length) s += String.fromCharCode.apply(null, chunk)
  return s
}

/** Lenient decode (U+FFFD for bad sequences), used for network bodies. */
export function utf8DecodeLenient(bytes) {
  const strict = utf8DecodeStrict(bytes)
  if (strict !== null) return strict
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += bytes[i] < 0x80 ? String.fromCharCode(bytes[i]) : '�'
  return s
}

export function utf8Length(str) {
  let n = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++ }
    else n += 3
  }
  return n
}

/** Cut a string to at most maxBytes of UTF-8 without splitting a character. */
export function truncateUtf8(str, maxBytes) {
  let n = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    const w = c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c <= 0xdbff) ? 4 : 3
    if (n + w > maxBytes) return str.slice(0, i)
    n += w
    if (w === 4) i++
  }
  return str
}

// ---------------------------------------------------------------- base64

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function bytesToBase64(bytes) {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] + '=' : '=='
  }
  return out
}

export function base64ToBytes(b64) {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12)
      | ((clean[i + 2] ? B64.indexOf(clean[i + 2]) : 0) << 6) | (clean[i + 3] ? B64.indexOf(clean[i + 3]) : 0)
    out[o++] = (n >> 16) & 255
    if (clean[i + 2] !== undefined && o < out.length) out[o++] = (n >> 8) & 255
    if (clean[i + 3] !== undefined && o < out.length) out[o++] = n & 255
  }
  return out.subarray(0, o)
}

export function base64UrlEncodeString(str) {
  return bytesToBase64(utf8Encode(str)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ---------------------------------------------------------------- tokens & text

/** Upstream heuristic: ceil(chars/4) + 4 per block. */
export function estimateTokens(text) {
  return Math.ceil((text ? text.length : 0) / 4) + 4
}

export function estimateBlocksTokens(blocks) {
  let n = 0
  for (const b of blocks || []) {
    if (!b) continue
    if (b.type === 'image') n += 1024
    else if (b.type === 'tool-call') n += estimateTokens(b.name + (b.arguments || ''))
    else n += estimateTokens(b.text || '')
  }
  return n
}

export function clip(text, max, suffix = '…') {
  if (!text) return ''
  return text.length > max ? text.slice(0, Math.max(0, max - suffix.length)) + suffix : text
}

export function collapseWhitespace(s) { return String(s || '').replace(/\s+/g, ' ').trim() }

export function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function pad2(n) { return n < 10 ? '0' + n : String(n) }

/** Upstream formatDuration: "1h 2m 3s" style. */
export function formatDuration(ms) {
  if (!(ms >= 0)) return 'unavailable'
  let s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60); s -= m * 60
  const parts = []
  if (h) parts.push(h + 'h')
  if (m) parts.push(m + 'm')
  parts.push(s + 's')
  return parts.join(' ')
}

export function formatClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm' + pad2(s % 60) + 's'
  return Math.floor(m / 60) + 'h' + pad2(m % 60) + 'm'
}

/** Local ISO-8601 timestamp with offset, e.g. 2026-11-22T10:00:00+08:00. */
export function localIsoWithOffset(date) {
  const d = date || new Date()
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
    + sign + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60)
}

export function deviceTimeZone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (tz) return tz
  } catch (e) { /* IE11 */ }
  const off = -new Date().getTimezoneOffset()
  if (off === 0) return 'UTC'
  // IANA Etc zones reverse the sign.
  const hours = off / 60
  return Number.isInteger(hours) ? 'Etc/GMT' + (hours > 0 ? '-' : '+') + Math.abs(hours) : 'UTC' + (off > 0 ? '+' : '-') + pad2(Math.floor(Math.abs(off) / 60)) + ':' + pad2(Math.abs(off) % 60)
}

/** Parse "Retry-After" (seconds or HTTP date) to milliseconds. */
export function parseRetryAfter(value) {
  if (!value) return undefined
  const n = Number(value)
  if (!Number.isNaN(n) && n >= 0) return n * 1000
  const t = Date.parse(value)
  if (!Number.isNaN(t)) return Math.max(0, t - Date.now())
  return undefined
}

/** Minimal URL parser (IE11 has no URL constructor). */
export function parseUrl(url) {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(String(url || '').trim())
  if (!m) return null
  const authority = m[2]
  const at = authority.lastIndexOf('@')
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority
  let host = hostPort, port = ''
  const pm = /^(\[[^\]]+\]|[^:]*)(?::(\d+))?$/.exec(hostPort)
  if (pm) { host = pm[1]; port = pm[2] || '' }
  const protocol = m[1].toLowerCase()
  return {
    protocol,
    host: host.toLowerCase(),
    port,
    origin: protocol + '://' + host.toLowerCase() + (port ? ':' + port : ''),
    pathname: m[3] || '/',
    search: m[4] || '',
    hash: m[5] || '',
  }
}

export function joinUrl(base, path) {
  if (!base) return path
  return base.replace(/\/+$/, '') + '/' + String(path).replace(/^\/+/, '')
}

export function throttle(fn, ms) {
  let last = 0, timer = null, pendingArgs = null
  return function (...args) {
    pendingArgs = args
    const now = Date.now()
    const run = () => { last = Date.now(); timer = null; const a = pendingArgs; pendingArgs = null; fn.apply(null, a) }
    if (now - last >= ms) { if (timer) { clearTimeout(timer); timer = null } run() }
    else if (!timer) timer = setTimeout(run, ms - (now - last))
  }
}

export function debounce(fn, ms) {
  let timer = null
  const wrapped = function (...args) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; fn.apply(null, args) }, ms)
  }
  wrapped.flush = () => { if (timer) { clearTimeout(timer); timer = null; fn() } }
  return wrapped
}

/** Run async tasks with a concurrency limit, preserving result order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  const workers = []
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker())
  await Promise.all(workers)
  return results
}

export function nowMs() { return Date.now() }
