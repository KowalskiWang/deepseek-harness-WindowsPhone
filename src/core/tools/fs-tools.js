// File tools (upstream @deepseek-ai/dsh-tool-fs and dsh-tool-fs-search):
// read, write, edit, apply_patch, read_image, glob, grep — reimplemented
// in-process over the virtual file system (no ripgrep binary on a phone).
import { resolve, isWithin, displayPath, globMatcher, extname, dirname } from '../paths.js'
import { utf8Length, truncateUtf8, makeError, bytesToBase64 } from '../util.js'
import { textOutput, errorOutput } from './runtime.js'
import { unifiedDiff } from '../diff.js'
import { applyPatchText } from './patch.js'

const SANDBOX_PARAMS = {
  sandbox_permissions: { type: 'string', description: 'The narrowest wider sandbox mode for a one-shot retry of the exact operation the sandbox just denied; the retry asks the user for approval.', enum: ['workspace-write', 'danger-full-access'] },
  justification: { type: 'string', description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact file operation needs the wider access. Use the language of the user’s current request.' },
}

const MODE_RANK = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }

/** Paths the agent may never touch (app internals); credentials never live in the VFS. */
function protectedPath(p) {
  return isWithin('/app/sessions', p) || p === '/app/settings.json' || p === '/app/schedule.json' || p === '/app/workspaces.json'
}

/**
 * Enforce the sandbox for a mutating file operation. Returns null when allowed,
 * or an error ToolOutput. Escalation (sandbox_permissions + justification)
 * asks the user once for this exact call.
 */
export async function checkWrite(exec, paths, args) {
  const sb = exec.sandbox
  for (const p of paths) if (protectedPath(p)) return errorOutput(`"${p}" belongs to the app and cannot be modified by tools`, 'FS_PROTECTED')
  const allowedIn = (mode) => {
    if (mode === 'danger-full-access') return true
    if (mode === 'read-only') return false
    return paths.every(p => isWithin(sb.workspaceRoot, p) || (sb.writableRoots || []).some(r => isWithin(r, p)))
  }
  if (allowedIn(sb.mode)) return null
  if (args && args.sandbox_permissions) {
    const requested = args.sandbox_permissions
    if (!(MODE_RANK[requested] > MODE_RANK[sb.mode])) return errorOutput(`invalid arguments: sandbox_permissions must be wider than the current mode (${sb.mode})`, 'INVALID_ARGS')
    if (!args.justification || !String(args.justification).trim()) return errorOutput('invalid arguments: justification is required with sandbox_permissions', 'INVALID_ARGS')
    if (!allowedIn(requested)) return errorOutput(`[sandbox: file access denied under ${requested} mode]`, 'SANDBOX_DENIED')
    const decision = await exec.requestApproval({
      kind: 'sandbox-escalation',
      toolName: exec.toolName,
      mode: requested,
      justification: String(args.justification),
      detail: paths.join('\n'),
    })
    if (decision === 'allowed-once') return null
    return errorOutput(`the user rejected tool "${exec.toolName}"`, 'REJECTED')
  }
  const escalation = sb.approvalPolicy === 'never'
    ? ''
    : '\n[sandbox: escalation available — retry this exact operation once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]'
  return errorOutput(`[sandbox: file access denied under ${sb.mode} mode]${escalation}`, 'SANDBOX_DENIED')
}

function withSandbox(params, exec) {
  return exec && exec.sandboxParams === false ? params : Object.assign({}, params, SANDBOX_PARAMS)
}

function posInt(v, name) {
  if (v === undefined) return undefined
  if (!(typeof v === 'number' && Math.floor(v) === v && v > 0)) throw makeError('INVALID_ARGS', `invalid arguments: ${name} must be a positive integer`)
  return v
}

// ---------------------------------------------------------------- read

const READ_MAX_LINES = 2000
const READ_MAX_LINE_CHARS = 2000
const READ_MAX_BYTES = 50 * 1024

export const readTool = {
  name: 'read',
  description: 'Read a UTF-8 text file and return line-numbered content. Reading a directory lists its entries.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to read, resolved by the filesystem backend.' },
      offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
      limit: { type: 'number', description: 'Maximum number of lines to return. Defaults to 2000.' },
    },
    required: ['file_path'],
  },
  readOnly: true,
  noSpill: true,
  isConcurrencySafe: () => true,
  guidance: () => 'Use the read tool — not shell commands like cat, sed, head, or tail — to inspect text files. Use offset and limit to read a line range or continue a large file.',
  async execute(args, exec) {
    const offset = posInt(args.offset, 'offset') || 1
    const limit = Math.min(posInt(args.limit, 'limit') || READ_MAX_LINES, READ_MAX_LINES)
    const path = resolve(exec.cwd, args.file_path)
    const st = await exec.vfs.stat(path)
    if (!st) throw makeError('ENOENT', `cannot read "${path}": no such file or directory`)
    if (st.type === 'dir') {
      const entries = (await exec.vfs.list(path)).filter(e => e.name.indexOf('._') !== 0 && e.name !== '.DS_Store')
      entries.sort((a, b) => (a.type === b.type ? (a.name < b.name ? -1 : 1) : a.type === 'dir' ? -1 : 1))
      const lines = entries.map(e => e.type === 'dir' ? e.name + '/' : e.name)
      const shown = lines.slice(offset - 1, offset - 1 + limit)
      return textOutput(`<path>${path}</path>\n<type>directory</type>\n<entries>\n${shown.join('\n')}${shown.length ? '\n' : ''}\n(${lines.length} entries)\n</entries>`, { display: { kind: 'read', path, directory: true, count: lines.length } })
    }
    const text = await exec.vfs.readText(path)
    if (exec.noteRead) exec.noteRead(path)
    const all = text.split('\n')
    if (all.length && all[all.length - 1] === '') all.pop()
    const total = all.length
    if (total === 0) return textOutput(`<path>${path}</path>\n<type>file</type>\n<content>\n(End of file - total 0 lines)\n</content>`, { display: { kind: 'read', path, from: 0, to: 0, total: 0 } })
    if (offset > total) throw makeError('OUT_OF_RANGE', `offset ${offset} is out of range for "${path}" (${total} lines)`)
    const out = []
    let bytes = 0
    let capped = false
    let last = offset - 1
    for (let i = offset - 1; i < Math.min(total, offset - 1 + limit); i++) {
      let line = all[i].replace(/\r$/, '')
      if (line.length > READ_MAX_LINE_CHARS) line = line.slice(0, READ_MAX_LINE_CHARS) + '... (line truncated to 2000 chars)'
      const rendered = `${i + 1}: ${line}`
      const size = utf8Length(rendered) + 1
      if (bytes + size > READ_MAX_BYTES && out.length) { capped = true; break }
      out.push(rendered)
      bytes += size
      last = i + 1
    }
    let footer
    if (capped) footer = `(Output capped. Showing lines ${offset}-${last}. Use offset=${last + 1} to continue.)`
    else if (last < total) footer = `(Showing lines ${offset}-${last} of ${total}. Use offset=${last + 1} to continue.)`
    else footer = `(End of file - total ${total} lines)`
    return textOutput(`<path>${path}</path>\n<type>file</type>\n<content>\n${out.join('\n')}\n\n${footer}\n</content>`, { display: { kind: 'read', path, from: offset, to: last, total } })
  },
}

// ---------------------------------------------------------------- write

export const writeTool = {
  name: 'write',
  description: 'Create or fully replace a UTF-8 text file.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to write, resolved by the filesystem backend. Provide `file_path` before `content` in the arguments.' },
      content: { type: 'string', description: 'Full UTF-8 text content to write.' },
    },
    required: ['file_path', 'content'],
  },
  withSandboxParams: true,
  guidance: (visible) => visible.indexOf('edit') >= 0
    ? 'Read an existing file before overwriting it with write and prefer edit for targeted changes.'
    : 'Read an existing file before overwriting it with write.',
  async execute(args, exec) {
    const path = resolve(exec.cwd, args.file_path)
    const denied = await checkWrite(exec, [path], args)
    if (denied) return denied
    const st = await exec.vfs.stat(path)
    if (st && st.type === 'dir') throw makeError('EISDIR', `cannot write "${path}": is a directory`)
    let before = ''
    if (st) { try { before = await exec.vfs.readText(path) } catch (e) { before = '' } }
    await exec.vfs.writeText(path, args.content)
    if (exec.noteWrite) exec.noteWrite(path)
    const diff = unifiedDiff(path, before, args.content)
    return textOutput(`<path>${path}</path>\n<type>file</type>\n<content>\n${st ? 'Updated file' : 'Created file'}\n</content>`, {
      display: { kind: 'diff', path, created: !st, added: diff.added, removed: diff.removed, diff: diff.text.length < 60000 ? diff.text : '', bytes: utf8Length(args.content) },
    })
  },
}

// ---------------------------------------------------------------- edit

function dominantEol(text) {
  const head = text.slice(0, 4096)
  const crlf = (head.match(/\r\n/g) || []).length
  const lf = (head.match(/\n/g) || []).length - crlf
  return crlf > lf ? '\r\n' : '\n'
}

export const editTool = {
  name: 'edit',
  description: 'Edit an existing UTF-8 text file by replacing literal text.',
  parameters: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to edit, resolved by the filesystem backend. Provide `file_path` before `old_string` and `new_string` in the arguments.' },
      old_string: { type: 'string', description: 'Literal text to replace.' },
      new_string: { type: 'string', description: 'Literal replacement text. Use an empty string to delete the match.' },
      replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  withSandboxParams: true,
  guidance: () => 'Read a file before editing it unless you just created or edited it in this session.',
  async execute(args, exec) {
    const path = resolve(exec.cwd, args.file_path)
    const denied = await checkWrite(exec, [path], args)
    if (denied) return denied
    if (args.old_string === '') throw makeError('INVALID_ARGS', 'old_string must not be empty')
    if (args.old_string === args.new_string) throw makeError('INVALID_ARGS', 'old_string and new_string must differ')
    const st = await exec.vfs.stat(path)
    if (!st || st.type !== 'file') throw makeError('FS_CHANGED', `cannot edit "${path}": file changed since it was read — re-read the file, then retry`)
    const original = await exec.vfs.readText(path)
    const eol = dominantEol(original)
    const text = original.replace(/\r\n/g, '\n')
    const oldS = args.old_string.replace(/\r\n/g, '\n')
    const newS = args.new_string.replace(/\r\n/g, '\n')
    let count = 0
    let idx = text.indexOf(oldS)
    while (idx >= 0) { count++; idx = text.indexOf(oldS, idx + oldS.length) }
    if (count === 0) throw makeError('EDIT_NOT_FOUND', `old_string was not found in "${path}"`)
    if (count > 1 && !args.replace_all) throw makeError('EDIT_AMBIGUOUS', `old_string matched ${count} times in "${path}"; provide a more specific old_string or set replace_all to true`)
    const updated = args.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS)
    const finalText = eol === '\r\n' ? updated.replace(/\n/g, '\r\n') : updated
    await exec.vfs.writeText(path, finalText)
    if (exec.noteWrite) exec.noteWrite(path)
    const diff = unifiedDiff(path, text, updated)
    const msg = args.replace_all
      ? `The file ${path} has been updated. All occurrences were successfully replaced.`
      : `The file ${path} has been updated successfully.`
    return textOutput(msg, { display: { kind: 'diff', path, added: diff.added, removed: diff.removed, diff: diff.text.length < 60000 ? diff.text : '', replacements: args.replace_all ? count : 1 } })
  },
}

// ---------------------------------------------------------------- apply_patch

export const applyPatchTool = {
  name: 'apply_patch',
  description: 'Create, update, delete, or move UTF-8 text files with one patch; prefer it over multiple edit calls when a change spans several files or separated regions.',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Patch text: start with *** Begin Patch and end with *** End Patch. Use *** Add File: path with + lines; *** Update File: path, optionally followed by *** Move to: path, with @@ or @@ context and space-prefixed context, + added, or - removed lines; *** End of File anchors the last hunk to the file end. Use *** Delete File: path to delete. Paths are relative to the Session working directory.' },
    },
    required: ['input'],
  },
  withSandboxParams: true,
  guidance: () => 'Prefer apply_patch over separate edit calls for changes across files or separated regions. Give every hunk enough surrounding context lines to match one place in the current file. The whole patch is checked first (syntax, hunk matching, missing files) and a rejected patch changes nothing; once applying starts, operations run in order, stop at the first failure, and are not rolled back, so re-read affected files before retrying when needed.',
  async execute(args, exec) {
    return applyPatchText(args.input, exec, (paths) => checkWrite(exec, paths, args))
  },
}

// ---------------------------------------------------------------- read_image

const IMAGE_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

export function sniffImage(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return null
}

export const readImageTool = {
  name: 'read_image',
  description: 'Read a PNG/JPEG/WebP/GIF file and return the image itself. Large images are downscaled automatically; do not install image libraries or create thumbnails to inspect an image.',
  parameters: {
    type: 'object',
    properties: { file_path: { type: 'string', description: 'Path to the image file, resolved by the filesystem backend.' } },
    required: ['file_path'],
  },
  readOnly: true,
  isConcurrencySafe: () => true,
  when: (ctx) => !!(ctx.model && ctx.model.input && ctx.model.input.indexOf('image') >= 0),
  async execute(args, exec) {
    const path = resolve(exec.cwd, args.file_path)
    const bytes = await exec.vfs.readBytes(path)
    const ext = extname(path)
    const mime = sniffImage(bytes) || (ext ? IMAGE_EXT[ext] : null)
    if (!mime) throw makeError('UNSUPPORTED_IMAGE', `"${path}" is not a PNG, JPEG, WebP or GIF image`)
    const img = exec.images ? await exec.images.prepare(bytes, mime) : { mime, data: bytesToBase64(bytes), width: 0, height: 0, bytes: bytes.length }
    const scaled = img.origWidth && (img.origWidth !== img.width)
    const info = `${img.mime} image, ${img.width}x${img.height} px, ${img.bytes} bytes${scaled ? ` (downscaled from ${img.origWidth}x${img.origHeight} px; multiply coordinates by ${(img.origWidth / img.width).toFixed(2)} to locate features in the original file)` : ''}`
    return {
      content: [
        { type: 'image', mime: img.mime, data: img.data, width: img.width, height: img.height, name: path },
        { type: 'text', text: `<path>${path}</path>\n<type>image</type>\n<content>\n${info}\n</content>` },
      ],
      display: { kind: 'image', path, mime: img.mime, width: img.width, height: img.height },
    }
  },
}

// ---------------------------------------------------------------- glob

const GLOB_CAP = 100

async function spillList(exec, name, lines) {
  const path = `/app/spill/${exec.sessionId || 'session'}/${Date.now().toString(36)}-${name}.txt`
  try { await exec.vfs.writeText(path, lines.join('\n') + '\n'); return path } catch (e) { return null }
}

export const globTool = {
  name: 'glob',
  description: 'Find files, not directories, whose paths match a glob pattern, including hidden and ignored files. Returns up to 100 paths in modification-time order; a larger result keeps the first paths and reports where the complete list was saved.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). A pattern with no "/" matches the basename at any depth, so "*" and "*.ts" both search the whole tree; include a separator to anchor the depth.' },
      path: { type: 'string', description: 'Directory to search in. Defaults to the session workspace; a relative path resolves against it.' },
    },
    required: ['pattern'],
  },
  readOnly: true,
  timeoutMs: 30000,
  isConcurrencySafe: () => true,
  guidance: () => 'Use the glob tool — not shell find — to discover files by path pattern.',
  async execute(args, exec) {
    const root = args.path ? resolve(exec.cwd, args.path) : exec.cwd
    const st = await exec.vfs.stat(root)
    if (!st || st.type !== 'dir') throw makeError('ENOENT', `search path not found: ${root}`)
    let match
    try { match = globMatcher(args.pattern) } catch (e) { throw makeError('SEARCH_INVALID_PATTERN', `invalid glob pattern: ${args.pattern}`) }
    const found = []
    await exec.vfs.walk(root, { hidden: true, vcs: false, gitignore: false, signal: exec.signal, maxFiles: 50000 }, (f) => {
      if (match(f.rel)) found.push(f)
    })
    if (!found.length) return textOutput('No files found', { display: { kind: 'search', count: 0 } })
    found.sort((a, b) => (a.mtime || 0) - (b.mtime || 0) || (a.path < b.path ? -1 : 1))
    const lines = found.map(f => displayPath(exec.cwd, f.path))
    if (lines.length <= GLOB_CAP) return textOutput(lines.join('\n'), { display: { kind: 'search', count: lines.length } })
    const saved = await spillList(exec, 'glob', lines)
    const tail = saved
      ? `(Showing ${GLOB_CAP} of ${lines.length} paths. Full sorted result stored at: ${saved}. Use read with offset/limit, or grep this path to search within it.)`
      : `(Showing ${GLOB_CAP} of ${lines.length} paths. The complete result could not be saved; narrow pattern or path to see more.)`
    return textOutput(lines.slice(0, GLOB_CAP).join('\n') + '\n\n' + tail, { display: { kind: 'search', count: lines.length } })
  },
}

// ---------------------------------------------------------------- grep

const GREP_CAP = 250

/** Translate common ripgrep syntax to a JavaScript RegExp. */
export function compileRipgrep(pattern) {
  let flags = 'g'
  let p = pattern
  const inline = /^\(\?([imsx]+)\)/.exec(p)
  if (inline) {
    if (inline[1].indexOf('i') >= 0) flags += 'i'
    p = p.slice(inline[0].length)
  }
  p = p.replace(/\[\[:(alpha|digit|alnum|space|upper|lower|punct|xdigit|word):\]\]/g, (m, cls) => ({
    alpha: '[A-Za-z]', digit: '[0-9]', alnum: '[A-Za-z0-9]', space: '\\s', upper: '[A-Z]', lower: '[a-z]', punct: '[!-/:-@[-`{-~]', xdigit: '[0-9A-Fa-f]', word: '\\w',
  })[cls])
  if (/\\p\{|\(\?<[=!]|\(\?P?</.test(p)) throw makeError('SEARCH_INVALID_PATTERN', `unsupported regular expression syntax on this device: ${pattern}`)
  try { return new RegExp(p, flags) } catch (e) { throw makeError('SEARCH_INVALID_PATTERN', `invalid regular expression: ${e.message}`) }
}

export const grepTool = {
  name: 'grep',
  description: 'Search file contents with a ripgrep regular expression. Returns matching lines with line numbers, grouped by file. Returns up to 250 matches; a larger result reports where the complete match list was saved.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for (ripgrep syntax).' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the session workspace; a relative path resolves against it.' },
      include: { type: 'string', description: 'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.' },
    },
    required: ['pattern'],
  },
  readOnly: true,
  timeoutMs: 30000,
  isConcurrencySafe: () => true,
  guidance: (visible) => 'Use the grep tool — not shell grep or rg — to search file contents.' + (visible.indexOf('read') >= 0 ? ' Use read on a matched file when you need surrounding context.' : ''),
  async execute(args, exec) {
    const re = compileRipgrep(args.pattern)
    let includeMatch = null
    if (args.include) {
      if (args.include.charAt(0) === '!') throw makeError('INVALID_ARGS', 'invalid arguments: include does not support negation')
      if (/,(?![^{]*\})/.test(args.include)) throw makeError('INVALID_ARGS', 'invalid arguments: include is one glob, not a list')
      includeMatch = globMatcher(args.include)
    }
    const target = args.path ? resolve(exec.cwd, args.path) : exec.cwd
    const st = await exec.vfs.stat(target)
    if (!st) throw makeError('ENOENT', `search path not found: ${target}`)
    const files = []
    if (st.type === 'file') files.push({ path: target, rel: target.slice(target.lastIndexOf('/') + 1) })
    else {
      await exec.vfs.walk(target, { hidden: false, vcs: false, gitignore: true, signal: exec.signal, maxFiles: 20000 }, (f) => {
        if (!includeMatch || includeMatch(f.rel)) files.push(f)
      })
    }
    const groups = []
    let total = 0
    for (const f of files) {
      if (exec.signal && exec.signal.aborted) throw makeError('ABORTED', 'aborted')
      if (f.size > 8 * 1024 * 1024) continue
      let text
      try { text = await exec.vfs.readText(f.path) } catch (e) { continue } // binary or non-UTF-8: skipped like rg
      const lines = text.split('\n')
      const hits = []
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0
        if (re.test(lines[i])) {
          let line = lines[i].replace(/\r$/, '')
          if (utf8Length(line) > 2000) line = truncateUtf8(line, 2000) + ' (line truncated)'
          hits.push(`Line ${i + 1}: ${line}`)
        }
      }
      if (hits.length) { groups.push({ path: displayPath(exec.cwd, f.path), hits }); total += hits.length }
    }
    if (!total) return textOutput('No matches found', { display: { kind: 'search', count: 0 } })
    const render = (cap) => {
      const parts = []
      let shown = 0
      for (const g of groups) {
        if (shown >= cap) break
        const take = g.hits.slice(0, cap - shown)
        shown += take.length
        parts.push(g.path + '\n' + take.join('\n'))
      }
      return parts.join('\n\n')
    }
    if (total <= GREP_CAP) {
      return textOutput(`Found ${total} ${total === 1 ? 'match' : 'matches'}\n\n${render(total)}`, { display: { kind: 'search', count: total } })
    }
    const fullLines = []
    for (const g of groups) { fullLines.push(g.path); for (const h of g.hits) fullLines.push(h); fullLines.push('') }
    const saved = await spillList(exec, 'grep', fullLines)
    const note = saved ? `(Full grep result stored at: ${saved}. Use read with offset/limit, or grep this path to search within it.)` : '(The complete result could not be saved; narrow the pattern or path.)'
    return textOutput(`Found ${GREP_CAP} of ${total} matches\n\n${render(GREP_CAP)}\n\n${note}`, { display: { kind: 'search', count: total } })
  },
}

export const FS_TOOLS = [readTool, writeTool, editTool, applyPatchTool, readImageTool, globTool, grepTool]

export function sandboxAware(def) {
  if (!def.withSandboxParams) return def
  return Object.assign({}, def, {
    parameters: Object.assign({}, def.parameters, { properties: withSandbox(def.parameters.properties) }),
  })
}

export { dirname }
