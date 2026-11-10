// lib/update-check.mjs — "update available" notice for the CLI and TUI.
//
// Contract: never delays startup, never throws, silent offline. The registry
// lookup has a short timeout and its result is cached ~24h in ~/.sigrank-mcp
// (dir 0700, file 0600 — same conventions as identity/keystore.mjs). Callers
// show the cached notice synchronously and refresh in the background.
//
// Opt out: SIGRANK_NO_UPDATE_CHECK=1 (also honours NO_UPDATE_NOTIFIER and CI).
// This module is never used by the MCP stdio server.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const REGISTRY_URL = "https://registry.npmjs.org/sigrank/latest";
export const CHECK_TTL_MS = 24 * 60 * 60 * 1000;
export const RETRY_AFTER_FAIL_MS = 60 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 1500;

const defaultDir = () => join(homedir(), ".sigrank-mcp");
const truthy = (v) => v != null && v !== "" && v !== "0" && v !== "false";

/** True when the user (or CI) opted out of network update checks. */
export function updateCheckDisabled(env = process.env) {
  return (
    truthy(env.SIGRANK_NO_UPDATE_CHECK) ||
    truthy(env.NO_UPDATE_NOTIFIER) ||
    truthy(env.CI)
  );
}

const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(String(v || "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** True when `latest` is a strictly newer release than `current`. */
export function isNewer(latest, current) {
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function formatUpdateNotice(latest) {
  return `sigrank ${latest} available — npm install -g sigrank@latest`;
}

const cachePath = (dir) => join(dir, "update-check.json");

function readCache(dir) {
  try {
    const c = JSON.parse(readFileSync(cachePath(dir), "utf-8"));
    return c && typeof c === "object" ? c : null;
  } catch {
    return null;
  }
}

function writeCache(dir, data) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const p = cachePath(dir);
    writeFileSync(p, JSON.stringify(data), { mode: 0o600 });
    chmodSync(p, 0o600);
  } catch {
    /* cache is best-effort */
  }
}

/** Synchronous, no network: the notice from the cached result, or null. */
export function cachedUpdateNotice({
  current,
  env = process.env,
  dir = defaultDir(),
} = {}) {
  if (updateCheckDisabled(env)) return null;
  const latest = readCache(dir)?.latest;
  return isNewer(latest, current) ? formatUpdateNotice(latest) : null;
}

/**
 * Refresh from the registry if the cache is stale, and return the notice (or
 * null). Short timeout, fails silent, resolves with whatever is cached on error.
 */
export async function checkForUpdate({
  current,
  env = process.env,
  dir = defaultDir(),
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  timeoutMs = CHECK_TIMEOUT_MS,
} = {}) {
  try {
    if (updateCheckDisabled(env) || typeof fetchImpl !== "function") return null;
    const cache = readCache(dir);
    const fresh =
      cache &&
      Number.isFinite(cache.checkedAt) &&
      now - cache.checkedAt >= 0 &&
      now - cache.checkedAt < CHECK_TTL_MS;
    const coolingDown =
      cache &&
      Number.isFinite(cache.failedAt) &&
      now - cache.failedAt >= 0 &&
      now - cache.failedAt < RETRY_AFTER_FAIL_MS;
    let latest = cache?.latest;
    if (!fresh && !coolingDown) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      timer.unref?.();
      try {
        const res = await fetchImpl(REGISTRY_URL, {
          signal: ac.signal,
          headers: { accept: "application/json" },
        });
        if (!res?.ok) throw new Error(`registry ${res?.status}`);
        const v = (await res.json())?.version;
        if (!parse(v)) throw new Error("bad registry payload");
        latest = v;
        writeCache(dir, { latest, checkedAt: now });
      } catch {
        writeCache(dir, { latest: cache?.latest, checkedAt: cache?.checkedAt, failedAt: now });
      } finally {
        clearTimeout(timer);
      }
    }
    return isNewer(latest, current) ? formatUpdateNotice(latest) : null;
  } catch {
    return null;
  }
}
