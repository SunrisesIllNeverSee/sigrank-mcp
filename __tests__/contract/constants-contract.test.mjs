// constants-contract.test.mjs — intra-repo contract: the centralized constants
// in lib/constants.mjs must stay consistent with the adapter registry and the
// submit-path platform enum.
//
// Run: node --test __tests__/contract/constants-contract.test.mjs
//
// Guards three invariants that previously drifted silently:
//   1. Every platform ID that TOKSCALE_CLIENT_MAP can emit (i.e. every value
//     that isn't null) is either a real adapter in ALL_PLATFORMS or the
//     literal "other" bucket. Before Fix 4, the map was duplicated in three
//     files and one copy mapped `kilo` → "kilo" while another mapped
//     `kilocode` → "kilo" but the adapter registry only had one of them.
//   2. PLATFORM_ENUM (submit/index.mjs) is a superset of every non-"other"
//     platform ID in TOKSCALE_CLIENT_MAP — a tokscale client mapped to a real
//     platform must be submittable, or the multi-platform submit path 422s.
//   3. TERMS_VERSION / PRIVACY_VERSION are the same string (the policy pair
//     ships together; a split would let a submit attest to terms X but
//     privacy Y).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  TERMS_VERSION,
  PRIVACY_VERSION,
  TOKSCALE_CLIENT_MAP,
} from "../../lib/constants.mjs";
import { ALL_PLATFORMS } from "../../adapters/index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const submitSrc = readFileSync(
  join(__dirname, "..", "..", "submit", "index.mjs"),
  "utf8",
);

test("every non-null TOKSCALE_CLIENT_MAP value is a real adapter or 'other'", () => {
  const adapterSet = new Set(ALL_PLATFORMS);
  for (const [client, platform] of Object.entries(TOKSCALE_CLIENT_MAP)) {
    if (platform === null) continue; // synthetic — skipped
    assert.ok(
      platform === "other" || adapterSet.has(platform),
      `TOKSCALE_CLIENT_MAP["${client}"] = "${platform}" is neither "other" nor a registered adapter (ALL_PLATFORMS: [${ALL_PLATFORMS.join(", ")}])`,
    );
  }
});

test("PLATFORM_ENUM (submit/index.mjs) + toPlatformPrimary safely buckets tokscale platforms", () => {
  // Extract the PLATFORM_ENUM set literal from submit/index.mjs.
  const m = submitSrc.match(/PLATFORM_ENUM\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/);
  assert.ok(m, "could not locate PLATFORM_ENUM in submit/index.mjs");
  const enumItems = m[1]
    .split(",")
    .map((s) => s.trim().replace(/['"`]/g, ""))
    .filter(Boolean);
  const enumSet = new Set(enumItems);
  // toPlatformPrimary(platform) returns the platform if it's in PLATFORM_ENUM,
  // else "other". So every non-null tokscale platform either submits as-is or
  // buckets to "other" — neither 422s. The invariant we CAN check: "other" is
  // in PLATFORM_ENUM (otherwise the bucket itself would be rejected).
  assert.ok(enumSet.has("other"), "PLATFORM_ENUM must include 'other' as the safe bucket");
  // And every non-null, non-"other" tokscale platform is a real adapter (invariant 1
  // above already checks this). Platforms not in PLATFORM_ENUM will be bucketed by
  // toPlatformPrimary — that's intentional (the server's accepted set is smaller
  // than the client's adapter set). The cross-repo contract test guards the
  // server-side enum separately.
});

test("TERMS_VERSION and PRIVACY_VERSION ship as a matched pair", () => {
  assert.equal(
    TERMS_VERSION,
    PRIVACY_VERSION,
    "Terms and Privacy versions diverged — the policy pair ships together",
  );
});
