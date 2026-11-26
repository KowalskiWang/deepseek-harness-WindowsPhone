import { h } from 'preact'
import { useEffect, useReducer } from 'preact/hooks'
import { t } from '../i18n.js'
import { ui, navigate } from '../store.js'
import { Page, Section, Button, Spinner, copyText } from '../components.jsx'
import { Icon } from '../icons.jsx'
import { activeSelfTest, startSelfTest, OFFLINE_SUITES } from '../../selftest/runner.js'
import { formatClock, throttle } from '../../core/util.js'

const MARK = { pass: '✓', fail: '✗', skip: '–' }
const MARK_CLASS = { pass: 'ok', fail: 'err', skip: 'muted' }

function CheckRow({ c }) {
  const open = () => navigate('text', { title: c.suite + ' / ' + c.name, text: '```\n' + (c.detail || '(no detail)') + '\n```' })
  return (
    <div className="list-item tappable" onClick={open}>
      <div className={'list-item-icon ' + MARK_CLASS[c.status]}>{MARK[c.status]}</div>
      <div className="list-item-main">
        <div className="list-item-title">{c.name}</div>
        {c.detail && c.status !== 'pass' ? <div className="list-item-sub">{c.detail}</div> : null}
      </div>
      <div className="list-item-right small">{c.ms >= 1000 ? formatClock(c.ms) : c.ms + ' ms'}</div>
    </div>
  )
}

/** Self-test page: starts a run (or shows the one in progress) and lists every check. */
export function SelfTestPage() {
  const [, force] = useReducer(x => x + 1, 0)
  const st = activeSelfTest()
  useEffect(() => {
    if (!st) return undefined
    const off = st.on('change', throttle(force, 300))
    const timer = setInterval(() => { if (st.state === 'running') force() }, 1000)
    return () => { off(); clearInterval(timer) }
  }, [st])

  const start = (suites) => {
    startSelfTest(ui.rt, { suites })
    force()
  }

  const rt = ui.rt
  if (!st) {
    return (
      <Page title={t('selfTest')}>
        <div className="pad">
          <p>{t('selfTestIntro')}</p>
          {!rt.hasUsableModel() ? <p className="muted small">{t('selfTestNoKey')}</p> : null}
          <Button kind="primary" onClick={() => start(null)}>{t('selfTestFull')}</Button>
          <div className="pad-v"><Button onClick={() => start(OFFLINE_SUITES)}>{t('selfTestOffline')}</Button></div>
        </div>
      </Page>
    )
  }

  const r = st.result()
  const groups = []
  for (const c of st.checks) {
    let g = groups[groups.length - 1]
    if (!g || g.suite !== c.suite) { g = { suite: c.suite, checks: [] }; groups.push(g) }
    g.checks.push(c)
  }
  const running = st.state === 'running'
  const summary = r.summary.pass + ' ' + t('st_pass') + ' · ' + r.summary.fail + ' ' + t('st_fail') + ' · ' + r.summary.skip + ' ' + t('st_skip') + ' · ' + formatClock(r.ms)
  return (
    <Page title={running ? t('selfTestRunning') : t('selfTestDone')} subtitle={summary}
      actions={<button className="icon-btn" onClick={() => copyText(JSON.stringify(r, null, 1))} aria-label={t('copyResult')}><Icon name="copy" size={20} /></button>}>
      {running ? (
        <div className="pad row"><Spinner /><span className="small" style={{ marginLeft: '8px' }}>{st.current ? st.current.suite + ' / ' + st.current.name : '…'}</span></div>
      ) : (
        <div className="pad"><Button onClick={() => start(st.opts.suites)}>{t('selfTestAgain')}</Button></div>
      )}
      {groups.map(g => (
        <Section key={g.suite} title={g.suite}>
          {g.checks.map((c, i) => <CheckRow key={i} c={c} />)}
        </Section>
      ))}
      <div className="pad muted small">{r.id} · {r.version} ({r.build}) · {r.env ? r.env.hint + (r.env.osVersion ? ' · ' + r.env.osVersion : '') : ''}</div>
    </Page>
  )
}
