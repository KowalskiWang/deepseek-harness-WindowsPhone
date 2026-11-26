// run_code compatibility cases, shared by the IE11 simulation
// (tests/ie11-worker-sim.mjs) and the on-device self-test.
//   expect: the result text run_code shows the model (strings as-is,
//           other values in the sandbox's inspect format)
//   error:  pattern the error message must match (the run must fail)
// The tools below are the stand-ins both harnesses expose to the sandbox.

export const SANDBOX_TOOLS = {
  read: a => 'content of ' + a.file_path,
  fail: () => { throw new Error('tool exploded') },
}

export const SANDBOX_CASES = [
  { name: 'arithmetic', code: 'return 1 + 1', expect: '2' },
  { name: 'loop sum', code: 'let s = 0; for (let i = 1; i <= 100; i++) s += i; return s', expect: '5050' },
  { name: 'arrow + reduce', code: 'return [1, 2, 3].map(x => x * 2).reduce((a, b) => a + b, 0)', expect: '12' },
  { name: 'object result', code: 'const xs = [1, 2, 3]; return { xs, sum: xs.reduce((a, b) => a + b, 0), ok: true }', expect: '{ xs: [ 1, 2, 3 ], sum: 6, ok: true }' },
  { name: 'console.log', code: 'console.log("hello", 42, { a: 1 }); return "done"', expect: 'done', logs: /hello 42/ },
  { name: 'template + destructuring', code: 'const { a, b = 2 } = { a: 1 }; const [x, ...rest] = [1, 2, 3]; return `${a}-${b}-${x}-${rest.length}`', expect: '1-2-1-2' },
  { name: 'for-of + spread + Set', code: 'const out = []; for (const v of [3, 1, 2]) out.push(v); return [...new Set([...out, 1])].sort()', expect: '[ 1, 2, 3 ]' },
  { name: 'Map + Object.entries', code: 'const m = new Map([["k", 1]]); return Object.entries({ a: 1, b: 2 }).length + m.get("k")', expect: '3' },
  { name: 'class', code: 'class P { constructor(n) { this.n = n } get twice() { return this.n * 2 } }; return new P(21).twice', expect: '42' },
  { name: 'async/await tool', code: 'const t = await tools.read({ file_path: "a.txt" }); return t.toUpperCase()', expect: 'CONTENT OF A.TXT' },
  { name: 'await in loop', code: 'const r = []; for (const f of ["a", "b"]) r.push(await tools.read({ file_path: f })); return r.join("|")', expect: 'content of a|content of b' },
  { name: 'Promise.all tools', code: 'const r = await Promise.all(["x", "y"].map(f => tools.read({ file_path: f }))); return r', expect: '[ "content of x", "content of y" ]' },
  { name: 'try/catch tool error', code: 'try { await tools.fail({}) } catch (e) { return "caught: " + e.message }', expect: 'caught: tool exploded' },
  { name: 'thrown error', code: 'throw new TypeError("boom")', error: /boom/ },
  { name: 'JSON + regex', code: 'return JSON.stringify("a1b22c333".match(/\\d+/g))', expect: '["1","22","333"]' },
  { name: 'string methods', code: 'return "abc".padStart(5, "-") + "x".repeat(3) + ("hello".includes("ell") ? "Y" : "N")', expect: '--abcxxxY' },
  { name: 'optional chaining / nullish', code: 'const o = { a: { b: null } }; return (o.a?.b ?? "dflt") + (o.z?.q ?? "")', expect: 'dflt' },
  { name: 'Date + Math', code: 'return [typeof Date.now(), Math.max(...[1, 5, 3]), Math.trunc(4.7)]', expect: '[ "number", 5, 4 ]' },
  { name: 'newer array methods', code: 'const a = [3, 1, 2]; return [a.includes(2), a.find(x => x > 1), [[1], [2, [3]]].flat(2).length, a.at(-1), a.toSorted().join(""), Array.from({ length: 3 }, (_, i) => i * i)]', expect: '[ true, 3, 3, 2, "123", [ 0, 1, 4 ] ]' },
  { name: 'newer object/string methods', code: 'const o = Object.fromEntries([["a", 1], ["b", 2]]); return [Object.values(o).join("+"), Object.assign({}, o, { c: 3 }).c, "a-b-c".replaceAll("-", "/"), "xyz".at(-1), Number.isInteger(5), String(Symbol("s").description)]', expect: '[ "1+2", 3, "a/b/c", "z", true, "s" ]' },
  { name: 'Promise combinators', code: 'const r = await Promise.allSettled([Promise.resolve(1), Promise.reject(new Error("x"))]); const any = await Promise.any([Promise.reject(1), Promise.resolve(7)]); return r.map(x => x.status).join(",") + ":" + any', expect: 'fulfilled,rejected:7' },
  { name: 'generator + iterator', code: 'function* g() { yield 1; yield 2; yield 3 } return [...g()].reduce((a, b) => a + b, 0)', expect: '6' },
  { name: 'async generator', code: 'async function* g() { yield 1; yield 2 } const out = []; for await (const v of g()) out.push(v); return out', expect: '[ 1, 2 ]' },
  { name: 'Map/Set iteration', code: 'const m = new Map(); m.set("a", 1).set("b", 2); const keys = [...m.keys()]; const s = new Set("hello"); return keys.join("") + s.size + [...m.entries()].length', expect: 'ab42' },
  { name: 'class without constructor', code: 'class C {} return typeof new C()', expect: 'object' },
  { name: 'class fields', code: 'class C { x = 1; y = this.x + 1 } const c = new C(); return c.x + c.y', expect: '3' },
  { name: 'static method', code: 'class C { static make() { return new C() } hi() { return "hi" } } return C.make().hi()', expect: 'hi' },
  { name: 'extends without constructor', code: 'class A { constructor() { this.a = 1 } } class B extends A { b = 2 } const o = new B(); return o.a + o.b', expect: '3' },
  { name: 'getter/setter + private', code: 'class C { #x = 1; get x() { return this.#x } set x(v) { this.#x = v } } const c = new C(); c.x = 5; return c.x', expect: '5' },
  { name: 'class expression', code: 'const K = class { v() { return 7 } }; return new K().v()', expect: '7' },
  { name: 'class in async code', code: 'class C { x = 1 } class D extends C {} const t = await tools.read({ file_path: "q" }); return new D().x + t.length', expect: '13' },
  { name: 'sync body returning promise', code: 'return tools.read({ file_path: "p" })', expect: 'content of p' },
  { name: 'sort + localeCompare', code: 'return ["b", "a", "c"].sort((x, y) => x.localeCompare(y)).join("")', expect: 'abc' },
  { name: 'text processing', code: 'const t = "line1\\nline2\\n\\nline4"; return t.split("\\n").filter(Boolean).map((l, i) => `${i + 1}:${l.trim()}`).join(",")', expect: '1:line1,2:line2,3:line4' },
  { name: 'perf 100k loop', code: 'let s = 0; for (let i = 0; i < 100000; i++) s += i % 7; return s', expect: '299995' },
]

/** Compare a run result {value, error, logs} with a case; returns null when it passes, else the reason. */
export function checkSandboxCase(c, r) {
  if (c.error) {
    if (r.error === undefined) return 'expected an error, got ' + safeJson(r.value)
    return c.error.test(String(r.error)) ? null : 'wrong error: ' + r.error
  }
  if (r.error !== undefined) return 'error: ' + r.error
  const got = typeof r.value === 'string' ? r.value : safeJson(r.value)
  if (got !== c.expect) return 'expected ' + c.expect + ', got ' + got
  if (c.logs && !c.logs.test((r.logs || []).join('\n'))) return 'console output missing: ' + safeJson(r.logs)
  return null
}

function safeJson(v) {
  try { return JSON.stringify(v) } catch (e) { return String(v) }
}
