#!/usr/bin/env node
/**
 * SigRank MCP server — exposes the SigRank yield cascade + live board as MCP tools
 * any client (Claude Code, Cursor, …) can call. Token-only, Claude/ccusage-first.
 *
 * Tools:
 *   - rank_paste(text)         paste ccusage-style token counts → Υ/SNR/Leverage/…+class
 *   - get_leaderboard()        the live public board (signalaf.com)
 *   - get_operator(codename)   one operator's live profile
 *
 * Pure cascade math lives in ./cascade.mjs (mirrors lib/ingest/bridge.ts). No
 * transcript content, no auth. Reuses the live read endpoints over HTTP.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { cascade, parsePillars } from './cascade.mjs'

const API_BASE = process.env.SIGRANK_API_BASE || 'https://signalaf.com'

async function fetchJson(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`SigRank API ${path} → HTTP ${res.status}`)
  return res.json()
}

const TOOLS = [
  {
    name: 'rank_paste',
    description: 'Rank a paste of ccusage-style token counts. Accepts JSON {input,output,cacheCreate,cacheRead} or 4 whitespace-separated numbers in that order. Returns Υ Yield, SNR, Leverage, Velocity, 10xDEV, and class. Token-only.',
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

async function callTool(name, args) {
  if (name === 'rank_paste') return cascade(parsePillars(args?.text))
  if (name === 'get_leaderboard') return fetchJson('/api/v1/leaderboard')
  if (name === 'get_operator') return fetchJson(`/api/v1/operators/${encodeURIComponent(args?.codename || '')}`)
  throw new Error(`Unknown tool: ${name}`)
}

async function main() {
  const server = new Server({ name: 'sigrank', version: '0.1.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const out = await callTool(req.params.name, req.params.arguments)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
    }
  })
  await server.connect(new StdioServerTransport())
}

main()
