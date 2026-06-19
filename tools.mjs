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
import { tokenpull as pullLocal } from './tokenpull.mjs'

export const DEFAULT_API_BASE = process.env.SIGRANK_API_BASE || 'https://signalaf.com'

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
      "Pull your LOCAL token usage (in-house reader — no ccusage/tokscale) from Claude Code's session logs (~/.claude/projects) and rank it across the four windows (7d/30d/90d/all-time) with the cascade — zero paste. Token-only: reads usage counts not message content; deduped by message.id to match billing. The numbers stay on your machine unless you submit them.",
    inputSchema: { type: 'object', properties: { platform: { type: 'string', enum: ['claude'], description: 'source platform (default claude; codex/others coming)' } } },
  },
  {
    name: 'tokenpull_submit',
    description:
      "Pull your LOCAL usage (tokenpull) AND publish it to the board in one call — the zero-paste flow. Submits the canonical 4 pillars per window, each re-scored server-side and tagged with the source platform (so Codex/others rank on the same board). Requires a codename to publish; omit for local preview. Token-only.",
    inputSchema: {
      type: 'object',
      properties: {
        codename: { type: 'string', description: 'operator codename to publish under (omit for preview-only)' },
        window: { type: 'string', enum: ['7d', '30d', '90d', 'all'], description: 'submit only this window (default: all 4)' },
      },
    },
  },
]

// tokenpull window key → the board's window_type enum.
const WINDOW_TYPE = { '7d': '7d', '30d': '30d', '90d': '90d', all: 'all_time' }

export async function callTool(name, args, opts = {}) {
  const apiBase = opts.apiBase || DEFAULT_API_BASE
  const doFetch = opts.fetchImpl || fetch

  const fetchJson = async (path) => {
    const res = await doFetch(`${apiBase}${path}`, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`SigRank API ${path} → HTTP ${res.status}`)
    return res.json()
  }

  if (name === 'rank_paste') {
    const c = cascade(parsePillars(args?.text))
    return { ...c, card: narrate(c) }
  }
  if (name === 'get_leaderboard') return fetchJson('/api/v1/leaderboard')
  if (name === 'get_operator') return fetchJson(`/api/v1/operators/${encodeURIComponent(args?.codename || '')}`)

  if (name === 'submit_paste') {
    // Local preview first — also validates the paste is parseable before any POST.
    const c = cascade(parsePillars(args?.text))
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
    const res = await doFetch(`${apiBase}/api/v1/ingest-paste`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ codename, raw_paste: String(args?.text || '') }),
    })
    let ack
    try { ack = await res.json() } catch { ack = { status: 'error', detail: `HTTP ${res.status} (non-JSON response)` } }
    return { ...c, card, submission: { httpStatus: res.status, ...ack } }
  }

  if (name === 'tokenpull') {
    // Local read → 4 windows of raw pillars → cascade each. Token-only, on-device.
    const pulled = await pullLocal({ adapter: opts.adapter })
    const windows = pulled.windows.map((w) => {
      const c = cascade(w.pillars)
      return { window: w.window, messages: w.messages, pillars: w.pillars, cascade: c, card: narrate(c, `${w.window} window`) }
    })
    return { platform: pulled.platform, generatedAt: pulled.generatedAt, files: pulled.files, totalMessages: pulled.totalMessages, windows }
  }

  if (name === 'tokenpull_submit') {
    // Pull local usage, then publish each window's CANONICAL pillars to the board
    // (server re-scores). The board stays platform-agnostic via the 4 pillars; the
    // source platform rides along as a tag. Conversion already happened in the adapter.
    const codename = String(args?.codename || '').trim()
    const pulled = await pullLocal({ adapter: opts.adapter })
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
      const res = await doFetch(`${apiBase}/api/v1/ingest-paste`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ codename, raw_paste: rawPaste, window_type: WINDOW_TYPE[w.window] || w.window, telemetry: { platform: { primary: pulled.platform } } }),
      })
      let ack
      try { ack = await res.json() } catch { ack = { status: 'error', detail: `HTTP ${res.status} (non-JSON)` } }
      out.push({ window: w.window, pillars: w.pillars, cascade: c, card, submission: { httpStatus: res.status, ...ack } })
    }
    return { platform: pulled.platform, codename: codename || null, generatedAt: pulled.generatedAt, windows: out }
  }

  throw new Error(`Unknown tool: ${name}`)
}
