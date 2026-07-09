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
 *   npx sigrank board | compare | watch    read / publish helpers
 *   npx sigrank --help          full reference
 *
 * For AI clients (NOT human commands): in a piped/non-TTY context this starts an MCP
 * stdio server; AI clients call its tools automatically. See ./tools.mjs.
 *
 * Pure cascade math: ./cascade.mjs  |  narration card: ./narrate.mjs
 * Tool table + dispatcher: ./tools.mjs  |  Terminal UI: ./cli.mjs + ./tui.mjs
 * Token-only — no transcript content.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, callTool } from "./tools.mjs";
import { runCli } from "./cli.mjs";
import { readFileSync } from "node:fs";

// FIX K: read the version from package.json (was hardcoded '0.7.0' — drifted from
// 0.11.0). The MCP server identity now tracks the published package version.
function serverVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
    );
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Prevent silent crashes — log to stderr (MCP clients read stdout; stderr is safe for
// diagnostics). The process exits so the client can respawn with a clean slate rather
// than hanging on a broken connection.
process.on("uncaughtException", (err) => {
  process.stderr.write(
    `[sigrank-mcp] uncaughtException: ${err?.stack || err}\n`,
  );
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(
    `[sigrank-mcp] unhandledRejection: ${reason?.stack || reason}\n`,
  );
  process.exit(1);
});

async function startMcpServer() {
  const server = new Server(
    { name: "sigrank", version: serverVersion() },
    { capabilities: { tools: {}, prompts: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    // Unknown tool name = a client/host bug → JSON-RPC -32602 protocol error, per the MCP
    // spec. isError results (below) are reserved for tools that ran and failed.
    if (!TOOLS.some((t) => t.name === req.params.name)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown tool: ${req.params.name}`,
      );
    }
    try {
      const out = await callTool(req.params.name, req.params.arguments);
      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
  });

  // --- Prompts: interactive templates that agents can offer to users ---
  const PROMPTS = [
    {
      name: "check-my-efficiency",
      description:
        "Pull your local token usage, compute your SigRank yield, and compare your efficiency against the leaderboard. Shows your class tier (Burner/Builder/10xer) and where you rank.",
      arguments: [],
    },
    {
      name: "simulate-improvement",
      description:
        'Run a what-if analysis on your token mix: "if I increased my cache reads by 50k, how would my yield change?" Uses simulate_change to show the payoff before you change your workflow.',
      arguments: [
        {
          name: "change",
          description:
            'The change to simulate (e.g. "increase cache reads by 50000" or "reduce input by 100000")',
          required: true,
        },
      ],
    },
    {
      name: "compare-with-leader",
      description:
        "Fetch the top operator from the SigRank leaderboard and compare their token efficiency metrics against yours. Shows the gap and what you'd need to change to close it.",
      arguments: [],
    },
  ];

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS,
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments || {};
    if (name === "check-my-efficiency") {
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "Pull my local token usage with tokenpull, compute my yield, and then fetch the leaderboard so I can see where I rank. Show me my class tier and my key metrics (Yield, Leverage, Velocity).",
            },
          },
        ],
      };
    }
    if (name === "simulate-improvement") {
      const change = args.change || "increase cache reads by 50000";
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `First pull my local token usage with tokenpull to get my current pillars. Then use simulate_change to answer: "what if I ${change}?" Show me the yield delta and whether my class tier would change.`,
            },
          },
        ],
      };
    }
    if (name === "compare-with-leader") {
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "Fetch the SigRank leaderboard with get_leaderboard, then pull my local token usage with tokenpull. Compare my yield, leverage, and velocity against the top operator. What's the gap and what would I need to change to close it?",
            },
          },
        ],
      };
    }
    throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
  });

  await server.connect(new StdioServerTransport());
}

// Route:
//   any arg              → the CLI (runCli shows help + exits non-zero on unknown commands,
//                          so a typo never silently starts a hung MCP stdio server on a TTY)
//   no args + TTY stdout → full tabbed TUI (interactive use)
//   no args + piped      → MCP stdio server (AI client use)
const cliArgs = process.argv.slice(2);
if (cliArgs.length > 0) {
  runCli(process.argv);
} else if (process.stdout.isTTY) {
  // Interactive terminal — launch the full tabbed TUI
  const { runTui } = await import("./tui.mjs");
  runTui();
} else {
  startMcpServer();
}
