import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const script = resolve("scripts/sync-platforms.mjs");
function run({ tokscale = "claude", ccusage = "claude", fail = "" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sigrank-platform-sync-"));
  try {
    const stub = join(dir, "npx");
    writeFileSync(stub, `#!/bin/sh
case "$1" in
  tokscale)
    [ "$SYNC_FAIL" = "tokscale" ] && exit 1
    printf '[possible values: %s]\\n' "$SYNC_TOKSCALE"
    ;;
  ccusage)
    [ "$SYNC_FAIL" = "ccusage" ] && exit 1
    printf '  %s  Show usage\\n' "$SYNC_CCUSAGE"
    ;;
esac
`);
    chmodSync(stub, 0o755);
    const result = spawnSync(process.execPath, [script, "--json"], {
      encoding: "utf8",
      env: { ...process.env, PATH: dir + ":" + process.env.PATH, SYNC_TOKSCALE: tokscale, SYNC_CCUSAGE: ccusage, SYNC_FAIL: fail },
    });
    assert.equal(result.error, undefined);
    return { code: result.status, report: JSON.parse(result.stdout) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test("known clients yield successful sync", () => {
  const { code, report } = run();
  assert.equal(code, 0);
  assert.equal(report.discoveryFailed, false);
});
test("unknown tokscale client is a confirmed gap", () => {
  const { code, report } = run({ tokscale: "unknown-client-xyz" });
  assert.equal(code, 1);
  assert.deepEqual(report.gaps.tokscale.clientsNotInMap, ["unknown-client-xyz"]);
});
test("tokscale execution failure is an upstream failure, not a gap", () => {
  const { code, report } = run({ fail: "tokscale" });
  assert.equal(code, 2);
  assert.equal(report.discoveryFailed, true);
});
test("ccusage execution failure is an upstream failure, not a gap", () => {
  const { code, report } = run({ fail: "ccusage" });
  assert.equal(code, 2);
  assert.equal(report.discoveryFailed, true);
});
test("empty upstream inventory fails closed", () => {
  const { code, report } = run({ tokscale: "" });
  assert.equal(code, 2);
  assert.equal(report.discoveryFailed, true);
});
