/**
 * tools/_multi.mjs — shared collector for the combined ("multi") cascade.
 *
 * "No local data" (empty read, platform not set up) is fine to skip. A platform
 * whose read THROWS or times out is a FAILED read: dropping it silently submits
 * a too-small combined total (2026-11-10: Devin timed out and the all-time
 * total went out as 7.7B instead of 61.5B). Callers must abort on `failed`.
 */
import { ALL_PLATFORMS } from "../adapters/index.mjs";
import { pullByPlatform } from "./_helpers.mjs";

const hasTokens = (r) =>
  !!r &&
  (r.windows || []).some(
    (w) =>
      (w.pillars?.input || 0) +
        (w.pillars?.output || 0) +
        (w.pillars?.cacheCreate || 0) +
        (w.pillars?.cacheRead || 0) >
      0,
  );

// Test-only reader override. Deliberately NOT reachable through ctx.opts, so a
// caller of the (signed) submit path cannot swap the real platform reader.
let _testPull = null;
export function _setMultiPullForTest(fn) {
  _testPull = fn || null;
}

/** Pull every platform. Returns { detected, failed:[{platform,error}] }. */
export async function collectMultiPlatforms(opts = {}, platforms = ALL_PLATFORMS) {
  const detected = [];
  const failed = [];
  const pull = _testPull ?? pullByPlatform;
  for (const p of platforms) {
    let r;
    try {
      r = await pull(p, opts);
    } catch (e) {
      // Allow-list of abort conditions: only a real read failure of a store that
      // exists (timeout, locked/corrupt db) aborts. Anything else (adapter not
      // set up, stale SIGRANK_OTHER_PATH, no data) is "no data" and is skipped.
      if (e?.code !== "SIGRANK_READ_FAILED") continue;
      failed.push({ platform: p, error: String(e?.message || e) });
      continue;
    }
    if (hasTokens(r)) detected.push(r);
  }
  return { detected, failed };
}

/** The result handlers return (and submit nothing) when a platform read failed. */
export function multiAbortResult(failed, extra = {}) {
  const names = failed.map((f) => f.platform).join(", ");
  return {
    platform: "multi",
    ...extra,
    status: "error",
    reason: "platform_read_failed",
    failed_platforms: failed,
    detail: `multi aborted: could not read ${names} (${failed.map((f) => `${f.platform}: ${f.error}`).join("; ")}). Nothing was submitted, because a combined total without ${names} would be too small. Fix or retry (Devin: raise SIGRANK_DEVIN_TIMEOUT_MS).`,
    windows: [],
  };
}
