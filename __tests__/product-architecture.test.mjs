import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { PRODUCT_ARCHITECTURE, SIGRANK_STANDARD_VERSION } from "../tools/standard-record.mjs";

test("product roles are explicit while the wire identifier remains stable", () => {
  assert.deepEqual(PRODUCT_ARCHITECTURE, {
    brand: "SignalAF",
    governance: "MO§ES™",
    product: "Upsilon",
    leaderboard: "SigRank",
    wire_spec: "sigrank/0.1-draft",
  });
  assert.equal(SIGRANK_STANDARD_VERSION, "sigrank/0.1-draft");
});

test("CLI identity exposes Upsilon without renaming the compatibility command", () => {
  const output = execFileSync(process.execPath, ["bin/sigrank.mjs", "standard", "--json"], {
    encoding: "utf8",
  });
  const identity = JSON.parse(output);
  assert.equal(identity.architecture.product, "Upsilon");
  assert.equal(identity.architecture.leaderboard, "SigRank");
  assert.equal(identity.spec, "sigrank/0.1-draft");
});
