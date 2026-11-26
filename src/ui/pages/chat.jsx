import { h } from 'preact'
import { useState, useEffect, useRef } from 'preact/hooks'
import { Icon } from '../icons.jsx'
import { t } from '../i18n.js'
import { ui, navigate, menu, prompt, toast, dialog, useRuntime } from '../store.js'
import { Page, Spinner, copyText, fmtTokens } from '../components.jsx'
import { Transcript } from '../transcript.jsx'
import { Composer, TodoDock, GoalDock, QueueDock, ApprovalCard, QuestionCard, PlanCard, pickModel, PERM_LABEL } from '../composer.jsx'
import { wsName } from './home.jsx'
import { clip } from '../../core/util.js'
import { resolve as resolvePath } from '../../core/paths.js'

export function openLink(agent, url) {
  if (/^(https?:|mailto:)/i.test(url)) { ui.platform.openExternal(url); return }
  const path = resolvePath(agent ? agent.cwd() : '/', url.replace(/:\d+$/, ''))
  navigate('preview', { path })
}

async function exportLog(agent, jsonl) {
  const rt = ui.rt
  const name = (agent.meta.title || 'session').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) + '-' + new Date().toISOString().slice(0, 10) + '.jsonl'
  if (ui.platform.saveFile) {
    try { const saved = await ui.platform.saveFile(name, jsonl, 'application/x-ndjson'); if (saved) { toast(t('exportDone', { path: saved })); return } } catch (e) { /* fall back */ }
  }
  const path = agent.workspaceRoot() + '/dsh-exports/' + name
  await rt.vfs.writeText(path, jsonl)
  toast(t('exportDone', { path }))
}

export function ChatPage({ params }) {
  const rt = ui.rt
  const [agent, setAgent] = useState(() => rt.getAgent(params.sessionId) || null)
  const [limit, setLimit] = useState(15)
  const [atBottom, setAtBottom] = useState(true)
  const scrollRef = useRef(null)
  const stick = useRef(true)

  useEffect(() => {
    let alive = true
    if (!agent) rt.agentFor(params.sessionId).then(a => { if (alive) setAgent(a) })
    return () => { alive = false }
  }, [params.sessionId])

  useEffect(() => {
    if (!agent) return undefined
    rt.activeSessionId = agent.session.id
    if (agent.meta.unread) rt.sessions.updateMeta(agent.session.id, { unread: false })
    const off = ui.on('export', (e) => { if (e.agent === agent) exportLog(agent, e.jsonl).catch(err => toast(err.message, { kind: 'error' })) })
    return () => { off(); if (rt.activeSessionId === agent.session.id) rt.activeSessionId = null }
  }, [agent])

  useRuntime(['agent', 'sessions', 'settings'], (ev, a) => ev !== 'agent' || a === agent, 120)

  useEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })

  // The keyboard shrinks the page: keep the latest message in view.
  useEffect(() => ui.on('keyboard', () => {
    setTimeout(() => { const el = scrollRef.current; if (el && stick.current) el.scrollTop = el.scrollHeight }, 60)
  }), [])

  if (!agent) return <Page title="…"><div className="center pad"><Spinner size={24} /></div></Page>

  const meta = agent.meta
  const settings = rt.settings.get().general
  const ws = rt.workspaces.get(meta.workspaceId)
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    stick.current = near
    if (near !== atBottom) setAtBottom(near)
  }

  const handlers = {
    onLink: url => openLink(agent, url),
    copy: text => copyText(text),
    openFile: path => navigate('preview', { path }),
    openSession: id => navigate('chat', { sessionId: id }),
    openText: (title, text) => navigate('text', { title, text }),
    viewImage: im => navigate('image', { src: `data:${im.mime};base64,${im.data}` }),
    loadEarlier: () => { stick.current = false; setLimit(limit + 15) },
    continueGen: () => rt.continueGeneration(agent),
    feedback: async (turn, rating) => {
      const r = await dialog('feedback', { rating })
      if (!r) return
      agent.session.append('feedback', { turn: turn.turn, rating, category: r.category, text: r.text })
      toast(t('feedbackThanks'))
    },
    branch: async () => {
      const child = await rt.forkSession(agent.session.id)
      navigate('chat', { sessionId: child.session.id })
    },
    turnUsage: (turn) => {
      const u = turn.usage
      const lines = [`${t('turnUsage')}: ${u.provider}/${u.model}`, `${t('inputTokens')}: ${u.input}`, `${t('cachedTokens')}: ${u.cacheRead}`, `cache write: ${u.cacheWrite}`, `${t('outputTokens')}: ${u.output} (${t('reasoningTokens')} ${u.reasoning})`, `${t('requests')}: ${u.requests}`]
      navigate('text', { title: t('turnUsage'), text: lines.join('\n\n') })
    },
  }

  const openModel = async () => {
    const sel = await pickModel(rt, agent.selection())
    if (sel) agent.setSelection(sel)
  }

  const sessionMenu = async () => {
    const v = await menu(clip(meta.title || t('untitled'), 40), [
      { label: t('rename'), icon: 'edit', value: 'rename' },
      { label: t('sessionPanel'), icon: 'panel', value: 'panel' },
      { label: t('files'), icon: 'folder', value: 'files' },
      { label: t('fork'), icon: 'fork', value: 'fork', disabled: meta.blank },
      { label: meta.pinned ? t('unpin') : t('pin'), icon: 'pin', value: 'pin' },
      { label: t('copyMarkdown'), icon: 'copy', value: 'md' },
      { label: t('downloadLog'), icon: 'download', value: 'log' },
      { label: t('cmd_compact'), icon: 'archive', value: 'compact', disabled: agent.running },
      { label: t('copyId'), icon: 'copy', value: 'id' },
    ])
    if (v === 'rename') {
      const name = await prompt({ title: t('rename'), value: meta.title, placeholder: t('sessionName') })
      if (name !== undefined) rt.sessions.updateMeta(meta.id, { title: name.trim() || meta.title, titleSource: 'user' })
    } else if (v === 'panel') navigate('panel', { sessionId: meta.id })
    else if (v === 'files') navigate('files', { root: agent.cwd(), title: wsName(ws), sessionId: meta.id })
    else if (v === 'fork') { const c = await rt.forkSession(meta.id); navigate('chat', { sessionId: c.session.id }) }
    else if (v === 'pin') rt.sessions.updateMeta(meta.id, { pinned: !meta.pinned })
    else if (v === 'md') copyText(await rt.exportMarkdown(meta.id), t('copyMarkdown'))
    else if (v === 'log') exportLog(agent, await rt.sessions.exportJsonl(meta.id)).catch(e => toast(e.message, { kind: 'error' }))
    else if (v === 'compact') {
      try { const r = await agent.compact({ reason: 'command' }); toast(r && r.compacted ? t('compacted', { n: r.items, t: fmtTokens(r.tokens) }) : t('contextCompacted')) } catch (e) { toast(e.message, { kind: 'error' }) }
    } else if (v === 'id') copyText(meta.id, 'Session ID')
  }

  const pending = agent.pending
  const subtitle = (meta.isSubagent ? t('subagents') + ' · ' + (meta.agentName || '') : wsName(ws)) + ' · ' + t(PERM_LABEL[agent.permissionPreset()])
  const empty = !agent.session.events.length && !agent.running && !agent.inbox.nextTurn.length

  return (
    <Page
      className="chat"
      header={<div className="page-title tappable" onClick={sessionMenu}>{meta.title || (meta.blank ? t('newSession') : t('untitled'))}</div>}
      subtitle={subtitle}
      scrollRef={scrollRef}
      onScroll={onScroll}
      actions={[
        <button key="p" className="icon-btn" onClick={() => navigate('panel', { sessionId: meta.id })} aria-label={t('sessionPanel')}>
          <Icon name="panel" size={20} />{Object.keys(agent.children).some(k => agent.children[k].agent.running) ? <span className="blue-dot" /> : null}
        </button>,
        <button key="m" className="icon-btn" onClick={sessionMenu} aria-label={t('moreActions')}><Icon name="more" size={22} /></button>,
      ]}
      appBar={
        <div className="chat-footer">
          {!atBottom ? <button className="to-bottom" onClick={() => { stick.current = true; const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; setAtBottom(true) }}><Icon name="chevronDown" size={16} />{t('backToBottom')}</button> : null}
          <TodoDock agent={agent} />
          <GoalDock agent={agent} />
          <QueueDock agent={agent} />
          {pending && pending.kind === 'approval' ? <ApprovalCard agent={agent} />
            : pending && pending.kind === 'question' ? <QuestionCard key={pending.id} agent={agent} />
              : pending && pending.kind === 'plan' ? <PlanCard key={pending.id} agent={agent} onViewPlan={plan => navigate('text', { title: t('plan'), text: plan })} />
                : <Composer agent={agent} onOpenModel={openModel} />}
        </div>
      }
    >
      {empty ? (
        <div className="hero small">
          <div className="hero-title">{t('heroTitle')}</div>
          <button className="ws-chip" onClick={() => dialog('workspaces', { current: meta.workspaceId, onPick: async (w) => { if (w.id !== meta.workspaceId) { const a = await rt.newSession({ workspaceId: w.id }); navigate('chat', { sessionId: a.session.id }) } } })}>
            <Icon name="folder" size={16} />{wsName(ws)}<Icon name="chevronDown" size={14} />
          </button>
          <div className="muted small">{agent.cwd()}</div>
        </div>
      ) : (
        <Transcript agent={agent} handlers={handlers} settings={settings} limit={limit} />
      )}
    </Page>
  )
}
