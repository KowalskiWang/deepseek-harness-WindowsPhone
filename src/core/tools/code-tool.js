// run_code: the phone's replacement for bash / PTC run_code. JavaScript runs in
// a Web Worker through the sval interpreter (so modern syntax works even on the
// ES5 engine of Windows Phone 8.1) and reaches files and the web only through
// the agent's own tools, which keep enforcing the sandbox and approvals.
import { makeError } from '../util.js'
import { textOutput, errorOutput, runToolCall } from './runtime.js'

const DEFAULT_TIMEOUT = 120000
const MAX_TIMEOUT = 600000
const MAX_OUTPUT = 60000

export function createCodeTool(env) {
  return {
    name: 'run_code',
    description: 'Run JavaScript in an isolated sandbox. The code is the body of an async function: use `await`, and `return` a value to see it. '
      + 'Every other tool is available as `await tools.<name>(args)`, resolving to that tool\'s text result (a failed tool call throws an Error with its message). '
      + 'console.log output is captured. There is no DOM, network, timers or file access except through tools. '
      + 'The code runs in a JavaScript interpreter on a phone, far slower than native JavaScript: keep loops small (well under 100,000 iterations) and avoid heavy computation. '
      + 'Use it for computation, data processing, and batching many tool calls; there is no shell on this device.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript async-function body (ES2020 syntax). Example: const t = await tools.read({ file_path: "a.txt" }); return t.length' },
        description: { type: 'string', description: 'A short (3-8 word) description of what the code does, for display. Use the language of the user\'s current request.' },
        timeoutMs: { type: 'number', description: `Time limit in milliseconds; defaults to ${DEFAULT_TIMEOUT}, at most ${MAX_TIMEOUT}.` },
      },
      required: ['code', 'description'],
    },
    when: () => !!env.codeRunner,
    guidance: () => 'There is no shell on this device. Use run_code for computation and multi-step data processing; inside it, call other tools as `await tools.<name>(args)`.',
    async execute(args, exec) {
      if (!env.codeRunner) throw makeError('UNAVAILABLE', 'code execution is not available on this device')
      const timeoutMs = Math.min(Math.max(1000, args.timeoutMs || DEFAULT_TIMEOUT), MAX_TIMEOUT)
      const calls = []
      const callTool = async (name, toolArgs) => {
        if (name === 'run_code' || name === 'exit_plan_mode') throw makeError('UNAVAILABLE', `${name} cannot be called from run_code`)
        const def = exec.resolveTool(name)
        if (!def) throw makeError('UNKNOWN_TOOL', `unknown tool "${name}"`)
        const id = `${exec.callId}.${calls.length + 1}`
        const entry = { id, name, args: toolArgs, status: 'running' }
        calls.push(entry)
        if (exec.progress) exec.progress({ kind: 'code', calls: calls.slice() })
        const out = await runToolCall(def, { id, name, input: toolArgs || {} }, Object.assign({}, exec, { callId: id, toolName: name }))
        entry.status = out.isError ? 'error' : 'done'
        if (exec.progress) exec.progress({ kind: 'code', calls: calls.slice() })
        const text = out.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
        if (out.isError) throw new Error(text.replace(/^Error: /, ''))
        return text
      }
      const started = Date.now()
      const r = await env.codeRunner.run(args.code, { timeoutMs, signal: exec.signal, callTool, toolNames: exec.toolNames() })
      if (env.diagnostic) {
        env.diagnostic(r.error ? 'run_code-error' : 'run_code-ok', {
          ms: Date.now() - started, error: r.error, timedOut: !!r.timedOut, toolCalls: calls.length,
          code: r.error ? String(args.code).slice(0, 1500) : undefined,
        })
      }
      let text = ''
      if (r.logs && r.logs.length) text += r.logs.join('\n') + '\n'
      if (r.error) {
        text += (text ? '\n' : '') + 'Error: ' + r.error
        if (text.length > MAX_OUTPUT) text = text.slice(0, MAX_OUTPUT) + '\n… (output truncated)'
        return errorOutput(text.replace(/^Error: /, ''), r.timedOut ? 'TIMEOUT' : 'CODE_ERROR', { display: { kind: 'code', description: args.description, code: args.code, calls, error: r.error } })
      }
      text += r.value === undefined ? '(no return value)' : r.value
      if (text.length > MAX_OUTPUT) text = text.slice(0, MAX_OUTPUT) + '\n… (output truncated)'
      return textOutput(text, { display: { kind: 'code', description: args.description, code: args.code, calls } })
    },
  }
}

/**
 * Code runner over a Worker-like factory. The worker protocol:
 *  main → worker  {type:'run', id, code, toolNames}
 *  worker → main  {type:'tool', runId, callId, name, args} | {type:'done', runId, value, logs} | {type:'error', runId, error, logs}
 *  main → worker  {type:'tool-result', callId, ok, value, error}
 */
export function createWorkerRunner(createWorker) {
  let worker = null
  let seq = 0
  const runs = {}
  function ensure() {
    if (worker) return worker
    worker = createWorker()
    worker.onmessage = (e) => {
      const m = e.data || {}
      const run = runs[m.runId]
      if (!run) return
      if (m.type === 'tool') {
        run.callTool(m.name, m.args).then(
          value => worker && worker.postMessage({ type: 'tool-result', callId: m.callId, ok: true, value }),
          err => worker && worker.postMessage({ type: 'tool-result', callId: m.callId, ok: false, error: (err && err.message) || String(err) }),
        )
      } else if (m.type === 'done' || m.type === 'error') {
        run.finish({ value: m.value, error: m.type === 'error' ? m.error : undefined, logs: m.logs || [] })
      }
    }
    worker.onerror = (e) => {
      const msg = (e && e.message) || 'worker error'
      for (const id in runs) runs[id].finish({ error: msg, logs: [] })
      reset()
    }
    return worker
  }
  function reset() {
    if (worker) { try { worker.terminate() } catch (e) { /* gone */ } }
    worker = null
  }
  return {
    run(code, opts) {
      return new Promise((resolve) => {
        const id = ++seq
        let timer = null
        let onAbort = null
        const finish = (r) => {
          if (!runs[id]) return
          delete runs[id]
          if (timer) clearTimeout(timer)
          if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort)
          resolve(r)
        }
        runs[id] = { callTool: opts.callTool, finish }
        timer = setTimeout(() => { finish({ error: `code timed out after ${opts.timeoutMs} ms`, timedOut: true, logs: [] }); reset() }, opts.timeoutMs)
        if (opts.signal) {
          onAbort = () => { finish({ error: 'aborted', logs: [] }); reset() }
          if (opts.signal.aborted) { onAbort(); return }
          opts.signal.addEventListener('abort', onAbort)
        }
        try {
          ensure().postMessage({ type: 'run', runId: id, code, toolNames: opts.toolNames || [] })
        } catch (e) {
          finish({ error: 'cannot start the code sandbox: ' + e.message, logs: [] })
        }
      })
    },
    dispose: reset,
  }
}
