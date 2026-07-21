/**
 * tools/self-improve.mjs — self_improve tool.
 */

import { cascade, parsePillars, detectMode, qualityScore, MODE_EXPECTED_YIELD } from "../analytics/cascade.mjs";
import { computeBadges } from "../badges.mjs";
import { CASCADE_OUTPUT, ANNOTATIONS } from "./_schemas.mjs";
import { MAX_INPUT, withParseWarnings } from "./_helpers.mjs";
import {
  _pullDailyRows,
  _compoundWeekly,
  _modeDistribution,
  _modeWeightedYield,
  _peakYield,
  _healthScore,
  _yieldForDays,
  _trajectory,
  _phasePattern,
  _dailyAssessment,
  _dailyAdvice,
} from "./_report.mjs";

export const TOOL_DEF = {
  name: "self_improve",
  description:
    "Runs the full self-improvement cycle in one call: (1) gets your current token pillars — either from the provided text or by running tokenpull on your local logs, (2) diagnoses where you're leaking efficiency (diagnose_cascade), (3) generates ranked improvement suggestions (suggest_improvements), (4) simulates the top suggestion (simulate_change), and (5) returns the complete cycle: diagnosis + suggestions + the simulated impact of the best change. This is the 'one-click optimize' tool — call it at the end of a session to see what to improve next time. If you provide pillars in `text`, it skips the tokenpull step. If you omit `text`, it runs tokenpull first (requires local ccusage logs). Pure local math — no network, no submission. The `scope` parameter adds mode detection (BUILD/EDIT/DEBUG/MAINTAIN/IDLE) and scoped analysis: 'daily' (default — current behavior + mode), 'weekly' (compound into weekly snapshots + report artifact), 'trend' (30d/90d trajectory analysis).",
  annotations: {
    title: "Self-improve plan",
    ...ANNOTATIONS.readOnlyHint,
    ...ANNOTATIONS.idempotentHint,
    ...ANNOTATIONS.openWorldHint,
  },
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description:
          'Optional: token pillars — ccusage JSON or "input output cacheCreate cacheRead". If omitted, runs tokenpull to get current pillars from local logs.',
      },
      window: {
        type: "string",
        enum: ["7d", "30d", "90d", "all"],
        description:
          "Which time window to pull when running tokenpull (default: 30d). Ignored if `text` is provided.",
      },
      scope: {
        type: "string",
        enum: ["daily", "weekly", "trend"],
        description:
          'Analysis scope: "daily" (default — current behavior + mode detection), "weekly" (compound daily rows into weekly snapshots + report artifact with badges), "trend" (30d/90d trajectory + phase patterns). Daily modes never leave the machine — only weekly distribution goes in submitted reports.',
      },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      pillars: {
        type: "object",
        description: "The 4 raw token pillars used",
      },
      current_cascade: CASCADE_OUTPUT,
      diagnosis: {
        type: "array",
        description: "Efficiency leaks found (from diagnose_cascade)",
      },
      suggestions: {
        type: "array",
        description: "Ranked improvements (from suggest_improvements)",
      },
      best_simulation: {
        type: "object",
        description: "Simulated result of the top suggestion",
      },
      cycle_summary: {
        type: "string",
        description: "One-line summary of the full cycle",
      },
      // Scope-specific fields
      mode: {
        type: "object",
        description:
          "Detected mode { mode, confidence } — present when scope is daily/weekly/trend",
      },
      quality_score: {
        type: "number",
        description: "Yield relative to mode expectation (daily scope)",
      },
      assessment: {
        type: "string",
        description: "One-line assessment for daily scope",
      },
      advice: {
        type: "string",
        description: "Advice for next session (daily scope)",
      },
      report: {
        type: "object",
        description: "Weekly report artifact (weekly scope)",
      },
      trend: { type: "object", description: "Trend analysis (trend scope)" },
    },
  },
};

export async function handleSelfImprove(args, ctx) {
  // The full self-improvement cycle: pull → diagnose → suggest → simulate.
  // If text is provided, use it as pillars. If not, run tokenpull first.
  let pillars;
  let pulledFrom = "provided";

  if (args?.text) {
    if (typeof args.text === "string" && args.text.length > MAX_INPUT) {
      return {
        status: "error",
        reason: "input_too_large",
        detail: `text exceeds ${MAX_INPUT} chars.`,
      };
    }
    pillars = parsePillars(args.text);
  } else {
    // Run tokenpull to get current pillars from local logs
    const windowType = args?.window || "30d";
    try {
      const pullResult = await ctx.callTool(
        "tokenpull",
        { window: windowType },
      );
      if (pullResult?.status === "error" || !pullResult?.windows?.length) {
        return {
          status: "error",
          reason: "tokenpull_failed",
          detail:
            "Could not pull pillars from local logs. Provide pillars via `text` argument instead.",
          pull_result: pullResult,
        };
      }
      // Use the first window's pillars
      const w = pullResult.windows[0];
      pillars = w.pillars;
      pulledFrom = `tokenpull ${w.window || windowType}`;
    } catch (e) {
      return {
        status: "error",
        reason: "tokenpull_error",
        detail: String(e.message || e),
        hint: "Provide pillars via `text` argument instead.",
      };
    }
  }

  const currentResult = withParseWarnings(pillars, cascade(pillars));
  const { input: i, output: o, cacheCreate: cw, cacheRead: cr } = pillars;

  // ── Step 1: Diagnose ──────────────────────────────────────────────
  const diagnosis = [];
  const leverage = currentResult.leverage;
  if (leverage !== null && leverage < 10) {
    diagnosis.push({
      metric: "cache_leverage",
      severity: "critical",
      finding: `Cache leverage is ${leverage}× — TRANSMITTER-class operators hit 200×+.`,
      recommendation:
        "Increase context reuse: load prior session context, use longer threads.",
    });
  } else if (leverage !== null && leverage < 50) {
    diagnosis.push({
      metric: "cache_leverage",
      severity: "warning",
      finding: `Cache leverage is ${leverage}× — below ARCH+ threshold (~100×+).`,
      recommendation: "Push cache reads higher by reusing prior context.",
    });
  }

  const velocity = currentResult.velocity;
  if (velocity !== null && velocity < 0.5) {
    diagnosis.push({
      metric: "velocity",
      severity: "critical",
      finding: `Velocity is ${velocity} — generating only ${velocity}× input as output.`,
      recommendation: "Increase output per turn, reduce over-reading.",
    });
  } else if (velocity !== null && velocity < 1.0) {
    diagnosis.push({
      metric: "velocity",
      severity: "warning",
      finding: `Velocity is ${velocity} — below 1.0. Healthy operators hit 1.5×+.`,
      recommendation: "Generate more output per input token.",
    });
  }

  if (currentResult.dev10x === null && cw === 0) {
    diagnosis.push({
      metric: "10xdev",
      severity: "critical",
      finding: "No cache creation — cascade cannot compound.",
      recommendation:
        "Switch to a platform with prompt caching (Claude Code).",
    });
  }

  const total = i + o + cw + cr;
  if (total > 0 && (i / total) * 100 > 10) {
    diagnosis.push({
      metric: "input_bloat",
      severity: "warning",
      finding: `Fresh input is ${((i / total) * 100).toFixed(1)}% of total flow — efficient operators keep it under 1%.`,
      recommendation: "Reduce fresh input by reusing prior context.",
    });
  }

  // ── Step 2: Suggest (generate + simulate candidates) ──────────────
  const candidates = [];
  // If cacheRead is 0, suggest absolute amounts instead of percentage boosts
  const crBoosts = cr > 0 ? [1.5, 2, 3, 5] : [];
  for (const mult of crBoosts) {
    const sim = cascade({ ...pillars, cacheRead: Math.round(cr * mult) });
    if (sim.yield !== null)
      candidates.push({
        action: `Increase cache reads by ${Math.round((mult - 1) * 100)}%`,
        pillar: "cacheRead",
        delta: `+${Math.round(cr * (mult - 1)).toLocaleString()}`,
        simulated_yield: sim.yield,
        yield_delta: Number(
          (sim.yield - (currentResult.yield ?? 0)).toFixed(2),
        ),
        class_after: sim.class,
        rationale: "Cache reads are the strongest Υ multiplier.",
      });
  }
  // For zero-cache operators, suggest enabling caching with a starter amount
  if (cr === 0 && cw === 0) {
    const starterAmounts = [
      Math.round(i * 10),
      Math.round(i * 50),
      Math.round(i * 100),
    ];
    for (const amt of starterAmounts) {
      const sim = cascade({
        ...pillars,
        cacheCreate: Math.round(amt * 0.5),
        cacheRead: amt,
      });
      if (sim.yield !== null && sim.yield > 0)
        candidates.push({
          action: `Enable caching with ${amt.toLocaleString()} cache reads`,
          pillar: "cacheRead",
          delta: `+${amt.toLocaleString()}`,
          simulated_yield: sim.yield,
          yield_delta: Number(
            (sim.yield - (currentResult.yield ?? 0)).toFixed(2),
          ),
          class_after: sim.class,
          rationale:
            "You have no cache — enabling it unlocks the cascade. Start by reusing prior context.",
        });
    }
  }
  for (const mult of [0.9, 0.75, 0.5]) {
    const newInput = Math.round(i * mult);
    if (newInput < 1) continue;
    const sim = cascade({ ...pillars, input: newInput });
    if (sim.yield !== null)
      candidates.push({
        action: `Reduce fresh input by ${Math.round((1 - mult) * 100)}%`,
        pillar: "input",
        delta: `-${Math.round(i * (1 - mult)).toLocaleString()}`,
        simulated_yield: sim.yield,
        yield_delta: Number(
          (sim.yield - (currentResult.yield ?? 0)).toFixed(2),
        ),
        class_after: sim.class,
        rationale: "Input is squared in Υ denominator — quadratic payoff.",
      });
  }
  for (const mult of [1.25, 1.5, 2]) {
    const sim = cascade({ ...pillars, output: Math.round(o * mult) });
    if (sim.yield !== null)
      candidates.push({
        action: `Increase output by ${Math.round((mult - 1) * 100)}%`,
        pillar: "output",
        delta: `+${Math.round(o * (mult - 1)).toLocaleString()}`,
        simulated_yield: sim.yield,
        yield_delta: Number(
          (sim.yield - (currentResult.yield ?? 0)).toFixed(2),
        ),
        class_after: sim.class,
        rationale: "Output is a linear multiplier in Υ.",
      });
  }
  candidates.sort((a, b) => b.yield_delta - a.yield_delta);
  const suggestions = candidates
    .slice(0, 8)
    .map((c, idx) => ({ rank: idx + 1, ...c }));

  // ── Step 3: Simulate the top suggestion ───────────────────────────
  const best = suggestions[0];
  let bestSimulation = null;
  if (best) {
    const simPillars = { ...pillars };
    const delta = parseInt(best.delta.replace(/[+\-,]/g, ""), 10);
    if (best.pillar === "cacheRead") simPillars.cacheRead = cr + delta;
    else if (best.pillar === "input")
      simPillars.input = Math.max(i - delta, 1);
    else if (best.pillar === "output") simPillars.output = o + delta;
    const simResult = cascade(simPillars);
    bestSimulation = {
      action: best.action,
      current_yield: currentResult.yield,
      simulated_yield: simResult.yield,
      yield_delta: best.yield_delta,
      current_class: currentResult.class,
      simulated_class: simResult.class,
      class_changed: currentResult.class !== simResult.class,
    };
  }

  // ── Step 4: Cycle summary ─────────────────────────────────────────
  const criticalCount = diagnosis.filter(
    (d) => d.severity === "critical",
  ).length;
  const cycleSummary = best
    ? `Pulled from ${pulledFrom}. Υ ${currentResult.yield} (${currentResult.class}). ${criticalCount} critical, ${diagnosis.length - criticalCount} other findings. Best: ${best.action} → Υ ${best.simulated_yield} (+${best.yield_delta}).`
    : `Pulled from ${pulledFrom}. Υ ${currentResult.yield} (${currentResult.class}). ${diagnosis.length} findings. No improvements suggested — cascade is optimized.`;

  // ── Step 5: Scope-specific analysis ───────────────────────────────
  const scope = args?.scope || "daily";
  const modeInfo = currentResult.mode; // { mode, confidence }
  const scopeResult = {};

  if (scope === "daily") {
    // Daily: mode + quality score + assessment + advice
    const qs = qualityScore(currentResult.yield ?? 0, modeInfo.mode);
    const expected = MODE_EXPECTED_YIELD[modeInfo.mode] ?? 0;
    const assessment = _dailyAssessment(
      modeInfo.mode,
      currentResult.yield,
      qs,
      expected,
    );
    const advice = _dailyAdvice(modeInfo.mode, currentResult.yield, qs);
    scopeResult.mode = modeInfo;
    scopeResult.quality_score = Math.round(qs * 100) / 100;
    scopeResult.assessment = assessment;
    scopeResult.advice = advice;
  }

  if (scope === "weekly" || scope === "trend") {
    // Pull daily rows from ccusage to build weekly snapshots
    const dailyRows = await _pullDailyRows(ctx.opts);
    const weeklySnapshots = _compoundWeekly(dailyRows);
    const modeDistribution = _modeDistribution(weeklySnapshots);
    const modeWeightedYield = _modeWeightedYield(weeklySnapshots);

    // Compute badges
    const historyForBadges = weeklySnapshots.map((w) => ({
      date: w.weekStart,
      mode: w.mode,
      yield: w.yield,
      pillars: w.pillars,
    }));
    const badges = computeBadges({
      pillars,
      cascade: currentResult,
      history: historyForBadges,
      isVerified: false, // set by submit_verified
      rank: null, // server-side
    });

    if (scope === "weekly") {
      scopeResult.mode = modeInfo;
      // Strip dailyModes from weekly_snapshots — privacy boundary (daily modes never leave the machine)
      const safeSnapshots = weeklySnapshots.map(
        ({ dailyModes, ...rest }) => rest,
      );
      scopeResult.report = {
        current_mode: modeInfo.mode,
        mode_confidence: modeInfo.confidence,
        mode_distribution: modeDistribution,
        mode_weighted_yield: modeWeightedYield,
        peak_yield: _peakYield(weeklySnapshots),
        health_score: _healthScore(weeklySnapshots, modeWeightedYield),
        weekly_snapshots: safeSnapshots,
        badges,
      };
    }

    if (scope === "trend") {
      const yield7d = _yieldForDays(weeklySnapshots, 7);
      const yield30d = _yieldForDays(weeklySnapshots, 30);
      const yield90d = _yieldForDays(weeklySnapshots, 90);
      const trajectory = _trajectory(yield7d, yield30d, yield90d);
      scopeResult.mode = modeInfo;
      scopeResult.trend = {
        yield_7d: yield7d,
        yield_30d: yield30d,
        yield_90d: yield90d,
        trajectory,
        mode_distribution: modeDistribution,
        phase_pattern: _phasePattern(weeklySnapshots),
      };
    }
  }

  return {
    pillars,
    current_cascade: {
      yield_: currentResult.yield,
      snr: currentResult.snr,
      leverage: currentResult.leverage,
      velocity: currentResult.velocity,
      tenx_dev: currentResult.dev10x,
      class: currentResult.class,
      mode: modeInfo,
      warnings: currentResult.warnings,
    },
    diagnosis,
    suggestions,
    best_simulation: bestSimulation,
    cycle_summary: cycleSummary,
    ...scopeResult,
  };
}
