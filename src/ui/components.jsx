import { h } from 'preact'
import { useState, useRef, useEffect } from 'preact/hooks'
import { Icon } from './icons.jsx'
import { ui, back, closeOverlay, useUi, dialog, toast } from './store.js'
import { t } from './i18n.js'

export function Page({ title, subtitle, onBack, actions, children, appBar, className, header, scrollRef, onScroll }) {
  return (
    <div className={'page ' + (className || '')}>
      <div className="page-header">
        {onBack !== false ? (
          <button className="icon-btn" onClick={onBack || (() => back())} aria-label="back"><Icon name="back" size={22} /></button>
        ) : null}
        <div className="page-title-wrap">
          {header || <div className="page-title">{title}</div>}
          {subtitle ? <div className="page-subtitle">{subtitle}</div> : null}
        </div>
        <div className="page-actions">{actions}</div>
      </div>
      <div className="page-body" ref={scrollRef} onScroll={onScroll}>{children}</div>
      {appBar || null}
    </div>
  )
}

export function AppBar({ buttons, menu }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={'appbar' + (open ? ' open' : '')}>
      <div className="appbar-row">
        {buttons.map((b, i) => (
          <button key={i} className="appbar-btn" disabled={b.disabled} onClick={() => { setOpen(false); b.onClick() }}>
            <span className="appbar-circle"><Icon name={b.icon} size={20} /></span>
            <span className="appbar-label">{b.label}</span>
          </button>
        ))}
        <button className="appbar-more" onClick={() => setOpen(!open)} aria-label="more"><Icon name="more" size={22} /></button>
      </div>
      {open && menu && menu.length ? (
        <div className="appbar-menu">
          {menu.map((m, i) => <button key={i} className="appbar-menu-item" onClick={() => { setOpen(false); m.onClick() }}>{m.label}</button>)}
        </div>
      ) : null}
    </div>
  )
}

export function Pivot({ tabs, active, onChange }) {
  return (
    <div className="pivot">
      {tabs.map(tab => (
        <button key={tab.id} className={'pivot-item' + (tab.id === active ? ' active' : '')} onClick={() => onChange(tab.id)}>{tab.label}</button>
      ))}
    </div>
  )
}

/** Long press (pointer timer + contextmenu) for item menus. */
export function useLongPress(onLongPress) {
  const timer = useRef(null)
  const fired = useRef(false)
  const start = (e) => {
    fired.current = false
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { fired.current = true; onLongPress(e) }, 550)
  }
  const cancel = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null } }
  return {
    onPointerDown: start, onPointerUp: cancel, onPointerCancel: cancel, onPointerLeave: cancel,
    onTouchStart: start, onTouchEnd: cancel, onTouchMove: cancel,
    onContextMenu: (e) => { e.preventDefault(); cancel(); if (!fired.current) { fired.current = true; onLongPress(e) } },
    wasLongPress: () => fired.current,
  }
}

export function ListItem({ icon, title, subtitle, right, onClick, onLongPress, className, children }) {
  const lp = useLongPress(onLongPress || (() => {}))
  const handlers = onLongPress ? lp : {}
  return (
    <div className={'list-item ' + (className || '') + (onClick ? ' tappable' : '')} {...handlers}
      onClick={(e) => { if (onLongPress && lp.wasLongPress()) return; if (onClick) onClick(e) }}>
      {icon ? <div className="list-item-icon">{typeof icon === 'string' ? <Icon name={icon} /> : icon}</div> : null}
      <div className="list-item-main">
        <div className="list-item-title">{title}</div>
        {subtitle ? <div className="list-item-sub">{subtitle}</div> : null}
        {children}
      </div>
      {right !== undefined ? <div className="list-item-right">{right}</div> : null}
    </div>
  )
}

export function Section({ title, children, right }) {
  return (
    <div className="section">
      {title ? <div className="section-title"><span>{title}</span>{right}</div> : null}
      {children}
    </div>
  )
}

export function Field({ label, hint, children, error }) {
  return (
    <label className="field">
      {label ? <span className="field-label">{label}</span> : null}
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  )
}

export function Toggle({ value, onChange, label, hint, disabled }) {
  return (
    <div className={'toggle-row' + (disabled ? ' disabled' : '')} onClick={() => !disabled && onChange(!value)}>
      <div className="toggle-text">
        <div>{label}</div>
        {hint ? <div className="field-hint">{hint}</div> : null}
      </div>
      <div className={'toggle' + (value ? ' on' : '')}><div className="toggle-knob" /></div>
    </div>
  )
}

export function Select({ value, options, onChange, disabled }) {
  return (
    <select className="select" value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

/**
 * Attributes for technical text (URLs, keys, codes, identifiers): no
 * auto-capitalisation, autocorrect or spell check from the phone keyboard.
 */
export const RAW = { autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: false }

export function Button({ kind, onClick, children, disabled, small, icon }) {
  return (
    <button className={'btn ' + (kind ? 'btn-' + kind : '') + (small ? ' btn-small' : '')} disabled={disabled} onClick={onClick}>
      {icon ? <Icon name={icon} size={16} /> : null}{children}
    </button>
  )
}

export function Spinner({ size = 16 }) {
  return <span className="spinner" style={{ width: size + 'px', height: size + 'px' }} />
}

export function Dots() { return <span className="dots"><i /><i /><i /></span> }

export function Empty({ icon, text, children }) {
  return (
    <div className="empty">
      {icon ? <Icon name={icon} size={40} /> : null}
      <div>{text}</div>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------- overlays

const registry = {}
export function registerOverlay(type, Comp) { registry[type] = Comp }

function MenuSheet({ o }) {
  const p = o.props
  return (
    <div className="sheet">
      {p.title ? <div className="sheet-title">{p.title}</div> : null}
      <div className="sheet-items">
        {p.items.filter(Boolean).map((it, i) => (
          it.separator ? <div key={i} className="sheet-sep" /> : (
            <button key={i} className={'sheet-item' + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : '')} disabled={it.disabled} onClick={() => closeOverlay(o, it.value)}>
              {it.icon ? <Icon name={it.icon} size={18} /> : null}
              <span className="sheet-item-text">
                <span>{it.label}</span>
                {it.hint ? <span className="sheet-item-hint">{it.hint}</span> : null}
              </span>
              {it.checked ? <Icon name="check" size={18} className="accent" /> : null}
            </button>
          )
        ))}
      </div>
    </div>
  )
}

function ConfirmDialog({ o }) {
  const p = o.props
  const [checked, setChecked] = useState(false)
  return (
    <div className="dialog">
      <div className="dialog-title">{p.title}</div>
      {p.body ? <div className="dialog-body">{p.body}</div> : null}
      {p.checkbox ? (
        <label className="check-row"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} /> <span>{p.checkbox}</span></label>
      ) : null}
      <div className="dialog-buttons">
        <Button onClick={() => closeOverlay(o, false)}>{p.cancelLabel || t('cancel')}</Button>
        <Button kind={p.danger ? 'danger' : 'primary'} disabled={p.checkbox && !checked} onClick={() => closeOverlay(o, true)}>{p.okLabel || t('ok')}</Button>
      </div>
    </div>
  )
}

function PromptDialog({ o }) {
  const p = o.props
  const [value, setValue] = useState(p.value || '')
  const ref = useRef(null)
  useEffect(() => { if (ref.current) { try { ref.current.focus(); ref.current.select() } catch (e) { /* phone */ } } }, [])
  const submit = () => closeOverlay(o, p.allowEmpty ? value : (value.trim() ? value : undefined))
  return (
    <div className="dialog">
      <div className="dialog-title">{p.title}</div>
      {p.body ? <div className="dialog-body">{p.body}</div> : null}
      {p.multiline
        ? <textarea ref={ref} className="input textarea" rows={p.rows || 4} value={value} placeholder={p.placeholder} onInput={e => setValue(e.target.value)} />
        : <input ref={ref} className="input" type={p.type || 'text'} value={value} placeholder={p.placeholder} onInput={e => setValue(e.target.value)} onKeyDown={e => { if (e.keyCode === 13) submit() }} />}
      <div className="dialog-buttons">
        <Button onClick={() => closeOverlay(o, undefined)}>{t('cancel')}</Button>
        <Button kind="primary" onClick={submit}>{p.okLabel || t('ok')}</Button>
      </div>
    </div>
  )
}

function CopyDialog({ o }) {
  const ref = useRef(null)
  useEffect(() => { if (ref.current) { try { ref.current.focus(); ref.current.select() } catch (e) { /* phone */ } } }, [])
  return (
    <div className="dialog dialog-tall">
      <div className="dialog-title">{o.props.title || t('copy')}</div>
      <div className="field-hint">{t('copyHint')}</div>
      <textarea ref={ref} className="input textarea mono" readOnly value={o.props.text} rows={12} />
      <div className="dialog-buttons"><Button kind="primary" onClick={() => closeOverlay(o)}>{t('close')}</Button></div>
    </div>
  )
}

registerOverlay('menu', MenuSheet)
registerOverlay('confirm', ConfirmDialog)
registerOverlay('prompt', PromptDialog)
registerOverlay('copy', CopyDialog)

export function Overlays() {
  useUi()
  if (!ui.overlays.length) return null
  return (
    <div className="overlays">
      {ui.overlays.map((o) => {
        const Comp = registry[o.type]
        const isSheet = o.type === 'menu' || (Comp && Comp.sheet)
        return (
          <div key={o.key} className={'overlay' + (isSheet ? ' overlay-sheet' : '')} onClick={(e) => { if (e.target === e.currentTarget && o.dismissable) closeOverlay(o, undefined) }}>
            {Comp ? <Comp o={o} /> : null}
          </div>
        )
      })}
    </div>
  )
}

export function Toast() {
  useUi()
  const tst = ui.toast
  if (!tst) return null
  return (
    <div key={tst.key} className={'toast toast-' + tst.kind}>
      <span>{tst.text}</span>
      {tst.action ? <button className="toast-action" onClick={() => { ui.toast = null; ui.emit('change'); tst.onAction() }}>{tst.action}</button> : null}
    </div>
  )
}

/** Copy text: clipboard where the platform has one, otherwise a selectable dialog. */
export function copyText(text, title) {
  const p = ui.platform
  if (p && p.clipboard && p.clipboard.copy(text)) {
    toast(t('copied'), { ms: 1600 })
    return Promise.resolve(true)
  }
  return dialog('copy', { text, title })
}

export function relTime(ms) {
  const d = Date.now() - ms
  if (d < 60000) return 'now'
  if (d < 3600000) return Math.floor(d / 60000) + 'min'
  if (d < 86400000) return Math.floor(d / 3600000) + 'h'
  if (d < 30 * 86400000) return Math.floor(d / 86400000) + 'd'
  if (d < 365 * 86400000) return Math.floor(d / (30 * 86400000)) + 'mo'
  return Math.floor(d / (365 * 86400000)) + 'y'
}

export function fmtTokens(n) {
  if (!n) return '0'
  if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K'
  return String(n)
}
