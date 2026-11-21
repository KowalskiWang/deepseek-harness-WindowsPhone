// Shared interpreter logic for run_code (used by the Web Worker and by tests).
import Sval from 'sval'

export function inspect(value, depth = 0, seen = []) {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'string') return depth === 0 ? value : JSON.stringify(value)
  if (t === 'number' || t === 'boolean') return String(value)
  if (t === 'function') return `[Function${value.name ? ': ' + value.name : ''}]`
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
  if (seen.indexOf(value) >= 0) return '[Circular]'
  if (depth > 4) return Array.isArray(value) ? '[Array]' : '[Object]'
  const next = seen.concat([value])
  if (Array.isArray(value)) {
    const items = value.slice(0, 200).map(v => inspect(v, depth + 1, next))
    if (value.length > 200) items.push(`… ${value.length - 200} more items`)
    const one = '[ ' + items.join(', ') + ' ]'
    return one.length < 100 ? one : '[\n' + items.map(s => '  ' + s.replace(/\n/g, '\n  ')).join(',\n') + '\n]'
  }
  if (value instanceof Date) return value.toISOString()
  const keys = Object.keys(value)
  const items = keys.slice(0, 200).map(k => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)) + ': ' + inspect(value[k], depth + 1, next))
  if (keys.length > 200) items.push(`… ${keys.length - 200} more keys`)
  const one = '{ ' + items.join(', ') + ' }'
  return keys.length === 0 ? '{}' : one.length < 100 ? one : '{\n' + items.map(s => '  ' + s.replace(/\n/g, '\n  ')).join(',\n') + '\n}'
}

/**
 * Run an async-function body. callTool(name, args) → Promise<string>.
 * Resolves {value, logs} or {error, logs}.
 */
export function runCode(code, toolNames, callTool) {
  return new Promise((resolve) => {
    const logs = []
    let finished = false
    const done = (r) => { if (!finished) { finished = true; r.logs = logs; resolve(r) } }
    const log = level => (...args) => {
      const line = args.map(a => (typeof a === 'string' ? a : inspect(a, 1))).join(' ')
      logs.push(level === 'log' || level === 'info' ? line : `[${level}] ${line}`)
      if (logs.length > 2000) logs.splice(0, logs.length - 2000)
    }
    const tools = {}
    for (const name of toolNames) tools[name] = args => callTool(name, args === undefined ? {} : args)
    const fail = e => done({ error: e && e.message ? (e.name && e.name !== 'Error' ? e.name + ': ' : '') + e.message : String(e) })
    const finish = (v) => {
      // a sync body may still return a promise (e.g. `return tools.read(…)`)
      if (v && typeof v.then === 'function') v.then(x => done({ value: inspect(x) }), fail)
      else done({ value: inspect(v) })
    }
    const interp = new Sval({ ecmaVer: 'latest', sourceType: 'script', sandBox: true })
    interp.import({
      console: { log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') },
      tools,
      __dshDone: finish,
      __dshFail: fail,
    })
    try {
      // Code without `await` runs in a plain function: sval's normal evaluator is
      // many times faster than its generator evaluator (which async functions need),
      // especially on IE11 where generators are compiled to a state machine.
      if (/\bawait\b/.test(code)) interp.run('(async function () {\n' + code + '\n})().then(__dshDone, __dshFail)')
      else interp.run('__dshDone((function () {\n' + code + '\n})())')
    } catch (e) {
      fail(e)
    }
  })
}
