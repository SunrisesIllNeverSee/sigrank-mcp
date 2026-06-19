/**
 * tokenpull.mjs — SigRank's in-house local usage reader.
 *
 * Reads token telemetry straight from the platform's local session logs (Claude Code
 * first: ~/.claude/projects/<project>/<session>.jsonl) and slices it into the four
 * windows (7d / 30d / 90d / all) of raw pillars — the WINDOWED_PROFILES payload, pulled
 * with zero paste. No ccusage, no tokscale: our own reader, our own numbers.
 *
 * Token-only: we read usage counts (input/output/cache), message id, and timestamp —
 * never message text. Billing-accurate: messages are deduped by `message.id` so the
 * tally matches what the API actually billed (the one trick token-dashboard gets right
 * and sigrank-agent's line-index keying does not).
 *
 * Adapter-shaped for multi-system: add a Codex / Cursor / Gemini reader by implementing
 * the same { platform, defaultRoot(), messages(root) } contract — Claude is just the first.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DAY_MS = 86_400_000

/** The four windows, in days. `all` = unbounded. */
export const WINDOWS = [
  { key: '7d', days: 7 },
  { key: '30d', days: 30 },
  { key: '90d', days: 90 },
  { key: 'all', days: Infinity },
]

/** Recursively yield every *.jsonl path under dir (any depth), sorted. Must be
 *  recursive: Claude Code stores sub-agent transcripts in `<project>/subagents/`
 *  (and other nested logs) — a 2-level readdir silently drops them, which badly
 *  under-counts input (sub-agent runs are input-heavy). token-dashboard's rglob. */
async function* _walkJsonl(dir) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, e.name)
    if (e.isDirectory()) yield* _walkJsonl(full)
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield full
  }
}

/**
 * Claude Code adapter. Yields one record per billed assistant message:
 * { id, sid, ts, input, output, cacheCreate, cacheRead, file }. Walks
 * ~/.claude/projects RECURSIVELY (incl. subagents/) and carries sessionId so the
 * caller can dedup by (session_id, message_id) like token-dashboard.
 */
export const claudeAdapter = {
  platform: 'claude',
  defaultRoot: () => join(homedir(), '.claude', 'projects'),
  async *messages(root) {
    for await (const path of _walkJsonl(root)) {
      let text
      try { text = await readFile(path, 'utf8') } catch { continue }
      const rel = path.startsWith(root) ? path.slice(root.length + 1) : path
      for (const line of text.split('\n')) {
        const s = line.trim()
        if (!s) continue
        let ev
        try { ev = JSON.parse(s) } catch { continue }
        const m = ev && ev.message
        if (!m || typeof m !== 'object') continue
        const u = m.usage
        if (!u || typeof u !== 'object') continue
        yield {
          id: m.id || null,
          sid: ev.sessionId || null,
          ts: ev.timestamp || ev.ts || null,
          input: Number(u.input_tokens) || 0,
          output: Number(u.output_tokens) || 0,
          cacheCreate: Number(u.cache_creation_input_tokens) || 0,
          cacheRead: Number(u.cache_read_input_tokens) || 0,
          file: rel,
        }
      }
    }
  },
}

/**
 * Pull local usage and slice it into the four windows of raw pillars.
 * Deterministic given (adapter output, now). Inject `now`/`root`/`adapter` for tests.
 * Returns { platform, root, generatedAt, files, totalMessages, windows:[{window,pillars,messages}] }.
 */
export async function tokenpull({ adapter = claudeAdapter, root, now } = {}) {
  const r = root || adapter.defaultRoot()
  const nowMs = now == null ? Date.now() : (typeof now === 'number' ? now : Date.parse(now))

  // Dedup by (session_id, message_id), keeping the FINAL snapshot — matches
  // token-dashboard: Claude Code writes 2-3 partial→final lines per response with
  // the same message.id; only the final tally matches billing. No-id records each
  // get a unique synthetic key so they always count.
  const seen = new Map()
  const files = new Set()
  let noId = 0
  for await (const msg of adapter.messages(r)) {
    const key = msg.sid && msg.id ? `${msg.sid}|${msg.id}` : (msg.id || `__noid_${noId++}`)
    seen.set(key, msg) // keep-last (final snapshot wins)
    if (msg.file) files.add(msg.file)
  }
  const msgs = [...seen.values()]

  const windows = WINDOWS.map((w) => {
    const cutoff = w.days === Infinity ? -Infinity : nowMs - w.days * DAY_MS
    const inWin = msgs.filter((m) => {
      if (w.days === Infinity) return true
      const t = m.ts ? Date.parse(m.ts) : NaN
      return Number.isFinite(t) && t >= cutoff && t <= nowMs
    })
    const pillars = inWin.reduce(
      (a, m) => ({ input: a.input + m.input, output: a.output + m.output, cacheCreate: a.cacheCreate + m.cacheCreate, cacheRead: a.cacheRead + m.cacheRead }),
      { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    )
    return { window: w.key, pillars, messages: inWin.length }
  })

  return {
    platform: adapter.platform,
    root: r,
    generatedAt: new Date(nowMs).toISOString(),
    files: files.size,
    totalMessages: msgs.length,
    windows,
  }
}

// ── Codex ──────────────────────────────────────────────────────────────────
// Logs at ~/.codex/sessions/**/rollout-*.jsonl (+ archived_sessions). Token usage is
// on `payload.type=='token_count'` lines; `payload.info.last_token_usage` is the
// per-turn delta. Codex `input_tokens` is INCLUSIVE of cached, so the combined input to
// split = input_tokens − cached_input_tokens (= ccusage's inputTokens, verified ~1%).
// The input/cacheCreate split is WINDOW-level (estInput = output × io_ratio), so Codex
// has its own pull (tokenpullCodex) instead of the per-message claude pipeline.
export const codexAdapter = {
  platform: 'codex',
  defaultRoot: () => join(homedir(), '.codex'),
  async *records(root) {
    for (const sub of ['sessions', 'archived_sessions']) {
      for await (const path of _walkJsonl(join(root, sub))) {
        let text
        try { text = await readFile(path, 'utf8') } catch { continue }
        const rel = path.startsWith(root) ? path.slice(root.length + 1) : path
        for (const line of text.split('\n')) {
          if (!line.includes('"token_count"')) continue
          let ev
          try { ev = JSON.parse(line) } catch { continue }
          const p = ev && ev.payload
          if (!p || p.type !== 'token_count') continue
          const u = (p.info || {}).last_token_usage || {}
          const inputIncl = Number(u.input_tokens) || 0
          const cached = Number(u.cached_input_tokens) || 0
          yield {
            ts: ev.timestamp || null,
            output: (Number(u.output_tokens) || 0) + (Number(u.reasoning_output_tokens) || 0),
            cacheRead: cached,
            uncached: Math.max(0, inputIncl - cached), // (true input + cache-write), split window-level
            file: rel,
          }
        }
      }
    }
  },
}

/**
 * Pull local Codex usage → the 4 windows of CANONICAL pillars (always estimated).
 * Window-level conversion: input = floor(output × ioRatio) (Beta = operator's Claude
 * input/output ratio; Alpha = 2.0 default), cacheCreate = max(0, uncached − input).
 * Inject ioRatio/root/now/adapter for tests.
 */
export async function tokenpullCodex({ adapter = codexAdapter, root, now, ioRatio = 2.0 } = {}) {
  const r = root || adapter.defaultRoot()
  const nowMs = now == null ? Date.now() : (typeof now === 'number' ? now : Date.parse(now))
  const recs = []
  const files = new Set()
  for await (const m of adapter.records(r)) { recs.push(m); if (m.file) files.add(m.file) }

  const windows = WINDOWS.map((w) => {
    const cutoff = w.days === Infinity ? -Infinity : nowMs - w.days * DAY_MS
    const inWin = recs.filter((m) => {
      if (w.days === Infinity) return true
      const t = m.ts ? Date.parse(m.ts) : NaN
      return Number.isFinite(t) && t >= cutoff && t <= nowMs
    })
    const sum = inWin.reduce(
      (a, m) => ({ output: a.output + m.output, cacheRead: a.cacheRead + m.cacheRead, uncached: a.uncached + m.uncached }),
      { output: 0, cacheRead: 0, uncached: 0 },
    )
    const input = Math.floor(sum.output * ioRatio) // estimated true input
    const cacheCreate = Math.max(0, sum.uncached - input) // split cache-write out of the combined input
    return { window: w.key, messages: inWin.length, pillars: { input, output: sum.output, cacheCreate, cacheRead: sum.cacheRead } }
  })

  return { platform: 'codex', root: r, generatedAt: new Date(nowMs).toISOString(), files: files.size, totalMessages: recs.length, estimated: true, ioRatio, windows }
}
