// Context compaction (upstream dsh-compaction-basic + tool-result-pruner).
import { estimateBlocksTokens, estimateTokens } from './util.js'
import { COMPACTION_INSTRUCTION, CHECKPOINT_PREAMBLE } from './prompt.js'

export const HEADROOM = 65536
export const SUMMARY_MAX_TOKENS = 65536

export function budget(model, maxTokens, override) {
  const W = model.contextWindow || 128000
  const O = Math.min(maxTokens || model.maxTokens || 8192, W - 1024)
  let threshold = Math.floor(Math.min(0.8 * W, W - O - HEADROOM))
  if (threshold < 4096) threshold = Math.floor(0.8 * W)
  if (override && override > 0) threshold = Math.min(threshold, override)
  const keep = Math.floor(0.16 * Math.max(W - O, threshold))
  return { W, O, threshold, keep: Math.min(keep, Math.floor(threshold * 0.5)) }
}

function eventTokens(ev) {
  const d = ev.data
  if (ev.type === 'system/message') return estimateTokens(d.text)
  return estimateBlocksTokens(d.content)
}

/** Provider-reported usage of the latest request plus a 4-chars/token estimate for later events. */
export function measure(surface) {
  let base = 0
  let idx = -1
  for (let i = surface.length - 1; i >= 0; i--) {
    const ev = surface[i]
    if (ev.type === 'assistant/message' && ev.data.usage && (ev.data.usage.input || ev.data.usage.cacheRead)) {
      const u = ev.data.usage
      base = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) + (u.output || 0)
      idx = i
      break
    }
  }
  let total = base
  for (let j = idx + 1; j < surface.length; j++) total += eventTokens(surface[j])
  if (idx < 0) total = surface.reduce((n, ev) => n + eventTokens(ev), 0)
  return total
}

/** Prune oversized tool results (first 4096 + marker + last 1024 chars) — returns replacement count. */
export function pruneToolResults(session, surface) {
  let n = 0
  for (const ev of surface) {
    if (ev.type !== 'tool/result' || ev.data.pruned) continue
    const texts = (ev.data.content || []).filter(b => b.type === 'text')
    const len = texts.reduce((s, b) => s + b.text.length, 0)
    if (len <= 8192) continue
    const full = texts.map(b => b.text).join('\n')
    const text = full.slice(0, 4096) + '\n\n[... tool result middle pruned ...]\n\n' + full.slice(full.length - 1024)
    session.append('tool/result', Object.assign({}, ev.data, { content: [{ type: 'text', text }], pruned: true }), { replace: { startSeq: ev.seq, endSeq: ev.seq } })
    n++
  }
  return n
}

/**
 * Choose the span to summarise: from the first non-system message up to the
 * verbatim tail of `keep` tokens, never splitting a tool call from its result.
 * Returns {start, end} indexes into surface (end exclusive) or null.
 */
export function chooseRange(surface, keep) {
  let first = 0
  while (first < surface.length && surface[first].type === 'system/message') first++
  let tail = 0
  let cut = surface.length
  while (cut > first) {
    const t = eventTokens(surface[cut - 1])
    if (tail + t > keep) break
    tail += t
    cut--
  }
  // never start the kept tail with tool results whose call is being summarised
  while (cut < surface.length && cut > first && surface[cut].type === 'tool/result') cut--
  while (cut > first && surface[cut - 1].type === 'assistant/message' && (surface[cut - 1].data.content || []).some(b => b.type === 'tool-call') && cut < surface.length && surface[cut].type === 'tool/result') cut--
  if (cut - first < 1) return null
  return { start: first, end: cut }
}

/**
 * Summarise and commit. llmCall(messages) -> {content, usage} runs the summary
 * request with the conversation's own system prompt and tools (prefix-cache reuse).
 */
export async function compact(session, { keep, llmCall, onPhase }) {
  const surface = session.surface()
  pruneToolResults(session, surface)
  const view = session.surface()
  const range = chooseRange(view, keep)
  if (!range) return { compacted: false, reason: 'nothing-to-compact' }
  const span = view.slice(range.start, range.end)
  const startSeq = span[0].seq
  const endSeq = span[span.length - 1].seq
  const id = 'cmp-' + startSeq + '-' + endSeq
  session.append('compaction/start', { compactionId: id, startSeq, endSeq, items: span.length })
  if (onPhase) onPhase('start')
  let result
  try {
    result = await llmCall(view.slice(0, range.end), COMPACTION_INSTRUCTION)
  } catch (e) {
    session.append('compaction/end', { compactionId: id, failed: true, error: e.message })
    throw e
  }
  const summary = (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
  const replacedTokens = span.reduce((n, ev) => n + eventTokens(ev), 0)
  if (!summary || estimateTokens(summary) >= replacedTokens) {
    session.append('compaction/end', { compactionId: id, failed: true, error: 'summary was empty or not smaller than the replaced history' })
    return { compacted: false, reason: 'summary-not-smaller' }
  }
  session.append('compaction/summary', { compactionId: id, summary, startSeq, endSeq, items: span.length, shadowedTokenCount: replacedTokens, usage: result.usage, provider: result.provider, model: result.model })
  session.append('user/message', {
    content: [{ type: 'text', text: CHECKPOINT_PREAMBLE + '\n\n<compacted-summary>\n' + summary + '\n</compacted-summary>' }],
    source: { kind: 'compaction', compactionId: id },
  }, { replace: { startSeq, endSeq } })
  session.append('compaction/end', { compactionId: id, items: span.length, tokens: replacedTokens })
  if (onPhase) onPhase('end')
  return { compacted: true, items: span.length, tokens: replacedTokens }
}
