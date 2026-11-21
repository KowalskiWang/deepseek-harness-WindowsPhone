// POSIX-style virtual paths. Every file the agent can reach lives under one
// absolute virtual tree:
//   /workspaces/<name>/…   app-local workspace folders
//   /mnt/<id>/…            device folders picked by the user (Windows Runtime)
//   /app/…                 app data (sessions, settings, skills, spill)
//   /tmp/…                 scratch space (always writable)

export function normalize(p) {
  const abs = p.charAt(0) === '/'
  const parts = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') { if (parts.length && parts[parts.length - 1] !== '..') parts.pop(); else if (!abs) parts.push('..') }
    else parts.push(seg)
  }
  const s = parts.join('/')
  return abs ? '/' + s : (s || '.')
}

export function join(...parts) { return normalize(parts.filter(Boolean).join('/')) }

export function isAbsolute(p) { return typeof p === 'string' && p.charAt(0) === '/' }

/** Resolve a possibly-relative path against a working directory. Windows-style separators are accepted. */
export function resolve(cwd, p) {
  let s = String(p == null ? '' : p).replace(/\\/g, '/')
  if (/^[a-zA-Z]:\//.test(s)) s = '/' + s.slice(3) // tolerate "C:/x" from Windows-minded models
  if (s === '~' || s.indexOf('~/') === 0) s = cwd + s.slice(1)
  return isAbsolute(s) ? normalize(s) : normalize(cwd + '/' + s)
}

export function dirname(p) {
  const n = normalize(p)
  const i = n.lastIndexOf('/')
  if (i <= 0) return n.charAt(0) === '/' ? '/' : '.'
  return n.slice(0, i)
}

export function basename(p) {
  const n = normalize(p)
  return n.slice(n.lastIndexOf('/') + 1)
}

export function extname(p) {
  const b = basename(p)
  const i = b.lastIndexOf('.')
  return i > 0 ? b.slice(i).toLowerCase() : ''
}

export function isWithin(root, p) {
  const r = normalize(root)
  const n = normalize(p)
  return n === r || n.indexOf(r === '/' ? '/' : r + '/') === 0
}

export function relative(from, to) {
  const f = normalize(from).split('/').filter(Boolean)
  const t = normalize(to).split('/').filter(Boolean)
  let i = 0
  while (i < f.length && i < t.length && f[i] === t[i]) i++
  const up = f.slice(i).map(() => '..')
  const rel = up.concat(t.slice(i)).join('/')
  return rel || '.'
}

/** Display a path relative to cwd when inside it, absolute otherwise (glob/grep output rule). */
export function displayPath(cwd, p) {
  return isWithin(cwd, p) ? relative(cwd, p) : normalize(p)
}

// ---------------------------------------------------------------- globs

const reEscape = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')

/**
 * Compile a glob (ripgrep/gitignore flavour: *, **, ?, [...], {a,b}) to a RegExp
 * matched against a "/"-separated relative path.
 */
export function globToRegExp(glob, { dot = true } = {}) {
  let i = 0
  let re = ''
  const braceStack = []
  while (i < glob.length) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "**/" → zero or more directories; trailing "**" → anything
        const atSegStart = i === 0 || glob[i - 1] === '/'
        if (glob[i + 2] === '/' && atSegStart) { re += '(?:[^/]*(?:/|$))*'; i += 3; continue }
        if (i + 2 === glob.length && atSegStart) { re += '.*'; i += 2; continue }
        re += '[^/]*'; i += 2; continue
      }
      re += dot ? '[^/]*' : '(?!\\.)[^/]*'
      i++
    } else if (c === '?') { re += '[^/]'; i++ }
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1)
      if (end < 0) { re += '\\['; i++; continue }
      let cls = glob.slice(i + 1, end)
      if (cls[0] === '!') cls = '^' + cls.slice(1)
      re += '[' + cls.replace(/\\/g, '\\\\') + ']'
      i = end + 1
    } else if (c === '{') { braceStack.push(re.length); re += '(?:'; i++ }
    else if (c === '}' && braceStack.length) { braceStack.pop(); re += ')'; i++ }
    else if (c === ',' && braceStack.length) { re += '|'; i++ }
    else if (c === '\\' && i + 1 < glob.length) { re += reEscape(glob[i + 1]); i += 2 }
    else { re += reEscape(c); i++ }
  }
  return new RegExp('^' + re + '$')
}

/**
 * Upstream glob rule: a pattern with no "/" matches the basename at any depth.
 * Returns a predicate over paths relative to the search root.
 */
export function globMatcher(pattern) {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '')
  if (p.indexOf('/') < 0) {
    const re = globToRegExp(p)
    return (rel) => re.test(rel.slice(rel.lastIndexOf('/') + 1))
  }
  const anchored = p.charAt(0) === '/' ? p.slice(1) : p
  const re = globToRegExp(anchored)
  return (rel) => re.test(rel)
}

export const VCS_DIRS = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']

// ---------------------------------------------------------------- gitignore (subset)

/** Parse a .gitignore into matchers. Supports negation, dir-only and anchored rules. */
export function parseGitignore(text, baseRel = '') {
  const rules = []
  for (let line of String(text || '').split(/\r?\n/)) {
    if (!line || line.charAt(0) === '#') continue
    line = line.replace(/\s+$/, '')
    let negate = false
    if (line.charAt(0) === '!') { negate = true; line = line.slice(1) }
    let dirOnly = false
    if (line.charAt(line.length - 1) === '/') { dirOnly = true; line = line.slice(0, -1) }
    if (!line) continue
    const anchored = line.indexOf('/') >= 0
    const pat = line.charAt(0) === '/' ? line.slice(1) : line
    const re = globToRegExp(anchored ? pat : '**/' + pat)
    rules.push({ negate, dirOnly, re, base: baseRel })
  }
  return rules
}

export function isIgnored(rules, rel, isDir) {
  let ignored = false
  for (const r of rules) {
    let target = rel
    if (r.base) {
      if (rel.indexOf(r.base + '/') !== 0) continue
      target = rel.slice(r.base.length + 1)
    }
    if (r.dirOnly && !isDir) {
      // a dir-only rule also hides files beneath the directory
      const parts = target.split('/')
      let hit = false
      for (let i = 1; i < parts.length; i++) if (r.re.test(parts.slice(0, i).join('/'))) { hit = true; break }
      if (!hit) continue
      ignored = !r.negate
      continue
    }
    if (r.re.test(target)) ignored = !r.negate
    else {
      const parts = target.split('/')
      for (let i = 1; i < parts.length; i++) {
        if (r.re.test(parts.slice(0, i).join('/'))) { ignored = !r.negate; break }
      }
    }
  }
  return ignored
}
