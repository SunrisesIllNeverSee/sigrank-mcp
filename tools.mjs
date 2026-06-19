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

  throw new Error(`Unknown tool: ${name}`)
}
