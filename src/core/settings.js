// Settings (/app/settings.json) and credentials. Credentials never enter the
// virtual file system the agent can read: they live in the platform credential
// store (PasswordVault on Windows Phone, localStorage on the web build).
import { Emitter, clone, debounce } from './util.js'

export const DEFAULT_SETTINGS = {
  general: {
    language: 'auto',
    theme: 'dark',
    fontSize: 15,
    workDetails: 'detailed',
    collapseWhen: 'completion',
    repliesAfterCollapse: 'all',
    openLinksIn: 'browser',
    busySend: 'queue',
    usageDisplay: 'detailed',
    defaultPermission: 'workspace-write',
    defaultPreset: 'standard',
    welcomeAck: null,
    onboarded: false,
    notifications: true,
    sendOnEnter: false,
  },
  gateway: { url: '', code: '', route: 'auto' },
  models: {
    deepseek: { baseURL: 'https://api.deepseek.com/anthropic', models: null, reasoningEffort: 'high' },
    custom: [],
    retry: { mode: 'default', maxRetries: 5, initialDelayMs: 500, maxDelayMs: 10000, jitter: 0.1 },
    defaultSelection: { provider: 'deepseek', model: 'deepseek-flash', effort: 'high' },
  },
  agent: { maxParallelToolCalls: 10, applyPatch: false, compactThreshold: 0 },
  subagent: { maxDepth: 1, maxParallel: 8, allowModelSelection: true },
  web: { searchProvider: 'auto', maxSearchesPerRequest: 5, resultsPerSearch: 10, fetchProvider: 'direct', sendOriginalQuestion: true, searchModel: 'deepseek-flash', apiKeyRef: false, allowPrivateFetch: false },
  code: { timeoutMs: 120000 },
  mcp: { servers: [] },
  skills: { customDirs: [] },
  sessionList: { groupBy: 'workspace', orderBy: 'updated', filter: 'hide-archived' },
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v) }

export function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? clone(base) : clone(over)
  const out = clone(base)
  for (const k in over) {
    if (!Object.prototype.hasOwnProperty.call(over, k)) continue
    out[k] = isObj(base[k]) && isObj(over[k]) ? deepMerge(base[k], over[k]) : clone(over[k])
  }
  return out
}

/** Upstream masked preview: identifier before the first "-"/"_", five leading and four trailing characters. */
export function maskSecret(key) {
  if (!key) return ''
  const chars = Array.from ? Array.from(key) : key.split('')
  let idLen = 0
  for (let i = 0; i < Math.min(chars.length, 12); i++) if (chars[i] === '-' || chars[i] === '_') { idLen = i + 1; break }
  const id = chars.slice(0, idLen).join('')
  const rest = chars.slice(idLen)
  if (rest.length - 9 >= 8) return id + rest.slice(0, 5).join('') + '••••••••' + rest.slice(rest.length - 4).join('')
  return new Array(chars.length + 1).join('•')
}

export class SettingsStore extends Emitter {
  constructor(vfs, credentials) {
    super()
    this.vfs = vfs
    this.credentials = credentials // {get(id), set(id, value), remove(id), list()} async
    this.data = clone(DEFAULT_SETTINGS)
    this.cred = {}
    this._save = debounce(() => this.vfs.writeJson('/app/settings.json', this.data).catch(() => {}), 300)
  }

  async init() {
    const stored = await this.vfs.readJson('/app/settings.json', {})
    this.data = deepMerge(DEFAULT_SETTINGS, stored || {})
    try {
      const ids = await this.credentials.list()
      for (const id of ids) {
        const v = await this.credentials.get(id)
        if (v) this.cred[id] = v
      }
    } catch (e) { /* no credential store */ }
  }

  get() { return this.data }

  /** Shallow-by-section update: update({general: {theme: 'light'}}). */
  update(patch) {
    this.data = deepMerge(this.data, patch)
    this._save()
    this.emit('change', this.data)
  }

  /** Replace one section path verbatim (arrays, lists). */
  set(section, value) {
    this.data[section] = clone(value)
    this._save()
    this.emit('change', this.data)
  }

  flush() { this._save.flush() }

  getCredential(id) { return this.cred[id] }
  hasCredential(id) { return !!this.cred[id] }
  credentialPreview(id) { return maskSecret(this.cred[id]) }

  async setCredential(id, value) {
    const v = String(value || '').trim()
    if (!v) return this.removeCredential(id)
    this.cred[id] = v
    await this.credentials.set(id, v)
    this.emit('change', this.data)
  }

  async removeCredential(id) {
    delete this.cred[id]
    await this.credentials.remove(id)
    this.emit('change', this.data)
  }
}
