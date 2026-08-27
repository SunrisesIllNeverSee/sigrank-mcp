/**
 * tools/index.mjs — the SigRank MCP tool table + dispatcher, transport-free so it can be
 * unit-tested without spawning the stdio server.
 *
 * Imports individual tool modules from ./ and re-exports the TOOLS array + callTool
 * dispatcher. Backward-compatible root import via ../tools.mjs (shim).
 */

import { ALL_PLATFORMS } from "../adapters/index.mjs";
import { execFileAsync } from "./_helpers.mjs";
import { buildFetch, DEFAULT_API_BASE, DEFAULT_FETCH_TIMEOUT } from "./_helpers.mjs";
import {
  TOKSCALE_CLIENT_MAP,
  TOKSCALE_BLIND_PLATFORMS,
} from "../lib/constants.mjs";

import { TOOL_DEF as rankPasteTool, handleRankPaste } from "./rank-paste.mjs";
import { TOOL_DEF as standardRecordTool, handleGetSigRankStandardRecord } from "./standard-record.mjs";
import { TOOL_DEF as getLeaderboardTool, handleGetLeaderboard } from "./get-leaderboard.mjs";
import { TOOL_DEF as getOperatorTool, handleGetOperator } from "./get-operator.mjs";
import { TOOL_DEF as submitPasteTool, handleSubmitPaste } from "./submit-paste.mjs";
import { TOOL_DEF as tokenpullTool, handleTokenpull } from "./tokenpull.mjs";
import { TOOL_DEF as tokenpullSubmitTool, handleTokenpullSubmit } from "./tokenpull-submit.mjs";
import { TOOL_DEF as rankWindowsTool, handleRankWindows } from "./rank-windows.mjs";
import { TOOL_DEF as watchTokenpullTool, handleWatchTokenpull } from "./watch-tokenpull.mjs";
import { TOOL_DEF as tokenpullCompareTool, handleTokenpullCompare } from "./tokenpull-compare.mjs";
import { TOOL_DEF as enrollTool, handleEnroll } from "./enroll.mjs";
import { TOOL_DEF as submitVerifiedTool, handleSubmitVerified } from "./submit-verified.mjs";
import { TOOL_DEF as simulateChangeTool, handleSimulateChange } from "./simulate-change.mjs";
import { TOOL_DEF as diagnoseCascadeTool, handleDiagnoseCascade } from "./diagnose-cascade.mjs";
import { TOOL_DEF as suggestImprovementsTool, handleSuggestImprovements } from "./suggest-improvements.mjs";
import { TOOL_DEF as selfImproveTool, handleSelfImprove } from "./self-improve.mjs";
import { TOOL_DEF as discoverPeersTool, handleDiscoverPeers } from "./discover-peers.mjs";
// NOTE: get_best_operator, compare_self, compare_operators, describe_power_user,
// and optimize_efficiency were moved to bestuser-router-mcp (the marketing layer).
// They are duplicated there with richer params (metric sorting, platform filters,
// local text scoring). sigrank-mcp stays focused on local pulling + scoring +
// submission + tokscale analytics.
import { TOOL_DEF as tokscaleBreakdownTool, handleTokscaleBreakdown } from "./tokscale-breakdown.mjs";
import { TOOL_DEF as tokscaleMarketShareTool, handleTokscaleMarketShare } from "./tokscale-market-share.mjs";
import { TOOL_DEF as tokscaleDeveloperProfileTool, handleTokscaleDeveloperProfile } from "./tokscale-developer-profile.mjs";
import { TOOL_DEF as tokscaleModelTrendsTool, handleTokscaleModelTrends } from "./tokscale-model-trends.mjs";
import { TOOL_DEF as tokscaleCostAnalysisTool, handleTokscaleCostAnalysis } from "./tokscale-cost-analysis.mjs";
import { TOOL_DEF as tokscaleDeviceProfileTool, handleTokscaleDeviceProfile } from "./tokscale-device-profile.mjs";
import { TOOL_DEF as tokscaleMcpUsageTool, handleTokscaleMcpUsage } from "./tokscale-mcp-usage.mjs";
import { TOOL_DEF as tokscaleCompetitiveIntelTool, handleTokscaleCompetitiveIntel } from "./tokscale-competitive-intel.mjs";

export { DEFAULT_API_BASE, DEFAULT_FETCH_TIMEOUT };

export const TOOLS = [
  rankPasteTool,
  standardRecordTool,
  getLeaderboardTool,
  getOperatorTool,
  submitPasteTool,
  tokenpullTool,
  tokenpullSubmitTool,
  rankWindowsTool,
  watchTokenpullTool,
  tokenpullCompareTool,
  enrollTool,
  submitVerifiedTool,
  simulateChangeTool,
  diagnoseCascadeTool,
  suggestImprovementsTool,
  selfImproveTool,
  discoverPeersTool,
  // get_best_operator, compare_self, compare_operators, describe_power_user,
  // optimize_efficiency → moved to bestuser-router-mcp
  tokscaleBreakdownTool,
  tokscaleMarketShareTool,
  tokscaleDeveloperProfileTool,
  tokscaleModelTrendsTool,
  tokscaleCostAnalysisTool,
  tokscaleDeviceProfileTool,
  tokscaleMcpUsageTool,
  tokscaleCompetitiveIntelTool,
];

// TOKSCALE_CLIENT_MAP is imported from lib/constants.mjs (single source of
// truth — was duplicated in tools/tokscale-breakdown.mjs and
// tokscale_analytics.mjs, and the copies had started to drift).

/** Run `tokscale models --json` and return the list of our platform names. */
async function _tokscaleDetectClients() {
  const raw = await execFileAsync("tokscale", ["models", "--json"], 60000);
  const data = JSON.parse(raw);
  const entries = Array.isArray(data?.entries)
    ? data.entries
    : Array.isArray(data)
      ? data
      : [];
  if (!entries.length) return [];
  const clients = new Set();
  for (const e of entries) {
    if (!e || !e.client) continue;
    if (e.model === "<synthetic>" || e.model === "unknown") continue;
    const input = Number(e.input) || 0;
    const output = Number(e.output) || 0;
    if (input + output === 0) continue;
    const platform = TOKSCALE_CLIENT_MAP[e.client];
    if (platform === null) continue; // synthetic → skip
    clients.add(platform || "other");
  }
  return [...clients];
}

/** Detection targets = what tokscale saw ∪ the platforms tokscale is blind to.
 *  Without the union, an operator with GBs of oh-my-pi telemetry gets no omp row
 *  on any machine where tokscale succeeds, because tokscale never names that
 *  client. Pure + exported so the union is unit-testable without shelling out. */
export function withTokscaleBlind(detected) {
  return [...new Set([...(detected || []), ...TOKSCALE_BLIND_PLATFORMS])];
}

/** Pull a specific set of platforms in parallel, filter to active ones.
 *  opts.callTool overrides the per-platform pull for tests (same opts-injection
 *  convention as opts.adapter in pullByPlatform) so the target-set logic is
 *  assertable without a real filesystem scan. */
async function _pullExplicit(platforms, opts = {}) {
  const pull = opts.callTool || callTool;
  const settled = await Promise.allSettled(
    platforms.map((p) => pull("tokenpull", { platform: p }, opts)),
  );
  const active = settled
    .filter((r) => r.status === "fulfilled" && r.value)
    .map((r) => r.value)
    .filter((d) =>
      (d.windows || []).some(
        (w) => (w.pillars?.input ?? 0) + (w.pillars?.output ?? 0) > 0,
      ),
    );
  const rank = (p) =>
    p === "claude" ? -2 : p === "codex" ? -1 : ALL_PLATFORMS.indexOf(p);
  active.sort((a, b) => rank(a.platform) - rank(b.platform));
  return active;
}

// ── Shared active-platform loader ───────────────────────────────────────────
// THE single data path for "show my cascade across platforms" — used by `me`,
// `watch`, and the TUI Dashboard so they can't drift apart again. Pulls each
// target platform via the tokenpull tool (enriched: pillars + cascade + card),
// keeps only platforms with real local data, and sorts claude → codex → rest.
// Pass `platforms` to scope it (e.g. ['claude'] for a fast first paint).
export async function pullActivePlatforms({ platforms } = {}, opts = {}) {
  // If the caller specified explicit platforms, use those.
  if (platforms && platforms.length) {
    return _pullExplicit(platforms, opts);
  }
  // Auto-detect: run tokscale once to discover all active clients, then pull
  // only those (plus the tokscale-blind platforms). This is much faster than trying
  // all adapters (most fail silently on a machine that doesn't have that tool).
  //
  // Flow: tokscale surfaces ALL clients → map to our platform names →
  // ccusage is primary for Claude (more accurate) → other platforms use
  // their adapters. Anything in tokscale NOT in ccusage gets included.
  // opts.detectClients overrides the tokscale probe for tests (no shelling out).
  const detect = opts.detectClients || _tokscaleDetectClients;
  const detected = await detect().catch(() => null);
  if (detected && detected.length > 0) {
    return _pullExplicit(withTokscaleBlind(detected), opts);
  }
  // Fallback: tokscale not installed or failed → try all adapters (old behavior)
  return _pullExplicit(ALL_PLATFORMS, opts);
}

export async function callTool(name, args, opts = {}) {
  const { apiBase, doFetch, fetchJson } = buildFetch(opts);
  const ctx = {
    apiBase,
    doFetch,
    fetchJson,
    opts,
    callTool: (n, a) => callTool(n, a, opts),
  };

  switch (name) {
    case "rank_paste":
      return handleRankPaste(args);
    case "get_sigrank_standard_record":
      return handleGetSigRankStandardRecord(args);
    case "get_leaderboard":
      return handleGetLeaderboard(args, ctx);
    case "get_operator":
      return handleGetOperator(args, ctx);
    case "submit_paste":
      return handleSubmitPaste(args, ctx);
    case "tokenpull":
      return handleTokenpull(args, ctx);
    case "tokenpull_submit":
      return handleTokenpullSubmit(args, ctx);
    case "rank_windows":
      return handleRankWindows(args);
    case "watch_tokenpull":
      return handleWatchTokenpull(args, ctx);
    case "tokenpull_compare":
      return handleTokenpullCompare(args, ctx);
    case "enroll":
      return handleEnroll(args, ctx);
    case "submit_verified":
      return handleSubmitVerified(args, ctx);
    case "simulate_change":
      return handleSimulateChange(args);
    case "diagnose_cascade":
      return handleDiagnoseCascade(args);
    case "suggest_improvements":
      return handleSuggestImprovements(args);
    case "self_improve":
      return handleSelfImprove(args, ctx);
    case "discover_peers":
      return handleDiscoverPeers(args, ctx);
    // get_best_operator, compare_self, compare_operators, describe_power_user,
    // optimize_efficiency → moved to bestuser-router-mcp
    case "tokscale_breakdown":
      return handleTokscaleBreakdown(args);
    case "tokscale_market_share":
      return handleTokscaleMarketShare();
    case "tokscale_developer_profile":
      return handleTokscaleDeveloperProfile();
    case "tokscale_model_trends":
      return handleTokscaleModelTrends();
    case "tokscale_cost_analysis":
      return handleTokscaleCostAnalysis();
    case "tokscale_device_profile":
      return handleTokscaleDeviceProfile();
    case "tokscale_mcp_usage":
      return handleTokscaleMcpUsage();
    case "tokscale_competitive_intel":
      return handleTokscaleCompetitiveIntel(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
