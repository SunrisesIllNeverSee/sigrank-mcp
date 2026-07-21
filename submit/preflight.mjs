/**
 * preflight.mjs — local plausibility pre-checks for the MCP submit path.
 *
 * Mirrors ONLY the server's public plausibility gate (gates.ts:86-137) —
 * totals consistency, turns/sessions ratios, output rate, cache ratio,
 * cadence. These are integrity guards labeled "NOT the proprietary RS.xx"
 * and are safe to replicate in an open agent.
 *
 * The proprietary battery (Benford / cadence / contamination) is SERVER-ONLY
 * and must NOT be shipped in the agent. The server always runs its own
 * battery after the POST — this preflight is a client-side preview of the
 * public plausibility checks only, not a replacement for the full gate chain.
 *
 * If preflight flags, the operator sees WHY their submission would be
 * rejected or flagged, and can fix the issue or submit anyway.
 *
 * Source of truth: lib/ingest/gates.ts (plausibilityGate). This port must
 * stay in sync with the plausibility gate ONLY.
 */

// ── plausibility checks (from gates.ts:86-137) ──────────────────────────────

const GATE_LIMITS = {
  TOTALS_TOLERANCE_FRAC: 0.01,
  MAX_OUTPUT_TOKENS_PER_MIN: 20_000,
  // Tightened range-plausibility bounds (deviewreview3)
  MAX_CACHE_REUSE_RATIO: 35,
  MIN_CACHE_WRITE_RATIO: 0.5,
  MIN_INPUT_SHARE_FRAC: 0.0003,
  MAX_CADENCE_PER_MIN: 15,
};

/**
 * Run plausibility checks against a payload's raw_telemetry.
 * Returns array of issues: { severity, code, detail }
 */
export function plausibilityCheck(rt, window) {
  const out = [];
  const pillars =
    rt.tokens_input_fresh +
    rt.tokens_output +
    rt.tokens_cache_read +
    rt.tokens_cache_creation;

  if (rt.tokens_total > 0) {
    const tol = Math.max(
      1,
      rt.tokens_total * GATE_LIMITS.TOTALS_TOLERANCE_FRAC,
    );
    if (Math.abs(pillars - rt.tokens_total) > tol) {
      out.push({
        severity: "reject",
        code: "totals_inconsistent",
        detail: `Σ4 pillars (${pillars}) ≠ tokens_total (${rt.tokens_total})`,
      });
    }
    if (rt.sessions_count === 0) {
      out.push({
        severity: "reject",
        code: "tokens_without_sessions",
        detail: `tokens_total ${rt.tokens_total} with sessions_count 0`,
      });
    }
  }
  if (rt.turns_total < rt.sessions_count) {
    out.push({
      severity: "reject",
      code: "turns_lt_sessions",
      detail: `turns_total ${rt.turns_total} < sessions_count ${rt.sessions_count}`,
    });
  }
  if (rt.tokens_output > 0 && rt.turns_total === 0) {
    out.push({
      severity: "reject",
      code: "output_without_turns",
      detail: `tokens_output ${rt.tokens_output} with turns_total 0`,
    });
  }

  if (window) {
    const spanMin =
      (Date.parse(window.end) - Date.parse(window.start)) / 60_000;
    if (Number.isFinite(spanMin) && rt.active_minutes_est > spanMin + 1) {
      out.push({
        severity: "flag",
        code: "active_exceeds_window",
        detail: `active_minutes_est ${rt.active_minutes_est} > window span ${Math.round(spanMin)}m`,
      });
    }
  }

  const outPerMin = rt.tokens_output / Math.max(rt.active_minutes_est, 1);
  if (outPerMin > GATE_LIMITS.MAX_OUTPUT_TOKENS_PER_MIN) {
    out.push({
      severity: "flag",
      code: "implausible_output_rate",
      detail: `${Math.round(outPerMin)} output tok/min > ${GATE_LIMITS.MAX_OUTPUT_TOKENS_PER_MIN}`,
    });
  }

  // Cross-field ratio checks (defense-in-depth — also in the plausibility gate)
  // Bounds tightened (deviewreview3): original 100:1 + 50/min were too loose.
  if (rt.tokens_cache_read > 1_000 && rt.tokens_cache_creation === 0) {
    out.push({
      severity: "flag",
      code: "cache_without_creation",
      detail: `${rt.tokens_cache_read} cache_read with 0 cache_creation (impossible cascade)`,
    });
  }
  if (
    rt.tokens_cache_creation > 0 &&
    rt.tokens_cache_read / rt.tokens_cache_creation >
      GATE_LIMITS.MAX_CACHE_REUSE_RATIO
  ) {
    out.push({
      severity: "flag",
      code: "extreme_cache_ratio",
      detail: `cache_read/cache_creation = ${(rt.tokens_cache_read / rt.tokens_cache_creation).toFixed(1)}:1 (real max ~30:1)`,
    });
  }
  if (
    rt.tokens_output > 1_000 &&
    rt.tokens_cache_creation / rt.tokens_output <
      GATE_LIMITS.MIN_CACHE_WRITE_RATIO
  ) {
    out.push({
      severity: "flag",
      code: "low_cache_write_ratio",
      detail: `cache_creation/output = ${(rt.tokens_cache_creation / rt.tokens_output).toFixed(2)}:1 (real min ~1.5:1)`,
    });
  }
  if (
    pillars > 10_000 &&
    rt.tokens_input_fresh / pillars < GATE_LIMITS.MIN_INPUT_SHARE_FRAC
  ) {
    out.push({
      severity: "flag",
      code: "implausible_input_share",
      detail: `input is ${((rt.tokens_input_fresh / pillars) * 100).toFixed(3)}% of total (real min ~0.3%)`,
    });
  }
  if (
    rt.active_minutes_est > 0 &&
    rt.turns_total / rt.active_minutes_est > GATE_LIMITS.MAX_CADENCE_PER_MIN
  ) {
    out.push({
      severity: "flag",
      code: "implausible_cadence",
      detail: `${(rt.turns_total / rt.active_minutes_est).toFixed(1)} turns/min (real: 0.5-10)`,
    });
  }

  return out;
}

// ── full preflight (plausibility only — NO battery) ─────────────────────────

/**
 * Run preflight plausibility checks against a payload. Returns:
 *   { pass: true, issues: [] }                    — clean submission
 *   { pass: false, issues: [...], wouldDowngrade } — would be flagged/rejected
 *
 * NOTE: this only mirrors the PUBLIC plausibility gate. The server runs
 * additional proprietary checks (the battery) that this preflight does NOT
 * replicate. A "pass" here means "passes the plausibility gate," not
 * "guaranteed to pass all server gates."
 */
export function preflight(payload) {
  const issues = plausibilityCheck(payload.raw_telemetry, payload.window);

  const hasReject = issues.some((i) => i.severity === "reject");
  const hasFlag = issues.some((i) => i.severity === "flag");

  return {
    pass: issues.length === 0,
    wouldReject: hasReject,
    wouldDowngrade: hasFlag,
    issues,
    summary: hasReject
      ? `REJECT: ${issues
          .filter((i) => i.severity === "reject")
          .map((i) => i.code)
          .join(", ")}`
      : hasFlag
        ? `FLAG (verified → flagged, not ranked): ${issues
            .filter((i) => i.severity === "flag")
            .map((i) => i.code)
            .join(", ")}`
        : "clean — passes plausibility gate (server runs additional proprietary checks)",
  };
}
