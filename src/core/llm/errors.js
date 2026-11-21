// LLM error taxonomy and retry policy, mirroring upstream dsh-llm / dsh-llm-retry.
import { makeError, parseRetryAfter } from '../util.js'

export const RETRYABLE_DEFAULT = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']

export function llmError(code, message, extra) {
  return makeError(code, message, Object.assign({ llm: true }, extra || {}))
}

const QUOTA_WORDS = /insufficient[ _-]?(balance|quota|funds)|quota exceeded|exceeded your current quota|余额不足|account balance/i
const CONTEXT_WORDS = /context[ _-]?(length|window)|maximum context|too many tokens|prompt is too long|input is too long|exceeds the model|reduce the length/i

/** Map an HTTP failure (status + parsed body) to an upstream-style error code. */
export function classifyHttpError(status, bodyText, headers) {
  let type = '', code = '', message = ''
  try {
    const j = JSON.parse(bodyText)
    const err = j.error || j
    type = String(err.type || '')
    code = String(err.code || '')
    message = String(err.message || err.msg || j.message || '')
  } catch (e) {
    message = String(bodyText || '').slice(0, 500)
  }
  const text = `${type} ${code} ${message}`
  const requestId = headers && (headers['request-id'] || headers['x-request-id'] || headers['x-deepseek-request-id'])
  const extra = { status, requestId, providerType: type, providerCode: code }
  let c
  if (status === 401 || status === 403 || /authentication_error|permission_error/.test(type)) c = 'AUTH'
  else if (status === 402 || QUOTA_WORDS.test(text)) c = 'QUOTA'
  else if (status === 429 || /rate_limit/.test(type)) {
    c = 'RATE_LIMIT'
    extra.retryAfterMs = parseRetryAfter(headers && headers['retry-after'])
  } else if (CONTEXT_WORDS.test(text)) c = 'CONTEXT_WINDOW_EXCEEDED'
  else if (status === 400 || status === 413 || /invalid_request/.test(type)) c = 'INVALID_REQUEST'
  else if (status >= 500 || /api_error|overloaded/.test(type)) c = 'SERVER'
  else c = 'HTTP_' + status
  const msg = message || `HTTP ${status}`
  return llmError(c, msg, extra)
}

export function inBandError(err) {
  const type = String((err && err.type) || '')
  const message = String((err && err.message) || 'provider error')
  let c = 'SERVER'
  if (/authentication|permission/.test(type)) c = 'AUTH'
  else if (/rate_limit/.test(type)) c = 'RATE_LIMIT'
  else if (/invalid_request/.test(type)) c = CONTEXT_WORDS.test(message) ? 'CONTEXT_WINDOW_EXCEEDED' : 'INVALID_REQUEST'
  else if (QUOTA_WORDS.test(message)) c = 'QUOTA'
  return llmError(c, message, { providerType: type })
}

/**
 * Retry policy (normal mode): up to maxRetries for retryable codes; delay
 * min(initial·2^(n−1), max) × jitter in [1−j, 1+j]. Retry-After is honoured
 * when ≤ maxDelay; a longer server-mandated wait gives up (mode 'always' waits).
 */
export function retryDecision(error, attempt, policy) {
  const p = Object.assign({ mode: 'default', maxRetries: 5, codes: RETRYABLE_DEFAULT, initialDelayMs: 500, maxDelayMs: 10000, jitter: 0.1 }, policy || {})
  if (!error || error.code === 'ABORTED') return null
  if (p.mode === 'off') return null
  const codes = p.mode === 'all' ? null : p.codes
  if (codes && codes.indexOf(error.code) < 0) return null
  if (p.mode !== 'always' && attempt > p.maxRetries) return null
  let delay = Math.min(p.initialDelayMs * Math.pow(2, attempt - 1), p.maxDelayMs)
  delay = delay * (1 - p.jitter + Math.random() * 2 * p.jitter)
  if (error.retryAfterMs !== undefined) {
    if (error.retryAfterMs > p.maxDelayMs && p.mode !== 'always') return null
    delay = Math.max(delay, error.retryAfterMs)
  }
  return { delayMs: Math.round(delay), attempt, max: p.mode === 'always' ? Infinity : p.maxRetries }
}

/** Codes after which the UI offers "Continue generating". */
export const CONTINUABLE = ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'STREAM_CLOSED']
