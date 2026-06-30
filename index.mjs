#!/usr/bin/env node
/**
 * SigRank MCP server + CLI entry point.
 *
 * The TUI is the whole app. Launch it and sign in inside it:
 *   npx sigrank                 full tabbed TUI (Dashboard / Trends / Compare /
 *                                   Board / Watch / Connect). Sign in on the Connect
 *                                   tab (paste a connect code), then [S] submits.
 *
 * CLI shortcuts (optional — the TUI never needs them):
 *   npx sigrank enroll          sign in: redeem a connect code from signalaf.com
 *   npx sigrank submit          publish your verified runs to the board
 *   npx sigrank board | me | compare | watch    read / publish helpers
 *   npx sigrank --help          full reference
 *
 * For AI clients (NOT human commands): in a piped/non-TTY context this starts an MCP
 * stdio server; AI clients call its tools automatically. See ./tools.mjs.
 *
 * Pure cascade math: ./cascade.mjs  |  narration card: ./narrate.mjs
 * Tool table + dispatcher: ./tools.mjs  |  Terminal UI: ./cli.mjs + ./tui.mjs
 * Token-only — no transcript content.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { TOOLS, callTool } from './tools.mjs'
import { runCli } from './cli.mjs'
import { readFileSync } from 'node:fs'

// FIX K: read the version from package.json (was hardcoded '0.7.0' — drifted from
// 0.11.0). The MCP server identity now tracks the published package version.
function serverVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

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
  const server = new Server({ name: 'sigrank', version: serverVersion() }, { capabilities: { tools: {} } })
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
//   any CLI command arg  → terminal UI / CLI command
//   no args + TTY stdout → full tabbed TUI (interactive use)
//   no args + piped      → MCP stdio server (AI client use)
const cliArgs = process.argv.slice(2)
const CLI_COMMANDS = new Set(['board', 'compare', 'tui', 'watch', 'enroll', 'submit', 'help', '--help', '-h', '--version', '-v'])
if (cliArgs.length > 0 && (CLI_COMMANDS.has(cliArgs[0]) || cliArgs[0].startsWith('--'))) {
  runCli(process.argv)
} else if (cliArgs.length === 0 && process.stdout.isTTY) {
  // Interactive terminal — launch the full tabbed TUI
  const { runTui } = await import('./tui.mjs')
  runTui()
} else {
  startMcpServer()
}
