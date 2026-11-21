// Web Worker entry for run_code (bundled to js/sandbox-worker.js). It has no DOM
// and no Windows Runtime access; tool calls are proxied to the app thread.
//
// The code it runs is written by the model, so it may use any modern built-in
// (Object.entries, Array.from, padStart, Promise.allSettled…). On IE11 (Windows
// Phone 8.1) those do not exist, so the worker loads the complete stable
// core-js set; the build expands this import into every module IE11 needs.
import 'core-js/stable'
import { runCode } from './interp.js'

const pending = {}
let callSeq = 0

self.onmessage = function (e) {
  const m = e.data || {}
  if (m.type === 'run') {
    const runId = m.runId
    const callTool = (name, args) => new Promise((resolve, reject) => {
      const callId = ++callSeq
      pending[callId] = { resolve, reject }
      self.postMessage({ type: 'tool', runId, callId, name, args: JSON.parse(JSON.stringify(args === undefined ? {} : args)) })
    })
    runCode(m.code, m.toolNames || [], callTool).then((r) => {
      self.postMessage(r.error !== undefined ? { type: 'error', runId, error: r.error, logs: r.logs } : { type: 'done', runId, value: r.value, logs: r.logs })
    })
  } else if (m.type === 'tool-result') {
    const p = pending[m.callId]
    if (!p) return
    delete pending[m.callId]
    if (m.ok) p.resolve(m.value)
    else p.reject(new Error(m.error))
  }
}
