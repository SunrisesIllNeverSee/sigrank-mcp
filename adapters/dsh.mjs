// DeepSeek Harness local telemetry. Format reference: ccusage DSH adapter README.
// Read-only; only token counters, timestamps and local dedup identifiers leave this reader.
import { readdir, readFile, stat } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import * as zlib from "node:zlib";

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 10000;
function fail(reason) {
  const err = new Error("DeepSeek Harness telemetry: " + reason);
  err.code = "SIGRANK_READ_FAILED";
  throw err;
}
function count(value) {
  if (value == null) return 0;
  const n = typeof value === "number" || typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) fail("invalid token counter");
  return n;
}
function timestamp(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= 8640000000000000 ? n : null;
}
function total(r) {
  return r.input + r.output + r.cacheCreate + r.cacheRead;
}
function preferred(a, b) {
  if (total(a) !== total(b)) return total(a) > total(b);
  if (a.output !== b.output) return a.output > b.output;
  return JSON.stringify([a.ts,a.model,a.input,a.cacheCreate,a.cacheRead]) < JSON.stringify([b.ts,b.model,b.input,b.cacheCreate,b.cacheRead]);
}
export function parseDshSession(text, path) {
  const lines = text.split("\n").filter(line => line.trim());
  if (!lines.length) return [];
  let header;
  try { header = JSON.parse(lines[0]); } catch { fail("invalid session header"); }
  if (header?.type !== "session") fail("missing session header");
  const sid = typeof header.id === "string" && header.id ? header.id : basename(dirname(path));
  let awaitingSeed = header.isSeeded === true;
  let model = "unknown";
  let records = [];
  for (let i = 1; i < lines.length; i++) {
    let event;
    try { event = JSON.parse(lines[i]); } catch {
      // A live writer can leave an incomplete final line. Never accept corrupt
      // interior lines or a complete newline-terminated malformed record.
      if (i === lines.length - 1 && !text.endsWith("\n")) break;
      fail("malformed session record");
    }
    const data = event?.data;
    if (!data || typeof data !== "object") continue;
    if (event.type === "session/end-seed" && data.inherited === true) {
      records = []; awaitingSeed = false; continue;
    }
    if (event.type === "request/header" || event.type === "request/context") {
      const route = event.type === "request/header" ? data.header?.config : data;
      if (typeof route?.model === "string" && route.model) model = route.model;
      continue;
    }
    const compact = event.type === "compaction/summary";
    if (!compact && event.type !== "assistant/message" && event.type !== "assistant/attempt") continue;
    if (awaitingSeed) continue;
    const usage = data.usage ?? (!compact && Array.isArray(data.stream)
      ? [...data.stream].reverse().find(r => r?.type === "chunk" && r.chunk?.type === "usage")?.chunk?.usage
      : null);
    if (!usage || typeof usage !== "object") continue;
    const input = count(usage.inputTokens), cacheCreate = count(usage.cacheWriteTokens),
      cacheRead = count(usage.cacheReadTokens), reported = count(usage.totalTokens);
    const output = usage.outputTokens != null ? count(usage.outputTokens) :
      usage.inputTokens != null ? Math.max(0, reported - input - cacheCreate - cacheRead) : 0;
    const sum = input + output + cacheCreate + cacheRead;
    if (!Number.isSafeInteger(sum)) fail("token total exceeds safe integer range");
    const ts = timestamp(event.time) ?? timestamp(header.createdAt);
    if (!sum && !reported) continue;
    const m = compact ? (typeof data.model === "string" ? data.model : "unknown") : model;
    const id = event.seq != null && /^-?\d+$/.test(String(event.seq)) ? "seq:" + event.seq :
      "tuple:" + JSON.stringify([ts,m,input,output,cacheCreate,cacheRead,reported]);
    records.push({ id, sid, ts: ts == null ? null : new Date(ts).toISOString(),
      input, output, cacheCreate, cacheRead, model: m, file: path, reported });
  }
  if (awaitingSeed) return [];
  for (const r of records) {
    if (r.reported > total(r)) fail("reported total contains tokens not attributable to the four pillars");
    if (!r.ts) fail("usage record has no valid timestamp");
    delete r.reported;
  }
  return records;
}
async function* candidates(dir, budget) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (e) { if (e.code === "ENOENT") return; throw e; }
  for (const e of entries.sort((a,b) => a.name.localeCompare(b.name))) {
    if (e.isSymbolicLink()) continue;
    const p = join(dir,e.name);
    if (e.isDirectory()) yield* candidates(p,budget);
    else if (e.isFile() && /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(e.name)) {
      if (++budget.count > MAX_FILES) fail("session file limit exceeded");
      yield p;
    }
  }
}
async function readSession(path) {
  if ((await stat(path)).size > MAX_BYTES) fail("session file exceeds read limit");
  const buf = await readFile(path);
  if (!path.endsWith(".zstd")) return buf.toString("utf8");
  if (typeof zlib.zstdDecompressSync !== "function") fail("compressed sessions require a Node runtime with zstd support");
  try { return zlib.zstdDecompressSync(buf,{maxOutputLength:MAX_BYTES}).toString("utf8"); }
  catch { fail("compressed session could not be decoded safely"); }
}
export const dshAdapter = {
  platform: "dsh",
  defaultRoot: () => join(homedir(), ".dsh"),
  async *messages(root) {
    const roots = process.env.DSH_HOME === undefined ? [root || this.defaultRoot()] :
      process.env.DSH_HOME.split(",").map(s=>s.trim()).filter(Boolean);
    const newest = new Map(), budget = { count: 0 };
    for (const r of roots) {
      for await (const path of candidates(join(r,"sessions"),budget)) {
        const gen = Number(basename(path).match(/\.v(\d+)\.jsonl/)?.[1] ?? 0);
        if (!Number.isSafeInteger(gen)) fail("invalid session generation");
        const dir = dirname(path), prev = newest.get(dir);
        if (!prev || gen > prev.gen || gen === prev.gen && path < prev.path)
          newest.set(dir,{gen,path});
      }
    }
    const seen = new Map();
    for (const {path} of newest.values()) {
      for (const record of parseDshSession(await readSession(path),path)) {
        const key = JSON.stringify([record.sid,record.id]);
        const prev = seen.get(key);
        if (!prev || preferred(record,prev)) seen.set(key,record);
      }
    }
    yield* seen.values();
  },
};
