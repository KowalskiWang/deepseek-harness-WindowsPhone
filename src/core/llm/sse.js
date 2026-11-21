// Incremental Server-Sent Events parser. Tolerates a BOM, CRLF and comment
// heartbeats (": ping"), which reset the idle timer via onActivity.
export function createSseParser(onEvent, onActivity) {
  let buffer = ''
  let eventName = ''
  let dataLines = []
  let first = true

  function dispatch() {
    if (dataLines.length === 0) { eventName = ''; return }
    const data = dataLines.join('\n')
    const ev = { event: eventName || 'message', data }
    eventName = ''
    dataLines = []
    onEvent(ev)
  }

  function line(l) {
    if (l === '') { dispatch(); return }
    if (l.charAt(0) === ':') { if (onActivity) onActivity(); return }
    const i = l.indexOf(':')
    const field = i < 0 ? l : l.slice(0, i)
    let value = i < 0 ? '' : l.slice(i + 1)
    if (value.charAt(0) === ' ') value = value.slice(1)
    if (field === 'event') eventName = value
    else if (field === 'data') dataLines.push(value)
  }

  return {
    push(chunk) {
      if (!chunk) return
      if (first) { if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1); first = false }
      if (onActivity) onActivity()
      buffer += chunk
      let idx
      while ((idx = buffer.search(/\r\n|\r|\n/)) >= 0) {
        const l = buffer.slice(0, idx)
        const nl = buffer.charAt(idx) === '\r' && buffer.charAt(idx + 1) === '\n' ? 2 : 1
        buffer = buffer.slice(idx + nl)
        line(l)
      }
    },
    end() {
      if (buffer) { line(buffer); buffer = '' }
      dispatch()
    },
  }
}
