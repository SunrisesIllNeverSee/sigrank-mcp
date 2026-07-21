/**
 * tools/tokenpull-compare.mjs — tokenpull_compare tool.
 */

import { cascade } from "../analytics/cascade.mjs";
import { ALL_PLATFORMS } from "../adapters/index.mjs";
import { COMPARE_OUTPUT, ANNOTATIONS } from "./_schemas.mjs";
import { pullByPlatform } from "./_helpers.mjs";
import { _ccusagePillars, _tokenDashPillars, _tokscalePillars } from "./_verifiers.mjs";

export const TOOL_DEF = {
  name: "tokenpull_compare",
  description:
    "Pull token usage from ALL four local sources in parallel — tokenpull (JSONL canon), ccusage CLI, token-dashboard SQLite, and tokscale report — and return them side-by-side with delta % vs tokenpull as the baseline. Also computes the cascade (Υ, SNR, Leverage, class) for each source so you can see how each verifier scores. Useful for validating your numbers before submitting, or understanding discrepancies between tools. Claude only for token-dash; codex and others use tokenpull + ccusage + tokscale. Token-only, on-device.",
  annotations: { title: "Compare token sources", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.openWorldHint },
  inputSchema: {
    type: "object",
    properties: {
      platform: {
        type: "string",
        enum: ALL_PLATFORMS,
        description:
          "platform to compare (default: claude). token-dash and App only available for claude.",
      },
    },
  },
  outputSchema: COMPARE_OUTPUT,
};

export async function handleTokenpullCompare(args, ctx) {
  const platform = args?.platform || "claude";
  const WINS = ["7d", "30d", "90d", "all"];

  // Pull all four sources in parallel (verifiers are now async via execFile)
  const [tpResult, ccPillars, tdPillars, tsPillars] = await Promise.all([
    pullByPlatform(platform, ctx.opts).catch(() => null),
    _ccusagePillars(platform).catch(() => null),
    (platform === "claude"
      ? _tokenDashPillars()
      : Promise.resolve(null)
    ).catch(() => null),
    _tokscalePillars(platform).catch(() => null),
  ]);

  // Build tokenpull window lookup
  const tpByWin = {};
  for (const w of tpResult?.windows ?? []) tpByWin[w.window] = w.pillars;

  // Helper: delta % vs tokenpull baseline
  const delta = (val, base) =>
    base > 0 ? +(((val - base) / base) * 100).toFixed(1) : null;

  // Build per-source per-window comparison
  const SOURCES = [
    {
      source: "tokenpull",
      note: "JSONL deduped by msg id — canon source",
      byWin: tpByWin,
    },
    {
      source: "ccusage",
      note: "ccusage CLI — monthly only",
      byWin: ccPillars ?? {},
    },
    {
      source: "token-dash",
      note: "token-dashboard SQLite — all-time only",
      byWin: tdPillars ?? {},
    },
    {
      source: "tokscale",
      note: "tokscale_report.json — all-time only",
      byWin: tsPillars ?? {},
    },
  ];

  const comparison = {};
  for (const win of WINS) {
    const baseP = tpByWin[win];
    comparison[win] = SOURCES.filter((s) => s.byWin[win] != null).map((s) => {
      const p = s.byWin[win];
      const cas = cascade(p);
      const entry = {
        source: s.source,
        note: s.note,
        pillars: p,
        cascade: {
          yield: cas.yield,
          snr: cas.snr,
          leverage: cas.leverage,
          velocity: cas.velocity,
          dev10x: cas.dev10x,
          class: cas.class,
        },
      };
      if (s.source !== "tokenpull" && baseP) {
        entry.delta_vs_tokenpull = {
          input: delta(p.input, baseP.input),
          output: delta(p.output, baseP.output),
          cacheCreate: delta(p.cacheCreate, baseP.cacheCreate),
          cacheRead: delta(p.cacheRead, baseP.cacheRead),
        };
      }
      return entry;
    });
  }

  // Sources available summary
  const available = SOURCES.filter(
    (s) => Object.keys(s.byWin).length > 0,
  ).map((s) => s.source);

  return {
    platform,
    estimated: tpResult?.estimated ?? false,
    generatedAt: tpResult?.generatedAt ?? new Date().toISOString(),
    sources_available: available,
    sources_missing: SOURCES.map((s) => s.source).filter(
      (s) => !available.includes(s),
    ),
    comparison,
  };
}
