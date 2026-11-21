// Anthropic Messages protocol adapter. This is the protocol of DeepSeek's own
// route in upstream dsh (POST {base}/v1/messages on api.deepseek.com/anthropic),
// including the in-history system-message extension and thinking passback.
import { postSse, postJson } from './transport.js'
import { llmError, inBandError } from './errors.js'
import { safeJsonParse } from '../util.js'

const API_VERSION = '2023-06-01'

export function messagesUrl(baseURL) {
  const base = String(baseURL || '').replace(/\/+$/, '')
  return (/\/v1$/.test(base) ? base : base + '/v1') + '/messages'
}

function textOf(msg) {
  return (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n\n')
}

function imageBlocks(b) {
  const out = []
  if (b.name || b.width) {
    const label = b.name ? ' ' + b.name : ''
    const dims = b.width ? `; ${b.width}x${b.height}px` : ''
    out.push({ type: 'text', text: `Image${label}${dims}. It may be resized or re-encoded.` })
  }
  out.push({ type: 'image', source: { type: 'base64', media_type: b.mime || 'image/png', data: b.data } })
  return out
}

function userBlocks(content) {
  const out = []
  for (const b of content || []) {
    if (b.type === 'text') { if (b.text) out.push({ type: 'text', text: b.text }) }
    else if (b.type === 'image') out.push(...imageBlocks(b))
  }
  return out
}

/**
 * Convert internal messages to the wire shape.
 * Rules (upstream serialize.ts): tool results ride in the user role, first in
 * that message; consecutive same-role messages merge; empty assistant text is
 * dropped; malformed historical tool arguments become {}; reasoning is sent
 * back verbatim, with its signature only when produced by the same model.
 */
export function toWire(messages, modelInfo, extraSystem) {
  const inHistory = modelInfo && modelInfo.systemPromptUpdate === 'in-history'
  let system = null
  const out = []
  const push = (role, blocks) => {
    if (!blocks.length) return
    const last = out[out.length - 1]
    if (last && last.role === role) {
      if (role === 'user') {
        const results = blocks.filter(b => b.type === 'tool_result')
        const others = blocks.filter(b => b.type !== 'tool_result')
        const lastResults = last.content.filter(b => b.type === 'tool_result')
        const lastOthers = last.content.filter(b => b.type !== 'tool_result')
        last.content = lastResults.concat(results, lastOthers, others)
      } else last.content = last.content.concat(blocks)
    } else out.push({ role, content: blocks })
  }
  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = textOf(msg)
      if (!text) continue
      if (system === null && out.length === 0) system = text
      else if (inHistory) out.push({ role: 'system', content: [{ type: 'text', text }] })
      else system = text
    } else if (msg.role === 'user') {
      push('user', userBlocks(msg.content))
    } else if (msg.role === 'assistant') {
      const blocks = []
      for (const b of msg.content || []) {
        if (b.type === 'thinking') {
          if (!b.text && !b.signature) continue
          const t = { type: 'thinking', thinking: b.text || '' }
          if (b.signature && (!b.model || !modelInfo || b.model === modelInfo.id)) t.signature = b.signature
          blocks.push(t)
        } else if (b.type === 'text') {
          if (b.text) blocks.push({ type: 'text', text: b.text })
        } else if (b.type === 'tool-call') {
          let input = b.input
          if (!input || typeof input !== 'object' || Array.isArray(input)) {
            const parsed = safeJsonParse(b.arguments || '{}', null)
            input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
          }
          blocks.push({ type: 'tool_use', id: b.id, name: b.name, input })
        }
      }
      push('assistant', blocks)
    } else if (msg.role === 'tool') {
      const content = []
      for (const b of msg.content || []) {
        if (b.type === 'text') content.push({ type: 'text', text: b.text || '' })
        else if (b.type === 'image') content.push({ type: 'image', source: { type: 'base64', media_type: b.mime || 'image/png', data: b.data } })
      }
      if (!content.length) content.push({ type: 'text', text: '' })
      push('user', [{ type: 'tool_result', tool_use_id: msg.callId, content, is_error: !!msg.isError }])
    }
  }
  const sys = [extraSystem, system].filter(Boolean).join('\n\n')
  return { system: sys || undefined, messages: out }
}

export function effortFields(provider, modelInfo, effort) {
  if (provider.kind === 'deepseek' || provider.thinkingFormat === 'deepseek') {
    if (!effort || effort === 'off') return { thinking: { type: 'disabled' } }
    return { thinking: { type: 'enabled' }, output_config: { effort } }
  }
  const map = modelInfo && modelInfo.reasoningEfforts
  if (!map || !effort) return {}
  if (effort === 'off') return map.off ? { output_config: { effort: map.off } } : {}
  return { thinking: { type: 'enabled' }, output_config: { effort: map[effort] || effort } }
}

export function buildBody(route, req) {
  const { system, messages } = toWire(req.messages, route.model, req.system)
  const body = {
    model: route.model.id,
    stream: req.stream !== false,
    messages,
    max_tokens: req.maxTokens || route.model.maxTokens || 256000,
  }
  Object.assign(body, effortFields(route.provider, route.model, req.effort))
  if (system) body.system = system
  if (req.tools && req.tools.length) {
    body.tools = req.tools.map(t => t.type ? t : ({ name: t.name, description: t.description, input_schema: t.parameters }))
  }
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.extraBody) Object.assign(body, req.extraBody)
  return body
}

export function headersFor(route) {
  const h = { 'anthropic-version': API_VERSION }
  if (route.apiKey) h['x-api-key'] = route.apiKey
  if (route.provider.headers) Object.assign(h, route.provider.headers)
  return h
}

function mapStop(reason) {
  switch (reason) {
    case 'end_turn': case 'stop_sequence': return 'stop'
    case 'tool_use': return 'tool-calls'
    case 'max_tokens': return 'length'
    case 'refusal': return 'refusal'
    case 'pause_turn': return 'stop'
    default: return null
  }
}

function mapUsage(u, prev) {
  const out = Object.assign({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, prev || {})
  if (!u) return out
  if (u.input_tokens != null) out.input = u.input_tokens
  if (u.output_tokens != null) out.output = u.output_tokens
  if (u.cache_read_input_tokens != null) out.cacheRead = u.cache_read_input_tokens
  if (u.cache_creation_input_tokens != null) out.cacheWrite = u.cache_creation_input_tokens
  if (u.output_tokens_details && u.output_tokens_details.thinking_tokens != null) out.reasoning = u.output_tokens_details.thinking_tokens
  if (u.server_tool_use) out.serverTools = u.server_tool_use
  return out
}

function finalizeBlocks(blocks, modelId) {
  const content = []
  for (const b of blocks) {
    if (!b) continue
    if (b.type === 'thinking') content.push({ type: 'thinking', text: b.text, signature: b.signature || undefined, model: modelId })
    else if (b.type === 'text') { if (b.text) content.push({ type: 'text', text: b.text }) }
    else if (b.type === 'tool-call') {
      const raw = b.json !== '' ? b.json : JSON.stringify(b.input || {})
      content.push({ type: 'tool-call', id: b.id, name: b.name, arguments: raw, input: safeJsonParse(raw || '{}', undefined) })
    }
  }
  return content
}

/** Stream one Messages request. Returns {content, stopReason, usage, requestId, ttftMs}. */
export async function stream(net, route, req) {
  const url = messagesUrl(route.provider.baseURL)
  const body = buildBody(route, req)
  const emit = req.onEvent || (() => {})
  const t0 = Date.now()
  let ttftMs
  if (body.stream === false) {
    const { json, res } = await postJson(net, { url, headers: headersFor(route), body, signal: req.signal, timeoutMs: req.timeoutMs || 300000 })
    const blocks = (json.content || []).map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text || '' }
      if (b.type === 'thinking') return { type: 'thinking', text: b.thinking || '', signature: b.signature }
      if (b.type === 'tool_use') return { type: 'tool-call', id: b.id, name: b.name, input: b.input, json: JSON.stringify(b.input || {}) }
      return null
    })
    return { content: finalizeBlocks(blocks, route.model.id), raw: json, stopReason: mapStop(json.stop_reason) || 'stop', usage: mapUsage(json.usage), requestId: res.headers['request-id'] || res.headers['x-request-id'] }
  }

  const blocks = []
  const byWire = {}
  let usage = mapUsage(null)
  let stopReason = null
  let stopDetails = ''
  let started = false
  let finished = false

  const partialError = (e) => {
    e.partial = { content: finalizeBlocks(blocks.filter(b => b && (b.type !== 'tool-call')), route.model.id), usage }
    return e
  }

  let res
  try {
    res = await postSse(net, { url, headers: headersFor(route), body, signal: req.signal, idleTimeoutMs: req.idleTimeoutMs || 300000 }, (ev) => {
      if (ev.data === '[DONE]') return
      const data = safeJsonParse(ev.data, null)
      if (!data || typeof data.type !== 'string') throw llmError('MALFORMED_RESPONSE', 'malformed stream event')
      switch (data.type) {
        case 'message_start':
          started = true
          usage = mapUsage(data.message && data.message.usage, usage)
          emit({ kind: 'start', usage })
          break
        case 'content_block_start': {
          const cb = data.content_block || {}
          let b
          if (cb.type === 'text') b = { type: 'text', text: cb.text || '' }
          else if (cb.type === 'thinking') b = { type: 'thinking', text: cb.thinking || '', signature: cb.signature || '' }
          else if (cb.type === 'tool_use') b = { type: 'tool-call', id: cb.id, name: cb.name, input: cb.input, json: '' }
          else if (cb.type === 'redacted_thinking') throw llmError('UNSUPPORTED_CONTENT', 'redacted thinking is not supported')
          else b = { type: 'other', raw: cb }
          byWire[data.index] = b
          blocks.push(b)
          if (ttftMs === undefined) ttftMs = Date.now() - t0
          emit({ kind: 'block', index: blocks.length - 1, type: b.type, name: b.name, id: b.id })
          if (b.text) emit({ kind: 'delta', index: blocks.length - 1, type: b.type, text: b.text })
          break
        }
        case 'content_block_delta': {
          const b = byWire[data.index]
          const d = data.delta || {}
          if (!b) break
          const idx = blocks.indexOf(b)
          if (d.type === 'text_delta') { b.text += d.text || ''; emit({ kind: 'delta', index: idx, type: 'text', text: d.text || '' }) }
          else if (d.type === 'thinking_delta') { b.text += d.thinking || ''; emit({ kind: 'delta', index: idx, type: 'thinking', text: d.thinking || '' }) }
          else if (d.type === 'signature_delta') { b.signature = (b.signature || '') + (d.signature || '') }
          else if (d.type === 'input_json_delta') { b.json += d.partial_json || ''; emit({ kind: 'delta', index: idx, type: 'tool-args', text: d.partial_json || '' }) }
          break
        }
        case 'content_block_stop':
          break
        case 'message_delta':
          if (data.delta && data.delta.stop_reason) stopReason = data.delta.stop_reason
          if (data.delta && data.delta.stop_details && data.delta.stop_details.explanation) stopDetails = data.delta.stop_details.explanation
          usage = mapUsage(data.usage, usage)
          emit({ kind: 'usage', usage })
          break
        case 'message_stop':
          finished = true
          break
        case 'error':
          throw inBandError(data.error)
        default:
          break // ping and unknown events count as activity only
      }
    })
  } catch (e) {
    throw partialError(e)
  }

  if (!started || !finished) throw partialError(llmError('STREAM_CLOSED', 'the stream ended before message_stop'))
  const mapped = mapStop(stopReason)
  if (!mapped) throw partialError(llmError('MALFORMED_RESPONSE', `unknown stop reason: ${stopReason}`))
  if (mapped === 'refusal') throw partialError(llmError('CONTENT_REFUSED', stopDetails || 'the model declined to respond', { usage }))
  const content = finalizeBlocks(blocks, route.model.id)
  if (mapped !== 'length') {
    for (const b of content) {
      if (b.type === 'tool-call' && (!b.input || typeof b.input !== 'object' || Array.isArray(b.input))) {
        throw partialError(llmError('MALFORMED_RESPONSE', `tool ${b.name} arguments are not a JSON object`))
      }
    }
  }
  if (!content.length && mapped !== 'length') throw llmError('EMPTY_RESPONSE', 'the model returned no content')
  return {
    content,
    stopReason: mapped,
    usage,
    requestId: res.headers['request-id'] || res.headers['x-request-id'] || res.headers['x-deepseek-request-id'],
    ttftMs,
    durationMs: Date.now() - t0,
  }
}
