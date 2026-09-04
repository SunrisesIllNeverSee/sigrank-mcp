import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, "../bin/sigrank.mjs");

function run(args) {
  return execFileSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

test("sigrank standard --json exposes the draft identity", () => {
  const out = JSON.parse(run(["standard", "--json"]));
  assert.equal(out.spec, "sigrank/0.1-draft");
  assert.equal(out.reference_math, "token-cascade");
  assert.deepEqual(out.telemetry, [
    "input",
    "output",
    "cache_write",
    "cache_read",
  ]);
});

test("sigrank export --standard emits canonical portable record", () => {
  const out = JSON.parse(
    run([
      "export",
      "--standard",
      "--input",
      "1251211",
      "--output",
      "11296121",
      "--cache-write",
      "128196310",
      "--cache-read",
      "2555179769",
      "--provider",
      "test",
      "--model",
      "test-model",
      "--tool",
      "test-tool",
      "--window",
      "30d",
    ]),
  );

  assert.equal(out.spec, "sigrank/0.1-draft");
  assert.equal(out.metrics.yield, 18436.98);
  assert.equal(out.metrics.leverage, 2042.2);
  assert.equal(out.metrics.velocity, 9.028);
  assert.equal(out.metrics.snr, 0.9003);
  assert.equal(out.metrics.dev10x, 3.31);
  assert.equal(out.context.window, "30d");
  assert.equal(out.context.source_platform, "claude");
});

test("sigrank export --standard preserves unavailable cache telemetry", () => {
  const out = JSON.parse(
    run([
      "export",
      "--standard",
      "--input",
      "100",
      "--output",
      "50",
    ]),
  );

  assert.equal(out.telemetry.cache_write, null);
  assert.equal(out.telemetry.cache_read, null);
  assert.equal(out.metrics.yield, null);
  assert.equal(out.metrics.leverage, null);
  assert.equal(out.metrics.velocity, 0.5);
  assert.equal(out.metrics.snr, 0.3333);
  assert.equal(out.metrics.dev10x, null);
});
