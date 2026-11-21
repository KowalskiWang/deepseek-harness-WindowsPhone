// Shared HTTP plumbing for model adapters: run a request whose body is an SSE
// stream (or plain JSON), classify failures, and surface partial output.
import { createSseParser } from './sse.js'
import { classifyHttpError, llmError } from './errors.js'
import { linkedAbort, safeJsonParse } from '../util.js'

/**
 * POST a JSON body and feed SSE events to onSse(ev) as they arrive. onSse may
 * throw to stop the stream; that error is rethrown. Resolves with response
 * metadata once the body ends.
 */
export async function postSse(net, { url, headers, body, signal, idleTimeoutMs = 300000 }, onSse) {
  const ctl = linkedAbort(signal)
  let failure = null
  const parser = createSseParser((ev) => {
    if (failure) return
    try { onSse(ev) } catch (e) { failure = e; ctl.abort('stream-error') }
  })
  let res
  try {
    res = await net.request({
      method: 'POST',
      url,
      headers: Object.assign({ 'content-type': 'application/json', accept: 'text/event-stream' }, headers),
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: ctl.signal,
      idleTimeoutMs,
      onText(chunk, status) {
        if (status && status >= 400) return // error bodies are classified once complete
        parser.push(chunk)
      },
    })
  } catch (e) {
    if (failure) throw failure
    throw e
  }
  if (failure) throw failure
  if (res.status >= 400) throw classifyHttpError(res.status, res.text, res.headers)
  parser.end()
  if (failure) throw failure
  return res
}

export async function postJson(net, { url, headers, body, signal, timeoutMs = 120000 }) {
  const res = await net.request({
    method: 'POST',
    url,
    headers: Object.assign({ 'content-type': 'application/json', accept: 'application/json' }, headers),
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal,
    timeoutMs,
  })
  if (res.status >= 400) throw classifyHttpError(res.status, res.text, res.headers)
  const json = safeJsonParse(res.text, undefined)
  if (json === undefined) throw llmError('INVALID_RESPONSE', 'response was not JSON: ' + String(res.text).slice(0, 200))
  return { json, res }
}

export async function getJson(net, { url, headers, signal, timeoutMs = 15000 }) {
  const res = await net.request({ method: 'GET', url, headers: Object.assign({ accept: 'application/json' }, headers), signal, timeoutMs })
  if (res.status >= 400) throw classifyHttpError(res.status, res.text, res.headers)
  const json = safeJsonParse(res.text, undefined)
  if (json === undefined) throw llmError('INVALID_RESPONSE', 'response was not JSON')
  return json
}
