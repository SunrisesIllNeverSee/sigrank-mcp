#!/usr/bin/env node
/**
 * SigRank MCP server — exposes the SigRank yield cascade + live board as MCP tools
 * any client (Claude Code, Cursor, …) can call. Token-only, Claude/ccusage-first.
 *
 * Tools (see ./tools.mjs):
 *   - rank_paste(text)              paste ccusage token counts → Υ/SNR/Leverage/…+class +card
 *   - get_leaderboard()             the live public board (signalaf.com)
 *   - get_operator(codename)        one operator's live profile
 *   - submit_paste(text, codename)  rank AND publish to the board in one call
 *
 * Pure cascade math lives in ./cascade.mjs (mirrors lib/ingest/bridge.ts); the
 * deterministic card in ./narrate.mjs; the tool table + dispatcher in ./tools.mjs.
 * No transcript content, no auth. Reuses the live read/write endpoints over HTTP.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { TOOLS, callTool } from './tools.mjs'

async function main() {
  const server = new Server({ name: 'sigrank', version: '0.5.0' }, { capabilities: { tools: {} } })
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
