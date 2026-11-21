// IE11-like harness for the shipped sandbox worker bundle (dist/web/js/sandbox-worker.js).
// Removes the ES2015+ built-ins that IE11 lacks, loads the bundle into a fresh VM
// context as a Worker would, then drives it through the real message protocol.
// Usage: node tests/ie11-worker-sim.mjs
import fs from 'node:fs'
import vm from 'node:vm'

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

const cases = [
  ['arithmetic', 'return 1 + 1'],
  ['loop sum', 'let s = 0; for (let i = 1; i <= 100; i++) s += i; return s'],
  ['arrow + reduce', 'return [1, 2, 3].map(x => x * 2).reduce((a, b) => a + b, 0)'],
  ['object result', 'const xs = [1, 2, 3]; return { xs, sum: xs.reduce((a, b) => a + b, 0), ok: true }'],
  ['console.log', 'console.log("hello", 42, { a: 1 }); return "done"'],
  ['template + destructuring', 'const { a, b = 2 } = { a: 1 }; const [x, ...rest] = [1, 2, 3]; return `${a}-${b}-${x}-${rest.length}`'],
  ['for-of + spread + Set', 'const out = []; for (const v of [3, 1, 2]) out.push(v); return [...new Set([...out, 1])].sort()'],
  ['Map + Object.entries', 'const m = new Map([["k", 1]]); return Object.entries({ a: 1, b: 2 }).length + m.get("k")'],
  ['class', 'class P { constructor(n) { this.n = n } get twice() { return this.n * 2 } }; return new P(21).twice'],
  ['async/await tool', 'const t = await tools.read({ file_path: "a.txt" }); return t.toUpperCase()'],
  ['await in loop', 'const r = []; for (const f of ["a", "b"]) r.push(await tools.read({ file_path: f })); return r.join("|")'],
  ['Promise.all tools', 'const r = await Promise.all(["x", "y"].map(f => tools.read({ file_path: f }))); return r'],
  ['try/catch tool error', 'try { await tools.fail({}) } catch (e) { return "caught: " + e.message }'],
  ['thrown error', 'throw new TypeError("boom")'],
  ['JSON + regex', 'return JSON.stringify("a1b22c333".match(/\\d+/g))'],
  ['string methods', 'return "abc".padStart(5, "-") + "x".repeat(3) + ("hello".includes("ell") ? "Y" : "N")'],
  ['optional chaining / nullish', 'const o = { a: { b: null } }; return (o.a?.b ?? "dflt") + (o.z?.q ?? "")'],
  ['Date + Math', 'return [typeof Date.now(), Math.max(...[1, 5, 3]), Math.trunc(4.7)]'],
  ['newer array methods', 'const a = [3, 1, 2]; return [a.includes(2), a.find(x => x > 1), [[1], [2, [3]]].flat(2).length, a.at(-1), a.toSorted().join(""), Array.from({ length: 3 }, (_, i) => i * i)]'],
  ['newer object/string methods', 'const o = Object.fromEntries([["a", 1], ["b", 2]]); return [Object.values(o).join("+"), Object.assign({}, o, { c: 3 }).c, "a-b-c".replaceAll("-", "/"), "xyz".at(-1), Number.isInteger(5), String(Symbol("s").description)]'],
  ['Promise combinators', 'const r = await Promise.allSettled([Promise.resolve(1), Promise.reject(new Error("x"))]); const any = await Promise.any([Promise.reject(1), Promise.resolve(7)]); return r.map(x => x.status).join(",") + ":" + any'],
  ['generator + iterator', 'function* g() { yield 1; yield 2; yield 3 } return [...g()].reduce((a, b) => a + b, 0)'],
  ['async generator', 'async function* g() { yield 1; yield 2 } const out = []; for await (const v of g()) out.push(v); return out'],
  ['Map/Set iteration', 'const m = new Map(); m.set("a", 1).set("b", 2); const keys = [...m.keys()]; const s = new Set("hello"); return keys.join("") + s.size + [...m.entries()].length'],
  ['class without constructor', 'class C {} return typeof new C()'],
  ['class fields', 'class C { x = 1; y = this.x + 1 } const c = new C(); return c.x + c.y'],
  ['static method', 'class C { static make() { return new C() } hi() { return "hi" } } return C.make().hi()'],
  ['extends without constructor', 'class A { constructor() { this.a = 1 } } class B extends A { b = 2 } const o = new B(); return o.a + o.b'],
  ['getter/setter + private', 'class C { #x = 1; get x() { return this.#x } set x(v) { this.#x = v } } const c = new C(); c.x = 5; return c.x'],
  ['class expression', 'const K = class { v() { return 7 } }; return new K().v()'],
  ['class in async code', 'class C { x = 1 } class D extends C {} const t = await tools.read({ file_path: "q" }); return new D().x + t.length'],
  ['sync body returning promise', 'return tools.read({ file_path: "p" })'],
  ['sort + localeCompare', 'return ["b", "a", "c"].sort((x, y) => x.localeCompare(y)).join("")'],
  ['text processing', 'const t = "line1\\nline2\\n\\nline4"; return t.split("\\n").filter(Boolean).map((l, i) => `${i + 1}:${l.trim()}`).join(",")'],
  ['perf 100k loop', 'let s = 0; for (let i = 0; i < 100000; i++) s += i % 7; return s'],
]

let failures = 0
for (const [name, code] of cases) {
  const started = Date.now()
  const r = await run(code, {
    read: a => 'content of ' + a.file_path,
    fail: () => { throw new Error('tool exploded') },
  })
  const ms = Date.now() - started
  const ok = r.type === 'done'
  const expectedError = name === 'thrown error'
  const pass = expectedError ? r.type === 'error' && /boom/.test(r.error) : ok
  if (!pass) failures++
  console.log(`${pass ? '✓' : '✗'} ${name.padEnd(28)} ${r.type}: ${String(r.type === 'done' ? r.value : r.error || '').replace(/\n/g, ' ').slice(0, 140)}${r.logs && r.logs.length ? '  logs=' + JSON.stringify(r.logs) : ''}  (${ms} ms)`)
}
console.log(failures ? `${failures} failing` : 'all passing', '| built-ins removed before load:', (await run('return 1')).missingBefore)
process.exit(failures ? 1 : 0)
