// Skills (upstream dsh-skill, dsh-skill-filesystem, dsh-tool-skill): discovery,
// SKILL.md frontmatter, the session catalog reminder and the `skill` tool.
import { join, dirname } from './paths.js'
import { collapseWhitespace, escapeXml, makeError } from './util.js'
import { textOutput } from './tools/runtime.js'

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Parse a YAML-subset frontmatter block. Returns {data, body} or null. */
export function parseFrontmatter(text) {
  const src = String(text || '').replace(/^﻿/, '').replace(/\r\n/g, '\n')
  if (src.indexOf('---\n') !== 0) return { data: {}, body: src }
  const end = src.indexOf('\n---', 4)
  if (end < 0) return null
  const head = src.slice(4, end)
  let body = src.slice(end + 4)
  if (body.charAt(0) === '\n') body = body.slice(1)
  const data = {}
  const lines = head.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i])
    if (!m) continue
    const key = m[1]
    let value = m[2]
    if (value === '|' || value === '>' || value === '|-' || value === '>-' || value === '') {
      const block = []
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].replace(/^\s{1,2}/, ''))
      if (value === '' && !block.length) { data[key] = ''; continue }
      if (value === '' && block.every(l => /^\s*[A-Za-z0-9_-]+:/.test(l) || !l.trim())) {
        const obj = {}
        for (const l of block) { const mm = /^\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(l); if (mm) obj[mm[1]] = scalar(mm[2]) }
        data[key] = obj
        continue
      }
      data[key] = value.charAt(0) === '>' ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').replace(/\n+$/, '')
      continue
    }
    data[key] = scalar(value)
  }
  return { data, body }
}

function scalar(v) {
  const s = v.trim()
  if (/^".*"$/.test(s)) { try { return JSON.parse(s) } catch (e) { return s.slice(1, -1) } }
  if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'")
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  return s
}

/**
 * Discover skills from roots (rank order). Each root holds `<name>/SKILL.md`
 * or a flat `<name>.md`; nested folders are not scanned.
 */
export async function discoverSkills(vfs, roots) {
  const found = {}
  const warnings = []
  for (const root of roots) {
    let entries
    try { entries = await vfs.list(root.path) } catch (e) { continue }
    for (const e of entries) {
      let file, dir
      if (e.type === 'dir') { file = join(root.path, e.name, 'SKILL.md'); dir = join(root.path, e.name) }
      else if (/\.md$/i.test(e.name) && e.name.indexOf('._') !== 0) { file = join(root.path, e.name); dir = root.path }
      else continue
      let text
      try { text = await vfs.readText(file) } catch (err) { continue }
      const fm = parseFrontmatter(text)
      if (!fm || !fm.data.name || !fm.data.description) { warnings.push(`skipped ${file}: missing name or description`); continue }
      const name = String(fm.data.name)
      if (!SKILL_NAME_RE.test(name)) { warnings.push(`skipped ${file}: invalid skill name "${name}"`); continue }
      if (found[name]) continue // lower rank already won
      found[name] = {
        name,
        description: String(fm.data.description),
        whenToUse: fm.data.whenToUse ? String(fm.data.whenToUse) : '',
        modelInvocable: fm.data['disable-model-invocation'] !== true,
        userInvocable: fm.data['user-invocable'] !== false,
        body: fm.body,
        file,
        baseDir: dir,
        source: root.source,
      }
    }
  }
  return { skills: Object.keys(found).sort().map(k => found[k]), warnings }
}

export function skillRoots(projectRoot, settings) {
  const roots = []
  if (projectRoot) {
    roots.push({ path: join(projectRoot, '.dsh/skills'), source: 'project' })
    roots.push({ path: join(projectRoot, '.agents/skills'), source: 'project' })
  }
  for (const d of (settings && settings.customDirs) || []) roots.push({ path: d, source: 'custom' })
  roots.push({ path: '/app/skills', source: 'user' })
  roots.push({ path: '/app/bundled-skills', source: 'bundled' })
  return roots
}

function catalogLines(skills) {
  return skills.filter(s => s.modelInvocable).map((s) => {
    let d = collapseWhitespace(s.description + (s.whenToUse ? ' ' + s.whenToUse : ''))
    if (d.length > 500) d = d.slice(0, 497) + '...'
    return `- \`${s.name}\`: ${escapeXml(d)}`
  })
}

export function skillCatalogSignature(skills) {
  return catalogLines(skills).join('\n')
}

export function renderSkillCatalog(skills, replacement) {
  const lines = catalogLines(skills)
  if (!lines.length) return ''
  const direct = 'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.'
  if (!replacement) {
    return '<system-reminder>\nA skill is a reusable set of task-specific instructions. The following skills are available in this session:\n\n<available_skills>\n'
      + lines.join('\n') + '\n</available_skills>\n\n'
      + "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.\n"
      + direct + '\n</system-reminder>'
  }
  return '<system-reminder>\nThe available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:\n\n<available_skills>\n'
    + lines.join('\n') + '\n</available_skills>\n\n'
    + 'Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the `skill` tool with the exact name before acting.\n'
    + direct + '\n</system-reminder>'
}

export function renderSkillContent(skill) {
  return `<skill_content name="${skill.name}">\n<skill_resources>\nBase directory for this skill: ${skill.baseDir}\nResolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.\n</skill_resources>\n\n<skill_instructions>\n${skill.body.replace(/\s+$/, '')}\n</skill_instructions>\n</skill_content>`
}

export function createSkillTool(getSkills) {
  return {
    name: 'skill',
    description: 'Load the full instructions for a skill. Call it before acting on a task that names or clearly matches a skill in the session skill catalog.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The exact skill name from the available skills list.' } },
      required: ['name'],
    },
    readOnly: true,
    when: ctx => (ctx.skills || []).some(s => s.modelInvocable),
    async execute(args, exec) {
      if (!SKILL_NAME_RE.test(args.name)) throw makeError('SKILL_NOT_FOUND', `skill "${args.name}" was not found`)
      const skills = await getSkills(exec)
      const skill = skills.find(s => s.name === args.name)
      if (!skill) throw makeError('SKILL_NOT_FOUND', `skill "${args.name}" was not found`)
      if (!skill.modelInvocable) throw makeError('SKILL_NOT_MODEL_INVOCABLE', `skill "${args.name}" can only be invoked by the user`)
      return textOutput(renderSkillContent(skill), { display: { kind: 'skill', name: skill.name, description: skill.description, file: skill.file } })
    },
  }
}

// ---------------------------------------------------------------- bundled skills

export const BUNDLED_SKILLS = {
  'create-skill': `---
name: create-skill
description: Create or update a reusable DSH skill (a SKILL.md with instructions) for the user, in the workspace or in the app's user skill folder.
---
# Create a skill

A skill is a folder containing \`SKILL.md\`: YAML frontmatter followed by Markdown instructions.

1. Ask what the skill should help with only if the request is unclear. Choose a short kebab-case \`name\` (lowercase letters, digits, hyphens).
2. Decide where it lives:
   - Workspace skill (shared with this project): \`<workspace>/.dsh/skills/<name>/SKILL.md\`
   - Personal skill (all workspaces on this phone): \`/app/skills/<name>/SKILL.md\`
3. Write the file with \`write\`:

\`\`\`markdown
---
name: <name>
description: <one sentence: what it does and when to use it>
---
# <Title>

<Step-by-step instructions, conventions, checklists, examples.>
\`\`\`

Optional frontmatter: \`whenToUse\`, \`disable-model-invocation: true\` (only the user may invoke it with /<name>), \`user-invocable: false\`.
4. Put supporting files next to SKILL.md and reference them with relative paths.
5. Tell the user the skill is available as \`/<name>\` in the composer and appears in the skill catalog from the next step.
`,
  'dsh-mobile': `---
name: dsh-mobile
description: Facts about running DSH Mobile on a Windows Phone — available tools, storage locations, the LAN gateway, and limits of the device. Load it when the user asks how this phone app works or when a task needs device-specific knowledge.
---
# DSH Mobile on Windows Phone

- There is no shell, Node.js, Python or git on the phone. Use \`read\`, \`write\`, \`edit\`, \`glob\`, \`grep\` for files, \`run_code\` for computation (sandboxed JavaScript with \`await tools.<name>(args)\`), \`web_search\`/\`web_fetch\` for the web.
- File locations: workspaces live under \`/workspaces/<name>\` (app storage) or \`/mnt/<id>\` (a phone/SD-card folder the user picked). \`/tmp\` is always writable scratch space. \`/app/skills\` holds personal skills; \`/app/AGENTS.md\` holds personal instructions for every workspace.
- Windows Phone 8.1 cannot open most modern HTTPS sites directly (old TLS). The DSH gateway on a computer in the same Wi-Fi relays HTTPS for the app; configure it in Settings → General → Network gateway.
- Keep outputs compact: the phone has a small screen and limited memory. Prefer short files and summaries over huge dumps.
- Scheduled tasks run while the app is open; missed runs are delivered when the app starts.
`,
}

export async function installBundledSkills(vfs) {
  for (const name in BUNDLED_SKILLS) {
    const path = `/app/bundled-skills/${name}/SKILL.md`
    let current = null
    try { current = await vfs.readText(path) } catch (e) { current = null }
    if (current !== BUNDLED_SKILLS[name]) await vfs.writeText(path, BUNDLED_SKILLS[name])
  }
}

export { dirname }
