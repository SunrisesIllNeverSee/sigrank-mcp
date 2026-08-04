// pkg-version.test.mjs — guards the agent_version stamp that rides inside the
// SIGNED submit payload (agent.agent_version).
//
// Run: node --test __tests__/pkg-version.test.mjs
//
// Before the shared lib/pkg-version.mjs helper, identity/keystore.mjs resolved
// ./package.json relative to its OWN subdirectory (identity/package.json — does
// not exist) and fell back to the bare string "sigrank-mcp". That wrong/missing
// version silently rode inside every signed payload. No test guarded it, which
// is why the bug survived. This test asserts the stamp matches
// /^sigrank-mcp\/\d+\.\d+\.\d+$/ so a regression to the bare fallback fails CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateIdentity } from "../keystore.mjs";
import { pkgVersion, agentVersion } from "../lib/pkg-version.mjs";

test("pkgVersion() returns a real semver, not the 'unknown' fallback", () => {
  const v = pkgVersion();
  assert.match(v, /^\d+\.\d+\.\d+$/, `pkgVersion() returned "${v}"`);
  assert.notStrictEqual(v, "unknown", "pkgVersion() fell back to 'unknown'");
});

test("agentVersion() stamp is sigrank-mcp/<semver>", () => {
  assert.match(
    agentVersion(),
    /^sigrank-mcp\/\d+\.\d+\.\d+$/,
    "agentVersion() must be sigrank-mcp/<semver>, not the bare 'sigrank-mcp' fallback",
  );
});

test("generateIdentity().agent_version matches sigrank-mcp/<semver>", () => {
  // agent_version rides inside the SIGNED payload — a bare "sigrank-mcp" here
  // was the high-priority bug this test exists to catch.
  const id = generateIdentity();
  assert.match(
    id.agent_version,
    /^sigrank-mcp\/\d+\.\d+\.\d+$/,
    `agent_version was "${id.agent_version}" — expected sigrank-mcp/<semver>`,
  );
});
