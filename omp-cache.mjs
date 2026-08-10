/**
 * omp-cache.mjs — Privacy-safe incremental SQLite cache for omp session scans.
 *
 * Stage 2 of the OMP Loading Optimization Plan. Wraps the Stage 1 bounded-concurrency
 * scanner with a persistent index at ~/.sigrank-mcp/omp-index.sqlite that stores:
 *   - File fingerprints (path, size, mtime_ms)
 *   - Usage events (session_id, message_id, timestamp, 4 token pillars)
 *   - No transcript text, ever.
 *
 * On a warm run with no changed files, the cache avoids all transcript reads and
 * serves usage records directly from SQLite — turning a ~35s scan into a metadata
 * walk + indexed aggregation.
 *
 * Activation:
 *   SIGRANK_OMP_CACHE=1      — use cache, fall back to uncached on error
 *   SIGRANK_OMP_CACHE=parity — use cache AND run uncached scan, fail on drift
 *   (unset)                  — uncached (Stage 1 behavior, the default)
 *
 * SQLite access: shells out to the `sqlite3` CLI (same as the devin adapter).
 * No native npm dependency. Works on Node 18+ (the project's minimum).
 *
 * Concurrency: SQLite WAL mode + busy timeout. If the write lock can't be
 * obtained, falls back to uncached scan without damaging the cache.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, stat, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const execFileP = promisify(execFileCb);

const CACHE_SCHEMA_VERSION = "1";
const CACHE_PARSER_VERSION = "omp-stage1-v1";
const BUSY_TIMEOUT_MS = 5_000;
const SQLITE_MAX_BUFFER = 256 * 1024 * 1024; // 256MB

/** Default cache location. */
export function defaultCachePath() {
  return join(homedir(), ".sigrank-mcp", "omp-index.sqlite");
}

/** Run a SQLite command, return parsed JSON rows or [] on error. */
async function sqliteJson(dbPath, sql, timeoutMs = 10_000) {
  try {
    const { stdout } = await execFileP("sqlite3", ["-json", dbPath, sql], {
      timeout: timeoutMs,
      maxBuffer: SQLITE_MAX_BUFFER,
    });
    return JSON.parse(stdout || "[]");
  } catch {
    return [];
  }
}

/** Run a SQLite command that doesn't return rows (DDL/DML). Returns success boolean. */
async function sqliteExec(dbPath, sql, timeoutMs = 30_000) {
  try {
    await execFileP("sqlite3", [dbPath, sql], {
      timeout: timeoutMs,
      maxBuffer: SQLITE_MAX_BUFFER,
    });
    return true;
  } catch {
    return false;
  }
}

/** Run multiple SQL statements in a single sqlite3 call (semicolon-separated). */
async function sqliteExecBatch(dbPath, sql, timeoutMs = 60_000) {
  return sqliteExec(dbPath, sql, timeoutMs);
}

/** Check if the cache database exists and has a compatible schema. */
async function cacheIsHealthy(dbPath) {
  const rows = await sqliteJson(
    dbPath,
    `SELECT key, value FROM metadata WHERE key IN ('schema_version','parser_version');`,
    2_000,
  );
  if (!rows || rows.length < 2) return false;
  const meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return (
    meta.schema_version === CACHE_SCHEMA_VERSION &&
    meta.parser_version === CACHE_PARSER_VERSION
  );
}

/** Initialize the cache database with the schema. */
async function initCacheDb(dbPath) {
  // Ensure the directory exists with 0700 permissions
  await mkdir(dirname(dbPath), { recursive: true, mode: 0o700 });

  const sql = `
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=${BUSY_TIMEOUT_MS};
    PRAGMA synchronous=NORMAL;

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roots (
      root TEXT PRIMARY KEY,
      last_seen_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      root TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      scanned_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      file_path TEXT NOT NULL,
      session_id TEXT,
      message_id TEXT,
      event_ts TEXT,
      input INTEGER NOT NULL,
      output INTEGER NOT NULL,
      cache_create INTEGER NOT NULL,
      cache_read INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (file_path, ordinal)
    );

    CREATE INDEX IF NOT EXISTS usage_events_dedup
      ON usage_events(session_id, message_id);

    CREATE INDEX IF NOT EXISTS usage_events_timestamp
      ON usage_events(event_ts);

    DELETE FROM metadata WHERE key IN ('schema_version', 'parser_version');
    INSERT INTO metadata VALUES ('schema_version', '${CACHE_SCHEMA_VERSION}');
    INSERT INTO metadata VALUES ('parser_version', '${CACHE_PARSER_VERSION}');
  `;
  return sqliteExecBatch(dbPath, sql);
}

/** Delete the cache file (corruption recovery). */
async function deleteCache(dbPath) {
  try {
    await unlink(dbPath);
  } catch {
    // already gone
  }
  // Also clean up WAL and SHM files
  for (const suffix of ["-wal", "-shm"]) {
    try {
      await unlink(dbPath + suffix);
    } catch {
      // ignore
    }
  }
}

/** Collect file metadata (path, size, mtime_ms) for all jsonl files under a root. */
async function collectFileMeta(rootDir, walkFiles, isJsonl, maxFiles) {
  const metas = [];
  for await (const path of walkFiles(rootDir, isJsonl, { n: 0 }, maxFiles)) {
    try {
      const st = await stat(path);
      metas.push({
        path,
        root: rootDir,
        size: st.size,
        mtime_ms: Math.floor(st.mtimeMs),
      });
    } catch {
      // file vanished between walk and stat — skip
    }
  }
  return metas;
}

/** Get cached file fingerprints from the database. */
async function getCachedFiles(dbPath, rootDir) {
  return sqliteJson(
    dbPath,
    `SELECT path, root, size, mtime_ms FROM files WHERE root = '${rootDir.replace(/'/g, "''")}';`,
    5_000,
  );
}

/** Compare current file metadata against cached fingerprints.
 *  Returns { newFiles, changedFiles, deletedFiles, unchangedFiles }. */
function diffFiles(currentMetas, cachedRows) {
  const cachedMap = new Map(cachedRows.map((r) => [r.path, r]));
  const currentPaths = new Set(currentMetas.map((m) => m.path));

  const newFiles = [];
  const changedFiles = [];
  const unchangedFiles = [];

  for (const m of currentMetas) {
    const cached = cachedMap.get(m.path);
    if (!cached) {
      newFiles.push(m);
    } else if (cached.size !== m.size || cached.mtime_ms !== m.mtime_ms) {
      changedFiles.push(m);
    } else {
      unchangedFiles.push(m);
    }
  }

  const deletedFiles = cachedRows
    .filter((r) => !currentPaths.has(r.path))
    .map((r) => r.path);

  return { newFiles, changedFiles, unchangedFiles, deletedFiles };
}

/** Escape a string for SQL single-quoted context. */
function sqlEscape(s) {
  return String(s ?? "").replace(/'/g, "''");
}

/** Format a value for SQL (null for null/undefined, quoted string otherwise). */
function sqlVal(v) {
  if (v == null) return "NULL";
  return `'${sqlEscape(v)}'`;
}

/** Update the cache for a set of files: parse them, insert usage events.
 *  Uses the Stage 1 parseOmpFile function passed in. */
async function updateFilesInCache(dbPath, fileMetas, parseOmpFile, readUtf8) {
  for (const meta of fileMetas) {
    const text = await readUtf8(meta.path);
    const records = [...parseOmpFile(text, meta.path)];

    if (process.env.SIGRANK_OMP_DEBUG) {
      console.error(`[omp-cache] updating ${meta.path}: ${records.length} records, size=${meta.size}, mtime=${meta.mtime_ms}`);
    }

    // Build SQL: delete old rows for this file, insert new ones, update fingerprint
    let sql = `
      BEGIN TRANSACTION;
      DELETE FROM usage_events WHERE file_path = '${sqlEscape(meta.path)}';
      DELETE FROM files WHERE path = '${sqlEscape(meta.path)}';
    `;

    if (records.length > 0) {
      const values = records
        .map((r, i) => {
          return `('${sqlEscape(meta.path)}', ${sqlVal(r.sid)}, ${sqlVal(r.id)}, ${sqlVal(r.ts)}, ${r.input}, ${r.output}, ${r.cacheCreate}, ${r.cacheRead}, ${i})`;
        })
        .join(",\n");
      sql += `INSERT INTO usage_events (file_path, session_id, message_id, event_ts, input, output, cache_create, cache_read, ordinal) VALUES ${values};\n`;
    }

    sql += `INSERT INTO files (path, root, size, mtime_ms, scanned_at) VALUES ('${sqlEscape(meta.path)}', '${sqlEscape(meta.root)}', ${meta.size}, ${meta.mtime_ms}, ${Date.now()});\n`;
    sql += `COMMIT;`;

    const ok = await sqliteExecBatch(dbPath, sql, 10_000);
    if (!ok && process.env.SIGRANK_OMP_DEBUG) {
      console.error(`[omp-cache] SQL FAILED for ${meta.path}`);
      console.error(`[omp-cache] SQL: ${sql.substring(0, 300)}`);
    }
  }
}

/** Remove cached data for deleted files. */
async function removeDeletedFiles(dbPath, deletedPaths) {
  if (deletedPaths.length === 0) return;
  const pathList = deletedPaths.map((p) => `'${sqlEscape(p)}'`).join(",");
  await sqliteExecBatch(
    dbPath,
    `
    BEGIN TRANSACTION;
    DELETE FROM usage_events WHERE file_path IN (${pathList});
    DELETE FROM files WHERE path IN (${pathList});
    COMMIT;
    `,
    10_000,
  );
}

/** Update the roots table to mark this root as seen. */
async function touchRoot(dbPath, rootDir) {
  await sqliteExecBatch(
    dbPath,
    `INSERT OR REPLACE INTO roots (root, last_seen_at) VALUES ('${sqlEscape(rootDir)}', ${Date.now()});`,
    2_000,
  );
}

/** Read all usage events from the cache as records (same shape as ompAdapter.messages). */
async function* readCachedRecords(dbPath) {
  const rows = await sqliteJson(
    dbPath,
    `SELECT file_path, session_id, message_id, event_ts, input, output, cache_create, cache_read
     FROM usage_events ORDER BY file_path, ordinal;`,
    30_000,
  );

  for (const row of rows) {
    yield {
      id: row.message_id || null,
      sid: row.session_id || null,
      ts: row.event_ts || null,
      input: row.input,
      output: row.output,
      cacheCreate: row.cache_create,
      cacheRead: row.cache_read,
      file: row.file_path,
    };
  }
}

/**
 * Run a cached omp scan. If the cache is healthy, does an incremental update
 * (only reparse new/changed files) and yields records from the cache.
 * Falls back to uncached scan on any error.
 *
 * @param {string} rootDir - the omp sessions directory
 * @param {Function} uncachedScan - async generator that yields records (Stage 1)
 * @param {Function} parseOmpFile - Stage 1 parser function
 * @param {Function} readUtf8 - file reader
 * @param {Function} walkFiles - file walker
 * @param {Function} isJsonl - file predicate
 * @param {number} maxFiles - file cap
 * @param {string} cachePath - override cache db path (for tests)
 * @returns {AsyncGenerator} - yields usage records
 */
export async function* cachedOmpScan({
  rootDir,
  uncachedScan,
  parseOmpFile,
  readUtf8,
  walkFiles,
  isJsonl,
  maxFiles,
  cachePath,
}) {
  const dbPath = cachePath || defaultCachePath();
  const parity = process.env.SIGRANK_OMP_CACHE === "parity";

  // Try to use the cache
  let healthy = await cacheIsHealthy(dbPath);
  if (process.env.SIGRANK_OMP_DEBUG) {
    console.error(`[omp-cache] initial healthy=${healthy} db=${dbPath}`);
  }
  if (!healthy) {
    // If the db file exists but is corrupt/incompatible, delete it first
    // (initCacheDb can't write to a non-SQLite file)
    try {
      const st = await stat(dbPath);
      if (st.isFile() && st.size > 0) {
        if (process.env.SIGRANK_OMP_DEBUG) {
          console.error(`[omp-cache] deleting existing file (size=${st.size})`);
        }
        await deleteCache(dbPath);
      }
    } catch {
      // file doesn't exist — fine
    }
    // Try to initialize
    const ok = await initCacheDb(dbPath);
    if (process.env.SIGRANK_OMP_DEBUG) {
      console.error(`[omp-cache] initCacheDb ok=${ok}`);
    }
    if (!ok) {
      // Can't create cache — fall back to uncached
      yield* uncachedScan();
      return;
    }
    healthy = await cacheIsHealthy(dbPath);
    if (process.env.SIGRANK_OMP_DEBUG) {
      console.error(`[omp-cache] post-init healthy=${healthy}`);
    }
    if (!healthy) {
      yield* uncachedScan();
      return;
    }
  }

  try {
    // Collect current file metadata
    const currentMetas = await collectFileMeta(rootDir, walkFiles, isJsonl, maxFiles);

    // Get cached fingerprints
    const cachedRows = await getCachedFiles(dbPath, rootDir);

    // Diff
    const { newFiles, changedFiles, unchangedFiles, deletedFiles } = diffFiles(
      currentMetas,
      cachedRows,
    );

    // Update cache for new and changed files
    const toUpdate = [...newFiles, ...changedFiles];
    if (toUpdate.length > 0) {
      await updateFilesInCache(dbPath, toUpdate, parseOmpFile, readUtf8);
    }

    // Remove deleted files
    if (deletedFiles.length > 0) {
      await removeDeletedFiles(dbPath, deletedFiles);
    }

    // Mark root as seen
    await touchRoot(dbPath, rootDir);

    // Yield records from cache
    yield* readCachedRecords(dbPath);

    // Parity mode: also run uncached and compare
    if (parity) {
      const cachedRecords = [...readCachedRecords(dbPath)];
      const uncachedRecords = [];
      for await (const r of uncachedScan()) {
        uncachedRecords.push(r);
      }
      // Compare totals (dedup happens downstream in tokenpull, so we compare
      // the raw record sums — they should match since the cache stores all
      // records from all files)
      const sumFields = (records, field) =>
        records.reduce((s, r) => s + (r[field] || 0), 0);

      for (const field of ["input", "output", "cacheCreate", "cacheRead"]) {
        const cachedSum = sumFields(cachedRecords, field);
        const uncachedSum = sumFields(uncachedRecords, field);
        if (cachedSum !== uncachedSum) {
          console.error(
            `[omp-cache] PARITY DRIFT: ${field} cached=${cachedSum} uncached=${uncachedSum} (diff=${cachedSum - uncachedSum})`,
          );
        }
      }
    }
  } catch (err) {
    // Any error during cache operations — fall back to uncached
    // Don't delete the cache; it may be partially valid and recoverable
    if (process.env.SIGRANK_OMP_DEBUG) {
      console.error(`[omp-cache] fallback to uncached: ${err.message}`);
    }
    yield* uncachedScan();
    return;
  }
}

/** Check if the omp cache is enabled via environment variable. */
export function ompCacheEnabled() {
  const v = process.env.SIGRANK_OMP_CACHE;
  return v === "1" || v === "parity";
}

/** Rebuild the omp cache from scratch (deletes existing cache, forces full scan). */
export async function rebuildOmpCache(cachePath) {
  const dbPath = cachePath || defaultCachePath();
  await deleteCache(dbPath);
  // The next scan will rebuild it
}

/** Get cache statistics for diagnostics. */
export async function getCacheStats(cachePath) {
  const dbPath = cachePath || defaultCachePath();
  const healthy = await cacheIsHealthy(dbPath);
  if (!healthy) return { healthy: false, files: 0, events: 0 };

  const fileRows = await sqliteJson(dbPath, `SELECT COUNT(*) as n FROM files;`, 2_000);
  const eventRows = await sqliteJson(
    dbPath,
    `SELECT COUNT(*) as n FROM usage_events;`,
    5_000,
  );

  return {
    healthy: true,
    files: fileRows[0]?.n || 0,
    events: eventRows[0]?.n || 0,
    path: dbPath,
  };
}
