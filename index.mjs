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
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
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
    { capabilities: { tools: { listChanged: false }, prompts: { listChanged: false }, resources: { listChanged: false } } },
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
              text: readFileSync(
                new URL("./prompts/check-my-efficiency.md", import.meta.url),
                "utf8",
              ).trim(),
            },
          },
        ],
      };
    }
    if (name === "simulate-improvement") {
      const change = args.change || "increase cache reads by 50000";
      const template = readFileSync(
        new URL("./prompts/simulate-improvement.md", import.meta.url),
        "utf8",
      );
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: template.replace(/\{\{change\}\}/g, change).trim(),
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
              text: readFileSync(
                new URL("./prompts/compare-with-leader.md", import.meta.url),
                "utf8",
              ).trim(),
            },
          },
        ],
      };
    }
    throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
  });

  // --- Resources: static context agents can read without calling a tool ---
  const RESOURCES = [
    {
      uri: "sigrank://scoring-formula",
      name: "SigRank Scoring Formula",
      description:
        "The yield cascade formula and all derived metrics: Υ (Yield = Cache Reads × Output / Input²), SNR (signal-to-noise), Leverage (Cr/I), Velocity (O/I), 10xDEV score, and class tier thresholds (Burner / Builder / 10xer).",
      mimeType: "text/markdown",
    },
    {
      uri: "sigrank://class-tiers",
      name: "Class Tier Definitions",
      description:
        "Definitions and thresholds for the three SigRank operator classes: Burner (raw volume), Builder (balanced efficiency), and 10xer (cascade-optimized). Includes the yield ranges that define each tier.",
      mimeType: "text/markdown",
    },
    {
      uri: "sigrank://install-guide",
      name: "Quick Start Guide",
      description:
        "Step-by-step install and first submission: npx sigrank → enroll → submit. Covers ccusage/tokscale bundled deps + token-dashboard (Nate's, github.com/nateherkai/token-dashboard), privacy model (token counts only, never prompts), and dry-run workflow.",
      mimeType: "text/markdown",
    },
    {
      uri: "sigrank://privacy-model",
      name: "Privacy Model",
      description:
        "How SigRank protects user privacy: runs locally, only four token counts (input, output, cacheCreate, cacheRead) leave the machine, ed25519-signed submissions, no prompt content ever transmitted.",
      mimeType: "text/markdown",
    },
    {
      uri: "sigrank://data-policy",
      name: "Data Policy",
      description:
        "Summary of SigRank data governance: what we collect, what we do not collect, consent requirements, and how to pause, delete, or export your data.",
      mimeType: "text/markdown",
    },
  ];

  const RESOURCE_FILES = {
    "sigrank://scoring-formula": "./resources/scoring-formula.md",
    "sigrank://class-tiers": "./resources/class-tiers.md",
    "sigrank://install-guide": "./resources/install-guide.md",
    "sigrank://privacy-model": "./resources/privacy-model.md",
    "sigrank://data-policy": "./resources/data-policy.md",
  };

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCES,
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    const file = RESOURCE_FILES[uri];
    if (!file) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
    }
    const content = readFileSync(new URL(file, import.meta.url), "utf8");
    return {
      contents: [
        {
          uri,
          mimeType: "text/markdown",
          text: content,
        },
      ],
    };
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
