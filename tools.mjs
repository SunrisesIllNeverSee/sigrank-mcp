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
import { createHash } from 'node:crypto'

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
      return pullCodex({ ioRatio, adapter: opts.adapter })
    }
    return pullLocal({ adapter: opts.adapter })
  }
  return tokenpullAny(platform || 'claude', opts)
}

export const DEFAULT_API_BASE = process.env.SIGRANK_API_BASE || 'https://signalaf.com'
/** Default network timeout in ms (override via opts.fetchTimeout or SIGRANK_FETCH_TIMEOUT). */
export const DEFAULT_FETCH_TIMEOUT = Number(process.env.SIGRANK_FETCH_TIMEOUT) || 10_000

export const TOOLS = [
  {
    name: 'rank_paste',
    description:
      'Rank a paste of ccusage-style token counts. Accepts JSON {input,output,cacheCreate,cacheRead} or 4 whitespace-separated numbers in that order. Returns Υ Yield, SNR, Leverage, Velocity, 10xDEV, class, AND a deterministic prose "card". Token-only; computes locally.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'ccusage JSON or "input output cacheCreate cacheRead"' } }, required: ['text'] },
  },
  {
    name: 'get_leaderboard',
    description: 'The live public SigRank board (signalaf.com) — operators ranked by yield.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_operator',
    description: "One operator's live profile by codename.",
    inputSchema: { type: 'object', properties: { codename: { type: 'string' } }, required: ['codename'] },
  },
  {
    name: 'submit_paste',
    description:
      'Rank a paste AND publish it to the live SigRank board in one call. Computes the cascade locally (instant preview + card), then submits the RAW paste to the board\'s web-paste endpoint, which re-parses and re-scores it server-side (authoritative). A codename is required to publish; omit it for a local preview only. Token-only, no auth (matches the web paste path). Best with a ccusage JSON paste — the 4-number form ranks locally but the board may reject it.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'ccusage JSON or "input output cacheCreate cacheRead"' },
        codename: { type: 'string', description: 'operator codename to publish under (required to submit; omit for local preview only)' },
      },
      required: ['text'],
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
      "Pull your LOCAL usage (tokenpull) AND publish it to the SigRank board in one call — the zero-paste flow. Submits the canonical 4 pillars per window, each re-scored server-side and tagged with the source platform. Requires a codename to publish; omit for local preview. Token-only.",
    inputSchema: {
      type: 'object',
      properties: {
        codename: { type: 'string', description: 'operator codename to publish under (omit for preview-only)' },
        window:   { type: 'string', enum: ['7d', '30d', '90d', 'all'], description: 'submit only this window (default: all 4)' },
        platform: { type: 'string', enum: ALL_PLATFORMS, description: `source platform (default: claude). Supported: ${ALL_PLATFORMS.join(', ')}` },
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
    },
  },
  {
    name: 'watch_tokenpull',
    description:
      'Watch your local token logs and re-derive your cascade whenever new sessions are written — a live tune meter. Polls at a configurable interval (default 60s), diffs against the last snapshot, and returns the updated cascade when something changes. The push-to-board step is TODO(AUTH.WIRE) — currently returns the diff locally so you can see your score move in real time without submitting.',
    inputSchema: {
      type: 'object',
      properties: {
        platform:    { type: 'string', enum: ALL_PLATFORMS, description: 'platform to watch (default: claude)' },
        interval_s:  { type: 'number', description: 'poll interval in seconds (default: 60, min: 10)' },
        window:      { type: 'string', enum: ['7d', '30d', '90d', 'all'], description: 'which window to watch (default: 7d — most sensitive to recent activity)' },
        codename:    { type: 'string', description: 'TODO(AUTH.WIRE): when set, will auto-submit on change once auth is live' },
      },
    },
  },
]

// tokenpull window key → the board's window_type enum.
const WINDOW_TYPE = { '7d': '7d', '30d': '30d', '90d': '90d', all: 'all_time' }

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
    const pillars = parsePillars(args.text)
    const c = withParseWarnings(pillars, cascade(pillars))
    return { ...c, card: narrate(c) }
  }
  if (name === 'get_leaderboard') return fetchJson('/api/v1/leaderboard')
  if (name === 'get_operator') {
    const codename = String(args?.codename || '').trim()
    if (!codename) throw new Error('get_operator requires a non-empty `codename` argument.')
    return fetchJson(`/api/v1/operators/${encodeURIComponent(codename)}`)
  }

  if (name === 'submit_paste') {
    if (!args?.text) throw new Error('submit_paste requires a non-empty `text` argument.')
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
    return { ...c, card, submission: { ...stamp, httpStatus: res.status, ...ack } }
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
      out.push({ window: w.window, pillars: w.pillars, cascade: c, card, submission: { ...stamp, httpStatus: res.status, ...ack } })
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
    // TODO(AUTH.WIRE): when codename is supplied and auth is live, auto-submit the
    // updated snapshot to the board on every detected change. For now, returns the
    // local cascade only.
    const platform = args?.platform || 'claude'
    const watchWindow = args?.window || '7d'
    const intervalS = Math.max(10, Number(args?.interval_s) || 60)

    const pulled = await pullByPlatform(platform, opts)
    const win = pulled.windows.find((w) => w.window === watchWindow)
    if (!win) throw new Error(`watch_tokenpull: window '${watchWindow}' not found in pull result.`)

    const c = cascade(win.pillars)
    const card = narrate(c, `${watchWindow} ${platform}`)

    // TODO(AUTH.WIRE): if args?.codename, submit to board here once auth + device
    // enrollment are live (SECURE_INGEST.md Phase 4).
    return {
      platform: pulled.platform,
      window: watchWindow,
      pillars: win.pillars,
      messages: win.messages,
      cascade: c,
      card,
      generatedAt: pulled.generatedAt,
      poll_interval_s: intervalS,
      auth_submit: args?.codename
        ? { status: 'TODO(AUTH.WIRE)', codename: args.codename, detail: 'Auto-submit on change will activate once device enrollment is live (SECURE_INGEST.md).' }
        : null,
      note: 'One snapshot per call — re-call at your poll interval to detect changes.',
    }
  }

  throw new Error(`Unknown tool: ${name}`)
}
