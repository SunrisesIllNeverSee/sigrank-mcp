#!/usr/bin/env node
/**
 * Enforces the 3-digit versioning ruleset (VERSIONING_RULESET.md).
 *
 * Fails CI if:
 *   - package.json version is not 0.0.NNN format (3-digit patch, 0 minor, 0 major)
 *   - The version uses minor or major bumps
 *
 * Run: node scripts/check-version.mjs
 * Exit 0 = OK, 1 = violation
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf8"),
);
const ver = pkg.version;

// Must match 0.0.NNN where NNN is 1-3 digits
const valid = /^0\.0\.(\d{1,3})$/.test(ver);

if (!valid) {
  console.error(`✗ Version "${ver}" violates the 3-digit ruleset.`);
  console.error("  Expected format: 0.0.NNN (e.g. 0.0.178)");
  console.error("  See VERSIONING_RULESET.md for details.");
  console.error("");
  console.error("  To fix: npm pkg set version=0.0.NNN");
  process.exit(1);
}

const patch = parseInt(ver.split(".")[2], 10);
if (patch > 999) {
  console.error(`✗ Version "${ver}" exceeds 0.0.999.`);
  console.error("  Time to graduate to 1.0.0 (see VERSIONING_RULESET.md).");
  process.exit(1);
}

console.log(`✓ Version "${ver}" complies with 3-digit ruleset.`);
process.exit(0);
