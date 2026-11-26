import { h } from 'preact'
import { useState, useEffect } from 'preact/hooks'
import { Icon, Logo } from '../icons.jsx'
import { t } from '../i18n.js'
import { ui, navigate, menu, prompt, confirm, toast, dialog, closeOverlay, useRuntime } from '../store.js'
import { AppBar, ListItem, Empty, relTime, copyText, Button, registerOverlay, Select, Field } from '../components.jsx'
import { clip } from '../../core/util.js'

export function wsName(ws) {
  if (!ws) return t('ungrouped')
  return ws.isDefault ? t('defaultWorkspace') : ws.name
}

function statusOf(meta) {
  switch (meta.status) {
    case 'running': return { cls: 'running', label: t('running') }
    case 'approval': return { cls: 'warn', label: t('waitingApproval') }
    case 'plan-review': return { cls: 'warn', label: t('planReview') }
    case 'question': return { cls: 'warn', label: t('waitingAnswer') }
    case 'failed': return { cls: 'fail', label: t('runFailed') }
    default: return meta.unread ? { cls: 'unread', label: t('unread') } : null
  }
}

export async function sessionMenu(meta) {
  const rt = ui.rt
  const v = await menu(clip(meta.title || t('untitled'), 40), [
    { label: meta.pinned ? t('unpin') : t('pin'), icon: 'pin', value: 'pin' },
    { label: t('rename'), icon: 'edit', value: 'rename' },
    { label: t('fork'), icon: 'fork', value: 'fork', disabled: meta.blank },
    { label: t('copyId'), icon: 'copy', value: 'copyId' },
    { label: meta.unread ? t('markRead') : t('markUnread'), icon: 'check', value: 'read' },
    { separator: true },
    { label: meta.archived ? t('unarchive') : t('archive'), icon: 'archive', value: 'archive' },
  ])
  if (!v) return
  if (v === 'pin') rt.sessions.updateMeta(meta.id, { pinned: !meta.pinned })
  else if (v === 'rename') {
    const name = await prompt({ title: t('rename'), value: meta.title, placeholder: t('sessionName') })
    if (name !== undefined) rt.sessions.updateMeta(meta.id, { title: name.trim() || meta.title, titleSource: 'user' })
  } else if (v === 'fork') {
    const child = await rt.forkSession(meta.id)
    toast(t('fork') + ' · ' + (child.meta.title || ''))
  } else if (v === 'copyId') copyText(meta.id, 'Session ID')
  else if (v === 'read') rt.sessions.updateMeta(meta.id, { unread: !meta.unread })
  else if (v === 'archive') {
    if (!meta.archived) {
      const agent = rt.getAgent(meta.id)
      if (agent && agent.running) {
        const ok = await confirm({ title: t('stopAndArchive'), danger: true, okLabel: t('archive') })
        if (!ok) return
        agent.cancel('archive')
      }
      rt.sessions.updateMeta(meta.id, { archived: true })
      toast(t('archived'), { action: t('undo'), onAction: () => rt.sessions.updateMeta(meta.id, { archived: false }) })
    } else rt.sessions.updateMeta(meta.id, { archived: false })
  }
}

export async function openSession(id) {
  const rt = ui.rt
  const meta = rt.sessions.getMeta(id)
  if (meta && meta.archived) { toast(t('archived'), { action: t('unarchive'), onAction: () => rt.sessions.updateMeta(id, { archived: false }) }); return }
  navigate('chat', { sessionId: id })
}

export async function startNewSession(workspaceId) {
  const rt = ui.rt
  if (!rt.workspaces.list().length) { await dialog('workspaces', {}); return }
  const agent = await rt.newSession({ workspaceId })
  navigate('chat', { sessionId: agent.session.id })
}

function SessionRow({ meta }) {
  const st = statusOf(meta)
  return (
    <ListItem
      className={'session-row' + (meta.archived ? ' archived' : '')}
      icon={<span className={'status-dot ' + (st ? st.cls : '')} />}
      title={<span>{meta.pinned ? <Icon name="pin" size={12} /> : null} {meta.title || t('untitled')}</span>}
      subtitle={st && st.cls !== 'unread' ? st.label : null}
      right={<span className="muted small">{relTime(meta.updatedAt || meta.createdAt)}</span>}
      onClick={() => openSession(meta.id)}
      onLongPress={() => sessionMenu(meta)}
    />
  )
}

function Group({ ws, items, view }) {
  const [shown, setShown] = useState(5)
  const rt = ui.rt
  const onMenu = async () => {
    const v = await menu(wsName(ws), [
      { label: t('newSession'), icon: 'add', value: 'new' },
      { label: t('files'), icon: 'folder', value: 'files' },
      ws && !ws.isDefault ? { label: t('deleteWorkspace'), icon: 'trash', value: 'delete', danger: true } : null,
    ])
    if (v === 'new') startNewSession(ws && ws.id)
    else if (v === 'files') navigate('files', { root: ws.path, title: wsName(ws) })
    else if (v === 'delete') {
      const ok = await confirm({ title: t('deleteWorkspace'), body: t('deleteWorkspaceBody'), danger: true, okLabel: t('delete') })
      if (ok) { await rt.workspaces.remove(ws.id); for (const m of rt.sessions.list()) if (m.workspaceId === ws.id) rt.sessions.updateMeta(m.id, { workspaceId: null }) }
    }
  }
  return (
    <div className="group">
      {view.groupBy === 'workspace' ? (
        <div className="group-head" onClick={onMenu}>
          <Icon name="folder" size={16} /><span className="group-name">{wsName(ws)}</span>
          {ws && ws.kind === 'device' ? <span className="badge">SD</span> : null}
          {ws ? <button className="icon-btn small" onClick={(e) => { e.stopPropagation(); startNewSession(ws.id) }}><Icon name="add" size={16} /></button> : null}
        </div>
      ) : null}
      {items.slice(0, shown).map(m => <SessionRow key={m.id} meta={m} />)}
      {items.length > shown ? <button className="link-btn" onClick={() => setShown(shown + 5)}>{t('showMore', { n: items.length - shown })}</button> : null}
      {shown > 5 && items.length <= shown ? <button className="link-btn" onClick={() => setShown(5)}>{t('showLess')}</button> : null}
    </div>
  )
}

export function HomePage() {
  const rt = ui.rt
  useRuntime(['sessions', 'workspaces', 'settings', 'agent'], null, 300)
  const [query, setQuery] = useState(null)
  const [contentHits, setContentHits] = useState([])
  const view = rt.settings.get().sessionList
  const all = rt.sessions.list().filter(m => !m.isSubagent && !(m.blank && !m.title))

  useEffect(() => {
    if (!query || query.length < 2) { setContentHits([]); return undefined }
    const timer = setTimeout(async () => {
      const hits = []
      for (const m of all.slice(0, 40)) {
        try {
          const s = await rt.sessions.open(m.id)
          const found = s.events.some(ev => (ev.type === 'user/message' || ev.type === 'assistant/message') && (ev.data.content || []).some(b => b.type === 'text' && b.text.toLowerCase().indexOf(query.toLowerCase()) >= 0))
          if (found) hits.push(m.id)
        } catch (e) { /* skip */ }
      }
      setContentHits(hits)
    }, 250)
    return () => clearTimeout(timer)
  }, [query])

  let list = all
  if (view.filter === 'hide-archived') list = list.filter(m => !m.archived)
  else if (view.filter === 'archived-only') list = list.filter(m => m.archived)
  if (query) {
    const q = query.toLowerCase()
    list = all.filter(m => (m.title || '').toLowerCase().indexOf(q) >= 0 || m.id.indexOf(q) >= 0 || wsName(rt.workspaces.get(m.workspaceId)).toLowerCase().indexOf(q) >= 0 || contentHits.indexOf(m.id) >= 0).slice(0, 20)
  }
  const key = view.orderBy === 'created' ? 'createdAt' : 'updatedAt'
  list.sort((a, b) => (b.pinned - a.pinned) || ((b[key] || 0) - (a[key] || 0)))

  const groups = []
  if (view.groupBy === 'workspace' && !query) {
    const byWs = {}
    for (const m of list) (byWs[m.workspaceId || ''] || (byWs[m.workspaceId || ''] = [])).push(m)
    const wss = rt.workspaces.list().slice().sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))
    for (const ws of wss) groups.push({ ws, items: byWs[ws.id] || [] })
    if (byWs['']) groups.push({ ws: null, items: byWs[''] })
  } else groups.push({ ws: null, items: list })

  const needsKey = !rt.hasUsableModel()

  return (
    <div className="page home">
      <div className="page-header">
        <div className="brand" onClick={() => startNewSession()}><Logo size={26} /><span className="brand-name">DSH</span><span className="badge">{t('preview')}</span></div>
        <div className="page-actions">
          <button className="icon-btn" onClick={() => setQuery(query === null ? '' : null)} aria-label={t('searchSessions')}><Icon name="search" size={22} /></button>
        </div>
      </div>
      {query !== null ? (
        <div className="search-bar"><input className="input" autoFocus placeholder={t('searchSessions')} value={query} onInput={e => setQuery(e.target.value)} /></div>
      ) : null}
      <div className="page-body">
        {needsKey ? (
          <div className="banner warn" onClick={() => dialog('apikey', {})}><Icon name="key" size={16} /><span>{t('addApiKeyTitle')}</span><Icon name="chevronRight" size={16} /></div>
        ) : null}
        {!all.length && query === null ? (
          <div className="hero">
            <div className="hero-title">{t('heroTitle')}</div>
            <div className="muted">DeepSeek Harness · Windows Phone</div>
            <Button kind="primary" icon="add" onClick={() => startNewSession()}>{t('newSession')}</Button>
          </div>
        ) : null}
        {query !== null && !list.length ? <Empty icon="search" text={t('noMatches')} /> : null}
        {groups.map((g, i) => (g.items.length || (view.groupBy === 'workspace' && !query)) ? <Group key={(g.ws && g.ws.id) || 'none' + i} ws={g.ws} items={g.items} view={view} /> : null)}
      </div>
      <AppBar
        buttons={[
          { icon: 'add', label: t('newSession'), onClick: () => startNewSession() },
          { icon: 'clock', label: t('automation'), onClick: () => navigate('automation') },
          { icon: 'puzzle', label: t('plugins'), onClick: () => navigate('plugins') },
          { icon: 'settings', label: t('settings'), onClick: () => navigate('settings') },
        ]}
        menu={[
          { label: t('desktopDsh'), onClick: () => navigate('remote') },
          { label: t('viewOptions'), onClick: () => dialog('viewOptions', {}) },
          { label: t('addWorkspace'), onClick: () => dialog('workspaces', {}) },
          { label: t('files'), onClick: () => { const ws = rt.workspaces.mostRecent(); if (ws) navigate('files', { root: ws.path, title: wsName(ws) }) } },
          { label: t('about'), onClick: () => navigate('about') },
        ]}
      />
    </div>
  )
}

// ---------------------------------------------------------------- overlays

function ViewOptions({ o }) {
  const rt = ui.rt
  const [v, setV] = useState(rt.settings.get().sessionList)
  const set = (patch) => { const nv = Object.assign({}, v, patch); setV(nv); rt.settings.set('sessionList', nv) }
  return (
    <div className="dialog">
      <div className="dialog-title">{t('viewOptions')}</div>
      <Field label={t('groupBy')}><Select value={v.groupBy} onChange={x => set({ groupBy: x })} options={[{ value: 'workspace', label: t('groupWorkspace') }, { value: 'none', label: t('groupNone') }]} /></Field>
      <Field label={t('orderBy')}><Select value={v.orderBy} onChange={x => set({ orderBy: x })} options={[{ value: 'updated', label: t('orderUpdated') }, { value: 'created', label: t('orderCreated') }]} /></Field>
      <Field label={t('filter')}><Select value={v.filter} onChange={x => set({ filter: x })} options={[{ value: 'hide-archived', label: t('hideArchived') }, { value: 'all', label: t('showAll') }, { value: 'archived-only', label: t('archivedOnly') }]} /></Field>
      <div className="dialog-buttons"><Button kind="primary" onClick={() => closeOverlay(o)}>{t('close')}</Button></div>
    </div>
  )
}
registerOverlay('viewOptions', ViewOptions)

function WorkspacesDialog({ o }) {
  const rt = ui.rt
  useRuntime(['workspaces'])
  const pick = async (ws) => {
    rt.workspaces.touch(ws.id)
    closeOverlay(o, ws)
    if (o.props.onPick) o.props.onPick(ws)
  }
  const addApp = async () => {
    const name = await prompt({ title: t('newFolder'), placeholder: t('folderName') })
    if (!name) return
    try { const ws = await rt.workspaces.addAppFolder(name); pick(ws) } catch (e) { toast(e.message, { kind: 'error' }) }
  }
  const addDevice = async () => {
    try {
      const picked = await ui.platform.pickFolder()
      if (!picked) return
      const ws = await rt.workspaces.addDeviceFolder(picked)
      pick(ws)
    } catch (e) { toast(e.message, { kind: 'error' }) }
  }
  return (
    <div className="dialog dialog-tall">
      <div className="dialog-title">{t('chooseWorkspace')}</div>
      <div className="dialog-scroll">
        {rt.workspaces.list().map(ws => (
          <ListItem key={ws.id} icon="folder" title={wsName(ws)} subtitle={ws.path + (ws.unavailable ? ' · unavailable' : '')} onClick={() => pick(ws)}
            right={o.props.current === ws.id ? <Icon name="check" className="accent" /> : null} />
        ))}
      </div>
      <div className="dialog-buttons wrap">
        <Button icon="add" onClick={addApp}>{t('newFolder')}</Button>
        {ui.platform.pickFolder ? <Button icon="folder" onClick={addDevice}>{t('pickDeviceFolder')}</Button> : null}
        <Button onClick={() => closeOverlay(o)}>{t('close')}</Button>
      </div>
    </div>
  )
}
registerOverlay('workspaces', WorkspacesDialog)
