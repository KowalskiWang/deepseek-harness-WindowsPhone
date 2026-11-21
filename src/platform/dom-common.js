// DOM helpers shared by the browser and Windows Runtime builds.
import { bytesToBase64, base64ToBytes } from '../core/util.js'

const MAX_DIM = 2048
const MAX_BYTES = 2 * 1024 * 1024

function readDims(bytes, mime) {
  try {
    if (mime === 'image/png' && bytes.length > 24) return { w: (bytes[16] << 24 | bytes[17] << 16 | bytes[18] << 8 | bytes[19]) >>> 0, h: (bytes[20] << 24 | bytes[21] << 16 | bytes[22] << 8 | bytes[23]) >>> 0 }
    if (mime === 'image/gif') return { w: bytes[6] | bytes[7] << 8, h: bytes[8] | bytes[9] << 8 }
    if (mime === 'image/jpeg') {
      let i = 2
      while (i < bytes.length) {
        if (bytes[i] !== 0xff) { i++; continue }
        const marker = bytes[i + 1]
        const len = bytes[i + 2] << 8 | bytes[i + 3]
        if (marker >= 0xc0 && marker <= 0xc3) return { h: bytes[i + 5] << 8 | bytes[i + 6], w: bytes[i + 7] << 8 | bytes[i + 8] }
        i += 2 + len
      }
    }
  } catch (e) { /* unknown */ }
  return { w: 0, h: 0 }
}

/** Downscale (long side ≤2048 px, ≤2 MiB) through a canvas; JPEG quality 0.85→0.6. */
export function createImageTools() {
  return {
    prepare(bytes, mime) {
      const dims = readDims(bytes, mime)
      const data = bytesToBase64(bytes)
      if (dims.w && dims.w <= MAX_DIM && dims.h <= MAX_DIM && bytes.length <= MAX_BYTES) {
        return Promise.resolve({ mime, data, width: dims.w, height: dims.h, bytes: bytes.length })
      }
      return new Promise((resolve) => {
        const img = new Image()
        img.onload = () => {
          const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height
          const scale = Math.min(1, MAX_DIM / Math.max(w0, h0))
          const w = Math.max(1, Math.round(w0 * scale)), hgt = Math.max(1, Math.round(h0 * scale))
          const canvas = document.createElement('canvas')
          canvas.width = w; canvas.height = hgt
          const ctx = canvas.getContext('2d')
          ctx.fillStyle = '#fff'
          ctx.fillRect(0, 0, w, hgt)
          ctx.drawImage(img, 0, 0, w, hgt)
          let out = null
          for (const q of [0.85, 0.75, 0.6]) {
            const url = canvas.toDataURL('image/jpeg', q)
            out = url.slice(url.indexOf(',') + 1)
            if (out.length * 0.75 <= MAX_BYTES) break
          }
          resolve({ mime: 'image/jpeg', data: out, width: w, height: hgt, bytes: Math.round(out.length * 0.75), origWidth: w0, origHeight: h0 })
        }
        img.onerror = () => resolve({ mime, data, width: dims.w, height: dims.h, bytes: bytes.length })
        img.src = 'data:' + mime + ';base64,' + data
      })
    },
  }
}

export function sniffMime(name, bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif'
  if (bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp'
  const ext = String(name || '').toLowerCase().split('.').pop()
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext] || 'application/octet-stream'
}

export function domClipboardCopy(text) {
  try {
    if (window.clipboardData && window.clipboardData.setData) return !!window.clipboardData.setData('Text', text)
  } catch (e) { /* not allowed */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'; ta.style.top = '-1000px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand && document.execCommand('copy')
    document.body.removeChild(ta)
    return !!ok
  } catch (e) { return false }
}

export function uaHint() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || ''
  if (/Windows Phone 8\.1/i.test(ua)) return 'wp81'
  if (/Windows Phone 8\.0/i.test(ua)) return 'wp81'
  if (/Windows Phone 10|Windows NT 10\.0;.*(Mobile|ARM)|Mobile.*Edge\//i.test(ua)) return 'w10m'
  return 'web'
}

export { base64ToBytes }
