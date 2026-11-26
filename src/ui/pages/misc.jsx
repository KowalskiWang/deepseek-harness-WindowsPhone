import { h } from 'preact'
import { useState, useEffect } from 'preact/hooks'
import { Icon, Logo } from '../icons.jsx'
import { t } from '../i18n.js'
import { ui, navigate, useRuntime } from '../store.js'
import { Page, Section, ListItem, Empty, Button, Spinner, fmtTokens, copyText } from '../components.jsx'
import { Markdown } from '../markdown.jsx'
import { formatClock } from '../../core/util.js'
import { wsName } from './home.jsx'

export function TextPage({ params }) {
  return (
    <Page title={params.title || ''} actions={<button className="icon-btn" onClick={() => copyText(params.text)}><Icon name="copy" size={20} /></button>}>
      <div className="pad"><Markdown text={params.text} onLink={url => ui.platform.openExternal(url)} onCopy={copyText} /></div>
    </Page>
  )
}

export function ImagePage({ params }) {
  return <Page title=""><div className="pad center"><img className="preview-img" src={params.src} alt="" /></div></Page>
}

export function PanelPage({ params }) {
  const rt = ui.rt
  const [agent, setAgent] = useState(rt.getAgent(params.sessionId))
  useEffect(() => { if (!agent) rt.agentFor(params.sessionId).then(setAgent) }, [])
  useRuntime(['agent', 'sessions'], (ev, a) => ev !== 'agent' || !agent || a === agent || (a && a.parent === agent), 300)
  if (!agent) return <Page title={t('sessionPanel')}><Spinner /></Page>
  const meta = agent.meta
  const ws = rt.workspaces.get(meta.workspaceId)
  const totals = agent.usageTotals()
  const ctx = agent.contextUsage()
  const children = rt.sessions.list().filter(m => m.parentId === meta.id && m.isSubagent)
  const deliverables = []
  for (const ev of agent.session.events) if (ev.type === 'deliverables/present') for (const f of ev.data.files || []) deliverables.push(f)
  // timing stats
  let llmMs = 0, toolMs = 0, ttft = [], outTokens = 0
  for (const ev of agent.session.events) {
    if (ev.type === 'assistant/message') { llmMs += ev.data.durationMs || 0; if (ev.data.ttftMs) ttft.push(ev.data.ttftMs); outTokens += (ev.data.usage && ev.data.usage.output) || 0 }
    if (ev.type === 'tool/result') toolMs += ev.data.durationMs || 0
  }
  const avgTtft = ttft.length ? Math.round(ttft.reduce((a, b) => a + b, 0) / ttft.length) : 0
  const tps = llmMs ? (outTokens / (llmMs / 1000)).toFixed(1) : '0'
  return (
    <Page title={t('sessionPanel')} subtitle={meta.title}>
      <Section title={t('environment')}>
        <ListItem icon="folder" title={t('workingFolder')} subtitle={agent.cwd()} onClick={() => navigate('files', { root: agent.cwd(), title: wsName(ws), sessionId: meta.id })} />
        <ListItem icon="info" title="Session ID" subtitle={meta.id} onClick={() => copyText(meta.id)} />
      </Section>
      <Section title={t('subagents')}>
        {children.length ? children.map(c => {
          const a = rt.getAgent(c.id)
          return <ListItem key={c.id} icon="agent" title={c.agentName + ' — ' + (c.title || '')} subtitle={a && a.running ? t('running') : t('idle')} onClick={() => navigate('chat', { sessionId: c.id })} right={a && a.running ? <span className="status-dot running" /> : null} />
        }) : <div className="muted small pad">—</div>}
      </Section>
      {deliverables.length ? (
        <Section title={t('deliverables')}>
          {deliverables.map((f, i) => <ListItem key={i} icon="file" title={f.path.split('/').pop()} subtitle={f.description || f.path} onClick={() => navigate('preview', { path: f.path })} />)}
        </Section>
      ) : null}
      <Section title={t('statistics')}>
        <div className="stats-grid">
          <div><b>{totals.requests}</b><span>{t('requests')}</span></div>
          <div><b>{fmtTokens(totals.input)}</b><span>{t('inputTokens')}</span></div>
          <div><b>{fmtTokens(totals.cacheRead)}</b><span>{t('cachedTokens')}</span></div>
          <div><b>{fmtTokens(totals.output)}</b><span>{t('outputTokens')}</span></div>
          <div><b>{fmtTokens(totals.reasoning)}</b><span>{t('reasoningTokens')}</span></div>
          <div><b>{Math.round(ctx.ratio * 1000) / 10}%</b><span>{t('contextUsed', { p: '' })}</span></div>
          <div><b>{formatClock(llmMs)}</b><span>LLM</span></div>
          <div><b>{formatClock(toolMs)}</b><span>Tools</span></div>
          <div><b>{avgTtft} ms</b><span>TTFT</span></div>
          <div><b>{tps}</b><span>tok/s</span></div>
        </div>
      </Section>
    </Page>
  )
}

export function AboutPage() {
  return (
    <Page title={t('about')}>
      <div className="pad center">
        <Logo size={72} />
        <div className="hero-title">DSH Mobile</div>
        <div className="muted">{typeof __DSH_VERSION__ !== 'undefined' ? __DSH_VERSION__ : ''} · {ui.platform.hint}</div>
      </div>
      <div className="pad">
        <p>{t('aboutBody')}</p>
        <p className="muted small">MIT License. DeepSeek Harness © 2026 DeepSeek (MIT). Preact (MIT), core-js (MIT), sval (MIT).</p>
        <Button onClick={() => ui.platform.openExternal('https://github.com/deepseek-ai/deepseek-harness')}>GitHub · deepseek-harness</Button>
        <div className="pad-v"><Button onClick={() => navigate('selftest')}>{t('selfTest')}</Button></div>
      </div>
    </Page>
  )
}

export { Empty }
