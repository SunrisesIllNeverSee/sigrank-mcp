#!/usr/bin/env node
/**
 * publish-guard.mjs — prepublishOnly hook.
 *
 * Blocks `npm publish` unless ALL of these are true:
 *   1. SIGRANK_PUBLISH=1 is set in env (owner confirmation)
 *   2. Current git branch is `main`
 *   3. Working tree is clean (no uncommitted changes)
 *   4. package.json version is not already published on npm
 *   5. Version matches the 3-digit scheme (0.0.x), not 2-digit (0.x.x)
 *
 * Usage: npm publish (the hook runs automatically)
 *        SIGRANK_PUBLISH=1 npm publish (owner-confirmed publish)
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function fail(msg) {
  console.error(`${RED}${BOLD}\n  ✗ PUBLISH BLOCKED${RESET}\n  ${msg}\n`);
  process.exit(1);
}

function ok(msg) {
  console.log(`${GREEN}  ✓ ${msg}${RESET}`);
}

// 1. Owner confirmation
if (process.env.SIGRANK_PUBLISH !== "1") {
  fail(
    `Set ${YELLOW}SIGRANK_PUBLISH=1${RESET} to publish.\n` +
    `  This is a guard against accidental/agent publishes.\n` +
    `  Run: ${YELLOW}SIGRANK_PUBLISH=1 npm publish${RESET}`
  );
}

// 2. Read package.json
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = pkg.version;

// 3. Version scheme check (must be 0.0.x, not 0.x.x)
const validScheme = /^0\.0\.\d+$/.test(version);
if (!validScheme) {
  fail(
    `Version "${version}" does not match required scheme ${YELLOW}0.0.x${RESET}.\n` +
    `  2-digit versions (0.18.x, 0.19.x) are banned — they pollute the npm version history.\n` +
    `  Fix: set version to "0.0.<N>" in package.json.`
  );
}
ok(`Version scheme 0.0.x: ${version}`);

// 4. Git branch must be main
let branch;
try {
  branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
} catch {
  fail("Could not determine git branch. Are you in a git repo?");
}
if (branch !== "main") {
  fail(
    `Current branch is "${branch}", must be "main".\n` +
    `  Switch: ${YELLOW}git checkout main${RESET}`
  );
}
ok(`On branch main`);

// 5. Working tree must be clean
const status = execSync("git status --porcelain", { encoding: "utf8" }).trim();
if (status) {
  fail(
    `Working tree has uncommitted changes:\n` +
    status.split("\n").map(l => `    ${l}`).join("\n") +
    `\n  Commit or stash before publishing.`
  );
}
ok(`Working tree clean`);

// 6. Version not already published
let published;
try {
  const result = execSync(`npm view sigrank@${version} version --silent 2>/dev/null`, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
  }).trim();
  published = result === version;
} catch {
  published = false;
}
if (published) {
  fail(
    `Version ${version} is already published on npm.\n` +
    `  Bump the version in package.json before publishing.`
  );
}
ok(`Version ${version} not yet published`);

console.log(`\n${GREEN}${BOLD}  All checks passed. Publishing...${RESET}\n`);
