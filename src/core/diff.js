// Line diff (Myers O(ND)) producing unified hunks, for edit/write cards and the
// "Edited N files" review. Falls back to a whole-file replacement when the
// edit distance is too large for a phone to compute quickly.
export function diffLines(aText, bText, maxD = 4000) {
  const a = aText === '' ? [] : aText.split('\n')
  const b = bText === '' ? [] : bText.split('\n')
  // trim common prefix/suffix first — most edits are local
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const A = a.slice(pre, a.length - suf)
  const B = b.slice(pre, b.length - suf)
  let ops = myers(A, B, maxD)
  if (!ops) ops = A.map(l => ['-', l]).concat(B.map(l => ['+', l]))
  const head = a.slice(0, pre).map(l => [' ', l])
  const tail = a.slice(a.length - suf).map(l => [' ', l])
  return head.concat(ops, tail)
}

function myers(a, b, maxD) {
  const n = a.length, m = b.length
  if (n === 0) return b.map(l => ['+', l])
  if (m === 0) return a.map(l => ['-', l])
  const max = Math.min(n + m, maxD)
  const offset = max + 1
  let v = new Array(2 * max + 3)
  for (let i = 0; i < v.length; i++) v[i] = 0
  const trace = []
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1]
      else x = v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, a, b, offset, d)
    }
  }
  return null
}

function backtrack(trace, a, b, offset, dEnd) {
  const ops = []
  let x = a.length, y = b.length
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d]
    const k = x - y
    let prevK
    if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) prevK = k + 1
    else prevK = k - 1
    const prevX = v[offset + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) { ops.push([' ', a[x - 1]]); x--; y-- }
    if (x === prevX) { ops.push(['+', b[y - 1]]); y-- }
    else { ops.push(['-', a[x - 1]]); x-- }
  }
  while (x > 0 && y > 0) { ops.push([' ', a[x - 1]]); x--; y-- }
  return ops.reverse()
}

/** Unified diff text with `context` lines around changes; returns {text, added, removed}. */
export function unifiedDiff(path, before, after, context = 3) {
  const ops = diffLines(before, after)
  let added = 0, removed = 0
  for (const o of ops) { if (o[0] === '+') added++; else if (o[0] === '-') removed++ }
  const lines = []
  let aLine = 1, bLine = 1
  let i = 0
  while (i < ops.length) {
    if (ops[i][0] === ' ') { i++; aLine++; bLine++; continue }
    // hunk start
    let start = i
    let back = 0
    while (back < context && start > 0 && ops[start - 1][0] === ' ') { start--; back++ }
    let end = i
    let gap = 0
    while (end < ops.length) {
      if (ops[end][0] !== ' ') { gap = 0; end++; continue }
      gap++
      if (gap > context * 2) break
      end++
    }
    // trim trailing context beyond `context`
    let trailing = 0
    while (end > i && ops[end - 1][0] === ' ' && trailing < gap - context) { end--; trailing++ }
    const aStart = aLine - back
    const bStart = bLine - back
    let aCount = 0, bCount = 0
    const body = []
    for (let j = start; j < end; j++) {
      const [op, text] = ops[j]
      body.push(op + text)
      if (op !== '+') aCount++
      if (op !== '-') bCount++
    }
    lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`)
    lines.push(...body)
    // advance counters over the consumed region
    for (let j = i; j < end; j++) {
      if (ops[j][0] !== '+') aLine++
      if (ops[j][0] !== '-') bLine++
    }
    i = end
  }
  return { text: lines.join('\n'), added, removed, path }
}
