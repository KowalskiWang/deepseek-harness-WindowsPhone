// Tool runtime: argument validation, the execution pipeline (timeout, abort,
// error rendering, spill of oversized results) and the batch scheduler that
// runs concurrency-safe calls in parallel while committing results in model
// order (upstream packages/core/tools: pipeline.ts, batch.ts, schema.ts).
import { createAbort, linkedAbort, makeError, errorMessage, safeJsonParse, estimateTokens, deferred, shortId } from '../util.js'

/**
 * ToolDefinition:
 *   name, description, parameters (JSON schema object)
 *   isConcurrencySafe?(args) -> boolean        default false
 *   readOnly?: boolean
 *   timeoutMs?: number
 *   noSpill?: boolean                            (read is exempt from spilling)
 *   execute(args, exec) -> Promise<ToolOutput | string>
 * ToolOutput: {content:[{type:'text'|'image',…}], isError?, code?, display?, concludesTurn?, context?:[blocks]}
 */

// ---------------------------------------------------------------- validation

function typeOk(type, v) {
  if (Array.isArray(type)) return type.some(t => typeOk(t, v))
  switch (type) {
    case 'string': return typeof v === 'string'
    case 'number': return typeof v === 'number' && isFinite(v)
    case 'integer': return typeof v === 'number' && Math.floor(v) === v
    case 'boolean': return typeof v === 'boolean'
    case 'array': return Array.isArray(v)
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v)
    case 'null': return v === null
    default: return true
  }
}

function validate(schema, value, path, errors) {
  if (!schema) return
  if (schema.oneOf) {
    if (!schema.oneOf.some(s => { const e = []; validate(s, value, path, e); return e.length === 0 })) errors.push(`${path || 'value'} does not match any allowed shape`)
    return
  }
  if (schema.type && !typeOk(schema.type, value)) {
    errors.push(`${path || 'value'} must be ${Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type === 'integer' ? 'an integer' : 'a ' + schema.type}`)
    return
  }
  if (schema.enum && schema.enum.indexOf(value) < 0) errors.push(`${path || 'value'} must be one of ${schema.enum.map(v => JSON.stringify(v)).join(', ')}`)
  if (schema.type === 'object' || (schema.properties && typeOk('object', value))) {
    for (const req of schema.required || []) {
      if (value[req] === undefined) errors.push(`${path ? path + '.' : ''}${req} is required`)
    }
    const props = schema.properties || {}
    for (const k in value) {
      if (!Object.prototype.hasOwnProperty.call(value, k)) continue
      if (props[k]) { if (value[k] !== null || !props[k].oneOf) validate(props[k], value[k], (path ? path + '.' : '') + k, errors) }
      else if (schema.additionalProperties === false) errors.push(`${path ? path + '.' : ''}${k} is not allowed`)
    }
  }
  if (schema.type === 'array' && schema.items && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} must have at least ${schema.minItems} items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} must have at most ${schema.maxItems} items`)
    for (let i = 0; i < value.length; i++) validate(schema.items, value[i], `${path}[${i}]`, errors)
  }
}

export function validateArgs(schema, args) {
  const errors = []
  if (!typeOk('object', args)) return ['arguments must be a JSON object']
  validate(schema, args, '', errors)
  return errors
}

/** Parse raw call arguments: '' → {}, malformed JSON → the raw string (rejected by validation). */
export function parseArgs(raw, input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input
  if (raw === undefined || raw === null || raw === '') return {}
  const v = safeJsonParse(raw, undefined)
  return v === undefined ? raw : v
}

// ---------------------------------------------------------------- outputs

export function textOutput(text, extra) {
  return Object.assign({ content: [{ type: 'text', text: String(text) }] }, extra || {})
}

export function errorOutput(message, code, extra) {
  return Object.assign({ content: [{ type: 'text', text: 'Error: ' + message }], isError: true, code }, extra || {})
}

function normalizeOutput(out) {
  if (typeof out === 'string') return textOutput(out)
  if (!out || !out.content) return textOutput(out === undefined ? '' : JSON.stringify(out))
  return out
}

// ---------------------------------------------------------------- spill

const MAX_INLINE_TOKENS = 12500

/** Upstream spill policy: head, "[...]", tail, plus where the full text lives. */
export async function applySpill(output, def, exec) {
  if (output.isError || def.noSpill || !exec.vfs) return output
  const texts = output.content.filter(b => b.type === 'text')
  const total = texts.reduce((n, b) => n + estimateTokens(b.text), 0)
  if (total <= MAX_INLINE_TOKENS) return output
  const full = texts.map(b => b.text).join('\n')
  const safeName = String(def.name).replace(/[^a-zA-Z0-9_-]/g, '_')
  const path = `/app/spill/${exec.sessionId || 'session'}/${shortId(8)}-${safeName}.txt`
  let stored = true
  try { await exec.vfs.writeText(path, full) } catch (e) { stored = false }
  if (!stored) return output
  const budgetChars = MAX_INLINE_TOKENS * 4
  const half = Math.floor(budgetChars / 2)
  const head = full.slice(0, half)
  const tail = full.slice(full.length - half)
  const omitted = Math.max(0, full.length - head.length - tail.length)
  const images = output.content.filter(b => b.type === 'image').length
  const text = `${head}\n\n[...]\n\n${tail}\n\n(Omitted ${omitted} bytes. Full formatted result stored at: ${path}. Use read with offset/limit, or grep this path to search within it.${images ? ` Omitted ${images} images.` : ''})`
  return Object.assign({}, output, { content: [{ type: 'text', text }], spilledTo: path })
}

// ---------------------------------------------------------------- pipeline

/** Run one tool call through validation, timeout, abort and error rendering. */
export async function runToolCall(def, call, exec) {
  if (!def) return errorOutput(`unknown tool "${call.name}"`, 'UNKNOWN_TOOL')
  const args = parseArgs(call.arguments, call.input)
  const problems = validateArgs(def.parameters, args)
  if (problems.length) return errorOutput('invalid arguments: ' + problems.join('; '), 'INVALID_ARGS')
  if (exec.signal && exec.signal.aborted) return errorOutput('tool call aborted before dispatch', 'ABORTED_BEFORE_DISPATCH')
  const ctl = linkedAbort(exec.signal)
  let timer = null
  const timeout = def.timeoutMs
  const childExec = Object.assign({}, exec, { signal: ctl.signal, args })
  try {
    const run = Promise.resolve().then(() => def.execute(args, childExec))
    let result
    if (timeout) {
      result = await Promise.race([run, new Promise((_, reject) => {
        timer = setTimeout(() => { ctl.abort('timeout'); reject(makeError('TOOL_TIMEOUT', `tool call timed out after ${timeout}ms`)) }, timeout)
      })])
    } else result = await run
    if (exec.signal && exec.signal.aborted) return errorOutput('tool call aborted', 'ABORTED')
    return await applySpill(normalizeOutput(result), def, exec)
  } catch (e) {
    if (exec.signal && exec.signal.aborted) return errorOutput('tool call aborted', 'ABORTED')
    if (e && e.code === 'TOOL_TIMEOUT') return errorOutput(e.message, 'TIMEOUT')
    if (e && e.toolOutput) return e.toolOutput
    return errorOutput(errorMessage(e), e && e.code)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Execute an assistant batch. Concurrency-safe calls run in a rolling pool of
 * maxParallel; any other call is a barrier that runs alone. onStart(call) fires
 * as each call starts (log `tool/call`); onResult(call, output) fires strictly
 * in model order.
 */
export async function executeBatch(calls, { resolve, exec, maxParallel = 10, onStart, onResult, signal }) {
  const outputs = new Array(calls.length)
  const done = calls.map(() => deferred())
  let committed = 0
  const commit = async () => {
    while (committed < calls.length && outputs[committed] !== undefined) {
      const i = committed++
      if (onResult) await onResult(calls[i], outputs[i], i)
    }
  }
  const runOne = async (i) => {
    const call = calls[i]
    const def = resolve(call.name)
    if (signal && signal.aborted) {
      outputs[i] = errorOutput('tool call aborted before dispatch', 'ABORTED_BEFORE_DISPATCH')
    } else {
      if (onStart) onStart(call, i)
      outputs[i] = await runToolCall(def, call, Object.assign({}, exec, { callId: call.id, toolName: call.name }))
    }
    done[i].resolve()
    await commit()
  }
  let i = 0
  while (i < calls.length) {
    const def = resolve(calls[i].name)
    const args = parseArgs(calls[i].arguments, calls[i].input)
    const parallel = !!(def && def.isConcurrencySafe && typeOk('object', args) && def.isConcurrencySafe(args))
    if (!parallel || maxParallel <= 1) {
      await runOne(i)
      i++
      continue
    }
    // collect the run of consecutive parallel-safe calls
    let j = i
    while (j < calls.length) {
      const d = resolve(calls[j].name)
      const a = parseArgs(calls[j].arguments, calls[j].input)
      if (!(d && d.isConcurrencySafe && typeOk('object', a) && d.isConcurrencySafe(a))) break
      j++
    }
    const indexes = []
    for (let k = i; k < j; k++) indexes.push(k)
    let next = 0
    const worker = async () => {
      while (next < indexes.length) {
        const k = indexes[next++]
        await runOne(k)
      }
    }
    const pool = []
    for (let w = 0; w < Math.min(maxParallel, indexes.length); w++) pool.push(worker())
    await Promise.all(pool)
    i = j
  }
  await commit()
  return outputs
}

export { createAbort }
