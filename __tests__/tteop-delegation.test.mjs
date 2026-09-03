/**
 * __tests__/tteop-delegation.test.mjs — Proves sigrank-mcp resolves canonical
 * TTEOP metric computation through @sigrank/cascade → tteop-spec.
 *
 * This test verifies:
 *   1. The cascade() function in analytics/cascade.mjs produces results
 *      identical to tteop-spec's computeMetrics() for the canonical vector.
 *   2. Banker's rounding is used (not round-half-up), matching tteop-spec.
 *   3. The get_sigrank_standard_record tool produces metrics consistent
 *      with tteop-spec canonical computation.
 *   4. Product extensions (mode, class) are present and separate from TTEOP.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { cascade, round } from "../cascade.mjs";
import { handleGetSigRankStandardRecord } from "../tools/standard-record.mjs";
import { computeMetrics, roundHalfToEven } from "tteop-spec";

// ─── 1. Cascade matches tteop-spec for canonical vector ─────────────────────

test("cascade() matches tteop-spec computeMetrics() for canonical MOSES vector", () => {
  const telemetry = {
    input: 1251211,
    output: 11296121,
    cache_write: 128196310,
    cache_read: 2555179769,
  };
  const tteopResult = computeMetrics(telemetry);
  const cascadeResult = cascade({
    input: telemetry.input,
    output: telemetry.output,
    cacheCreate: telemetry.cache_write,
    cacheRead: telemetry.cache_read,
  });

  assert.equal(cascadeResult.yield, tteopResult.metrics.yield);
  assert.equal(cascadeResult.leverage, tteopResult.metrics.leverage);
  assert.equal(cascadeResult.velocity, tteopResult.metrics.velocity);
  assert.equal(cascadeResult.snr, tteopResult.metrics.output_fraction);
  assert.equal(cascadeResult.dev10x, tteopResult.metrics.log_leverage);

  // Canonical invariants
  assert.equal(cascadeResult.yield, 18436.98);
  assert.equal(cascadeResult.snr, 0.9003);
  assert.equal(cascadeResult.dev10x, 3.31);
});

// ─── 2. Banker's rounding (no drift between SigRank and TTEOP) ───────────────

test("round() uses banker's rounding matching tteop-spec (no drift)", () => {
  // These half-value cases would differ under round-half-up (toFixed)
  assert.equal(round(0.5, 0), roundHalfToEven(0.5, 0), "0.5 → 0 (even)");
  assert.equal(round(2.5, 0), roundHalfToEven(2.5, 0), "2.5 → 2 (even)");
  assert.equal(round(1.25, 1), roundHalfToEven(1.25, 1), "1.25 → 1.2 (even)");
  assert.equal(round(0.625, 2), roundHalfToEven(0.625, 2), "0.625 → 0.62 (even)");
});

// ─── 3. get_sigrank_standard_record consistent with tteop-spec ───────────────

test("get_sigrank_standard_record metrics match tteop-spec computeMetrics()", async () => {
  const record = await handleGetSigRankStandardRecord({
    input: 1_251_211,
    output: 11_296_121,
    cache_write: 128_196_310,
    cache_read: 2_555_179_769,
  });

  const tteopResult = computeMetrics({
    input: 1_251_211,
    output: 11_296_121,
    cache_write: 128_196_310,
    cache_read: 2_555_179_769,
  });

  assert.equal(record.metrics.yield, tteopResult.metrics.yield);
  assert.equal(record.metrics.leverage, tteopResult.metrics.leverage);
  assert.equal(record.metrics.velocity, tteopResult.metrics.velocity);
  assert.equal(record.metrics.snr, tteopResult.metrics.output_fraction);
  assert.equal(record.metrics.dev10x, tteopResult.metrics.log_leverage);
});

// ─── 4. Product extensions present and separate from TTEOP ──────────────────

test("cascade() includes product extensions (mode, class) not in TTEOP", () => {
  const result = cascade({
    input: 1251211,
    output: 11296121,
    cacheCreate: 128196310,
    cacheRead: 2555179769,
  });

  // mode is a SigRank product extension, not a TTEOP metric
  assert.ok(result.mode, "mode field present");
  assert.ok(result.mode.mode, "mode.mode present");
  assert.equal(typeof result.mode.mode, "string");

  // class is a SigRank product extension (RS05 taxonomy), not a TTEOP metric
  assert.ok(result.class, "class field present");
  assert.equal(typeof result.class, "string");
});
