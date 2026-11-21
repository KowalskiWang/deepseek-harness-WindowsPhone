// Workspaces: app-local folders under /workspaces and device folders the user
// picked (mounted at /mnt/<id> through the platform's folder access list).
import { Emitter, shortId, makeError } from './util.js'

const FILE = '/app/workspaces.json'

export class WorkspaceStore extends Emitter {
  constructor(vfs, platform) {
    super()
    this.vfs = vfs
    this.platform = platform
    this.items = []
  }

  async init() {
    this.items = await this.vfs.readJson(FILE, [])
    if (!Array.isArray(this.items)) this.items = []
    for (const ws of this.items) {
      if (ws.kind === 'device' && this.platform.mountDeviceFolder) {
        try { await this.platform.mountDeviceFolder(ws) } catch (e) { ws.unavailable = true }
      }
    }
    if (!this.items.length) await this.addAppFolder('Default', { isDefault: true })
  }

  save() {
    return this.vfs.writeJson(FILE, this.items).catch(() => {}).then(() => this.emit('change'))
  }

  list() { return this.items.slice() }
  get(id) { return this.items.find(w => w.id === id) }
  byPath(p) { return this.items.find(w => w.path === p) }

  async addAppFolder(name, opts = {}) {
    const clean = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 64)
    if (!clean) throw makeError('INVALID_NAME', 'folder name is empty')
    const path = '/workspaces/' + clean
    if (this.byPath(path)) throw makeError('WORKSPACE_EXISTS', 'a workspace with this name already exists')
    await this.vfs.mkdirp(path)
    const ws = { id: 'ws-' + shortId(8), name: clean, path, kind: 'app', isDefault: !!opts.isDefault, createdAt: Date.now(), lastActiveAt: Date.now() }
    this.items.push(ws)
    await this.save()
    return ws
  }

  /** Register a folder picked from the phone's file system. */
  async addDeviceFolder(picked) {
    const id = 'ws-' + shortId(8)
    const ws = { id, name: picked.name, path: '/mnt/' + id.slice(3), kind: 'device', token: picked.token, createdAt: Date.now(), lastActiveAt: Date.now() }
    await this.platform.mountDeviceFolder(ws)
    this.items.push(ws)
    await this.save()
    return ws
  }

  /** Remove from the list only; the folder and its sessions' logs stay. */
  async remove(id) {
    const ws = this.get(id)
    if (!ws) return
    this.items = this.items.filter(w => w !== ws)
    if (ws.kind === 'device' && this.platform.forgetDeviceFolder) this.platform.forgetDeviceFolder(ws)
    await this.save()
  }

  touch(id) {
    const ws = this.get(id)
    if (ws) { ws.lastActiveAt = Date.now(); this.save() }
  }

  mostRecent() {
    return this.items.slice().sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))[0]
  }
}
