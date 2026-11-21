import { h } from 'preact'
import { parseBlocks, parseInline } from './markdown-parse.js'

// Markdown → Preact vnodes (GFM subset: headings, emphasis, code, fences, lists,
// task lists, quotes, tables, links, images, rules). Builds DOM nodes directly,
// never innerHTML, so untrusted model output cannot inject markup and the
// Windows Runtime "unsafe dynamic content" filter never triggers.

function renderInline(nodes, ctx) {
  return nodes.map((n, k) => {
    switch (n.t) {
      case 'text': return n.v
      case 'code': return <code key={k} className="md-code">{n.v}</code>
      case 'strong': return <strong key={k}>{renderInline(n.children, ctx)}</strong>
      case 'em': return <em key={k}>{renderInline(n.children, ctx)}</em>
      case 'del': return <del key={k}>{renderInline(n.children, ctx)}</del>
      case 'br': return <br key={k} />
      case 'img': {
        const ok = /^(https?:|data:image\/)/i.test(n.src)
        return ok ? <img key={k} className="md-img" src={n.src} alt={n.alt} /> : <span key={k}>{n.alt}</span>
      }
      case 'link': {
        const href = n.href
        const safe = /^(https?:|mailto:)/i.test(href) || /^\/?[\w.@-]+(\/[\w.@ -]+)*(:\d+)?$/.test(href)
        if (!safe) return <span key={k}>{renderInline(n.children, ctx)}</span>
        return (
          <a key={k} className="md-link" href="#" onClick={(e) => { e.preventDefault(); if (ctx.onLink) ctx.onLink(href) }}>
            {renderInline(n.children, ctx)}
          </a>
        )
      }
      default: return null
    }
  })
}

function renderBlocks(blocks, ctx) {
  return blocks.map((b, k) => {
    switch (b.type) {
      case 'heading': {
        const Tag = 'h' + Math.min(6, b.level + 1)
        return <Tag key={k} className={'md-h md-h' + b.level}>{renderInline(parseInline(b.text), ctx)}</Tag>
      }
      case 'para': return b.tight ? <span key={k}>{renderInline(parseInline(b.text), ctx)}</span> : <p key={k}>{renderInline(parseInline(b.text), ctx)}</p>
      case 'hr': return <hr key={k} />
      case 'quote': return <blockquote key={k}>{renderBlocks(b.children, ctx)}</blockquote>
      case 'code': return <CodeBlock key={k} lang={b.lang} text={b.text} ctx={ctx} />
      case 'list': {
        const items = b.items.map((it, j) => (
          <li key={j} className={it.task !== null ? 'md-task' : ''}>
            {it.task !== null ? <span className={'md-check' + (it.task ? ' on' : '')}>{it.task ? '✓' : ''}</span> : null}
            {renderBlocks(it.children, ctx)}
          </li>
        ))
        return b.ordered ? <ol key={k} start={b.start > 1 ? b.start : undefined}>{items}</ol> : <ul key={k}>{items}</ul>
      }
      case 'table':
        return (
          <div key={k} className="md-table-wrap">
            <table className="md-table">
              <thead><tr>{b.head.map((c, j) => <th key={j} style={b.aligns[j] ? { textAlign: b.aligns[j] } : undefined}>{renderInline(parseInline(c), ctx)}</th>)}</tr></thead>
              <tbody>{b.rows.map((r, j) => <tr key={j}>{b.head.map((_, x) => <td key={x} style={b.aligns[x] ? { textAlign: b.aligns[x] } : undefined}>{renderInline(parseInline(r[x] || ''), ctx)}</td>)}</tr>)}</tbody>
            </table>
          </div>
        )
      default: return null
    }
  })
}

function CodeBlock({ lang, text, ctx }) {
  return (
    <div className="md-pre">
      <div className="md-pre-bar">
        <span>{lang || 'text'}</span>
        {ctx.onCopy ? <a href="#" className="md-pre-copy" onClick={(e) => { e.preventDefault(); ctx.onCopy(text) }}>⧉</a> : null}
      </div>
      <pre><code>{text}</code></pre>
    </div>
  )
}

const cache = []
export function Markdown({ text, onLink, onCopy, className }) {
  const src = String(text || '')
  let blocks = null
  for (const c of cache) if (c.src === src) { blocks = c.blocks; break }
  if (!blocks) {
    blocks = parseBlocks(src)
    cache.push({ src, blocks })
    if (cache.length > 60) cache.shift()
  }
  return <div className={'md ' + (className || '')}>{renderBlocks(blocks, { onLink, onCopy })}</div>
}

export { parseBlocks, parseInline }
