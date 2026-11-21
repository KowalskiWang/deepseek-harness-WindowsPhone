import { h } from 'preact'
import { useState } from 'preact/hooks'
import { Icon } from './icons.jsx'
import { Markdown } from './markdown.jsx'
import { t } from './i18n.js'
import { Dots, fmtTokens, copyText } from './components.jsx'
import { formatClock, clip, safeJsonParse } from '../core/util.js'
import { CONTINUABLE } from '../core/llm/errors.js'

const HIDDEN_SOURCES = { 'runtime-context': 1, instructions: 1, 'instructions-update': 1, skills: 1, 'time-context': 1, notice: 1, 'repeat-tool-reminder': 1, 'tool-context': 1 }

/** Build the timeline (turns + markers) from session events. */
export function buildTimeline(events) {
  const items = []
  let turn = null
  const calls = {}
  const pushMarker = (m) => { (turn ? turn.markers : items).push(m) }
  for (const ev of events) {
    const d = ev.data || {}
    switch (ev.type) {
      case 'turn/start':
        turn = { kind: 'turn', turn: d.turn, seq: ev.seq, startedAt: ev.time, inputs: [], parts: [], markers: [], status: 'running', toolCount: 0, usage: null, deliverables: [], retries: [] }
        items.push(turn)
        break
      case 'user/message': {
        const src = d.source || { kind: 'human' }
        if (ev.replace || src.kind === 'compaction') { (turn ? turn.markers : items).push({ kind: 'checkpoint', seq: ev.seq, text: (d.content && d.content[0] && d.content[0].text) || '' }); break }
        const entry = { seq: ev.seq, time: ev.time, source: src, content: d.content || [], displayText: d.displayText }
        if (HIDDEN_SOURCES[src.kind]) { pushMarker({ kind: 'context', seq: ev.seq, source: src.kind, text: (d.content && d.content[0] && d.content[0].text) || '' }); break }
        if (turn && turn.status === 'running') {
          if (turn.parts.length) turn.parts.push({ kind: 'steer', entry })
          else turn.inputs.push(entry)
        } else items.push({ kind: 'input', entry })
        break
      }
      case 'assistant/message': {
        if (!turn) break
        for (const b of d.content || []) {
          if (b.type === 'thinking') { if (b.text) turn.parts.push({ kind: 'thinking', text: b.text, seq: ev.seq }) }
          else if (b.type === 'text') turn.parts.push({ kind: 'text', text: b.text, seq: ev.seq, interrupted: d.interrupted })
          else if (b.type === 'tool-call') {
            const part = { kind: 'tool', call: b, result: null, seq: ev.seq }
            calls[b.id] = part
            turn.parts.push(part)
            turn.toolCount++
          }
        }
        if (d.usage) {
          const u = turn.usage || (turn.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0, model: d.model, provider: d.provider })
          u.input += d.usage.input || 0; u.output += d.usage.output || 0; u.cacheRead += d.usage.cacheRead || 0; u.cacheWrite += d.usage.cacheWrite || 0; u.reasoning += d.usage.reasoning || 0; u.requests++
          u.model = d.model; u.provider = d.provider
        }
        if (d.stopReason === 'length') turn.maxTokens = true
        break
      }
      case 'tool/call': if (calls[d.id]) calls[d.id].startedAt = d.startedAt; break
      case 'tool/result': {
        const part = calls[d.callId]
        if (part && !ev.replace) part.result = d
        else if (part && ev.replace) part.result = Object.assign({}, part.result, { pruned: true })
        break
      }
      case 'llm/retry': if (turn) turn.retries.push(d); break
      case 'turn/end':
        if (turn) { turn.status = d.reason; turn.error = d.error; turn.endedAt = ev.time; turn.durationMs = d.durationMs }
        turn = null
        break
      case 'compaction/start': pushMarker({ kind: 'compacting', seq: ev.seq, id: d.compactionId }); break
      case 'compaction/summary': pushMarker({ kind: 'compacted', seq: ev.seq, items: d.items, tokens: d.shadowedTokenCount, summary: d.summary }); break
      case 'plan/mode': pushMarker({ kind: 'plan-mode', seq: ev.seq, active: d.active, by: d.by }); break
      case 'goal/change': pushMarker({ kind: 'goal', seq: ev.seq, goal: d.goal, reason: d.reason }); break
      case 'permission/preset': pushMarker({ kind: 'permission', seq: ev.seq, preset: d.preset }); break
      case 'model/selection': pushMarker({ kind: 'model', seq: ev.seq, sel: d }); break
      case 'session/end-seed': items.push({ kind: 'inherited', seq: ev.seq }); break
      case 'subagent/finished': pushMarker({ kind: 'subagent-finished', seq: ev.seq, name: d.name, reason: d.reason, sessionId: d.sessionId }); break
      case 'deliverables/present': if (turn) turn.deliverables = turn.deliverables.concat(d.files || []); break
      case 'feedback': pushMarker({ kind: 'feedback', seq: ev.seq, rating: d.rating }); break
      default: break
    }
  }
  return items
}

// ---------------------------------------------------------------- tool rows

const TOOL_ICON = {
  read: 'file', write: 'edit', edit: 'edit', apply_patch: 'edit', read_image: 'image', glob: 'search', grep: 'search',
  todo_write: 'list', exit_plan_mode: 'plan', ask_user_question: 'question', present: 'download', web_search: 'globe', web_fetch: 'globe',
  skill: 'sparkle', run_code: 'code', workflow: 'agent', subagent: 'agent', subagent_fork: 'agent', send_message: 'agent', list_agents: 'agent', wait_agent: 'clock',
  create_goal: 'goal', get_goal: 'goal', update_goal: 'goal', schedule_create: 'clock', schedule_edit: 'clock', schedule_list: 'clock', schedule_view: 'clock',
}

function argsOf(call) { return call.input || safeJsonParse(call.arguments || '{}', {}) || {} }
function base(p) { return String(p || '').split('/').pop() }

export function toolTitle(call, result) {
  const a = argsOf(call)
  const disp = (result && result.display) || {}
  switch (call.name) {
    case 'read': return { verb: t('tv_read'), target: base(a.file_path) + (disp.from ? ` (${disp.from}-${disp.to})` : '') }
    case 'write': return { verb: disp.created === false ? t('tv_overwrite') : t('tv_write'), target: base(a.file_path), stat: disp.added !== undefined ? `+${disp.added} −${disp.removed}` : '' }
    case 'edit': return { verb: t('tv_edit'), target: base(a.file_path), stat: disp.added !== undefined ? `+${disp.added} −${disp.removed}` : '' }
    case 'apply_patch': return { verb: t('tv_patch'), target: disp.files ? disp.files.length + t('tv_files') : '', stat: disp.added !== undefined ? `+${disp.added} −${disp.removed}` : '' }
    case 'read_image': return { verb: t('tv_image'), target: base(a.file_path) }
    case 'glob': return { verb: t('tv_glob'), target: a.pattern, stat: disp.count !== undefined ? String(disp.count) : '' }
    case 'grep': return { verb: t('tv_grep'), target: a.pattern, stat: disp.count !== undefined ? String(disp.count) : '' }
    case 'todo_write': return { verb: t('tv_todo'), target: (a.todos || []).length + t('tv_items') }
    case 'exit_plan_mode': return { verb: t('tv_plan'), target: clip(String(a.plan || '').split('\n')[0].replace(/^#\s*/, ''), 40) }
    case 'ask_user_question': return { verb: t('tv_ask'), target: (a.questions || []).length + t('tv_questions') }
    case 'present': return { verb: t('tv_present'), target: (a.files || []).map(f => base(f.path)).join(', ') }
    case 'web_search': return { verb: t('tv_search'), target: (a.queries || []).join(' · ') }
    case 'web_fetch': return { verb: t('tv_fetch'), target: a.url }
    case 'skill': return { verb: t('tv_skill'), target: a.name }
    case 'run_code': return { verb: t('tv_code'), target: a.description || '' }
    case 'workflow': return { verb: t('tv_workflow'), target: (a.meta && a.meta.name) || '' }
    case 'subagent': case 'subagent_fork': return { verb: call.name === 'subagent_fork' ? t('tv_fork') : t('tv_subagent'), target: a.description || a.name }
    case 'send_message': return { verb: t('tv_message'), target: a.agent }
    case 'list_agents': return { verb: t('tv_agents'), target: '' }
    case 'wait_agent': return { verb: t('tv_wait'), target: '' }
    case 'create_goal': return { verb: t('tv_goal_create'), target: clip(a.objective || '', 40) }
    case 'get_goal': return { verb: t('tv_goal_get'), target: '' }
    case 'update_goal': return { verb: t('tv_goal_update'), target: a.action }
    case 'schedule_create': return { verb: t('tv_sched_create'), target: a.title }
    case 'schedule_edit': return { verb: t('tv_sched_edit'), target: a.action }
    case 'schedule_list': return { verb: t('tv_sched_list'), target: '' }
    case 'schedule_view': return { verb: t('tv_sched_view'), target: a.id }
    default:
      if (/^mcp__/.test(call.name)) { const parts = call.name.split('__'); return { verb: 'MCP · ' + parts[1], target: parts.slice(2).join('__') } }
      return { verb: t('toolCall'), target: call.name }
  }
}

export function DiffView({ diff, max = 160 }) {
  if (!diff) return null
  const lines = diff.split('\n')
  const shown = lines.slice(0, max)
  return (
    <div className="diff">
      {shown.map((l, i) => {
        const c = l.charAt(0)
        const cls = c === '+' ? 'diff-add' : c === '-' ? 'diff-del' : c === '@' ? 'diff-hunk' : ''
        return <div key={i} className={'diff-line ' + cls}>{l || ' '}</div>
      })}
      {lines.length > max ? <div className="diff-line diff-hunk">… {lines.length - max} more lines</div> : null}
    </div>
  )
}

function TodoList({ todos }) {
  return (
    <div className="todo-list">
      {(todos || []).map((td, i) => (
        <div key={i} className={'todo todo-' + td.status}>
          <span className="todo-box">{td.status === 'completed' ? '✓' : td.status === 'in_progress' ? '•' : ''}</span>
          <span>{td.content}</span>
        </div>
      ))}
    </div>
  )
}

function ToolRow({ part, live, h: handlers, detailLevel }) {
  const [open, setOpen] = useState(false)
  const { call, result } = part
  const title = toolTitle(call, result)
  const running = !result
  const disp = (result && result.display) || {}
  const failed = result && result.isError
  const outText = result ? (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n') : ''
  const showInline = disp.kind === 'todo' || (disp.kind === 'diff' && detailLevel !== 'compact')
  return (
    <div className={'tool-row' + (failed ? ' failed' : '') + (running ? ' running' : '')}>
      <div className="tool-head" onClick={() => setOpen(!open)}>
        <Icon name={TOOL_ICON[call.name] || (/^mcp__/.test(call.name) ? 'puzzle' : 'bolt')} size={16} />
        <span className="tool-verb">{title.verb}</span>
        <span className="tool-target">{title.target}</span>
        {title.stat ? <span className="tool-stat">{title.stat}</span> : null}
        <span className="tool-state">{running ? <Dots /> : failed ? <Icon name="close" size={14} /> : (result.durationMs ? formatClock(result.durationMs) : <Icon name="check" size={14} />)}</span>
      </div>
      {running && live && live.toolProgress && live.toolProgress.kind === 'workflow' ? (
        <div className="tool-sub">
          {live.toolProgress.phase ? <div>▸ {live.toolProgress.phase}</div> : null}
          {live.toolProgress.agents.slice(-8).map((ag, i) => <div key={i}>↳ {ag.label} {ag.status === 'running' ? '…' : ag.status === 'failed' ? '✗' : '✓'}</div>)}
          {live.toolProgress.logs.map((l, i) => <div key={'l' + i} className="muted">{l}</div>)}
        </div>
      ) : null}
      {running && live && live.toolProgress && live.toolProgress.kind === 'code' ? (
        <div className="tool-sub">{live.toolProgress.calls.map((c, i) => <div key={i}>↳ {c.name} {c.status === 'running' ? '…' : c.status === 'error' ? '✗' : '✓'}</div>)}</div>
      ) : null}
      {!open && showInline && disp.kind === 'todo' ? <TodoList todos={disp.todos} /> : null}
      {!open && showInline && disp.kind === 'diff' && disp.diff ? <DiffView diff={disp.diff} max={detailLevel === 'verbose' ? 400 : 24} /> : null}
      {!open && disp.kind === 'web-search' && disp.sources ? (
        <div className="tool-sources">{disp.sources.slice(0, 5).map((s, i) => <a key={i} href="#" className="md-link" onClick={(e) => { e.preventDefault(); handlers.onLink(s.url) }}>{clip(s.title, 40)}</a>)}</div>
      ) : null}
      {!open && disp.kind === 'subagent' ? (
        <div className="tool-sub"><a href="#" className="md-link" onClick={(e) => { e.preventDefault(); handlers.openSession(disp.sessionId) }}>{disp.name} →</a></div>
      ) : null}
      {!open && disp.kind === 'present' ? (
        <div className="deliverables">{disp.files.map((f, i) => <div key={i} className="deliverable" onClick={() => handlers.openFile(f.path)}><Icon name="file" size={16} /><span>{base(f.path)}</span><span className="muted">{f.description}</span></div>)}</div>
      ) : null}
      {open ? (
        <div className="tool-detail">
          <div className="tool-detail-label">{t('input')}</div>
          <pre className="tool-pre">{clip(JSON.stringify(argsOf(call), null, 1), 6000)}</pre>
          {result ? <div className="tool-detail-label">{t('output')}{result.durationMs ? ' · ' + formatClock(result.durationMs) : ''}</div> : null}
          {disp.kind === 'diff' && disp.diff ? <DiffView diff={disp.diff} max={600} /> : null}
          {disp.kind === 'todo' ? <TodoList todos={disp.todos} /> : null}
          {result ? <pre className={'tool-pre' + (failed ? ' error' : '')}>{clip(outText, 12000)}</pre> : null}
          <div className="tool-detail-actions">
            <a href="#" onClick={(e) => { e.preventDefault(); copyText(outText) }}>{t('copy')}</a>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function Thinking({ text, live }) {
  const [open, setOpen] = useState(false)
  const preview = clip(String(text || '').replace(/\s+/g, ' ').trim(), 90)
  return (
    <div className={'thinking' + (open ? ' open' : '')} onClick={() => setOpen(!open)}>
      <div className="thinking-head"><Icon name="sparkle" size={14} /><span>{live ? t('think') : t('thought')}</span>{!open ? <span className="thinking-preview">{preview}</span> : null}</div>
      {open ? <div className="thinking-body">{text}</div> : null}
    </div>
  )
}

// ---------------------------------------------------------------- inputs & markers

function sourceLabel(src) {
  switch (src.kind) {
    case 'goal': return t('src_goal') + (src.round || '')
    case 'schedule': return t('src_schedule') + (src.title || '')
    case 'subagent': return t('src_subagent') + src.from + (src.reason === 'completed' ? t('src_done') : t('src_ended'))
    case 'agent': return t('src_from') + src.from + t('src_msg')
    case 'continue': return t('src_continue')
    default: return src.skill ? '/' + src.skill : ''
  }
}

function InputBubble({ entry, handlers }) {
  const src = entry.source || {}
  const label = sourceLabel(src)
  const images = entry.content.filter(b => b.type === 'image')
  let text = entry.displayText || entry.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
  if (src.kind === 'goal') text = ''
  if (src.kind === 'subagent' || src.kind === 'agent') {
    return (
      <div className="notice-row" onClick={() => handlers.openText(label, text)}>
        <Icon name="agent" size={14} /><span>{label}</span><Icon name="chevronRight" size={14} />
      </div>
    )
  }
  if (src.kind === 'continue') return <div className="notice-row"><Icon name="play" size={14} /><span>{label}</span></div>
  return (
    <div className="bubble-row">
      <div className="bubble">
        {label ? <div className="bubble-label">{label}</div> : null}
        {images.length ? <div className="bubble-images">{images.map((im, i) => <img key={i} src={`data:${im.mime};base64,${im.data}`} alt="" onClick={() => handlers.viewImage(im)} />)}</div> : null}
        {text ? <div className="bubble-text">{text}</div> : null}
      </div>
    </div>
  )
}

function Marker({ m, handlers, level }) {
  switch (m.kind) {
    case 'compacting': return <div className="marker"><Icon name="refresh" size={14} />{t('compacting')}</div>
    case 'compacted': return <div className="marker tappable" onClick={() => handlers.openText(t('contextCompacted'), m.summary)}><Icon name="archive" size={14} />{t('compacted', { n: m.items, t: fmtTokens(m.tokens) })}</div>
    case 'checkpoint': return null
    case 'plan-mode': return <div className="marker"><Icon name="plan" size={14} />{m.active ? t('mk_plan_on') : m.by === 'approval' ? t('mk_plan_approved') : t('mk_plan_off')}</div>
    case 'goal': return <div className="marker"><Icon name="goal" size={14} />{m.goal ? `${t('goal')} · ${m.goal.phase} · ${clip(m.goal.objective, 40)}` : t('mk_goal_cleared')}</div>
    case 'permission': return level === 'verbose' ? <div className="marker"><Icon name="shield" size={14} />{m.preset}</div> : null
    case 'model': return level === 'verbose' ? <div className="marker"><Icon name="model" size={14} />{m.sel.model} · {m.sel.effort || ''}</div> : null
    case 'subagent-finished': return null
    case 'context': return level === 'verbose' ? <div className="marker tappable" onClick={() => handlers.openText(m.source, m.text)}><Icon name="info" size={14} />{m.source}</div> : null
    case 'feedback': return null
    default: return null
  }
}

// ---------------------------------------------------------------- turns

function TurnView({ turn, live, isLast, agentStatus, handlers, settings }) {
  const level = settings.workDetails || 'detailed'
  const running = turn.status === 'running'
  const [expanded, setExpanded] = useState(null)
  // final answer = text parts after the last tool part
  let lastTool = -1
  turn.parts.forEach((p, i) => { if (p.kind === 'tool' || p.kind === 'steer') lastTool = i })
  const work = turn.parts.slice(0, lastTool + 1)
  const tail = turn.parts.slice(lastTool + 1)
  const finalTexts = tail.filter(p => p.kind === 'text')
  const tailThinking = tail.filter(p => p.kind === 'thinking')
  const workItems = work.concat(running ? tailThinking : tailThinking)
  const collapsedDefault = !running && (level === 'compact' || level === 'standard' || level === 'detailed')
  const isOpen = expanded === null ? (level === 'verbose' || running || (!collapsedDefault)) : expanded
  const duration = turn.durationMs || (turn.endedAt ? turn.endedAt - turn.startedAt : Date.now() - turn.startedAt)
  const finalText = finalTexts.map(p => p.text).join('\n\n')
  const showWork = workItems.length > 0 || (running && live)
  const retry = running && turn.retries.length ? turn.retries[turn.retries.length - 1] : null
  return (
    <div className="turn">
      {turn.inputs.map((e, i) => <InputBubble key={i} entry={e} handlers={handlers} />)}
      {turn.markers.filter(m => m.kind !== 'context' || level === 'verbose').map((m, i) => <Marker key={'m' + i} m={m} handlers={handlers} level={level} />)}
      {showWork ? (
        <div className={'work' + (isOpen ? ' open' : '')}>
          {(!running || workItems.length) ? (
            <div className="work-head" onClick={() => setExpanded(!isOpen)}>
              <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={14} />
              <span>{running ? t('deepDiving') + ' ' + formatClock(duration) : t('completedIn', { d: formatClock(duration) })}{turn.toolCount ? ' · ' + t('toolCalls', { n: turn.toolCount }) : ''}</span>
            </div>
          ) : null}
          {isOpen ? (
            <div className="work-body">
              {workItems.map((p, i) => {
                if (p.kind === 'thinking') return level === 'compact' ? null : <Thinking key={i} text={p.text} />
                if (p.kind === 'tool') return <ToolRow key={i} part={p} live={isLast ? live : null} h={handlers} detailLevel={level} />
                if (p.kind === 'steer') return <InputBubble key={i} entry={p.entry} handlers={handlers} />
                if (p.kind === 'text') return <div key={i} className="work-text"><Markdown text={p.text} onLink={handlers.onLink} onCopy={handlers.copy} /></div>
                return null
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      {running && live ? <LiveBlocks live={live} handlers={handlers} /> : null}
      {finalText ? (
        <div className="answer">
          <Markdown text={finalText} onLink={handlers.onLink} onCopy={handlers.copy} />
          {finalTexts.some(p => p.interrupted) ? <div className="muted small">（{t('stopped')}）</div> : null}
        </div>
      ) : null}
      {turn.deliverables.length ? (
        <div className="deliverables">{turn.deliverables.map((f, i) => <div key={i} className="deliverable" onClick={() => handlers.openFile(f.path)}><Icon name="file" size={16} /><span>{base(f.path)}</span><span className="muted">{f.description}</span></div>)}</div>
      ) : null}
      {retry ? <div className="retry-row"><Icon name="refresh" size={14} />{t('retrying', { n: retry.attempt, max: retry.max || '∞', s: Math.round(retry.delayMs / 1000) })} · {retry.code}</div> : null}
      {running && !live && agentStatus === 'running' ? <div className="status-line"><span className="whale" />{t('deepDiving')} {formatClock(duration)} <Dots /></div> : null}
      {turn.status === 'error' ? (
        <div className="error-row">
          <Icon name="warning" size={16} />
          <div className="error-text">
            <div>{t('turnFailed')}{turn.error ? ' · ' + (t('error_' + turn.error.code) !== 'error_' + turn.error.code ? t('error_' + turn.error.code) : turn.error.code) : ''}</div>
            {turn.error && turn.error.message ? <div className="muted small">{clip(turn.error.message, 300)}</div> : null}
          </div>
          {isLast && turn.error && (CONTINUABLE.indexOf(turn.error.code) >= 0) ? <button className="btn btn-small" onClick={handlers.continueGen}><Icon name="play" size={14} />{t('continueGen')}</button> : null}
        </div>
      ) : null}
      {turn.status === 'aborted' ? <div className="muted small stopped">{t('stopped')}</div> : null}
      {turn.maxTokens ? <div className="warn-row"><Icon name="warning" size={14} />{t('maxTokens')}</div> : null}
      {!running && finalText ? <TurnActions turn={turn} text={finalText} handlers={handlers} settings={settings} isLast={isLast} /> : null}
    </div>
  )
}

function TurnActions({ turn, text, handlers, settings, isLast }) {
  const u = turn.usage
  const cachePct = u && (u.input + u.cacheRead) ? Math.round(100 * u.cacheRead / (u.input + u.cacheRead)) : 0
  return (
    <div className="turn-actions">
      <button className="icon-btn small" onClick={() => handlers.copy(text)} aria-label={t('copy')}><Icon name="copy" size={16} /></button>
      <button className="icon-btn small" onClick={() => handlers.feedback(turn, 'good')} aria-label={t('goodResponse')}><Icon name="thumbUp" size={16} /></button>
      <button className="icon-btn small" onClick={() => handlers.feedback(turn, 'bad')} aria-label={t('badResponse')}><Icon name="thumbDown" size={16} /></button>
      {isLast ? <button className="icon-btn small" onClick={() => handlers.branch(turn)} aria-label={t('branch')}><Icon name="fork" size={16} /></button> : null}
      {u && settings.usageDisplay !== 'compact' ? (
        <span className="usage-chip" onClick={() => handlers.turnUsage(turn)}>{fmtTokens(u.input + u.cacheRead + u.cacheWrite)}↑ {fmtTokens(u.output)}↓ · {t('cacheHit', { p: cachePct })}</span>
      ) : null}
    </div>
  )
}

function LiveBlocks({ live, handlers }) {
  const blocks = live.blocks.filter(Boolean)
  if (!blocks.length) return <div className="status-line"><span className="whale" />{t('deepDiving')} {formatClock(Date.now() - live.startedAt)} <Dots /></div>
  return (
    <div className="live">
      {blocks.map((b, i) => {
        if (b.type === 'thinking') return <Thinking key={i} text={b.text} live />
        if (b.type === 'text') return <div key={i} className="answer streaming"><Markdown text={b.text} onLink={handlers.onLink} /></div>
        if (b.type === 'tool-call') return <div key={i} className="tool-row running"><div className="tool-head"><Icon name={TOOL_ICON[b.name] || 'bolt'} size={16} /><span className="tool-verb">{b.name}</span><span className="tool-target muted">{b.text ? b.text.length + ' chars' : ''}</span><span className="tool-state"><Dots /></span></div></div>
        return null
      })}
    </div>
  )
}

export function Transcript({ agent, handlers, settings, limit }) {
  const items = buildTimeline(agent.session.events)
  const turns = items
  const start = Math.max(0, turns.length - limit)
  const shown = turns.slice(start)
  let lastTurnIdx = -1
  shown.forEach((it, i) => { if (it.kind === 'turn') lastTurnIdx = i })
  return (
    <div className="transcript">
      {start > 0 ? <button className="load-earlier" onClick={handlers.loadEarlier}>{t('loadEarlier')}</button> : (agent.session.events.length ? <div className="muted small center">{t('startOfConversation')}</div> : null)}
      {shown.map((it, i) => {
        if (it.kind === 'turn') return <TurnView key={'t' + it.seq} turn={it} live={i === lastTurnIdx ? agent.live : null} isLast={i === lastTurnIdx} agentStatus={agent.status} handlers={handlers} settings={settings} />
        if (it.kind === 'input') return <InputBubble key={'i' + it.entry.seq} entry={it.entry} handlers={handlers} />
        if (it.kind === 'inherited') return <div key={'h' + it.seq} className="inherited">{t('inherited')}</div>
        return <Marker key={'x' + (it.seq || i)} m={it} handlers={handlers} level={settings.workDetails} />
      })}
      {agent.compacting ? <div className="marker"><Icon name="refresh" size={14} />{t('compacting')}</div> : null}
    </div>
  )
}
