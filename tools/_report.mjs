/**
 * tools/_report.mjs — cascade report blocks + self-improvement scope helpers.
 *
 * Used by submit_verified (per-window report payload) and self_improve
 * (weekly/trend scope analysis).
 */

import { cascade, detectMode, qualityScore, MODE_EXPECTED_YIELD } from "../analytics/cascade.mjs";
import { computeBadges } from "../badges.mjs";
import { execFileAsync } from "./_helpers.mjs";

/**
 * Compute the cascade report block for a submission payload.
 * Pure math — mode detection + badges + health score from the current pillars.
 * The server stores this as-is (does NOT recompute modes).
 * Weekly granularity is the privacy boundary — no daily modes in the report.
 */
export function _computeReportBlock(pillars) {
  const cas = cascade(pillars);
  const modeInfo = detectMode(pillars);
  const badges = computeBadges({
    pillars,
    cascade: cas,
    history: [], // no history available at submit time — badges computed from current pillars only
    isVerified: true, // submit_verified is the signed agent path
    rank: null,
  });
  return {
    current_mode: modeInfo.mode,
    mode_confidence: modeInfo.confidence,
    mode_distribution: { [modeInfo.mode]: 1.0 }, // single-window submission
    mode_weighted_yield: cas.yield ?? 0,
    peak_yield: cas.yield ?? 0,
    health_score: _healthScore(
      [{ mode: modeInfo.mode, yield: cas.yield ?? 0 }],
      cas.yield ?? 0,
    ),
    badges,
  };
}

/** Pull daily rows from ccusage to build mode history. Returns array of { date, pillars, yield, mode }. */
export async function _pullDailyRows(opts = {}) {
  try {
    const raw = await execFileAsync(
      "ccusage",
      ["claude", "daily", "--json"],
      15000,
    );
    const rows = JSON.parse(raw)?.daily ?? JSON.parse(raw);
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => {
        const pillars = {
          input: r.inputTokens ?? r.input_tokens ?? 0,
          output: r.outputTokens ?? r.output_tokens ?? 0,
          cacheCreate: r.cacheCreationTokens ?? r.cache_create_tokens ?? 0,
          cacheRead: r.cacheReadTokens ?? r.cache_read_tokens ?? 0,
        };
        const cas = cascade(pillars);
        const mode = detectMode(pillars);
        return {
          date: r.date ?? r.day ?? null,
          pillars,
          yield: cas.yield ?? 0,
          mode: mode.mode,
          mode_confidence: mode.confidence,
        };
      })
      .filter((r) => r.date);
  } catch {
    return [];
  }
}

/** Compound daily rows into weekly snapshots. Each week = 7 days, starting Monday. */
export function _compoundWeekly(dailyRows) {
  if (!dailyRows || dailyRows.length === 0) return [];
  // Group by ISO week (week starts Monday)
  const weeks = new Map();
  for (const row of dailyRows) {
    const d = new Date(row.date);
    const day = d.getDay() || 7; // Sunday=0 → 7
    const monday = new Date(d);
    monday.setDate(d.getDate() - day + 1);
    const weekKey = monday.toISOString().slice(0, 10);
    if (!weeks.has(weekKey)) {
      weeks.set(weekKey, { weekStart: weekKey, days: [] });
    }
    weeks.get(weekKey).days.push(row);
  }
  // Compound each week
  return Array.from(weeks.values())
    .map((w) => {
      const pillars = w.days.reduce(
        (acc, d) => ({
          input: acc.input + d.pillars.input,
          output: acc.output + d.pillars.output,
          cacheCreate: acc.cacheCreate + d.pillars.cacheCreate,
          cacheRead: acc.cacheRead + d.pillars.cacheRead,
        }),
        { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
      );
      const cas = cascade(pillars);
      const mode = detectMode(pillars);
      return {
        weekStart: w.weekStart,
        pillars,
        yield: cas.yield ?? 0,
        mode: mode.mode,
        mode_confidence: mode.confidence,
        dayCount: w.days.length,
        dailyModes: w.days.map((d) => d.mode), // stays local — not in submitted report
      };
    })
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

/** Compute mode distribution from weekly snapshots (weekly granularity = privacy boundary). */
export function _modeDistribution(weeklySnapshots) {
  if (!weeklySnapshots || weeklySnapshots.length === 0) return {};
  const counts = { BUILD: 0, EDIT: 0, DEBUG: 0, MAINTAIN: 0, IDLE: 0 };
  for (const w of weeklySnapshots) {
    counts[w.mode] = (counts[w.mode] || 0) + 1;
  }
  const total = weeklySnapshots.length;
  const dist = {};
  for (const [mode, count] of Object.entries(counts)) {
    if (count > 0) dist[mode] = Math.round((count / total) * 100) / 100;
  }
  return dist;
}

/** Mode-weighted yield — average yield weighted by mode distribution. */
export function _modeWeightedYield(weeklySnapshots) {
  if (!weeklySnapshots || weeklySnapshots.length === 0) return 0;
  const total = weeklySnapshots.length;
  const sum = weeklySnapshots.reduce((acc, w) => acc + (w.yield || 0), 0);
  return Math.round(sum / total);
}

/** Peak yield across all weekly snapshots. */
export function _peakYield(weeklySnapshots) {
  if (!weeklySnapshots || weeklySnapshots.length === 0) return 0;
  return Math.max(...weeklySnapshots.map((w) => w.yield || 0));
}

/** Health score (0-100) — weighted composite of consistency, momentum, quality. */
export function _healthScore(weeklySnapshots, modeWeightedYield) {
  if (!weeklySnapshots || weeklySnapshots.length === 0) return 0;
  // Simplified Phase 1 formula:
  //  40% — consistency (how often in MAINTAIN)
  //  30% — momentum (recent yield vs older yield)
  //  30% — quality (mode-weighted yield relative to MAINTAIN expected)
  const dist = _modeDistribution(weeklySnapshots);
  const maintainShare = dist.MAINTAIN || 0;
  const consistency = Math.min(maintainShare, 1) * 40;

  // Momentum: compare last 3 weeks to first 3 weeks
  const recent = weeklySnapshots.slice(-3);
  const older = weeklySnapshots.slice(0, 3);
  const recentAvg =
    recent.reduce((a, w) => a + (w.yield || 0), 0) / (recent.length || 1);
  const olderAvg =
    older.reduce((a, w) => a + (w.yield || 0), 0) / (older.length || 1);
  const momentumRatio = olderAvg > 0 ? recentAvg / olderAvg : 1;
  const momentum = (Math.min(momentumRatio, 2) / 2) * 30;

  // Quality: mode-weighted yield vs MAINTAIN expected (5000)
  const quality = Math.min(modeWeightedYield / 5000, 1) * 30;

  return Math.round(consistency + momentum + quality);
}

/** Yield for the last N days (from weekly snapshots — approximates by summing recent weeks). */
export function _yieldForDays(weeklySnapshots, days) {
  if (!weeklySnapshots || weeklySnapshots.length === 0) return 0;
  const weeksNeeded = Math.ceil(days / 7);
  const recent = weeklySnapshots.slice(-weeksNeeded);
  if (recent.length === 0) return 0;
  const sum = recent.reduce((a, w) => a + (w.yield || 0), 0);
  return Math.round(sum / recent.length); // average weekly yield
}

/** Trajectory description from 7d/30d/90d yields. */
export function _trajectory(y7, y30, y90) {
  if (y90 === 0) return "insufficient_data";
  const r7v30 = y30 > 0 ? y7 / y30 : 1;
  const r30v90 = y90 > 0 ? y30 / y90 : 1;
  if (r7v30 > 1.2 && r30v90 > 1.0) return "accelerating";
  if (r7v30 > 1.2) return "recent_surge";
  if (r7v30 < 0.8 && r30v90 < 0.8) return "declining";
  if (r7v30 < 0.8) return "recent_dip";
  if (r30v90 > 1.1) return "steady_growth";
  return "stable";
}

/** Phase pattern description from mode distribution over time. */
export function _phasePattern(weeklySnapshots) {
  if (!weeklySnapshots || weeklySnapshots.length < 2)
    return "insufficient_data";
  const modes = weeklySnapshots.map((w) => w.mode);
  const transitions = [];
  for (let i = 1; i < modes.length; i++) {
    if (modes[i] !== modes[i - 1]) {
      transitions.push(`${modes[i - 1]}→${modes[i]}`);
    }
  }
  if (transitions.length === 0) return `consistent_${modes[0].toLowerCase()}`;
  // Check for smooth transitions (BUILD→MAINTAIN without DEBUG)
  const smooth = transitions.every((t) => !t.includes("DEBUG"));
  if (smooth && transitions.some((t) => t === "BUILD→MAINTAIN"))
    return "smooth_ramp";
  if (transitions.filter((t) => t.includes("DEBUG")).length > 2)
    return "erratic";
  return "cyclical";
}

/** Daily assessment string. */
export function _dailyAssessment(mode, yieldVal, qualityScoreVal, expectedYield) {
  const qsPct = Math.round(qualityScoreVal * 100);
  if (mode === "IDLE")
    return "You're idle — no significant token activity today.";
  if (mode === "MAINTAIN") {
    if (qualityScoreVal >= 0.5)
      return `You're in MAINTAIN mode. Yield ${yieldVal} is ${qsPct}% of MAINTAIN norm. The cascade is compounding.`;
    return `You're in MAINTAIN mode but yield ${yieldVal} is only ${qsPct}% of expected (${expectedYield}). You may be coasting — push for more output.`;
  }
  if (mode === "BUILD") {
    if (qualityScoreVal >= 0.5)
      return `You're in BUILD mode. Yield ${yieldVal} is ${qsPct}% of BUILD norm. Greenfield work — expected to be low.`;
    return `You're in BUILD mode. Yield ${yieldVal} is ${qsPct}% of expected (${expectedYield}). Building is slow — keep going.`;
  }
  if (mode === "EDIT") {
    if (qualityScoreVal >= 0.5)
      return `You're in EDIT mode. Yield ${yieldVal} is ${qsPct}% of EDIT norm. Fresh input but producing — good.`;
    return `You're in EDIT mode. Yield ${yieldVal} is ${qsPct}% of expected (${expectedYield}). Push for more output per input.`;
  }
  if (mode === "DEBUG") {
    if (qualityScoreVal >= 0.5)
      return `You're in DEBUG mode. Yield ${yieldVal} is ${qsPct}% of DEBUG norm. Investigating — yield is expected to be low.`;
    return `You're in DEBUG mode. Yield ${yieldVal} is ${qsPct}% of expected (${expectedYield}). Debugging is slow — consider loading prior context.`;
  }
  return `Mode: ${mode}. Yield: ${yieldVal}. Quality: ${qsPct}%.`;
}

/** Daily advice string. */
export function _dailyAdvice(mode, yieldVal, qs) {
  if (mode === "MAINTAIN" && qs >= 0.5)
    return "Keep the cascade going. Don't reset context — let it compound.";
  if (mode === "MAINTAIN")
    return "You're in MAINTAIN but underperforming. Push the agent for more output per turn.";
  if (mode === "BUILD")
    return "When you're done building, load prior context to transition to MAINTAIN. The cascade rewards reuse.";
  if (mode === "EDIT")
    return "You're producing but using fresh input. Try to reuse prior context to boost leverage.";
  if (mode === "DEBUG")
    return "When you're done debugging, load prior context to return to MAINTAIN. Don't let the debug phase drag on.";
  if (mode === "IDLE")
    return "No activity detected. Start a session to build your cascade.";
  return "Keep working — the cascade will compound as you build context.";
}
