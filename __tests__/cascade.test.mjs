/**
 * cascade.test.mjs — tests for detectMode() + qualityScore() + mode in cascade().
 *
 * Tests mode detection against all 5 modes with known pillar ratios,
 * and verifies that cascade() now includes mode in its return object.
 */
import {
  cascade,
  detectMode,
  qualityScore,
  MODE_EXPECTED_YIELD,
  parsePillars,
} from "../cascade.mjs";
import assert from "node:assert";

// ── detectMode: all 5 modes ─────────────────────────────────────────────────

// IDLE: near-zero tokens
{
  const r = detectMode({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0 });
  assert.strictEqual(r.mode, "IDLE", "zero tokens → IDLE");
  assert.strictEqual(r.confidence, 1.0, "IDLE confidence 1.0");
}
{
  const r = detectMode({
    input: 200,
    output: 200,
    cacheCreate: 200,
    cacheRead: 200,
  });
  assert.strictEqual(r.mode, "IDLE", "total < 1000 → IDLE");
}

// MAINTAIN: high leverage + high velocity (the cascade is compounding)
{
  // leverage = cr/i = 10000/100 = 100, velocity = o/i = 200/100 = 2
  const r = detectMode({
    input: 100,
    output: 200,
    cacheCreate: 500,
    cacheRead: 10000,
  });
  assert.strictEqual(r.mode, "MAINTAIN", "leverage>10 + velocity>1 → MAINTAIN");
  assert.strictEqual(r.confidence, 0.9, "MAINTAIN high confidence");
}
{
  // leverage = cr/i = 4000/1000 = 4, velocity = o/i = 800/1000 = 0.8
  const r = detectMode({
    input: 1000,
    output: 800,
    cacheCreate: 2000,
    cacheRead: 4000,
  });
  assert.strictEqual(
    r.mode,
    "MAINTAIN",
    "leverage>3 + velocity>0.5 → MAINTAIN",
  );
  assert.strictEqual(r.confidence, 0.7, "MAINTAIN medium confidence");
}

// DEBUG: low velocity + high input share (reading, not producing)
{
  // velocity = o/i = 100/10000 = 0.01, input_share = 10000/10100 = 0.99
  const r = detectMode({
    input: 10000,
    output: 100,
    cacheCreate: 0,
    cacheRead: 0,
  });
  assert.strictEqual(r.mode, "DEBUG", "velocity<0.3 + input_share>0.5 → DEBUG");
  assert.strictEqual(r.confidence, 0.8, "DEBUG high confidence");
}

// EDIT: high input share + high velocity (fresh input but producing)
{
  // leverage = cr/i = 10/3000 = 0.003 (not MAINTAIN)
  // velocity = o/i = 3000/3000 = 1 (not DEBUG primary, velocity >= 0.3)
  // input_share = 3000/6010 = 0.499 > 0.4, velocity > 0.5 → EDIT
  const r = detectMode({
    input: 3000,
    output: 3000,
    cacheCreate: 0,
    cacheRead: 10,
  });
  assert.strictEqual(r.mode, "EDIT", "input_share>0.4 + velocity>0.5 → EDIT");
  assert.strictEqual(r.confidence, 0.7, "EDIT confidence");
}

// BUILD: fallback (high input, no cache reuse)
{
  // leverage = 0/399 = 0 (not MAINTAIN)
  // velocity = 601/399 = 1.5 (not DEBUG primary, velocity >= 0.3)
  // input_share = 399/1000 = 0.399 (not > 0.4, so not EDIT or DEBUG secondary)
  // → BUILD fallback
  const r = detectMode({
    input: 399,
    output: 601,
    cacheCreate: 0,
    cacheRead: 0,
  });
  assert.strictEqual(r.mode, "BUILD", "fallback → BUILD");
  assert.strictEqual(r.confidence, 0.6, "BUILD confidence");
}

// ── MO§ES data: should be MAINTAIN ──────────────────────────────────────────
{
  const MOSES = "1251211 11296121 128196310 2555179769";
  const pillars = parsePillars(MOSES);
  const r = detectMode(pillars);
  // leverage = 2555179769/1251211 = 2042, velocity = 11296121/1251211 = 9.03
  assert.strictEqual(
    r.mode,
    "MAINTAIN",
    "MO§ES → MAINTAIN (leverage 2042×, velocity 9.0)",
  );
  assert.strictEqual(r.confidence, 0.9, "MO§ES MAINTAIN high confidence");
}

// ── cascade() now includes mode ─────────────────────────────────────────────
{
  const MOSES = "1251211 11296121 128196310 2555179769";
  const c = cascade(parsePillars(MOSES));
  assert.ok(c.mode, "cascade result has mode");
  assert.strictEqual(
    c.mode.mode,
    "MAINTAIN",
    "cascade mode = MAINTAIN for MO§ES",
  );
  assert.strictEqual(c.yield, 18436.98, "cascade yield still correct");
}

// ── qualityScore ────────────────────────────────────────────────────────────
{
  // DEBUG session: Υ 8 / expected 10 = 0.80
  const qs = qualityScore(8, "DEBUG");
  assert.strictEqual(qs, 0.8, "DEBUG quality score 80%");
}
{
  // MAINTAIN session: Υ 50 / expected 5000 = 0.01
  const qs = qualityScore(50, "MAINTAIN");
  assert.strictEqual(qs, 0.01, "MAINTAIN quality score 1%");
}
{
  // BUILD session: Υ 12 / expected 15 = 0.80
  const qs = qualityScore(12, "BUILD");
  assert.ok(Math.abs(qs - 0.8) < 0.001, "BUILD quality score 80%");
}
{
  // IDLE: expected 0, actual 0 → 1.0 (perfect idle)
  const qs = qualityScore(0, "IDLE");
  assert.strictEqual(qs, 1.0, "IDLE quality score 100%");
}
{
  // Outperforming: Υ 20000 / expected 5000 = 4.0
  const qs = qualityScore(20000, "MAINTAIN");
  assert.strictEqual(qs, 4.0, "outperforming quality score 400%");
}

// ── MODE_EXPECTED_YIELD ─────────────────────────────────────────────────────
{
  assert.strictEqual(MODE_EXPECTED_YIELD.BUILD, 15, "BUILD expected yield");
  assert.strictEqual(MODE_EXPECTED_YIELD.EDIT, 45, "EDIT expected yield");
  assert.strictEqual(MODE_EXPECTED_YIELD.DEBUG, 10, "DEBUG expected yield");
  assert.strictEqual(
    MODE_EXPECTED_YIELD.MAINTAIN,
    5000,
    "MAINTAIN expected yield",
  );
  assert.strictEqual(MODE_EXPECTED_YIELD.IDLE, 0, "IDLE expected yield");
}

console.log("✓ detectMode: all 5 modes (IDLE, MAINTAIN, DEBUG, EDIT, BUILD)");
console.log("✓ detectMode: MO§ES → MAINTAIN (leverage 2042×, velocity 9.0)");
console.log("✓ cascade() includes mode in return object");
console.log(
  "✓ qualityScore: DEBUG 80%, MAINTAIN 1%, BUILD 80%, IDLE 100%, outperform 400%",
);
console.log("✓ MODE_EXPECTED_YIELD: all 5 mode defaults correct");
