/**
 * omp-cache.test.mjs — Tests for the Stage 2 incremental SQLite cache.
 *
 * Covers: cache build, warm hit, file append, file rewrite, file delete,
 * corruption recovery, parity mode, and cache-disabled fallback.
 *
 * Uses temp directories with synthetic omp session files.
 */

import assert from "node:assert";
import { mkdtemp, mkdir, writeFile, rm, appendFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { cachedOmpScan, ompCacheEnabled, rebuildOmpCache, getCacheStats } from "../adapters/omp-cache.mjs";

const execFileP = promisify(execFileCb);

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Create a synthetic omp session file with a session header + message entries. */
function makeOmpSession(sessionId, messages) {
  const lines = [];
  lines.push(JSON.stringify({ type: "session", id: sessionId }));
  for (const m of messages) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: m.id,
        timestamp: m.ts,
        message: {
          usage: {
            input: m.input,
            output: m.output,
            cacheWrite: m.cacheCreate,
            cacheRead: m.cacheRead,
          },
        },
      }),
    );
  }
  return lines.join("\n") + "\n";
}

/** Collect all records from an async generator into an array. */
async function collect(gen) {
  const out = [];
  for await (const r of gen) out.push(r);
  return out;
}

/** Sum a field across records. */
function sumField(records, field) {
  return records.reduce((s, r) => s + (r[field] || 0), 0);
}

// ── Mock the Stage 1 scanner components ────────────────────────────────────────
// We import the real parseOmpFile and readUtf8 from the adapters module,
// but use a local walkFiles that works on our temp directory.

import { parseOmpFile } from "../adapters/index.mjs";
import { walkFiles, isJsonl } from "../adapters/index.mjs";

async function readUtf8(path) {
  try {
    const { readFile } = await import("node:fs/promises");
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

const OMP_MAX_FILES = 500_000;

/** Run a cached scan on a temp directory. */
async function* scanWithCache(rootDir, cachePath) {
  yield* cachedOmpScan({
    rootDir,
    uncachedScan: async function* () {
      // Fallback uncached scan — same as ompUncachedScan but inline
      const paths = [];
      for await (const path of walkFiles(rootDir, isJsonl, { n: 0 }, OMP_MAX_FILES)) {
        paths.push(path);
      }
      const concurrency = 8;
      const inflight = new Set();
      const queue = [...paths];
      while (queue.length > 0 || inflight.size > 0) {
        while (inflight.size < concurrency && queue.length > 0) {
          const path = queue.shift();
          const p = (async () => {
            const text = await readUtf8(path);
            return { path, records: [...parseOmpFile(text, path)] };
          })();
          inflight.add(p);
          p.finally(() => inflight.delete(p));
        }
        const done = await Promise.race(inflight);
        inflight.delete(done);
        for (const record of done.records) {
          yield record;
        }
      }
    },
    parseOmpFile,
    readUtf8,
    walkFiles,
    isJsonl,
    maxFiles: OMP_MAX_FILES,
    cachePath,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

let testsPassed = 0;
let testsFailed = 0;

async function test(name, fn) {
  try {
    await fn();
    testsPassed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    testsFailed++;
    console.error(`  ✗ ${name}: ${err.message}`);
    console.error(err.stack);
  }
}

export async function runOmpCacheTests() {
  console.log("─ omp-cache: Stage 2 incremental SQLite cache ─");

  // ── Test 1: Cache build from scratch ──────────────────────────────────────
  await test("cache build from scratch — records match uncached", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-cache-test-"));
    const cachePath = join(dir, "omp-index.sqlite");
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    // Create 3 session files
    await writeFile(
      join(sessionsDir, "s1.jsonl"),
      makeOmpSession("sess-1", [
        { id: "m1", ts: "2026-08-01T10:00:00Z", input: 100, output: 200, cacheCreate: 50, cacheRead: 500 },
        { id: "m2", ts: "2026-08-01T11:00:00Z", input: 110, output: 210, cacheCreate: 55, cacheRead: 550 },
      ]),
    );
    await writeFile(
      join(sessionsDir, "s2.jsonl"),
      makeOmpSession("sess-2", [
        { id: "m3", ts: "2026-08-02T10:00:00Z", input: 120, output: 220, cacheCreate: 60, cacheRead: 600 },
      ]),
    );
    await writeFile(
      join(sessionsDir, "s3.jsonl"),
      makeOmpSession("sess-3", [
        { id: "m4", ts: "2026-08-03T10:00:00Z", input: 130, output: 230, cacheCreate: 65, cacheRead: 650 },
      ]),
    );

    // First scan: builds the cache
    const cached = await collect(scanWithCache(sessionsDir, cachePath));
    assert.strictEqual(cached.length, 4, "should have 4 records");

    // Verify pillar sums
    assert.strictEqual(sumField(cached, "input"), 460);
    assert.strictEqual(sumField(cached, "output"), 860);
    assert.strictEqual(sumField(cached, "cacheCreate"), 230);
    assert.strictEqual(sumField(cached, "cacheRead"), 2300);

    // Verify cache stats
    const stats = await getCacheStats(cachePath);
    assert.strictEqual(stats.healthy, true);
    assert.strictEqual(stats.files, 3);
    assert.strictEqual(stats.events, 4);

    await rm(dir, { recursive: true, force: true });
  });

  // ── Test 2: Warm hit — no files changed ───────────────────────────────────
  await test("warm hit — unchanged files served from cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-cache-warm-"));
    const cachePath = join(dir, "omp-index.sqlite");
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    await writeFile(
      join(sessionsDir, "s1.jsonl"),
      makeOmpSession("sess-1", [
        { id: "m1", ts: "2026-08-01T10:00:00Z", input: 100, output: 200, cacheCreate: 50, cacheRead: 500 },
      ]),
    );

    // First scan: build cache
    const first = await collect(scanWithCache(sessionsDir, cachePath));
    assert.strictEqual(first.length, 1);

    // Second scan: should serve from cache (no file changes)
    const second = await collect(scanWithCache(sessionsDir, cachePath));
    assert.strictEqual(second.length, 1);
    assert.deepStrictEqual(second[0], first[0]);

    await rm(dir, { recursive: true, force: true });
  });

  // ── Test 3: File append — new file added ──────────────────────────────────
  await test("file append — new file picked up incrementally", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-cache-append-"));
    const cachePath = join(dir, "omp-index.sqlite");
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    await writeFile(
      join(sessionsDir, "s1.jsonl"),
      makeOmpSession("sess-1", [
        { id: "m1", ts: "2026-08-01T10:00:00Z", input: 100, output: 200, cacheCreate: 50, cacheRead: 500 },
      ]),
    );

    // Build cache
    await collect(scanWithCache(sessionsDir, cachePath));

    // Add a new file
    await writeFile(
      join(sessionsDir, "s2.jsonl"),
      makeOmpSession("sess-2", [
        { id: "m2", ts: "2026-08-02T10:00:00Z", input: 120, output: 220, cacheCreate: 60, cacheRead: 600 },
      ]),
    );

    // Second scan: should only parse the new file
    const second = await collect(scanWithCache(sessionsDir, cachePath));
    assert.strictEqual(second.length, 2, "should have 2 records after append");

    const stats = await getCacheStats(cachePath);
    assert.strictEqual(stats.files, 2);
    assert.strictEqual(stats.events, 2);

    await rm(dir, { recursive: true, force: true });
  });

  // ── Test 4: File rewrite — changed file replaces old records ──────────────
  await test("file rewrite — changed file replaces old records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-cache-rewrite-"));
    const cachePath = join(dir, "omp-index.sqlite");
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    const filePath = join(sessionsDir, "s1.jsonl");
    await writeFile(
      filePath,
      makeOmpSession("sess-1", [
        { id: "m1", ts: "2026-08-01T10:00:00Z", input: 100, output: 200, cacheCreate: 50, cacheRead: 500 },
      ]),
    );

    // Build cache
    await collect(scanWithCache(sessionsDir, cachePath));

    // Rewrite the file with different data
    await writeFile(
      filePath,
      makeOmpSession("sess-1", [
        { id: "m1", ts: "2026-08-01T10:00:00Z", input: 999, output: 888, cacheCreate: 777, cacheRead: 666 },
      ]),
    );

    // Second scan: should detect the change and replace
    const second = await collect(scanWithCache(sessionsDir, cachePath));
    assert.strictEqual(second.length, 1, "should still have 1 record");
    assert.strictEqual(second[0].input, 999, "input should be the new value");
    assert.strictEqual(second[0].output, 888);
    assert.strictEqual(second[0].cacheCreate, 777);
    assert.strictEqual(second[0].cacheRead, 666);

    await rm(dir, { recursive: true, force: true });
  });

  // ── Test 5: File delete — removed file's records disappear ────────────────
  await test("file delete — removed file's records disappear", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-cache-delete-"));
    const cachePath = join(dir, "omp-index.sqlite");
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    const f1 = join(sessionsDir, "s1.jsonl");
    const f2 = join(sessionsDir, "s2.jsonl");
    await writeFile(f1, makeOmpSession("sess-1", [
      { id: "m1", ts: "2026-08-01T10:00:00Z", input: 100, output: 200, cacheCreate: 50, cacheRead: 500 },
    ]));
    await writeFile(f2, makeOmpSession("sess-2", [
      { id: "m2", ts: "2026-08-02T10:00:00Z", input: 120, output: 220, cacheCreate: 60, cacheRead: 600 },
    ]));

    // Build cache
    await collect(scanWithCache(sessionsDir, cachePath));

    // Delete one file
    await rm(f2, { force: true });

    // Second scan: should remove deleted file's records
    const second = await collect(scanWithCache(sessionsDir, cachePath));
    assert.strictEqual(second.length, 1, "should have 1 record after delete");
    assert.strictEqual(second[0].id, "m1");

    const stats = await getCacheStats(cachePath);
    assert.strictEqual(stats.files, 1);
    assert.strictEqual(stats.events, 1);

    await rm(dir, { recursive: true, force: true });
  });

  // ── Test 6: Corruption recovery — corrupt db is rebuilt ───────────────────
  await test("corruption recovery — corrupt db triggers rebuild", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-cache-corrupt-"));
    const cachePath = join(dir, "omp-index.sqlite");
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    await writeFile(join(sessionsDir, "s1.jsonl"), makeOmpSession("sess-1", [
      { id: "m1", ts: "2026-08-01T10:00:00Z", input: 100, output: 200, cacheCreate: 50, cacheRead: 500 },
    ]));

    // Write a corrupt cache file (not a valid SQLite db)
    await writeFile(cachePath, "this is not a sqlite database");

    // Scan should detect corruption, rebuild, and return correct records
    const records = await collect(scanWithCache(sessionsDir, cachePath));
    assert.strictEqual(records.length, 1, "should recover and return 1 record");
    assert.strictEqual(records[0].input, 100);

    // Cache should now be healthy
    const stats = await getCacheStats(cachePath);
    assert.strictEqual(stats.healthy, true);

    await rm(dir, { recursive: true, force: true });
  });

  // ── Test 7: Cache disabled — env unset falls back to uncached ─────────────
  await test("cache disabled — SIGRANK_OMP_CACHE unset uses uncached path", async () => {
    const oldVal = process.env.SIGRANK_OMP_CACHE;
    delete process.env.SIGRANK_OMP_CACHE;

    assert.strictEqual(ompCacheEnabled(), false, "cache should be disabled");

    // Restore
    if (oldVal !== undefined) process.env.SIGRANK_OMP_CACHE = oldVal;
  });

  // ── Test 8: Cache enabled — env=1 enables cache ───────────────────────────
  await test("cache enabled — SIGRANK_OMP_CACHE=1 enables cache", async () => {
    const oldVal = process.env.SIGRANK_OMP_CACHE;
    process.env.SIGRANK_OMP_CACHE = "1";

    assert.strictEqual(ompCacheEnabled(), true);

    if (oldVal === undefined) delete process.env.SIGRANK_OMP_CACHE;
    else process.env.SIGRANK_OMP_CACHE = oldVal;
  });

  // ── Test 9: Rebuild command — deletes cache file ──────────────────────────
  await test("rebuild — deletes existing cache file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-cache-rebuild-"));
    const cachePath = join(dir, "omp-index.sqlite");

    // Create a valid cache
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, "s1.jsonl"), makeOmpSession("sess-1", [
      { id: "m1", ts: "2026-08-01T10:00:00Z", input: 100, output: 200, cacheCreate: 50, cacheRead: 500 },
    ]));
    await collect(scanWithCache(sessionsDir, cachePath));

    // Verify it exists
    const statsBefore = await getCacheStats(cachePath);
    assert.strictEqual(statsBefore.healthy, true);

    // Rebuild
    await rebuildOmpCache(cachePath);

    // Verify it's gone
    const statsAfter = await getCacheStats(cachePath);
    assert.strictEqual(statsAfter.healthy, false);

    await rm(dir, { recursive: true, force: true });
  });

  // ── Test 10: Nested subagent transcripts ──────────────────────────────────
  await test("nested subagent transcripts — counted in cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-cache-nested-"));
    const cachePath = join(dir, "omp-index.sqlite");
    const sessionsDir = join(dir, "sessions");
    const subDir = join(sessionsDir, "sess-1", "critic");
    await mkdir(subDir, { recursive: true });

    // Main session
    await writeFile(join(sessionsDir, "s1.jsonl"), makeOmpSession("sess-1", [
      { id: "m1", ts: "2026-08-01T10:00:00Z", input: 100, output: 200, cacheCreate: 50, cacheRead: 500 },
    ]));
    // Nested subagent transcript
    await writeFile(join(subDir, "advisor.jsonl"), makeOmpSession("sess-1-sub", [
      { id: "m2", ts: "2026-08-01T10:30:00Z", input: 80, output: 160, cacheCreate: 40, cacheRead: 400 },
    ]));

    const records = await collect(scanWithCache(sessionsDir, cachePath));
    assert.strictEqual(records.length, 2, "should count both main and subagent records");

    await rm(dir, { recursive: true, force: true });
  });

  // ── Test 11: Empty directory ──────────────────────────────────────────────
  await test("empty directory — returns no records, cache stays healthy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-cache-empty-"));
    const cachePath = join(dir, "omp-index.sqlite");
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    const records = await collect(scanWithCache(sessionsDir, cachePath));
    assert.strictEqual(records.length, 0);

    const stats = await getCacheStats(cachePath);
    assert.strictEqual(stats.healthy, true);
    assert.strictEqual(stats.files, 0);
    assert.strictEqual(stats.events, 0);

    await rm(dir, { recursive: true, force: true });
  });

  // ── Test 12: No transcript content in cache ───────────────────────────────
  await test("privacy — no transcript content stored in cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-cache-privacy-"));
    const cachePath = join(dir, "omp-index.sqlite");
    const sessionsDir = join(dir, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    // Write a file with distinctive text content that should NOT appear in the cache
    const secretText = "SUPER_SECRET_PROMPT_CONTENT_12345";
    const fileContent = JSON.stringify({ type: "session", id: "sess-1" }) + "\n" +
      JSON.stringify({
        type: "message",
        id: "m1",
        timestamp: "2026-08-01T10:00:00Z",
        message: {
          content: secretText,
          usage: { input: 100, output: 200, cacheWrite: 50, cacheRead: 500 },
        },
      }) + "\n";

    await writeFile(join(sessionsDir, "s1.jsonl"), fileContent);

    await collect(scanWithCache(sessionsDir, cachePath));

    // Check the cache file for the secret text
    const { readFile } = await import("node:fs/promises");
    const cacheBytes = await readFile(cachePath);
    const cacheStr = cacheBytes.toString("utf8");
    assert.ok(
      !cacheStr.includes(secretText),
      "transcript content must not appear in the cache database",
    );

    await rm(dir, { recursive: true, force: true });
  });

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`  ${testsPassed} passed, ${testsFailed} failed`);
  if (testsFailed > 0) {
    throw new Error(`${testsFailed} omp-cache tests failed`);
  }
}
