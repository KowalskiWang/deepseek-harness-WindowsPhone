// apply_patch: the "*** Begin Patch" envelope format (upstream tool-fs apply-patch.ts).
import { resolve } from '../paths.js'
import { textOutput, errorOutput } from './runtime.js'
import { unifiedDiff } from '../diff.js'

function parsePatch(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  const problems = []
  if (!lines.length || lines[0].trim() !== '*** Begin Patch') problems.push({ line: 1, msg: 'patch must start with *** Begin Patch' })
  if (!lines.length || lines[lines.length - 1].trim() !== '*** End Patch') problems.push({ line: lines.length, msg: 'patch must end with *** End Patch' })
  const ops = []
  let i = 1
  let cur = null
  let hunk = null
  const end = lines.length - 1
  while (i < end) {
    const l = lines[i]
    let m
    if ((m = /^\*\*\* Add File: (.+)$/.exec(l))) { cur = { kind: 'add', path: m[1].trim(), lines: [], line: i + 1 }; ops.push(cur); hunk = null }
    else if ((m = /^\*\*\* Delete File: (.+)$/.exec(l))) { cur = { kind: 'delete', path: m[1].trim(), line: i + 1 }; ops.push(cur); hunk = null }
    else if ((m = /^\*\*\* Update File: (.+)$/.exec(l))) { cur = { kind: 'update', path: m[1].trim(), hunks: [], line: i + 1 }; ops.push(cur); hunk = null }
    else if ((m = /^\*\*\* Move to: (.+)$/.exec(l))) {
      if (!cur || cur.kind !== 'update') problems.push({ line: i + 1, msg: '*** Move to must follow *** Update File' })
      else cur.moveTo = m[1].trim()
    } else if (l.trim() === '*** End of File') {
      if (hunk) hunk.eof = true
    } else if (/^@@/.test(l)) {
      if (!cur || cur.kind !== 'update') problems.push({ line: i + 1, msg: '@@ hunk outside *** Update File' })
      else { hunk = { header: l.replace(/^@@\s?/, '').trim(), lines: [], line: i + 1 }; cur.hunks.push(hunk) }
    } else if (cur && cur.kind === 'add') {
      if (l.charAt(0) === '+') cur.lines.push(l.slice(1))
      else problems.push({ line: i + 1, msg: 'lines of an added file must start with +' })
    } else if (cur && cur.kind === 'update') {
      if (!hunk) { hunk = { header: '', lines: [], line: i + 1 }; cur.hunks.push(hunk) }
      const op = l.charAt(0)
      if (op === ' ' || op === '-' || op === '+') hunk.lines.push({ op, text: l.slice(1) })
      else if (l === '') hunk.lines.push({ op: ' ', text: '' })
      else problems.push({ line: i + 1, msg: `unexpected line in hunk: ${l.slice(0, 40)}` })
    } else if (l.trim() !== '') problems.push({ line: i + 1, msg: `unexpected line: ${l.slice(0, 40)}` })
    i++
  }
  return { ops, problems }
}

function findSeq(haystack, needle, from, eof) {
  if (!needle.length) return eof ? haystack.length : from
  const tryMatch = (norm) => {
    const start = eof ? haystack.length - needle.length : from
    for (let s = Math.max(0, start); s <= haystack.length - needle.length; s++) {
      let ok = true
      for (let k = 0; k < needle.length; k++) if (norm(haystack[s + k]) !== norm(needle[k])) { ok = false; break }
      if (ok) return s
      if (eof) break
    }
    return -1
  }
  const levels = [s => s, s => s.replace(/\s+$/, ''), s => s.trim()]
  for (const norm of levels) {
    const at = tryMatch(norm)
    if (at >= 0) return at
  }
  return -1
}

function applyHunks(content, hunks) {
  const hadTrailingNl = /\n$/.test(content)
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  if (hadTrailingNl) lines.pop()
  let pos = 0
  const out = lines.slice()
  let delta = 0
  for (const h of hunks) {
    if (h.header) {
      const hi = findSeq(lines, [h.header], pos, false)
      if (hi >= 0) pos = hi + 1
    }
    const oldLines = h.lines.filter(l => l.op !== '+').map(l => l.text)
    const newLines = h.lines.filter(l => l.op !== '-').map(l => l.text)
    const at = findSeq(lines, oldLines, pos, h.eof)
    if (at < 0) return { error: `hunk${h.header ? ` "@@ ${h.header}"` : ''} did not match the current file` }
    out.splice(at + delta, oldLines.length, ...newLines)
    delta += newLines.length - oldLines.length
    pos = at + oldLines.length
  }
  return { text: out.join('\n') + (hadTrailingNl || out.length ? '\n' : '') }
}

export async function applyPatchText(input, exec, checkWrite) {
  const { ops, problems } = parsePatch(input)
  const report = []
  for (const p of problems) report.push(`- patch line ${p.line}: ${p.msg}`)
  const plan = []
  for (let idx = 0; idx < ops.length; idx++) {
    const op = ops[idx]
    const path = resolve(exec.cwd, op.path)
    const st = await exec.vfs.stat(path)
    const where = `operation ${idx + 1} (${op.kind} ${op.path}, patch line ${op.line})`
    if (op.kind === 'add') {
      if (st) { report.push(`- ${where}: file already exists`); continue }
      plan.push({ op, path, text: op.lines.join('\n') + (op.lines.length ? '\n' : '') })
    } else if (op.kind === 'delete') {
      if (!st || st.type !== 'file') { report.push(`- ${where}: file not found`); continue }
      plan.push({ op, path })
    } else {
      if (!st || st.type !== 'file') { report.push(`- ${where}: file not found`); continue }
      let content
      try { content = await exec.vfs.readText(path) } catch (e) { report.push(`- ${where}: ${e.message}`); continue }
      const r = applyHunks(content, op.hunks)
      if (r.error) { report.push(`- ${where}: ${r.error}`); continue }
      plan.push({ op, path, before: content, text: r.text, moveTo: op.moveTo ? resolve(exec.cwd, op.moveTo) : null })
    }
  }
  if (report.length) return errorOutput(`Patch rejected before any change (${report.length} problems):\n${report.join('\n')}`, 'PATCH_REJECTED')
  if (!plan.length) return textOutput('Success. No operations in patch.')
  const allPaths = []
  for (const p of plan) { allPaths.push(p.path); if (p.moveTo) allPaths.push(p.moveTo) }
  const denied = await checkWrite(allPaths)
  if (denied) return denied
  const done = [], diffs = []
  for (let k = 0; k < plan.length; k++) {
    const p = plan[k]
    try {
      if (p.op.kind === 'add') { await exec.vfs.writeText(p.path, p.text); done.push('A ' + p.op.path); diffs.push(unifiedDiff(p.path, '', p.text)) }
      else if (p.op.kind === 'delete') { await exec.vfs.remove(p.path); done.push('D ' + p.op.path) }
      else {
        await exec.vfs.writeText(p.moveTo || p.path, p.text)
        if (p.moveTo && p.moveTo !== p.path) await exec.vfs.remove(p.path)
        done.push('M ' + (p.op.moveTo || p.op.path))
        diffs.push(unifiedDiff(p.moveTo || p.path, p.before, p.text))
      }
      if (exec.noteWrite) exec.noteWrite(p.moveTo || p.path)
    } catch (e) {
      const notRun = plan.slice(k + 1).map(q => `${q.op.kind} ${q.op.path}`)
      return errorOutput(`Patch stopped after ${k} of ${plan.length} operations.\nCompleted:\n${done.join('\n') || '(none)'}\nFailed:\n${p.op.kind} ${p.op.path}: ${e.message}\nOutcome unknown:\n(none)\nNot executed:\n${notRun.join('\n') || '(none)'}`, 'PATCH_PARTIAL')
    }
  }
  const added = diffs.reduce((n, d) => n + d.added, 0)
  const removed = diffs.reduce((n, d) => n + d.removed, 0)
  return textOutput(`Success. Updated the following files:\n${done.join('\n')}`, { display: { kind: 'patch', files: done, added, removed, diffs: diffs.map(d => ({ path: d.path, added: d.added, removed: d.removed, diff: d.text.length < 40000 ? d.text : '' })) } })
}
