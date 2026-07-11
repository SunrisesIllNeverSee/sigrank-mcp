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
    { capabilities: { tools: { listChanged: false } } },
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
        "Step-by-step install and first submission: npx sigrank → enroll → submit. Covers ccusage/tokscale/tokendash bundled deps, privacy model (token counts only, never prompts), and dry-run workflow.",
      mimeType: "text/markdown",
    },
    {
      uri: "sigrank://privacy-model",
      name: "Privacy Model",
      description:
        "How SigRank protects user privacy: runs locally, only four token counts (input, output, cacheCreate, cacheRead) leave the machine, ed25519-signed submissions, no prompt content ever transmitted.",
      mimeType: "text/markdown",
    },
  ];

  const RESOURCE_CONTENT = {
    "sigrank://scoring-formula": `# SigRank Scoring Formula

## Yield (Υ) — the headline metric

\`\`\`
Υ = Cache Reads × Output / Input²
\`\`\`

Yield rewards operators who maximize output while minimizing input — and who build cache to amortize that input across sessions. A high yield means you're getting more done with less, efficiently.

## Derived Metrics

| Metric | Formula | Meaning |
|--------|---------|---------|
| **SNR** | Output / (Input + CacheCreate) | Signal-to-noise: how much of your token spend is productive output vs. overhead |
| **Leverage** | Cache Reads / Input | How well you reuse cached context — higher = better cache utilization |
| **Velocity** | Output / Input | Raw output efficiency — how much output you generate per token of input |
| **10xDEV** | Composite score | Weighted blend of yield, leverage, and velocity for cross-platform comparison |

## Class Tier Thresholds

| Tier | Yield Range | Profile |
|------|-------------|---------|
| **Burner** | Υ < 1.0 | Raw volume — high input, low cache reuse, brute-force output |
| **Builder** | 1.0 ≤ Υ < 10.0 | Balanced — moderate cache, decent output efficiency |
| **10xer** | Υ ≥ 10.0 | Cascade-optimized — high cache reads, minimal input, efficient output |

The formula is deterministic and computed locally. No network calls needed for scoring.
`,

    "sigrank://class-tiers": `# SigRank Class Tiers

Every operator is classified into one of three tiers based on their Yield (Υ = Cache Reads × Output / Input²).

## Burner (Υ < 1.0)
- **Profile:** Raw volume operators. High input tokens, low cache reuse.
- **Behavior:** Brute-force — lots of context fed in, relatively little output back.
- **Typical:** New AI users, verbose prompters, no session continuity.
- **Fix:** Build cache across sessions. Stop re-explaining context. Use --continue.

## Builder (1.0 ≤ Υ < 10.0)
- **Profile:** Balanced operators. Moderate cache, decent output efficiency.
- **Behavior:** Productive — reasonable input-to-output ratio, some cache leverage.
- **Typical:** Experienced AI coders who use CLAUDE.md, project context, and session continuity.
- **Fix:** Increase cache reads by reusing sessions. Reduce input by trimming unnecessary context.

## 10xer (Υ ≥ 10.0)
- **Profile:** Cascade-optimized operators. High cache reads, minimal input, efficient output.
- **Behavior:** Surgical — minimal new input, maximum cache reuse, high-yield output.
- **Typical:** Power users with long-running sessions, tight context windows, and aggressive cache strategies.
- **Maintain:** Keep cache hit rate high. Avoid context bloat. Monitor with watch_tokenpull.

Tiers are recalculated on every submission. Your tier can change between windows (7d, 30d, 90d, all-time).
`,

    "sigrank://install-guide": `# SigRank Quick Start

## Install

\`\`\`bash
npx sigrank
\`\`\`

No global install needed. The MCP server starts automatically when an AI client (Claude, Cursor, Cline) connects.

## First Submission

1. **Enroll** — register your operator codename:
   \`\`\`bash
   npx sigrank enroll
   \`\`\`

2. **Pull + Submit** — scan your local AI session logs and publish:
   \`\`\`bash
   npx sigrank submit
   \`\`\`

3. **Dry Run** — see exactly what would be sent before publishing:
   \`\`\`bash
   npx sigrank submit --dry-run
   \`\`\`

## Token Pull Sources (bundled)

SigRank bundles three token readers as dependencies:
- **ccusage** — Claude Code session logs
- **tokscale** — multi-platform token telemetry
- **tokendash** — dashboard + TUI for token usage

No separate install needed. All three are called automatically by the tokenpull tools.

## MCP Client Setup

Add to your MCP client config:
\`\`\`json
{
  "mcpServers": {
    "sigrank": {
      "command": "npx",
      "args": ["sigrank"]
    }
  }
}
\`\`\`

## Live Board

Visit https://signalaf.com to see the global leaderboard.
`,

    "sigrank://privacy-model": `# SigRank Privacy Model

## What leaves your machine

**Only four numbers per submission:**
- Input tokens
- Output tokens
- Cache create tokens
- Cache read tokens

**That's it.** No prompts, no code, no file contents, no conversation text.

## How it works

1. **Local-first:** All token pulling happens on your machine. SigRank reads session logs from ~/.claude, ~/.codex, ~/.local/share/amp, etc.
2. **Token counts only:** The MCP tools extract integer counts from log metadata. The actual content of your conversations is never read, parsed, or transmitted.
3. **Signed submission:** Submissions are ed25519-signed. The board verifies authenticity without seeing your data.
4. **No auth required:** No API keys, no OAuth, no account needed to read the leaderboard. Enrollment only requires a codename.

## What SigRank can NOT see

- Your prompts or messages
- Your code or file contents
- Your tool calls or their results
- Which AI platform you use (beyond token counts)
- Your identity (only your chosen codename)

## Verification

The submit_verified tool uses ed25519 signing. The board's source_attestations table records the signature for audit. You can verify your own submissions via get_operator.
`,
  };

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCES,
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    const content = RESOURCE_CONTENT[uri];
    if (!content) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
    }
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
