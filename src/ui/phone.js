// Phone integration driven by runtime events: the status-bar progress
// indicator while agents work, background execution on Windows 10 Mobile,
// the Start tile (latest finished task) and its badge (sessions waiting for
// the user). Every hook is optional; the web build has none of them.
import { textOfBlocks } from '../core/session.js'
import { clip, throttle } from '../core/util.js'
import { t } from './i18n.js'
import { toast, navigate, current } from './store.js'
import { hasPending } from '../core/remote-dsh.js'

export function installPhoneIntegration(rt, platform) {
  let lastBusy
  let lastBadge = -1
  let keep = false

  const refresh = () => {
    const agents = Object.keys(rt.agents).map(k => rt.agents[k])
    const remote = rt.remote ? rt.remote.list() : []
    const running = agents.filter(a => a.running && !a.isSubagent).concat(remote.filter(s => s.running))
    const waiting = agents.filter(a => a.pending).length + remote.filter(hasPending).length
    const busy = waiting ? t('busyWaiting') : running.length > 1 ? t('busyMany', { n: running.length }) : running.length ? t('busyOne') : null
    if (busy !== lastBusy && platform.busy) { lastBusy = busy; platform.busy(busy) }
    const want = running.length > 0
    if (want !== keep && platform.keepRunning) { keep = want; platform.keepRunning(want, 'tasks') }
    if (platform.badge) {
      const unread = rt.sessions.list().filter(m => m.unread && !m.archived && !m.isSubagent).length
      const n = waiting + unread
      if (n !== lastBadge) { lastBadge = n; platform.badge(n) }
    }
  }
  const later = throttle(refresh, 400)

  rt.on('agent', later)
  rt.on('sessions', later)
  if (rt.remote) {
    // sessions running on the computer: same signals as local ones
    const as = s => ({ meta: { title: s.title || 'dsh' }, session: { id: 'remote:' + s.id } })
    const notifyOn = () => rt.settings.get().general.notifications
    rt.remote.on('change', later)
    rt.remote.on('needs-input', (s) => { if (platform.notify && notifyOn()) platform.notify('needs-input', as(s), {}) })
    rt.remote.on('done', (s) => {
      const last = s.items.filter(i => i.kind === 'message').pop()
      const text = last ? clip(last.text.replace(/\s+/g, ' ').trim(), 140) : ''
      if (platform.notify && notifyOn()) platform.notify('turn-done', as(s), { text })
      if (platform.tile && notifyOn()) platform.tile(s.title || 'dsh', text || t('taskDone'))
    })
  }
  rt.on('notify', (n) => {
    if (n.kind === 'turn-done' && platform.tile && rt.settings.get().general.notifications) {
      const agent = rt.getAgent(n.sessionId)
      const last = agent && agent.session.last('assistant/message')
      const text = last ? textOfBlocks(last.data.content).replace(/\s+/g, ' ').trim() : ''
      platform.tile(n.title || 'DSH', clip(text, 140) || t('taskDone'))
    }
    later()
  })
  refresh()

  // In the app, a session other than the open one that finishes or waits for
  // the user gets a toast that opens it.
  const visible = () => !(typeof document !== 'undefined' && (document.hidden || document.visibilityState === 'hidden'))
  const notice = (title, kind, page, params) => {
    if (!visible()) return
    const top = current()
    if (top.page === page && top.params.sessionId === params.sessionId) return
    const what = kind === 'needs-input' ? t('noticeNeedsInput') : kind === 'turn-failed' ? t('noticeFailed') : t('noticeDone')
    toast(clip(title || 'DSH', 30) + ' · ' + what, { action: t('noticeOpen'), onAction: () => navigate(page, params), ms: 6000, kind: kind === 'turn-failed' ? 'error' : 'info' })
  }
  rt.on('notify', (n) => {
    if (n.kind === 'needs-input' || n.kind === 'turn-done' || n.kind === 'turn-failed') notice(n.title, n.kind, 'chat', { sessionId: n.sessionId })
  })
  if (rt.remote) {
    rt.remote.on('needs-input', s => notice(s.title, 'needs-input', 'remote-chat', { sessionId: s.id }))
    rt.remote.on('done', s => notice(s.title, s.items.length && s.items[s.items.length - 1].error ? 'turn-failed' : 'turn-done', 'remote-chat', { sessionId: s.id }))
  }
}

/** The page for launch arguments ({"sessionId": …} from a toast), or null. */
export function launchTarget(rt, args) {
  let a
  try { a = JSON.parse(args) } catch (e) { return null }
  const id = a && a.sessionId
  if (!id) return null
  if (id.indexOf('remote:') === 0) return rt.remote && rt.remote.get(id.slice(7)) ? { page: 'remote-chat', params: { sessionId: id.slice(7) } } : null
  return rt.sessions.getMeta(id) ? { page: 'chat', params: { sessionId: id } } : null
}
