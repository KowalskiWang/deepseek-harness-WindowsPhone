import { h } from 'preact'
import { useState, useEffect } from 'preact/hooks'
import { Icon } from '../icons.jsx'
import { t } from '../i18n.js'
import { ui, navigate, menu, prompt, confirm, toast, useRuntime } from '../store.js'
import { Page, Pivot, Section, Field, Toggle, Select, Button, ListItem, Spinner, Empty } from '../components.jsx'
import { DEFAULT_SETTINGS } from '../../core/settings.js'
import { clone, shortId, safeJsonParse } from '../../core/util.js'
import { SecretField } from './settings.jsx'

function Num({ label, value, min, max, onChange }) {
  return <Field label={label}><input className="input" type="number" min={min} max={max} value={value} onChange={e => { const n = parseInt(e.target.value, 10); if (!Number.isNaN(n)) onChange(Math.max(min, Math.min(max, n))) }} /></Field>
}

function overridden(section) {
  const cur = ui.rt.settings.get()[section]
  return JSON.stringify(cur) !== JSON.stringify(DEFAULT_SETTINGS[section])
}

function ResetRow({ section }) {
  if (!overridden(section)) return null
  return <div className="row gap"><span className="badge">{t('overridden')}</span><Button small onClick={() => ui.rt.settings.set(section, clone(DEFAULT_SETTINGS[section]))}>{t('reset')}</Button></div>
}

function BuiltinTab() {
  const rt = ui.rt
  const s = rt.settings.get()
  const up = (section, patch) => rt.settings.update({ [section]: patch })
  return (
    <div>
      <Section title={t('subagentSettings')}>
        <Num label={t('maxDepth')} value={s.subagent.maxDepth} min={0} max={3} onChange={v => up('subagent', { maxDepth: v })} />
        <Num label={t('parallelLimit')} value={s.subagent.maxParallel} min={1} max={16} onChange={v => up('subagent', { maxParallel: v })} />
        <Toggle label={t('allowModelChoice')} value={s.subagent.allowModelSelection} onChange={v => up('subagent', { allowModelSelection: v })} />
        <ResetRow section="subagent" />
      </Section>
      <Section title={t('webSettings')}>
        <Field label={t('searchProvider')}><Select value={s.web.searchProvider} onChange={v => up('web', { searchProvider: v })} options={[{ value: 'auto', label: t('spAuto') }, { value: 'deepseek-search-api', label: t('spApi') }, { value: 'deepseek-native', label: t('spNative') }]} /></Field>
        <Num label={t('maxSearches')} value={s.web.maxSearchesPerRequest} min={1} max={10} onChange={v => up('web', { maxSearchesPerRequest: v })} />
        <Num label={t('resultsPerSearch')} value={s.web.resultsPerSearch} min={1} max={50} onChange={v => up('web', { resultsPerSearch: v })} />
        <Field label={t('fetchProvider')}><Select value={s.web.fetchProvider} onChange={v => up('web', { fetchProvider: v })} options={[{ value: 'direct', label: t('fpDirect') }, { value: 'deepseek-fetch-api', label: t('fpApi') }]} /></Field>
        <Toggle label={t('apiKey') + ' (web)'} hint="DeepSeek key used only for search/fetch billing" value={!!s.web.apiKeyRef} onChange={v => up('web', { apiKeyRef: v })} />
        {s.web.apiKeyRef ? <SecretField label={t('apiKey')} credId="web" /> : null}
        <ResetRow section="web" />
      </Section>
      <Section title={t('agentLoop')}>
        <Num label={t('parallelTools')} value={s.agent.maxParallelToolCalls} min={1} max={16} onChange={v => up('agent', { maxParallelToolCalls: v })} />
        <Toggle label={t('applyPatch')} value={s.agent.applyPatch} onChange={v => up('agent', { applyPatch: v })} />
        <Num label={t('compactAt')} value={s.agent.compactThreshold || 0} min={0} max={2000000} onChange={v => up('agent', { compactThreshold: v })} />
        <ResetRow section="agent" />
      </Section>
      <Section title={t('codeSettings')}>
        <Num label={t('codeTimeout')} value={s.code.timeoutMs} min={1000} max={600000} onChange={v => up('code', { timeoutMs: v })} />
      </Section>
    </div>
  )
}

function McpTab() {
  const rt = ui.rt
  const servers = rt.settings.get().mcp.servers
  const [status, setStatus] = useState(rt.mcp.status())
  const [busy, setBusy] = useState(false)
  const refresh = async () => { setBusy(true); await rt.mcp.refresh(true).catch(() => {}); setStatus(rt.mcp.status()); setBusy(false) }
  useEffect(() => { refresh() }, [servers.length])
  const add = async () => {
    const url = await prompt({ title: t('addMcp'), placeholder: 'https://example.com/mcp', body: t('mcpUrl') })
    if (!url) return
    const id = await prompt({ title: t('providerId'), value: (url.replace(/^https?:\/\//, '').split(/[./:]/)[0] || 'mcp').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 20) })
    if (!id) return
    const headersText = await prompt({ title: t('mcpHeaders'), placeholder: '{"Authorization":"Bearer …"}', allowEmpty: true, multiline: true, rows: 3 })
    const headers = headersText ? safeJsonParse(headersText, null) : {}
    if (headersText && !headers) { toast('headers: invalid JSON', { kind: 'error' }); return }
    rt.settings.set('mcp', { servers: servers.concat([{ id: id.trim(), name: id.trim(), url: url.trim(), headers: headers || {}, enabled: true }]) })
  }
  return (
    <div>
      <div className="help">Streamable HTTP MCP servers. Tools appear as mcp__&lt;server&gt;__&lt;tool&gt;.</div>
      {servers.length ? servers.map((sv) => {
        const st = status.find(x => x.id === sv.id)
        return (
          <ListItem key={sv.id} icon="puzzle" title={sv.name || sv.id} subtitle={sv.url + (st ? ' · ' + (st.state === 'ready' ? t('connected') + ` (${st.tools})` : st.state === 'error' ? t('failed') + ': ' + st.error : st.state) : '')}
            right={<input type="checkbox" checked={sv.enabled !== false} onChange={e => rt.settings.set('mcp', { servers: servers.map(x => (x.id === sv.id ? Object.assign({}, x, { enabled: e.target.checked }) : x)) })} />}
            onLongPress={async () => { if (await confirm({ title: t('delete') + ' ' + sv.id + '?', danger: true })) rt.settings.set('mcp', { servers: servers.filter(x => x.id !== sv.id) }) }} />
        )
      }) : <Empty icon="puzzle" text="—" />}
      <div className="row gap pad">
        <Button icon="add" onClick={add}>{t('addMcp')}</Button>
        <Button icon="refresh" disabled={busy} onClick={refresh}>{busy ? <Spinner /> : null}{t('refresh')}</Button>
      </div>
    </div>
  )
}

function SkillsTab() {
  const rt = ui.rt
  const [skills, setSkills] = useState(null)
  const load = async () => {
    const ws = rt.workspaces.mostRecent()
    const fake = { cwd: () => (ws ? ws.path : '/'), workspaceRoot: () => (ws ? ws.path : '/'), projectRoot: null }
    rt._skills.at = 0
    setSkills(await rt.skillsFor(fake).catch(() => []))
  }
  useEffect(() => { load() }, [])
  const create = async () => {
    const name = await prompt({ title: t('newSkill'), placeholder: 'my-skill' })
    if (!name) return
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
    if (!slug) return
    const path = `/app/skills/${slug}/SKILL.md`
    await rt.vfs.writeText(path, `---\nname: ${slug}\ndescription: Describe what this skill does and when to use it.\n---\n# ${name}\n\nInstructions…\n`)
    navigate('preview', { path, edit: true })
    load()
  }
  return (
    <div>
      {skills === null ? <div className="pad"><Spinner /></div> : skills.length ? skills.map(s => (
        <ListItem key={s.name} icon="sparkle" title={'/' + s.name} subtitle={s.description + ' · ' + s.source + (!s.modelInvocable ? ' · ' + t('skillUserOnly') : '')} onClick={() => navigate('preview', { path: s.file, edit: s.source !== 'bundled' })} />
      )) : <Empty icon="sparkle" text={t('noSkills')} />}
      <div className="pad"><Button icon="add" onClick={create}>{t('newSkill')}</Button></div>
    </div>
  )
}

export function PluginsPage() {
  useRuntime(['settings'])
  const [tab, setTab] = useState('builtin')
  return (
    <Page title={t('plugins')}>
      <Pivot active={tab} onChange={setTab} tabs={[{ id: 'builtin', label: t('pluginSettings') }, { id: 'mcp', label: 'MCP' }, { id: 'skills', label: t('skills') }]} />
      {tab === 'builtin' ? <BuiltinTab /> : tab === 'mcp' ? <McpTab /> : <SkillsTab />}
    </Page>
  )
}

export { shortId, menu }
