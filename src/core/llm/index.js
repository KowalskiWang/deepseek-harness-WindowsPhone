// Model routing: providers, model catalog (with DeepSeek's published listing),
// credential lookup and protocol adapters.
import * as anthropic from './anthropic.js'
import * as openai from './openai.js'
import { getJson } from './transport.js'
import { llmError } from './errors.js'
import { parseUrl, clone } from '../util.js'

export const DEEPSEEK_EFFORTS = ['off', 'low', 'high', 'max']

/** Built-in DeepSeek catalog (upstream packages/llm/llm-deepseek/src/models.ts). */
export const DEEPSEEK_MODELS = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek-V4.1-Flash',
    contextWindow: 1048576,
    maxTokens: 256000,
    input: ['text', 'image'],
    systemPromptUpdate: 'in-history',
    toolUpdate: 'addition-only',
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    description: 'Stronger agentic coding … higher cost',
    contextWindow: 1048576,
    maxTokens: 256000,
    input: ['text'],
    systemPromptUpdate: 'leading-only',
    toolUpdate: 'leading-only',
  },
]

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic'

export function builtinDeepseekProvider(overrides) {
  const o = overrides || {}
  return {
    id: 'deepseek',
    kind: 'deepseek',
    name: 'DeepSeek',
    protocol: 'anthropic-messages',
    baseURL: o.baseURL || DEEPSEEK_BASE_URL,
    models: o.models && o.models.length ? o.models : null, // null → follow the published listing
    retry: o.retry,
    builtin: true,
  }
}

/** Third-party providers offered by "Add model provider" (endpoint + protocol; models are discovered). */
export const THIRD_PARTY_CATALOG = [
  {
    id: 'deepseek-openai', kind: 'deepseek-openai', name: 'DeepSeek (OpenAI-compatible API)', protocol: 'openai-completions', baseURL: 'https://api.deepseek.com',
    compat: { thinkingFormat: 'deepseek' },
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1048576, maxTokens: 256000, input: ['text', 'image'], reasoningEfforts: { off: '', low: 'low', high: 'high', max: 'max' } },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1048576, maxTokens: 256000, input: ['text'], reasoningEfforts: { off: '', low: 'low', high: 'high', max: 'max' } },
    ],
  },
  { id: 'moonshotai', name: 'Moonshot AI (Kimi)', protocol: 'openai-completions', baseURL: 'https://api.moonshot.cn/v1', models: [] },
  { id: 'zai', name: 'Zhipu (GLM)', protocol: 'openai-completions', baseURL: 'https://open.bigmodel.cn/api/paas/v4', models: [] },
  { id: 'dashscope', name: 'Alibaba Cloud (Qwen)', protocol: 'openai-completions', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: [] },
  { id: 'siliconflow', name: 'SiliconFlow', protocol: 'openai-completions', baseURL: 'https://api.siliconflow.cn/v1', models: [] },
  { id: 'openrouter', name: 'OpenRouter', protocol: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1', models: [] },
  { id: 'openai', name: 'OpenAI', protocol: 'openai-completions', baseURL: 'https://api.openai.com/v1', models: [] },
  { id: 'anthropic', name: 'Anthropic', protocol: 'anthropic-messages', baseURL: 'https://api.anthropic.com', models: [] },
]

export const PROTOCOLS = ['openai-completions', 'anthropic-messages']

function adapterFor(protocol) {
  if (protocol === 'anthropic-messages') return anthropic
  if (protocol === 'openai-completions') return openai
  throw llmError('UNSUPPORTED_PROTOCOL', `unsupported API protocol: ${protocol}`)
}

const LISTING_TTL = 10 * 60 * 1000

export class LlmService {
  /**
   * @param {object} deps
   *   net: {request}
   *   getSettings(): settings.models section
   *   getCredential(providerId): string | undefined
   *   gatewayInjectsKey(): boolean  (a DSH gateway supplies the DeepSeek key)
   */
  constructor(deps) {
    this.net = deps.net
    this.getSettings = deps.getSettings
    this.getCredential = deps.getCredential
    this.gatewayInjectsKey = deps.gatewayInjectsKey || (() => false)
    this.listingCache = {} // providerId -> {at, models, error}
    this.listingInflight = {}
  }

  providers() {
    const s = this.getSettings() || {}
    const list = [builtinDeepseekProvider(s.deepseek)]
    for (const p of s.custom || []) list.push(Object.assign({ kind: 'custom' }, p))
    return list
  }

  getProvider(id) { return this.providers().find(p => p.id === id) }

  /** Models of a provider; DeepSeek follows the published listing when not customised. */
  models(providerId) {
    const p = this.getProvider(providerId)
    if (!p) return []
    if (p.kind === 'deepseek') {
      if (p.models) return p.models.map(m => Object.assign({ efforts: DEEPSEEK_EFFORTS }, m))
      const cached = this.listingCache.deepseek
      const base = cached && cached.models ? cached.models : DEEPSEEK_MODELS
      return base.map(m => Object.assign({ efforts: DEEPSEEK_EFFORTS }, m))
    }
    return (p.models || []).map(m => Object.assign({ efforts: m.reasoningEfforts ? Object.keys(m.reasoningEfforts) : [] }, m))
  }

  findModel(providerId, modelId) {
    const found = this.models(providerId).find(m => m.id === modelId)
    if (found) return found
    const p = this.getProvider(providerId)
    if (p && p.kind === 'deepseek' && modelId) {
      // Unknown ids pass through as text-only (upstream behaviour).
      return { id: modelId, name: modelId, contextWindow: 1000000, maxTokens: 256000, input: ['text'], efforts: DEEPSEEK_EFFORTS, passthrough: true }
    }
    return undefined
  }

  defaultEffort(providerId, modelId) {
    const p = this.getProvider(providerId)
    const s = this.getSettings() || {}
    if (p && p.kind === 'deepseek') return (s.deepseek && s.deepseek.reasoningEffort) || 'high'
    const m = this.findModel(providerId, modelId)
    if (!m || !m.efforts || !m.efforts.length) return undefined
    return m.defaultEffort || (m.efforts.indexOf('high') >= 0 ? 'high' : m.efforts[m.efforts.length - 1])
  }

  apiKeyFor(provider) {
    const key = this.getCredential(provider.id)
    if (key) return key
    if (provider.kind === 'deepseek' && this.gatewayInjectsKey()) return ''
    return undefined
  }

  /** Resolve a selection {provider, model, effort} into a callable route. */
  resolve(selection) {
    const sel = selection || {}
    const provider = this.getProvider(sel.provider)
    if (!provider) throw llmError('UNKNOWN_PROVIDER', `unknown model provider: ${sel.provider}`)
    const model = this.findModel(provider.id, sel.model)
    if (!model) throw llmError('UNKNOWN_MODEL', `unknown model: ${sel.provider}/${sel.model}`)
    let effort = sel.effort || this.defaultEffort(provider.id, model.id)
    if (effort && model.efforts && model.efforts.length && model.efforts.indexOf(effort) < 0) {
      throw llmError('UNSUPPORTED_REASONING_EFFORT', `model ${model.id} does not support reasoning effort "${effort}"`)
    }
    const apiKey = this.apiKeyFor(provider)
    if (apiKey === undefined) throw llmError('MISSING_CREDENTIAL', `no API key is configured for ${provider.name}`)
    return { provider, model, effort, apiKey, adapter: adapterFor(provider.protocol) }
  }

  stream(route, req) {
    return route.adapter.stream(this.net, route, req)
  }

  // ------------------------------------------------------------ listing

  /** Origin + /models (upstream: the base URL's origin plus /models). */
  listingUrl(provider) {
    const u = parseUrl(provider.baseURL)
    return u ? u.origin + '/models' : null
  }

  /** Refresh DeepSeek's published model list (waits ≤5 s on first use; background every 10 min). */
  ensureListing(force) {
    const p = this.getProvider('deepseek')
    if (!p || p.models) return Promise.resolve()
    const u = parseUrl(p.baseURL)
    if (!u || u.host !== 'api.deepseek.com') return Promise.resolve()
    const cached = this.listingCache.deepseek
    if (!force && cached && Date.now() - cached.at < LISTING_TTL) return Promise.resolve()
    if (this.listingInflight.deepseek) return this.listingInflight.deepseek
    const apiKey = this.apiKeyFor(p)
    if (apiKey === undefined) return Promise.resolve()
    const headers = apiKey ? { authorization: 'Bearer ' + apiKey } : {}
    const run = getJson(this.net, { url: this.listingUrl(p), headers, timeoutMs: 5000 })
      .then((json) => {
        const models = parseDeepseekListing(json)
        this.listingCache.deepseek = { at: Date.now(), models: models.length ? models : (cached && cached.models) || null }
      })
      .catch((e) => {
        this.listingCache.deepseek = { at: Date.now(), models: (cached && cached.models) || null, error: e.message }
      })
      .then(() => { this.listingInflight.deepseek = null })
    this.listingInflight.deepseek = run
    return run
  }

  /** "Fetch available models" for a provider form (custom endpoints). */
  async discoverModels({ protocol, baseURL, apiKey }) {
    const base = String(baseURL || '').replace(/\/+$/, '')
    let url, headers
    if (protocol === 'anthropic-messages') {
      url = (/\/v1$/.test(base) ? base : base + '/v1') + '/models'
      headers = { 'anthropic-version': '2023-06-01' }
      if (apiKey) headers['x-api-key'] = apiKey
    } else {
      url = base + '/models'
      headers = apiKey ? { authorization: 'Bearer ' + apiKey } : {}
    }
    const json = await getJson(this.net, { url, headers, timeoutMs: 15000 })
    let items = null
    if (json && Array.isArray(json.data)) items = json.data
    else if (json && json.models && typeof json.models === 'object') items = Array.isArray(json.models) ? json.models : Object.keys(json.models).map(k => Object.assign({ id: k }, json.models[k]))
    if (!items) throw llmError('INVALID_RESPONSE', 'the endpoint reported neither a data array nor a models object')
    const out = []
    for (const it of items) {
      const id = it.id || it.name
      if (!id || out.some(m => m.id === id)) continue
      out.push({
        id,
        name: it.display_name || it.name || id,
        contextWindow: it.context_window || it.context_length || undefined,
        maxTokens: it.max_output_tokens || undefined,
        input: Array.isArray(it.input_modalities) ? it.input_modalities.filter(x => x === 'text' || x === 'image') : ['text'],
      })
    }
    return out
  }

  /** DeepSeek account balance for an API key (GET {origin}/user/balance). */
  async balance() {
    const p = this.getProvider('deepseek')
    const u = parseUrl(p.baseURL)
    const apiKey = this.apiKeyFor(p)
    if (apiKey === undefined) throw llmError('MISSING_CREDENTIAL', 'no DeepSeek API key is configured')
    const headers = apiKey ? { authorization: 'Bearer ' + apiKey } : {}
    return getJson(this.net, { url: u.origin + '/user/balance', headers, timeoutMs: 15000 })
  }
}

/** Parse DeepSeek's /models listing (upstream listing.ts rules). */
export function parseDeepseekListing(json) {
  const out = []
  const builtin = {}
  for (const m of DEEPSEEK_MODELS) builtin[m.id] = m
  for (const it of (json && json.data) || []) {
    if (!it || typeof it.id !== 'string' || out.some(m => m.id === it.id)) continue
    const caps = it.api_capabilities && it.api_capabilities.anthropic_messages
    if (!caps) continue
    const outMods = it.output_modalities
    if (Array.isArray(outMods) && outMods.indexOf('text') < 0) continue
    const req = it.client_requirements && it.client_requirements['deepseek-harness']
    if (!req && !builtin[it.id]) continue
    if (req && req.min_version && compareSemver(req.min_version, '0.2.2') > 0) continue
    const base = builtin[it.id] || {}
    const input = Array.isArray(it.input_modalities) ? it.input_modalities.filter(x => x === 'text' || x === 'image') : base.input || ['text']
    const meta = it.client_metadata && it.client_metadata['deepseek-harness']
    out.push({
      id: it.id,
      name: it.name || base.name || it.id,
      description: base.description,
      contextWindow: it.context_window || base.contextWindow || 1000000,
      maxTokens: Math.min(base.maxTokens || 256000, it.max_output_tokens || 256000),
      input: input.length ? input : ['text'],
      systemPromptUpdate: caps.system_prompt_update || base.systemPromptUpdate,
      toolUpdate: caps.tool_update || base.toolUpdate,
      badge: meta && meta.badge,
    })
  }
  return out
}

function compareSemver(a, b) {
  const pa = String(a).split(/[.-]/).map(n => parseInt(n, 10) || 0)
  const pb = String(b).split(/[.-]/).map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  return 0
}

export { clone }
