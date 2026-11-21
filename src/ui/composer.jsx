import { h } from 'preact'
import { useState, useRef, useEffect } from 'preact/hooks'
import { Icon } from './icons.jsx'
import { t } from './i18n.js'
import { ui, menu, confirm, toast, dialog, closeOverlay } from './store.js'
import { Button, useLongPress, fmtTokens, registerOverlay } from './components.jsx'
import { Markdown } from './markdown.jsx'
import { COMMANDS, fuzzyScore } from '../core/commands.js'
import { PERMISSION_PRESETS } from '../core/agent.js'
import { clip } from '../core/util.js'
import { globMatcher } from '../core/paths.js'

export const PERM_LABEL = { 'read-only': 'perm_readonly', 'workspace-write': 'perm_workspace', 'danger-full-access': 'perm_full' }
const PERM_DESC = { 'read-only': 'permDesc_readonly', 'workspace-write': 'permDesc_workspace', 'danger-full-access': 'permDesc_full' }

export async function pickPermission(agent) {
  const cur = agent.permissionPreset()
  const v = await menu(t('cmd_permission'), Object.keys(PERMISSION_PRESETS).map(p => ({ label: t(PERM_LABEL[p]), hint: t(PERM_DESC[p]), value: p, checked: p === cur, icon: 'shield' })))
  if (!v || v === cur) return
  if (v === 'danger-full-access') {
    const ok = await confirm({ title: t('enableFullAccess'), body: t('fullAccessBody'), checkbox: t('understandRisk'), danger: true })
    if (!ok) return
  }
  agent.setPermission(v)
}

export function effortLabel(e) { const k = 'effort_' + e; const s = t(k); return s === k ? e : s }

export async function pickModel(rt, current, opts = {}) {
  const items = []
  for (const p of rt.llm.providers()) {
    if (rt.llm.apiKeyFor(p) === undefined && p.kind !== 'deepseek') continue
    for (const m of rt.llm.models(p.id)) {
      items.push({ label: (m.name || m.id) + (m.input && m.input.indexOf('image') >= 0 ? ' · 🖼' : ''), hint: p.name + ' · ' + m.id + (m.description ? ' · ' + m.description : ''), value: p.id + '\u0000' + m.id, checked: current && current.provider === p.id && current.model === m.id, icon: 'model' })
    }
  }
  const v = await menu(t('cmd_model'), items)
  if (!v) return null
  const [provider, model] = v.split('\u0000')
  const info = rt.llm.findModel(provider, model)
  let effort
  if (info && info.efforts && info.efforts.length) {
    const def = rt.llm.defaultEffort(provider, model)
    const cur = current && current.provider === provider && current.model === model ? current.effort : def
    effort = await menu(t('effort'), info.efforts.map(e => ({ label: effortLabel(e) + (e === def ? ' · ' + t('effortDefault') : ''), value: e, checked: e === cur })))
    if (!effort) effort = cur
  }
  const sel = { provider, model, effort }
  if (!opts.noDefault) rt.settings.update({ models: { defaultSelection: sel } })
  return sel
}

// ---------------------------------------------------------------- docks

export function TodoDock({ agent }) {
  const [open, setOpen] = useState(false)
  let todos = null
  for (let i = agent.session.events.length - 1; i >= 0; i--) {
    const ev = agent.session.events[i]
    if (ev.type === 'todo/write') { todos = ev.data.todos; break }
    if (ev.type === 'turn/start' && !agent.running) break
  }
  if (!todos || !todos.length) return null
  const done = todos.filter(x => x.status === 'completed').length
  const cur = todos.find(x => x.status === 'in_progress')
  return (
    <div className="dock" onClick={() => setOpen(!open)}>
      <div className="dock-head"><Icon name="list" size={14} /><span>{t('todos')} {done}/{todos.length}</span><span className="dock-sub">{cur ? cur.content : ''}</span><Icon name={open ? 'chevronDown' : 'chevronUp'} size={14} /></div>
      {open ? <div className="dock-body">{todos.map((td, i) => <div key={i} className={'todo todo-' + td.status}><span className="todo-box">{td.status === 'completed' ? '✓' : td.status === 'in_progress' ? '•' : ''}</span><span>{td.content}</span></div>)}</div> : null}
    </div>
  )
}

export function GoalDock({ agent }) {
  const g = agent.goal.get()
  if (!g || g.phase === 'complete') return null
  const label = g.phase === 'active' ? (agent.goal.armed ? t('goalOngoing') : t('goalInactive')) : g.phase === 'paused' ? t('goalPaused') : t('goalBlocked')
  return (
    <div className="dock">
      <div className="dock-head">
        <Icon name="goal" size={14} /><span>{label}</span><span className="dock-sub">{clip(g.objective, 60)} · {g.roundsStarted}/{g.maxGoalRounds}</span>
        {g.phase === 'active' && agent.goal.armed
          ? <button className="chip" onClick={() => agent.goal.pause()}>{t('pause')}</button>
          : <button className="chip" onClick={() => { agent.goal.resume(); if (!agent.running) agent.goal.maybeContinue() }}>{t('resume')}</button>}
        <button className="chip" onClick={() => agent.goal.clear()}>{t('clear')}</button>
      </div>
    </div>
  )
}

export function QueueDock({ agent }) {
  const q = agent.inbox.nextTurn
  if (!q.length) return null
  return (
    <div className="dock">
      <div className="dock-head"><Icon name="clock" size={14} /><span>{t('queued', { n: q.length })}</span>{agent.running ? <button className="chip" onClick={() => agent.steerQueued()}>{t('steer')}</button> : null}</div>
      <div className="dock-body">
        {q.map(m => {
          const text = (m.displayText || (m.content || []).filter(b => b.type === 'text').map(b => b.text).join(' '))
          return (
            <div key={m.id} className="queue-item">
              <span className="queue-text">{clip(text, 80)}</span>
              <button className="chip" onClick={async () => { const v = await dialog('prompt', { title: t('edit'), value: text, multiline: true }); if (v) agent.editQueued(m.id, v) }}>{t('edit')}</button>
              {agent.running ? <button className="chip" onClick={() => agent.steerQueued(m.id)}>{t('steer')}</button> : null}
              <button className="chip" onClick={() => agent.removeQueued(m.id)}>{t('remove')}</button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- interaction cards

export function ApprovalCard({ agent }) {
  const p = agent.pending.payload
  const modeLabel = t(PERM_LABEL[p.mode] || 'perm_full')
  return (
    <div className="card interact">
      <div className="interact-strip"><Icon name="shield" size={14} />{t('waitingForApproval')}</div>
      <div className="interact-title">{p.justification ? t('approvalTitle', { mode: modeLabel, why: p.justification }) : `Tool ${p.toolName} requests privileged execution`}</div>
      {p.detail ? <pre className="tool-pre">{clip(p.detail, 1200)}</pre> : null}
      <div className="interact-buttons">
        <Button onClick={() => agent.answer('approval', 'rejected')}>{t('reject')}</Button>
        <Button kind="primary" onClick={() => agent.answer('approval', 'allowed-once')}>{t('allowOnce')}</Button>
      </div>
    </div>
  )
}

export function QuestionCard({ agent }) {
  const qs = agent.pending.payload.questions || []
  const [idx, setIdx] = useState(0)
  const [answers, setAnswers] = useState(() => qs.map(q => ({ id: q.id, selected: (q.options || []).filter(o => /\(Recommended\)|（推荐）/.test(o.label)).slice(0, 1).map(o => o.label), custom: '' })))
  const q = qs[idx]
  if (!q) return null
  const a = answers[idx]
  const set = (patch) => setAnswers(answers.map((x, i) => (i === idx ? Object.assign({}, x, patch) : x)))
  const toggle = (label) => {
    if (q.multi_select) set({ selected: a.selected.indexOf(label) >= 0 ? a.selected.filter(s => s !== label) : a.selected.concat([label]) })
    else set({ selected: a.selected[0] === label ? [] : [label] })
  }
  const submit = () => agent.answer('question', { answers: answers.map(x => (x.custom ? { id: x.id, selected: x.selected, custom: x.custom } : { id: x.id, selected: x.selected })) })
  return (
    <div className="card interact">
      <div className="interact-strip"><Icon name="question" size={14} />{t('waitingAnswer')} {qs.length > 1 ? `${idx + 1}/${qs.length}` : ''}</div>
      {q.header ? <div className="chip static">{q.header}</div> : null}
      <div className="interact-title">{q.question}</div>
      <div className="options">
        {(q.options || []).map(o => (
          <div key={o.label} className={'option' + (a.selected.indexOf(o.label) >= 0 ? ' on' : '')} onClick={() => toggle(o.label)}>
            <span className={'option-box' + (q.multi_select ? ' square' : '')}>{a.selected.indexOf(o.label) >= 0 ? '✓' : ''}</span>
            <span><div>{o.label}</div>{o.description ? <div className="muted small">{o.description}</div> : null}</span>
          </div>
        ))}
      </div>
      <input className="input" placeholder={t('typeAnswer')} value={a.custom} onInput={e => set({ custom: e.target.value })} />
      <div className="interact-buttons">
        {idx > 0 ? <Button small onClick={() => setIdx(idx - 1)}>{t('prev')}</Button> : null}
        <Button small onClick={() => { set({ selected: [], custom: '' }); if (idx < qs.length - 1) setIdx(idx + 1); else agent.answer('question', { answers: answers.map((x, i) => (i === idx ? { id: x.id, selected: [] } : x)) }) }}>{t('skip')}</Button>
        {idx < qs.length - 1 ? <Button small kind="primary" onClick={() => setIdx(idx + 1)}>{t('next')}</Button> : <Button small kind="primary" onClick={submit}>{t('submit')}</Button>}
      </div>
    </div>
  )
}

export function PlanCard({ agent, onViewPlan }) {
  const plan = agent.pending.payload.plan || ''
  const [feedback, setFeedback] = useState('')
  const [asking, setAsking] = useState(false)
  return (
    <div className="card interact">
      <div className="interact-strip"><Icon name="plan" size={14} />{t('planReview')}</div>
      <div className="plan-preview" onClick={() => onViewPlan(plan)}><Markdown text={clip(plan, 600)} /></div>
      <a href="#" className="md-link" onClick={(e) => { e.preventDefault(); onViewPlan(plan) }}>{t('viewFullPlan')}</a>
      {asking ? <textarea className="input textarea" rows={3} placeholder={t('planFeedback')} value={feedback} onInput={e => setFeedback(e.target.value)} /> : null}
      <div className="interact-buttons">
        {asking
          ? <Button onClick={() => agent.answer('plan', { decision: 'revise', feedback })}>{t('submit')}</Button>
          : <Button onClick={() => setAsking(true)}>{t('requestChanges')}</Button>}
        <Button kind="primary" onClick={() => agent.answer('plan', { decision: 'approve' })}>{t('approve')}</Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- composer

function useSkills(agent) {
  const [skills, setSkills] = useState([])
  useEffect(() => { ui.rt.skillsFor(agent).then(setSkills).catch(() => {}) }, [agent])
  return skills
}

export function Composer({ agent, onOpenModel }) {
  const rt = ui.rt
  const settings = rt.settings.get().general
  const [text, setText] = useState(() => (ui.drafts && ui.drafts[agent.session.id]) || '')
  const [images, setImages] = useState([])
  const [menuState, setMenuState] = useState(null) // {kind:'command'|'file', query, items}
  const ref = useRef(null)
  const skills = useSkills(agent)
  ui.drafts = ui.drafts || {}
  ui.drafts[agent.session.id] = text

  let route = null
  try { route = rt.llm.resolve(agent.selection()) } catch (e) { route = null }
  const sel = agent.selection()
  const modelInfo = route ? route.model : null
  const supportsImages = !!(modelInfo && modelInfo.input && modelInfo.input.indexOf('image') >= 0)

  const autosize = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 150) + 'px'
  }
  useEffect(autosize, [text])

  const updateMenus = (value) => {
    const el = ref.current
    const caret = el && el.selectionStart !== undefined ? el.selectionStart : value.length
    const before = value.slice(0, caret)
    const cm = /^\/([^\s/]*)$/.exec(before)
    if (cm) {
      const q = cm[1]
      const items = []
      for (const c of COMMANDS) {
        const score = Math.max(fuzzyScore(q, c.name), ...(c.aliases || []).map(a => fuzzyScore(q, a)))
        if (score >= 0) items.push({ score, kind: 'command', name: c.name, label: '/' + c.name, hint: t('cmdDesc_' + c.name), section: c.section })
      }
      for (const s of skills) {
        if (!s.userInvocable) continue
        const score = fuzzyScore(q, s.name)
        if (score >= 0) items.push({ score, kind: 'skill', name: s.name, label: '/' + s.name, hint: clip(s.description, 80), section: 'skills' })
      }
      items.sort((a, b) => b.score - a.score)
      setMenuState({ kind: 'command', items: items.slice(0, 12) })
      return
    }
    const am = /(^|\s)@([^\s@]*)$/.exec(before)
    if (am) {
      const q = am[2]
      const cwd = agent.cwd()
      const found = []
      const matcher = q ? globMatcher('*' + q.replace(/[*?[\]{}]/g, '') + '*') : null
      rt.vfs.walk(cwd, { hidden: false, maxFiles: 400 }, (f) => { if (!matcher || matcher(f.rel) || f.rel.indexOf(q) >= 0) found.push(f.rel) }).then(() => {
        setMenuState({ kind: 'file', at: caret - q.length - 1, items: found.slice(0, 12).map(p => ({ kind: 'file', label: '@' + p, value: p })) })
      }).catch(() => {})
      return
    }
    if (menuState) setMenuState(null)
  }

  const onInput = (e) => {
    const v = e.target.value
    setText(v)
    updateMenus(v)
  }

  const choose = (item) => {
    if (item.kind === 'command' || item.kind === 'skill') {
      if (item.name === 'model') { setText(''); setMenuState(null); onOpenModel(); return }
      if (item.name === 'file') { setText(''); setMenuState(null); addImages(); return }
      if (item.name === 'permission') { setText(''); setMenuState(null); pickPermission(agent); return }
      setText('/' + item.name + ' ')
    } else if (item.kind === 'file') {
      const caret = ref.current ? ref.current.selectionStart : text.length
      const start = menuState.at
      const v = text.slice(0, start) + '@' + item.value + ' ' + text.slice(caret)
      setText(v)
    }
    setMenuState(null)
    setTimeout(() => { if (ref.current) { try { ref.current.focus() } catch (e) { /* ok */ } } }, 0)
  }

  const addImages = async () => {
    if (!supportsImages) { toast(t('imageNotSupported'), { kind: 'warn' }); return }
    try {
      const picked = await ui.platform.pickImages()
      if (picked && picked.length) setImages(images.concat(picked).slice(0, 20))
    } catch (e) { toast(e.message, { kind: 'error' }) }
  }

  const doSend = async (mode) => {
    if (!text.trim() && !images.length) return
    if (!route) { toast(t('modelSelectionMissing'), { kind: 'warn' }); onOpenModel(); return }
    const payload = { text, images, mode: mode || (agent.running ? settings.busySend : 'queue') }
    setText('')
    setImages([])
    setMenuState(null)
    try {
      const r = await rt.send(agent, payload)
      if (r && r.command === 'export' && r.result && r.result.jsonl) ui.emit('export', { agent, jsonl: r.result.jsonl })
      else if (r && r.command === 'compact') toast(r.result && r.result.compacted ? t('compacted', { n: r.result.items, t: fmtTokens(r.result.tokens) }) : t('contextCompacted'))
      else if (r && r.command === 'feedback') toast(t('feedbackThanks'))
    } catch (e) {
      toast(e.message, { kind: 'error' })
    }
  }

  const sendLong = useLongPress(() => { if (agent.running && text.trim()) doSend(settings.busySend === 'queue' ? 'steer' : 'queue') })

  const onKeyDown = (e) => {
    if (menuState && menuState.items.length && (e.keyCode === 13 || e.keyCode === 9)) { e.preventDefault(); choose(menuState.items[0]); return }
    if (e.keyCode === 27 && menuState) { setMenuState(null); return }
    if (e.keyCode === 13 && !e.shiftKey && settings.sendOnEnter) { e.preventDefault(); doSend() }
  }

  const perm = agent.permissionPreset()
  const planMode = agent.planMode()
  const running = agent.running
  const empty = !text.trim() && !images.length
  const totals = agent.usageTotals()
  const ctxUse = agent.contextUsage()
  const cachePct = totals.input + totals.cacheRead ? Math.round(100 * totals.cacheRead / (totals.input + totals.cacheRead)) : 0
  const turns = agent.session.turnCount()

  return (
    <div className="composer-wrap">
      {menuState && menuState.items.length ? (
        <div className="popup-menu">
          {menuState.items.map((it, i) => (
            <div key={i} className="popup-item" onClick={() => choose(it)}>
              <span className="popup-label">{it.label}</span>
              {it.hint ? <span className="popup-hint">{it.hint}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      {images.length ? (
        <div className="attach-rail">
          {images.map((im, i) => (
            <div key={i} className="attach-thumb">
              <img src={`data:${im.mime};base64,${im.data}`} alt="" />
              <button className="attach-x" onClick={() => setImages(images.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="composer">
        <textarea ref={ref} className="composer-input" rows={1} value={text} onInput={onInput} onKeyDown={onKeyDown}
          placeholder={planMode ? t('planPlaceholder') : t('composerPlaceholder')} />
        <div className="composer-bar">
          <button className="icon-btn" aria-label={t('addFilesOrCommands')} onClick={async () => {
            const v = await menu(t('addFilesOrCommands'), [
              { label: t('attachImage'), icon: 'image', value: 'image', disabled: !supportsImages, hint: supportsImages ? '' : t('imageNotSupported') },
              { label: '/ ' + t('sectionCommands'), icon: 'bolt', value: 'cmd' },
              { label: '@ ' + t('sectionFiles'), icon: 'file', value: 'at' },
              { label: t('cmd_goal'), icon: 'goal', value: 'goal' },
              { label: t('cmd_plan'), icon: 'plan', value: 'plan' },
            ])
            if (v === 'image') addImages()
            else if (v === 'cmd') { setText('/'); updateMenus('/') }
            else if (v === 'at') { const nv = text + (text && !/\s$/.test(text) ? ' @' : '@'); setText(nv); updateMenus(nv) }
            else if (v === 'goal') setText('/goal ')
            else if (v === 'plan') { agent.setPlanMode(true, 'user') }
          }}><Icon name="add" size={20} /></button>
          <button className={'chip perm-' + perm} onClick={() => pickPermission(agent)}><Icon name="shield" size={13} />{t(PERM_LABEL[perm])}</button>
          {planMode ? <button className="chip chip-accent" onClick={() => agent.setPlanMode(false, 'user')}><Icon name="plan" size={13} />{t('plan')} ×</button> : null}
          <button className="chip chip-model" onClick={onOpenModel}>{modelInfo ? clip(modelInfo.name || modelInfo.id, 22) : t('selectModel')}{sel && sel.effort && modelInfo && modelInfo.efforts && modelInfo.efforts.length ? ' · ' + effortLabel(sel.effort) : ''}</button>
          <span className="flex1" />
          {running && empty
            ? <button className="send-btn stop" onClick={() => agent.cancel('user')} aria-label={t('stop')}><Icon name="stop" size={18} /></button>
            : <button className={'send-btn' + (empty ? ' disabled' : '')} {...sendLong} onClick={() => { if (!sendLong.wasLongPress()) doSend() }} aria-label={running ? t(settings.busySend) : t('send')}>
              <Icon name={running ? (settings.busySend === 'steer' ? 'bolt' : 'clock') : 'send'} size={18} />
            </button>}
        </div>
      </div>
      {turns ? (
        <div className="stats-row">
          <span>{turns} {t('turns')}</span>
          <span>{fmtTokens(totals.input + totals.cacheRead + totals.cacheWrite)}↑ {fmtTokens(totals.output)}↓</span>
          <span>{t('cacheHit', { p: cachePct })}</span>
          <span className="ctx-ring" title={t('contextUsed', { p: Math.round(ctxUse.ratio * 100) + '%' })}><span className="ctx-fill" style={{ width: Math.max(2, Math.round(ctxUse.ratio * 100)) + '%' }} />{Math.round(ctxUse.ratio * 1000) / 10}%</span>
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------- feedback dialog

function FeedbackDialog({ o }) {
  const [cat, setCat] = useState(o.props.rating === 'good' ? '' : 'wrong')
  const [text, setText] = useState('')
  const cats = ['wrong', 'incomplete', 'ignored', 'tool', 'slow', 'unsafe', 'other']
  return (
    <div className="dialog">
      <div className="dialog-title">{o.props.rating === 'good' ? t('goodResponse') : t('badResponse')}</div>
      {o.props.rating !== 'good' ? (
        <div className="chips-wrap">{cats.map(c => <button key={c} className={'chip' + (cat === c ? ' chip-accent' : '')} onClick={() => setCat(c)}>{t('fb_' + c)}</button>)}</div>
      ) : null}
      <textarea className="input textarea" rows={3} value={text} onInput={e => setText(e.target.value)} placeholder="…" />
      <div className="dialog-buttons">
        <Button onClick={() => closeOverlay(o)}>{t('cancel')}</Button>
        <Button kind="primary" onClick={() => closeOverlay(o, { category: cat, text })}>{t('submitFeedback')}</Button>
      </div>
    </div>
  )
}
registerOverlay('feedback', FeedbackDialog)
