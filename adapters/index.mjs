/**
 * adapters.mjs — SigRank tokenpull adapters for all supported platforms.
 *
 * OKF (code-file form — fields live in this comment, not raw frontmatter, so the .mjs
 * still parses as valid JS):
 *   type: Reference
 *   title: SigRank tokenpull adapters
 *   description: Per-platform adapters implementing the tokenpull contract — async-generate
 *     {id,sid,ts,input,output,cacheCreate,cacheRead,file} from local logs. Reasoning→output,
 *     cost fields dropped, missing cacheCreate → estimated:true. Token-only, read-only.
 *   tags: [sigrank, mcp, tokenpull, adapters, reference]
 *   timestamp: 2026-06-23
 *
 * Each adapter implements the tokenpull contract:
 *   messages(root): async generator → { id?, sid?, ts, input, output, cacheCreate, cacheRead, file }
 *
 * SigRank-specific mapping rules (applied consistently across all adapters):
 *   - Claude = parsed natively (4 pillars exact, no conversion)
 *   - Non-Claude systems = combined input → split via ioRatio:
 *       input = floor(output × ioRatio)     // Beta from Claude, else Alpha 2.0
 *       cacheCreate = max(0, uncached − input)
 *       cacheRead = exact
 *     (Adapters that yield {ts, output, cacheRead, uncached} via records() go through
 *      tokenpullCodex(); adapters that yield native 4-pillar via messages() go through
 *      tokenpull() directly. The split happens at the tokenpullAny() routing layer.)
 *   - Reasoning / thinking tokens → folded into `output` (they are output-side spend)
 *     EXCEPTION: omp already reports reasoningTokens INSIDE output — see adapter #16
 *   - No cache-creation data available → cacheCreate: 0 + adapter sets `estimated: true`
 *   - Cost fields (USD) → NEVER used or forwarded (SigRank scores cost efficiency from
 *     token ratios, not from dollar amounts — cost efficiency is derived, not ingested)
 *   - Credits / provider-specific fields → dropped
 *
 * "estimated" flag: set on the ADAPTER OBJECT (not per-record) when the adapter
 * cannot provide native cacheCreate values. tokenpull() and tokenpullCodex() already
 * handle this pattern; new adapters with estimated=true get the same treatment.
 *
 * SQLite adapters shell out to `sqlite3 -json` (macOS/Linux system tool, no npm dep).
 * If sqlite3 is unavailable the adapter returns an empty generator with a dataGap note.
 *
 * Data-gap notes (sources that can't provide full 4-pillar data) are attached on the
 * adapter object as `dataGap: string` so tokenpull() can surface them to the user.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { cachedOmpScan, ompCacheEnabled } from "../omp-cache.mjs";

const execFileP = promisify(execFileCb);
const DAY_MS = 86_400_000; // shared with tokenpull.mjs but kept local to avoid circular import

// ── File-system helpers ───────────────────────────────────────────────────────

/** Recursively yield every file whose name matches `pred` under dir (skips
 *  symlink dirs, stops after `max` files). Exported so adapters/tokenpull.mjs
 *  can reuse it instead of maintaining a second near-identical walker
 *  (_walkJsonl) — the two had drifted on the symlink-skip + max-files guards. */
export async function* walkFiles(dir, pred, counter = { n: 0 }, max = 10_000) {
  if (counter.n >= max) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (counter.n >= max) return;
    const full = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      yield* walkFiles(full, pred, counter, max);
    } else if (e.isFile() && pred(e.name)) {
      counter.n++;
      yield full;
    }
  }
}

export const isJsonl = (n) =>
  n.endsWith(".jsonl") ||
  n.endsWith(".jsonl.deleted") ||
  n.match(/\.jsonl\.reset\.\d+$/);
const isJson = (n) => n.endsWith(".json") && !n.endsWith(".jsonl");

/** Read a file as UTF-8, return null on error. */
async function readUtf8(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Parse each newline-delimited JSON line, yield parsed objects silently skipping bad lines. */
function* parseJsonl(text, filePath) {
  if (!text) return;
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      yield [JSON.parse(s), filePath];
    } catch {
      /* skip malformed */
    }
  }
}

/** Run sqlite3 -json and return parsed rows, or [] on error/unavailability.
 *  execFile with an args array — no shell, so dbPath/sql need no quoting/escaping
 *  (matches the execFile hardening used in tools.mjs / tokenpull.mjs). */
async function sqliteJson(dbPath, sql, timeoutMs = 10_000) {
  try {
    const { stdout } = await execFileP("sqlite3", ["-json", dbPath, sql], {
      timeout: timeoutMs,
      maxBuffer: 256 * 1024 * 1024, // 256MB — Devin's sessions.db yields ~15MB JSON
    });
    return JSON.parse(stdout || "[]");
  } catch {
    return [];
  }
}

// ── Env-var helper ────────────────────────────────────────────────────────────
/** Resolve roots from env var or default. Supports comma-separated list. */
function roots(envVar, defaultPath) {
  const v = process.env[envVar];
  if (v)
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return [defaultPath];
}

// ── 1. Amp ────────────────────────────────────────────────────────────────────
// ~/.local/share/amp/threads/**/*.json
// Fields: assistant message usage: input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens
export const ampAdapter = {
  platform: "amp",
  defaultRoot: () => join(homedir(), ".local", "share", "amp"),
  async *messages(root) {
    for (const r of roots("AMP_DATA_DIR", root)) {
      const threadsDir = join(r, "threads");
      for await (const path of walkFiles(threadsDir, isJson)) {
        const text = await readUtf8(path);
        if (!text) continue;
        let thread;
        try {
          thread = JSON.parse(text);
        } catch {
          continue;
        }
        // Amp thread is an array or object with messages
        const msgs = Array.isArray(thread) ? thread : thread.messages || [];
        for (const msg of msgs) {
          if (!msg || msg.role !== "assistant") continue;
          const u = msg.usage || (msg.metadata && msg.metadata.usage) || {};
          const input = Number(u.input_tokens || u.inputTokens || 0);
          const output = Number(u.output_tokens || u.outputTokens || 0);
          const cacheCreate = Number(
            u.cache_creation_tokens || u.cacheCreationTokens || 0,
          );
          const cacheRead = Number(
            u.cache_read_tokens || u.cacheReadTokens || 0,
          );
          if (input + output + cacheCreate + cacheRead === 0) continue;
          yield {
            id: msg.id || null,
            sid: thread.id || null,
            ts: msg.timestamp || msg.created_at || null,
            input,
            output,
            cacheCreate,
            cacheRead,
            file: path,
          };
        }
      }
    }
  },
};

// ── 2. Kimi ───────────────────────────────────────────────────────────────────
// ~/.kimi/sessions/<group-id>/<session-id>/wire.jsonl
// StatusUpdate lines only; token_usage: { input_other, output, input_cache_read, input_cache_creation }
export const kimiAdapter = {
  platform: "kimi",
  defaultRoot: () => join(homedir(), ".kimi"),
  async *messages(root) {
    const sessionsDir = join(roots("KIMI_DATA_DIR", root)[0], "sessions");
    for await (const path of walkFiles(sessionsDir, isJsonl)) {
      const text = await readUtf8(path);
      for (const [ev] of parseJsonl(text, path)) {
        if (!ev || ev.type !== "StatusUpdate") continue;
        const u = ev.token_usage || {};
        const input = Number(u.input_other || 0);
        const output = Number(u.output || 0);
        const cacheCreate = Number(u.input_cache_creation || 0);
        const cacheRead = Number(u.input_cache_read || 0);
        if (input + output + cacheCreate + cacheRead === 0) continue;
        yield {
          id: ev.id || null,
          sid: null,
          ts: ev.timestamp || ev.created_at || null,
          input,
          output,
          cacheCreate,
          cacheRead,
          file: path,
        };
      }
    }
  },
};

// ── 3. Qwen ───────────────────────────────────────────────────────────────────
// ~/.qwen/projects/{project}/chats/*.jsonl
// usageMetadata: { promptTokenCount, candidatesTokenCount, cachedContentTokenCount, thoughtsTokenCount }
// No cache creation field. Reasoning (thoughtsTokenCount) → output.
export const qwenAdapter = {
  platform: "qwen",
  estimated: true, // no cacheCreate in logs
  defaultRoot: () => join(homedir(), ".qwen"),
  async *messages(root) {
    const projectsDir = join(roots("QWEN_DATA_DIR", root)[0], "projects");
    for await (const path of walkFiles(projectsDir, isJsonl)) {
      const text = await readUtf8(path);
      for (const [ev] of parseJsonl(text, path)) {
        if (!ev || !ev.usageMetadata) continue;
        const u = ev.usageMetadata;
        const rawInput = Number(u.promptTokenCount || 0);
        const rawOutput = Number(u.candidatesTokenCount || 0);
        const thoughts = Number(u.thoughtsTokenCount || 0); // reasoning → output
        const cacheRead = Number(u.cachedContentTokenCount || 0);
        // promptTokenCount is inclusive of cached; subtract to get fresh input
        const input = Math.max(0, rawInput - cacheRead);
        const output = rawOutput + thoughts;
        if (input + output + cacheRead === 0) continue;
        yield {
          id: ev.id || null,
          sid: null,
          ts: ev.timestamp || null,
          input,
          output,
          cacheCreate: 0,
          cacheRead,
          file: path,
        };
      }
    }
  },
};

// ── 4. pi-agent ───────────────────────────────────────────────────────────────
// ~/.pi/agent/sessions/**/*.jsonl
// Fields: inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens
export const piAdapter = {
  platform: "pi",
  defaultRoot: () => join(homedir(), ".pi", "agent", "sessions"),
  async *messages(root) {
    for (const r of roots("PI_AGENT_DIR", root)) {
      for await (const path of walkFiles(r, isJsonl)) {
        const text = await readUtf8(path);
        for (const [ev] of parseJsonl(text, path)) {
          if (!ev) continue;
          // pi-agent stores usage in assistant messages or usage events
          const u = ev.usage || ev;
          const input = Number(u.inputTokens || u.input_tokens || 0);
          const output = Number(u.outputTokens || u.output_tokens || 0);
          const cacheCreate = Number(
            u.cacheCreationTokens || u.cache_creation_tokens || 0,
          );
          const cacheRead = Number(
            u.cacheReadTokens || u.cache_read_tokens || 0,
          );
          if (input + output + cacheCreate + cacheRead === 0) continue;
          yield {
            id: ev.id || null,
            sid: ev.sessionId || null,
            ts: ev.timestamp || null,
            input,
            output,
            cacheCreate,
            cacheRead,
            file: path,
          };
        }
      }
    }
  },
};

// ── 5. OpenClaw ───────────────────────────────────────────────────────────────
// ~/.openclaw/ (also ~/.clawdbot/, ~/.moltbot/, ~/.moldbot/)
// agents/<agentId>/sessions/<uuid>.jsonl (+ .deleted.<ts> and .reset.<ts> variants)
// Per-message: input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens
export const openclawAdapter = {
  platform: "openclaw",
  defaultRoot: () => {
    const env = process.env.OPENCLAW_DIR;
    if (env) return env.split(",")[0].trim();
    return join(homedir(), ".openclaw");
  },
  async *messages(root) {
    const dirs = process.env.OPENCLAW_DIR
      ? process.env.OPENCLAW_DIR.split(",").map((s) => s.trim())
      : [
          join(homedir(), ".openclaw"),
          join(homedir(), ".clawdbot"),
          join(homedir(), ".moltbot"),
          join(homedir(), ".moldbot"),
        ];
    const pred = (n) => isJsonl(n) || n.endsWith(".json"); // covers archived variants
    for (const dir of dirs) {
      for await (const path of walkFiles(dir, pred)) {
        const text = await readUtf8(path);
        for (const [ev] of parseJsonl(text, path)) {
          if (!ev || ev.role !== "assistant") continue;
          const u = ev.usage || ev.tokens || {};
          const input = Number(u.input_tokens || u.inputTokens || 0);
          const output = Number(u.output_tokens || u.outputTokens || 0);
          const cacheCreate = Number(
            u.cache_creation_tokens || u.cacheCreationTokens || 0,
          );
          const cacheRead = Number(
            u.cache_read_tokens || u.cacheReadTokens || 0,
          );
          if (input + output + cacheCreate + cacheRead === 0) continue;
          yield {
            id: ev.id || null,
            sid: null,
            ts: ev.timestamp || null,
            input,
            output,
            cacheCreate,
            cacheRead,
            file: path,
          };
        }
      }
    }
  },
};

// ── 6. Droid ──────────────────────────────────────────────────────────────────
// ~/.factory/sessions/**/*.settings.json
// Fields: input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, thinking_tokens
// Thinking tokens → output. Per-settings-file (session-level granularity).
// CUMULATIVE-COLUMN GUARD: settings files contain session-level totals. If the same session
// appears in multiple files, summing double-counts. We set both id and sid to the session id
// so tokenpull()'s (sid|id) keep-last dedup collapses duplicates to the latest values.
export const droidAdapter = {
  platform: "droid",
  defaultRoot: () => join(homedir(), ".factory", "sessions"),
  async *messages(root) {
    for (const r of roots("DROID_SESSIONS_DIR", root)) {
      for await (const path of walkFiles(r, (n) =>
        n.endsWith(".settings.json"),
      )) {
        const text = await readUtf8(path);
        if (!text) continue;
        let s;
        try {
          s = JSON.parse(text);
        } catch {
          continue;
        }
        const input = Number(s.input_tokens || 0);
        const output =
          Number(s.output_tokens || 0) + Number(s.thinking_tokens || 0);
        const cacheCreate = Number(s.cache_creation_tokens || 0);
        const cacheRead = Number(s.cache_read_tokens || 0);
        if (input + output + cacheCreate + cacheRead === 0) continue;
        const sessionId = String(s.session_id || s.id || "");
        yield {
          id: sessionId,
          sid: sessionId,
          ts: s.updated_at || s.created_at || null,
          input,
          output,
          cacheCreate,
          cacheRead,
          file: path,
        };
      }
    }
  },
};

// ── 7. Codebuff ───────────────────────────────────────────────────────────────
// ~/.config/manicode/projects/<project>/chats/<chat-id>/chat-messages.json
// assistant messages: metadata.usage or metadata.codebuff.usage
export const codebuffAdapter = {
  platform: "codebuff",
  defaultRoot: () => join(homedir(), ".config", "manicode"),
  async *messages(root) {
    const dirs = process.env.CODEBUFF_DATA_DIR
      ? process.env.CODEBUFF_DATA_DIR.split(",").map((s) => s.trim())
      : [
          join(homedir(), ".config", "manicode"),
          join(homedir(), ".config", "manicode-dev"),
          join(homedir(), ".config", "manicode-staging"),
        ];
    for (const dir of dirs) {
      for await (const path of walkFiles(
        dir,
        (n) => n === "chat-messages.json",
      )) {
        const text = await readUtf8(path);
        if (!text) continue;
        let msgs;
        try {
          msgs = JSON.parse(text);
        } catch {
          continue;
        }
        if (!Array.isArray(msgs)) continue;
        for (const msg of msgs) {
          if (!msg || msg.role !== "assistant") continue;
          const u =
            (msg.metadata &&
              (msg.metadata.usage || msg.metadata.codebuff?.usage)) ||
            {};
          const input = Number(u.input_tokens || u.inputTokens || 0);
          const output = Number(u.output_tokens || u.outputTokens || 0);
          const cacheCreate = Number(
            u.cache_creation_tokens || u.cacheCreationTokens || 0,
          );
          const cacheRead = Number(
            u.cache_read_tokens || u.cacheReadTokens || 0,
          );
          if (input + output + cacheCreate + cacheRead === 0) continue;
          yield {
            id: msg.id || null,
            sid: null,
            ts: msg.timestamp || msg.created_at || null,
            input,
            output,
            cacheCreate,
            cacheRead,
            file: path,
          };
        }
      }
    }
  },
};

// ── 8. Gemini CLI ─────────────────────────────────────────────────────────────
// ~/.gemini/tmp/*/chats/*.json and *.jsonl
// Fields: input, output, cached, thought (reasoning), tool, total
// SigRank mapping: input = input−cached (fresh), cacheRead = cached, cacheCreate = 0 (not exposed),
// output = output + thought (reasoning→output)
export const geminiAdapter = {
  platform: "gemini",
  estimated: true, // no cacheCreate field in Gemini logs
  defaultRoot: () => join(homedir(), ".gemini", "tmp"),
  async *messages(root) {
    for (const r of roots("GEMINI_DATA_DIR", root)) {
      for await (const path of walkFiles(
        r,
        (n) => n.endsWith(".json") || n.endsWith(".jsonl"),
      )) {
        const text = await readUtf8(path);
        if (!text) continue;
        // Try JSONL first, then single JSON
        let parsed = [];
        try {
          parsed = text
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l));
        } catch {
          try {
            parsed = [JSON.parse(text)];
          } catch {
            continue;
          }
        }
        for (const ev of parsed) {
          if (!ev) continue;
          // Gemini usage may be at top level or nested in usageMetadata
          const u = ev.usageMetadata || ev.usage || ev;
          const rawInput = Number(u.input || u.promptTokenCount || 0);
          const rawOutput = Number(u.output || u.candidatesTokenCount || 0);
          const cached = Number(u.cached || u.cachedContentTokenCount || 0);
          const thought = Number(u.thought || u.thoughtsTokenCount || 0);
          if (rawInput + rawOutput + cached + thought === 0) continue;
          const input = Math.max(0, rawInput - cached); // strip cached from input
          const output = rawOutput + thought; // reasoning → output
          yield {
            id: ev.id || null,
            sid: null,
            ts: ev.timestamp || null,
            input,
            output,
            cacheCreate: 0,
            cacheRead: cached,
            file: path,
          };
        }
      }
    }
  },
};

// ── 9. GitHub Copilot CLI ─────────────────────────────────────────────────────
// ~/.copilot/otel/*.jsonl  (requires COPILOT_OTEL_ENABLED=true before session start)
// OpenTelemetry spans; looks for llm.token_count.prompt / completion / cached attributes
export const copilotAdapter = {
  platform: "copilot",
  defaultRoot: () => join(homedir(), ".copilot", "otel"),
  async *messages(root) {
    const dir = process.env.COPILOT_OTEL_FILE_EXPORTER_PATH
      ? dirname(process.env.COPILOT_OTEL_FILE_EXPORTER_PATH)
      : root;
    for await (const path of walkFiles(dir, isJsonl)) {
      const text = await readUtf8(path);
      for (const [ev] of parseJsonl(text, path)) {
        if (!ev) continue;
        // OTel span: attributes may be an object or array of {key,value} pairs
        const attrs = ev.attributes || ev.resource?.attributes || {};
        const get = (k) => {
          if (typeof attrs === "object" && !Array.isArray(attrs))
            return attrs[k];
          if (Array.isArray(attrs)) {
            const a = attrs.find((x) => x.key === k);
            return a?.value?.intValue ?? a?.value?.stringValue ?? null;
          }
          return null;
        };
        const input = Number(
          get("llm.token_count.prompt") ||
            get("gen_ai.usage.input_tokens") ||
            0,
        );
        const output = Number(
          get("llm.token_count.completion") ||
            get("gen_ai.usage.output_tokens") ||
            0,
        );
        const cacheCreate = Number(get("llm.token_count.cache_creation") || 0);
        const cacheRead = Number(
          get("llm.token_count.cache_read") ||
            get("gen_ai.usage.cache_read_input_tokens") ||
            0,
        );
        if (input + output + cacheCreate + cacheRead === 0) continue;
        yield {
          id: ev.traceId || ev.spanId || null,
          sid: null,
          ts: ev.startTimeUnixNano
            ? new Date(Number(ev.startTimeUnixNano) / 1e6).toISOString()
            : null,
          input,
          output,
          cacheCreate,
          cacheRead,
          file: path,
        };
      }
    }
  },
  setupNote:
    "Requires COPILOT_OTEL_ENABLED=true and COPILOT_OTEL_EXPORTER_TYPE=file set BEFORE starting the Copilot session. Without this, no local token logs are written.",
};

// ── 10. OpenCode ──────────────────────────────────────────────────────────────
// ~/.local/share/opencode — JSON message files, but costs stored as 0 and token fields
// are calculated via LiteLLM pricing (not stored in the log). No raw token fields.
// SigRank cannot derive pillars from OpenCode logs with current log format.
export const opencodeAdapter = {
  platform: "opencode",
  defaultRoot: () => join(homedir(), ".local", "share", "opencode"),
  estimated: true,
  dataGap:
    "OpenCode logs store cost:0 and derive tokens via LiteLLM at runtime — raw token counts are not persisted. SigRank cannot read pillars from OpenCode logs with the current format. Track https://github.com/ccusage/ccusage for format changes.",
  // eslint-disable-next-line require-yield
  async *messages() {
    /* no data available */
  },
};

// ── 11. Goose ─────────────────────────────────────────────────────────────────
// SQLite: sessions.db at standard Goose data roots or $GOOSE_PATH_ROOT/data/sessions/sessions.db
// Columns: accumulated_input_tokens (or input_tokens), accumulated_output_tokens (or output_tokens),
//          accumulated_total_tokens (or total_tokens). NO cache fields. Reasoning = total-input-output.
// CUMULATIVE-COLUMN GUARD: accumulated_* columns are per-session running totals. If the sessions
// table has multiple rows per session id, summing them downstream double-counts. We set both sid
// and id to the session id and ORDER BY updated_at so tokenpull()'s (sid|id) keep-last dedup
// collapses duplicate session rows to the latest (max accumulated) values.
export const gooseAdapter = {
  platform: "goose",
  estimated: true, // no cacheCreate or cacheRead
  defaultRoot: () => {
    const env = process.env.GOOSE_PATH_ROOT;
    if (env) return env;
    // Standard locations (macOS first, then XDG)
    return join(homedir(), "Library", "Application Support", "goose");
  },
  async *messages(root) {
    const dbCandidates = process.env.GOOSE_PATH_ROOT
      ? [join(process.env.GOOSE_PATH_ROOT, "data", "sessions", "sessions.db")]
      : [
          join(
            homedir(),
            "Library",
            "Application Support",
            "goose",
            "sessions",
            "sessions.db",
          ),
          join(
            homedir(),
            ".local",
            "share",
            "goose",
            "sessions",
            "sessions.db",
          ),
          join(
            homedir(),
            ".local",
            "share",
            "Block",
            "goose",
            "sessions",
            "sessions.db",
          ),
        ];
    for (const db of dbCandidates) {
      // ORDER BY updated_at so the latest cumulative row per session is yielded last
      // (tokenpull keep-last dedup picks the final row = max accumulated values).
      const rows = await sqliteJson(
        db,
        "SELECT * FROM sessions ORDER BY updated_at",
      );
      for (const row of rows) {
        const input = Number(
          row.accumulated_input_tokens || row.input_tokens || 0,
        );
        const output = Number(
          row.accumulated_output_tokens || row.output_tokens || 0,
        );
        const total = Number(
          row.accumulated_total_tokens || row.total_tokens || 0,
        );
        const reasoning = Math.max(0, total - input - output); // folded into output
        if (input + output === 0) continue;
        const sessionId = String(row.id || row.session_id || "");
        yield {
          id: sessionId,
          sid: sessionId,
          ts: row.created_at || row.updated_at || null,
          input,
          output: output + reasoning,
          cacheCreate: 0,
          cacheRead: 0,
          file: db,
        };
      }
    }
  },
};

// ── 12. Kilo ──────────────────────────────────────────────────────────────────
// SQLite: ~/.local/share/kilo/kilo.db
// Per-message rows with model, input/output/cache token columns.
export const kiloAdapter = {
  platform: "kilo",
  defaultRoot: () => join(homedir(), ".local", "share", "kilo"),
  async *messages(root) {
    const dbPath = join(roots("KILO_DATA_DIR", root)[0], "kilo.db");
    const rows = await sqliteJson(
      dbPath,
      'SELECT * FROM messages WHERE role="assistant"',
    );
    for (const row of rows) {
      const input = Number(row.input_tokens || row.inputTokens || 0);
      const output = Number(row.output_tokens || row.outputTokens || 0);
      const cacheCreate = Number(
        row.cache_creation_tokens || row.cacheCreationTokens || 0,
      );
      const cacheRead = Number(
        row.cache_read_tokens || row.cacheReadTokens || 0,
      );
      if (input + output + cacheCreate + cacheRead === 0) continue;
      yield {
        id: String(row.id || ""),
        sid: String(row.session_id || row.sessionId || ""),
        ts: row.created_at || row.timestamp || null,
        input,
        output,
        cacheCreate,
        cacheRead,
        file: dbPath,
      };
    }
  },
};

// ── 13. Hermes Agent ─────────────────────────────────────────────────────────
// SQLite: ~/.hermes/state.db
// Per-session rows: input, output, cache_read, cache_write (=cacheCreate), reasoning_tokens → output
// CUMULATIVE-COLUMN GUARD: session rows may contain cumulative totals. If the same session
// appears in multiple rows, summing double-counts. We set both id and sid to the session id
// and ORDER BY updated_at so tokenpull()'s (sid|id) keep-last dedup collapses duplicates
// to the latest values.
export const hermesAdapter = {
  platform: "hermes",
  defaultRoot: () => join(homedir(), ".hermes"),
  async *messages(root) {
    for (const r of roots("HERMES_HOME", root)) {
      const dbPath = join(r, "state.db");
      // ORDER BY updated_at so the latest cumulative row per session is yielded last.
      const rows = await sqliteJson(
        dbPath,
        "SELECT * FROM sessions ORDER BY updated_at",
      );
      for (const row of rows) {
        const input = Number(row.input || 0);
        const reasoning = Number(row.reasoning_tokens || 0);
        const output = Number(row.output || 0) + reasoning;
        const cacheCreate = Number(row.cache_write || row.cache_creation || 0);
        const cacheRead = Number(row.cache_read || 0);
        if (input + output + cacheCreate + cacheRead === 0) continue;
        const sessionId = String(row.id || row.session_id || "");
        yield {
          id: sessionId,
          sid: sessionId,
          ts: row.created_at || row.updated_at || null,
          input,
          output,
          cacheCreate,
          cacheRead,
          file: dbPath,
        };
      }
    }
  },
};

// ── 14. Devin CLI ────────────────────────────────────────────────────────────
// SQLite: ~/.local/share/devin/cli/sessions.db
// Same combined-input problem as Codex: input_tokens INCLUDES cache write, so we
// yield { ts, output, cacheRead, uncached } and let tokenpullCodex() do the
// ioRatio split (input = output × ioRatio, cacheCreate = uncached − input).
// ioRatio comes from Claude (Beta = operator's Claude input/output ratio) or
// the Alpha 2.0 default (matches Codex; the "7:1:2 average → 0.5" note in a
// prior revision was wrong — tokenpullAny defaults ioRatio to 2.0 for both).
export const devinAdapter = {
  platform: "devin",
  defaultRoot: () => join(homedir(), ".local", "share", "devin", "cli"),
  async *records(root) {
    for (const r of roots("DEVIN_HOME", root)) {
      const dbPath = join(r, "sessions.db");
      const rows = await sqliteJson(
        dbPath,
        `SELECT row_id, session_id,
                json_extract(chat_message, '$.metadata.metrics.input_tokens') as input_tokens,
                json_extract(chat_message, '$.metadata.metrics.output_tokens') as output_tokens,
                json_extract(chat_message, '$.metadata.metrics.cache_read_tokens') as cache_read_tokens,
                json_extract(chat_message, '$.metadata.created_at') as created_at
         FROM message_nodes
         WHERE json_extract(chat_message, '$.role') = 'assistant'
           AND json_extract(chat_message, '$.metadata.metrics.input_tokens') IS NOT NULL
         ORDER BY created_at`,
        60_000,
      );
      for (const row of rows) {
        const inputIncl = Number(row.input_tokens || 0);
        const cached = Number(row.cache_read_tokens || 0);
        const output = Number(row.output_tokens || 0);
        if (inputIncl + output + cached === 0) continue;
        yield {
          ts: row.created_at || null,
          output,
          cacheRead: cached,
          uncached: Math.max(0, inputIncl - cached),
          file: dbPath,
        };
      }
    }
  },
};

// ── 15. Other (user-supplied JSON) ───────────────────────────────────────────
// For platforms/models not yet on the adapter list. The user writes a JSON file
// with the 4 pillars per window and points SIGRANK_OTHER_PATH at it. This lets
// anyone with a new tool submit without needing a custom adapter.
//
// JSON format (all fields optional, missing windows are skipped):
// {
//   "platform": "my-tool",           // optional, defaults to "other"
//   "windows": {
//     "all":  { "input": 1000, "output": 2000, "cacheCreate": 500, "cacheRead": 8000 },
//     "30d":  { "input":  500, "output": 1000, "cacheCreate": 200, "cacheRead": 4000 },
//     "7d":   { "input":  100, "output":  200, "cacheCreate":  50, "cacheRead":  800 }
//   }
// }
//
// The adapter yields ONE message carrying the all-time pillars. The generic
// tokenpull aggregator buckets by timestamp, and these records carry no
// timestamp (ts: null → "all" window only, same as null-ts records in other
// adapters). Yielding one message PER window key — as a prior version did —
// caused the "all" total to be the SUM of every window entry (all + 30d + 7d
// …), i.e. a multi-count. This is the only user-facing wrong-number bug in
// ingestion: an operator who filled in all four windows saw an "all" Υ
// computed from 2–4× the real pillars.
//
// Fix: yield exactly one record. If the JSON has an "all" entry, use it
// verbatim; otherwise sum the provided windows into a synthetic all-time
// total. The 7d/30d/90d entries are accepted (so the file format stays
// forward-compatible) but are NOT yielded as separate records — the generic
// aggregator has no way to route a timestamp-less record into a bounded
// window, so emitting them would only re-introduce the overcount. An operator
// who wants windowed data must use a real adapter that carries timestamps.
export const otherAdapter = {
  platform: "other",
  defaultRoot: () => process.env.SIGRANK_OTHER_PATH || "",
  async *messages(root) {
    const filePath = root || process.env.SIGRANK_OTHER_PATH;
    if (!filePath) {
      throw new Error(
        "other adapter: set SIGRANK_OTHER_PATH to a JSON file with your token pillars. " +
          'Format: { "windows": { "all": { "input": N, "output": N, "cacheCreate": N, "cacheRead": N } } }',
      );
    }
    let text;
    try {
      text = await readFile(filePath, "utf8");
    } catch {
      throw new Error(`other adapter: cannot read ${filePath} — check SIGRANK_OTHER_PATH`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`other adapter: invalid JSON in ${filePath}`);
    }
    const windows = data.windows || {};
    const norm = (p) => ({
      input: Number(p?.input || 0),
      output: Number(p?.output || 0),
      cacheCreate: Number(p?.cacheCreate || p?.cache_create || 0),
      cacheRead: Number(p?.cacheRead || p?.cache_read || 0),
    });
    let all;
    if (windows.all) {
      // Explicit all-time entry → use verbatim (do NOT add 7d/30d/90d on top).
      all = norm(windows.all);
    } else {
      // No "all" key → fold the provided windows into a synthetic all-time.
      all = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
      for (const pillars of Object.values(windows)) {
        const n = norm(pillars);
        all.input += n.input;
        all.output += n.output;
        all.cacheCreate += n.cacheCreate;
        all.cacheRead += n.cacheRead;
      }
    }
    if (all.input + all.output + all.cacheCreate + all.cacheRead === 0) return;
    yield {
      id: `other:all`,
      sid: `other-all`,
      ts: null, // no timestamp → lands in "all" window only
      input: all.input,
      output: all.output,
      cacheCreate: all.cacheCreate,
      cacheRead: all.cacheRead,
      file: filePath,
    };
  },
};

// ── 16. oh-my-pi (omp) ───────────────────────────────────────────────────────
// ~/.omp/agent/sessions/<bucket>/<timestamp>_<sessionId>/<name>.jsonl (recursive)
// NOT pi-agent (#4): oh-my-pi forked from pi long ago and is a separate harness
// with its own on-disk format. Line 1 is a fixed-width 256-byte {"type":"title"}
// slot; line 2 is {"type":"session"} and carries the session `.id`. Neither line
// holds usage. Other observed `.type` values (all usage-free): custom,
// custom_message, model_change, thinking_level_change, session_init, credential_pin.
// Usage lives at `.message.usage` on `.type === "message"` entries:
//   { input, output, cacheRead, cacheWrite, totalTokens, reasoningTokens, cost:{…} }
// Native 4-pillar (no estimation): input→input, output→output,
// cacheWrite→cacheCreate, cacheRead→cacheRead.
// TRAP 1 — reasoningTokens is ALREADY INSIDE output. Do NOT fold it in. Every other
//   adapter here folds reasoning into output, so the reflex is wrong for omp; adding
//   it double-counts. Proof: totalTokens === input+output+cacheRead+cacheWrite
//   exactly, and reasoningTokens is always ≤ output.
// TRAP 2 — usage.cost reuses the SAME four key names (input/output/cacheRead/
//   cacheWrite, plus total) for USD floats. Read the four counts straight off
//   `usage`; never descend into `cost`. Cost fields are never forwarded (file header).
// Nested subagent transcripts (critic.jsonl beside critic/__advisor.jsonl) are real
// operator work and ARE counted — same policy as Claude's `subagents/`.
// Dedup key is (session header `.id`, entry top-level `.id`) — `.message` has no id.
// File cap: a real omp tree runs to 20k+ transcripts, past walkFiles' 10_000 default,
// which would silently drop half the operator's tokens — pass an explicit cap.
const OMP_MAX_FILES = 500_000;

// ── Stage 1: bounded-concurrency + line-guard optimization ───────────────────
// Based on George-RD's measured findings (PR #32 review comment):
//   - CPU-bound, not disk-bound: 90.5% of one thread, tree fully page-cached
//   - c=8 is optimal: 45.06s → 34.92s (1.29x), regresses at c12/c16
//   - Line guard MUST pass both "message" AND "session" lines, or it breaks
//     the (session_id, entry_id) dedup key — session header lines carry the id
//   - Two-term guard: 0 false negatives across 2.18M lines
//   - All 504 duplicate keys carry byte-identical pillar tuples → order-safe
//   - Only ~1-3% end-to-end win from the guard alone (omp's skippable lines are
//     19.8% of lines but 15.3% of bytes); the guard costs 1.2s but saves parse
//     on lines that can't contain usage. Folded into concurrency, not standalone.
const OMP_CONCURRENCY = 8;

/** Check if a line could contain an omp usage record or session header.
 *  Conservative: false positives are fine, false negatives are not.
 *  Must match both "message" (usage) and "session" (dedup key) lines. */
function ompLineCouldMatter(line) {
  // Fast substring check before JSON.parse — rejects ~20% of lines that are
  // neither message nor session entries (tool calls, reasoning, etc.)
  return line.includes('"message"') || line.includes('"session"');
}

/** Parse a single omp transcript file and yield usage records.
 *  Isolated so it can be called concurrently from the bounded pool.
 *  Exported for omp-cache.mjs and tests. */
export function* parseOmpFile(text, path) {
  if (!text) return;
  let sid = null;
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    // Line guard: skip lines that can't be message or session entries.
    // George-RD verified 0 false negatives across 2.18M lines with this guard.
    if (!ompLineCouldMatter(s)) continue;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    if (!ev) continue;
    if (ev.type === "session") {
      sid = ev.id || null;
      continue;
    }
    if (ev.type !== "message") continue;
    const u = ev.message && ev.message.usage;
    if (!u) continue;
    const input = Number(u.input || 0);
    const output = Number(u.output || 0); // reasoningTokens ALREADY inside — TRAP 1
    const cacheCreate = Number(u.cacheWrite || 0);
    const cacheRead = Number(u.cacheRead || 0);
    if (input + output + cacheCreate + cacheRead === 0) continue;
    yield {
      id: ev.id || null,
      sid,
      ts: ev.timestamp || null,
      input,
      output,
      cacheCreate,
      cacheRead,
      file: path,
    };
  }
}

export const ompAdapter = {
  platform: "omp",
  defaultRoot: () => join(homedir(), ".omp", "agent", "sessions"),
  async *messages(root) {
    for (const r of roots("OMP_DATA_DIR", root)) {
      // Stage 2: if SIGRANK_OMP_CACHE is set, use the incremental SQLite cache.
      // The cache wraps the Stage 1 scanner — on a warm run with no changed
      // files, it serves records from SQLite without reading transcripts.
      // Falls back to uncached on any error.
      if (ompCacheEnabled()) {
        yield* cachedOmpScan({
          rootDir: r,
          uncachedScan: async function* () {
            yield* ompUncachedScan(r);
          },
          parseOmpFile,
          readUtf8,
          walkFiles,
          isJsonl,
          maxFiles: OMP_MAX_FILES,
        });
        continue;
      }

      // Default: uncached Stage 1 scan
      yield* ompUncachedScan(r);
    }
  },
};

/** Stage 1 uncached scan — bounded concurrency + line guard.
 *  Isolated so the cache wrapper can call it as the fallback/parity reference. */
async function* ompUncachedScan(rootDir) {
  // Collect all file paths first (readdir is 0.8% of scan time — negligible)
  const paths = [];
  for await (const path of walkFiles(rootDir, isJsonl, { n: 0 }, OMP_MAX_FILES)) {
    paths.push(path);
  }

  // Bounded-concurrency read+parse: George-RD measured c=8 as optimal
  // (1.29x speedup, 45s → 35s). Order-safe: all 504 duplicate keys carry
  // byte-identical pillar tuples, so completion order can't change totals.
  const concurrency = OMP_CONCURRENCY;
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
}

// ── SigRank local API proxy ──────────────────────────────────────────────────
// ~/.sigrank-mcp/proxy-sessions.jsonl — one provider-reported usage record per
// API call. Native 4-pillar data; OpenAI's inclusive input count is normalized
// by proxy.mjs before it reaches this adapter.
export const proxyAdapter = {
  platform: "proxy",
  defaultRoot: () =>
    join(homedir(), ".sigrank-mcp", "proxy-sessions.jsonl"),
  async *messages(root) {
    const path = root || this.defaultRoot();
    const text = await readUtf8(path);
    for (const [ev] of parseJsonl(text, path)) {
      if (!ev || typeof ev !== "object") continue;
      const input = Number(ev.input);
      const output = Number(ev.output);
      const cacheCreate = Number(ev.cacheCreate);
      const cacheRead = Number(ev.cacheRead);
      if (
        ![input, output, cacheCreate, cacheRead].every(
          (n) => Number.isFinite(n) && n >= 0,
        )
      ) {
        continue;
      }
      if (input + output + cacheCreate + cacheRead === 0) continue;
      yield {
        // tokenpull() keeps the final record for a duplicate id, which gives
        // this adapter the requested same-timestamp keep-last behavior.
        id: typeof ev.ts === "string" && ev.ts ? ev.ts : null,
        sid: null,
        ts: typeof ev.ts === "string" ? ev.ts : null,
        input,
        output,
        cacheCreate,
        cacheRead,
        model: typeof ev.model === "string" ? ev.model : null,
        backend: typeof ev.backend === "string" ? ev.backend : null,
        file: path,
      };
    }
  },
};

// ── Registry ──────────────────────────────────────────────────────────────────
/** All non-Claude, non-Codex adapters keyed by platform ID. */
export const ADAPTERS = {
  amp: ampAdapter,
  kimi: kimiAdapter,
  qwen: qwenAdapter,
  pi: piAdapter,
  openclaw: openclawAdapter,
  droid: droidAdapter,
  codebuff: codebuffAdapter,
  gemini: geminiAdapter,
  copilot: copilotAdapter,
  opencode: opencodeAdapter,
  goose: gooseAdapter,
  kilo: kiloAdapter,
  hermes: hermesAdapter,
  devin: devinAdapter,
  other: otherAdapter,
  omp: ompAdapter,
  proxy: proxyAdapter,
};

export const ALL_PLATFORMS = Object.keys(ADAPTERS).concat(["claude", "codex"]);
