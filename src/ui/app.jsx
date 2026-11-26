import { h } from 'preact'
import { useEffect } from 'preact/hooks'
import { ui, current, useUi, dialog, toast } from './store.js'
import { Overlays, Toast } from './components.jsx'
import { HomePage } from './pages/home.jsx'
import { ChatPage } from './pages/chat.jsx'
import { SettingsPage, ProviderPage } from './pages/settings.jsx'
import { PluginsPage } from './pages/plugins.jsx'
import { AutomationPage, TaskPage } from './pages/automation.jsx'
import { FilesPage, PreviewPage } from './pages/files.jsx'
import { TextPage, ImagePage, PanelPage, AboutPage } from './pages/misc.jsx'
import { SelfTestPage } from './pages/selftest.jsx'
import { t } from './i18n.js'

const PAGES = {
  home: HomePage, chat: ChatPage, settings: SettingsPage, provider: ProviderPage, plugins: PluginsPage,
  automation: AutomationPage, task: TaskPage, files: FilesPage, preview: PreviewPage,
  text: TextPage, image: ImagePage, panel: PanelPage, about: AboutPage, selftest: SelfTestPage,
}

export const WELCOME_VERSION = '2026-11-22.1'

export function resolvedTheme() {
  const pref = ui.rt.settings.get().general.theme
  if (pref === 'light' || pref === 'dark') return pref
  try { if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light' } catch (e) { /* IE11 */ }
  return 'dark'
}

export function applyTheme() {
  const theme = resolvedTheme()
  const link = document.getElementById('theme-css')
  const href = 'css/theme-' + theme + '.css'
  if (link && link.getAttribute('href') !== href) link.setAttribute('href', href)
  document.documentElement.style.fontSize = (ui.rt.settings.get().general.fontSize || 15) + 'px'
  document.documentElement.className = 'theme-' + theme + ' platform-' + ui.platform.hint
  if (ui.platform.setStatusBar) ui.platform.setStatusBar(theme === 'dark')
}

/** First run: preview notice (versioned), then the API key dialog when no model is reachable. */
export async function onboarding() {
  const rt = ui.rt
  const g = rt.settings.get().general
  if (g.welcomeAck !== WELCOME_VERSION) {
    await dialog('welcome', { dismissable: false })
    rt.settings.update({ general: { welcomeAck: WELCOME_VERSION } })
  }
  if (!rt.hasUsableModel() && !g.onboarded) await dialog('apikey', {})
  else if (!rt.hasUsableModel()) toast(t('addApiKeyTitle'), { action: t('settings'), onAction: () => dialog('apikey', {}), ms: 6000 })
}

export function App() {
  useUi()
  useEffect(() => {
    const off = ui.on('theme', applyTheme)
    return off
  }, [])
  const page = current()
  const Comp = PAGES[page.page] || HomePage
  return (
    <div className="app">
      <Comp key={page.key} params={page.params} />
      <Overlays />
      <Toast />
    </div>
  )
}
