/* global Windows */
// Windows Runtime platform for the APPX build (Windows Phone 8.1 HTML/JS app
// model, which Windows 10 Mobile also runs). Storage uses the app's local
// folder and folders the user picks; pickers use WP8.1's "AndContinue" flow.
import { Vfs } from '../core/vfs.js'
import { makeError } from '../core/util.js'
import { createXhrHttp } from './http-xhr.js'
import { createWorkerRunner } from '../core/tools/code-tool.js'
import { createImageTools, sniffMime } from './dom-common.js'

const RESOURCE = 'DSH Mobile'

function wrap(op) {
  return new Promise((resolve, reject) => { op.then(resolve, reject) })
}

function splitRel(rel) {
  const i = rel.lastIndexOf('/')
  return i < 0 ? { dir: '', name: rel } : { dir: rel.slice(0, i), name: rel.slice(i + 1) }
}

function isFolder(item) {
  return item.isOfType(Windows.Storage.StorageItemTypes.folder)
}

/** StorageFolder-backed VFS backend. root: () => Promise<StorageFolder>. */
export class StorageBackend {
  constructor(root) { this.root = root }

  async _folder(rel, create) {
    let folder = await this.root()
    if (!rel) return folder
    const S = Windows.Storage
    for (const seg of rel.split('/')) {
      if (!seg) continue
      try {
        folder = await wrap(create ? folder.createFolderAsync(seg, S.CreationCollisionOption.openIfExists) : folder.getFolderAsync(seg))
      } catch (e) {
        throw makeError('ENOENT', `no such directory: ${rel}`)
      }
    }
    return folder
  }

  async _item(rel) {
    if (!rel) return this.root()
    const { dir, name } = splitRel(rel)
    let parent
    try { parent = await this._folder(dir, false) } catch (e) { return null }
    try { return await wrap(parent.getItemAsync(name)) } catch (e) { return null }
  }

  async stat(rel) {
    const item = await this._item(rel)
    if (!item) return null
    if (isFolder(item)) return { type: 'dir', size: 0, mtime: 0 }
    try {
      const p = await wrap(item.getBasicPropertiesAsync())
      return { type: 'file', size: p.size, mtime: p.dateModified ? new Date(p.dateModified).getTime() : 0 }
    } catch (e) { return { type: 'file', size: 0, mtime: 0 } }
  }

  async list(rel) {
    const folder = await this._folder(rel, false)
    const items = await wrap(folder.getItemsAsync())
    const arr = []
    const n = items.length !== undefined ? items.length : items.size
    for (let i = 0; i < n; i++) arr.push(items[i] || items.getAt(i))
    return Promise.all(arr.map(async (it) => {
      if (isFolder(it)) return { name: it.name, type: 'dir', size: 0, mtime: 0 }
      try {
        const p = await wrap(it.getBasicPropertiesAsync())
        return { name: it.name, type: 'file', size: p.size, mtime: p.dateModified ? new Date(p.dateModified).getTime() : 0 }
      } catch (e) { return { name: it.name, type: 'file', size: 0, mtime: 0 } }
    }))
  }

  async readBytes(rel) {
    const item = await this._item(rel)
    if (!item) throw makeError('ENOENT', `no such file: ${rel}`)
    if (isFolder(item)) throw makeError('EISDIR', `is a directory: ${rel}`)
    const buf = await wrap(Windows.Storage.FileIO.readBufferAsync(item))
    const out = new Uint8Array(buf.length)
    if (buf.length) {
      const reader = Windows.Storage.Streams.DataReader.fromBuffer(buf)
      reader.readBytes(out)
      try { reader.close() } catch (e) { /* closed */ }
    }
    return out
  }

  async writeBytes(rel, bytes) {
    const S = Windows.Storage
    const { dir, name } = splitRel(rel)
    const parent = await this._folder(dir, true)
    const file = await wrap(parent.createFileAsync(name, S.CreationCollisionOption.replaceExisting))
    await wrap(S.FileIO.writeBytesAsync(file, bytes))
  }

  async appendText(rel, text) {
    const S = Windows.Storage
    const { dir, name } = splitRel(rel)
    const parent = await this._folder(dir, true)
    const file = await wrap(parent.createFileAsync(name, S.CreationCollisionOption.openIfExists))
    await wrap(S.FileIO.appendTextAsync(file, text, S.Streams.UnicodeEncoding.utf8))
  }

  async mkdir(rel) { await this._folder(rel, true) }

  async remove(rel) {
    const item = await this._item(rel)
    if (!item) throw makeError('ENOENT', `no such file: ${rel}`)
    await wrap(item.deleteAsync(Windows.Storage.StorageDeleteOption.permanentDelete))
  }

  async rename(from, to) {
    const S = Windows.Storage
    const item = await this._item(from)
    if (!item) throw makeError('ENOENT', `no such file: ${from}`)
    const a = splitRel(from), b = splitRel(to)
    if (!isFolder(item)) {
      const dest = await this._folder(b.dir, true)
      await wrap(item.moveAsync(dest, b.name, S.NameCollisionOption.replaceExisting))
      return
    }
    if (a.dir === b.dir) { await wrap(item.renameAsync(b.name, S.NameCollisionOption.failIfExists)); return }
    // folders cannot be moved across parents: copy recursively, then delete
    await this.mkdir(to)
    for (const e of await this.list(from)) {
      if (e.type === 'dir') await this.rename(from + '/' + e.name, to + '/' + e.name)
      else await this.writeBytes(to + '/' + e.name, await this.readBytes(from + '/' + e.name))
    }
    await this.remove(from)
  }
}

/** deviceFamilyVersion: 64-bit decimal string, major.minor.build.revision in 16-bit parts. */
function decodeFamilyVersion(str) {
  let digits = String(str || '').replace(/\D/g, '').split('').map(Number)
  if (!digits.length) return ''
  const parts = []
  for (let i = 0; i < 4; i++) {
    let rem = 0
    const q = []
    for (let j = 0; j < digits.length; j++) {
      const cur = rem * 10 + digits[j]
      const qd = Math.floor(cur / 65536)
      rem = cur % 65536
      if (q.length || qd) q.push(qd)
    }
    parts.unshift(rem)
    digits = q.length ? q : [0]
  }
  return parts.join('.')
}

/**
 * What the device is. A Windows Phone 8.1 package also runs on Windows 10
 * Mobile, in the same IE11-based engine, so the user agent can still say
 * "Windows Phone 8.1"; the Windows 10 APIs tell the two apart.
 */
export function winrtDeviceInfo() {
  const out = {}
  try {
    const v = Windows.System.Profile.AnalyticsInfo.versionInfo
    out.deviceFamily = v.deviceFamily
    out.osVersion = decodeFamilyVersion(v.deviceFamilyVersion)
  } catch (e) { out.deviceFamily = null }
  try { out.win10Apis = !!(Windows.Foundation.Metadata && Windows.Foundation.Metadata.ApiInformation) } catch (e) { out.win10Apis = false }
  try {
    const d = new Windows.Security.ExchangeActiveSyncProvisioning.EasClientDeviceInformation()
    out.manufacturer = d.systemManufacturer
    out.model = d.systemProductName
    out.os = d.operatingSystem
  } catch (e) { /* not available */ }
  try {
    const v = Windows.ApplicationModel.Package.current.id.version
    out.packageVersion = [v.major, v.minor, v.build, v.revision].join('.')
  } catch (e) { /* not packaged */ }
  return out
}

function winrtHint(info) {
  if (info.deviceFamily) return /mobile/i.test(info.deviceFamily) ? 'w10m' : 'web'
  if (info.win10Apis) return 'w10m'
  return 'wp81'
}

export async function createWinrtPlatform() {
  const S = Windows.Storage
  const local = S.ApplicationData.current.localFolder
  const sub = name => { let p = null; return () => p || (p = wrap(local.createFolderAsync(name, S.CreationCollisionOption.openIfExists))) }
  const vfs = new Vfs()
  vfs.mount('/app', new StorageBackend(sub('app')), { hidden: true })
  vfs.mount('/workspaces', new StorageBackend(sub('workspaces')))
  vfs.mount('/tmp', new StorageBackend(() => Promise.resolve(S.ApplicationData.current.temporaryFolder)))

  // ---------------------------------------------------------------- continuation pickers (WP8.1)
  const pending = { files: null, folder: null }
  const A = Windows.ApplicationModel.Activation
  Windows.UI.WebUI.WebUIApplication.addEventListener('activated', (args) => {
    try {
      if (A.ActivationKind.pickFileContinuation !== undefined && args.kind === A.ActivationKind.pickFileContinuation && pending.files) {
        const p = pending.files; pending.files = null
        const list = []
        const n = args.files ? (args.files.length !== undefined ? args.files.length : args.files.size) : 0
        for (let i = 0; i < n; i++) list.push(args.files[i] || args.files.getAt(i))
        p.resolve(list)
      } else if (A.ActivationKind.pickFolderContinuation !== undefined && args.kind === A.ActivationKind.pickFolderContinuation && pending.folder) {
        const p = pending.folder; pending.folder = null
        p.resolve(args.folder || null)
      }
    } catch (e) { /* ignore malformed activation */ }
  })

  function pickFiles(exts) {
    const P = S.Pickers
    const picker = new P.FileOpenPicker()
    picker.viewMode = P.PickerViewMode.thumbnail
    picker.suggestedStartLocation = P.PickerLocationId.picturesLibrary
    for (const e of exts) picker.fileTypeFilter.append(e)
    if (picker.pickMultipleFilesAndContinue) {
      return new Promise((resolve, reject) => { pending.files = { resolve, reject }; picker.pickMultipleFilesAndContinue() })
    }
    return wrap(picker.pickMultipleFilesAsync()).then((files) => {
      const out = []
      for (let i = 0; i < files.length; i++) out.push(files[i])
      return out
    })
  }

  function pickFolderRaw() {
    const P = S.Pickers
    const picker = new P.FolderPicker()
    picker.fileTypeFilter.append('*')
    picker.suggestedStartLocation = P.PickerLocationId.documentsLibrary
    if (picker.pickFolderAndContinue) return new Promise((resolve, reject) => { pending.folder = { resolve, reject }; picker.pickFolderAndContinue() })
    return wrap(picker.pickSingleFolderAsync())
  }

  const fal = () => S.AccessCache.StorageApplicationPermissions.futureAccessList
  const images = createImageTools()
  const vault = () => new Windows.Security.Credentials.PasswordVault()
  const device = winrtDeviceInfo()

  return {
    kind: 'winrt',
    hint: winrtHint(device),
    deviceInfo: () => device,
    persistent: true,
    vfs,
    http: createXhrHttp(),
    credentials: {
      async get(id) { try { const c = vault().retrieve(RESOURCE, id); c.retrievePassword(); return c.password } catch (e) { return undefined } },
      async set(id, v) {
        const vlt = vault()
        try { vlt.remove(vlt.retrieve(RESOURCE, id)) } catch (e) { /* none */ }
        vlt.add(new Windows.Security.Credentials.PasswordCredential(RESOURCE, id, v))
      },
      async remove(id) { const vlt = vault(); try { vlt.remove(vlt.retrieve(RESOURCE, id)) } catch (e) { /* none */ } },
      async list() {
        try {
          const all = vault().findAllByResource(RESOURCE)
          const out = []
          const n = all.length !== undefined ? all.length : all.size
          for (let i = 0; i < n; i++) out.push((all[i] || all.getAt(i)).userName)
          return out
        } catch (e) { return [] }
      },
    },
    codeRunner: typeof Worker !== 'undefined' ? createWorkerRunner(() => new Worker('js/sandbox-worker.js')) : null,
    images,
    async pickImages() {
      const files = await pickFiles(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
      const out = []
      for (const f of files || []) {
        const buf = await wrap(S.FileIO.readBufferAsync(f))
        const bytes = new Uint8Array(buf.length)
        const reader = S.Streams.DataReader.fromBuffer(buf)
        reader.readBytes(bytes)
        const img = await images.prepare(bytes, sniffMime(f.name, bytes))
        out.push(Object.assign({ name: f.name }, img))
      }
      return out
    },
    async pickFolder() {
      const folder = await pickFolderRaw()
      if (!folder) return null
      const token = fal().add(folder)
      return { name: folder.displayName || folder.name, token }
    },
    async mountDeviceFolder(ws) {
      let folderPromise = null
      const root = () => folderPromise || (folderPromise = wrap(fal().getFolderAsync(ws.token)))
      await root()
      vfs.mount(ws.path, new StorageBackend(root), { label: ws.name })
    },
    forgetDeviceFolder(ws) {
      vfs.unmount(ws.path)
      try { fal().remove(ws.token) } catch (e) { /* gone */ }
    },
    openExternal(url) {
      try { Windows.System.Launcher.launchUriAsync(new Windows.Foundation.Uri(url)) } catch (e) { /* bad uri */ }
    },
    clipboard: {
      copy(text) {
        try {
          const DT = Windows.ApplicationModel.DataTransfer
          const dp = new DT.DataPackage()
          dp.setText(text)
          DT.Clipboard.setContent(dp)
          return true
        } catch (e) { return false }
      },
    },
    async saveFile(name, text) {
      // saved next to the app's exports; the UI also mirrors it into the workspace
      const folder = await wrap(local.createFolderAsync('exports', S.CreationCollisionOption.openIfExists))
      const file = await wrap(folder.createFileAsync(name, S.CreationCollisionOption.generateUniqueName))
      await wrap(S.FileIO.writeTextAsync(file, text, S.Streams.UnicodeEncoding.utf8))
      return null // not user-visible on WP8.1; caller falls back to the workspace copy
    },
    notify(kind, agent, data) {
      if (!document.hidden && document.visibilityState !== 'hidden') return
      try {
        const N = Windows.UI.Notifications
        const xml = N.ToastNotificationManager.getTemplateContent(N.ToastTemplateType.toastText02)
        const texts = xml.getElementsByTagName('text')
        const title = agent.meta.title || 'DSH'
        const body = kind === 'needs-input' ? '等待你的操作' : kind === 'turn-failed' ? '本轮运行失败' : kind === 'schedule' ? '定时任务已开始' : '任务已完成'
        texts[0].appendChild(xml.createTextNode(title))
        texts[1].appendChild(xml.createTextNode(body))
        N.ToastNotificationManager.createToastNotifier().show(new N.ToastNotification(xml))
      } catch (e) { /* toasts disabled */ }
    },
    onBack(fn) {
      try {
        Windows.Phone.UI.Input.HardwareButtons.addEventListener('backpressed', (e) => { if (fn()) e.handled = true })
      } catch (e) { /* no hardware back button */ }
    },
    onNavigate() {},
    onSuspend(fn) {
      Windows.UI.WebUI.WebUIApplication.addEventListener('suspending', (e) => {
        const d = e.suspendingOperation.getDeferral()
        Promise.resolve(fn()).then(() => d.complete(), () => d.complete())
      })
    },
    setStatusBar(dark) {
      try {
        const sb = Windows.UI.ViewManagement.StatusBar.getForCurrentView()
        const C = Windows.UI.ColorHelper
        sb.backgroundColor = dark ? C.fromArgb(255, 0, 0, 0) : C.fromArgb(255, 255, 255, 255)
        sb.foregroundColor = dark ? C.fromArgb(255, 255, 255, 255) : C.fromArgb(255, 0, 0, 0)
        sb.backgroundOpacity = 1
      } catch (e) { /* no status bar (desktop) */ }
    },
  }
}
