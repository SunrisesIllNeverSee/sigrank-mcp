/**
 * tools/tokscale-breakdown.mjs — tokscale_breakdown tool.
 */

import { execFileAsync } from "./_helpers.mjs";
import { ANNOTATIONS } from "./_schemas.mjs";

export const TOOL_DEF = {
  name: "tokscale_breakdown",
  description:
    "Show a per-model breakdown of your token usage across all platforms detected by tokscale. Models under the threshold (default 1%) are lumped into 'other' to keep the display clean. Useful for seeing which models you actually use per platform (e.g. claude-opus-4-8 76%, claude-sonnet-4-6 11%, other 0.3%). Returns { platform: [{ model, input, output, cacheRead, cacheCreate, pct }] }.",
  annotations: {
    title: "Model breakdown",
    ...ANNOTATIONS.readOnlyHint,
    ...ANNOTATIONS.openWorldHint,
  },
  inputSchema: {
    type: "object",
    properties: {
      threshold: {
        type: "number",
        description:
          "Models below this fraction of their platform's total tokens are lumped into 'other'. Default 0.01 (1%). Set 0 to see every model.",
        default: 0.01,
      },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      platforms: {
        type: "object",
        description: "Map of platform name → array of { model, input, output, cacheRead, cacheCreate, pct }",
      },
    },
  },
};

const TOKSCALE_CLIENT_MAP = {
  claude: "claude",
  codex: "codex",
  "devin-cli": "devin",
  "devin-desktop": "devin",
  gemini: "gemini",
  amp: "amp",
  kimi: "kimi",
  qwen: "qwen",
  goose: "goose",
  kilo: "kilo",
  kilocode: "kilo",
  hermes: "hermes",
  droid: "droid",
  codebuff: "codebuff",
  copilot: "copilot",
  opencode: "opencode",
  openclaw: "openclaw",
  pi: "pi",
  cursor: "other",
  roocode: "other",
  mux: "other",
  crush: "other",
  antigravity: "other",
  "antigravity-cli": "other",
  zed: "other",
  kiro: "other",
  trae: "other",
  warp: "other",
  cline: "other",
  gjc: "other",
  grok: "other",
  jcode: "other",
  commandcode: "other",
  micode: "other",
  junie: "other",
  zcode: "other",
  opencodereview: "other",
  codebuddy: "other",
  workbuddy: "other",
  synthetic: null,
};

/**
 * Run `tokscale models --json` and return a model-level breakdown per platform.
 * Models under `threshold` (default 1%) of their platform's total are lumped
 * into "other" to keep the display clean.
 *
 * Returns: { platform: [{ model, input, output, cacheRead, cacheCreate, pct }] }
 */
export async function tokscaleModelBreakdown(threshold = 0.01) {
  const raw = await execFileAsync("tokscale", ["models", "--json"], 60000);
  const data = JSON.parse(raw);
  const entries = Array.isArray(data?.entries)
    ? data.entries
    : Array.isArray(data)
      ? data
      : [];
  if (!entries.length) return {};

  // Group entries by our platform name
  const byPlatform = {};
  for (const e of entries) {
    if (!e || !e.client) continue;
    if (e.model === "<synthetic>" || e.model === "unknown") continue;
    const input = Number(e.input) || 0;
    const output = Number(e.output) || 0;
    if (input + output === 0) continue;
    const platform = TOKSCALE_CLIENT_MAP[e.client];
    if (platform === null) continue;
    const p = platform || "other";
    if (!byPlatform[p]) byPlatform[p] = [];
    byPlatform[p].push({
      model: e.model,
      input,
      output,
      cacheRead: Number(e.cacheRead) || 0,
      cacheCreate: Number(e.cacheWrite) || 0,
    });
  }

  // For each platform: sort by total tokens desc, lump small models into "other"
  const result = {};
  for (const [platform, models] of Object.entries(byPlatform)) {
    const total = models.reduce(
      (s, m) => s + m.input + m.output + m.cacheRead + m.cacheCreate,
      0,
    );
    if (total === 0) continue;
    const sorted = models.sort(
      (a, b) =>
        b.input + b.output + b.cacheRead + b.cacheCreate -
        (a.input + a.output + a.cacheRead + a.cacheCreate),
    );
    const big = [];
    const small = { model: "other", input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    for (const m of sorted) {
      const t = m.input + m.output + m.cacheRead + m.cacheCreate;
      if (t / total < threshold) {
        small.input += m.input;
        small.output += m.output;
        small.cacheRead += m.cacheRead;
        small.cacheCreate += m.cacheCreate;
      } else {
        big.push({ ...m, pct: t / total });
      }
    }
    if (small.input + small.output + small.cacheRead + small.cacheCreate > 0) {
      const t = small.input + small.output + small.cacheRead + small.cacheCreate;
      big.push({ ...small, pct: t / total });
    }
    result[platform] = big;
  }
  return result;
}

export async function handleTokscaleBreakdown(args) {
  const threshold = Number(args?.threshold ?? 0.01);
  const platforms = await tokscaleModelBreakdown(threshold);
  return { platforms };
}
