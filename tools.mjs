/**
 * tools.mjs — the SigRank MCP tool table + dispatcher, transport-free so it can be
 * unit-tested without spawning the stdio server (index.mjs imports from here).
 *
 * callTool() takes an opts bag with an injectable { apiBase, fetchImpl } so tests can
 * exercise the read/write network paths against a fake fetch — no live calls, no
 * writes to production. Pure cascade math lives in ./cascade.mjs; the deterministic
 * narration card in ./narrate.mjs. Token-only, no transcript content.
 */

import { cascade, parsePillars } from './cascade.mjs'
import { narrate } from './narrate.mjs'
import { tokenpull as pullLocal, tokenpullCodex as pullCodex, tokenpullAny } from './tokenpull.mjs'
import { ALL_PLATFORMS } from './adapters.mjs'
import { ensureIdentity, recordEnrollment } from './keystore.mjs'
import { submitSignedWindow } from './submit.mjs'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve local node_modules/.bin for bundled deps (ccusage, tokscale)
const _pkgRoot = path.dirname(fileURLToPath(import.meta.url))
const _localBin = path.join(_pkgRoot, 'node_modules', '.bin')
const _envPath = `${_localBin}${process.env.PATH ? ':' + process.env.PATH : ''}`

// ASYNC FIX (2026-06-27): execFile wrapped in a Promise — replaces execSync for
// defense-in-depth (shell injection prevention + non-blocking). The platform param
// is enum-validated at the MCP schema level, but execFile also prevents shell
// interpolation attacks by passing args as an array (no shell parsing).
// BIN FIX (2026-06-27): PATH includes local node_modules/.bin so bundled deps
// are found even when sigrank isn't globally installed.
function execFileAsync(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    // NOTE: execFile does not accept a `stdio` option (it always pipes + buffers
    // stdout/stderr against maxBuffer) — a previous `stdio` key here was silently ignored.
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, PATH: _envPath } }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout.toString())
    })
  })
}

// ── Verifier readers (sync, on-device, token-only) ────────────────────────────
// These mirror the implementations in cli.mjs / tui.mjs without the circular import.
//
// NOTE (P3 2026-06-27): Intentionally separate from tokenpull.mjs `freshVerifierPillars()`.
// The MCP `tokenpull_compare` tool uses these file-based/cached readers (tokscale_report.json,
// direct db read) for a quick comparison, while freshVerifierPillars runs all sources live
// (bunx tokscale, scan+read tokendash) for the TUI/CLI dashboard. Different data sources =
// different behavior; do NOT merge without understanding the trade-off.

async function _ccusagePillars(platform = 'claude') {
  try {
    const raw = await execFileAsync('ccusage', [platform, 'daily', '--json'], 15000)
    const rows = JSON.parse(raw)?.daily ?? JSON.parse(raw)
    const now = Date.now()
    const result = {}
    for (const [win, days] of Object.entries({ '7d': 7, '30d': 30, '90d': 90 })) {
      const since = new Date(now - days * 86400000)
      let i=0,o=0,cw=0,cr=0
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
    let i=0,o=0,cw=0,cr=0
    for (const r of rows) {
      i  += r.inputTokens         ?? r.input_tokens         ?? 0
      o  += r.outputTokens        ?? r.output_tokens        ?? 0
      cw += r.cacheCreationTokens ?? r.cache_create_tokens  ?? 0
      cr += r.cacheReadTokens     ?? r.cache_read_tokens    ?? 0
    }
    result['all'] = { input: i, output: o, cacheCreate: cw, cacheRead: cr }
    return result
  } catch { return null }
}

async function _tokenDashPillars() {
  const dbPath = path.join(os.homedir(), '.claude', 'token-dashboard.db')
  if (!existsSync(dbPath)) return null
  try {
    const raw = await execFileAsync('sqlite3', [dbPath,
      'SELECT SUM(input_tokens),SUM(output_tokens),SUM(cache_create_5m_tokens)+SUM(cache_create_1h_tokens),SUM(cache_read_tokens) FROM messages'
    ], 5000)
    const [i,o,cw,cr] = raw.trim().split('|').map(Number)
    return { all: { input: i||0, output: o||0, cacheCreate: cw||0, cacheRead: cr||0 } }
  } catch { return null }
}

async function _tokscalePillars(platform = 'claude') {
  // Try the bundled tokscale CLI first (fresh data), fall back to saved report file.
  try {
    const raw = await execFileAsync('tokscale', ['models', '--json'], 60000)
    const data = JSON.parse(raw)
    const entries = Array.isArray(data?.entries) ? data.entries : (Array.isArray(data) ? data : [])
    const rows = entries.filter(e =>
      e && e.client === platform && e.model !== '<synthetic>' && e.model !== 'unknown' && ((Number(e.input) || 0) > 0 || (Number(e.output) || 0) > 0)
    )
    if (rows.length) {
      const acc = rows.reduce((a,e) => ({
        input: a.input+(Number(e.input)||0), output: a.output+(Number(e.output)||0),
        cacheCreate: a.cacheCreate+(Number(e.cacheWrite)||0), cacheRead: a.cacheRead+(Number(e.cacheRead)||0),
      }), { input:0, output:0, cacheCreate:0, cacheRead:0 })
      return { all: acc }
    }
  } catch { /* fall through to file-based read */ }
  // Fallback: read saved tokscale_report.json if it exists
  const p = path.join(os.homedir(), 'tokscale_report.json')
  if (!existsSync(p)) return null
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'))
    const rows = (data.entries ?? []).filter(e =>
      e.client === platform && e.model !== '<synthetic>' && e.model !== 'unknown' && (e.input > 0 || e.output > 0)
    )
    if (!rows.length) return null
    const acc = rows.reduce((a,e) => ({
      input: a.input+(e.input??0), output: a.output+(e.output??0),
      cacheCreate: a.cacheCreate+(e.cacheWrite??0), cacheRead: a.cacheRead+(e.cacheRead??0),
    }), { input:0, output:0, cacheCreate:0, cacheRead:0 })
    return { all: acc }
  } catch { return null }
}

// Every board upload from the MCP is hashed + timestamped (ddmmyy) — provenance + dedup.
function uploadStamp(content) {
  const hash = createHash('sha256').update(JSON.stringify(content)).digest('hex')
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const ddmmyy = p(d.getUTCDate()) + p(d.getUTCMonth() + 1) + String(d.getUTCFullYear()).slice(-2)
  return { content_hash: hash, submitted_ddmmyy: ddmmyy, submitted_at: d.toISOString() }
}

// Pull a platform's local usage → 4 windows of canonical pillars. Routes through
// tokenpullAny() which handles Claude (native), Codex (estimated io_ratio), and all
// other adapters from the registry. opts.adapter overrides for tests.
async function pullByPlatform(platform, opts = {}) {
  if (opts.adapter) {
    // Test injection: bypass registry and use the mock adapter directly
    if (platform === 'codex') {
      let ioRatio = 2.0
      try {
        const c = await pullLocal({})
        const all = c.windows.find((w) => w.window === 'all')
        if (all && all.pillars.output > 0) ioRatio = all.pillars.input / all.pillars.output
      } catch { /* no Claude data → Alpha 2.0 */ }
      return pullCodex({ ioRatio, adapter: opts.adapter, now: opts.now })
    }
    return pullLocal({ adapter: opts.adapter, now: opts.now })
  }
  return tokenpullAny(platform || 'claude', opts)
}

export const DEFAULT_API_BASE = process.env.SIGRANK_API_BASE || 'https://signalaf.com'
/** Default network timeout in ms (override via opts.fetchTimeout or SIGRANK_FETCH_TIMEOUT). */
export const DEFAULT_FETCH_TIMEOUT = Number(process.env.SIGRANK_FETCH_TIMEOUT) || 10_000
/** Max accepted length for a single paste/string arg (chars). Token counts are tiny; anything
 *  past this is malformed or abusive — reject cleanly before parsing/POSTing (E2 hardening). */
const MAX_INPUT = 1_000_000

export const TOOLS = [
  {
    name: 'rank_paste',
    description:
      'Computes the SigRank yield cascade from a paste of token counts. Parses the input, runs the full cascade math locally (no network calls), and returns: Υ Yield (the headline efficiency metric, Υ = Cache Reads × Output / Input²), SNR (signal-to-noise ratio), Leverage ratio (Cr/I = cache reads divided by input), Velocity (O/I = output divided by input), 10xDEV score, operator class tier (Burner / Builder / 10xer), and a deterministic prose "card" summarizing the result in plain English. Accepts two input formats: (1) JSON object {"input":N,"output":N,"cacheCreate":N,"cacheRead":N} or (2) four whitespace-separated numbers in order: input output cacheCreate cacheRead. Returns an error if the input is malformed or has negative values. Use this for a quick one-off ranking without submitting to the board. Do NOT use this to submit your score — use submit_paste instead, which both ranks and publishes. Do NOT use this if you want to rank all four time windows at once — use rank_windows for that. After calling this, use submit_paste to publish the result if you want to appear on the leaderboard.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Token counts to rank. Two formats accepted: (1) JSON object {"input":N,"output":N,"cacheCreate":N,"cacheRead":N} where all values are non-negative integers, or (2) four whitespace-separated numbers in order: input output cacheCreate cacheRead. Get these from `ccusage` output, the Claude Max usage dashboard, tokscale, or any token reader. Example valid input: {"input":1000000,"output":500000,"cacheCreate":50000,"cacheRead":800000}',
        },
      },
      required: ['text'],
      description: 'Requires the token counts as a string. No other parameters are accepted.',
    },
  },
  {
    name: 'get_leaderboard',
    description:
      "Fetches the live public SigRank leaderboard from signalaf.com. Reads all ranked operators sorted by yield (Υ = Cache Reads × Output / Input²) and returns an array of operator summaries. Each entry contains: codename (public display name), yield (Υ, the headline efficiency metric), leverage ratio (Cr/I = cache reads divided by input), velocity (O/I = output divided by input), class tier (Burner / Builder / 10xer), and rank position (integer, 1-based). Returns an empty array if no operators have submitted yet. Use this to see where operators stand overall, to find specific codenames for get_operator lookups, or to display the current rankings. Do NOT use this to check your own rank if you already know your codename — use get_operator instead for a single-operator profile with per-window breakdowns. After calling this, follow up with get_operator to get detailed metrics for any operator of interest.",
    inputSchema: {
      type: 'object',
      properties: {},
      description: 'This tool takes no parameters. It always fetches the full public leaderboard.',
    },
  },
  {
    name: 'get_operator',
    description:
      "Fetches one operator's live profile from the SigRank board by their codename. Reads the operator's current submission data from signalaf.com and returns their detailed metrics: yield (Υ), leverage ratio (Cr/I), velocity (O/I), class tier (Burner / Builder / 10xer), rank position (integer, 1-based), and per-window breakdowns for each time range (7d, 30d, 90d, all-time) with the four canonical pillars (input, output, cacheCreate, cacheRead) per window. Returns an error if the codename is not found on the board. Use this to look up any operator who has submitted to the board — codenames are public and visible on the leaderboard. Do NOT use this to browse all operators — use get_leaderboard for that. After calling this, you can use simulate_change to model what would happen if the operator adjusted their token mix.",
    inputSchema: {
      type: 'object',
      properties: {
        codename: {
          type: 'string',
          description: 'The operator\'s public codename as shown on the SigRank leaderboard. Case-insensitive — "Ghost Falcon" and "ghost falcon" are equivalent. Must match a codename that exists on the board; returns an error if not found. To discover valid codenames, call get_leaderboard first.',
        },
      },
      required: ['codename'],
      description: 'Requires the operator\'s codename. No other parameters are accepted.',
    },
  },
  {
    name: 'submit_paste',
    description:
      'Ranks a paste of token counts AND publishes it to the live SigRank board at signalaf.com in one call. First computes the cascade locally for an instant preview (yield, leverage, velocity, class, card), then submits the raw paste to the board\'s web-paste endpoint, which re-parses and re-scores it server-side. The server score is authoritative — it may differ from the local preview if the board applies additional validation. Returns both the local preview and the server response (including the operator\'s new rank if accepted). A codename is required to publish — omit it for a local preview only (no board submission). Token-only, no auth required. Use this when you have token counts from ccusage or a dashboard and want to both see your score and publish it. Do NOT use this if you want to pull your local usage automatically — use tokenpull_submit for the zero-paste flow. Do NOT use this for multi-window dashboard pastes — use rank_windows to rank them first, then submit each window. After calling this, use get_operator with your codename to verify your submission appeared on the board.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Token counts to rank and submit. Two formats: (1) JSON {"input":N,"output":N,"cacheCreate":N,"cacheRead":N} from ccusage (preferred — the board parses this reliably), or (2) four whitespace-separated numbers: input output cacheCreate cacheRead. The 4-number form ranks locally but the board may reject it. Example: {"input":1000000,"output":500000,"cacheCreate":50000,"cacheRead":800000}',
        },
        codename: {
          type: 'string',
          description: 'Operator codename to publish under on the leaderboard (e.g. "Ghost Falcon"). Required to submit — omit for local preview only (no board submission, just returns the local cascade result). Must be a non-empty string.',
        },
      },
      required: ['text'],
      description: 'Requires token counts (text). Codename is optional but required for board submission — omit it for preview-only mode.',
    },
  },
  {
    name: 'tokenpull',
    description:
      "Pull your LOCAL token usage from the platform's session logs and rank it across the four windows (7d/30d/90d/all-time) with the cascade — zero paste. Token-only: reads usage counts not message content. The numbers stay on your machine unless you submit them. Some platforms may have partial data (estimated=true when cacheCreate isn't available) or a dataGap note when the log format doesn't expose raw token counts.",
    inputSchema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          enum: ALL_PLATFORMS,
          description: `source platform (default: claude). Supported: ${ALL_PLATFORMS.join(', ')}. codex is estimated via io_ratio. Some platforms need setup (e.g. copilot requires COPILOT_OTEL_ENABLED=true).`,
        },
      },
    },
  },
  {
    name: 'tokenpull_submit',
    description:
      "Pull your LOCAL token usage from session logs AND publish it to the SigRank board in one call — the zero-paste flow. Reads the four canonical pillars (input, output, cacheCreate, cacheRead) per window from your local logs, computes the cascade, and submits each window to the board where it is re-scored server-side and tagged with the source platform. Requires a codename to publish; omit for a local preview only. Token-only — no prompt content is read or transmitted.",
    inputSchema: {
      type: 'object',
      properties: {
        codename: {
          type: 'string',
          description: 'Operator codename to publish under on the leaderboard (e.g. "Iron Lotus"). Required to submit — omit for local preview only.',
        },
        window: {
          type: 'string',
          enum: ['7d', '30d', '90d', 'all'],
          description: 'Submit only this time window (default: all 4 windows). Use "7d" for recent activity or "all" for all-time ranking.',
        },
        platform: {
          type: 'string',
          enum: ALL_PLATFORMS,
          description: `Source platform to pull from (default: claude). Supported: ${ALL_PLATFORMS.join(', ')}. Each platform reads its own session logs locally.`,
        },
      },
    },
  },
  {
    name: 'rank_windows',
    description:
      'Rank all four time windows (7d/30d/90d/all-time) in one call from a dashboard paste — paste the full table from ccusage, tokscale, or the Claude Max usage dashboard and get the cascade (Υ, SNR, Leverage, Velocity, 10xDEV, class, card) for each window. Each window is parsed and scored independently. Named keys required (input/output/cacheCreate/cacheRead); positional order is NOT safe here (dashboards list cache_read before cache_create — see WINDOWED_PROFILES gotcha). Omit windows you don\'t have — partial input is allowed (1–4 windows). Does NOT submit to the board; use tokenpull_submit for zero-paste publishing.',
    inputSchema: {
      type: 'object',
      properties: {
        '7d':  { type: 'string', description: 'ccusage/tokscale paste or JSON for the 7-day window (optional)' },
        '30d': { type: 'string', description: 'ccusage/tokscale paste or JSON for the 30-day window (optional)' },
        '90d': { type: 'string', description: 'ccusage/tokscale paste or JSON for the 90-day window (optional)' },
        all:   { type: 'string', description: 'ccusage/tokscale paste or JSON for the all-time window (optional)' },
        source_tool: { type: 'string', enum: ['ccusage', 'tokscale', 'claude_max', 'token_dashboard', 'other'], description: 'which token reader produced the paste (for cross-tool variance tracking)' },
      },
      // at least one window paste is required (runtime check backs this up)
      anyOf: [{ required: ['7d'] }, { required: ['30d'] }, { required: ['90d'] }, { required: ['all'] }],
    },
  },
  {
    name: 'watch_tokenpull',
    description:
      'One poll per call: pulls your local token logs and returns the current cascade for the watched window — the tool never blocks or loops. Re-call at your desired cadence to watch for changes (interval_s is advisory only and echoed back as poll_interval_s). With submit:true (and an enrolled device) each call may also sign + publish the watched window to the board, rate-limited to once per 5 min per platform+window; default is preview-only (no submit).',
    inputSchema: {
      type: 'object',
      properties: {
        platform:    { type: 'string', enum: ALL_PLATFORMS, description: 'platform to watch (default: claude)' },
        interval_s:  { type: 'number', description: 'advisory poll cadence in seconds (default: 60, min: 10) — echoed back as poll_interval_s; does not make the call block or loop' },
        window:      { type: 'string', enum: ['7d', '30d', '90d', 'all'], description: 'which window to watch (default: 7d — most sensitive to recent activity)' },
        submit:      { type: 'boolean', description: 'auto-submit the watched window to the board as a VERIFIED operator each poll (requires `enroll`; default false = preview only)' },
      },
    },
  },
  {
    name: 'tokenpull_compare',
    description:
      'Pull token usage from ALL four local sources in parallel — tokenpull (JSONL canon), ccusage CLI, token-dashboard SQLite, and tokscale report — and return them side-by-side with delta % vs tokenpull as the baseline. Also computes the cascade (Υ, SNR, Leverage, class) for each source so you can see how each verifier scores. Useful for validating your numbers before submitting, or understanding discrepancies between tools. Claude only for token-dash; codex and others use tokenpull + ccusage + tokscale. Token-only, on-device.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          enum: ALL_PLATFORMS,
          description: 'platform to compare (default: claude). token-dash and App only available for claude.',
        },
      },
    },
  },
  {
    name: 'enroll',
    description:
      'Bind THIS device to your SigRank operator so your signed token runs cascade to the live board. Paste the key from signalaf.com → Settings → "New key" (or "Generate connect code"). On first run it generates + stores a local ed25519 keypair (~/.sigrank-mcp/identity.json); only the PUBLIC key is ever sent. Need a new key? Click "New key" at signalaf.com → Settings, then paste it here.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'the key / connect code (SIGR-XXXXX-XXXXX-XXXXX) from Settings → New key (or Generate connect code)' },
        device_label: { type: 'string', description: 'optional label for this device (default: hostname · agent version)' },
      },
      required: ['code'],
    },
  },
  {
    name: 'submit_verified',
    description:
      'Publish your LOCAL token runs to the SigRank board as a VERIFIED operator — the enrolled, signed path. Reads your pillars (tokenpull), builds the canonical Schema 1.0 snapshot per window, ed25519-signs it with your device key, and POSTs to /api/v1/snapshots. Requires `npx sigrank-mcp enroll` first (a bound device). Only signed submissions from a trusted device rank on the board. Token-only; the private key never leaves your machine. Pass dry_run:true to inspect the exact signed payload without publishing.',
    inputSchema: {
      type: 'object',
      properties: {
        window: { type: 'string', enum: ['7d', '30d', '90d', 'all'], description: 'submit only this window (default: all 4)' },
        platform: { type: 'string', enum: [...ALL_PLATFORMS, 'multi'], description: "source platform (default: claude). 'multi' = combined cascade summed across all locally-detected platforms (needs 2+ active); empty windows are skipped." },
        dry_run: { type: 'boolean', description: 'build + sign but do NOT publish — returns the exact payload that would be POSTed (token counts only), so you can inspect before submitting' },
      },
    },
  },
  {
    name: 'simulate_change',
    description:
      "The first PRESCRIPTIVE SigRank tool — 'what if I changed my token mix?' Takes your current 4 pillars (input/output/cacheCreate/cacheRead) and one or more proposed changes, runs the canonical cascade on BOTH the current and simulated values, and returns the exact Υ Yield delta, class change, and per-metric diffs. This is the 'show me the payoff before I do the work' primitive: no network, no submission, pure local math. Use it to answer 'would increasing my cache-read by 50k tokens actually move my class?' before you change your workflow. Accepts the current pillars as JSON or 4 numbers (same as rank_paste) plus a `changes` object with any of the 4 pillar names mapped to new absolute values OR relative deltas (e.g. {cacheRead: '+50000'} or {input: 800000}).",
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Current token pillars — ccusage JSON or "input output cacheCreate cacheRead" (same format as rank_paste).',
        },
        changes: {
          type: 'object',
          description: 'Proposed changes to apply. Keys: input, output, cacheCreate, cacheRead. Values are either absolute numbers (replace) or strings starting with +/- for relative deltas (add/subtract). Omitted pillars are unchanged.',
          properties: {
            input:       { type: ['number', 'string'], description: 'new input token count (absolute) or "+/-N" for a relative delta' },
            output:      { type: ['number', 'string'], description: 'new output token count (absolute) or "+/-N" for a relative delta' },
            cacheCreate: { type: ['number', 'string'], description: 'new cache-create token count (absolute) or "+/-N" for a relative delta' },
            cacheRead:   { type: ['number', 'string'], description: 'new cache-read token count (absolute) or "+/-N" for a relative delta' },
          },
        },
      },
      required: ['text', 'changes'],
    },
  },
]

// tokenpull window key → the board's window_type enum.
const WINDOW_TYPE = { '7d': '7d', '30d': '30d', '90d': '90d', all: 'all_time' }

// E3: client-side auto-submit cooldown for watch_tokenpull. The server already dedups
// identical snapshots (exact hash → 422), but a noisy poll loop with submit:true could still
// churn the network/board with near-identical rows. Cap auto-submit to once per WATCH_SUBMIT_COOLDOWN_MS
// per platform+window (in-memory, per process). Keyed by platform:window so different
// platforms/windows don't block each other, and only armed on a non-error submit so a
// network failure doesn't lock out retries for 5 minutes.
const WATCH_SUBMIT_COOLDOWN_MS = 5 * 60 * 1000
const _lastWatchSubmitAt = new Map()

// ── Shared active-platform loader ───────────────────────────────────────────
// THE single data path for "show my cascade across platforms" — used by `me`,
// `watch`, and the TUI Dashboard so they can't drift apart again. Pulls each
// target platform via the tokenpull tool (enriched: pillars + cascade + card),
// keeps only platforms with real local data, and sorts claude → codex → rest.
// Pass `platforms` to scope it (e.g. ['claude'] for a fast first paint).
export async function pullActivePlatforms({ platforms } = {}, opts = {}) {
  const targets = platforms && platforms.length ? platforms : ALL_PLATFORMS
  const settled = await Promise.allSettled(targets.map((p) => callTool('tokenpull', { platform: p }, opts)))
  const active = settled
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => r.value)
    .filter((d) => (d.windows || []).some((w) => ((w.pillars?.input ?? 0) + (w.pillars?.output ?? 0)) > 0))
  const rank = (p) => (p === 'claude' ? -2 : p === 'codex' ? -1 : ALL_PLATFORMS.indexOf(p))
  active.sort((a, b) => rank(a.platform) - rank(b.platform))
  return active
}

export async function callTool(name, args, opts = {}) {
  const apiBase = opts.apiBase || DEFAULT_API_BASE
  const timeoutMs = opts.fetchTimeout ?? DEFAULT_FETCH_TIMEOUT
  const rawFetch = opts.fetchImpl || fetch

  // Wrap every fetch with an AbortController timeout so a hung network call never
  // blocks the MCP client indefinitely.
  const doFetch = (url, init = {}) => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    return rawFetch(url, { ...init, signal: ac.signal }).finally(() => clearTimeout(timer))
  }

  const fetchJson = async (path) => {
    const res = await doFetch(`${apiBase}${path}`, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`SigRank API ${path} → HTTP ${res.status}`)
    return res.json()
  }

  // Helper: attach _parseWarnings from pillars onto the cascade result so they
  // are always visible in the tool output for review.
  const withParseWarnings = (pillars, cascadeResult) => {
    if (pillars._parseWarnings && pillars._parseWarnings.length > 0) {
      const existing = cascadeResult.warnings || []
      return { ...cascadeResult, warnings: [...existing, ...pillars._parseWarnings.map((w) => `parse:${w}`)] }
    }
    return cascadeResult
  }

  if (name === 'rank_paste') {
    if (!args?.text) throw new Error('rank_paste requires a non-empty `text` argument.')
    // E2: reject oversized pastes before parsing (parity with submit_paste / rank_windows).
    if (typeof args.text === 'string' && args.text.length > MAX_INPUT) {
      return { status: 'error', reason: 'input_too_large', detail: `text exceeds ${MAX_INPUT} chars (${args.text.length}). Paste only the token-count table, not full output.` }
    }
    const pillars = parsePillars(args.text)
    const c = withParseWarnings(pillars, cascade(pillars))
    return { ...c, card: narrate(c) }
  }
  if (name === 'get_leaderboard') return fetchJson('/api/v1/leaderboard?metric=yield_')
  if (name === 'get_operator') {
    const codename = String(args?.codename || '').trim()
    if (!codename) throw new Error('get_operator requires a non-empty `codename` argument.')
    return fetchJson(`/api/v1/operators/${encodeURIComponent(codename)}`)
  }

  if (name === 'enroll') {
    // Redeem a web connect code → bind this device. Generates/loads the local keypair;
    // sends ONLY the public key. operator binding happens server-side from the code row.
    const code = String(args?.code || '').trim()
    if (!code) throw new Error('enroll requires a `code` — paste your connect code from signalaf.com → Settings → Connect a device.')
    const id = opts.identity || ensureIdentity()
    const deviceLabel = String(args?.device_label || `${os.hostname()} · ${id.agent_version}`).slice(0, 120)
    const res = await doFetch(`${apiBase}/api/v1/devices/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        code,
        device_id: id.device_id,
        public_key: id.public_key,
        device_label: deviceLabel,
        agent_version: id.agent_version,
      }),
    })
    let ack
    try { ack = await res.json() } catch { ack = {} }
    if (res.status === 201 && ack.status === 'enrolled') {
      // Persist the binding locally (skipped when a test injects opts.identity → no keystore write).
      if (!opts.identity) recordEnrollment({ codename: ack.codename, operator_id: ack.operator_id })
      return {
        status: 'enrolled',
        codename: ack.codename ?? null,
        operator_id: ack.operator_id ?? null,
        device_id: id.device_id,
        trust_status: ack.trust_status ?? 'trusted',
      }
    }
    return { status: 'error', httpStatus: res.status, reason: ack.reason || ack.status || `http_${res.status}`, detail: ack.detail ?? null }
  }

  if (name === 'submit_verified') {
    // The enrolled, signed publish path → /api/v1/snapshots (only verified rows rank).
    const id = opts.identity || ensureIdentity()
    if (!id.codename || !id.operator_id) {
      return { status: 'not_enrolled', detail: 'Run `npx sigrank-mcp enroll` to bind this device first.' }
    }
    const platform = args?.platform || 'claude'

    // MULTI: the combined cross-platform cascade. The dashboard already SUMS every
    // active platform's pillars (a "claude+codex" row) but never submitted it — this
    // is that missing submission. Aggregate every locally-detected platform's pillars
    // per window and publish as platform='multi' = the operator's TOTAL usage. Empty
    // windows are skipped so a no-activity window never lands as a degenerate row.
    if (platform === 'multi') {
      const detected = []
      for (const p of ALL_PLATFORMS) {
        const r = await pullByPlatform(p, opts).catch(() => null)
        const live = r && (r.windows || []).some(
          (w) => (w.pillars.input + w.pillars.output + w.pillars.cacheCreate + w.pillars.cacheRead) > 0,
        )
        if (live) detected.push(r)
      }
      if (detected.length < 2) {
        return {
          platform: 'multi', codename: id.codename, operator_id: id.operator_id,
          status: 'skipped', reason: 'need_2_platforms',
          detail: `multi needs 2+ active platforms; found ${detected.length} (${detected.map((d) => d.platform).join(', ') || 'none'}).`,
          windows: [],
        }
      }
      const winKeys = args?.window ? [args.window] : ['7d', '30d', '90d', 'all']
      const out = []
      for (const wk of winKeys) {
        const sum = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }
        let msgs = 0
        for (const d of detected) {
          const w = (d.windows || []).find((x) => x.window === wk)
          if (!w) continue
          sum.input += w.pillars.input || 0
          sum.output += w.pillars.output || 0
          sum.cacheCreate += w.pillars.cacheCreate || 0
          sum.cacheRead += w.pillars.cacheRead || 0
          msgs += w.messages || 0
        }
        if (sum.input + sum.output + sum.cacheCreate + sum.cacheRead <= 0) continue // skip empty window
        const r = await submitSignedWindow(wk, sum, msgs, id, { apiBase, fetchImpl: doFetch, platform: 'multi', now: opts.now, dryRun: !!args?.dry_run })
        out.push({ window: wk, pillars: sum, ...r })
      }
      return { platform: 'multi', codename: id.codename, operator_id: id.operator_id, sources: detected.map((d) => d.platform), windows: out }
    }

    const pulled = await pullByPlatform(platform, opts)
    const targets = args?.window ? pulled.windows.filter((w) => w.window === args.window) : pulled.windows
    const out = []
    for (const w of targets) {
      const r = await submitSignedWindow(w.window, w.pillars, w.messages, id, {
        apiBase,
        fetchImpl: doFetch,
        platform: pulled.platform,
        now: opts.now,
        dryRun: !!args?.dry_run,
      })
      out.push({ window: w.window, pillars: w.pillars, ...r })
    }
    return { platform: pulled.platform, codename: id.codename, operator_id: id.operator_id, generatedAt: pulled.generatedAt, windows: out }
  }

  if (name === 'submit_paste') {
    if (!args?.text) throw new Error('submit_paste requires a non-empty `text` argument.')
    if (typeof args.text === 'string' && args.text.length > MAX_INPUT) {
      return { status: 'error', reason: 'input_too_large', detail: `text exceeds ${MAX_INPUT} chars (${args.text.length}). Paste only the token-count table, not full output.` }
    }
    // Local preview first — also validates the paste is parseable before any POST.
    const pillars = parsePillars(args.text)
    const c = withParseWarnings(pillars, cascade(pillars))
    const codename = String(args?.codename || '').trim()
    const card = narrate(c, codename || 'This operator')

    // No codename → cannot publish (the board endpoint requires it). Fail fast at the
    // tool boundary with a clear message instead of an opaque server 400.
    if (!codename) {
      return {
        ...c,
        card,
        submission: { status: 'not_submitted', reason: 'codename_required', detail: 'Pass a codename to publish to the board. Showing local preview only.' },
      }
    }

    // Submit the RAW paste so the server re-parses + re-scores authoritatively — the
    // MCP's local cascade is only a preview; the board stays the single source of truth.
    const stamp = uploadStamp({ codename, pillars: c.pillars, source: 'web_paste' })
    const res = await doFetch(`${apiBase}/api/v1/ingest-paste`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ codename, raw_paste: String(args?.text || ''), ...stamp }),
    })
    let ack
    try { ack = await res.json() } catch { ack = { status: 'error', detail: `HTTP ${res.status} (non-JSON response)` } }
    const ranked = !!(res.ok && ack.verification_tier === 'verified' && ack.persisted === true)
    return { ...c, card, ranked, submission: { ...stamp, httpStatus: res.status, ranked, ...ack } }
  }

  if (name === 'tokenpull') {
    // Local read → 4 windows of pillars → cascade each. Token-only, on-device.
    const platform = args?.platform || 'claude'
    const pulled = await pullByPlatform(platform, opts)
    const windows = pulled.windows.map((w) => {
      const c = cascade(w.pillars)
      return { window: w.window, messages: w.messages, pillars: w.pillars, cascade: c, card: narrate(c, `${w.window} ${platform}`) }
    })
    return { platform: pulled.platform, estimated: pulled.estimated || false, ...(pulled.ioRatio ? { ioRatio: pulled.ioRatio } : {}), generatedAt: pulled.generatedAt, files: pulled.files, totalMessages: pulled.totalMessages, windows }
  }

  if (name === 'tokenpull_submit') {
    // Pull local usage, then publish each window's CANONICAL pillars to the board
    // (server re-scores). The board stays platform-agnostic via the 4 pillars; the
    // source platform rides along as a tag. Conversion already happened in the adapter.
    const codename = String(args?.codename || '').trim()
    const pulled = await pullByPlatform(args?.platform || 'claude', opts)
    const targets = args?.window ? pulled.windows.filter((w) => w.window === args.window) : pulled.windows
    const out = []
    for (const w of targets) {
      const c = cascade(w.pillars)
      const card = narrate(c, `${w.window} window`)
      if (!codename) {
        out.push({ window: w.window, pillars: w.pillars, cascade: c, card, submission: { status: 'not_submitted', reason: 'codename_required' } })
        continue
      }
      // canonical pillars → "input output cacheCreate cacheRead" (the parser's 4-bare-number form)
      const rawPaste = `${w.pillars.input} ${w.pillars.output} ${w.pillars.cacheCreate} ${w.pillars.cacheRead}`
      const windowType = WINDOW_TYPE[w.window] || w.window
      const stamp = uploadStamp({ codename, window: windowType, pillars: w.pillars, platform: pulled.platform })
      const res = await doFetch(`${apiBase}/api/v1/ingest-paste`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ codename, raw_paste: rawPaste, window_type: windowType, telemetry: { platform: { primary: pulled.platform } }, ...stamp }),
      })
      let ack
      try { ack = await res.json() } catch { ack = { status: 'error', detail: `HTTP ${res.status} (non-JSON)` } }
      // ranked = actually on the board (verified + persisted), not just received — parity
      // with submit_verified (submit.mjs). An unenrolled/revoked device gets 202 but is NEVER ranked.
      const ranked = !!(res.ok && ack.verification_tier === 'verified' && ack.persisted === true)
      out.push({ window: w.window, pillars: w.pillars, cascade: c, card, ranked, submission: { ...stamp, httpStatus: res.status, ranked, ...ack } })
    }
    return { platform: pulled.platform, codename: codename || null, generatedAt: pulled.generatedAt, windows: out }
  }

  if (name === 'rank_windows') {
    // Score up to 4 named window pastes independently. Named-key parsing only —
    // positional is unsafe here because dashboards list cache_read before cache_create
    // (the WINDOWED_PROFILES swap gotcha). Each window goes through parsePillars →
    // cascade → narrate individually; results are collected into a windows[] array
    // in the same shape as tokenpull output for easy follow-up with tokenpull_submit.
    const WINDOW_KEYS = ['7d', '30d', '90d', 'all']
    const sourceTool = args?.source_tool || null
    // E2: reject any oversized window paste up front (token tables are tiny).
    for (const wk of WINDOW_KEYS) {
      const v = args?.[wk]
      if (typeof v === 'string' && v.length > MAX_INPUT) {
        return { status: 'error', reason: 'input_too_large', detail: `window '${wk}' exceeds ${MAX_INPUT} chars (${v.length}). Paste only the token-count table.` }
      }
    }
    const windows = []
    for (const wk of WINDOW_KEYS) {
      const text = args?.[wk]
      if (!text || typeof text !== 'string' || !text.trim()) continue
      const pillars = parsePillars(text)
      const c = withParseWarnings(pillars, cascade(pillars))
      const card = narrate(c, `${wk} window`)
      windows.push({ window: wk, pillars, cascade: c, card })
    }
    if (windows.length === 0) {
      throw new Error('rank_windows requires at least one window paste (7d, 30d, 90d, or all).')
    }
    return {
      windows,
      source_tool: sourceTool,
      note: 'Local preview only — use tokenpull_submit to publish to the board.',
    }
  }

  if (name === 'watch_tokenpull') {
    // Poll the local token logs at a configurable interval and return the cascade
    // diff whenever new sessions appear. One poll cycle per MCP call — the client
    // is responsible for re-calling at the desired cadence (MCP tools are stateless;
    // a persistent background watcher lives outside the tool boundary).
    //
    // With submit:true + an enrolled device, this also signs + POSTs the watched window
    // to the verified ingest path each poll (the server dedups identical re-submits).
    const platform = args?.platform || 'claude'
    const watchWindow = args?.window || '7d'
    const intervalS = Math.max(10, Number(args?.interval_s) || 60)

    const pulled = await pullByPlatform(platform, opts)
    const win = pulled.windows.find((w) => w.window === watchWindow)
    if (!win) throw new Error(`watch_tokenpull: window '${watchWindow}' not found in pull result.`)

    const c = cascade(win.pillars)
    const card = narrate(c, `${watchWindow} ${platform}`)

    // AUTH.WIRE (D7 §7): when submit is on AND the device is enrolled, sign + POST the
    // watched window to the verified ingest path. Default OFF = preview only. The server
    // dedups identical re-submits (exact snapshot_hash → 422), so re-calling is safe.
    let auth_submit = null
    if (args?.submit === true) {
      const id = opts.identity || ensureIdentity()
      if (id.codename && id.operator_id && id.private_key_pkcs8_b64) {
        // E3: client-side cooldown — at most one auto-submit per platform+window per 5 min.
        // Prevents a fast poll loop from churning the board even before the server's
        // hash-dedup kicks in. Armed only on a non-error outcome so failed submits retry.
        const clockNow = typeof opts.now === 'number' ? opts.now : Date.now()
        const cdKey = `${pulled.platform}:${watchWindow}`
        const last = _lastWatchSubmitAt.get(cdKey)
        if (last != null && clockNow - last < WATCH_SUBMIT_COOLDOWN_MS) {
          const waitS = Math.ceil((WATCH_SUBMIT_COOLDOWN_MS - (clockNow - last)) / 1000)
          auth_submit = { status: 'cooldown', detail: `auto-submit for '${cdKey}' on cooldown — next in ~${waitS}s (max once / 5 min).`, retry_after_s: waitS }
        } else {
          auth_submit = await submitSignedWindow(watchWindow, win.pillars, win.messages, id, {
            apiBase,
            fetchImpl: doFetch,
            platform: pulled.platform,
            now: opts.now,
          })
          if (auth_submit?.status !== 'error') _lastWatchSubmitAt.set(cdKey, clockNow)
        }
      } else {
        auth_submit = { status: 'not_enrolled', detail: 'Run `npx sigrank-mcp enroll` to auto-submit verified runs.' }
      }
    }
    return {
      platform: pulled.platform,
      window: watchWindow,
      pillars: win.pillars,
      messages: win.messages,
      cascade: c,
      card,
      generatedAt: pulled.generatedAt,
      poll_interval_s: intervalS,
      auth_submit,
      note: 'One snapshot per call — re-call at your poll interval to detect changes.',
    }
  }

  if (name === 'tokenpull_compare') {
    const platform = args?.platform || 'claude'
    const WINS = ['7d', '30d', '90d', 'all']

    // Pull all four sources in parallel (verifiers are now async via execFile)
    const [tpResult, ccPillars, tdPillars, tsPillars] = await Promise.all([
      pullByPlatform(platform, opts).catch(() => null),
      _ccusagePillars(platform).catch(() => null),
      (platform === 'claude' ? _tokenDashPillars() : Promise.resolve(null)).catch(() => null),
      _tokscalePillars(platform).catch(() => null),
    ])

    // Build tokenpull window lookup
    const tpByWin = {}
    for (const w of (tpResult?.windows ?? [])) tpByWin[w.window] = w.pillars

    // Helper: delta % vs tokenpull baseline
    const delta = (val, base) => base > 0 ? +((( val - base) / base * 100).toFixed(1)) : null

    // Build per-source per-window comparison
    const SOURCES = [
      { source: 'tokenpull',   note: 'JSONL deduped by msg id — canon source', byWin: tpByWin },
      { source: 'ccusage',     note: 'ccusage CLI — monthly only',             byWin: ccPillars ?? {} },
      { source: 'token-dash',  note: 'token-dashboard SQLite — all-time only', byWin: tdPillars ?? {} },
      { source: 'tokscale',    note: 'tokscale_report.json — all-time only',   byWin: tsPillars ?? {} },
    ]

    const comparison = {}
    for (const win of WINS) {
      const baseP = tpByWin[win]
      comparison[win] = SOURCES
        .filter(s => s.byWin[win] != null)
        .map(s => {
          const p = s.byWin[win]
          const cas = cascade(p)
          const entry = {
            source: s.source,
            note: s.note,
            pillars: p,
            cascade: { yield: cas.yield, snr: cas.snr, leverage: cas.leverage, velocity: cas.velocity, dev10x: cas.dev10x, class: cas.class },
          }
          if (s.source !== 'tokenpull' && baseP) {
            entry.delta_vs_tokenpull = {
              input:       delta(p.input,       baseP.input),
              output:      delta(p.output,      baseP.output),
              cacheCreate: delta(p.cacheCreate, baseP.cacheCreate),
              cacheRead:   delta(p.cacheRead,   baseP.cacheRead),
            }
          }
          return entry
        })
    }

    // Sources available summary
    const available = SOURCES
      .filter(s => Object.keys(s.byWin).length > 0)
      .map(s => s.source)

    return {
      platform,
      estimated: tpResult?.estimated ?? false,
      generatedAt: tpResult?.generatedAt ?? new Date().toISOString(),
      sources_available: available,
      sources_missing: SOURCES.map(s => s.source).filter(s => !available.includes(s)),
      comparison,
    }
  }

  if (name === 'simulate_change') {
    // The first prescriptive tool — "what if I changed my token mix?"
    // Pure local math: parse current pillars, apply proposed changes, run the
    // cascade on both, return the delta. No network, no submission.
    if (!args?.text) throw new Error('simulate_change requires a non-empty `text` argument (current pillars).')
    if (typeof args.text === 'string' && args.text.length > MAX_INPUT) {
      return { status: 'error', reason: 'input_too_large', detail: `text exceeds ${MAX_INPUT} chars.` }
    }
    if (!args?.changes || typeof args.changes !== 'object') {
      throw new Error('simulate_change requires a `changes` object with at least one pillar change.')
    }

    const currentPillars = parsePillars(args.text)
    const current = withParseWarnings(currentPillars, cascade(currentPillars))

    // Apply changes: each pillar is either an absolute number (replace) or a
    // string starting with +/- (relative delta). Omitted pillars are unchanged.
    const PILLAR_KEYS = ['input', 'output', 'cacheCreate', 'cacheRead']
    const simulated = { ...currentPillars }
    const appliedChanges = {}

    for (const key of PILLAR_KEYS) {
      if (args.changes[key] == null) continue
      const raw = args.changes[key]
      let newVal

      if (typeof raw === 'number') {
        newVal = raw
      } else if (typeof raw === 'string') {
        const trimmed = raw.trim()
        if (trimmed.startsWith('+') || trimmed.startsWith('-')) {
          // Relative delta: add/subtract from current value
          const delta = Number(trimmed)
          if (!Number.isFinite(delta)) {
            return { status: 'error', reason: 'invalid_change', detail: `changes.${key}: "${raw}" is not a valid relative delta.` }
          }
          newVal = currentPillars[key] + delta
        } else {
          // Absolute value as a string
          newVal = Number(trimmed)
        }
      } else {
        return { status: 'error', reason: 'invalid_change', detail: `changes.${key}: expected number or string, got ${typeof raw}.` }
      }

      if (!Number.isFinite(newVal)) {
        return { status: 'error', reason: 'invalid_change', detail: `changes.${key}: result is not a finite number.` }
      }
      // Clamp to non-negative — token counts can't be negative
      if (newVal < 0) {
        return { status: 'error', reason: 'invalid_change', detail: `changes.${key}: result ${newVal} is negative — token counts must be >= 0.` }
      }

      simulated[key] = newVal
      appliedChanges[key] = {
        from: currentPillars[key],
        to: newVal,
        delta: newVal - currentPillars[key],
      }
    }

    if (Object.keys(appliedChanges).length === 0) {
      return { status: 'error', reason: 'no_changes', detail: 'No pillar changes specified in the `changes` object.' }
    }

    const simulatedResult = cascade(simulated)

    // Compute deltas for every cascade metric
    const metricDelta = (curr, sim) => {
      if (curr == null && sim == null) return null
      if (curr == null) return { from: null, to: sim, delta: null }
      if (sim == null) return { from: curr, to: null, delta: null }
      return { from: curr, to: sim, delta: Number((sim - curr).toFixed(4)) }
    }

    const classChanged = current.class !== simulatedResult.class

    return {
      current: {
        pillars: currentPillars,
        yield: current.yield,
        snr: current.snr,
        leverage: current.leverage,
        velocity: current.velocity,
        dev10x: current.dev10x,
        class: current.class,
      },
      simulated: {
        pillars: { input: simulated.input, output: simulated.output, cacheCreate: simulated.cacheCreate, cacheRead: simulated.cacheRead },
        yield: simulatedResult.yield,
        snr: simulatedResult.snr,
        leverage: simulatedResult.leverage,
        velocity: simulatedResult.velocity,
        dev10x: simulatedResult.dev10x,
        class: simulatedResult.class,
      },
      changes: appliedChanges,
      deltas: {
        yield: metricDelta(current.yield, simulatedResult.yield),
        snr: metricDelta(current.snr, simulatedResult.snr),
        leverage: metricDelta(current.leverage, simulatedResult.leverage),
        velocity: metricDelta(current.velocity, simulatedResult.velocity),
        dev10x: metricDelta(current.dev10x, simulatedResult.dev10x),
      },
      class_changed: classChanged,
      ...(classChanged ? { class_transition: `${current.class} → ${simulatedResult.class}` } : {}),
      ...(simulatedResult.warnings ? { simulated_warnings: simulatedResult.warnings } : {}),
      note: 'Local simulation only — no submission. The actual score depends on server-side RS.xx weights and class thresholds.',
    }
  }

  throw new Error(`Unknown tool: ${name}`)
}
