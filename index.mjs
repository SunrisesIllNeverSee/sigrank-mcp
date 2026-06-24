#!/usr/bin/env node
/**
 * SigRank MCP server + CLI entry point.
 *
 * CLI mode  — triggered when any command arg is passed:
 *   npx sigrank-mcp board           live leaderboard (auto-refresh)
 *   npx sigrank-mcp me              your local cascade across 4 windows
 *   npx sigrank-mcp watch           RT tune meter, re-reads local logs
 *   npx sigrank-mcp --help          full command reference
 *
 * MCP server mode — triggered when no args (the default for MCP clients):
 *   npx sigrank-mcp                 starts the MCP stdio server
 *
 * Tools exposed in MCP mode (see ./tools.mjs):
 *   rank_paste · get_leaderboard · get_operator · submit_paste
 *   tokenpull  · tokenpull_submit · rank_windows · watch_tokenpull
 *
 * Pure cascade math: ./cascade.mjs  |  narration card: ./narrate.mjs
 * Tool table + dispatcher: ./tools.mjs  |  Terminal UI: ./cli.mjs
 * Token-only — no transcript content, no auth.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { TOOLS, callTool } from './tools.mjs'
import { runCli } from './cli.mjs'

// Prevent silent crashes — log to stderr (MCP clients read stdout; stderr is safe for
// diagnostics). The process exits so the client can respawn with a clean slate rather
// than hanging on a broken connection.
process.on('uncaughtException', (err) => {
  process.stderr.write(`[sigrank-mcp] uncaughtException: ${err?.stack || err}\n`)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[sigrank-mcp] unhandledRejection: ${reason?.stack || reason}\n`)
  process.exit(1)
})

async function startMcpServer() {
  const server = new Server({ name: 'sigrank', version: '0.7.0' }, { capabilities: { tools: {} } })
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

// Route:
//   any CLI command arg  → terminal UI
//   no args + TTY stdout → terminal dashboard (interactive use)
//   no args + piped      → MCP stdio server (AI client use)
const cliArgs = process.argv.slice(2)
const CLI_COMMANDS = new Set(['board', 'me', 'compare', 'watch', 'help', '--help', '-h', '--version', '-v'])
if (cliArgs.length > 0 && (CLI_COMMANDS.has(cliArgs[0]) || cliArgs[0].startsWith('--'))) {
  runCli(process.argv)
} else if (cliArgs.length === 0 && process.stdout.isTTY) {
  // Interactive terminal — show the dashboard
  runCli(process.argv)
} else {
  startMcpServer()
}
