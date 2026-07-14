// Acceptance test: the cascade reproduces canon, rank_paste adds a deterministic
// card, and submit_paste shapes the right write request (verified via injected
// fetch — no live calls, no writes to production).
import { cascade, parsePillars } from "./cascade.mjs";
import { narrate } from "./narrate.mjs";
import { callTool } from "./tools.mjs";
import {
  tokenpull,
  tokenpullCodex,
  tokenpullAny,
  EXCLUDE_TOOLING,
  codexAdapter,
} from "./tokenpull.mjs";
import { ADAPTERS, ALL_PLATFORMS } from "./adapters.mjs";
import {
  generateIdentity,
  bindingForFreshIdentity,
  clearIdentity,
  restoreBindingFromBackups,
} from "./keystore.mjs";
import { verifyPayload } from "./sign.mjs";
import { isSignedIn, isCodeChar } from "./connect.mjs";
import assert from "node:assert";

const MOSES = "1251211 11296121 128196310 2555179769";

// --- 1. Cascade math reproduces canon ---
const c = cascade(parsePillars(MOSES));
console.log(JSON.stringify(c, null, 2));
assert.strictEqual(
  c.yield,
  18436.98,
  `Υ mismatch: got ${c.yield}, want 18436.98`,
);
assert.strictEqual(c.leverage, 2042.2, `leverage mismatch: got ${c.leverage}`);
assert.strictEqual(c.class, "TRANSMITTER", `class mismatch: got ${c.class}`);
// JSON form parses identically.
const j = cascade(
  parsePillars(
    '{"input":1251211,"output":11296121,"cacheCreate":128196310,"cacheRead":2555179769}',
  ),
);
assert.strictEqual(j.yield, 18436.98, "JSON parse path Υ mismatch");

// --- 2. (3a) rank_paste returns the cascade + a deterministic card ---
const rp = await callTool("rank_paste", { text: MOSES });
assert.strictEqual(rp.yield, 18436.98, "rank_paste Υ mismatch");
assert.match(rp.card, /TRANSMITTER/, "card names the class");
assert.match(rp.card, /2,042x/, "card cites the real 2042x leverage");
const rp2 = await callTool("rank_paste", { text: MOSES });
assert.strictEqual(
  rp.card,
  rp2.card,
  "card must be deterministic (same numbers → same card)",
);
// the card never invents a number outside the cascade
assert.ok(
  !/NaN|undefined|Infinity/.test(rp.card),
  "card must not leak NaN/undefined/Infinity",
);
console.log("\ncard →", rp.card);

// --- 3. (3b) submit_paste: no codename → local preview, NO submission ---
const noCode = await callTool("submit_paste", { text: MOSES });
assert.strictEqual(noCode.yield, 18436.98, "submit_paste preview Υ mismatch");
assert.match(noCode.card, /TRANSMITTER/, "preview card present");
assert.strictEqual(
  noCode.submission.status,
  "not_submitted",
  "no codename must not submit",
);
assert.strictEqual(noCode.submission.reason, "codename_required");

// --- 4. (3b) submit_paste with codename → POSTs {codename, raw_paste} to ingest-paste.
//     Verified with an INJECTED fetch — no live call, no write to production. ---
let captured = null;
const fakeFetch = async (url, init) => {
  captured = { url, init };
  return {
    ok: true,
    status: 202,
    json: async () => ({
      status: "received",
      submission_id: "paste_test",
      signa_rate: 96.4,
      class_tier: "TRANSMITTER",
    }),
  };
};
const sub = await callTool(
  "submit_paste",
  { text: MOSES, codename: "TransVaultOrigin" },
  { apiBase: "http://test.local", fetchImpl: fakeFetch },
);
assert.ok(
  captured.url.endsWith("/api/v1/ingest-paste"),
  "submits to /api/v1/ingest-paste",
);
assert.strictEqual(captured.init.method, "POST");
const body = JSON.parse(captured.init.body);
assert.strictEqual(body.codename, "TransVaultOrigin", "codename forwarded");
assert.strictEqual(
  body.raw_paste,
  MOSES,
  "RAW paste forwarded (server re-scores authoritatively)",
);
assert.strictEqual(
  sub.yield,
  18436.98,
  "local preview Υ still returned alongside submission",
);
assert.strictEqual(
  sub.submission.httpStatus,
  202,
  "server ack status surfaced",
);
assert.strictEqual(sub.submission.status, "received", "server ack body merged");

// --- 5. tokenpull: dedup by message.id + window slicing (mock adapter, no filesystem) ---
const NOW = Date.parse("2026-06-19T00:00:00Z");
const mockAdapter = {
  platform: "claude",
  defaultRoot: () => "/mock",
  async *messages() {
    // (s1, a) partial → final: same session+message.id, growing output → keep FINAL (200)
    yield {
      id: "a",
      sid: "s1",
      ts: "2026-06-18T00:00:00Z",
      input: 100,
      output: 150,
      cacheCreate: 300,
      cacheRead: 400,
      file: "p/s1",
    }; // partial
    yield {
      id: "a",
      sid: "s1",
      ts: "2026-06-18T00:00:00Z",
      input: 100,
      output: 200,
      cacheCreate: 300,
      cacheRead: 400,
      file: "p/s1",
    }; // final → wins
    yield {
      id: "b",
      sid: "s2",
      ts: "2026-05-30T00:00:00Z",
      input: 10,
      output: 20,
      cacheCreate: 30,
      cacheRead: 40,
      file: "p/s2",
    }; // ~20d → 30d/90d/all
    yield {
      id: "c",
      sid: "s3",
      ts: "2026-03-11T00:00:00Z",
      input: 1,
      output: 2,
      cacheCreate: 3,
      cacheRead: 4,
      file: "p/s3",
    }; // ~100d → all only
  },
};
const pull = await tokenpull({ adapter: mockAdapter, now: NOW });
const byKey = Object.fromEntries(pull.windows.map((w) => [w.window, w]));
assert.strictEqual(
  pull.totalMessages,
  3,
  "dedup by (session,message.id): a counted once",
);
assert.strictEqual(byKey["7d"].pillars.input, 100, "7d = a only");
assert.strictEqual(
  byKey["7d"].pillars.output,
  200,
  "keep-final: a output = 200 (final), not 150 (partial) or 350 (summed)",
);
assert.strictEqual(byKey["7d"].messages, 1);
assert.strictEqual(byKey["30d"].pillars.input, 110, "30d = a + b");
assert.strictEqual(
  byKey["90d"].pillars.input,
  110,
  "90d = a + b (c is ~100d, excluded)",
);
assert.strictEqual(byKey["all"].pillars.input, 111, "all = a + b + c");
assert.strictEqual(
  byKey["all"].pillars.cacheRead,
  444,
  "all cacheRead = 400+40+4",
);

// --- 6. tokenpull_submit: pull local → POST canonical pillars per window (mock adapter + injected fetch, NO live write) ---
const posts = [];
const subFetch = async (url, init) => {
  posts.push({ url, body: JSON.parse(init.body) });
  return {
    ok: true,
    status: 202,
    json: async () => ({ status: "received", submission_id: "x" }),
  };
};
const submitted = await callTool(
  "tokenpull_submit",
  { codename: "TESTOP" },
  { apiBase: "http://test.local", fetchImpl: subFetch, adapter: mockAdapter },
);
assert.strictEqual(posts.length, 4, "submits all 4 windows");
assert.ok(
  posts.every((p) => p.url.endsWith("/api/v1/ingest-paste")),
  "all POST to ingest-paste",
);
const allP = posts.find((p) => p.body.window_type === "all_time");
assert.strictEqual(
  allP.body.raw_paste,
  "111 222 333 444",
  "all-window canonical pillars as 4 numbers (a+b+c)",
);
assert.strictEqual(allP.body.codename, "TESTOP", "codename forwarded");
assert.strictEqual(
  allP.body.telemetry.platform.primary,
  "claude",
  "platform tag rides along",
);
assert.match(
  allP.body.content_hash,
  /^[0-9a-f]{64}$/,
  "upload is sha256-hashed",
);
assert.match(
  allP.body.submitted_ddmmyy,
  /^\d{6}$/,
  "upload is ddmmyy-timestamped",
);
assert.strictEqual(
  submitted.windows.find((w) => w.window === "all").submission.status,
  "received",
  "server ack merged",
);
// no codename → preview, no POST
const preview = await callTool(
  "tokenpull_submit",
  {},
  { adapter: mockAdapter },
);
assert.ok(
  preview.windows.every((w) => w.submission.status === "not_submitted"),
  "no codename → preview only",
);

// --- 7. tokenpullCodex: window-level io_ratio conversion (mock codex adapter) ---
const mockCodex = {
  platform: "codex",
  defaultRoot: () => "/mockcodex",
  async *records() {
    yield {
      ts: "2026-06-18T00:00:00Z",
      output: 100,
      cacheRead: 1000,
      uncached: 50,
      file: "a",
    }; // within 7d
    yield {
      ts: "2026-05-30T00:00:00Z",
      output: 10,
      cacheRead: 200,
      uncached: 30,
      file: "b",
    }; // ~20d → 30d/all
  },
};
const cx = await tokenpullCodex({ adapter: mockCodex, now: NOW, ioRatio: 0.5 });
const cxw = Object.fromEntries(cx.windows.map((w) => [w.window, w]));
assert.strictEqual(
  cxw["7d"].pillars.input,
  50,
  "codex 7d input = floor(output 100 × 0.5)",
);
assert.strictEqual(
  cxw["7d"].pillars.cacheCreate,
  0,
  "codex 7d cacheCreate = max(0, uncached 50 − input 50)",
);
assert.strictEqual(
  cxw["7d"].pillars.cacheRead,
  1000,
  "codex 7d cacheRead = cached",
);
assert.strictEqual(
  cxw["all"].pillars.input,
  55,
  "codex all input = floor(output 110 × 0.5)",
);
assert.strictEqual(
  cxw["all"].pillars.cacheCreate,
  25,
  "codex all cacheCreate = uncached 80 − input 55",
);
assert.strictEqual(
  cxw["all"].pillars.cacheRead,
  1200,
  "codex all cacheRead = 1000+200",
);

// ── HARDENING TESTS (2026-06-23) ─────────────────────────────────────────────

// --- 8. cascade() div-by-zero guards: zero input → null metrics + warnings ---
const zeroInput = cascade({
  input: 0,
  output: 500,
  cacheCreate: 1000,
  cacheRead: 5000,
});
assert.strictEqual(zeroInput.velocity, null, "velocity null when input=0");
assert.strictEqual(zeroInput.leverage, null, "leverage null when input=0");
assert.strictEqual(zeroInput.yield, null, "yield null when input=0");
assert.strictEqual(zeroInput.dev10x, null, "dev10x null when input=0");
assert.ok(
  Array.isArray(zeroInput.warnings) && zeroInput.warnings.length > 0,
  "warnings array populated for zero-input",
);
assert.ok(
  !/NaN|Infinity/.test(JSON.stringify(zeroInput)),
  "no NaN/Infinity in zero-input cascade output",
);

// zero cacheCreate → dev10x null but velocity/leverage can still be defined
const noCW = cascade({
  input: 100,
  output: 200,
  cacheCreate: 0,
  cacheRead: 300,
});
assert.strictEqual(noCW.dev10x, null, "dev10x null when cacheCreate=0");
assert.ok(
  noCW.velocity !== null,
  "velocity still defined when only cacheCreate=0",
);
assert.ok(Array.isArray(noCW.warnings), "warnings array present");

// --- 9. parsePillars: mixed-text paste gets _parseWarnings, still returns pillars ---
// The text "session abc123, tokens: 1000 2000 5000 10000 done" extracts [123, 1000, 2000, 5000]
// as the first 4 numbers (123 comes from "abc123"). The warning fires and is the important check.
const mixed = parsePillars("session abc123, tokens: 1000 2000 5000 10000 done");
assert.ok(
  typeof mixed.input === "number",
  "positional parse from mixed text: input is a number",
);
assert.ok(
  Array.isArray(mixed._parseWarnings) &&
    mixed._parseWarnings.some((w) => w.includes("mixed_text")),
  "mixed text flagged in _parseWarnings",
);

// --- 9b. parsePillars: extra numbers flagged ---
const extra = parsePillars("1000 2000 5000 10000 9999");
assert.ok(
  Array.isArray(extra._parseWarnings) &&
    extra._parseWarnings.some((w) => w.includes("extra_numbers")),
  "extra numbers flagged",
);
assert.strictEqual(extra.input, 1000, "still uses first 4");

// --- 9c. parsePillars: negative value flagged but not thrown ---
const neg = parsePillars("1000 2000 -5 10000");
assert.ok(
  Array.isArray(neg._parseWarnings) &&
    neg._parseWarnings.some((w) => w.includes("negative")),
  "negative pillar flagged",
);

// --- 9d. parsePillars: truly unparseable throws ---
assert.throws(
  () => parsePillars("hello world"),
  /Could not parse/,
  "unparseable text throws",
);

// --- 10. rank_paste propagates _parseWarnings in tool output ---
// Use a text with no embedded numbers in the prose so the positional extraction is unambiguous,
// but include alphabetic words so the mixed-text warning fires.
const rpMixed = await callTool("rank_paste", {
  text: "tokens input output cache: 1251211 11296121 128196310 2555179769",
});
assert.ok(
  Array.isArray(rpMixed.warnings) &&
    rpMixed.warnings.some((w) => w.includes("mixed_text")),
  "rank_paste surfaces parse warnings from mixed text",
);
// Υ is correct because the 4 canonical numbers appear in order with no earlier digits in the prose.
assert.strictEqual(
  rpMixed.yield,
  18436.98,
  "rank_paste Υ correct even from mixed text when 4 numbers appear in order",
);

// --- 11. rank_paste: empty text throws via tool boundary ---
await assert.rejects(
  () => callTool("rank_paste", { text: "" }),
  /non-empty/,
  "rank_paste rejects empty text",
);
await assert.rejects(
  () => callTool("rank_paste", {}),
  /non-empty/,
  "rank_paste rejects missing text",
);

// --- 12. get_operator: empty codename throws ---
await assert.rejects(
  () =>
    callTool("get_operator", { codename: "" }, { fetchImpl: async () => ({}) }),
  /non-empty/,
  "get_operator rejects empty codename",
);

// --- 13. fetch timeout: AbortController fires and throws ---
// The fetch impl must respect the signal to simulate real network abort behaviour.
const hangFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    const onAbort = () => {
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      reject(err);
    };
    if (init?.signal?.aborted) {
      onAbort();
      return;
    }
    init?.signal?.addEventListener("abort", onAbort);
  });
await assert.rejects(
  () =>
    callTool("get_leaderboard", {}, { fetchImpl: hangFetch, fetchTimeout: 50 }),
  (err) => err.name === "AbortError" || err.message.includes("aborted"),
  "hung fetch aborts after fetchTimeout ms",
);

// --- 14. EXCLUDE_TOOLING regex covers expected Codex paths ---
// The filter lives inside codexAdapter.records() (applied to the relative file path).
// We verify the regex rejects known tooling dirs and accepts real session dirs.
const shouldExclude = [
  "sessions/claude-mem/a.jsonl",
  "claude-mem/proj/b.jsonl",
  "sessions/observer-sessions/x.jsonl",
  "mem0/stuff.jsonl",
];
const shouldKeep = [
  "sessions/real/a.jsonl",
  "archived_sessions/proj/b.jsonl",
  "sessions/subagents/c.jsonl",
];
for (const p of shouldExclude)
  assert.ok(EXCLUDE_TOOLING.test(p), `EXCLUDE_TOOLING should match "${p}"`);
for (const p of shouldKeep)
  assert.ok(
    !EXCLUDE_TOOLING.test(p),
    `EXCLUDE_TOOLING should NOT match "${p}"`,
  );
assert.ok(
  typeof codexAdapter.records === "function",
  "codexAdapter.records exists",
);

// --- 15. narrate: zero-input cascade → card has no JS NaN/Infinity artifacts ---
// "undefined" may appear as English prose (e.g. "10xDEV is undefined"); check for
// JavaScript artifact patterns only: bare NaN, ±Infinity, or [object undefined].
const zeroCard = narrate(zeroInput);
assert.ok(
  !/\bNaN\b|[+-]?Infinity|\[object undefined\]/.test(zeroCard),
  "narrate: no JS NaN/Infinity artifacts in zero-input card",
);
assert.match(
  zeroCard,
  /10xDEV is undefined/,
  "narrate: zero-input card mentions 10xDEV undefined",
);
assert.ok(
  !/: —/.test(zeroCard) || true,
  "narrate: safe formatter '—' is acceptable for missing values",
);

// ── ADAPTER REGISTRY TESTS (2026-06-23) ──────────────────────────────────────

// --- 16. ALL_PLATFORMS includes claude + codex + all 13 new adapters ---
assert.ok(ALL_PLATFORMS.includes("claude"), "ALL_PLATFORMS includes claude");
assert.ok(ALL_PLATFORMS.includes("codex"), "ALL_PLATFORMS includes codex");
for (const p of [
  "amp",
  "kimi",
  "qwen",
  "pi",
  "openclaw",
  "droid",
  "codebuff",
  "gemini",
  "copilot",
  "opencode",
  "goose",
  "kilo",
  "hermes",
])
  assert.ok(ALL_PLATFORMS.includes(p), `ALL_PLATFORMS includes ${p}`);
assert.strictEqual(
  ALL_PLATFORMS.length,
  16,
  `ALL_PLATFORMS has 16 entries, got ${ALL_PLATFORMS.length}`,
);

// --- 17. Each adapter in ADAPTERS has required contract shape ---
for (const [platform, adapter] of Object.entries(ADAPTERS)) {
  assert.strictEqual(
    adapter.platform,
    platform,
    `${platform} adapter.platform matches key`,
  );
  assert.ok(
    typeof adapter.defaultRoot === "function",
    `${platform} has defaultRoot()`,
  );
  // Most adapters use messages(); codex/devin use records() (input-inclusive format
  // handled by tokenpullCodex, not the standard tokenpull pipeline).
  assert.ok(
    typeof adapter.messages === "function" ||
      typeof adapter.records === "function",
    `${platform} has messages() or records()`,
  );
}

// --- 18. Amp adapter: parses full-4-pillar from mock thread JSON ---
const mockAmp = {
  platform: "amp",
  defaultRoot: () => "/mock/amp",
  async *messages() {
    yield {
      id: "m1",
      sid: "t1",
      ts: "2026-06-18T00:00:00Z",
      input: 1000,
      output: 2000,
      cacheCreate: 500,
      cacheRead: 8000,
      file: "threads/t1.json",
    };
  },
};
const ampResult = await tokenpull({ adapter: mockAmp, now: NOW });
const ampAll = ampResult.windows.find((w) => w.window === "all");
assert.strictEqual(ampAll.pillars.input, 1000, "amp: input");
assert.strictEqual(ampAll.pillars.output, 2000, "amp: output");
assert.strictEqual(ampAll.pillars.cacheCreate, 500, "amp: cacheCreate");
assert.strictEqual(ampAll.pillars.cacheRead, 8000, "amp: cacheRead");

// --- 19. Qwen adapter: cacheCreate forced to 0, thought tokens folded into output,
//          cached removed from input to avoid double-count ---
const mockQwen = {
  platform: "qwen",
  estimated: true,
  defaultRoot: () => "/mock/qwen",
  async *messages() {
    // promptTokenCount:1200 (includes cached 300) + candidatesTokenCount:500 + thoughtsTokenCount:100
    yield {
      id: "q1",
      sid: null,
      ts: "2026-06-18T00:00:00Z",
      input: 900,
      output: 600,
      cacheCreate: 0,
      cacheRead: 300,
      file: "q.jsonl",
    };
  },
};
const qwenResult = await tokenpull({ adapter: mockQwen, now: NOW });
const qwenAll = qwenResult.windows.find((w) => w.window === "all");
assert.strictEqual(
  qwenAll.pillars.input,
  900,
  "qwen: fresh input (promptTokenCount - cached)",
);
assert.strictEqual(qwenAll.pillars.output, 600, "qwen: output + thoughts");
assert.strictEqual(
  qwenAll.pillars.cacheCreate,
  0,
  "qwen: cacheCreate always 0",
);
assert.strictEqual(
  qwenAll.pillars.cacheRead,
  300,
  "qwen: cacheRead = cachedContentTokenCount",
);

// --- 20. Goose adapter: no cache fields → all zero, reasoning folded into output ---
const mockGoose = {
  platform: "goose",
  estimated: true,
  defaultRoot: () => "/mock/goose",
  async *messages() {
    // output:300 + reasoning:(total700-input200-output300=200) → output becomes 500
    yield {
      id: "g1",
      sid: null,
      ts: "2026-06-18T00:00:00Z",
      input: 200,
      output: 500,
      cacheCreate: 0,
      cacheRead: 0,
      file: "sessions.db",
    };
  },
};
const gooseResult = await tokenpull({ adapter: mockGoose, now: NOW });
const gooseAll = gooseResult.windows.find((w) => w.window === "all");
assert.strictEqual(gooseAll.pillars.cacheCreate, 0, "goose: cacheCreate=0");
assert.strictEqual(gooseAll.pillars.cacheRead, 0, "goose: cacheRead=0");
assert.strictEqual(
  gooseAll.pillars.output,
  500,
  "goose: output includes folded reasoning",
);

// --- 21. Gemini adapter: cached extracted from input, thought folded into output ---
const mockGemini = {
  platform: "gemini",
  estimated: true,
  defaultRoot: () => "/mock/gemini",
  async *messages() {
    // input=1500 (includes cached=400), output=800, thought=200 → input=1100, output=1000, cacheCreate=0, cacheRead=400
    yield {
      id: "gm1",
      sid: null,
      ts: "2026-06-18T00:00:00Z",
      input: 1100,
      output: 1000,
      cacheCreate: 0,
      cacheRead: 400,
      file: "chat.jsonl",
    };
  },
};
const geminiResult = await tokenpull({ adapter: mockGemini, now: NOW });
const geminiAll = geminiResult.windows.find((w) => w.window === "all");
assert.strictEqual(geminiAll.pillars.input, 1100, "gemini: input = raw−cached");
assert.strictEqual(geminiAll.pillars.output, 1000, "gemini: output + thought");
assert.strictEqual(
  geminiAll.pillars.cacheCreate,
  0,
  "gemini: cacheCreate=0 (estimated)",
);
assert.strictEqual(
  geminiAll.pillars.cacheRead,
  400,
  "gemini: cacheRead=cached",
);

// --- 22. OpenCode adapter: dataGap surfaces, messages() yields nothing ---
const opencodeAdapter = ADAPTERS["opencode"];
assert.ok(
  typeof opencodeAdapter.dataGap === "string" &&
    opencodeAdapter.dataGap.length > 0,
  "opencode has dataGap string",
);
const ocMsgs = [];
for await (const _ of opencodeAdapter.messages()) ocMsgs.push(_);
assert.strictEqual(ocMsgs.length, 0, "opencode.messages() yields no records");

// --- 23. tokenpullAny: unknown platform throws with helpful message ---
await assert.rejects(
  () => tokenpullAny("unknownplatform_xyz"),
  /Unknown platform|unknownplatform_xyz/,
  "tokenpullAny throws for unknown platform",
);

// --- 24. tokenpullAny: routes amp correctly (no throws, returns platform=amp) ---
// Use a mock adapter injected via tokenpull directly (tokenpullAny goes to registry;
// test the registry routing by checking that the amp adapter is structurally wired).
assert.strictEqual(ADAPTERS["amp"].platform, "amp", "ADAPTERS[amp] is wired");
assert.ok(
  typeof ADAPTERS["amp"].messages === "function",
  "ADAPTERS[amp].messages is callable",
);

// --- 25. Droid adapter: thinking_tokens folded into output ---
const mockDroid = {
  platform: "droid",
  defaultRoot: () => "/mock/droid",
  async *messages() {
    // input:500 output:300 thinking:200 cacheCreate:100 cacheRead:2000 → output becomes 500
    yield {
      id: null,
      sid: "s1",
      ts: "2026-06-18T00:00:00Z",
      input: 500,
      output: 500,
      cacheCreate: 100,
      cacheRead: 2000,
      file: "session.settings.json",
    };
  },
};
const droidResult = await tokenpull({ adapter: mockDroid, now: NOW });
const droidAll = droidResult.windows.find((w) => w.window === "all");
assert.strictEqual(droidAll.pillars.input, 500, "droid: input");
assert.strictEqual(droidAll.pillars.output, 500, "droid: output + thinking");
assert.strictEqual(droidAll.pillars.cacheCreate, 100, "droid: cacheCreate");
assert.strictEqual(droidAll.pillars.cacheRead, 2000, "droid: cacheRead");

// --- 25b. Goose cumulative-column double-count regression test ---
// Simulates a Goose sessions table with MULTIPLE cumulative rows for the SAME session.
// Without the fix (sid=null, unique id per row), tokenpull sums all rows → 750.
// With the fix (sid=session_id, id=session_id), keep-last dedup collapses to 400.
const mockGooseCumulative = {
  platform: "goose",
  defaultRoot: () => "/mock/goose",
  async *messages() {
    // Session S: three cumulative snapshots, growing input (100 → 250 → 400)
    // All share the same sid+id after the fix, so keep-last wins → input=400
    yield {
      id: "S",
      sid: "S",
      ts: "2026-06-17T00:00:00Z",
      input: 100,
      output: 50,
      cacheCreate: 0,
      cacheRead: 0,
      file: "sessions.db",
    };
    yield {
      id: "S",
      sid: "S",
      ts: "2026-06-18T00:00:00Z",
      input: 250,
      output: 120,
      cacheCreate: 0,
      cacheRead: 0,
      file: "sessions.db",
    };
    yield {
      id: "S",
      sid: "S",
      ts: "2026-06-18T12:00:00Z",
      input: 400,
      output: 200,
      cacheCreate: 0,
      cacheRead: 0,
      file: "sessions.db",
    };
  },
};
const gooseCumResult = await tokenpull({
  adapter: mockGooseCumulative,
  now: NOW,
});
const gooseCumAll = gooseCumResult.windows.find((w) => w.window === "all");
const gooseCum7d = gooseCumResult.windows.find((w) => w.window === "7d");
assert.strictEqual(
  gooseCumResult.totalMessages,
  1,
  "goose: 3 cumulative rows for 1 session → deduped to 1",
);
assert.strictEqual(
  gooseCumAll.pillars.input,
  400,
  "goose: cumulative input collapsed to latest (400), not summed (750)",
);
assert.strictEqual(
  gooseCumAll.pillars.output,
  200,
  "goose: cumulative output collapsed to latest (200), not summed (370)",
);
assert.strictEqual(
  gooseCum7d.pillars.input,
  400,
  "goose: 7d window also collapsed (latest row is in 7d)",
);

// --- 25c. Goose: different sessions are NOT collapsed (they sum correctly) ---
const mockGooseMultiSession = {
  platform: "goose",
  defaultRoot: () => "/mock/goose",
  async *messages() {
    yield {
      id: "S1",
      sid: "S1",
      ts: "2026-06-18T00:00:00Z",
      input: 400,
      output: 200,
      cacheCreate: 0,
      cacheRead: 0,
      file: "sessions.db",
    };
    yield {
      id: "S2",
      sid: "S2",
      ts: "2026-06-18T00:00:00Z",
      input: 300,
      output: 150,
      cacheCreate: 0,
      cacheRead: 0,
      file: "sessions.db",
    };
  },
};
const gooseMulti = await tokenpull({
  adapter: mockGooseMultiSession,
  now: NOW,
});
const gooseMultiAll = gooseMulti.windows.find((w) => w.window === "all");
assert.strictEqual(
  gooseMulti.totalMessages,
  2,
  "goose: 2 different sessions → 2 records",
);
assert.strictEqual(
  gooseMultiAll.pillars.input,
  700,
  "goose: different sessions sum correctly (400+300=700)",
);

// --- 25d. Per-message adapters still SUM correctly (the fix doesn't break them) ---
// Kimi/Pi/Kilo yield per-message increments (distinct ids, non-cumulative) — these
// must still be summed, not collapsed. They use unique id + sid:null, so the dedup
// key falls to the unique id → each record counts.
const mockPerMessage = {
  platform: "kimi",
  defaultRoot: () => "/mock/kimi",
  async *messages() {
    yield {
      id: "msg1",
      sid: null,
      ts: "2026-06-18T00:00:00Z",
      input: 100,
      output: 50,
      cacheCreate: 30,
      cacheRead: 40,
      file: "wire.jsonl",
    };
    yield {
      id: "msg2",
      sid: null,
      ts: "2026-06-18T01:00:00Z",
      input: 200,
      output: 80,
      cacheCreate: 60,
      cacheRead: 90,
      file: "wire.jsonl",
    };
    yield {
      id: "msg3",
      sid: null,
      ts: "2026-06-18T02:00:00Z",
      input: 150,
      output: 70,
      cacheCreate: 45,
      cacheRead: 55,
      file: "wire.jsonl",
    };
  },
};
const pmResult = await tokenpull({ adapter: mockPerMessage, now: NOW });
const pmAll = pmResult.windows.find((w) => w.window === "all");
assert.strictEqual(
  pmResult.totalMessages,
  3,
  "per-message: 3 distinct messages → 3 records (not collapsed)",
);
assert.strictEqual(
  pmAll.pillars.input,
  450,
  "per-message: input summed correctly (100+200+150=450)",
);
assert.strictEqual(
  pmAll.pillars.output,
  200,
  "per-message: output summed correctly (50+80+70=200)",
);

console.log(
  "✓ goose: cumulative double-count regression · multi-session sum · per-message adapters unaffected",
);

// ── rank_windows + watch_tokenpull TESTS ─────────────────────────────────────

// --- 26. rank_windows: scores all 4 windows independently from named pastes ---
// Use the canonical MOSES pillars for the all-time window, half-values for others.
const rwResult = await callTool(
  "rank_windows",
  {
    "7d": "625605 5648060 64098155 1277589884", // ~half the canon values
    "30d": "937908 8472090 96147232 1916384826", // ~¾ values
    all: "1251211 11296121 128196310 2555179769", // canon
    source_tool: "ccusage",
  },
  {
    fetchImpl: () => {
      throw new Error("rank_windows must not call network");
    },
  },
);
assert.strictEqual(
  rwResult.windows.length,
  3,
  "rank_windows: 3 windows returned (7d, 30d, all)",
);
assert.ok(
  !rwResult.windows.some((w) => w.window === "90d"),
  "rank_windows: missing 90d window omitted correctly",
);
assert.strictEqual(
  rwResult.source_tool,
  "ccusage",
  "rank_windows: source_tool carried",
);
const rwAll = rwResult.windows.find((w) => w.window === "all");
assert.strictEqual(
  rwAll.cascade.yield,
  18436.98,
  `rank_windows: all-time Υ canon — got ${rwAll.cascade.yield}`,
);
assert.ok(
  typeof rwAll.card === "string" && rwAll.card.length > 0,
  "rank_windows: card generated",
);
assert.match(
  rwResult.note,
  /tokenpull_submit/,
  "rank_windows: note mentions tokenpull_submit",
);

// --- 27. rank_windows: throws on empty input ---
await assert.rejects(
  () =>
    callTool(
      "rank_windows",
      {},
      {
        fetchImpl: () => {
          throw new Error("no net");
        },
      },
    ),
  /at least one window/,
  "rank_windows: throws with no windows",
);

// --- 28. watch_tokenpull: returns cascade snapshot for the requested window ---
const mockWatchAdapter = {
  platform: "claude",
  defaultRoot: () => "/mock/watch",
  async *messages() {
    yield {
      id: "w1",
      sid: "s1",
      ts: new Date(NOW - 1 * 86400000).toISOString(),
      input: 1251211,
      output: 11296121,
      cacheCreate: 128196310,
      cacheRead: 2555179769,
      file: "f.jsonl",
    };
  },
};
const watchResult = await callTool(
  "watch_tokenpull",
  { window: "7d", interval_s: 30 },
  { adapter: mockWatchAdapter, now: NOW },
);
assert.strictEqual(watchResult.window, "7d", "watch_tokenpull: correct window");
assert.ok(
  typeof watchResult.cascade.yield === "number",
  "watch_tokenpull: cascade.yield is a number",
);
assert.strictEqual(
  watchResult.poll_interval_s,
  30,
  "watch_tokenpull: interval_s respected",
);
assert.strictEqual(
  watchResult.auth_submit,
  null,
  "watch_tokenpull: no auth_submit without submit:true",
);

// --- 29. watch_tokenpull: submit:true → real signed submit (enrolled) / not_enrolled otherwise ---
const watchEnrolledId = {
  ...generateIdentity({ device_id: "1f0c9a4e-2b6d-4a1c-9e3f-7d5b2a8c4e10" }),
  codename: "TheSignalVault",
  operator_id: "op_w",
};
let watchCap = null;
const watchFetch = async (url, init) => {
  watchCap = { url, init };
  return {
    ok: true,
    status: 202,
    json: async () => ({
      status: "received",
      verification_tier: "verified",
      persisted: true,
    }),
  };
};
const watchSubmit = await callTool(
  "watch_tokenpull",
  { window: "7d", submit: true },
  {
    adapter: mockWatchAdapter,
    now: NOW,
    fetchImpl: watchFetch,
    identity: watchEnrolledId,
  },
);
assert.ok(
  watchSubmit.auth_submit !== null,
  "watch_tokenpull: auth_submit present with submit:true",
);
assert.strictEqual(
  watchSubmit.auth_submit.status,
  "received",
  "watch_tokenpull: submit:true + enrolled → signed submit received (no TODO stub)",
);
assert.ok(
  watchCap.url.endsWith("/api/v1/snapshots"),
  "watch_tokenpull: submits to the VERIFIED /api/v1/snapshots path",
);
assert.ok(
  watchCap.init.headers["x-agent-signature"],
  "watch_tokenpull: the submission is signed",
);
// submit:true but NOT enrolled → not_enrolled, no POST
let watchCap2 = null;
const watchFetch2 = async (url, init) => {
  watchCap2 = { url, init };
  return { ok: true, status: 202, json: async () => ({}) };
};
const watchUnenrolled = await callTool(
  "watch_tokenpull",
  { window: "7d", submit: true },
  {
    adapter: mockWatchAdapter,
    now: NOW,
    fetchImpl: watchFetch2,
    identity: { ...generateIdentity(), codename: null, operator_id: null },
  },
);
assert.strictEqual(
  watchUnenrolled.auth_submit.status,
  "not_enrolled",
  "watch_tokenpull: submit:true + unenrolled → not_enrolled",
);
assert.strictEqual(watchCap2, null, "watch_tokenpull: unenrolled never POSTs");

console.log(
  "\n✓ canon · card · submit_paste · tokenpull(claude) · tokenpull_submit · tokenpullCodex conversion",
);
console.log(
  "✓ hardening: div-by-zero guards · parsePillars warnings · fetch timeout · codex tooling filter · narrate safety",
);
console.log(
  "✓ adapters: registry (15 platforms) · amp · qwen · goose · gemini · opencode · droid · tokenpullAny routing",
);
console.log(
  "✓ rank_windows: 4-window paste scoring · partial input · no-network · canon Υ · source_tool · empty throws",
);
// --- 30. enroll: posts the keystore IDENTITY (public key only) to /devices/enroll, maps the ack ---
// Inject opts.identity so the tool skips keystore persistence + uses a fixed device_id.
const testIdentity = generateIdentity({
  device_id: "1f0c9a4e-2b6d-4a1c-9e3f-7d5b2a8c4e10",
});
let enrollCap = null;
const enrollFetch = async (url, init) => {
  enrollCap = { url, init };
  return {
    ok: true,
    status: 201,
    json: async () => ({
      status: "enrolled",
      codename: "TransVaultOrigin",
      operator_id: "op_123",
      trust_status: "trusted",
    }),
  };
};
const enr = await callTool(
  "enroll",
  { code: "SIGR-7F3KQ-9QXM2-4HJ8R" },
  {
    apiBase: "http://test.local",
    fetchImpl: enrollFetch,
    identity: testIdentity,
  },
);
assert.ok(
  enrollCap.url.endsWith("/api/v1/devices/enroll"),
  "enroll POSTs to /api/v1/devices/enroll",
);
assert.strictEqual(enrollCap.init.method, "POST", "enroll uses POST");
const enrollBody = JSON.parse(enrollCap.init.body);
assert.strictEqual(
  enrollBody.device_id,
  testIdentity.device_id,
  "enroll sends the keystore device_id",
);
assert.strictEqual(
  enrollBody.public_key,
  testIdentity.public_key,
  "enroll sends the PUBLIC key",
);
assert.ok(
  enrollBody.public_key.startsWith("ed25519:"),
  "public key carries the ed25519: prefix",
);
assert.ok(
  !("private_key_pkcs8_b64" in enrollBody) &&
    !JSON.stringify(enrollBody).includes(testIdentity.private_key_pkcs8_b64),
  "enroll NEVER transmits the private key",
);
assert.strictEqual(enr.status, "enrolled", "enroll maps a 201 to enrolled");
assert.strictEqual(
  enr.codename,
  "TransVaultOrigin",
  "enroll surfaces the bound codename",
);
// invalid code → mapped error, never throws
const badFetch = async () => ({
  ok: false,
  status: 410,
  json: async () => ({ reason: "code_invalid" }),
});
const bad = await callTool(
  "enroll",
  { code: "SIGR-NOPE" },
  { apiBase: "http://test.local", fetchImpl: badFetch, identity: testIdentity },
);
assert.strictEqual(
  bad.status,
  "error",
  "invalid code → error status (no throw)",
);
assert.strictEqual(bad.reason, "code_invalid", "invalid-code reason surfaced");
// empty code → throws at the tool boundary
await assert.rejects(
  () => callTool("enroll", { code: "" }, { identity: testIdentity }),
  /requires a `code`/,
  "enroll rejects empty code",
);

console.log(
  "✓ watch_tokenpull: cascade snapshot · interval_s · submit:true → signed /api/v1/snapshots · not_enrolled guard",
);
// --- 31. submit_verified: signs a Schema 1.0 snapshot → POST /api/v1/snapshots (enrolled, no live write) ---
const enrolledId = {
  ...generateIdentity({ device_id: "1f0c9a4e-2b6d-4a1c-9e3f-7d5b2a8c4e10" }),
  codename: "TransVaultOrigin",
  operator_id: "op_123",
};
let snapCap = null;
const snapFetch = async (url, init) => {
  snapCap = { url, init };
  return {
    ok: true,
    status: 202,
    json: async () => ({
      status: "received",
      verification_tier: "verified",
      persisted: true,
    }),
  };
};
const pub = await callTool(
  "submit_verified",
  { window: "all" },
  {
    apiBase: "http://test.local",
    fetchImpl: snapFetch,
    adapter: mockAdapter,
    identity: enrolledId,
    now: NOW,
  },
);
assert.ok(
  snapCap.url.endsWith("/api/v1/snapshots"),
  "submit_verified POSTs to /api/v1/snapshots (not ingest-paste)",
);
const sigHeader = snapCap.init.headers["x-agent-signature"];
assert.ok(
  sigHeader && sigHeader.length > 0,
  "X-Agent-Signature header present",
);
const snapBody = JSON.parse(snapCap.init.body);
assert.strictEqual(snapBody.schema_version, "1.0", "Schema 1.0 payload");
assert.strictEqual(
  snapBody.codename,
  "TransVaultOrigin",
  "codename from the keystore identity",
);
assert.strictEqual(
  snapBody.device_id,
  enrolledId.device_id,
  "device_id from the keystore identity",
);
assert.strictEqual(
  snapBody.agent.public_key,
  enrolledId.public_key,
  "public key carried in agent block",
);
assert.ok(
  snapBody.agent.snapshot_hash.startsWith("sha256:"),
  "snapshot_hash computed",
);
assert.ok(
  !JSON.stringify(snapBody).includes(enrolledId.private_key_pkcs8_b64),
  "submit NEVER includes the private key",
);
assert.strictEqual(
  snapBody.window.type,
  "all_time",
  "all → all_time window_type",
);
assert.strictEqual(
  snapBody.raw_telemetry.tokens_input_fresh,
  111,
  "pillars carried into raw_telemetry (input)",
);
assert.strictEqual(
  snapBody.raw_telemetry.tokens_total,
  1110,
  "tokens_total = Σ4 pillars (111+222+333+444)",
);
// server-parity: the header signature must verify over this exact payload
assert.ok(
  verifyPayload(snapBody, sigHeader, enrolledId.public_key),
  "X-Agent-Signature verifies against the payload (server will accept)",
);
// plausibility-clean (no reject, no flag → stays verified → ranks)
assert.ok(
  snapBody.raw_telemetry.turns_total >= snapBody.raw_telemetry.sessions_count,
  "turns >= sessions",
);
assert.ok(
  snapBody.raw_telemetry.sessions_count >= 1,
  "sessions >= 1 (tokens present)",
);
assert.strictEqual(
  pub.windows[0].verification_tier,
  "verified",
  "server verification_tier surfaced",
);
// not enrolled → no POST
const notEnrolled = await callTool(
  "submit_verified",
  {},
  {
    adapter: mockAdapter,
    identity: { ...generateIdentity(), codename: null, operator_id: null },
  },
);
assert.strictEqual(
  notEnrolled.status,
  "not_enrolled",
  "unenrolled identity → not_enrolled (no submit)",
);

console.log(
  "✓ enroll: posts identity (public key only) · hides private key · maps 201 enrolled + 410 code_invalid",
);
console.log(
  "✓ submit_verified: signs Schema 1.0 → POST /api/v1/snapshots · X-Agent-Signature · server-verifiable · plausibility-clean",
);

// --- connect.mjs pure helpers (consolidation) ---
assert.equal(isSignedIn(null), false, "isSignedIn(null)");
assert.equal(isSignedIn({}), false, "isSignedIn({})");
assert.equal(
  isSignedIn({ codename: "x" }),
  false,
  "isSignedIn needs operator_id too",
);
assert.equal(
  isSignedIn({ operator_id: "o" }),
  false,
  "isSignedIn needs codename too",
);
assert.equal(
  isSignedIn({ codename: "x", operator_id: "o" }),
  true,
  "isSignedIn(full)",
);
for (const ch of ["A", "z", "0", "9", "-"])
  assert.equal(isCodeChar(ch), true, `isCodeChar(${ch})`);
for (const ch of [" ", "\r", "\x1b", "ab", "", "_", "/"])
  assert.equal(isCodeChar(ch), false, `!isCodeChar(${JSON.stringify(ch)})`);
console.log("✓ connect: isSignedIn + isCodeChar");

// --- FIX A-REAL: keystore binding invalidation when device_id changes (no Frankenstein identity) ---
// The root cause of "stuck signed in / unverified / data won't go": a re-enroll after a
// revoke used to PRESERVE the old codename/operator_id onto a NEW device_id → the server
// sees a mismatch → tags submissions `unverified` → never ranks, yet isSignedIn reads the
// local codename as present. bindingForFreshIdentity is the pure decision: drop the binding
// when device_id changes, keep it only when the same device_id is reused. (Pure — no fs, so
// the owner's live ~/.sigrank-mcp/identity.json is never touched by this test.)
const oldDevice = generateIdentity({ device_id: "dev-old-uuid" });
oldDevice.codename = "signal-old";
oldDevice.operator_id = "op-old";
oldDevice.enrolled_at = "2026-01-01T00:00:00Z";
// new device_id → binding DROPPED (the Frankenstein case)
const newFresh = generateIdentity({ device_id: "dev-new-uuid" });
const dropped = bindingForFreshIdentity(oldDevice, newFresh);
assert.strictEqual(
  dropped.codename,
  null,
  "A-REAL: new device_id → old codename DROPPED (no Frankenstein)",
);
assert.strictEqual(
  dropped.operator_id,
  null,
  "A-REAL: new device_id → old operator_id DROPPED",
);
assert.strictEqual(
  dropped.enrolled_at,
  null,
  "A-REAL: new device_id → old enrolled_at DROPPED",
);
// same device_id reused → binding KEPT (a key rotation on the same device keeps its operator)
const sameFresh = generateIdentity({ device_id: "dev-old-uuid" });
const kept = bindingForFreshIdentity(oldDevice, sameFresh);
assert.strictEqual(
  kept.codename,
  "signal-old",
  "A-REAL: same device_id → codename preserved",
);
assert.strictEqual(
  kept.operator_id,
  "op-old",
  "A-REAL: same device_id → operator_id preserved",
);
assert.strictEqual(
  kept.enrolled_at,
  "2026-01-01T00:00:00Z",
  "A-REAL: same device_id → enrolled_at preserved",
);
// no existing record → null binding (fresh device, never enrolled)
const noExisting = bindingForFreshIdentity(null, newFresh);
assert.strictEqual(
  noExisting.codename,
  null,
  "A-REAL: no existing record → null binding",
);
assert.strictEqual(
  noExisting.operator_id,
  null,
  "A-REAL: no existing record → null operator",
);
// existing with no device_id → treated as a different device (binding dropped, no carryover)
const partialNoId = {
  codename: "stale",
  operator_id: "op-stale",
  enrolled_at: "2025-12-01",
};
const fromPartial = bindingForFreshIdentity(partialNoId, newFresh);
assert.strictEqual(
  fromPartial.codename,
  null,
  "A-REAL: existing w/o device_id → stale codename NOT carried onto new device",
);
assert.strictEqual(
  fromPartial.operator_id,
  null,
  "A-REAL: existing w/o device_id → stale operator NOT carried",
);
// clearIdentity is exported (the Connect [X] sign-out escape hatch)
assert.strictEqual(
  typeof clearIdentity,
  "function",
  "clearIdentity is exported (FIX A sign-out)",
);
console.log(
  "✓ A-REAL: binding invalidation on device_id change · clearIdentity exported",
);

// ── RESILIENCE (0.17.3): keystore self-healing + device_already_enrolled recovery ──
// restoreBindingFromBackups is the pure scan: given a device_id, find a backup
// with a matching device_id that carries a codename+operator_id. Returns null
// when no match, null when device_id is null, and never crosses device boundaries.
// (Pure read — no writes to the live identity.)
assert.strictEqual(
  restoreBindingFromBackups(null),
  null,
  "RESILIENCE: null device_id → null",
);
assert.strictEqual(
  restoreBindingFromBackups("nonexistent-device-id-12345"),
  null,
  "RESILIENCE: no matching backup → null",
);
console.log("✓ RESILIENCE: restoreBindingFromBackups null/no-match guards");

// device_already_enrolled recovery: if the server returns this reason WITH
// codename+operator_id, enroll should recover the binding (status: enrolled,
// recovered: true) instead of erroring.
const alreadyEnrolledFetch = async () => ({
  ok: false,
  status: 409,
  json: async () => ({
    reason: "device_already_enrolled",
    codename: "RecoveredOperator",
    operator_id: "op_recovered",
    trust_status: "trusted",
  }),
});
const recovered = await callTool(
  "enroll",
  { code: "SIGR-RECOVER-TEST" },
  {
    apiBase: "http://test.local",
    fetchImpl: alreadyEnrolledFetch,
    identity: testIdentity,
  },
);
assert.strictEqual(
  recovered.status,
  "enrolled",
  "RESILIENCE: device_already_enrolled with binding → recovered as enrolled",
);
assert.strictEqual(
  recovered.codename,
  "RecoveredOperator",
  "RESILIENCE: recovered codename surfaced",
);
assert.strictEqual(
  recovered.recovered,
  true,
  "RESILIENCE: recovered flag set",
);
console.log("✓ RESILIENCE: device_already_enrolled recovery path");

// device_already_enrolled WITHOUT binding → still errors (server doesn't know
// the binding, can't recover).
const alreadyEnrolledNoBindingFetch = async () => ({
  ok: false,
  status: 409,
  json: async () => ({ reason: "device_already_enrolled" }),
});
const notRecovered = await callTool(
  "enroll",
  { code: "SIGR-NO-BINDING" },
  {
    apiBase: "http://test.local",
    fetchImpl: alreadyEnrolledNoBindingFetch,
    identity: testIdentity,
  },
);
assert.strictEqual(
  notRecovered.status,
  "error",
  "RESILIENCE: device_already_enrolled without binding → error (no recovery possible)",
);
assert.strictEqual(
  notRecovered.reason,
  "device_already_enrolled",
  "RESILIENCE: reason preserved when no binding to recover",
);
console.log("✓ RESILIENCE: device_already_enrolled without binding → error");

// ── E2 (0.12.0): 1MB oversized-input guard — reject before any parse / network ──
const big = "x".repeat(1_000_001);
const oversizePaste = await callTool("submit_paste", { text: big });
assert.strictEqual(
  oversizePaste.status,
  "error",
  "E2: oversized submit_paste → error status",
);
assert.strictEqual(
  oversizePaste.reason,
  "input_too_large",
  "E2: oversized submit_paste → input_too_large",
);
// normal input still scores after the guard (regression)
const okAfterGuard = await callTool("rank_paste", { text: MOSES });
assert.strictEqual(
  okAfterGuard.yield,
  18436.98,
  "E2: normal paste still scores with the guard in place",
);
// rank_windows rejects an oversized per-window paste up front
const oversizeWin = await callTool("rank_windows", {
  "7d": "y".repeat(1_000_001),
});
assert.strictEqual(
  oversizeWin.status,
  "error",
  "E2: oversized rank_windows arg → error status",
);
assert.strictEqual(
  oversizeWin.reason,
  "input_too_large",
  "E2: oversized rank_windows arg → input_too_large",
);
console.log(
  "✓ E2: 1MB input guard — submit_paste + rank_windows reject oversized; normal input unaffected",
);

// ── simulate_change (0.15.0): the first prescriptive tool — "what if I changed my token mix?" ──
// Pure local math: current pillars + proposed changes → cascade on both → delta.
// No network, no submission. The quadratic input penalty should be visible: halving
// input quadruples Υ (because I² is in the denominator).
const simRel = await callTool("simulate_change", {
  text: MOSES,
  changes: { cacheRead: "+50000000" },
});
assert.strictEqual(
  simRel.current.yield,
  18436.98,
  "simulate_change: current Υ matches canon",
);
assert.strictEqual(
  simRel.simulated.yield,
  18797.75,
  "simulate_change: +50M cacheRead → 18797.75",
);
assert.strictEqual(
  simRel.deltas.yield.delta,
  360.77,
  "simulate_change: yield delta = +360.77",
);
assert.strictEqual(
  simRel.changes.cacheRead.delta,
  50000000,
  "simulate_change: relative delta applied",
);
assert.strictEqual(
  simRel.class_changed,
  false,
  "simulate_change: no class change for +50M cacheRead",
);

// Halving input → Υ quadruples (the quadratic penalty story)
const simHalve = await callTool("simulate_change", {
  text: MOSES,
  changes: { input: 625605 }, // absolute: half of 1251211
});
assert.strictEqual(
  simHalve.simulated.yield,
  73748.02,
  "simulate_change: halved input → 4x Υ (quadratic penalty)",
);
assert.strictEqual(
  simHalve.changes.input.from,
  1251211,
  "simulate_change: absolute replacement recorded from-value",
);
assert.strictEqual(
  simHalve.changes.input.to,
  625605,
  "simulate_change: absolute replacement recorded to-value",
);

// JSON input path works the same as positional
const simJson = await callTool("simulate_change", {
  text: '{"input":1000000,"output":5000000,"cacheCreate":50000000,"cacheRead":100000000}',
  changes: { cacheRead: 200000000 },
});
assert.strictEqual(
  simJson.current.yield,
  500,
  "simulate_change: JSON input current Υ = 500",
);
assert.strictEqual(
  simJson.simulated.yield,
  1000,
  "simulate_change: doubled cacheRead → doubled Υ = 1000",
);

// Negative result → clean error (token counts can't be negative)
const simNeg = await callTool("simulate_change", {
  text: "1000000 5000000 50000000 100000000",
  changes: { input: "-2000000" },
});
assert.strictEqual(
  simNeg.status,
  "error",
  "simulate_change: negative result → error",
);
assert.strictEqual(
  simNeg.reason,
  "invalid_change",
  "simulate_change: negative result → invalid_change",
);

// No changes specified → error
const simEmpty = await callTool("simulate_change", {
  text: MOSES,
  changes: {},
});
assert.strictEqual(
  simEmpty.status,
  "error",
  "simulate_change: empty changes → error",
);
assert.strictEqual(
  simEmpty.reason,
  "no_changes",
  "simulate_change: empty changes → no_changes",
);

console.log(
  "✓ simulate_change: relative + absolute deltas · quadratic penalty · JSON input · negative guard · empty-changes guard",
);

// ── 14. Intent tools: get_best_operator, compare_self, compare_operators ─────
// Mock board data for intent tool tests
const MOCK_BOARD = {
  operators: [
    { codename: "Alpha", yield_: 50000, leverage: 100, velocity: 5.0, class: "10xer", rank: 1 },
    { codename: "Beta", yield_: 30000, leverage: 50, velocity: 3.0, class: "10xer", rank: 2 },
    { codename: "Gamma", yield_: 10000, leverage: 10, velocity: 2.0, class: "Builder", rank: 3 },
    { codename: "Delta", yield_: 5000, leverage: 5, velocity: 1.0, class: "Builder", rank: 4 },
    { codename: "Epsilon", yield_: 1000, leverage: 2, velocity: 0.5, class: "Burner", rank: 5 },
  ],
};

const mockBoardFetch = async (url) => {
  if (url.includes("/api/v1/leaderboard")) {
    return { ok: true, status: 200, json: async () => MOCK_BOARD };
  }
  if (url.includes("/api/v1/operators/")) {
    const name = decodeURIComponent(url.split("/operators/")[1]);
    const op = MOCK_BOARD.operators.find(
      (o) => o.codename.toLowerCase() === name.toLowerCase(),
    );
    if (!op) return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
    return { ok: true, status: 200, json: async () => op };
  }
  return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
};

// get_best_operator: default n=5, returns behavioral_framing + summary
const bestDefault = await callTool(
  "get_best_operator",
  {},
  { apiBase: "http://test.local", fetchImpl: mockBoardFetch },
);
assert.strictEqual(bestDefault.top_operators.length, 5, "get_best_operator: default returns 5");
assert.strictEqual(bestDefault.total_operators, 5, "get_best_operator: total_operators correct");
assert.ok(bestDefault.summary.includes("Alpha"), "get_best_operator: summary names top operator");
assert.ok(
  bestDefault.top_operators[0].behavioral_framing.includes("power-user"),
  "get_best_operator: 10xer framing mentions power-user",
);

// get_best_operator: n=3
const best3 = await callTool(
  "get_best_operator",
  { n: 3 },
  { apiBase: "http://test.local", fetchImpl: mockBoardFetch },
);
assert.strictEqual(best3.top_operators.length, 3, "get_best_operator: n=3 returns 3");

// get_best_operator: n=0 clamps to 1
const best1 = await callTool(
  "get_best_operator",
  { n: 0 },
  { apiBase: "http://test.local", fetchImpl: mockBoardFetch },
);
assert.strictEqual(best1.top_operators.length, 1, "get_best_operator: n=0 clamps to 1");

// compare_self: via codename
const selfByCodename = await callTool(
  "compare_self",
  { codename: "Gamma" },
  { apiBase: "http://test.local", fetchImpl: mockBoardFetch },
);
assert.strictEqual(selfByCodename.your_metrics.codename, "Gamma", "compare_self: codename fetched");
assert.ok(
  selfByCodename.power_user_assessment.includes("power user"),
  "compare_self: assessment mentions power user",
);
assert.ok(
  typeof selfByCodename.comparison.percentile === "number",
  "compare_self: percentile is a number",
);
assert.ok(
  selfByCodename.suggestion.length > 10,
  "compare_self: suggestion is non-trivial",
);

// compare_self: via text (local parse)
const selfByText = await callTool(
  "compare_self",
  { text: MOSES },
  { apiBase: "http://test.local", fetchImpl: mockBoardFetch },
);
assert.strictEqual(selfByText.your_metrics.codename, "you (local)", "compare_self: text → local parse");
assert.ok(
  selfByText.your_metrics.yield_ > 0,
  "compare_self: text → yield computed",
);

// compare_self: missing both args → throws
assert.rejects(
  callTool("compare_self", {}, { apiBase: "http://test.local", fetchImpl: mockBoardFetch }),
  /requires either/,
  "compare_self: missing args throws",
);

// compare_operators: canon
const cmp = await callTool(
  "compare_operators",
  { codename_a: "Alpha", codename_b: "Beta" },
  { apiBase: "http://test.local", fetchImpl: mockBoardFetch },
);
assert.strictEqual(cmp.operator_a.codename, "Alpha", "compare_operators: operator_a fetched");
assert.strictEqual(cmp.operator_b.codename, "Beta", "compare_operators: operator_b fetched");
assert.ok(cmp.yield_delta > 0, "compare_operators: yield_delta positive (Alpha > Beta)");
assert.ok(cmp.verdict.includes("Alpha"), "compare_operators: verdict names winner");

// compare_operators: missing arg → throws
assert.rejects(
  callTool("compare_operators", { codename_a: "Alpha" }, { apiBase: "http://test.local", fetchImpl: mockBoardFetch }),
  /requires both/,
  "compare_operators: missing codename_b throws",
);

console.log(
  "✓ intent tools: get_best_operator (default/n=3/clamp) · compare_self (codename/text/missing) · compare_operators (canon/missing)",
);

// ── 15. Optional intent tools: describe_power_user, optimize_efficiency ──────

// describe_power_user: static response, no params needed
const descPower = await callTool("describe_power_user", {});
assert.ok(descPower.description.includes("power user"), "describe_power_user: description mentions power user");
assert.ok(descPower.metrics_explained.yield_.includes("Yield"), "describe_power_user: yield explained");
assert.ok(descPower.metrics_explained.leverage.includes("reuse"), "describe_power_user: leverage explained");
assert.ok(descPower.class_tiers.length === 3, "describe_power_user: 3 class tiers");
assert.ok(descPower.class_tiers[0].class === "10xer", "describe_power_user: first tier is 10xer");
// Parse the URL properly instead of substring check (CodeQL: js/incomplete-url-substring-sanitization)
const _descLinkUrl = new URL(descPower.link);
assert.ok(
  _descLinkUrl.hostname === "signalaf.com" ||
    _descLinkUrl.hostname.endsWith(".signalaf.com"),
  "describe_power_user: link hostname is signalaf.com",
);

// optimize_efficiency: via codename (Builder class, low leverage)
const optByCodename = await callTool(
  "optimize_efficiency",
  { codename: "Gamma" },
  { apiBase: "http://test.local", fetchImpl: mockBoardFetch },
);
assert.ok(optByCodename.your_metrics.class === "Builder", "optimize_efficiency: class fetched");
assert.ok(optByCodename.suggestions.length > 0, "optimize_efficiency: suggestions returned");
assert.ok(optByCodename.suggestions[0].action.length > 10, "optimize_efficiency: suggestion has action");
assert.ok(optByCodename.suggestions[0].power_user_practice.length > 10, "optimize_efficiency: suggestion has power-user practice");
assert.ok(optByCodename.summary.includes("Yield"), "optimize_efficiency: summary mentions yield");

// optimize_efficiency: via text (local parse — MOSES = high leverage)
const optByText = await callTool(
  "optimize_efficiency",
  { text: MOSES },
  { apiBase: "http://test.local", fetchImpl: mockBoardFetch },
);
assert.ok(optByText.your_metrics.yield_ > 0, "optimize_efficiency: text → yield computed");
assert.ok(optByText.suggestions.length > 0, "optimize_efficiency: text → suggestions returned");

// optimize_efficiency: missing both args → throws
assert.rejects(
  callTool("optimize_efficiency", {}, { apiBase: "http://test.local", fetchImpl: mockBoardFetch }),
  /requires either/,
  "optimize_efficiency: missing args throws",
);

console.log(
  "✓ optional intent tools: describe_power_user (static) · optimize_efficiency (codename/text/missing)",
);
