// Virtual file system: one absolute "/"-rooted tree routed to storage backends.
//
// Backend contract (all async, paths are backend-relative, "" is the backend root):
//   stat(rel) -> {type:'file'|'dir', size, mtime} | null
//   list(rel) -> [{name, type, size, mtime}]
//   readBytes(rel) -> Uint8Array
//   writeBytes(rel, bytes)          creates parent directories
//   appendText?(rel, text)          optional fast path for logs
//   mkdir(rel)                      recursive
//   remove(rel)                     recursive
//   rename(fromRel, toRel)          within the backend
import { normalize, dirname, basename, join, VCS_DIRS, parseGitignore, isIgnored } from './paths.js'
import { utf8Encode, utf8DecodeStrict, makeError } from './util.js'

export class Vfs {
  constructor() {
    this.mounts = [] // {prefix, backend, label, writable}
  }

  mount(prefix, backend, opts = {}) {
    const p = normalize(prefix)
    this.mounts = this.mounts.filter(m => m.prefix !== p)
    this.mounts.push({ prefix: p, backend, label: opts.label || p, writable: opts.writable !== false, hidden: !!opts.hidden })
    this.mounts.sort((a, b) => b.prefix.length - a.prefix.length)
  }

  unmount(prefix) {
    const p = normalize(prefix)
    this.mounts = this.mounts.filter(m => m.prefix !== p)
  }

  route(path) {
    const p = normalize(path)
    for (const m of this.mounts) {
      if (p === m.prefix) return { mount: m, rel: '' }
      if (p.indexOf(m.prefix + '/') === 0) return { mount: m, rel: p.slice(m.prefix.length + 1) }
    }
    return null
  }

  /** Synthetic directories (/, /mnt) that only exist because mounts live under them. */
  virtualChildren(path) {
    const p = normalize(path)
    const prefix = p === '/' ? '/' : p + '/'
    const names = {}
    for (const m of this.mounts) {
      if (m.prefix.indexOf(prefix) === 0 && m.prefix !== p) {
        const name = m.prefix.slice(prefix.length).split('/')[0]
        if (name) names[name] = m.hidden
      }
    }
    return Object.keys(names).map(name => ({ name, type: 'dir', size: 0, mtime: 0, hidden: names[name] }))
  }

  async stat(path) {
    const r = this.route(path)
    if (!r) return this.virtualChildren(path).length || normalize(path) === '/' ? { type: 'dir', size: 0, mtime: 0 } : null
    return r.mount.backend.stat(r.rel)
  }

  async exists(path) { return !!(await this.stat(path)) }

  async list(path) {
    const r = this.route(path)
    const virtual = this.virtualChildren(path)
    if (!r) {
      if (!virtual.length && normalize(path) !== '/') throw makeError('ENOENT', `no such directory: ${path}`)
      return virtual
    }
    const entries = await r.mount.backend.list(r.rel)
    if (!virtual.length) return entries
    const seen = {}
    for (const e of entries) seen[e.name] = true
    return entries.concat(virtual.filter(v => !seen[v.name]))
  }

  async readBytes(path) {
    const r = this.route(path)
    if (!r) throw makeError('ENOENT', `no such file: ${path}`)
    return r.mount.backend.readBytes(r.rel)
  }

  /** Strict UTF-8 text read; throws FS_NOT_TEXT / FS_BINARY like upstream tool-fs. */
  async readText(path) {
    const bytes = await this.readBytes(path)
    const head = bytes.subarray(0, 8192)
    for (let i = 0; i < head.length; i++) if (head[i] === 0) throw makeError('FS_BINARY', `cannot read "${path}": binary file`)
    let start = 0
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3
    const text = utf8DecodeStrict(start ? bytes.subarray(start) : bytes)
    if (text === null) throw makeError('FS_NOT_TEXT', `cannot read "${path}": invalid UTF-8 text`)
    return text
  }

  async writeBytes(path, bytes) {
    const r = this.route(path)
    if (!r) throw makeError('EROFS', `cannot write outside a mounted folder: ${path}`)
    if (!r.mount.writable) throw makeError('EROFS', `read-only location: ${path}`)
    if (r.rel === '') throw makeError('EISDIR', `is a directory: ${path}`)
    return r.mount.backend.writeBytes(r.rel, bytes)
  }

  writeText(path, text) { return this.writeBytes(path, utf8Encode(text)) }

  async appendText(path, text) {
    const r = this.route(path)
    if (!r) throw makeError('EROFS', `cannot write outside a mounted folder: ${path}`)
    if (r.mount.backend.appendText) return r.mount.backend.appendText(r.rel, text)
    let prev = ''
    try { prev = await this.readText(path) } catch (e) { if (e.code !== 'ENOENT') throw e }
    return this.writeText(path, prev + text)
  }

  async mkdirp(path) {
    const r = this.route(path)
    if (!r) return
    if (r.rel === '') return
    return r.mount.backend.mkdir(r.rel)
  }

  async remove(path) {
    const r = this.route(path)
    if (!r || r.rel === '') throw makeError('EPERM', `cannot remove mount point: ${path}`)
    return r.mount.backend.remove(r.rel)
  }

  async rename(from, to) {
    const a = this.route(from), b = this.route(to)
    if (!a || !b) throw makeError('EROFS', 'cannot move outside mounted folders')
    if (a.mount === b.mount) return a.mount.backend.rename(a.rel, b.rel)
    const st = await this.stat(from)
    if (st && st.type === 'dir') throw makeError('EXDEV', 'cannot move a directory across storage locations')
    await this.writeBytes(to, await this.readBytes(from))
    await this.remove(from)
  }

  async readJson(path, fallback) {
    try { return JSON.parse(await this.readText(path)) } catch (e) { return fallback }
  }

  writeJson(path, value) { return this.writeText(path, JSON.stringify(value, null, 1)) }

  /**
   * Walk files beneath root. Options: hidden (include dot entries), vcs (include
   * VCS dirs), gitignore (respect .gitignore files), maxFiles, signal.
   * Calls visit({path, rel, size, mtime}) for each file.
   */
  async walk(root, opts, visit) {
    const o = Object.assign({ hidden: true, vcs: false, gitignore: false, maxFiles: 200000 }, opts || {})
    let count = 0
    const rootNorm = normalize(root)
    let rules = []
    const recurse = async (dir, rel) => {
      if (o.signal && o.signal.aborted) throw makeError('ABORTED', 'aborted')
      let entries
      try { entries = await this.list(dir) } catch (e) { return }
      if (o.gitignore) {
        const gi = entries.find(e => e.name === '.gitignore' && e.type === 'file')
        if (gi) {
          try { rules = rules.concat(parseGitignore(await this.readText(join(dir, '.gitignore')), rel)) } catch (e) { /* unreadable */ }
        }
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const e of entries) {
        if (count >= o.maxFiles) return
        if (e.hidden && dir === '/') continue
        if (!o.vcs && e.type === 'dir' && VCS_DIRS.indexOf(e.name) >= 0) continue
        if (!o.hidden && e.name.charAt(0) === '.') continue
        if (e.name.indexOf('._') === 0 || e.name === '.DS_Store') continue
        const childRel = rel ? rel + '/' + e.name : e.name
        if (o.gitignore && rules.length && isIgnored(rules, childRel, e.type === 'dir')) continue
        const childPath = dir === '/' ? '/' + e.name : dir + '/' + e.name
        if (e.type === 'dir') await recurse(childPath, childRel)
        else {
          count++
          const r = visit({ path: childPath, rel: childRel, size: e.size, mtime: e.mtime })
          if (r && r.then) await r
        }
      }
    }
    await recurse(rootNorm, '')
    return count
  }
}

// ---------------------------------------------------------------- memory backend

export class MemoryBackend {
  constructor() { this.nodes = { '': { type: 'dir', mtime: Date.now() } } }

  _parent(rel) { const i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i) }

  async stat(rel) {
    const n = this.nodes[rel]
    if (!n) return null
    return { type: n.type, size: n.type === 'file' ? n.data.length : 0, mtime: n.mtime }
  }

  async list(rel) {
    const n = this.nodes[rel]
    if (!n || n.type !== 'dir') throw makeError('ENOENT', `no such directory: ${rel || '/'}`)
    const prefix = rel ? rel + '/' : ''
    const out = []
    for (const k in this.nodes) {
      if (k === rel || k.indexOf(prefix) !== 0) continue
      const rest = k.slice(prefix.length)
      if (!rest || rest.indexOf('/') >= 0) continue
      const c = this.nodes[k]
      out.push({ name: rest, type: c.type, size: c.type === 'file' ? c.data.length : 0, mtime: c.mtime })
    }
    return out
  }

  async readBytes(rel) {
    const n = this.nodes[rel]
    if (!n) throw makeError('ENOENT', `no such file: ${rel}`)
    if (n.type !== 'file') throw makeError('EISDIR', `is a directory: ${rel}`)
    return n.data
  }

  async mkdir(rel) {
    if (!rel) return
    const parts = rel.split('/')
    let cur = ''
    for (const p of parts) {
      cur = cur ? cur + '/' + p : p
      const n = this.nodes[cur]
      if (n && n.type === 'file') throw makeError('ENOTDIR', `not a directory: ${cur}`)
      if (!n) this.nodes[cur] = { type: 'dir', mtime: Date.now() }
    }
  }

  async writeBytes(rel, bytes) {
    await this.mkdir(this._parent(rel))
    const n = this.nodes[rel]
    if (n && n.type === 'dir') throw makeError('EISDIR', `is a directory: ${rel}`)
    this.nodes[rel] = { type: 'file', data: new Uint8Array(bytes), mtime: Date.now() }
  }

  async remove(rel) {
    if (!this.nodes[rel]) throw makeError('ENOENT', `no such file: ${rel}`)
    const prefix = rel + '/'
    for (const k of Object.keys(this.nodes)) if (k === rel || k.indexOf(prefix) === 0) delete this.nodes[k]
  }

  async rename(from, to) {
    if (!this.nodes[from]) throw makeError('ENOENT', `no such file: ${from}`)
    await this.mkdir(this._parent(to))
    const prefix = from + '/'
    for (const k of Object.keys(this.nodes)) {
      if (k === from) { this.nodes[to] = this.nodes[k]; delete this.nodes[k] }
      else if (k.indexOf(prefix) === 0) { this.nodes[to + k.slice(from.length)] = this.nodes[k]; delete this.nodes[k] }
    }
  }
}

export { normalize, dirname, basename }
