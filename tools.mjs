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
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── Verifier readers (sync, on-device, token-only) ────────────────────────────
// These mirror the implementations in cli.mjs / tui.mjs without the circular import.

function _ccusagePillars(platform = 'claude') {
  try {
    const raw = execSync(`ccusage ${platform} daily --json`, { timeout: 15000, stdio: ['ignore','pipe','ignore'] }).toString()
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
      i+=r.inputTokens??0; o+=r.outputTokens??0; cw+=r.cacheCreationTokens??0; cr+=r.cacheReadTokens??0
    }
    result['all'] = { input: i, output: o, cacheCreate: cw, cacheRead: cr }
    return result
  } catch { return null }
}

function _tokenDashPillars() {
  const dbPath = path.join(os.homedir(), '.claude', 'token-dashboard.db')
  if (!existsSync(dbPath)) return null
  try {
    const raw = execSync(
      `sqlite3 "${dbPath}" "SELECT SUM(input_tokens),SUM(output_tokens),SUM(cache_create_5m_tokens)+SUM(cache_create_1h_tokens),SUM(cache_read_tokens) FROM messages"`,
      { timeout: 5000, stdio: ['ignore','pipe','ignore'] }
    ).toString().trim()
    const [i,o,cw,cr] = raw.split('|').map(Number)
    return { all: { input: i||0, output: o||0, cacheCreate: cw||0, cacheRead: cr||0 } }
  } catch { return null }
}

function _tokscalePillars(platform = 'claude') {
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
      'Watch your local token logs and re-derive your cascade whenever new sessions are written — a live tune meter. Polls at a configurable interval (default 60s) and returns the updated cascade. With submit:true (and an enrolled device) it also signs + publishes the watched window to the board each poll; default is preview-only (no submit).',
    inputSchema: {
      type: 'object',
      properties: {
        platform:    { type: 'string', enum: ALL_PLATFORMS, description: 'platform to watch (default: claude)' },
        interval_s:  { type: 'number', description: 'poll interval in seconds (default: 60, min: 10)' },
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
      'Publish your LOCAL token runs to the SigRank board as a VERIFIED operator — the enrolled, signed path. Reads your pillars (tokenpull), builds the canonical Schema 1.0 snapshot per window, ed25519-signs it with your device key, and POSTs to /api/v1/snapshots. Requires `npx sigrank-mcp enroll` first (a bound device). Only signed submissions from a trusted device rank on the board. Token-only; the private key never leaves your machine.',
    inputSchema: {
      type: 'object',
      properties: {
        window: { type: 'string', enum: ['7d', '30d', '90d', 'all'], description: 'submit only this window (default: all 4)' },
        platform: { type: 'string', enum: ALL_PLATFORMS, description: 'source platform (default: claude)' },
      },
    },
  },
]

// tokenpull window key → the board's window_type enum.
const WINDOW_TYPE = { '7d': '7d', '30d': '30d', '90d': '90d', all: 'all_time' }

// E3: client-side auto-submit cooldown for watch_tokenpull. The server already dedups
// identical snapshots (exact hash → 422), but a noisy poll loop with submit:true could still
// churn the network/board with near-identical rows. Cap auto-submit to once per WATCH_SUBMIT_COOLDOWN_MS
// per window (in-memory, per process). Keyed by window so different windows don't block each other.
const WATCH_SUBMIT_COOLDOWN_MS = 5 * 60 * 1000
const _lastWatchSubmitAt = new Map()

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
        const r = await submitSignedWindow(wk, sum, msgs, id, { apiBase, fetchImpl: doFetch, platform: 'multi', now: opts.now })
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
        // E3: client-side cooldown — at most one auto-submit per window per 5 min. Prevents a
        // fast poll loop from churning the board even before the server's hash-dedup kicks in.
        const clockNow = typeof opts.now === 'number' ? opts.now : Date.now()
        const last = _lastWatchSubmitAt.get(watchWindow)
        if (last != null && clockNow - last < WATCH_SUBMIT_COOLDOWN_MS) {
          const waitS = Math.ceil((WATCH_SUBMIT_COOLDOWN_MS - (clockNow - last)) / 1000)
          auth_submit = { status: 'cooldown', detail: `auto-submit for '${watchWindow}' on cooldown — next in ~${waitS}s (max once / 5 min).`, retry_after_s: waitS }
        } else {
          _lastWatchSubmitAt.set(watchWindow, clockNow)
          auth_submit = await submitSignedWindow(watchWindow, win.pillars, win.messages, id, {
            apiBase,
            fetchImpl: doFetch,
            platform: pulled.platform,
            now: opts.now,
          })
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

    // Pull all four sources in parallel (verifiers are sync, wrap in Promise.resolve)
    const [tpResult, ccPillars, tdPillars, tsPillars] = await Promise.all([
      pullByPlatform(platform, opts).catch(() => null),
      Promise.resolve(_ccusagePillars(platform)),
      Promise.resolve(platform === 'claude' ? _tokenDashPillars() : null),
      Promise.resolve(_tokscalePillars(platform)),
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

  throw new Error(`Unknown tool: ${name}`)
}
