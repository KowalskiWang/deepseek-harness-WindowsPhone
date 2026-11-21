// IndexedDB storage backend for the browser build (IE11 on Windows Phone 8.1
// supports IndexedDB with string keys only). Files are base64 chunks so logs
// can be appended without rewriting the whole file.
import { makeError, bytesToBase64, base64ToBytes, utf8Encode } from '../core/util.js'

const DB_NAME = 'dsh-mobile'
const STORE = 'files'

export function openDb() {
  return new Promise((resolve, reject) => {
    const idb = (typeof self !== 'undefined') && (self.indexedDB || self.msIndexedDB)
    if (!idb) { reject(new Error('IndexedDB is not available')); return }
    let req
    try { req = idb.open(DB_NAME, 1) } catch (e) { reject(e); return }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'))
  })
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export class IdbBackend {
  constructor(db, mount) {
    this.db = db
    this.mount = mount // key prefix, e.g. "app"
    this.cache = {} // key -> meta record (dirs and file metas)
  }

  key(rel) { return this.mount + ':' + rel }
  chunkKey(rel, i) { return this.mount + '#' + rel + '\u0001' + i }

  tx(mode) { return this.db.transaction(STORE, mode).objectStore(STORE) }

  async getMeta(rel) {
    if (rel === '') return { type: 'dir', size: 0, mtime: 0 }
    const k = this.key(rel)
    if (this.cache[k] !== undefined) return this.cache[k]
    const v = await promisify(this.tx('readonly').get(k))
    this.cache[k] = v || null
    return v || null
  }

  async putMeta(rel, meta) {
    this.cache[this.key(rel)] = meta
    await promisify(this.tx('readwrite').put(meta, this.key(rel)))
  }

  async stat(rel) {
    const m = await this.getMeta(rel)
    return m ? { type: m.type, size: m.size || 0, mtime: m.mtime || 0 } : null
  }

  async list(rel) {
    const m = await this.getMeta(rel)
    if (!m || m.type !== 'dir') throw makeError('ENOENT', `no such directory: ${rel || '/'}`)
    const prefix = this.key(rel ? rel + '/' : '')
    const range = IDBKeyRange.bound(prefix, prefix + '￿')
    const out = []
    await new Promise((resolve, reject) => {
      const req = this.tx('readonly').openCursor(range)
      req.onsuccess = () => {
        const cur = req.result
        if (!cur) { resolve(); return }
        const rest = String(cur.key).slice(prefix.length)
        if (rest && rest.indexOf('/') < 0) out.push({ name: rest, type: cur.value.type, size: cur.value.size || 0, mtime: cur.value.mtime || 0 })
        cur['continue']()
      }
      req.onerror = () => reject(req.error)
    })
    return out
  }

  async readBytes(rel) {
    const m = await this.getMeta(rel)
    if (!m) throw makeError('ENOENT', `no such file: ${rel}`)
    if (m.type !== 'file') throw makeError('EISDIR', `is a directory: ${rel}`)
    const store = this.tx('readonly')
    const parts = []
    for (let i = 0; i < (m.chunks || 0); i++) parts.push(promisify(store.get(this.chunkKey(rel, i))))
    const chunks = await Promise.all(parts)
    const arrays = chunks.map(c => base64ToBytes(c || ''))
    const total = arrays.reduce((n, a) => n + a.length, 0)
    const out = new Uint8Array(total)
    let o = 0
    for (const a of arrays) { out.set(a, o); o += a.length }
    return out
  }

  async mkdir(rel) {
    if (!rel) return
    const parts = rel.split('/')
    let cur = ''
    for (const p of parts) {
      cur = cur ? cur + '/' + p : p
      const m = await this.getMeta(cur)
      if (m && m.type === 'file') throw makeError('ENOTDIR', `not a directory: ${cur}`)
      if (!m) await this.putMeta(cur, { type: 'dir', size: 0, mtime: Date.now() })
    }
  }

  async writeBytes(rel, bytes) {
    const i = rel.lastIndexOf('/')
    if (i > 0) await this.mkdir(rel.slice(0, i))
    const old = await this.getMeta(rel)
    if (old && old.type === 'dir') throw makeError('EISDIR', `is a directory: ${rel}`)
    const store = this.tx('readwrite')
    for (let c = 0; old && c < (old.chunks || 0); c++) store['delete'](this.chunkKey(rel, c))
    store.put(bytesToBase64(bytes), this.chunkKey(rel, 0))
    const meta = { type: 'file', size: bytes.length, mtime: Date.now(), chunks: 1 }
    this.cache[this.key(rel)] = meta
    await promisify(store.put(meta, this.key(rel)))
  }

  async appendText(rel, text) {
    const m = await this.getMeta(rel)
    if (!m) return this.writeBytes(rel, utf8Encode(text))
    const bytes = utf8Encode(text)
    const store = this.tx('readwrite')
    store.put(bytesToBase64(bytes), this.chunkKey(rel, m.chunks || 0))
    const meta = { type: 'file', size: (m.size || 0) + bytes.length, mtime: Date.now(), chunks: (m.chunks || 0) + 1 }
    this.cache[this.key(rel)] = meta
    await promisify(store.put(meta, this.key(rel)))
    // compact very fragmented logs into one chunk
    if (meta.chunks > 400) await this.writeBytes(rel, await this.readBytes(rel))
  }

  async _descendants(rel) {
    const prefix = this.key(rel + '/')
    const keys = []
    await new Promise((resolve, reject) => {
      const req = this.tx('readonly').openCursor(IDBKeyRange.bound(prefix, prefix + '￿'))
      req.onsuccess = () => { const cur = req.result; if (!cur) { resolve(); return } keys.push(String(cur.key).slice(this.mount.length + 1)); cur['continue']() }
      req.onerror = () => reject(req.error)
    })
    return keys
  }

  async remove(rel) {
    const m = await this.getMeta(rel)
    if (!m) throw makeError('ENOENT', `no such file: ${rel}`)
    const targets = [rel].concat(m.type === 'dir' ? await this._descendants(rel) : [])
    for (const r of targets) {
      const meta = await this.getMeta(r)
      const store = this.tx('readwrite')
      for (let c = 0; meta && c < (meta.chunks || 0); c++) store['delete'](this.chunkKey(r, c))
      this.cache[this.key(r)] = null
      await promisify(store['delete'](this.key(r)))
    }
  }

  async rename(from, to) {
    const m = await this.getMeta(from)
    if (!m) throw makeError('ENOENT', `no such file: ${from}`)
    if (m.type === 'file') {
      await this.writeBytes(to, await this.readBytes(from))
      await this.remove(from)
      return
    }
    await this.mkdir(to)
    for (const r of await this._descendants(from)) {
      const meta = await this.getMeta(r)
      const target = to + r.slice(from.length)
      if (meta.type === 'dir') await this.mkdir(target)
      else await this.writeBytes(target, await this.readBytes(r))
    }
    await this.remove(from)
  }
}
