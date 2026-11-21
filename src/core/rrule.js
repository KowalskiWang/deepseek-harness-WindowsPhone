// RFC 5545 recurrence subset used by schedule_create (upstream tool-schedule):
// one DTSTART line and one RRULE line. TZID times are interpreted in the device
// time zone (Windows Phone has no IANA database); a "Z" DTSTART is UTC.
import { makeError, pad2 } from './util.js'

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const FREQS = ['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']

function parseDate(s, utc) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z)?$/.exec(s)
  if (!m) throw makeError('SCHEDULE_INVALID_RRULE', `invalid date-time: ${s}`)
  const parts = [+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)]
  if (m[7] || utc) return new Date(Date.UTC(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]))
  return new Date(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5])
}

function nums(v, min, max, name) {
  return v.split(',').map((x) => {
    const n = parseInt(x, 10)
    if (Number.isNaN(n) || n < min || n > max || n === 0 && min < 0) throw makeError('SCHEDULE_INVALID_RRULE', `invalid ${name}: ${x}`)
    return n
  })
}

export function parseRrule(text) {
  const lines = String(text || '').replace(/\\n/g, '\n').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const dtLine = lines.find(l => /^DTSTART/i.test(l))
  const rrLine = lines.find(l => /^RRULE:/i.test(l))
  if (!dtLine || !rrLine || lines.length !== 2) throw makeError('SCHEDULE_INVALID_RRULE', 'expected one DTSTART line and one RRULE line')
  const dm = /^DTSTART(?:;TZID=([^:]+))?:(\S+)$/i.exec(dtLine)
  if (!dm) throw makeError('SCHEDULE_INVALID_RRULE', 'invalid DTSTART line')
  const tzid = dm[1] || null
  if (!tzid && !/Z$/.test(dm[2])) throw makeError('SCHEDULE_INVALID_RRULE', 'DTSTART must end in Z or carry TZID')
  const dtstart = parseDate(dm[2], false)
  const rule = { tzid, dtstart, interval: 1 }
  for (const part of rrLine.slice(6).split(';')) {
    const [k, v] = part.split('=')
    if (!v) continue
    switch (k.toUpperCase()) {
      case 'FREQ':
        if (FREQS.indexOf(v) < 0) throw makeError('SCHEDULE_INVALID_RRULE', `invalid FREQ: ${v}`)
        if (v === 'SECONDLY') throw makeError('SCHEDULE_INVALID_RRULE', 'SECONDLY is not supported')
        rule.freq = v; break
      case 'INTERVAL': rule.interval = nums(v, 1, 100000, 'INTERVAL')[0]; break
      case 'COUNT': rule.count = nums(v, 1, 1000, 'COUNT')[0]; break
      case 'UNTIL':
        if (!/Z$/.test(v)) throw makeError('SCHEDULE_INVALID_RRULE', 'UNTIL must be a UTC instant ending in Z')
        rule.until = parseDate(v, true); break
      case 'BYSECOND': rule.bysecond = nums(v, 0, 59, 'BYSECOND'); if (rule.bysecond.length > 1) throw makeError('SCHEDULE_INVALID_RRULE', 'BYSECOND takes one value'); break
      case 'BYMINUTE': rule.byminute = nums(v, 0, 59, 'BYMINUTE'); break
      case 'BYHOUR': rule.byhour = nums(v, 0, 23, 'BYHOUR'); break
      case 'BYMONTHDAY': rule.bymonthday = nums(v, -31, 31, 'BYMONTHDAY'); break
      case 'BYMONTH': rule.bymonth = nums(v, 1, 12, 'BYMONTH'); break
      case 'BYSETPOS': rule.bysetpos = nums(v, -366, 366, 'BYSETPOS'); if (rule.bysetpos.length > 31) throw makeError('SCHEDULE_INVALID_RRULE', 'BYSETPOS accepts at most 31 values'); break
      case 'BYDAY':
        rule.byday = v.split(',').map((d) => {
          const mm = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(d)
          if (!mm) throw makeError('SCHEDULE_INVALID_RRULE', `invalid BYDAY: ${d}`)
          return { n: mm[1] ? parseInt(mm[1], 10) : 0, day: DAYS.indexOf(mm[2]) }
        })
        break
      case 'WKST': break
      default: throw makeError('SCHEDULE_INVALID_RRULE', `unsupported rule part: ${k}`)
    }
  }
  if (!rule.freq) throw makeError('SCHEDULE_INVALID_RRULE', 'FREQ is required')
  if ((rule.freq === 'MINUTELY' || rule.freq === 'HOURLY') && (rule.byday || rule.byhour || rule.byminute || rule.bymonthday || rule.bymonth || rule.bysetpos)) {
    throw makeError('SCHEDULE_INVALID_RRULE', 'MINUTELY and HOURLY accept no BY parts; use DAILY or WEEKLY with BYHOUR and BYMINUTE')
  }
  if (rule.bymonthday && rule.freq !== 'MONTHLY' && rule.freq !== 'YEARLY') throw makeError('SCHEDULE_INVALID_RRULE', 'BYMONTHDAY requires MONTHLY or YEARLY')
  if (rule.byday && rule.byday.some(d => d.n) && rule.freq !== 'MONTHLY' && rule.freq !== 'YEARLY') throw makeError('SCHEDULE_INVALID_RRULE', 'ordinal BYDAY requires MONTHLY or YEARLY')
  if (rule.count && rule.until) throw makeError('SCHEDULE_INVALID_RRULE', 'use either COUNT or UNTIL')
  return rule
}

function useUtc(rule) { return !rule.tzid || /^(UTC|Etc\/UTC|GMT|Z)$/i.test(rule.tzid) }

function fields(d, utc) {
  return utc
    ? { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), wd: d.getUTCDay() }
    : { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds(), wd: d.getDay() }
}

function make(utc, y, mo, d, h, mi, s) {
  const t = utc ? new Date(Date.UTC(y, mo, d, h, mi, s)) : new Date(y, mo, d, h, mi, s)
  const f = fields(t, utc)
  // reject normalised (nonexistent) local times, e.g. Feb 30 or DST gaps
  if (f.y !== y || f.mo !== ((mo % 12) + 12) % 12 || f.d !== d || f.h !== h || f.mi !== mi) return null
  return t
}

function daysInMonth(y, mo) { return new Date(Date.UTC(y, mo + 1, 0)).getUTCDate() }

/** Candidates of one FREQ period, sorted, after BY expansion and BYSETPOS. */
function periodCandidates(rule, utc, y, mo, d0, h0, mi0, start) {
  const hours = rule.byhour || [h0]
  const minutes = rule.byminute || [mi0]
  const second = rule.bysecond ? rule.bysecond[0] : start.s
  let days = [] // [y, mo, d]
  if (rule.freq === 'YEARLY' || rule.freq === 'MONTHLY') {
    const months = rule.freq === 'YEARLY' ? (rule.bymonth || (rule.byday || rule.bymonthday ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(x => x + 1) : [start.mo + 1])).map(x => x - 1) : [mo]
    for (const m of months) {
      if (rule.freq === 'MONTHLY' && rule.bymonth && rule.bymonth.indexOf(m + 1) < 0) continue
      const dim = daysInMonth(y, m)
      let set = []
      if (rule.bymonthday) for (const md of rule.bymonthday) { const dd = md > 0 ? md : dim + md + 1; if (dd >= 1 && dd <= dim) set.push(dd) }
      if (rule.byday) {
        const byDays = []
        for (const bd of rule.byday) {
          const matches = []
          for (let dd = 1; dd <= dim; dd++) if (new Date(Date.UTC(y, m, dd)).getUTCDay() === bd.day) matches.push(dd)
          if (bd.n > 0) { if (matches[bd.n - 1]) byDays.push(matches[bd.n - 1]) } else if (bd.n < 0) { if (matches[matches.length + bd.n]) byDays.push(matches[matches.length + bd.n]) } else byDays.push(...matches)
        }
        set = rule.bymonthday ? set.filter(x => byDays.indexOf(x) >= 0) : byDays
      }
      if (!rule.bymonthday && !rule.byday) set = [Math.min(start.d, dim) === start.d ? start.d : -1].filter(x => x > 0)
      for (const dd of set) days.push([y, m, dd])
    }
  } else if (rule.freq === 'WEEKLY') {
    const base = new Date(Date.UTC(y, mo, d0))
    const wd = base.getUTCDay()
    const weekDays = rule.byday ? rule.byday.map(b => b.day) : [start.wd]
    for (const target of weekDays) {
      const delta = (target - 1 + 7) % 7 - (wd - 1 + 7) % 7 // weeks start Monday
      const dd = new Date(Date.UTC(y, mo, d0 + delta))
      days.push([dd.getUTCFullYear(), dd.getUTCMonth(), dd.getUTCDate()])
    }
  } else if (rule.freq === 'DAILY') {
    const dd = new Date(Date.UTC(y, mo, d0))
    if (!rule.byday || rule.byday.some(b => b.day === dd.getUTCDay())) days.push([y, mo, d0])
    if (rule.bymonth && rule.bymonth.indexOf(mo + 1) < 0) days = []
  }
  const out = []
  if (rule.freq === 'HOURLY' || rule.freq === 'MINUTELY') {
    const t = make(utc, y, mo, d0, h0, mi0, second)
    if (t) out.push(t)
  } else {
    for (const day of days) for (const h of hours) for (const mi of minutes) {
      const t = make(utc, day[0], day[1], day[2], h, mi, second)
      if (t) out.push(t)
    }
  }
  out.sort((a, b) => a - b)
  const uniq = out.filter((t, i) => i === 0 || +t !== +out[i - 1])
  if (rule.bysetpos) {
    const picked = []
    for (const p of rule.bysetpos) { const t = p > 0 ? uniq[p - 1] : uniq[uniq.length + p]; if (t) picked.push(t) }
    picked.sort((a, b) => a - b)
    return picked
  }
  return uniq
}

/** First occurrence strictly after `after` (Date), or null when the rule has ended. */
export function nextOccurrence(rule, after) {
  const utc = useUtc(rule)
  const start = fields(rule.dtstart, utc)
  let count = 0
  const stepPeriod = (i) => {
    const n = i * rule.interval
    switch (rule.freq) {
      case 'YEARLY': return [start.y + n, 0, 1, start.h, start.mi]
      case 'MONTHLY': { const dd = new Date(Date.UTC(start.y, start.mo + n, 1)); return [dd.getUTCFullYear(), dd.getUTCMonth(), 1, start.h, start.mi] }
      case 'WEEKLY': { const dd = new Date(Date.UTC(start.y, start.mo, start.d + 7 * n)); return [dd.getUTCFullYear(), dd.getUTCMonth(), dd.getUTCDate(), start.h, start.mi] }
      case 'DAILY': { const dd = new Date(Date.UTC(start.y, start.mo, start.d + n)); return [dd.getUTCFullYear(), dd.getUTCMonth(), dd.getUTCDate(), start.h, start.mi] }
      case 'HOURLY': { const dd = new Date(rule.dtstart.getTime() + n * 3600000); const f = fields(dd, utc); return [f.y, f.mo, f.d, f.h, f.mi] }
      default: { const dd = new Date(rule.dtstart.getTime() + n * 60000); const f = fields(dd, utc); return [f.y, f.mo, f.d, f.h, f.mi] }
    }
  }
  // Without COUNT, skip ahead to just before `after` for the fixed-length frequencies.
  let i = 0
  const spanMs = { MINUTELY: 60000, HOURLY: 3600000, DAILY: 86400000, WEEKLY: 604800000 }[rule.freq]
  if (!rule.count && spanMs && after > rule.dtstart) i = Math.max(0, Math.floor((after - rule.dtstart) / (spanMs * rule.interval)) - 2)
  for (let guard = 0; guard < 20000; guard++, i++) {
    const p = stepPeriod(i)
    const cands = periodCandidates(rule, utc, p[0], p[1], p[2], p[3], p[4], start)
    for (const t of cands) {
      if (t < rule.dtstart) continue
      if (rule.until && t > rule.until) return null
      count++
      if (rule.count && count > rule.count) return null
      if (t > after) return t
    }
    if (rule.until && makePeriodStart(p, utc) > rule.until) return null
  }
  return null
}

function makePeriodStart(p, utc) { return utc ? new Date(Date.UTC(p[0], p[1], p[2])) : new Date(p[0], p[1], p[2]) }

export function formatLocal(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

/** Build an rrule from the Automation UI's repeat choices. */
export function buildRrule(kind, at, opts) {
  const o = opts || {}
  const d = at || new Date()
  const ds = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + pad2(d.getMinutes()) + '00'
  const tz = o.tzid || 'Local'
  const head = `DTSTART;TZID=${tz}:${ds}\n`
  switch (kind) {
    case 'once': return head + 'RRULE:FREQ=DAILY;COUNT=1'
    case 'minutes': return head + `RRULE:FREQ=MINUTELY;INTERVAL=${Math.max(1, o.every || 30)}`
    case 'hours': return head + `RRULE:FREQ=HOURLY;INTERVAL=${Math.max(1, o.every || 1)}`
    case 'day': return head + 'RRULE:FREQ=DAILY'
    case 'week': return head + `RRULE:FREQ=WEEKLY;BYDAY=${DAYS[d.getDay()]}`
    case 'weekdays': return head + 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'
    case 'month': return head + `RRULE:FREQ=MONTHLY;BYMONTHDAY=${d.getDate()}`
    default: return o.custom || head + 'RRULE:FREQ=DAILY'
  }
}
