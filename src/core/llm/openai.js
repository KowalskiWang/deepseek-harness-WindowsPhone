// OpenAI Chat Completions protocol adapter, for custom providers and gateways
// (upstream llm-pi-ai "openai-completions"). Supports DeepSeek-style
// reasoning_content and the `thinkingFormat: deepseek` compat switch.
import { postSse, postJson } from './transport.js'
import { llmError, inBandError } from './errors.js'
import { safeJsonParse } from '../util.js'

export function completionsUrl(baseURL) {
  return String(baseURL || '').replace(/\/+$/, '') + '/chat/completions'
}

export function toWire(messages, route, extraSystem) {
  const compat = Object.assign({}, route.provider.compat || {}, route.model.compat || {})
  const out = []
  if (extraSystem) out.push({ role: 'system', content: extraSystem })
  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n\n')
      if (text) out.push({ role: compat.supportsDeveloperRole && route.model.reasoningEfforts ? 'developer' : 'system', content: text })
    } else if (msg.role === 'user') {
      const parts = []
      for (const b of msg.content || []) {
        if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text })
        else if (b.type === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${b.mime || 'image/png'};base64,${b.data}` } })
      }
      if (!parts.length) continue
      const onlyText = parts.every(p => p.type === 'text')
      out.push({ role: 'user', content: onlyText ? parts.map(p => p.text).join('\n\n') : parts })
    } else if (msg.role === 'assistant') {
      const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
      const reasoning = (msg.content || []).filter(b => b.type === 'thinking').map(b => b.text).join('')
      const calls = (msg.content || []).filter(b => b.type === 'tool-call').map(b => ({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: typeof b.arguments === 'string' && safeJsonParse(b.arguments, null) ? b.arguments : JSON.stringify(b.input || {}) },
      }))
      if (!text && !calls.length && !reasoning) continue
      const m = { role: 'assistant', content: text || (calls.length ? null : '') }
      if (calls.length) m.tool_calls = calls
      if (reasoning && compat.reasoningContent !== false) m.reasoning_content = reasoning
      out.push(m)
    } else if (msg.role === 'tool') {
      const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
      out.push({ role: 'tool', tool_call_id: msg.callId, content: (msg.isError && text.indexOf('Error') !== 0 ? 'Error: ' : '') + text })
      const imgs = (msg.content || []).filter(b => b.type === 'image')
      if (imgs.length) {
        out.push({ role: 'user', content: [{ type: 'text', text: `Image output of tool call ${msg.callId}:` }].concat(imgs.map(b => ({ type: 'image_url', image_url: { url: `data:${b.mime};base64,${b.data}` } }))) })
      }
    }
  }
  return out
}

export function buildBody(route, req) {
  const compat = Object.assign({}, route.provider.compat || {}, route.model.compat || {})
  const body = {
    model: route.model.id,
    messages: toWire(req.messages, route, req.system),
    stream: req.stream !== false,
  }
  if (body.stream) body.stream_options = { include_usage: true }
  const maxTokens = req.maxTokens || route.model.maxTokens
  if (maxTokens) body[compat.maxTokensField || 'max_tokens'] = maxTokens
  if (req.tools && req.tools.length) {
    body.tools = req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
  }
  const efforts = route.model.reasoningEfforts
  const effort = req.effort
  const deepseekThinking = compat.thinkingFormat === 'deepseek' || route.provider.kind === 'deepseek-openai'
  if (efforts && effort) {
    if (effort === 'off') {
      if (efforts.off) body.reasoning_effort = efforts.off
      if (deepseekThinking) body.thinking = { type: 'disabled' }
    } else {
      body.reasoning_effort = efforts[effort] || effort
      if (deepseekThinking) body.thinking = { type: 'enabled' }
    }
  }
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.extraBody) Object.assign(body, req.extraBody)
  return body
}

function headersFor(route) {
  const h = {}
  if (route.apiKey) h.authorization = 'Bearer ' + route.apiKey
  if (route.provider.headers) Object.assign(h, route.provider.headers)
  return h
}

function mapUsage(u) {
  if (!u) return null
  const cacheRead = u.prompt_cache_hit_tokens != null ? u.prompt_cache_hit_tokens
    : (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0
  return {
    input: Math.max(0, (u.prompt_tokens || 0) - cacheRead),
    output: u.completion_tokens || 0,
    cacheRead,
    cacheWrite: 0,
    reasoning: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0,
  }
}

function mapFinish(r) {
  switch (r) {
    case 'stop': return 'stop'
    case 'tool_calls': case 'function_call': return 'tool-calls'
    case 'length': return 'length'
    case 'content_filter': return 'refusal'
    default: return r ? 'stop' : null
  }
}

export async function stream(net, route, req) {
  const url = completionsUrl(route.provider.baseURL)
  const body = buildBody(route, req)
  const emit = req.onEvent || (() => {})
  const t0 = Date.now()
  let ttftMs

  if (body.stream === false) {
    const { json } = await postJson(net, { url, headers: headersFor(route), body, signal: req.signal, timeoutMs: req.timeoutMs || 300000 })
    const choice = (json.choices && json.choices[0]) || {}
    const m = choice.message || {}
    const content = []
    if (m.reasoning_content) content.push({ type: 'thinking', text: m.reasoning_content, model: route.model.id })
    if (m.content) content.push({ type: 'text', text: m.content })
    for (const c of m.tool_calls || []) {
      content.push({ type: 'tool-call', id: c.id, name: c.function.name, arguments: c.function.arguments || '{}', input: safeJsonParse(c.function.arguments || '{}', undefined) })
    }
    return { content, stopReason: mapFinish(choice.finish_reason) || 'stop', usage: mapUsage(json.usage) || {}, raw: json }
  }

  let reasoning = null, text = null
  const calls = []
  const order = []
  let finish = null
  let usage = null
  let sawData = false
  let done = false

  const snapshot = () => {
    const content = []
    for (const o of order) {
      if (o === 'r' && reasoning) content.push({ type: 'thinking', text: reasoning.text, model: route.model.id })
      if (o === 't' && text && text.text) content.push({ type: 'text', text: text.text })
    }
    for (const c of calls) if (c) content.push({ type: 'tool-call', id: c.id, name: c.name, arguments: c.args || '{}', input: safeJsonParse(c.args || '{}', undefined) })
    return content
  }

  try {
    await postSse(net, { url, headers: headersFor(route), body, signal: req.signal, idleTimeoutMs: req.idleTimeoutMs || 300000 }, (ev) => {
      if (ev.data === '[DONE]') { done = true; return }
      const data = safeJsonParse(ev.data, null)
      if (!data) throw llmError('MALFORMED_RESPONSE', 'malformed stream chunk')
      if (data.error) throw inBandError(data.error)
      sawData = true
      if (ttftMs === undefined) ttftMs = Date.now() - t0
      if (data.usage) { usage = mapUsage(data.usage); emit({ kind: 'usage', usage }) }
      const choice = data.choices && data.choices[0]
      if (!choice) return
      const d = choice.delta || {}
      const rc = d.reasoning_content != null ? d.reasoning_content : d.reasoning
      if (rc) {
        if (!reasoning) { reasoning = { text: '' }; order.push('r'); emit({ kind: 'block', index: order.length - 1, type: 'thinking' }) }
        reasoning.text += rc
        emit({ kind: 'delta', index: order.indexOf('r'), type: 'thinking', text: rc })
      }
      if (d.content) {
        if (!text) { text = { text: '' }; order.push('t'); emit({ kind: 'block', index: order.length - 1, type: 'text' }) }
        text.text += d.content
        emit({ kind: 'delta', index: order.indexOf('t'), type: 'text', text: d.content })
      }
      for (const tc of d.tool_calls || []) {
        const i = tc.index != null ? tc.index : calls.length
        let c = calls[i]
        if (!c) {
          c = calls[i] = { id: tc.id || ('call_' + i), name: '', args: '' }
          emit({ kind: 'block', index: 100 + i, type: 'tool-call', name: tc.function && tc.function.name, id: c.id })
        }
        if (tc.id) c.id = tc.id
        if (tc.function && tc.function.name) c.name += tc.function.name
        if (tc.function && tc.function.arguments) { c.args += tc.function.arguments; emit({ kind: 'delta', index: 100 + i, type: 'tool-args', text: tc.function.arguments }) }
      }
      if (choice.finish_reason) finish = choice.finish_reason
    })
  } catch (e) {
    e.partial = { content: snapshot().filter(b => b.type !== 'tool-call') }
    throw e
  }
  if (!sawData) throw llmError('EMPTY_RESPONSE', 'the provider returned no stream data')
  if (!finish && !done) { const e = llmError('STREAM_CLOSED', 'the stream ended without a finish reason'); e.partial = { content: snapshot() }; throw e }
  const stopReason = mapFinish(finish) || 'stop'
  if (stopReason === 'refusal') throw llmError('CONTENT_REFUSED', 'the provider filtered the response')
  const content = snapshot()
  if (stopReason !== 'length') {
    for (const b of content) {
      if (b.type === 'tool-call' && (!b.input || typeof b.input !== 'object' || Array.isArray(b.input))) {
        throw llmError('MALFORMED_RESPONSE', `tool ${b.name} arguments are not a JSON object`)
      }
    }
  }
  if (!content.length && stopReason !== 'length') throw llmError('EMPTY_RESPONSE', 'the model returned no content')
  return { content, stopReason: calls.length && stopReason === 'stop' ? 'tool-calls' : stopReason, usage: usage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ttftMs, durationMs: Date.now() - t0 }
}
