#!/usr/bin/env node
/**
 * Enforces the versioning ruleset (VERSIONING_RULESET.md).
 *
 * Accepts two formats:
 *   - 0.0.NNN  (legacy 3-digit patch, 0 minor, 0 major)
 *   - 1.0.NNN  (graduated 1.0 scheme, patch increments in third decimal)
 *
 * Fails CI if:
 *   - package.json version doesn't match either format
 *   - The version uses minor bumps (0.1.x, 1.1.x) or major jumps (2.0.x)
 *   - The patch number exceeds 999
 *
 * Run: node scripts/check-version.mjs
 * Exit 0 = OK, 1 = violation
 */
import { pkgVersion } from "../lib/pkg-version.mjs";

const ver = pkgVersion();

// Accept 0.0.NNN (legacy) or 1.0.NNN (graduated)
const legacyMatch = /^0\.0\.(\d{1,3})$/.test(ver);
const graduatedMatch = /^1\.0\.(\d{1,3})$/.test(ver);

if (!legacyMatch && !graduatedMatch) {
  console.error(`✗ Version "${ver}" violates the versioning ruleset.`);
  console.error("  Accepted formats: 0.0.NNN (legacy) or 1.0.NNN (graduated)");
  console.error("  Examples: 0.0.178, 1.0.0, 1.0.42");
  console.error("  See VERSIONING_RULESET.md for details.");
  console.error("");
  console.error("  To fix: npm pkg set version=1.0.NNN");
  process.exit(1);
}

const patch = parseInt(ver.split(".")[2], 10);
if (patch > 999) {
  console.error(`✗ Version "${ver}" exceeds patch 999.`);
  console.error("  Time to graduate to 2.0.0 (see VERSIONING_RULESET.md).");
  process.exit(1);
}

const scheme = graduatedMatch ? "1.0" : "0.0 (legacy)";
console.log(`✓ Version "${ver}" complies with ${scheme} ruleset.`);

// Cross-file drift gate — every versioned surface must agree with
// package.json. Added 2026-10-05 after package-lock drifted two releases
// behind (release workflow bumped package.json but never staged the lock).
import { readFileSync } from "node:fs";

const read = (f) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
const lock = read("package-lock.json");
const server = read("server.json");
const manifest = read("manifest.json");

const drift = [];
if (lock.version !== ver) drift.push(`package-lock.json root version ${lock.version}`);
if (lock.packages?.[""]?.version !== ver)
  drift.push(`package-lock.json packages[""] version ${lock.packages?.[""]?.version}`);
if (server.version !== ver) drift.push(`server.json version ${server.version}`);
for (const [i, p] of (server.packages ?? []).entries())
  if (p.version !== ver) drift.push(`server.json packages[${i}] version ${p.version}`);
if (manifest.version !== ver) drift.push(`manifest.json version ${manifest.version}`);

if (drift.length) {
  console.error(`✗ Version drift — package.json is ${ver} but:`);
  for (const d of drift) console.error(`    ${d}`);
  process.exit(1);
}
console.log("✓ package.json / package-lock.json / server.json / manifest.json versions agree.");
process.exit(0);
