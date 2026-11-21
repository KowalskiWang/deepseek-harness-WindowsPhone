// Workspace instructions (upstream dsh-agent-instructions): AGENTS.md / CLAUDE.md
// (+ .local overlays) from the user-global file and from the project root down to
// the session directory, delivered as a durable <system-reminder> user message.
import { join, dirname, isWithin, normalize } from './paths.js'
import { utf8Length, truncateUtf8 } from './util.js'

const CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']
const INTRO = 'The following workspace instructions may be relevant to your work. '
  + 'Use them as guidance when applicable. More specific instructions take precedence over broader ones. '
  + 'They do not override system, developer, or direct user instructions.'
const REPLACEMENT_INTRO = 'This complete workspace instruction baseline replaces all earlier workspace instruction baselines. ' + INTRO
const EMPTY_REPLACEMENT = 'This complete workspace instruction baseline replaces all earlier workspace instruction baselines. No workspace instructions are currently active.'
const MAX_FILE = 1024 * 1024

/** Nearest ancestor of cwd (within the workspace) that contains .git, else the workspace root. */
export async function findProjectRoot(vfs, cwd, workspaceRoot) {
  let dir = normalize(cwd)
  while (true) {
    if (await vfs.exists(join(dir, '.git'))) return dir
    if (!workspaceRoot || dir === normalize(workspaceRoot) || dir === '/') break
    if (!isWithin(workspaceRoot, dir)) break
    dir = dirname(dir)
  }
  return workspaceRoot || cwd
}

async function readCandidates(vfs, dir) {
  const out = []
  for (const name of CANDIDATES) {
    const p = join(dir, name)
    try {
      const st = await vfs.stat(p)
      if (!st || st.type !== 'file' || st.size > MAX_FILE) continue
      out.push({ path: p, content: await vfs.readText(p) })
    } catch (e) { /* unreadable */ }
  }
  return out
}

function budgetChain(files, maxBytes, notices) {
  let total = files.reduce((n, f) => n + utf8Length(f.content), 0)
  const kept = files.slice()
  while (total > maxBytes && kept.length > 1) {
    const dropped = kept.shift() // broadest first
    total -= utf8Length(dropped.content)
    notices.push(`omitted ${dropped.path}`)
  }
  if (total > maxBytes && kept.length) {
    const f = kept[0]
    const cut = truncateUtf8(f.content, maxBytes)
    notices.push(`truncated ${f.path} to ${utf8Length(cut)} of ${utf8Length(f.content)} bytes`)
    kept[0] = { path: f.path, content: cut }
  }
  return kept
}

/** Load the baseline: user-global chain, then project root → cwd. */
export async function loadInstructions(vfs, { cwd, workspaceRoot, maxBytes = 65536 }) {
  const user = await readCandidates(vfs, '/app')
  const projectRoot = await findProjectRoot(vfs, cwd, workspaceRoot)
  const dirs = []
  let d = normalize(cwd)
  while (true) {
    dirs.unshift(d)
    if (d === projectRoot || d === '/' || !isWithin(projectRoot, d)) break
    d = dirname(d)
  }
  let project = []
  for (const dir of dirs) project = project.concat(await readCandidates(vfs, dir))
  const seen = {}
  const dedupe = files => files.filter((f) => {
    const key = f.content.trim()
    if (!key || seen[key]) return !!key && false
    seen[key] = true
    return true
  })
  const notices = []
  const files = budgetChain(dedupe(user), maxBytes, notices).concat(budgetChain(dedupe(project), maxBytes, notices))
  return { files, notices, projectRoot, dirs }
}

export function instructionSignature(baseline) {
  return baseline.files.map(f => f.path + '\u0000' + f.content).join('\u0001')
}

export function renderInstructions(baseline, replacement, maxBytes = 65536) {
  if (!baseline.files.length) return replacement ? `<system-reminder>\n${EMPTY_REPLACEMENT}\n</system-reminder>` : ''
  const body = baseline.files.map(f => `Instructions from: ${f.path}\n\n${f.content.replace(/<\/system-reminder\s*>/gi, t => '<\\' + t.slice(1))}`).join('\n\n')
  const notice = baseline.notices.length ? `\n\nWorkspace instruction budget ${maxBytes} bytes: ${baseline.notices.join('; ')}` : ''
  return `<system-reminder>\n${replacement ? REPLACEMENT_INTRO : INTRO}\n\n${body}${notice}\n</system-reminder>`
}

/** Instructions found in a directory reached later by read/write/edit (deeper than cwd). */
export async function additionalInstructions(vfs, dir) {
  const files = await readCandidates(vfs, dir)
  if (!files.length) return ''
  return '<system-reminder>\n' + files.map(f => `Additional instructions from: ${f.path}\n\n${f.content}`).join('\n\n') + '\n</system-reminder>'
}
