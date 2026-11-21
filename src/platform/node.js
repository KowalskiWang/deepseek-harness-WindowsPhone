// Node platform for tests and headless runs: real-disk backend, Node HTTP,
// in-memory credentials and an in-process sval code runner.
import fs from 'node:fs'
import path from 'node:path'
import { Vfs, MemoryBackend } from '../core/vfs.js'
import { createNodeHttp } from './http-node.js'
import { makeError, bytesToBase64 } from '../core/util.js'
import { runCode } from '../sandbox/interp.js'

export class DiskBackend {
  constructor(root) { this.root = root; fs.mkdirSync(root, { recursive: true }) }
  p(rel) { return path.join(this.root, rel) }
  async stat(rel) {
    try { const s = fs.statSync(this.p(rel)); return { type: s.isDirectory() ? 'dir' : 'file', size: s.size, mtime: s.mtimeMs } } catch (e) { return null }
  }
  async list(rel) {
    try {
      return fs.readdirSync(this.p(rel), { withFileTypes: true }).map((d) => {
        let st = null
        try { st = fs.statSync(path.join(this.p(rel), d.name)) } catch (e) { /* vanished */ }
        return { name: d.name, type: d.isDirectory() ? 'dir' : 'file', size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 }
      })
    } catch (e) { throw makeError('ENOENT', `no such directory: ${rel}`) }
  }
  async readBytes(rel) {
    try { return new Uint8Array(fs.readFileSync(this.p(rel))) } catch (e) { throw makeError(e.code === 'EISDIR' ? 'EISDIR' : 'ENOENT', `no such file: ${rel}`) }
  }
  async writeBytes(rel, bytes) { fs.mkdirSync(path.dirname(this.p(rel)), { recursive: true }); fs.writeFileSync(this.p(rel), Buffer.from(bytes)) }
  async appendText(rel, text) { fs.mkdirSync(path.dirname(this.p(rel)), { recursive: true }); fs.appendFileSync(this.p(rel), text) }
  async mkdir(rel) { fs.mkdirSync(this.p(rel), { recursive: true }) }
  async remove(rel) { if (!fs.existsSync(this.p(rel))) throw makeError('ENOENT', 'no such file'); fs.rmSync(this.p(rel), { recursive: true, force: true }) }
  async rename(a, b) { fs.mkdirSync(path.dirname(this.p(b)), { recursive: true }); fs.renameSync(this.p(a), this.p(b)) }
}

export function createNodePlatform({ root, memory = false } = {}) {
  const vfs = new Vfs()
  const backend = name => (memory ? new MemoryBackend() : new DiskBackend(path.join(root, name)))
  vfs.mount('/app', backend('app'), { hidden: true })
  vfs.mount('/workspaces', backend('workspaces'))
  vfs.mount('/tmp', backend('tmp'))
  const creds = {}
  return {
    kind: 'node',
    hint: 'node',
    vfs,
    http: createNodeHttp(),
    credentials: {
      async get(id) { return creds[id] },
      async set(id, v) { creds[id] = v },
      async remove(id) { delete creds[id] },
      async list() { return Object.keys(creds) },
    },
    codeRunner: {
      run(code, opts) {
        return Promise.race([
          runCode(code, opts.toolNames || [], opts.callTool),
          new Promise(resolve => setTimeout(() => resolve({ error: `code timed out after ${opts.timeoutMs} ms`, timedOut: true, logs: [] }), opts.timeoutMs)),
        ])
      },
    },
    images: {
      async prepare(bytes, mime) { return { mime, data: bytesToBase64(bytes), width: 0, height: 0, bytes: bytes.length } },
    },
  }
}
