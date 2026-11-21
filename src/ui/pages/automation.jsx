import { h } from 'preact'
import { useState } from 'preact/hooks'
import { Icon } from '../icons.jsx'
import { t } from '../i18n.js'
import { ui, navigate, confirm, toast, back, useRuntime } from '../store.js'
import { Page, Pivot, Field, Select, Button, ListItem, Empty, AppBar, relTime } from '../components.jsx'
import { buildRrule, parseRrule, nextOccurrence, formatLocal } from '../../core/rrule.js'
import { pad2 } from '../../core/util.js'
import { wsName } from './home.jsx'

export function AutomationPage() {
  const rt = ui.rt
  useRuntime(['schedule'])
  const [filter, setFilter] = useState('active')
  let tasks = rt.schedule.tasks.slice()
  if (filter === 'active') tasks = tasks.filter(x => x.active)
  else if (filter === 'paused') tasks = tasks.filter(x => !x.active && !x.ended)
  else if (filter === 'ended') tasks = tasks.filter(x => x.ended)
  tasks.sort((a, b) => (b.active - a.active) || ((a.nextAt || Infinity) - (b.nextAt || Infinity)))
  return (
    <Page title={t('automation')} appBar={
      <AppBar buttons={[{ icon: 'add', label: t('taskNew'), onClick: () => navigate('task', {}) }]} menu={[{ label: t('clearEnded'), onClick: () => rt.schedule.clearEnded() }]} />
    }>
      <Pivot active={filter} onChange={setFilter} tabs={[{ id: 'active', label: t('enabled') }, { id: 'paused', label: t('paused') }, { id: 'ended', label: t('ended') }, { id: 'all', label: t('all') }]} />
      {tasks.length ? tasks.map(task => (
        <ListItem key={task.id} icon="clock" title={task.title}
          subtitle={(task.nextAt ? t('nextRun') + ' ' + formatLocal(new Date(task.nextAt)) : task.ended ? t('ended') : t('paused')) + ' · ' + task.target}
          right={task.lastRunAt ? <span className="muted small">{relTime(task.lastRunAt)}</span> : null}
          onClick={() => navigate('task', { id: task.id })} />
      )) : <Empty icon="clock" text={t('noTasks')} />}
    </Page>
  )
}

function toLocalInput(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

function guessRepeat(rrule) {
  const r = String(rrule || '')
  if (/COUNT=1(;|$)/.test(r)) return 'once'
  if (/FREQ=MINUTELY/.test(r)) return 'minutes'
  if (/FREQ=HOURLY/.test(r)) return 'hours'
  if (/FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR$/.test(r)) return 'weekdays'
  if (/FREQ=WEEKLY/.test(r)) return 'week'
  if (/FREQ=MONTHLY/.test(r)) return 'month'
  if (/FREQ=DAILY$/.test(r.split('\n')[1] || '')) return 'day'
  return 'custom'
}

export function TaskPage({ params }) {
  const rt = ui.rt
  useRuntime(['schedule'])
  const task = params.id ? rt.schedule.get(params.id) : null
  const [tab, setTab] = useState('rules')
  const [title, setTitle] = useState(task ? task.title : '')
  const [promptText, setPrompt] = useState(task ? task.prompt : '')
  const [target, setTarget] = useState(task ? (task.target === 'this_session' ? 'new_once' : task.target) : 'new_once')
  const [wsId, setWs] = useState(task ? task.workspaceId : (rt.workspaces.mostRecent() || {}).id)
  const [repeat, setRepeat] = useState(task ? guessRepeat(task.rrule) : 'day')
  const [every, setEvery] = useState(30)
  const [start, setStart] = useState(() => { const d = new Date(Date.now() + 5 * 60000); d.setSeconds(0); return toLocalInput(d) })
  const [custom, setCustom] = useState(task ? task.rrule : '')
  const [error, setError] = useState('')

  const rrule = () => {
    if (repeat === 'custom') return custom
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(start)
    const d = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : new Date()
    return buildRrule(repeat, d, { every })
  }
  let preview = ''
  try { const n = nextOccurrence(parseRrule(rrule()), new Date()); preview = n ? formatLocal(n) : '—' } catch (e) { preview = e.message }

  const save = () => {
    setError('')
    try {
      const ws = rt.workspaces.get(wsId)
      if (task) {
        rt.schedule.edit(task.id, { action: 'update', title, prompt: promptText, rrule: rrule(), target })
        const tk = rt.schedule.get(task.id)
        tk.workspaceId = wsId; tk.cwd = ws ? ws.path : tk.cwd
        rt.schedule.save()
      } else {
        rt.schedule.create({ title, prompt: promptText, rrule: rrule(), target, workspaceId: wsId, cwd: ws ? ws.path : '/' })
      }
      back()
    } catch (e) { setError(e.message) }
  }

  return (
    <Page title={task ? task.title : t('taskNew')} actions={task ? <button className="icon-btn" onClick={async () => { if (await confirm({ title: t('delete') + '?', danger: true })) { rt.schedule.edit(task.id, { action: 'delete' }); back() } }}><Icon name="trash" size={20} /></button> : null}>
      {task ? <Pivot active={tab} onChange={setTab} tabs={[{ id: 'rules', label: t('rules') }, { id: 'records', label: t('records') }]} /> : null}
      {tab === 'rules' ? (
        <div className="pad">
          <Field label={t('taskName')}><input className="input" value={title} maxLength={120} onInput={e => setTitle(e.target.value)} /></Field>
          <Field label={t('taskInstruction')}><textarea className="input textarea" rows={4} value={promptText} onInput={e => setPrompt(e.target.value)} /></Field>
          <Field label={t('runIn')}><Select value={target} onChange={setTarget} options={[{ value: 'new_once', label: t('runReuse') }, { value: 'new', label: t('runNew') }].concat(task && task.target === 'this_session' ? [{ value: 'this_session', label: t('runThis') }] : [])} /></Field>
          <Field label={t('linkedWorkspace')}><Select value={wsId} onChange={setWs} options={rt.workspaces.list().map(w => ({ value: w.id, label: wsName(w) }))} /></Field>
          <Field label={t('repeat')}><Select value={repeat} onChange={setRepeat} options={['once', 'minutes', 'hours', 'day', 'week', 'weekdays', 'month', 'custom'].map(k => ({ value: k, label: t('rep_' + k) }))} /></Field>
          {repeat === 'minutes' || repeat === 'hours' ? <Field label={t('every')}><input className="input" type="number" min="1" value={every} onChange={e => setEvery(parseInt(e.target.value, 10) || 1)} /></Field> : null}
          {repeat !== 'custom' ? <Field label={t('startAt')}><input className="input" type="datetime-local" value={start} onChange={e => setStart(e.target.value)} /></Field>
            : <Field label="RRULE" hint="DTSTART;TZID=Asia/Shanghai:20261201T090000 + newline + RRULE:FREQ=DAILY"><textarea className="input textarea mono" rows={3} value={custom} onInput={e => setCustom(e.target.value)} /></Field>}
          <div className="muted small">{t('nextRun')}: {preview}</div>
          {error ? <div className="err">{error}</div> : null}
          <div className="row gap pad-v wrap">
            <Button kind="primary" onClick={save}>{t('save')}</Button>
            {task ? <Button onClick={() => { rt.schedule.edit(task.id, { action: 'update', active: !task.active }); toast(task.active ? t('paused') : t('enabled')) }}>{task.active ? t('pause') : t('resume')}</Button> : null}
            {task ? <Button icon="play" onClick={async () => { await rt.schedule.runNow(task.id); toast(t('runNow') + ' ✓') }}>{t('runNow')}</Button> : null}
          </div>
        </div>
      ) : (
        <div>
          {(task.runs || []).slice().reverse().map((r, i) => (
            <ListItem key={i} icon={r.status === 'failed' ? 'warning' : 'check'} title={new Date(r.at).toLocaleString()} subtitle={(r.manual ? t('runNow') + ' · ' : '') + (r.error || r.status)}
              onClick={r.sessionId ? () => navigate('chat', { sessionId: r.sessionId }) : undefined} />
          ))}
          {!(task.runs || []).length ? <Empty icon="clock" text="—" /> : null}
        </div>
      )}
    </Page>
  )
}
