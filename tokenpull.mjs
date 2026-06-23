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

import { readdir, readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { ADAPTERS } from './adapters.mjs'

const DAY_MS = 86_400_000

// Background tooling that runs under your account but is NOT your work — memory plugins,
// observers, summarizers, sub-agent fleets. They pad output/Υ (claude-mem did ~27%).
// Excluded so pillars reflect the operator, not their tools. EXTENSIBLE — add tool
// dir-name patterns here. Strategic note: others' tools inflate the PUBLIC
// token-dashboard / tokscale boards; SigRank filters them, so SigRank stays honest.
// subagents/ are KEPT (real work). Future-robust signal: also drop entrypoint=sdk-cli.
export const EXCLUDE_TOOLING =
  /(^|[/-])(claude-mem|mem0|claude-self-reflect|basic-memory|memento|cipher-mem|memory-keeper)\b|observer-(sessions|archive)/i

/** The four windows, in days. `all` = unbounded. */
export const WINDOWS = [
  { key: '7d', days: 7 },
  { key: '30d', days: 30 },
  { key: '90d', days: 90 },
  { key: 'all', days: Infinity },
]

/** Hard cap: stop walking after this many .jsonl files to prevent OOM on
 *  accidentally huge or circularly-symlinked directory trees.
 *  Override via SIGRANK_MAX_JSONL_FILES env var. */
const MAX_JSONL_FILES = Number(process.env.SIGRANK_MAX_JSONL_FILES) || 10_000

/** Recursively yield every *.jsonl path under dir (any depth), sorted. Must be
 *  recursive: Claude Code stores sub-agent transcripts in `<project>/subagents/`
 *  (and other nested logs) — a 2-level readdir silently drops them, which badly
 *  under-counts input (sub-agent runs are input-heavy). token-dashboard's rglob.
 *
 *  Hardened: skips symlinked directories (prevents circular traversal) and stops
 *  after MAX_JSONL_FILES files (prevents OOM on pathological trees). */
async function* _walkJsonl(dir, _counter = { n: 0 }) {
  if (_counter.n >= MAX_JSONL_FILES) return
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (_counter.n >= MAX_JSONL_FILES) return
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      // Skip symlinked directories — prevents circular traversal on machines where
      // ~/.claude/projects/ contains a symlink to a large or self-referential tree.
      let stat
      try { stat = await lstat(full) } catch { continue }
      if (stat.isSymbolicLink()) continue
      yield* _walkJsonl(full, _counter)
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      _counter.n++
      yield full
    }
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
      if (EXCLUDE_TOOLING.test(rel)) continue // skip claude-mem observer & other background tooling
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

  // Auto-detect background tooling we excluded → report it (the MCP "asks" by telling).
  let excludedTooling = []
  try {
    const top = await readdir(r, { withFileTypes: true })
    excludedTooling = top.filter((d) => d.isDirectory() && EXCLUDE_TOOLING.test(d.name)).map((d) => d.name)
  } catch { /* ignore */ }

  return {
    platform: adapter.platform,
    root: r,
    generatedAt: new Date(nowMs).toISOString(),
    files: files.size,
    totalMessages: msgs.length,
    excludedTooling,
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
        // Apply the same background-tooling exclusion as the Claude adapter — skips
        // memory plugins / observers running under the Codex account.
        if (EXCLUDE_TOOLING.test(rel)) continue
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

/**
 * Unified pull for ANY platform by name. Routes to the right adapter:
 *   - 'claude' → tokenpull()
 *   - 'codex'  → tokenpullCodex()  (requires ioRatio via opts; auto-derives from Claude if available)
 *   - other    → tokenpull() with the adapter from ADAPTERS registry
 *
 * Returns the same shape as tokenpull() with an added `estimated` flag when the
 * adapter cannot provide full cacheCreate data, and a `dataGap` string when the
 * source's log format doesn't expose token counts at all.
 */
export async function tokenpullAny(platform, opts = {}) {
  if (!platform || platform === 'claude') return tokenpull({ adapter: claudeAdapter, ...opts })
  if (platform === 'codex') {
    // Auto-derive io_ratio from the operator's Claude data when not explicitly provided.
    let ioRatio = opts.ioRatio || 2.0
    if (!opts.ioRatio) {
      try {
        const c = await tokenpull({ adapter: claudeAdapter })
        const all = c.windows.find((w) => w.window === 'all')
        if (all && all.pillars.output > 0) ioRatio = all.pillars.input / all.pillars.output
      } catch { /* no Claude data → Alpha 2.0 */ }
    }
    return tokenpullCodex({ ioRatio, ...opts })
  }
  const adapter = ADAPTERS[platform]
  if (!adapter) throw new Error(`Unknown platform "${platform}". Valid platforms: claude, codex, ${Object.keys(ADAPTERS).join(', ')}`)
  const result = await tokenpull({ adapter, ...opts })
  // Surface adapter-level flags
  if (adapter.estimated) result.estimated = true
  if (adapter.dataGap)   result.dataGap   = adapter.dataGap
  if (adapter.setupNote) result.setupNote = adapter.setupNote
  return result
}
