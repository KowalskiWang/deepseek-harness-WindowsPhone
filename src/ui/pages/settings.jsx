import { h } from 'preact'
import { useState, useEffect } from 'preact/hooks'
import { Icon } from '../icons.jsx'
import { t, setLanguage } from '../i18n.js'
import { ui, navigate, menu, confirm, toast, closeOverlay, useRuntime, back } from '../store.js'
import { Page, Pivot, Section, Field, Toggle, Select, Button, ListItem, Spinner, registerOverlay, RAW } from '../components.jsx'
import { THIRD_PARTY_CATALOG, DEEPSEEK_MODELS, DEEPSEEK_BASE_URL, PROTOCOLS } from '../../core/llm/index.js'
import { PRESETS } from '../../core/prompt.js'
import { effortLabel, PERM_LABEL, pickModel } from '../composer.jsx'
import { clone, errorMessage } from '../../core/util.js'

// ---------------------------------------------------------------- secret input

/** Write-only key field: a saved key shows only its masked preview; typing replaces it. */
export function SecretField({ label, credId, hint, placeholder, onSaved }) {
  const rt = ui.rt
  const saved = rt.settings.hasCredential(credId)
  const [draft, setDraft] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try { await rt.settings.setCredential(credId, draft); setDraft(''); toast(t('save') + ' ✓'); if (onSaved) onSaved() } catch (e) { toast(e.message, { kind: 'error' }) }
    setBusy(false)
  }
  return (
    <Field label={label} hint={draft ? '' : saved ? t('savedKey') : hint}>
      <div className="secret-row">
        <input className="input mono" {...RAW} type={show ? 'text' : 'password'} value={draft} placeholder={saved ? rt.settings.credentialPreview(credId) : (placeholder || 'sk-…')} onInput={e => { setDraft(e.target.value); setShow(false) }} />
        {draft ? <button className="icon-btn small" onClick={() => setShow(!show)} aria-label={show ? t('hideSecret') : t('showSecret')}><Icon name="lock" size={16} /></button> : null}
      </div>
      <div className="row gap">
        {draft ? <Button kind="primary" small disabled={busy} onClick={save}>{t('save')}</Button> : null}
        {saved && !draft ? <Button small kind="danger" onClick={async () => { if (await confirm({ title: t('removeKey') + '?', danger: true })) { await rt.settings.removeCredential(credId); toast(t('removeKey') + ' ✓') } }}>{t('removeKey')}</Button> : null}
      </div>
    </Field>
  )
}

// ---------------------------------------------------------------- general

function GatewaySection() {
  const rt = ui.rt
  const g = rt.settings.get().gateway
  const [url, setUrl] = useState(g.url)
  const [code, setCode] = useState(g.code)
  const [state, setState] = useState(rt.gatewayInfo)
  const [busy, setBusy] = useState(false)
  const test = async () => {
    rt.settings.update({ gateway: { url: url.trim().replace(/\/+$/, ''), code: code.trim() } })
    setBusy(true)
    const info = await rt.probeGateway()
    setState(info)
    setBusy(false)
    if (info && !info.error) rt.llm.ensureListing(true)
  }
  return (
    <Section title={t('gateway')}>
      <div className="help">{t('gatewayHelp')}</div>
      <Field label={t('gatewayUrl')}><input className="input mono" {...RAW} type="url" placeholder="http://192.168.1.100:8787" value={url} onInput={e => setUrl(e.target.value)} /></Field>
      <Field label={t('gatewayCode')}><input className="input mono" {...RAW} value={code} onInput={e => setCode(e.target.value)} placeholder="123456" /></Field>
      <Field label={t('gatewayRoute')}>
        <Select value={g.route} onChange={v => rt.settings.update({ gateway: { route: v } })} options={[{ value: 'auto', label: t('routeAuto') }, { value: 'https', label: t('routeOn') }, { value: 'off', label: t('routeOff') }]} />
      </Field>
      <div className="row gap">
        <Button kind="primary" small disabled={busy} onClick={test}>{busy ? <Spinner /> : null}{t('testConnection')}</Button>
        {state ? (state.error ? <span className="err small">{state.error}</span> : <span className="ok small">✓ {t('gatewayOk')}{state.injectsKey ? ' · ' + t('gatewayKey') : ''}</span>) : null}
      </div>
    </Section>
  )
}

function GeneralTab() {
  const rt = ui.rt
  const g = rt.settings.get().general
  const set = (patch) => {
    rt.settings.update({ general: patch })
    if (patch.language) { setLanguage(patch.language); ui.emit('change') }
    if (patch.theme || patch.fontSize) ui.emit('theme')
  }
  return (
    <div>
      <Section>
        <Field label={t('defaultPermission')}>
          <Select value={g.defaultPermission} onChange={v => set({ defaultPermission: v })} options={Object.keys(PERM_LABEL).map(k => ({ value: k, label: t(PERM_LABEL[k]) }))} />
        </Field>
        <Field label={t('language')}><Select value={g.language} onChange={v => set({ language: v })} options={[{ value: 'auto', label: t('langAuto') }, { value: 'zh', label: '中文' }, { value: 'en', label: 'English' }]} /></Field>
        <Field label={t('appearance')}><Select value={g.theme} onChange={v => set({ theme: v })} options={[{ value: 'dark', label: t('dark') }, { value: 'light', label: t('light') }, { value: 'system', label: t('system') }]} /></Field>
        <Field label={t('fontSize') + ' · ' + g.fontSize}>
          <input type="range" min="12" max="22" step="1" value={g.fontSize} onChange={e => set({ fontSize: parseInt(e.target.value, 10) })} />
        </Field>
        <Field label={t('workDetails')}><Select value={g.workDetails} onChange={v => set({ workDetails: v })} options={['compact', 'standard', 'detailed', 'verbose'].map(v => ({ value: v, label: t('wd_' + v) }))} /></Field>
        <Field label={t('busySend')}><Select value={g.busySend} onChange={v => set({ busySend: v })} options={[{ value: 'queue', label: t('queue') }, { value: 'steer', label: t('steer') }]} /></Field>
        <Field label={t('usageDisplay')}><Select value={g.usageDisplay} onChange={v => set({ usageDisplay: v })} options={[{ value: 'detailed', label: t('usageDetailed') }, { value: 'compact', label: t('usageCompact') }]} /></Field>
        <Toggle label={t('notifications')} value={g.notifications} onChange={v => set({ notifications: v })} />
        <Toggle label={t('sendOnEnter')} value={g.sendOnEnter} onChange={v => set({ sendOnEnter: v })} />
      </Section>
      <GatewaySection />
      <Section title={t('version')}><div className="muted">DSH Mobile {typeof __DSH_VERSION__ !== 'undefined' ? __DSH_VERSION__ : ''} ({typeof __DSH_BUILD__ !== 'undefined' ? __DSH_BUILD__ : 'dev'}) · {ui.platform.hint}</div></Section>
    </div>
  )
}

// ---------------------------------------------------------------- models

function DeepseekCard() {
  const rt = ui.rt
  const ds = rt.settings.get().models.deepseek
  const retry = rt.settings.get().models.retry
  const [open, setOpen] = useState(false)
  const [baseURL, setBaseURL] = useState(ds.baseURL)
  const listing = rt.llm.listingCache.deepseek
  const models = rt.llm.models('deepseek')
  return (
    <div className="card">
      <div className="card-head"><Icon name="model" size={18} /><span className="card-title">DeepSeek</span><span className="muted small">{models.map(m => m.name).join(' · ')}</span></div>
      <SecretField label={t('apiKey')} credId="deepseek" hint={rt.gateway() ? t('leaveBlankGateway') : t('apiKeyHint')} onSaved={() => rt.llm.ensureListing(true)} />
      <Field label={t('effort')}>
        <Select value={ds.reasoningEffort || 'high'} onChange={v => rt.settings.update({ models: { deepseek: { reasoningEffort: v } } })} options={['off', 'low', 'high', 'max'].map(e => ({ value: e, label: effortLabel(e) }))} />
      </Field>
      <button className="link-btn" onClick={() => setOpen(!open)}><Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />{t('customized')}</button>
      {open ? (
        <div className="sub">
          <Field label={t('baseUrl')} hint={DEEPSEEK_BASE_URL}>
            <input className="input mono" {...RAW} type="url" value={baseURL} onInput={e => setBaseURL(e.target.value)} onBlur={() => rt.settings.update({ models: { deepseek: { baseURL: baseURL.trim() || DEEPSEEK_BASE_URL } } })} />
          </Field>
          <Field label={t('retryPolicy')}>
            <Select value={retry.mode} onChange={v => rt.settings.update({ models: { retry: { mode: v } } })} options={[{ value: 'default', label: t('retryDefault') }, { value: 'all', label: t('retryAll') }, { value: 'off', label: t('retryOff') }]} />
          </Field>
          <Field label={t('maxRetries')}><input className="input" type="number" min="0" max="20" value={retry.maxRetries} onChange={e => rt.settings.update({ models: { retry: { maxRetries: parseInt(e.target.value, 10) || 0 } } })} /></Field>
          <Toggle label={t('followListing')} hint={listing && listing.error ? listing.error : listing ? new Date(listing.at).toLocaleTimeString() : ''} value={!ds.models} onChange={(v) => {
            const s = clone(rt.settings.get().models)
            s.deepseek.models = v ? null : clone(models.map(m => ({ id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens, input: m.input })))
            rt.settings.set('models', s)
          }} />
          {ds.models ? <ModelListEditor models={ds.models} onChange={(list) => { const s = clone(rt.settings.get().models); s.deepseek.models = list; rt.settings.set('models', s) }} deepseek /> : null}
          <Button small onClick={() => { const s = clone(rt.settings.get().models); s.deepseek = { baseURL: DEEPSEEK_BASE_URL, models: null, reasoningEffort: 'high' }; rt.settings.set('models', s); setBaseURL(DEEPSEEK_BASE_URL); rt.llm.ensureListing(true) }}>{t('reset')}</Button>
        </div>
      ) : null}
    </div>
  )
}

export function ModelListEditor({ models, onChange, deepseek }) {
  const update = (i, patch) => onChange(models.map((m, j) => (j === i ? Object.assign({}, m, patch) : m)))
  return (
    <div className="model-list">
      {models.map((m, i) => (
        <div key={i} className="model-item">
          <div className="row gap">
            <input className="input mono flex1" {...RAW} value={m.id} placeholder={t('modelId')} onInput={e => update(i, { id: e.target.value.trim() })} />
            <button className="icon-btn small" onClick={() => onChange(models.filter((_, j) => j !== i))}><Icon name="trash" size={16} /></button>
            {i > 0 ? <button className="icon-btn small" onClick={() => { const c = models.slice(); const x = c[i - 1]; c[i - 1] = c[i]; c[i] = x; onChange(c) }}><Icon name="chevronUp" size={16} /></button> : null}
          </div>
          <input className="input" value={m.name || ''} placeholder={t('displayName')} onInput={e => update(i, { name: e.target.value })} />
          <div className="row gap">
            <input className="input flex1" type="number" value={m.contextWindow || ''} placeholder={t('contextWindow')} onChange={e => update(i, { contextWindow: parseInt(e.target.value, 10) || undefined })} />
            <input className="input flex1" type="number" value={m.maxTokens || ''} placeholder={t('maxOutput')} onChange={e => update(i, { maxTokens: parseInt(e.target.value, 10) || undefined })} />
          </div>
          <div className="row gap">
            <span className="muted small">{t('inputTypes')}</span>
            <label className="check-row"><input type="checkbox" checked={(m.input || ['text']).indexOf('image') >= 0} onChange={e => update(i, { input: e.target.checked ? ['text', 'image'] : ['text'] })} /> {t('image')}</label>
          </div>
          {!deepseek ? (
            <div>
              <Toggle label={t('reasoningLevels')} value={!!m.reasoningEfforts} onChange={v => update(i, { reasoningEfforts: v ? { off: '', low: 'low', medium: 'medium', high: 'high' } : undefined })} />
              {m.reasoningEfforts ? Object.keys(m.reasoningEfforts).map(level => (
                <div key={level} className="row gap">
                  <span className="flex1">{effortLabel(level)}</span>
                  <input className="input mono flex1" {...RAW} value={m.reasoningEfforts[level]} placeholder={t('apiValue')} onInput={e => update(i, { reasoningEfforts: Object.assign({}, m.reasoningEfforts, { [level]: e.target.value }) })} />
                  {level !== 'off' ? <button className="icon-btn small" onClick={() => { const r = Object.assign({}, m.reasoningEfforts); delete r[level]; update(i, { reasoningEfforts: r }) }}><Icon name="close" size={14} /></button> : null}
                </div>
              )) : null}
            </div>
          ) : null}
        </div>
      ))}
      <Button small icon="add" onClick={() => onChange(models.concat([{ id: '', name: '', input: ['text'] }]))}>{t('addModel')}</Button>
    </div>
  )
}

function ModelsTab() {
  const rt = ui.rt
  const custom = rt.settings.get().models.custom
  const add = async () => {
    const v = await menu(t('addProvider'), [{ label: t('thirdParty'), value: 'third', icon: 'globe' }, { label: t('customApi'), value: 'custom', icon: 'code' }])
    if (v === 'third') {
      const id = await menu(t('thirdParty'), THIRD_PARTY_CATALOG.filter(p => !custom.some(c => c.id === p.id)).map(p => ({ label: p.name, hint: p.id + ' · ' + p.baseURL, value: p.id })))
      if (id) navigate('provider', { template: id })
    } else if (v === 'custom') navigate('provider', {})
  }
  return (
    <div>
      <DeepseekCard />
      {custom.map(p => (
        <ListItem key={p.id} icon="model" title={p.name || p.id} subtitle={`${p.id} · ${p.protocol} · ${(p.models || []).length} models${rt.settings.hasCredential(p.id) ? ' · 🔑' : ''}`}
          onClick={() => navigate('provider', { id: p.id })}
          right={<Icon name="chevronRight" size={16} />} />
      ))}
      <div className="pad"><Button icon="add" onClick={add}>{t('addProvider')}</Button></div>
      <Section title={t('selectModel')}>
        <DefaultModelRow />
      </Section>
    </div>
  )
}

function DefaultModelRow() {
  const rt = ui.rt
  const sel = rt.settings.get().models.defaultSelection
  let ok = true
  try { rt.llm.resolve(sel) } catch (e) { ok = false }
  const info = rt.llm.findModel(sel.provider, sel.model)
  return (
    <ListItem icon="model" title={info ? info.name || info.id : t('selectModel')} subtitle={sel.provider + ' · ' + (sel.effort ? effortLabel(sel.effort) : '') + (ok ? '' : ' · ' + t('modelSelectionMissing'))}
      onClick={async () => { const s = await pickModel(rt, sel); if (s) toast('✓ ' + s.model) }} />
  )
}

// ---------------------------------------------------------------- provider form

export function ProviderPage({ params }) {
  const rt = ui.rt
  const existing = params.id ? rt.settings.get().models.custom.find(p => p.id === params.id) : null
  const template = params.template ? THIRD_PARTY_CATALOG.find(p => p.id === params.template) : null
  const [form, setForm] = useState(() => clone(existing || (template ? { id: template.id, name: template.name, protocol: template.protocol, baseURL: template.baseURL, compat: template.compat || {}, models: template.models || [] } : { id: '', name: '', protocol: 'openai-completions', baseURL: '', compat: {}, models: [] })))
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = patch => setForm(Object.assign({}, form, patch))

  const fetchModels = async () => {
    setBusy(true); setError('')
    try {
      const list = await rt.llm.discoverModels({ protocol: form.protocol, baseURL: form.baseURL, apiKey: key || rt.settings.getCredential(form.id) })
      const have = {}
      for (const m of form.models) have[m.id] = true
      const picked = await menu(t('fetchModels') + ` (${list.length})`, list.slice(0, 80).map(m => ({ label: m.id, hint: m.name !== m.id ? m.name : '', value: m.id, checked: have[m.id] })))
      if (picked) {
        const m = list.find(x => x.id === picked)
        if (have[picked]) set({ models: form.models.filter(x => x.id !== picked) })
        else set({ models: form.models.concat([m]) })
      }
    } catch (e) { setError(errorMessage(e)) }
    setBusy(false)
  }

  const save = async () => {
    const id = String(form.id || '').trim()
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) { setError('Provider ID: lowercase letters, digits, ".", "_" or "-"'); return }
    if (!form.baseURL) { setError(t('baseUrl') + ' ?'); return }
    if (!form.models.length || form.models.some(m => !m.id)) { setError(t('addModel') + ' ?'); return }
    const list = rt.settings.get().models.custom.filter(p => p.id !== (existing ? existing.id : id))
    if (!existing && (id === 'deepseek' || list.some(p => p.id === id))) { setError('Provider ID already exists'); return }
    const s = clone(rt.settings.get().models)
    s.custom = list.concat([{ id, name: form.name || id, protocol: form.protocol, baseURL: form.baseURL.trim().replace(/\/+$/, ''), compat: form.compat || {}, models: form.models }])
    rt.settings.set('models', s)
    if (key) await rt.settings.setCredential(id, key)
    back()
  }

  const remove = async () => {
    if (!(await confirm({ title: t('delete') + ' ' + form.id + '?', danger: true }))) return
    const s = clone(rt.settings.get().models)
    s.custom = s.custom.filter(p => p.id !== existing.id)
    rt.settings.set('models', s)
    await rt.settings.removeCredential(existing.id)
    back()
  }

  return (
    <Page title={existing ? form.name || form.id : t('addProvider')} actions={existing ? <button className="icon-btn" onClick={remove}><Icon name="trash" size={20} /></button> : null}>
      <div className="pad">
        <Field label={t('providerId')} hint={existing ? '' : 'lowercase, permanent'}><input className="input mono" {...RAW} disabled={!!existing} value={form.id} onInput={e => set({ id: e.target.value.trim().toLowerCase() })} /></Field>
        <Field label={t('displayName')}><input className="input" value={form.name} onInput={e => set({ name: e.target.value })} /></Field>
        <Field label={t('baseUrl')}><input className="input mono" {...RAW} type="url" value={form.baseURL} placeholder="https://gateway.example/v1" onInput={e => set({ baseURL: e.target.value })} /></Field>
        <Field label={t('protocol')}><Select value={form.protocol} onChange={v => set({ protocol: v })} options={PROTOCOLS.map(p => ({ value: p, label: p === 'openai-completions' ? 'OpenAI Chat Completions' : 'Anthropic Messages' }))} /></Field>
        <Field label={t('apiKey')} hint={existing && rt.settings.hasCredential(existing.id) ? t('savedKey') + ' · ' + rt.settings.credentialPreview(existing.id) : ''}>
          <input className="input mono" {...RAW} type="password" value={key} onInput={e => setKey(e.target.value)} placeholder={existing && rt.settings.hasCredential(existing.id) ? rt.settings.credentialPreview(existing.id) : 'sk-…'} />
        </Field>
        {form.protocol === 'openai-completions' ? (
          <div>
            <Toggle label="thinkingFormat: deepseek" hint="off → thinking disabled; other levels → thinking enabled + reasoning_effort" value={(form.compat || {}).thinkingFormat === 'deepseek'} onChange={v => set({ compat: Object.assign({}, form.compat, { thinkingFormat: v ? 'deepseek' : undefined }) })} />
            <Field label="maxTokensField"><Select value={(form.compat || {}).maxTokensField || 'max_tokens'} onChange={v => set({ compat: Object.assign({}, form.compat, { maxTokensField: v }) })} options={[{ value: 'max_tokens', label: 'max_tokens' }, { value: 'max_completion_tokens', label: 'max_completion_tokens' }]} /></Field>
          </div>
        ) : null}
        <Section title={t('modelCatalog')} right={<Button small disabled={busy || !form.baseURL} onClick={fetchModels}>{busy ? <Spinner /> : <Icon name="refresh" size={14} />}{t('fetchModels')}</Button>}>
          <ModelListEditor models={form.models} onChange={models => set({ models })} />
        </Section>
        {error ? <div className="err">{error}</div> : null}
        <div className="row gap pad-v">
          <Button onClick={() => back()}>{t('cancel')}</Button>
          <Button kind="primary" onClick={save}>{t('save')}</Button>
        </div>
      </div>
    </Page>
  )
}

// ---------------------------------------------------------------- account

function AccountTab() {
  const rt = ui.rt
  const [state, setState] = useState({ loading: false })
  const load = async () => {
    setState({ loading: true })
    try { setState({ data: await rt.llm.balance() }) } catch (e) { setState({ error: errorMessage(e) }) }
  }
  useEffect(() => { load() }, [])
  const infos = state.data && state.data.balance_infos
  return (
    <div className="pad">
      <div className="card">
        <div className="card-head"><Icon name="key" size={18} /><span className="card-title">DeepSeek API</span>{rt.settings.hasCredential('deepseek') ? <span className="muted small">{rt.settings.credentialPreview('deepseek')}</span> : null}</div>
        {state.loading ? <Spinner /> : null}
        {state.error ? <div className="err small">{state.error}</div> : null}
        {infos ? infos.map(b => (
          <div key={b.currency} className="balance">
            <div className="balance-total">{b.currency === 'CNY' ? '¥' : '$'}{b.total_balance}</div>
            <div className="muted small">{t('toppedUp')} {b.topped_up_balance} · {t('granted')} {b.granted_balance}</div>
          </div>
        )) : null}
        {state.data && state.data.is_available === false ? <div className="err small">{t('error_QUOTA')}</div> : null}
        <div className="row gap wrap">
          <Button small icon="refresh" onClick={load}>{t('refresh')}</Button>
          <Button small onClick={() => ui.platform.openExternal('https://platform.deepseek.com/usage')}>{t('viewUsage')}</Button>
          <Button small kind="primary" onClick={() => ui.platform.openExternal('https://platform.deepseek.com/top_up')}>{t('topUp')}</Button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- presets

function PresetsTab() {
  const rt = ui.rt
  const def = rt.settings.get().general.defaultPreset || 'standard'
  const names = { standard: t('standardMode'), ptc: t('ptcMode'), minimal: t('minimalMode') }
  return (
    <div>
      {Object.keys(PRESETS).map(id => {
        const p = PRESETS[id]
        return (
          <div key={id} className="card">
            <div className="card-head"><Icon name="agent" size={18} /><span className="card-title">{names[id]}</span>{def === id ? <span className="badge">{t('isDefault')}</span> : null}</div>
            <div className="muted small">{t('presetDesc_' + id)}</div>
            <div className="muted small mono">{p.tools === 'all' ? 'tools: all' : 'tools: ' + p.tools.join(', ')}</div>
            <div className="row gap">
              {def !== id ? <Button small onClick={() => rt.settings.update({ general: { defaultPreset: id } })}>{t('setDefault')}</Button> : null}
              <Button small onClick={() => navigate('text', { title: names[id], text: '```\n' + (p.complete ? p.persona : 'You are an AI agent powered by DeepSeek Harness.\n' + p.persona) + '\n```' })}>{t('inspect')}</Button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function SettingsPage({ params }) {
  useRuntime(['settings', 'gateway'])
  const [tab, setTab] = useState(params.tab || 'general')
  return (
    <Page title={t('settings')}>
      <Pivot active={tab} onChange={setTab} tabs={[{ id: 'general', label: t('general') }, { id: 'models', label: t('models') }, { id: 'account', label: t('account') }, { id: 'presets', label: t('presets') }]} />
      {tab === 'general' ? <GeneralTab /> : tab === 'models' ? <ModelsTab /> : tab === 'account' ? <AccountTab /> : <PresetsTab />}
    </Page>
  )
}

// ---------------------------------------------------------------- onboarding dialogs

function WelcomeDialog({ o }) {
  return (
    <div className="dialog">
      <div className="dialog-title">{t('welcomeTitle')}</div>
      <div className="dialog-body">{t('welcomeBody')}</div>
      <div className="dialog-buttons"><Button kind="primary" onClick={() => closeOverlay(o, true)}>{t('continue')}</Button></div>
    </div>
  )
}
WelcomeDialog.dismissable = false
registerOverlay('welcome', WelcomeDialog)

function ApiKeyDialog({ o }) {
  const rt = ui.rt
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const needsGateway = ui.platform.hint === 'wp81'
  const g = rt.settings.get().gateway
  const [gw, setGw] = useState(g.url || (ui.platform.servedByGateway ? ui.platform.origin : ''))
  const [code, setCode] = useState(g.code)
  const save = async () => {
    setBusy(true); setErr('')
    try {
      if (gw !== g.url || code !== g.code) {
        rt.settings.update({ gateway: { url: gw.trim().replace(/\/+$/, ''), code: code.trim() } })
        const info = await rt.probeGateway()
        if (gw && info && info.error) throw new Error(t('gateway') + ': ' + info.error)
      }
      if (key.trim()) await rt.settings.setCredential('deepseek', key.trim())
      await rt.llm.ensureListing(true)
      if (!rt.hasUsableModel()) throw new Error(t('error_MISSING_CREDENTIAL'))
      rt.settings.update({ general: { onboarded: true } })
      closeOverlay(o, true)
    } catch (e) { setErr(errorMessage(e)) }
    setBusy(false)
  }
  return (
    <div className="dialog">
      <div className="dialog-title">{t('addApiKeyTitle')}</div>
      {needsGateway || gw ? (
        <div>
          <div className="help small">{t('gatewayHelp')}</div>
          <Field label={t('gatewayUrl')}><input className="input mono" {...RAW} type="url" value={gw} placeholder="http://192.168.1.100:8787" onInput={e => setGw(e.target.value)} /></Field>
          <Field label={t('gatewayCode')}><input className="input mono" {...RAW} value={code} onInput={e => setCode(e.target.value)} /></Field>
        </div>
      ) : null}
      <Field label={t('apiKey')} hint={rt.gateway() || gw ? t('leaveBlankGateway') : t('apiKeyHint')}>
        <div className="secret-row">
          <input className="input mono" {...RAW} type={show ? 'text' : 'password'} value={key} placeholder={rt.settings.hasCredential('deepseek') ? rt.settings.credentialPreview('deepseek') : 'sk-…'} onInput={e => setKey(e.target.value)} />
          <button className="icon-btn small" onClick={() => setShow(!show)}><Icon name="lock" size={16} /></button>
        </div>
      </Field>
      {err ? <div className="err small">{err}</div> : null}
      <div className="dialog-buttons">
        <Button onClick={() => { rt.settings.update({ general: { onboarded: true } }); closeOverlay(o, false) }}>{t('configureLater')}</Button>
        <Button kind="primary" disabled={busy} onClick={save}>{busy ? <Spinner /> : null}{t('saveAndContinue')}</Button>
      </div>
    </div>
  )
}
registerOverlay('apikey', ApiKeyDialog)
