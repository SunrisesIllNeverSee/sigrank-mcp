import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { callTool } from "../tools.mjs";
import { generateIdentity } from "../identity/keystore.mjs";
import { devinTimeoutMs } from "../adapters/index.mjs";
import { _pullExplicitForTest } from "../tools/index.mjs";
import {
  cachedUpdateNotice,
  checkForUpdate,
  isNewer,
  updateCheckDisabled,
  formatUpdateNotice,
} from "../lib/update-check.mjs";
import { cascadeWindow } from "../presentation/tui.mjs";

// ── multi: never drop a platform whose read failed ──────────────────────────
const win = (window, input, output, cacheRead = 0) => ({
  window,
  messages: 1,
  pillars: { input, output, cacheCreate: 0, cacheRead },
});
const data = (platform, n = 1000) => ({
  platform,
  windows: ["7d", "30d", "90d", "all"].map((w) => win(w, n, n * 2, n * 10)),
});
const empty = (platform) => ({
  platform,
  windows: ["7d", "30d", "90d", "all"].map((w) => win(w, 0, 0, 0)),
});

const id = {
  ...generateIdentity({ device_id: "1f0c9a4e-2b6d-4a1c-9e3f-7d5b2a8c4e10" }),
  codename: "TestOperator",
  operator_id: "op_test",
};
const run = (tool, args, pull) => {
  let posts = 0;
  return callTool(tool, args, {
    identity: id,
    pullByPlatform: pull,
    fetchImpl: async () => {
      posts++;
      return { ok: true, status: 202, json: async () => ({ status: "received" }) };
    },
    apiBase: "http://test.local",
  }).then((out) => ({ out, posts: () => posts }));
};

for (const tool of ["submit_verified", "tokenpull", "tokenpull_submit"]) {
  test(`${tool} multi: a platform whose read throws aborts, naming it`, async () => {
    const args = { platform: "multi", confirm: true, dry_run: tool !== "tokenpull", codename: "TestOperator" };
    const { out, posts } = await run(tool, args, async (p) => {
      if (p === "devin") throw new Error("sqlite read of x failed: timed out after 60s");
      if (p === "claude" || p === "codex") return data(p);
      return empty(p);
    });
    assert.equal(out.status, "error");
    assert.equal(out.reason, "platform_read_failed");
    assert.deepEqual(out.failed_platforms.map((f) => f.platform), ["devin"]);
    assert.match(out.detail, /devin/);
    assert.deepEqual(out.windows, []);
    assert.equal(posts(), 0, "nothing submitted for multi");
  });

  test(`${tool} multi: platforms with zero data are skipped as before`, async () => {
    const args = { platform: "multi", confirm: true, dry_run: tool !== "tokenpull", codename: "TestOperator" };
    const { out } = await run(tool, args, async (p) => {
      if (p === "claude" || p === "codex") return data(p);
      if (p === "other") throw Object.assign(new Error("not set up"), { code: "SIGRANK_NO_LOCAL_DATA" });
      return empty(p);
    });
    assert.notEqual(out.status, "error");
    assert.equal(out.platform, "multi");
    assert.ok((out.windows || []).length > 0, "multi windows were built");
    if (out.sources) assert.deepEqual(out.sources.sort(), ["claude", "codex"]);
  });
}

test("Devin read timeout is generous and configurable", () => {
  assert.equal(devinTimeoutMs({}), 300_000);
  assert.equal(devinTimeoutMs({ SIGRANK_DEVIN_TIMEOUT_MS: "900000" }), 900_000);
  assert.equal(devinTimeoutMs({ SIGRANK_DEVIN_TIMEOUT_MS: "nope" }), 300_000);
});

test("loader reports failed platform reads (not 'no data') to the TUI", async () => {
  const active = await _pullExplicitForTest(["claude", "devin", "other"], {
    callTool: async (_n, a) => {
      if (a.platform === "devin") throw new Error("timed out");
      if (a.platform === "other") throw Object.assign(new Error("unset"), { code: "SIGRANK_NO_LOCAL_DATA" });
      return data(a.platform);
    },
  });
  assert.deepEqual(active.map((d) => d.platform), ["claude"]);
  assert.deepEqual(active.failed.map((f) => f.platform), ["devin"]);
});

// ── update check ────────────────────────────────────────────────────────────
test("isNewer / notice text", () => {
  assert.ok(isNewer("1.0.50", "1.0.49"));
  assert.ok(isNewer("1.0.100", "1.0.99"));
  assert.ok(!isNewer("1.0.49", "1.0.49"));
  assert.ok(!isNewer("1.0.48", "1.0.49"));
  assert.ok(!isNewer("garbage", "1.0.49"));
  assert.equal(formatUpdateNotice("1.0.50"), "sigrank 1.0.50 available — npm install -g sigrank@latest");
});

test("update check: fetches, caches ~24h, 0600 file, no refetch inside TTL", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sr-upd-"));
  try {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { ok: true, json: async () => ({ version: "1.0.50" }) };
    };
    const t0 = 1_000_000_000_000;
    const n1 = await checkForUpdate({ current: "1.0.49", env: {}, dir, now: t0, fetchImpl });
    assert.match(n1, /1\.0\.50 available/);
    assert.equal(calls, 1);
    assert.equal(statSync(path.join(dir, "update-check.json")).mode & 0o777, 0o600);
    assert.match(cachedUpdateNotice({ current: "1.0.49", env: {}, dir }), /1\.0\.50/);
    await checkForUpdate({ current: "1.0.49", env: {}, dir, now: t0 + 3600_000, fetchImpl });
    assert.equal(calls, 1, "cached inside 24h");
    await checkForUpdate({ current: "1.0.49", env: {}, dir, now: t0 + 25 * 3600_000, fetchImpl });
    assert.equal(calls, 2, "refetched after 24h");
    assert.equal(await checkForUpdate({ current: "1.0.50", env: {}, dir, now: t0 + 26 * 3600_000, fetchImpl }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update check: offline / bad payload is silent; opt-out makes no call", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sr-upd-"));
  try {
    const down = async () => {
      throw new Error("ENOTFOUND");
    };
    assert.equal(await checkForUpdate({ current: "1.0.49", env: {}, dir, fetchImpl: down }), null);
    let calls = 0;
    const spy = async () => {
      calls++;
      return { ok: true, json: async () => ({ version: "9.9.9" }) };
    };
    assert.equal(await checkForUpdate({ current: "1.0.49", env: {}, dir, now: Date.now() + 10, fetchImpl: spy }), null, "cooldown after a failure");
    assert.equal(calls, 0);
    const bad = async () => ({ ok: true, json: async () => ({ nope: 1 }) });
    assert.equal(await checkForUpdate({ current: "1.0.49", env: {}, dir: dir + "-b", fetchImpl: bad }), null);
    for (const env of [{ SIGRANK_NO_UPDATE_CHECK: "1" }, { NO_UPDATE_NOTIFIER: "1" }, { CI: "true" }]) {
      assert.ok(updateCheckDisabled(env));
      assert.equal(await checkForUpdate({ current: "1.0.49", env, dir: dir + "-c", fetchImpl: spy }), null);
    }
    assert.equal(calls, 0, "opt-out never touches the network");
    assert.equal(existsSync(dir + "-c"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir + "-b", { recursive: true, force: true });
  }
});

test("update check: a hanging registry is cut off by the timeout", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sr-upd-"));
  try {
    const hang = (_u, { signal }) =>
      new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));
    const t = Date.now();
    assert.equal(await checkForUpdate({ current: "1.0.49", env: {}, dir, fetchImpl: hang, timeoutMs: 50 }), null);
    assert.ok(Date.now() - t < 1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── cascade scroll window ───────────────────────────────────────────────────
const mkRows = (platforms, per = 4) =>
  platforms.flatMap((p) => Array.from({ length: per }, () => ({ platform: p, notes: 0 })));

test("cascadeWindow: everything fits → no scrolling", () => {
  const w = cascadeWindow(mkRows(["a", "b"]), 5, 40);
  assert.equal(w.maxOffset, 0);
  assert.equal(w.offset, 0);
  assert.equal(w.count, 8);
  assert.equal(w.below, 0);
});

test("cascadeWindow: counts blanks and markers so lines never exceed the budget", () => {
  const rows = mkRows(["a", "b", "c", "d"]); // 16 rows
  for (const budget of [8, 10, 12, 15]) {
    const maxOff = cascadeWindow(rows, 0, budget).maxOffset;
    for (let o = 0; o <= maxOff; o++) {
      const w = cascadeWindow(rows, o, budget);
      const vis = rows.slice(w.offset, w.offset + w.count);
      let lines = vis.length + 1 + (w.above > 0 ? 1 : 0) + (w.below > 0 ? 1 : 0);
      for (let i = 1; i < vis.length; i++) if (vis[i].platform !== vis[i - 1].platform) lines++;
      assert.ok(lines <= budget, `budget ${budget} offset ${o}: ${lines} lines`);
      assert.equal(w.above + w.count + w.below, rows.length, "hint counts are exact");
    }
    const end = cascadeWindow(rows, 999, budget);
    assert.equal(end.below, 0, "End shows the last row");
    assert.equal(end.offset, end.maxOffset);
  }
});

test("cascadeWindow: every row is reachable by stepping ↓", () => {
  const rows = mkRows(["a", "b", "c", "d", "e"], 4);
  const seen = new Set();
  let o = 0;
  for (let i = 0; i < 100; i++) {
    const w = cascadeWindow(rows, o, 9);
    for (let r = w.offset; r < w.offset + w.count; r++) seen.add(r);
    if (w.offset >= w.maxOffset) break;
    o = w.offset + 1;
  }
  assert.equal(seen.size, rows.length);
});

// ── Dashboard render: scrolling, accurate hints, stable anchor ──────────────
import * as tui from "../presentation/tui.mjs";

function frame(active, scroll) {
  Object.defineProperty(process.stdout, "columns", { value: 120, configurable: true });
  Object.defineProperty(process.stdout, "rows", { value: 44, configurable: true });
  tui.startBuffer();
  tui.renderDashboard({ active }, "t", scroll);
  const buf = tui._getScreenBuf();
  const lines = (Array.isArray(buf) ? buf : String(buf).split("\n")).map((l) => tui.stripAnsi(l));
  tui._resetBuf();
  return lines;
}
const synth = (p, i) => ({
  platform: p,
  windows: ["7d", "30d", "90d", "all"].map((w, k) => ({
    window: w,
    messages: 1,
    pillars: { input: 1000 * (i + k), output: 2000 * (i + k), cacheCreate: 500, cacheRead: 90000 * (i + k) },
  })),
});

test("dashboard: ↓ reveals later rows; hints match the frame; End shows the combined rows", () => {
  const active = ["claude", "codex", "gemini", "amp", "kimi"].map((p, i) => synth(p, i + 1));
  const sc = { offset: 0, anchor: null };
  let top = frame(active, sc);
  const m = top.join("\n").match(/▼ (\d+) rows? below/);
  assert.ok(m, "scroll hint shown when rows are cut");
  assert.ok(!/claude\+codex\+gemini\+amp\+kimi\s+(7d|30d|90d|all)/.test(top.join("\n")), "combined rows are below the fold at the top");
  sc.offset = 999;
  const end = frame(active, sc).join("\n");
  assert.ok(/claude\+codex\+gemini\+amp\+kimi\s+all/.test(end), "End reaches the combined all row");
  assert.ok(!/rows? below/.test(end), "no ▼ hint at the end");
  assert.match(end, new RegExp(`▲ ${sc.offset} rows? above`));
});

test("dashboard: scroll position stays put when a platform loads in above it", () => {
  const base = ["claude", "codex", "gemini", "amp"].map((p, i) => synth(p, i + 1));
  const sc = { offset: 0, anchor: null };
  frame(base, sc);
  sc.offset = 5; // scrolled into codex
  sc.anchor = null;
  const before = frame(base, sc);
  const topBefore = before.find((l) => /^\s+(claude|codex|gemini|amp)\s+(7d|30d|90d|all)/.test(l));
  // A platform that sorts ahead of the viewport arrives asynchronously.
  const grown = [synth("antigravity", 9), ...base];
  const after = frame(grown, sc);
  const topAfter = after.find((l) => /^\s+(antigravity|claude|codex|gemini|amp)\s+(7d|30d|90d|all)/.test(l));
  assert.equal(topAfter.trim().slice(0, 20), topBefore.trim().slice(0, 20), "same top row after rows load");
});
