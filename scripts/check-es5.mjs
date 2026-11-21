// Verify that the shipped bundles parse as ECMAScript 5 — the language level of
// the IE11/Trident engine that runs HTML apps on Windows Phone 8.1 — and that no
// regular expression literal uses flags IE11 lacks (u, y, s).
import { parse } from 'acorn'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = ['dist/web/js/app.js', 'dist/web/js/sandbox-worker.js']
let failed = false

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return
  visit(node)
  for (const key in node) {
    if (key === 'loc' || key === 'start' || key === 'end') continue
    const v = node[key]
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c, visit) }
    else if (v && typeof v.type === 'string') walk(v, visit)
  }
}

for (const rel of files) {
  const code = fs.readFileSync(path.join(root, rel), 'utf8')
  let ast
  try {
    ast = parse(code, { ecmaVersion: 5, sourceType: 'script', allowReserved: true })
  } catch (e) {
    failed = true
    const line = code.split('\n')[(e.loc && e.loc.line ? e.loc.line : 1) - 1] || ''
    const col = e.loc ? e.loc.column : 0
    console.error(`✗ ${rel}: ${e.message}\n  …${line.slice(Math.max(0, col - 80), col + 80)}…`)
    continue
  }
  const bad = []
  walk(ast, (n) => {
    if (n.type === 'Literal' && n.regex && /[suy]/.test(n.regex.flags)) bad.push(`/${n.regex.pattern.slice(0, 40)}/${n.regex.flags}`)
    if (n.type === 'NewExpression' && n.callee && n.callee.name === 'RegExp' && n.arguments[1] && n.arguments[1].type === 'Literal' && /[suy]/.test(String(n.arguments[1].value))) bad.push('new RegExp(…, "' + n.arguments[1].value + '")')
  })
  if (bad.length) {
    failed = true
    console.error(`✗ ${rel}: regex flags unsupported by IE11:\n  ` + bad.slice(0, 10).join('\n  '))
  } else console.log(`✓ ${rel} is ES5 with IE11-safe regex literals (${(code.length / 1024).toFixed(1)} KiB)`)
}
process.exit(failed ? 1 : 0)
