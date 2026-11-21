// Slash commands (upstream packages/interaction/commands builtin.ts).
export const COMMANDS = [
  { name: 'file', section: 'add', clientOnly: true },
  { name: 'goal', aliases: ['目标'], section: 'add', args: '[<objective>|clear|edit <objective>|pause|resume]', attachments: true },
  { name: 'plan', aliases: ['计划'], section: 'add', args: '[off|message]', attachments: true },
  { name: 'feedback', aliases: ['反馈'], section: 'add', args: '<text>' },
  { name: 'compact', aliases: ['压缩'], section: 'commands' },
  { name: 'permission', aliases: ['权限'], section: 'commands', args: '<preset>' },
  { name: 'model', section: 'commands', clientOnly: true },
  { name: 'export', aliases: ['导出'], section: 'commands' },
]

export function findCommand(name) {
  const n = String(name || '').toLowerCase()
  return COMMANDS.find(c => c.name === n || (c.aliases || []).indexOf(n) >= 0) || null
}

/** Split "/name rest" → {name, args}; null when text is not a slash command. */
export function splitCommand(text) {
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(String(text || '').trim())
  if (!m) return null
  return { name: m[1], args: (m[2] || '').trim() }
}

/** Fuzzy score for the command menu (subsequence match). */
export function fuzzyScore(query, target) {
  const q = query.toLowerCase(), t = target.toLowerCase()
  if (!q) return 1
  if (t.indexOf(q) === 0) return 100 - t.length
  if (t.indexOf(q) > 0) return 50 - t.length
  let i = 0
  for (const ch of t) if (ch === q[i]) i++
  return i === q.length ? 10 - t.length / 100 : -1
}
