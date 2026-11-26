// Build DSH Mobile: one ES5 bundle for IE11 (Windows Phone 8.1) and newer engines,
// emitted twice: dist/web (LAN web build served by the gateway) and dist/appx
// (package layout for the Windows Phone 8.1 / Windows 10 Mobile APPX).
//
//   node scripts/build.mjs          production build (minified)
//   node scripts/build.mjs --dev    readable output, no minification
import { rollup } from 'rollup'
import { babel } from '@rollup/plugin-babel'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import terser from '@rollup/plugin-terser'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { themes } from '../src/styles/tokens.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dev = process.argv.includes('--dev')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const BUILD_ID = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')

// polyfills: 'usage' injects only what the bundle's own code uses (the app);
// 'entry' expands `import 'core-js/stable'` into every ES feature IE11 lacks —
// needed by the run_code sandbox, which executes arbitrary model-written code.
function babelPlugin(polyfills = 'usage') {
  return babel({
    babelHelpers: 'bundled',
    extensions: ['.js', '.jsx', '.mjs'],
    exclude: [/node_modules[\\/]core-js/, /node_modules[\\/]regenerator-runtime/],
    babelrc: false,
    configFile: false,
    presets: [['@babel/preset-env', {
      targets: { ie: '11' },
      useBuiltIns: polyfills,
      corejs: '3.51',
      modules: false,
      bugfixes: true,
      // Keep IE11's native typed arrays: core-js would replace the global
      // Uint8Array/ArrayBuffer with wrapper constructors on IE11, and host APIs
      // (msCrypto, Windows Runtime FileIO/DataReader) reject the wrapped objects
      // with "Invalid argument". The app only uses features IE11 has natively.
      exclude: [/^(es|esnext)\.typed-array\./, /^(es|esnext)\.array-buffer\./, /^(es|esnext)\.data-view/, /^(es|esnext)\.uint8-array\./],
    }]],
    plugins: [['@babel/plugin-transform-react-jsx', { pragma: 'h', pragmaFrag: 'Fragment' }]],
  })
}

// Build-time patches for sval 0.6.12 (the run_code interpreter). Each patch must
// match exactly `count` times, so an sval upgrade fails the build loudly.
const SVAL_PATCHES = [
  {
    // Inside async functions/generators (sval's generator evaluator) a class
    // without an explicit constructor gets `function* () {…}` as its default
    // constructor, which `new` cannot call ("r is not a constructor"). run_code
    // wraps every program in an async function, so build a plain function that
    // drives the field-initializer generator to completion instead.
    name: 'default constructor in generator evaluator',
    count: 1,
    bug: /let a = function\* \(\) \{\s*const n = r \? tt\(this, r\) : this;\s*return yield\* s\(n\), n;\s*\};/g,
    fix: 'let a = function () {\n    const n = r ? tt(this, r) : this;\n    const g = s(n);\n    for (let x = g.next(); !x.done; x = g.next()) ;\n    return n;\n  };',
  },
  {
    // IE11 (Chakra) keeps ES5 semantics: a function's own `length` is
    // non-configurable, so sval's Object.defineProperty(f, "length", …) on every
    // interpreted function throws "Cannot redefine non-configurable property
    // 'length'" (seen on a Lumia 1020). Arity is cosmetic: skip it there.
    name: 'function length on ES5 engines',
    count: 2,
    bug: /w\(f, "length", \{\s*value: a\.length,\s*configurable: !0\s*\}\)/g,
    fix: '(function () { try { w(f, "length", { value: a.length, configurable: !0 }) } catch (_e) { /* ES5: non-configurable */ } })()',
  },
]

function patchSval() {
  return {
    name: 'patch-sval',
    transform(code, id) {
      if (!/[\\/]sval[\\/]dist[\\/]sval\.js$/.test(id)) return null
      let out = code
      for (const p of SVAL_PATCHES) {
        const hits = (out.match(p.bug) || []).length
        if (hits !== p.count) this.error(`sval patch "${p.name}": expected ${p.count} match(es), found ${hits} — re-check the patch against the installed sval`)
        out = out.replace(p.bug, p.fix)
      }
      return { code: out, map: null }
    },
  }
}

async function bundle(input, outFile, globals = {}) {
  const plugins = [
    nodeResolve({ extensions: ['.js', '.jsx', '.mjs'], browser: true }),
    commonjs(),
    patchSval(),
    babelPlugin(globals.polyfills),
  ]
  if (!dev) plugins.push(terser({ ecma: 5, safari10: false, ie8: false, format: { comments: false }, compress: { passes: 2 } }))
  const build = await rollup({
    input,
    plugins,
    onwarn(warning, warn) {
      if (warning.code === 'CIRCULAR_DEPENDENCY' && /node_modules/.test(warning.message)) return
      if (warning.code === 'THIS_IS_UNDEFINED') return
      warn(warning)
    },
  })
  await build.write({
    file: outFile,
    format: 'iife',
    inlineDynamicImports: true,
    name: globals.name,
    sourcemap: false,
    banner: `/* DSH Mobile ${pkg.version} (${BUILD_ID}) — MIT. Ported from DeepSeek Harness (MIT, (c) 2026 DeepSeek). */`,
    intro: `var __DSH_VERSION__ = ${JSON.stringify(pkg.version)}; var __DSH_BUILD__ = ${JSON.stringify(BUILD_ID)};`,
  })
  await build.close()
}

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }) }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }) }
function copyDir(src, dst, filter = () => true) {
  mkdirp(dst)
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name.startsWith('._') || entry.name === '.DS_Store') continue
    const s = path.join(src, entry.name)
    const d = path.join(dst, entry.name)
    if (!filter(s)) continue
    if (entry.isDirectory()) copyDir(s, d, filter)
    else fs.copyFileSync(s, d)
  }
}
function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('._') || entry.name === '.DS_Store') continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, base, out)
    else out.push(path.relative(base, p).split(path.sep).join('/'))
  }
  return out
}

// CSS custom properties do not exist in IE11, so every theme is compiled to a
// static stylesheet and the app swaps <link href> to change themes.
function buildThemes(outDir) {
  const source = fs.readFileSync(path.join(root, 'src/styles/app.css'), 'utf8')
  mkdirp(outDir)
  for (const [name, tokens] of Object.entries(themes)) {
    const css = source.replace(/var\(--([a-z0-9-]+)\)/g, (m, key) => {
      if (!(key in tokens)) throw new Error(`theme ${name}: missing token --${key}`)
      return tokens[key]
    })
    fs.writeFileSync(path.join(outDir, `theme-${name}.css`), css)
  }
}

async function main() {
  const t0 = Date.now()
  const web = path.join(root, 'dist/web')
  const appx = path.join(root, 'dist/appx')
  rmrf(web); rmrf(appx)
  mkdirp(path.join(web, 'js'))

  await bundle(path.join(root, 'src/main.js'), path.join(web, 'js/app.js'))
  await bundle(path.join(root, 'src/sandbox/worker.js'), path.join(web, 'js/sandbox-worker.js'), { polyfills: 'entry' })
  buildThemes(path.join(web, 'css'))
  copyDir(path.join(root, 'src/static'), web)
  copyDir(path.join(root, 'assets/img'), path.join(web, 'img'))

  // index.html: the web build gets an AppCache manifest so the pinned tile
  // keeps working when the gateway is briefly offline; the APPX build must not.
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8')
    .replace(/__BUILD__/g, BUILD_ID).replace(/__VERSION__/g, pkg.version)
  fs.writeFileSync(path.join(web, 'index.html'), html.replace('<html', '<html manifest="dsh.appcache"'))

  // --- APPX layout (same files, no AppCache, plus manifest and tile images)
  copyDir(web, appx)
  fs.writeFileSync(path.join(appx, 'index.html'), html)
  const manifest = fs.readFileSync(path.join(root, 'appx/AppxManifest.xml'), 'utf8')
    .replace(/__VERSION__/g, toAppxVersion(pkg.version))
  fs.writeFileSync(path.join(appx, 'AppxManifest.xml'), manifest)
  copyDir(path.join(root, 'assets/tiles'), path.join(appx, 'images'))
  // web-only files (pinned-site tiles, AppCache) do not belong in the package
  rmrf(path.join(appx, 'browserconfig.xml'))
  rmrf(path.join(appx, 'img'))
  rmrf(path.join(appx, 'dsh.appcache'))

  // --- AppCache manifest for the web build (hash changes whenever a file changes)
  const files = walk(web).filter(f => f !== 'dsh.appcache')
  const hash = crypto.createHash('sha256')
  for (const f of files.sort()) hash.update(f).update(fs.readFileSync(path.join(web, f)))
  fs.writeFileSync(path.join(web, 'dsh.appcache'), [
    'CACHE MANIFEST',
    `# ${pkg.version} ${hash.digest('hex').slice(0, 16)}`,
    '',
    'CACHE:',
    ...files.filter(f => f !== 'index.html' && !f.startsWith('download/')),
    '',
    'NETWORK:',
    '*',
    '',
  ].join('\n'))

  const size = f => (fs.statSync(path.join(web, f)).size / 1024).toFixed(1) + ' KiB'
  console.log(`built ${dev ? 'dev' : 'prod'} ${BUILD_ID} in ${Date.now() - t0} ms — app.js ${size('js/app.js')}, worker ${size('js/sandbox-worker.js')}`)
}

function toAppxVersion(v) {
  const nums = v.split(/[.-]/).map(n => parseInt(n, 10)).filter(n => !Number.isNaN(n))
  while (nums.length < 4) nums.push(0)
  // APPX_REVISION sets the fourth part, so device test builds install over each other
  if (process.env.APPX_REVISION) nums[3] = parseInt(process.env.APPX_REVISION, 10) || 0
  return nums.slice(0, 4).join('.')
}

main().catch((e) => { console.error(e); process.exit(1) })
