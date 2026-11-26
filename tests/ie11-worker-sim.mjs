// IE11-like harness for the shipped sandbox worker bundle (dist/web/js/sandbox-worker.js).
// Removes the ES2015+ built-ins that IE11 lacks, loads the bundle into a fresh VM
// context as a Worker would, then drives it through the real message protocol.
// Usage: node tests/ie11-worker-sim.mjs
import fs from 'node:fs'
import vm from 'node:vm'
import { SANDBOX_CASES, SANDBOX_TOOLS, checkSandboxCase } from '../src/selftest/sandbox-cases.js'

const bundle = fs.readFileSync(new URL('../dist/web/js/sandbox-worker.js', import.meta.url), 'utf8')

const STRIP = `
  (function () {
    var g = this;
    ['Promise','Symbol','Reflect','Proxy','WeakRef','FinalizationRegistry','queueMicrotask','structuredClone',
     'Map','Set','WeakMap','WeakSet','AggregateError','BigInt','BigInt64Array','BigUint64Array','SharedArrayBuffer','Atomics',
     'TextEncoder','TextDecoder','URL','URLSearchParams','AbortController','fetch','Iterator'].forEach(function (k) { try { delete g[k] } catch (e) {} });
    var del = function (o, keys) { keys.forEach(function (k) { try { delete o[k] } catch (e) {} }) };
    del(Object, ['assign','entries','values','fromEntries','getOwnPropertySymbols','is','hasOwn','groupBy','getOwnPropertyDescriptors']);
    del(Array, ['from','of']);
    del(Array.prototype, ['find','findIndex','includes','fill','flat','flatMap','entries','keys','values','copyWithin','at','findLast','findLastIndex','toReversed','toSorted','toSpliced','with']);
    del(String, ['fromCodePoint','raw']);
    del(String.prototype, ['includes','startsWith','endsWith','repeat','padStart','padEnd','trimStart','trimEnd','trimLeft','trimRight','codePointAt','normalize','at','replaceAll','matchAll','isWellFormed','toWellFormed']);
    del(Number, ['isInteger','isNaN','isFinite','isSafeInteger','EPSILON','MAX_SAFE_INTEGER','MIN_SAFE_INTEGER','parseFloat','parseInt']);
    del(Math, ['trunc','sign','log2','log10','cbrt','hypot','clz32','fround','imul','expm1','log1p','sinh','cosh','tanh','asinh','acosh','atanh']);
    del(Function.prototype, ['toString']);

    // ES5 object semantics that IE11 (Chakra) still follows:
    //  • a function's own "length" is non-configurable, so redefining it throws
    //    (found on a real Lumia: "Cannot redefine non-configurable property 'length'")
    //  • Object.keys/getPrototypeOf/freeze/… throw a TypeError for primitive arguments
    var odp = Object.defineProperty;
    Object.defineProperty = function (o, k, d) {
      if (typeof o === 'function' && k === 'length') throw new TypeError("Cannot redefine non-configurable property 'length'");
      return odp(o, k, d);
    };
    Object.defineProperties = function (o, props) {
      Object.keys(props).forEach(function (k) { Object.defineProperty(o, k, props[k]) });
      return o;
    };
    ['keys', 'getPrototypeOf', 'getOwnPropertyNames', 'freeze', 'seal', 'preventExtensions', 'isFrozen', 'isSealed', 'isExtensible', 'getOwnPropertyDescriptor'].forEach(function (name) {
      var orig = Object[name];
      Object[name] = function (o) {
        if (o === null || (typeof o !== 'object' && typeof o !== 'function')) throw new TypeError('Object.' + name + ': argument is not an Object');
        return orig.apply(Object, arguments);
      };
    });
  }).call(this);
`

function makeWorker() {
  const posted = []
  const sandbox = {
    setTimeout, clearTimeout, setInterval, clearInterval,
    console: { log() {}, warn() {}, error() {}, info() {} },
  }
  const ctx = vm.createContext(sandbox)
  vm.runInContext('var self = this;', ctx)
  vm.runInContext(STRIP, ctx)
  // Function.prototype.toString was removed above to mimic quirks; restore a minimal version (IE11 has one)
  vm.runInContext('Function.prototype.toString = function () { return "function () { [native code] }" };', ctx)
  let onMsg = null
  ctx.postMessage = (m) => posted.push(m)
  const missing = vm.runInContext('[typeof Promise, typeof Symbol, typeof Map, typeof Object.assign, typeof Array.from].join(",")', ctx)
  vm.runInContext(bundle, ctx, { filename: 'sandbox-worker.js' })
  onMsg = ctx.onmessage || ctx.self.onmessage
  return { ctx, posted, missingBefore: missing, send: m => onMsg.call(ctx, { data: JSON.parse(JSON.stringify(m)) }) }
}

async function run(code, tools = {}) {
  const w = makeWorker()
  w.send({ type: 'run', runId: 1, code, toolNames: Object.keys(tools) })
  const t0 = Date.now()
  while (Date.now() - t0 < 20000) {
    await new Promise(r => setTimeout(r, 5))
    while (w.posted.length) {
      const m = w.posted.shift()
      if (m.type === 'tool') {
        const fn = tools[m.name]
        Promise.resolve().then(() => fn(m.args)).then(
          v => w.send({ type: 'tool-result', callId: m.callId, ok: true, value: v }),
          e => w.send({ type: 'tool-result', callId: m.callId, ok: false, error: e.message }),
        )
      } else if (m.type === 'done' || m.type === 'error') return Object.assign({ missingBefore: w.missingBefore }, m)
    }
  }
  return { type: 'timeout', missingBefore: w.missingBefore }
}

let failures = 0
for (const c of SANDBOX_CASES) {
  const started = Date.now()
  const r = await run(c.code, SANDBOX_TOOLS)
  const ms = Date.now() - started
  const result = r.type === 'done' ? { value: r.value, logs: r.logs } : r.type === 'error' ? { error: r.error, logs: r.logs } : { error: 'timed out' }
  const problem = checkSandboxCase(c, result)
  if (problem) failures++
  console.log(`${problem ? '✗' : '✓'} ${c.name.padEnd(28)} ${r.type}: ${String(r.type === 'done' ? JSON.stringify(r.value) : r.error || '').replace(/\n/g, ' ').slice(0, 140)}${problem ? '  ← ' + problem : ''}  (${ms} ms)`)
}
console.log(failures ? `${failures} failing` : 'all passing', '| built-ins removed before load:', (await run('return 1')).missingBefore)
process.exit(failures ? 1 : 0)
