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
 *   - Reasoning / thinking tokens → folded into `output` (they are output-side spend)
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

const execFileP = promisify(execFileCb);
const DAY_MS = 86_400_000; // shared with tokenpull.mjs but kept local to avoid circular import

// ── File-system helpers ───────────────────────────────────────────────────────

/** Recursively yield every file whose name matches `pred` under dir (skips symlink dirs). */
async function* walkFiles(dir, pred, counter = { n: 0 }, max = 10_000) {
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

const isJsonl = (n) =>
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
// ioRatio comes from Claude (Beta) or the 7:1:2 average (Alpha = 0.5).
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
};

export const ALL_PLATFORMS = Object.keys(ADAPTERS).concat(["claude", "codex"]);
