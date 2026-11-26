// Desktop dsh, driven from the phone: sessions that run on the computer under
// DeepSeek Harness (`dsh --profile acp` behind the gateway's --dsh bridge).
import { h } from 'preact'
import { useState, useEffect, useRef, useReducer } from 'preact/hooks'
import { Icon } from '../icons.jsx'
import { t } from '../i18n.js'
import { ui, navigate, replace, menu, confirm, toast } from '../store.js'
import { Page, Section, ListItem, Empty, Button, Spinner, relTime, copyText } from '../components.jsx'
import { Markdown } from '../markdown.jsx'
import { toolSummary, hasPending } from '../../core/remote-dsh.js'
import { clip, throttle } from '../../core/util.js'

function useRemote() {
  const [, force] = useReducer(x => x + 1, 0)
  useEffect(() => ui.rt.remote.on('change', throttle(force, 150)), [])
  return ui.rt.remote
}

function baseName(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
}

function stateLine(remote) {
  if (!remote.configured()) return t('dshNeedsGateway')
  if (remote.state === 'error') return t('dshOffline') + (remote.error ? ' · ' + remote.error : '')
  if (remote.state === 'connected') return t('dshConnected')
  return t('dshConnecting')
}

/** Remote sessions on the computer: the phone's copies first, then the computer's other stored sessions. */
export function RemoteHomePage() {
  const remote = useRemote()
  const [others, setOthers] = useState(null)
  useEffect(() => {
    if (!remote.configured()) return
    remote.start()
    remote.remoteList().then(list => setOthers(list.filter(x => !remote.get(x.sessionId))), (e) => setOthers({ error: e.message }))
  }, [])
  const open = async (x) => {
    const s = remote.ensureSession(x.sessionId, x.cwd)
    if (!s.title) s.title = x.title || baseName(x.cwd)
    remote.touch(s)
    navigate('remote-chat', { sessionId: s.id })
  }
  const onLong = async (s) => {
    const v = await menu(s.title || baseName(s.cwd), [{ label: t('copyId'), icon: 'copy', value: 'id' }, { label: t('delete'), icon: 'trash', value: 'del', danger: true }])
    if (v === 'id') copyText(s.id)
    if (v === 'del' && await confirm({ title: t('delete'), body: t('dshDeleteBody'), danger: true })) remote.remove(s.id)
  }
  const list = remote.list()
  return (
    <Page title={t('desktopDsh')} subtitle={stateLine(remote)}>
      <div className="pad">
        <p className="muted small">{t('dshIntro')}</p>
        <Button kind="primary" icon="add" disabled={!remote.configured()} onClick={() => navigate('remote-folder', {})}>{t('dshNewSession')}</Button>
      </div>
      {list.length ? (
        <Section title={t('dshOnPhone')}>
          {list.map(s => (
            <ListItem key={s.id} icon={s.running ? 'play' : 'terminal'} title={s.title || baseName(s.cwd)} subtitle={baseName(s.cwd) + ' · ' + relTime(s.updatedAt)}
              right={hasPending(s) ? <span className="status-dot warn" /> : s.running ? <span className="status-dot running" /> : null}
              onClick={() => navigate('remote-chat', { sessionId: s.id })} onLongPress={() => onLong(s)} />
          ))}
        </Section>
      ) : null}
      {others && others.length ? (
        <Section title={t('dshOnComputer')}>
          {others.map(x => <ListItem key={x.sessionId} icon="terminal" title={x.title || baseName(x.cwd)} subtitle={x.cwd} onClick={() => open(x)} />)}
        </Section>
      ) : null}
      {others && others.error ? <div className="pad muted small">{others.error}</div> : null}
      {!list.length && (!others || !others.length) && remote.configured() ? <Empty icon="terminal" text={t('dshEmpty')} /> : null}
    </Page>
  )
}

/** Choose the working folder on the computer, then start a session there. */
export function RemoteFolderPage({ params }) {
  const remote = ui.rt.remote
  const [ls, setLs] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    remote.ls(params.path || '').then(r => { if (alive) setLs(r) }, e => { if (alive) setLs({ error: e.message }) })
    return () => { alive = false }
  }, [params.path])
  const start = async () => {
    setBusy(true)
    try {
      const s = await remote.newSession(ls.path)
      replace('remote-chat', { sessionId: s.id })
    } catch (e) { toast(e.message, { kind: 'error' }); setBusy(false) }
  }
  if (!ls) return <Page title={t('dshChooseFolder')}><div className="pad center"><Spinner size={24} /></div></Page>
  if (ls.error) return <Page title={t('dshChooseFolder')}><div className="pad err">{ls.error}</div></Page>
  return (
    <Page title={baseName(ls.path) || ls.path} subtitle={ls.path}>
      <div className="pad">
        <Button kind="primary" icon="terminal" disabled={busy} onClick={start}>{busy ? t('dshStarting') : t('dshStartHere')}</Button>
      </div>
      {ls.parent ? <ListItem icon="back" title=".." subtitle={ls.parent} onClick={() => replace('remote-folder', { path: ls.parent })} /> : null}
      {ls.dirs.map(d => <ListItem key={d} icon="folder" title={d} onClick={() => replace('remote-folder', { path: ls.path + '/' + d })} />)}
      {!ls.dirs.length ? <div className="pad muted small">{t('dshNoSubfolders')}</div> : null}
    </Page>
  )
}

function Thought({ it }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={'thinking' + (open ? ' open' : '')} onClick={() => setOpen(!open)}>
      <div className="thinking-head"><Icon name="sparkle" size={14} /><span>{t('thought')}</span>{!open ? <span className="thinking-preview">{clip(it.text.replace(/\s+/g, ' '), 60)}</span> : null}</div>
      {open ? <div className="thinking-body">{it.text}</div> : null}
    </div>
  )
}

function Tool({ it }) {
  const [open, setOpen] = useState(false)
  const running = it.status === 'in_progress' || it.status === 'pending'
  const failed = it.status === 'failed'
  return (
    <div className={'tool-row' + (failed ? ' failed' : '') + (running ? ' running' : '')}>
      <div className="tool-head" onClick={() => setOpen(!open)}>
        <Icon name="terminal" size={14} />
        <span className="tool-verb">{it.title}</span>
        <span className="tool-target">{clip(String(toolSummary(it)).replace(/\s+/g, ' '), 120)}</span>
        <span className="tool-state">{running ? <Spinner size={12} /> : failed ? '✗' : '✓'}</span>
      </div>
      {open ? (
        <div>
          {it.input !== undefined ? <pre className="tool-pre">{typeof it.input === 'string' ? it.input : JSON.stringify(it.input, null, 1)}</pre> : null}
          {it.output ? <pre className={'tool-pre' + (failed ? ' error' : '')}>{clip(it.output, 6000)}</pre> : null}
        </div>
      ) : null}
    </div>
  )
}

function Permission({ s, it }) {
  const remote = ui.rt.remote
  const tool = s.items.filter(x => x.kind === 'tool' && x.toolCallId === it.toolCallId)[0]
  const answer = (optionId) => remote.answer(s.id, it.requestId, optionId).catch(e => toast(e.message, { kind: 'error' }))
  if (it.decided) {
    const label = it.decided === 'cancelled' ? t('dshPermCancelled') : /reject/.test(it.decided) ? t('dshPermRejected') : t('dshPermAllowed')
    return <div className="marker"><Icon name="shield" size={13} />{label}{tool ? ' · ' + clip(String(toolSummary(tool)), 60) : ''}</div>
  }
  return (
    <div className="card interact">
      <div className="interact-strip"><Icon name="shield" size={14} />{t('waitingForApproval')}</div>
      <div className="interact-title">{t('dshPermTitle', { tool: tool ? tool.title : 'tool' })}</div>
      {tool && tool.input !== undefined ? <pre className="tool-pre">{clip(typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input, null, 1), 1200)}</pre> : null}
      <div className="interact-buttons">
        {(it.options || []).slice().sort((a, b) => (/^allow/.test(a.kind) ? 1 : 0) - (/^allow/.test(b.kind) ? 1 : 0)).map(o => <Button key={o.optionId} kind={/^allow/.test(o.kind) ? 'primary' : undefined} onClick={() => answer(o.optionId)}>{/^allow_once/.test(o.kind) ? t('allowOnce') : /^reject/.test(o.kind) ? t('reject') : o.name}</Button>)}
      </div>
    </div>
  )
}

function End({ it }) {
  if (it.error) return <div className="error-row"><Icon name="warning" size={14} /><span className="error-text">{it.error}</span></div>
  const label = it.stopReason === 'cancelled' ? t('dshStopped') : it.stopReason === 'max_tokens' ? t('dshMaxTokens') : t('dshDone')
  return <div className="marker"><Icon name="check" size={13} />{label}</div>
}

export function RemoteChatPage({ params }) {
  const remote = useRemote()
  const s = remote.get(params.sessionId)
  const [text, setText] = useState('')
  const scrollRef = useRef(null)
  const stick = useRef(true)
  const inputRef = useRef(null)
  useEffect(() => { remote.start() }, [])
  useEffect(() => { const el = scrollRef.current; if (el && stick.current) el.scrollTop = el.scrollHeight })
  useEffect(() => ui.on('keyboard', () => setTimeout(() => { const el = scrollRef.current; if (el && stick.current) el.scrollTop = el.scrollHeight }, 60)), [])
  if (!s) return <Page title={t('desktopDsh')}><Empty icon="terminal" text={t('dshMissing')} /></Page>
  const onScroll = () => { const el = scrollRef.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }
  const send = async () => {
    const v = text.trim()
    if (!v || s.running) return
    const hadFocus = document.activeElement === inputRef.current
    setText('')
    stick.current = true
    try { await remote.prompt(s.id, v) } catch (e) { toast(e.message, { kind: 'error' }) }
    if (hadFocus && inputRef.current) { try { inputRef.current.focus() } catch (e) { /* gone */ } }
  }
  // dsh's session options: the model and, for models that reason, the effort
  const options = (s.config || []).filter(c => c.type === 'select' && (c.id === 'model' || c.id === 'reasoning_effort'))
  // options may come in groups ({group, name, options}), e.g. models by provider
  const flat = c => (c.options || []).reduce((a, o) => a.concat(o.options ? o.options.map(x => Object.assign({ groupName: o.name }, x)) : [o]), [])
  const pick = async (c) => {
    const v = await menu(c.id === 'model' ? t('selectModel') : t('reasoningEffort'), flat(c).map(o => ({ label: o.name || o.value, value: o.value, checked: o.value === c.currentValue, hint: o.groupName })))
    if (v && v !== c.currentValue) remote.setConfig(s.id, c.id, v).catch(e => toast(e.message, { kind: 'error' }))
  }
  const optionLabel = c => clip(flat(c).filter(o => o.value === c.currentValue).map(o => o.name || o.value)[0] || String(c.currentValue), 18)
  const usage = s.usage && s.usage.size ? Math.round(1000 * s.usage.used / s.usage.size) / 10 + '%' : ''
  return (
    <Page title={s.title || baseName(s.cwd)} subtitle={s.cwd + (usage ? ' · ' + usage : '')} scrollRef={scrollRef} onScroll={onScroll}
      actions={options.length ? options.map(c => <button key={c.id} className="chip chip-model" onClick={() => pick(c)}>{optionLabel(c)}</button>) : null}
      appBar={(
        <div className="composer-wrap">
          <div className="composer">
            <textarea ref={inputRef} className="composer-input" rows={1} value={text} onInput={e => setText(e.target.value)} placeholder={t('dshPlaceholder')} />
            <div className="composer-bar">
              <span className="muted small">{stateLine(remote)}</span>
              <span className="flex1" />
              {s.running
                ? <button className="send-btn stop" onClick={() => remote.cancel(s.id).catch(e => toast(e.message, { kind: 'error' }))} aria-label={t('stop')}><Icon name="stop" size={18} /></button>
                : <button className={'send-btn' + (text.trim() ? '' : ' disabled')} onMouseDown={e => { if (document.activeElement === inputRef.current) e.preventDefault() }} onClick={send} aria-label={t('send')}><Icon name="send" size={18} /></button>}
            </div>
          </div>
        </div>
      )}>
      <div className="transcript">
        {!s.items.length ? <div className="pad muted small">{t('dshFirstPrompt')}</div> : null}
        {s.items.map((it, i) => {
          if (it.kind === 'user') return <div key={i} className="bubble-row"><div className="bubble"><div className="bubble-text">{it.text}</div></div></div>
          if (it.kind === 'thought') return <Thought key={i} it={it} />
          if (it.kind === 'message') return <div key={i} className="turn"><Markdown text={it.text} onLink={url => ui.platform.openExternal(url)} onCopy={copyText} /></div>
          if (it.kind === 'tool') return <Tool key={i} it={it} />
          if (it.kind === 'permission') return <Permission key={i} s={s} it={it} />
          if (it.kind === 'end') return <End key={i} it={it} />
          return null
        })}
        {s.running && !hasPending(s) ? <div className="status-line"><span className="whale" />{t('dshWorking')}</div> : null}
      </div>
    </Page>
  )
}
