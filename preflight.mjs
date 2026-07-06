/**
 * preflight.mjs — local anti-gaming pre-checks for the MCP submit path.
 *
 * Ports the server's plausibility gate + battery (Benford + contamination)
 * so the agent can warn the operator BEFORE submitting. The server always
 * runs its own checks — this is a client-side preview, not a replacement.
 *
 * If preflight flags, the operator sees WHY their submission would get
 * downgraded from verified → flagged (not ranked), and can fix the issue
 * or submit anyway.
 *
 * Source of truth: lib/ingest/gates.ts (plausibilityGate) + lib/ingest/battery.ts
 * (benfordCheck + contaminationCheck). These ports must stay in sync.
 */

// ── plausibility checks (from gates.ts:86-137) ──────────────────────────────

const GATE_LIMITS = {
  TOTALS_TOLERANCE_FRAC: 0.01,
  MAX_OUTPUT_TOKENS_PER_MIN: 20_000,
}

/**
 * Run plausibility checks against a payload's raw_telemetry.
 * Returns array of issues: { severity, code, detail }
 */
export function plausibilityCheck(rt, window) {
  const out = []
  const pillars = rt.tokens_input_fresh + rt.tokens_output + rt.tokens_cache_read + rt.tokens_cache_creation

  if (rt.tokens_total > 0) {
    const tol = Math.max(1, rt.tokens_total * GATE_LIMITS.TOTALS_TOLERANCE_FRAC)
    if (Math.abs(pillars - rt.tokens_total) > tol) {
      out.push({ severity: 'reject', code: 'totals_inconsistent', detail: `Σ4 pillars (${pillars}) ≠ tokens_total (${rt.tokens_total})` })
    }
    if (rt.sessions_count === 0) {
      out.push({ severity: 'reject', code: 'tokens_without_sessions', detail: `tokens_total ${rt.tokens_total} with sessions_count 0` })
    }
  }
  if (rt.turns_total < rt.sessions_count) {
    out.push({ severity: 'reject', code: 'turns_lt_sessions', detail: `turns_total ${rt.turns_total} < sessions_count ${rt.sessions_count}` })
  }
  if (rt.tokens_output > 0 && rt.turns_total === 0) {
    out.push({ severity: 'reject', code: 'output_without_turns', detail: `tokens_output ${rt.tokens_output} with turns_total 0` })
  }

  if (window) {
    const spanMin = (Date.parse(window.end) - Date.parse(window.start)) / 60_000
    if (Number.isFinite(spanMin) && rt.active_minutes_est > spanMin + 1) {
      out.push({ severity: 'flag', code: 'active_exceeds_window', detail: `active_minutes_est ${rt.active_minutes_est} > window span ${Math.round(spanMin)}m` })
    }
  }

  const outPerMin = rt.tokens_output / Math.max(rt.active_minutes_est, 1)
  if (outPerMin > GATE_LIMITS.MAX_OUTPUT_TOKENS_PER_MIN) {
    out.push({ severity: 'flag', code: 'implausible_output_rate', detail: `${Math.round(outPerMin)} output tok/min > ${GATE_LIMITS.MAX_OUTPUT_TOKENS_PER_MIN}` })
  }

  // Cross-field ratio checks (defense-in-depth — battery checks these too)
  if (rt.tokens_cache_read > 1_000 && rt.tokens_cache_creation === 0) {
    out.push({ severity: 'flag', code: 'cache_without_creation', detail: `${rt.tokens_cache_read} cache_read with 0 cache_creation (impossible cascade)` })
  }
  if (rt.tokens_cache_creation > 0 && rt.tokens_cache_read / rt.tokens_cache_creation > 100) {
    out.push({ severity: 'flag', code: 'extreme_cache_ratio', detail: `cache_read/cache_creation = ${(rt.tokens_cache_read / rt.tokens_cache_creation).toFixed(1)}:1 (real max ~30:1)` })
  }
  if (rt.active_minutes_est > 0 && rt.turns_total / rt.active_minutes_est > 50) {
    out.push({ severity: 'flag', code: 'implausible_cadence', detail: `${(rt.turns_total / rt.active_minutes_est).toFixed(1)} turns/min (real: 0.5-10)` })
  }

  return out
}

// ── battery checks (from battery.ts:37-107) ─────────────────────────────────

/**
 * Benford check — flags if < 25% of leading digits are 1-3.
 * Ported from lib/ingest/battery.ts:37-56.
 */
export function benfordCheck(rt) {
  const vals = [
    rt.tokens_input_fresh,
    rt.tokens_output,
    rt.tokens_cache_read,
    rt.tokens_cache_creation,
  ].filter((v) => v > 0)
  if (vals.length < 3) return null
  const lead = vals.map((v) => parseInt(String(v)[0], 10))
  const lowFrac = lead.filter((d) => d <= 3).length / lead.length
  if (lowFrac < 0.25) {
    return { code: 'benford_violation', detail: `leading-digit distribution ${Math.round(lowFrac * 100)}% in 1-3 (expected ~60% per Benford's law)` }
  }
  return null
}

/**
 * Contamination check — flags impossible cache patterns.
 * Ported from lib/ingest/battery.ts:87-107.
 */
export function contaminationCheck(rt) {
  if (rt.tokens_cache_read > 1_000 && rt.tokens_cache_creation === 0) {
    return { code: 'contamination_signature', detail: `${rt.tokens_cache_read} cache_read with 0 cache_creation (impossible cascade — must write before read)` }
  }
  if (rt.tokens_cache_creation > 0 && rt.tokens_cache_read / rt.tokens_cache_creation > 100) {
    return { code: 'extreme_cache_ratio', detail: `cache_read/cache_creation = ${(rt.tokens_cache_read / rt.tokens_cache_creation).toFixed(1)}:1 (real max ~30:1)` }
  }
  return null
}

// ── full preflight ──────────────────────────────────────────────────────────

/**
 * Run all preflight checks against a payload. Returns:
 *   { pass: true, issues: [] }                    — clean submission
 *   { pass: false, issues: [...], wouldDowngrade } — would be flagged/rejected
 */
export function preflight(payload) {
  const issues = []

  // Plausibility gate
  const plaus = plausibilityCheck(payload.raw_telemetry, payload.window)
  issues.push(...plaus)

  // Battery: Benford
  const benford = benfordCheck(payload.raw_telemetry)
  if (benford) issues.push({ severity: 'flag', code: benford.code, detail: benford.detail })

  // Battery: contamination
  const contamination = contaminationCheck(payload.raw_telemetry)
  if (contamination) issues.push({ severity: 'flag', code: contamination.code, detail: contamination.detail })

  const hasReject = issues.some((i) => i.severity === 'reject')
  const hasFlag = issues.some((i) => i.severity === 'flag')

  return {
    pass: issues.length === 0,
    wouldReject: hasReject,
    wouldDowngrade: hasFlag,
    issues,
    summary: hasReject
      ? `REJECT: ${issues.filter((i) => i.severity === 'reject').map((i) => i.code).join(', ')}`
      : hasFlag
        ? `FLAG (verified → flagged, not ranked): ${issues.filter((i) => i.severity === 'flag').map((i) => i.code).join(', ')}`
        : 'clean — will pass all server gates',
  }
}
