// lib/pkg-version.mjs — single source of truth for the package version.
//
// Resolves the repo-root package.json by walking up from this module until it
// finds the package named "sigrank". This is robust to callers in any
// subdirectory (identity/, submit/, presentation/, tools/, scripts/) — the
// previous per-caller `new URL("./package.json", import.meta.url)` lookups
// resolved relative to the CALLER's own directory and hit non-existent files,
// falling back to a bare string. The agent_version stamp rides inside the
// SIGNED submit payload (agent.agent_version), so a wrong/missing version
// there is a high-priority bug — it survived because no test guarded it.
//
// One implementation, imported everywhere. Never throws: returns "unknown" on
// any failure so a missing/renamed package.json never breaks a submit.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The published package name (package.json "name"). Used to identify the
 *  repo-root package.json unambiguously past any nested package.json. */
const REPO_PKG_NAME = "sigrank";

/** Resolve the repo-root package version (best-effort).
 *  Returns the version string (e.g. "0.0.181") or "unknown" on any failure. */
export function pkgVersion() {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 20; i++) {
      const pkgPath = join(dir, "package.json");
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      } catch {
        // no package.json here — walk up
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
        continue;
      }
      if (pkg.name === REPO_PKG_NAME) return pkg.version || "unknown";
      // Found a package.json but it isn't ours (e.g. a nested dep) — keep walking.
      const parent = dirname(dir);
      if (parent === dir) {
        // Reached the filesystem root without matching; use whatever we found.
        return pkg.version || "unknown";
      }
      dir = parent;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** The full agent-version stamp, e.g. "sigrank-mcp/0.0.181".
 *  This is the value embedded in the signed payload's agent.agent_version. */
export function agentVersion() {
  return `sigrank-mcp/${pkgVersion()}`;
}
