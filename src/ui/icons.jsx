import { h } from 'preact'

// 24×24 stroke icons drawn for this app (no third-party icon assets).
const P = {
  add: 'M12 5v14M5 12h14',
  send: 'M4 12l16-8-6 16-2-7-8-1z',
  stop: 'M7 7h10v10H7z',
  settings: 'M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM19.4 13a7.6 7.6 0 000-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 00-1.7-1L15 3.5h-4l-.4 2.5a7.6 7.6 0 00-1.7 1l-2.4-1-2 3.4L6.6 11a7.6 7.6 0 000 2l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 001.7 1l.3 2.5h4l.4-2.5a7.6 7.6 0 001.7-1l2.4 1 2-3.4z',
  search: 'M10.5 17a6.5 6.5 0 100-13 6.5 6.5 0 000 13zM15.5 15.5L20 20',
  back: 'M15 5l-7 7 7 7',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  attach: 'M20 11.5l-7.8 7.8a5 5 0 01-7-7l7.8-7.8a3.3 3.3 0 014.7 4.7l-7.6 7.6a1.7 1.7 0 01-2.4-2.4l7-7',
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  file: 'M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  close: 'M6 6l12 12M18 6L6 18',
  chevronRight: 'M9 5l7 7-7 7',
  chevronDown: 'M5 9l7 7 7-7',
  chevronUp: 'M5 15l7-7 7 7',
  shield: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z',
  plan: 'M9 4h6v3H9zM7 5H5v15h14V5h-2M8 11h8M8 15h5',
  goal: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 16a4 4 0 100-8 4 4 0 000 8zM12 12h.01',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  puzzle: 'M10 4a2 2 0 014 0v2h4v4h-2a2 2 0 000 4h2v4h-4v-2a2 2 0 00-4 0v2H6v-4h2a2 2 0 000-4H6V6h4z',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  pin: 'M9 3h6l-1 6 4 3H6l4-3zM12 12v9',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  fork: 'M6 3v6a4 4 0 004 4h4a4 4 0 004-4V3M12 13v8M6 3h.01M18 3h.01',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  copy: 'M9 9h10v12H9zM5 15H4V3h12v1',
  thumbUp: 'M7 11v9H4v-9zM7 11l4-8a2 2 0 012 2v4h5.5a2 2 0 012 2.3l-1.2 7A2 2 0 0117.3 20H7',
  thumbDown: 'M7 13V4H4v9zM7 13l4 8a2 2 0 002-2v-4h5.5a2 2 0 002-2.3l-1.2-7A2 2 0 0017.3 4H7',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7',
  play: 'M7 4l13 8-13 8z',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01',
  model: 'M12 2l8.5 5v10L12 22l-8.5-5V7zM12 22V12M20.5 7L12 12 3.5 7',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  panel: 'M4 4h16v16H4zM14 4v16',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  agent: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 4-6 8-6s8 2 8 6',
  globe: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5',
  question: 'M9.5 9a2.5 2.5 0 115 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01M12 21a9 9 0 100-18 9 9 0 000 18z',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 8h.01',
  warning: 'M12 3l10 18H2zM12 10v4M12 17h.01',
  sparkle: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z',
  key: 'M14 10a5 5 0 10-1.5 3.5L21 22M17 18l2-2M19 20l2-2',
  wifi: 'M2 9a15 15 0 0120 0M5 12.5a10 10 0 0114 0M8.5 16a5 5 0 017 0M12 19.5h.01',
  download: 'M12 4v11M7 10l5 5 5-5M4 20h16',
  lock: 'M6 11h12v10H6zM8 11V8a4 4 0 018 0v3',
}

export function Icon({ name, size = 20, className = '', title }) {
  const d = P[name] || P.info
  return (
    <svg className={'icon ' + className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : 'true'} focusable="false">
      {title ? <title>{title}</title> : null}
      <path d={d} />
    </svg>
  )
}

export function Logo({ size = 28 }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <rect x="0" y="0" width="48" height="48" fill="#4d6bfe" />
      <path d="M11 16l9 8-9 8" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="square" />
      <path d="M24 33h13" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="square" />
    </svg>
  )
}
