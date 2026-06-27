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
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { ADAPTERS } from './adapters.mjs'

const DAY_MS = 86_400_000

// Resolve the package root for finding bundled binaries (ccusage, tokscale, etc.)
const _pkgRoot = join(dirname(fileURLToPath(import.meta.url)))
const _localBin = join(_pkgRoot, 'node_modules', '.bin')
// Prepend local node_modules/.bin to PATH so bundled deps are found even when
// not globally installed (e.g., npx sigrank, local dev).
const _envPath = `${_localBin}${process.env.PATH ? ':' + process.env.PATH : ''}`

// ASYNC FIX (2026-06-27): execFile wrapped in a Promise — replaces execSync in the
// fresh verifier readers. execSync blocks the entire Node event loop (no key handling,
// no screen repaint for up to 90s during the tokendash scan). execFile is async: the
// event loop keeps running, so the TUI stays responsive while external commands run.
// Returns stdout as a string. Rejects on error or timeout (caller catches → null).
// BIN FIX (2026-06-27): PATH includes local node_modules/.bin so bundled deps
// (ccusage, tokscale) are found even when sigrank isn't globally installed.
function execFileAsync(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 10 * 1024 * 1024, env: { ...process.env, PATH: _envPath } }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout.toString())
    })
  })
}

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
  // Cloud agents (Devin, etc.) run server-side — no local JSONL to read
  const CLOUD_AGENTS = { devin: 'Cognition/Devin', }
  if (platform in CLOUD_AGENTS) {
    throw new Error(
      `"${platform}" (${CLOUD_AGENTS[platform]}) runs in the cloud — sessions are not written to local JSONL files. ` +
      `There is no local data source to read. If ${CLOUD_AGENTS[platform]} exposes a usage API in future, an adapter can be added.`
    )
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

// ── Fresh verifier pull (#9 / C1) ─────────────────────────────────────────────
// The owner-requested FRESH pull of the three external verifier sources. Unlike the
// stale snapshot readers (a 3-day-old token-dashboard.db, a static tokscale_report.json),
// these RUN the source tool on every call so the numbers are live. Token-only: each tool
// reports usage counts, never transcript content. Every external call is wrapped so a
// missing binary / parse error / timeout returns null and NEVER throws — a verifier the
// machine doesn't have simply doesn't appear.
//
// Returns { ccusage, tokscale, tokendash } where each value is either null or an object
// keyed by window: { '7d':{...}, '30d':{...}, '90d':{...}, all:{...} } (windows that can't
// be derived from a source are omitted; 'all' is present whenever the source has data).

// ccusage: run `ccusage <platform> daily --json` and bucket the daily rows into the four
// windows by date. Logic copied from tools.mjs `_ccusagePillars` (do NOT import private fns).
//
// ASYNC FIX (2026-06-27): was execSync (blocked the entire event loop for up to 15s,
// freezing the TUI locked frame + key handling). Now uses execFile (async) so the
// event loop keeps running — the TUI stays responsive while the external command runs.
async function _freshCcusage(platform = 'claude') {
  try {
    const raw = await execFileAsync('ccusage', [platform, 'daily', '--json'], 15000)
    const rows = JSON.parse(raw)?.daily ?? JSON.parse(raw)
    if (!Array.isArray(rows)) return null
    const now = Date.now()
    const result = {}
    for (const [win, days] of Object.entries({ '7d': 7, '30d': 30, '90d': 90 })) {
      const since = new Date(now - days * DAY_MS)
      let i = 0, o = 0, cw = 0, cr = 0
      for (const r of rows) {
        if (new Date(r.date ?? r.day ?? '1970') >= since) {
          i  += r.inputTokens         ?? r.input_tokens         ?? 0
          o  += r.outputTokens        ?? r.output_tokens        ?? 0
          cw += r.cacheCreationTokens ?? r.cache_create_tokens  ?? 0
          cr += r.cacheReadTokens     ?? r.cache_read_tokens    ?? 0
        }
      }
      result[win] = { input: i, output: o, cacheCreate: cw, cacheRead: cr }
    }
    let i = 0, o = 0, cw = 0, cr = 0
    for (const r of rows) {
      i += r.inputTokens ?? 0; o += r.outputTokens ?? 0; cw += r.cacheCreationTokens ?? 0; cr += r.cacheReadTokens ?? 0
    }
    result['all'] = { input: i, output: o, cacheCreate: cw, cacheRead: cr }
    return result
  } catch { return null }
}

// tokendash: REFRESH ~/.claude/token-dashboard.db by running the dashboard's scan, then read
// the live db via sqlite3. Claude only (the db only holds Claude Code sessions). The scan is
// best-effort: if it fails (tool missing, slow), we still read whatever the db currently has.
//
// ASYNC FIX (2026-06-27): was execSync with a 90s timeout — that blocked the ENTIRE event
// loop for up to 90 seconds, freezing the TUI completely (no key handling, no frame repaint).
// Now uses execFile (async) so the TUI stays responsive during the scan.
async function _freshTokendash(platform = 'claude') {
  if (platform !== 'claude') return null
  const dbPath = join(homedir(), '.claude', 'token-dashboard.db')
  // Read the token-dashboard DB directly with sqlite3 (no external python scan
  // needed — the DB is created by the tokendash dashboard, now bundled as a dep).
  // all-time only; the db doesn't expose windowing here.
  if (!existsSync(dbPath)) return null
  try {
    const raw = await execFileAsync('sqlite3', [dbPath,
      'SELECT SUM(input_tokens),SUM(output_tokens),SUM(cache_create_5m_tokens)+SUM(cache_create_1h_tokens),SUM(cache_read_tokens) FROM messages'
    ], 5000)
    const [i, o, cw, cr] = raw.trim().split('|').map(Number)
    if (![i, o, cw, cr].some((n) => Number.isFinite(n) && n > 0)) return null
    return { all: { input: i || 0, output: o || 0, cacheCreate: cw || 0, cacheRead: cr || 0 } }
  } catch { return null }
}

// tokscale: run `tokscale models --json` (bundled as npm dep — no bunx needed)
// and sum the per-(client,model) rows for the requested platform. The JSON shape
// (verified live) is:
//   { entries: [ { client, model, input, output, cacheRead, cacheWrite, ... }, ... ], ... }
// `client` maps directly to our platform name. Synthetic/unknown model rows are dropped (they
// carry no real usage). all-time only — tokscale's models view is not windowed. If no row
// matches the platform, return null gracefully.
//
// ASYNC FIX (2026-06-27): was execSync with a 60s timeout — blocked the event loop entirely.
// Now uses execFile (async) so the TUI stays responsive.
async function _freshTokscale(platform = 'claude') {
  try {
    const raw = await execFileAsync('tokscale', ['models', '--json'], 60000)
    const data = JSON.parse(raw)
    const entries = Array.isArray(data?.entries) ? data.entries : (Array.isArray(data) ? data : [])
    const rows = entries.filter((e) =>
      e && e.client === platform && e.model !== '<synthetic>' && e.model !== 'unknown' &&
      ((Number(e.input) || 0) > 0 || (Number(e.output) || 0) > 0),
    )
    if (!rows.length) return null
    const acc = rows.reduce((a, e) => ({
      input:       a.input       + (Number(e.input)      || 0),
      output:      a.output      + (Number(e.output)     || 0),
      cacheCreate: a.cacheCreate + (Number(e.cacheWrite) || 0),
      cacheRead:   a.cacheRead   + (Number(e.cacheRead)  || 0),
    }), { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 })
    return { all: acc }
  } catch { return null }
}

/**
 * Fresh-pull all three external verifier sources for a platform. Each is run live (no stale
 * snapshot) and returned as { window → {input,output,cacheCreate,cacheRead} } or null when the
 * source is unavailable / has no data for the platform. Never throws — a failing source is null.
 *
 *   - ccusage  : `ccusage <platform> daily --json`              → 7d/30d/90d/all
 *   - tokendash: refresh + read ~/.claude/token-dashboard.db    → all (claude only)
 *   - tokscale : `bunx tokscale@latest models --json`           → all
 */
export async function freshVerifierPillars(platform = 'claude') {
  const p = platform || 'claude'
  // Each call is internally try/catch → null; await Promise.all of resolved values keeps the
  // helper async (per the contract) without any individual failure rejecting the batch.
  const [ccusage, tokendash, tokscale] = await Promise.all([
    Promise.resolve().then(() => _freshCcusage(p)).catch(() => null),
    Promise.resolve().then(() => _freshTokendash(p)).catch(() => null),
    Promise.resolve().then(() => _freshTokscale(p)).catch(() => null),
  ])
  return { ccusage, tokscale, tokendash }
}
