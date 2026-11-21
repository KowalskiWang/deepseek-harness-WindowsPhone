// Small HTML → Markdown converter for web_fetch (upstream uses turndown with ATX
// headings, fenced code, "-" bullets and GFM tables). It tokenizes HTML itself
// so it never instantiates untrusted markup in the app's privileged context.

const DROP = { script: 1, style: 1, noscript: 1, template: 1, iframe: 1, object: 1, embed: 1, svg: 1, canvas: 1, head: 1, select: 1, button: 1, form: 0 }
const VOID = { br: 1, hr: 1, img: 1, input: 1, meta: 1, link: 1, area: 1, base: 1, col: 1, embed: 1, source: 1, track: 1, wbr: 1 }
const BLOCK = { p: 1, div: 1, section: 1, article: 1, main: 1, header: 1, footer: 1, nav: 1, aside: 1, figure: 1, figcaption: 1, address: 1, details: 1, summary: 1, dl: 1, dt: 1, dd: 1, center: 1 }

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', bull: '•', times: '×', deg: '°', trade: '™', euro: '€', yen: '¥', pound: '£' }

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e.charAt(0) === '#') {
      const code = e.charAt(1) === 'x' || e.charAt(1) === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      if (!code || code > 0x10ffff) return m
      if (code > 0xffff) { const c = code - 0x10000; return String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff)) }
      return String.fromCharCode(code)
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m
  })
}

function parseAttrs(src) {
  const attrs = {}
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
  let m
  while ((m = re.exec(src))) attrs[m[1].toLowerCase()] = decodeEntities(m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : '')
  return attrs
}

/** Build a lightweight tree: {tag, attrs, children} / {text}. */
export function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [] }
  const stack = [root]
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<\/([a-zA-Z][a-zA-Z0-9:-]*)\s*>|<([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g
  let last = 0
  let m
  let depth = 0
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1]
    if (m.index > last) top.children.push({ text: html.slice(last, m.index) })
    last = re.lastIndex
    if (m[1]) {
      const tag = m[1].toLowerCase()
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break }
      }
    } else if (m[2]) {
      const tag = m[2].toLowerCase()
      const node = { tag, attrs: parseAttrs(m[3] || ''), children: [] }
      if (DROP[tag]) {
        // skip raw content up to the matching close tag
        const closeRe = new RegExp('</' + tag + '\\s*>', 'ig')
        closeRe.lastIndex = re.lastIndex
        const cm = closeRe.exec(html)
        last = re.lastIndex = cm ? closeRe.lastIndex : html.length
        continue
      }
      const hidden = node.attrs.hidden !== undefined || /display\s*:\s*none/i.test(node.attrs.style || '') || node.attrs['aria-hidden'] === 'true'
      if (hidden) node.hidden = true
      top.children.push(node)
      if (!VOID[tag] && !m[4]) {
        if (stack.length > 512) { depth = 513; break }
        stack.push(node)
      }
    }
  }
  if (depth > 512) return null
  if (last < html.length) stack[stack.length - 1].children.push({ text: html.slice(last) })
  return root
}

function findFirst(node, tag) {
  if (node.tag === tag) return node
  for (const c of node.children || []) {
    if (c.tag) { const f = findFirst(c, tag); if (f) return f }
  }
  return null
}

function inlineText(node) {
  if (node.text != null) return decodeEntities(node.text)
  let s = ''
  for (const c of node.children || []) s += inlineText(c)
  return s
}

function resolveHref(href, base) {
  if (!href) return ''
  if (/^(https?:|mailto:)/i.test(href)) return href
  if (/^\/\//.test(href)) return 'https:' + href
  if (!base) return href
  const m = /^(https?:\/\/[^/]+)(\/[^?#]*)?/i.exec(base)
  if (!m) return href
  if (href.charAt(0) === '/') return m[1] + href
  if (href.charAt(0) === '#' || /^javascript:/i.test(href)) return ''
  const dir = (m[2] || '/').replace(/[^/]*$/, '')
  return m[1] + dir + href
}

function render(node, ctx) {
  if (node.text != null) {
    if (ctx.pre) return decodeEntities(node.text)
    return decodeEntities(node.text).replace(/\s+/g, ' ')
  }
  if (node.hidden) return ''
  const tag = node.tag
  const kids = () => (node.children || []).map(c => render(c, ctx)).join('')
  switch (tag) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const t = kids().trim()
      return t ? '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + t + '\n\n' : ''
    }
    case 'br': return '  \n'
    case 'hr': return '\n\n---\n\n'
    case 'strong': case 'b': { const t = kids(); return t.trim() ? '**' + t.trim() + '**' : t }
    case 'em': case 'i': { const t = kids(); return t.trim() ? '_' + t.trim() + '_' : t }
    case 'del': case 's': case 'strike': { const t = kids(); return t.trim() ? '~~' + t.trim() + '~~' : t }
    case 'code': {
      if (ctx.pre) return inlineText(node)
      const t = inlineText(node)
      return t ? '`' + t.replace(/`/g, 'ˋ') + '`' : ''
    }
    case 'pre': {
      const codeNode = findFirst(node, 'code')
      const cls = (codeNode && codeNode.attrs.class) || node.attrs.class || ''
      const lang = (/(?:language|lang)-([\w+-]+)/.exec(cls) || [])[1] || ''
      const t = inlineText(node).replace(/\n+$/, '')
      return '\n\n```' + lang + '\n' + t + '\n```\n\n'
    }
    case 'a': {
      const t = kids().trim()
      const href = resolveHref(node.attrs.href, ctx.base)
      if (!href) return t
      return t ? '[' + t.replace(/\]/g, '\\]') + '](' + href + ')' : ''
    }
    case 'img': {
      const src = resolveHref(node.attrs.src, ctx.base)
      return src && !/^data:/i.test(node.attrs.src || '') ? '![' + (node.attrs.alt || '') + '](' + src + ')' : (node.attrs.alt || '')
    }
    case 'blockquote': {
      const t = kids().trim()
      return t ? '\n\n' + t.split('\n').map(l => '> ' + l).join('\n') + '\n\n' : ''
    }
    case 'ul': case 'ol': {
      const items = (node.children || []).filter(c => c.tag === 'li')
      const depth = ctx.listDepth || 0
      const lines = items.map((li, i) => {
        const inner = (li.children || []).map(c => render(c, Object.assign({}, ctx, { listDepth: depth + 1 }))).join('').trim().replace(/\n{3,}/g, '\n\n')
        const bullet = tag === 'ol' ? (i + 1) + '. ' : '- '
        const pad = '  '.repeat(depth)
        return pad + bullet + inner.split('\n').join('\n' + pad + '  ')
      })
      return '\n\n' + lines.join('\n') + '\n\n'
    }
    case 'li': return kids()
    case 'table': return renderTable(node, ctx)
    case 'input': return node.attrs.type === 'checkbox' ? (node.attrs.checked !== undefined ? '[x] ' : '[ ] ') : ''
    default:
      if (BLOCK[tag]) { const t = kids(); return t.trim() ? '\n\n' + t.trim() + '\n\n' : '' }
      return kids()
  }
}

function renderTable(node, ctx) {
  const rows = []
  const collect = (n) => {
    for (const c of n.children || []) {
      if (c.tag === 'tr') rows.push(c)
      else if (c.tag === 'thead' || c.tag === 'tbody' || c.tag === 'tfoot') collect(c)
    }
  }
  collect(node)
  if (!rows.length) return ''
  const cells = rows.map(r => (r.children || []).filter(c => c.tag === 'td' || c.tag === 'th').map(c => render(c, ctx).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')))
  const width = Math.max.apply(null, cells.map(r => r.length))
  if (!width) return ''
  const pad = r => { while (r.length < width) r.push(''); return r }
  const out = ['| ' + pad(cells[0]).join(' | ') + ' |', '|' + new Array(width + 1).join(' --- |')]
  for (const r of cells.slice(1)) out.push('| ' + pad(r).join(' | ') + ' |')
  return '\n\n' + out.join('\n') + '\n\n'
}

export function htmlToMarkdown(html, baseUrl) {
  const tree = parseHtml(String(html || ''))
  if (!tree) return '[HTML content omitted: unable to convert safely.]'
  const body = findFirst(tree, 'body') || tree
  const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''))
  let md = render(body, { base: baseUrl })
  md = md.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  const title = tm ? decodeEntities(tm[1]).replace(/\s+/g, ' ').trim() : ''
  if (title && md.indexOf('# ' + title) < 0) md = '# ' + title + '\n\n' + md
  return md
}
