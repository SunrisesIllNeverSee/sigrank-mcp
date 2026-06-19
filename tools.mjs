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
]

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

  throw new Error(`Unknown tool: ${name}`)
}
