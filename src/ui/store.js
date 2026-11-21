// App-level UI state: navigation stack, dialogs, menus (bottom sheets), toasts,
// and hooks that re-render on runtime events.
import { useEffect, useReducer, useRef } from 'preact/hooks'
import { Emitter, throttle } from '../core/util.js'

export const ui = new Emitter()
ui.rt = null
ui.platform = null
ui.stack = [{ page: 'home', params: {}, key: 1 }]
ui.overlays = [] // dialogs and sheets, topmost last
ui.toast = null
let keySeq = 1

function changed() { ui.emit('change') }

export function current() { return ui.stack[ui.stack.length - 1] }

export function navigate(page, params) {
  ui.stack.push({ page, params: params || {}, key: ++keySeq })
  if (ui.platform && ui.platform.onNavigate) ui.platform.onNavigate(ui.stack.length)
  changed()
}

export function replace(page, params) {
  ui.stack[ui.stack.length - 1] = { page, params: params || {}, key: ++keySeq }
  changed()
}

export function goHome() {
  ui.stack = [ui.stack[0]]
  changed()
}

/** Hardware/browser back. Returns true when handled inside the app. */
export function back() {
  if (ui.overlays.length) {
    const top = ui.overlays[ui.overlays.length - 1]
    if (top.dismissable === false) return true
    closeOverlay(top, undefined)
    return true
  }
  const page = current()
  if (page.onBack && page.onBack()) return true
  if (ui.stack.length > 1) { ui.stack.pop(); changed(); return true }
  return false
}

export function openOverlay(type, props) {
  return new Promise((resolve) => {
    const o = { type, props: props || {}, resolve, key: ++keySeq, dismissable: !(props && props.dismissable === false) }
    ui.overlays.push(o)
    changed()
  })
}

export function closeOverlay(o, value) {
  const i = ui.overlays.indexOf(o)
  if (i < 0) return
  ui.overlays.splice(i, 1)
  changed()
  o.resolve(value)
}

/** Bottom-sheet menu: items [{label, icon?, value, danger?, hint?, checked?}] → chosen value. */
export function menu(title, items) { return openOverlay('menu', { title, items }) }
export function confirm(props) { return openOverlay('confirm', props) }
export function prompt(props) { return openOverlay('prompt', props) }
export function dialog(type, props) { return openOverlay(type, props) }

let toastTimer = null
export function toast(text, opts) {
  ui.toast = { text, action: opts && opts.action, onAction: opts && opts.onAction, kind: (opts && opts.kind) || 'info', key: ++keySeq }
  changed()
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { ui.toast = null; changed() }, (opts && opts.ms) || 3200)
}

/** Re-render on UI navigation/overlay changes. */
export function useUi() {
  const [, force] = useReducer(x => x + 1, 0)
  useEffect(() => ui.on('change', force), [])
}

/** Re-render (throttled) when the runtime emits any of the given events. */
export function useRuntime(events, filter, ms = 150) {
  const [, force] = useReducer(x => x + 1, 0)
  const fref = useRef(filter)
  fref.current = filter
  useEffect(() => {
    const rt = ui.rt
    if (!rt) return undefined
    const run = throttle(() => force(), ms)
    const offs = events.map(ev => rt.on(ev, (arg) => { if (!fref.current || fref.current(ev, arg)) run() }))
    return () => offs.forEach(off => off())
  }, [events.join(',')])
}

export function useForce() {
  const [, force] = useReducer(x => x + 1, 0)
  return force
}
