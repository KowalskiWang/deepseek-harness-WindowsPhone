import { h } from 'preact'
import { useState, useEffect } from 'preact/hooks'
import { Icon } from '../icons.jsx'
import { t } from '../i18n.js'
import { ui, navigate, menu, prompt, confirm, toast, back } from '../store.js'
import { Page, ListItem, Empty, Spinner, Button, Toggle, copyText } from '../components.jsx'
import { Markdown } from '../markdown.jsx'
import { join, basename, extname, dirname, relative } from '../../core/paths.js'
import { bytesToBase64, errorMessage } from '../../core/util.js'
import { sniffImage } from '../../core/tools/fs-tools.js'

export function FilesPage({ params }) {
  const rt = ui.rt
  const [dir, setDir] = useState(params.root || '/')
  const [entries, setEntries] = useState(null)
  const [hidden, setHidden] = useState(false)
  const [error, setError] = useState('')
  const load = async () => {
    setEntries(null); setError('')
    try {
      const list = (await rt.vfs.list(dir)).filter(e => e.name.indexOf('._') !== 0 && e.name !== '.DS_Store' && !e.hidden)
      list.sort((a, b) => (a.type === b.type ? (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1) : a.type === 'dir' ? -1 : 1))
      setEntries(list)
    } catch (e) { setError(errorMessage(e)); setEntries([]) }
  }
  useEffect(() => { load() }, [dir])

  const shown = (entries || []).filter(e => hidden || e.name.charAt(0) !== '.')
  const root = params.root || '/'
  const canUp = dir !== root && dir !== '/'

  const itemMenu = async (e) => {
    const path = join(dir, e.name)
    const v = await menu(e.name, [
      e.type === 'file' ? { label: t('openFile'), icon: 'file', value: 'open' } : null,
      params.sessionId ? { label: t('addToChat'), icon: 'add', value: 'chat' } : null,
      { label: t('rename'), icon: 'edit', value: 'rename' },
      { label: t('copy') + ' path', icon: 'copy', value: 'path' },
      { label: t('delete'), icon: 'trash', value: 'delete', danger: true },
    ])
    if (v === 'open') navigate('preview', { path })
    else if (v === 'chat') {
      ui.drafts = ui.drafts || {}
      const agent = rt.getAgent(params.sessionId)
      const rel = agent ? relative(agent.cwd(), path) : path
      ui.drafts[params.sessionId] = ((ui.drafts[params.sessionId] || '') + ' @' + rel + ' ').replace(/^ /, '')
      back()
    } else if (v === 'rename') {
      const name = await prompt({ title: t('rename'), value: e.name })
      if (name && name !== e.name) { try { await rt.vfs.rename(path, join(dir, name)); load() } catch (err) { toast(err.message, { kind: 'error' }) } }
    } else if (v === 'path') copyText(path)
    else if (v === 'delete') {
      if (await confirm({ title: t('delete') + ' ' + e.name + '?', danger: true })) { try { await rt.vfs.remove(path); load() } catch (err) { toast(err.message, { kind: 'error' }) } }
    }
  }

  return (
    <Page title={params.title || t('files')} subtitle={dir} actions={[
      <button key="n" className="icon-btn" onClick={async () => {
        const v = await menu(t('create'), [{ label: t('newFolder'), value: 'dir', icon: 'folder' }, { label: 'New file', value: 'file', icon: 'file' }])
        if (!v) return
        const name = await prompt({ title: v === 'dir' ? t('newFolder') : 'New file', placeholder: v === 'dir' ? t('folderName') : 'notes.md' })
        if (!name) return
        try { if (v === 'dir') await rt.vfs.mkdirp(join(dir, name)); else await rt.vfs.writeText(join(dir, name), ''); load() } catch (e) { toast(e.message, { kind: 'error' }) }
      }}><Icon name="add" size={20} /></button>,
      <button key="r" className="icon-btn" onClick={load}><Icon name="refresh" size={20} /></button>,
    ]}>
      <Toggle label={t('showHidden')} value={hidden} onChange={setHidden} />
      {canUp ? <ListItem icon="back" title=".." onClick={() => setDir(dirname(dir))} /> : null}
      {entries === null ? <div className="pad"><Spinner /></div> : null}
      {error ? <div className="err pad">{error}</div> : null}
      {entries && !shown.length && !error ? <Empty icon="folder" text={t('emptyFolder')} /> : null}
      {shown.map(e => (
        <ListItem key={e.name} icon={e.type === 'dir' ? 'folder' : 'file'} title={e.name}
          subtitle={e.type === 'file' ? fmtSize(e.size) + (e.mtime ? ' · ' + new Date(e.mtime).toLocaleString() : '') : null}
          onClick={() => (e.type === 'dir' ? setDir(join(dir, e.name)) : navigate('preview', { path: join(dir, e.name) }))}
          onLongPress={() => itemMenu(e)} />
      ))}
    </Page>
  )
}

function fmtSize(n) {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

export function PreviewPage({ params }) {
  const rt = ui.rt
  const path = params.path
  const [state, setState] = useState({ loading: true })
  const [editing, setEditing] = useState(!!params.edit)
  const [draft, setDraft] = useState('')
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const st = await rt.vfs.stat(path)
        if (!st) throw new Error('not found: ' + path)
        if (st.type === 'dir') { navigate('files', { root: path }); return }
        const bytes = await rt.vfs.readBytes(path)
        const img = sniffImage(bytes)
        if (img) { if (alive) setState({ image: `data:${img};base64,${bytesToBase64(bytes)}` }); return }
        const text = await rt.vfs.readText(path)
        if (alive) { setState({ text }); setDraft(text) }
      } catch (e) { if (alive) setState({ error: errorMessage(e) }) }
    })()
    return () => { alive = false }
  }, [path])
  const ext = extname(path)
  const isMd = ext === '.md' || ext === '.markdown'
  const save = async () => {
    try { await rt.vfs.writeText(path, draft); setState({ text: draft }); setEditing(false); toast(t('save') + ' ✓') } catch (e) { toast(e.message, { kind: 'error' }) }
  }
  return (
    <Page title={basename(path)} subtitle={path} actions={state.text !== undefined ? [
      editing ? <button key="s" className="icon-btn" onClick={save}><Icon name="check" size={20} /></button> : <button key="e" className="icon-btn" onClick={() => setEditing(true)}><Icon name="edit" size={20} /></button>,
      <button key="c" className="icon-btn" onClick={() => copyText(state.text)}><Icon name="copy" size={20} /></button>,
    ] : null}>
      {state.loading ? <div className="pad"><Spinner /></div> : null}
      {state.error ? <div className="err pad">{state.error}</div> : null}
      {state.image ? <div className="pad center"><img className="preview-img" src={state.image} alt="" /></div> : null}
      {state.text !== undefined && editing ? <textarea className="input textarea mono editor" value={draft} onInput={e => setDraft(e.target.value)} /> : null}
      {state.text !== undefined && !editing ? (isMd ? <div className="pad"><Markdown text={state.text} onLink={url => ui.platform.openExternal(url)} onCopy={copyText} /></div> : <pre className="code-view">{state.text}</pre>) : null}
      {editing ? <div className="row gap pad"><Button onClick={() => { setEditing(false); setDraft(state.text) }}>{t('cancel')}</Button><Button kind="primary" onClick={save}>{t('save')}</Button></div> : null}
    </Page>
  )
}
