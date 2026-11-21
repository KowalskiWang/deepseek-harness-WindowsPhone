// Markdown parser (GFM subset) — pure functions shared by the UI and tests.

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const HR = /^ {0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/
const QUOTE = /^ {0,3}>\s?(.*)$/

function splitRow(line) {
  let s = line.trim()
  if (s.charAt(0) === '|') s = s.slice(1)
  if (s.charAt(s.length - 1) === '|' && s.charAt(s.length - 2) !== '\\') s = s.slice(0, -1)
  const cells = []
  let cur = ''
  let inCode = false
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i)
    if (c === '\\' && s.charAt(i + 1) === '|') { cur += '|'; i++; continue }
    if (c === '`') inCode = !inCode
    if (c === '|' && !inCode) { cells.push(cur.trim()); cur = '' } else cur += c
  }
  cells.push(cur.trim())
  return cells
}

export function parseBlocks(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    let m
    if ((m = FENCE.exec(line))) {
      const fence = m[1]
      const lang = m[2] || ''
      const body = []
      i++
      while (i < lines.length && !(lines[i].trim().indexOf(fence.charAt(0) === '`' ? '```' : '~~~') === 0 && lines[i].trim().replace(/[`~]/g, '') === '')) { body.push(lines[i]); i++ }
      i++
      blocks.push({ type: 'code', lang, text: body.join('\n'), open: i > lines.length })
      continue
    }
    if ((m = HEADING.exec(line))) { blocks.push({ type: 'heading', level: m[1].length, text: m[2] }); i++; continue }
    if (HR.test(line)) { blocks.push({ type: 'hr' }); i++; continue }
    if (QUOTE.test(line)) {
      const body = []
      while (i < lines.length && lines[i].trim() && (m = QUOTE.exec(lines[i]) || [null, lines[i]])) { body.push(m[1]); i++ }
      blocks.push({ type: 'quote', children: parseBlocks(body.join('\n')) })
      continue
    }
    if (line.indexOf('|') >= 0 && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0) {
      const head = splitRow(line)
      const aligns = splitRow(lines[i + 1]).map(c => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : /^:-/.test(c) ? 'left' : ''))
      const rows = []
      i += 2
      while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0) { rows.push(splitRow(lines[i])); i++ }
      blocks.push({ type: 'table', head, aligns, rows })
      continue
    }
    if ((m = LIST.exec(line))) {
      const baseIndent = m[1].length
      const ordered = /\d/.test(m[2])
      const items = []
      while (i < lines.length) {
        const lm = LIST.exec(lines[i])
        if (lm && lm[1].length === baseIndent && /\d/.test(lm[2]) === ordered) {
          const item = { lines: [lm[3]], start: ordered ? parseInt(lm[2], 10) : undefined }
          i++
          while (i < lines.length) {
            const l = lines[i]
            if (!l.trim()) {
              if (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) && lines[i + 1].trim())) { item.lines.push(''); i++; continue }
              break
            }
            const nested = LIST.exec(l)
            if (nested && nested[1].length <= baseIndent) break
            if (!nested && !/^\s/.test(l) && (HEADING.test(l) || FENCE.test(l) || HR.test(l))) break
            item.lines.push(l.replace(new RegExp('^\\s{0,' + (baseIndent + 4) + '}'), ''))
            i++
          }
          items.push(item)
        } else break
      }
      blocks.push({
        type: 'list',
        ordered,
        start: items.length ? items[0].start : 1,
        items: items.map((it) => {
          let first = it.lines[0]
          let task = null
          const tm = /^\[([ xX])\]\s+(.*)$/.exec(first)
          if (tm) { task = tm[1] !== ' '; first = tm[2] }
          const rest = it.lines.slice(1)
          const simple = rest.every(l => !l.trim() || (!LIST.test(l) && !FENCE.test(l)))
          return { task, children: simple && !rest.some(l => !l.trim()) ? [{ type: 'para', text: [first].concat(rest).join('\n'), tight: true }] : parseBlocks([first].concat(rest).join('\n')) }
        }),
      })
      continue
    }
    const para = []
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !HR.test(lines[i]) && !QUOTE.test(lines[i]) && !(para.length && LIST.test(lines[i]))) {
      if (lines[i].indexOf('|') >= 0 && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) break
      para.push(lines[i]); i++
    }
    if (para.length) blocks.push({ type: 'para', text: para.join('\n') })
    else i++
  }
  return blocks
}

// ---------------------------------------------------------------- inline

const URL_RE = /^(https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"）】》」』，。；：！？])/

export function parseInline(text) {
  const out = []
  let buf = ''
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = '' } }
  let i = 0
  while (i < text.length) {
    const c = text.charAt(i)
    const rest = text.slice(i)
    let m
    if (c === '\\' && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!|~>]/.test(text.charAt(i + 1))) { buf += text.charAt(i + 1); i += 2; continue }
    if (c === '`') {
      const n = /^`+/.exec(rest)[0].length
      const close = text.indexOf(text.substr(i, n), i + n)
      if (close > 0) { flush(); out.push({ t: 'code', v: text.slice(i + n, close).replace(/^ (.*) $/, '$1') }); i = close + n; continue }
    }
    if (c === '!' && (m = /^!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest))) { flush(); out.push({ t: 'img', alt: m[1], src: m[2] }); i += m[0].length; continue }
    if (c === '[' && (m = /^\[((?:[^\][]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/.exec(rest))) { flush(); out.push({ t: 'link', href: m[2], children: parseInline(m[1]) }); i += m[0].length; continue }
    if (c === '<' && (m = /^<(https?:\/\/[^>\s]+)>/.exec(rest))) { flush(); out.push({ t: 'link', href: m[1], children: [{ t: 'text', v: m[1] }] }); i += m[0].length; continue }
    if ((c === 'h') && (i === 0 || /[\s(（:：,，]/.test(text.charAt(i - 1))) && (m = URL_RE.exec(rest))) { flush(); out.push({ t: 'link', href: m[1], children: [{ t: 'text', v: m[1] }] }); i += m[1].length; continue }
    if ((c === '*' || c === '_') && text.charAt(i + 1) === c) {
      const close = text.indexOf(c + c, i + 2)
      if (close > i + 2 && text.charAt(i + 2) !== ' ') { flush(); out.push({ t: 'strong', children: parseInline(text.slice(i + 2, close)) }); i = close + 2; continue }
    }
    if (c === '~' && text.charAt(i + 1) === '~') {
      const close = text.indexOf('~~', i + 2)
      if (close > i + 2) { flush(); out.push({ t: 'del', children: parseInline(text.slice(i + 2, close)) }); i = close + 2; continue }
    }
    if ((c === '*' || c === '_') && text.charAt(i + 1) !== ' ' && text.charAt(i + 1) !== c) {
      const prev = i ? text.charAt(i - 1) : ' '
      if (c === '*' || !/\w/.test(prev)) {
        let close = i + 1
        while ((close = text.indexOf(c, close)) > 0) {
          if (text.charAt(close - 1) !== ' ' && text.charAt(close + 1) !== c && (c === '*' || !/\w/.test(text.charAt(close + 1) || ' '))) break
          close++
        }
        if (close > i + 1) { flush(); out.push({ t: 'em', children: parseInline(text.slice(i + 1, close)) }); i = close + 1; continue }
      }
    }
    if (c === '\n') {
      if (/ {2,}$/.test(buf) || buf.charAt(buf.length - 1) === '\\') { buf = buf.replace(/ +$|\\$/, ''); flush(); out.push({ t: 'br' }) } else buf += ' '
      i++
      continue
    }
    buf += c
    i++
  }
  flush()
  return out
}
