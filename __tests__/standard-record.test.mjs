import assert from "node:assert/strict";
import { handleGetSigRankStandardRecord } from "../tools/standard-record.mjs";

const record = await handleGetSigRankStandardRecord({
  input: 1_251_211,
  output: 11_296_121,
  cache_write: 128_196_310,
  cache_read: 2_555_179_769,
  provider: "anthropic",
  model: "reference-model",
  tool: "test",
  timestamp: "2026-08-27T00:00:00.000Z",
});

assert.equal(record.spec, "sigrank/0.1-draft");
assert.equal(record.timestamp, "2026-08-27T00:00:00.000Z");
assert.deepEqual(record.telemetry, {
  input: 1_251_211,
  output: 11_296_121,
  cache_write: 128_196_310,
  cache_read: 2_555_179_769,
});
assert.equal(record.metrics.yield, 18436.98);
assert.equal(record.metrics.leverage, 2042.2);
assert.equal(record.metrics.velocity, 9.028);
assert.equal(record.metrics.snr, 0.9003);
assert.equal(record.metrics.dev10x, 3.31);
assert.equal(record.metrics.construction, 11.3487);
assert.deepEqual(record.warnings, []);

const degenerate = await handleGetSigRankStandardRecord({
  input: 0,
  output: 0,
  cache_write: 0,
  cache_read: 0,
});
assert.equal(degenerate.metrics.yield, null);
assert.equal(degenerate.metrics.leverage, null);
assert.equal(degenerate.metrics.velocity, null);
assert.equal(degenerate.metrics.snr, null);
assert.equal(degenerate.metrics.dev10x, null);
assert.equal(degenerate.metrics.construction, null);
assert.ok(degenerate.warnings.length > 0);

await assert.rejects(
  () => handleGetSigRankStandardRecord({ input: -1, output: 1, cache_write: 1, cache_read: 1 }),
  /non-negative token pillars/,
);

console.log("standard-record.test.mjs: ok");
