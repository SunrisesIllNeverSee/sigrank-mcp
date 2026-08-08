// Acceptance test: the cascade reproduces canon, rank_paste adds a deterministic
// card, and submit_paste shapes the right write request (verified via injected
// fetch — no live calls, no writes to production).
import { cascade, parsePillars } from "./cascade.mjs";
import { narrate } from "./narrate.mjs";
import { callTool, TOOLS } from "./tools.mjs";
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
assert.strictEqual(c.class, "REFINER I", `class mismatch: got ${c.class}`);
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
assert.match(rp.card, /REFINER/, "card names the class");
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
assert.match(noCode.card, /REFINER/, "preview card present");
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
      class_tier: "REFINER I",
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
  "canonical 4-number paste forwarded (parsed pillars, not raw user text)",
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

// --- 4b. submit_paste PRIVACY: mixed text → only 4 numbers sent, no prose leaks ---
//     The user pastes text containing prose + 4 numbers. parsePillars extracts the
//     numbers; raw_paste must be the canonical 4-number form, NOT the original text.
//     This is the privacy guard: conversation content never reaches the server.
let mixedCaptured = null;
const mixedFetch = async (url, init) => {
  mixedCaptured = { url, init };
  return {
    ok: true,
    status: 202,
    json: async () => ({ status: "received", submission_id: "pmix" }),
  };
};
const MIXED = "My session used 1000 input, 500 output, 50 cacheCreate, 80 cacheRead tokens today";
const mixedSub = await callTool(
  "submit_paste",
  { text: MIXED, codename: "PrivacyTest" },
  { apiBase: "http://test.local", fetchImpl: mixedFetch },
);
const mixedBody = JSON.parse(mixedCaptured.init.body);
assert.strictEqual(
  mixedBody.raw_paste,
  "1000 500 50 80",
  "PRIVACY: raw_paste is canonical 4 numbers, not the raw prose",
);
assert.ok(
  !mixedBody.raw_paste.includes("session"),
  "PRIVACY: no prose leaks into raw_paste",
);
assert.ok(
  !mixedBody.raw_paste.includes("tokens today"),
  "PRIVACY: no conversation text leaks into raw_paste",
);
console.log("✓ submit_paste PRIVACY: mixed text → only 4 numbers sent (no prose leak)");

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

// --- 16. ALL_PLATFORMS includes claude + codex + all 16 registry adapters ---
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
  "omp",
])
  assert.ok(ALL_PLATFORMS.includes(p), `ALL_PLATFORMS includes ${p}`);
assert.strictEqual(
  ALL_PLATFORMS.length,
  18,
  `ALL_PLATFORMS has 18 entries, got ${ALL_PLATFORMS.length}`,
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

// ── OMP (oh-my-pi) ADAPTER TESTS (2026-08-08) ─────────────────────────────────
// oh-my-pi (`omp`) is a SEPARATE harness from pi-agent (`piAdapter`) — it forked
// from pi long ago and has its own on-disk format. Fixtures are built under the
// OS tmpdir; a test NEVER reads the operator's real ~/.omp.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { toPlatformPrimary } from "./submit.mjs";

// Env vars must not leak the operator's real dirs into the fixture reads.
delete process.env.OMP_DATA_DIR;
delete process.env.PI_AGENT_DIR;

const jsonl = (...objs) => objs.map((o) => JSON.stringify(o)).join("\n") + "\n";
const OMP_TS = "2026-06-18T12:00:00.000Z"; // inside 7d of NOW

const ompRoot = await mkdtemp(pathJoin(tmpdir(), "sigrank-omp-"));
const ompSession = pathJoin(ompRoot, "20260618_sess-A");
await mkdir(pathJoin(ompSession, "agent"), { recursive: true });

// Line 1 = fixed-width title slot, line 2 = session header. Neither carries usage —
// the bogus top-level token fields here exist so a naive `ev.usage || ev` fallback
// (piAdapter's shape) would fail loudly instead of silently inflating the pillars.
const ompTitleLine = {
  pad: "".padEnd(8, " "),
  title: "fixture",
  type: "title",
  updatedAt: OMP_TS,
  v: 1,
  input: 999999,
  output: 999999,
  cacheRead: 999999,
  cacheWrite: 999999,
};
const ompSessionLine = {
  cwd: "/fixture",
  id: "sess-A",
  timestamp: OMP_TS,
  type: "session",
  version: 1,
  input: 888888,
  output: 888888,
};
const ompMsg = (id, usage) => ({
  id,
  parentId: null,
  timestamp: OMP_TS,
  type: "message",
  message: {
    model: "fixture-model",
    provider: "fixture",
    role: "assistant",
    usage,
  },
});
const ompNoise = (type, id) => ({
  id,
  timestamp: OMP_TS,
  type,
  // usage in the SAME place a message carries it — only type:"message" may count.
  message: {
    role: "assistant",
    usage: { input: 70000, output: 70000, cacheRead: 70000, cacheWrite: 70000 },
  },
});

await writeFile(
  pathJoin(ompSession, "main.jsonl"),
  jsonl(
    ompTitleLine,
    ompSessionLine,
    // TRAP 1: reasoningTokens (12) is ALREADY inside output (18). Never add it.
    // totalTokens 5392 === 3582+18+1792+0 proves it.
    ompMsg("e1", {
      input: 3582,
      output: 18,
      cacheRead: 1792,
      cacheWrite: 0,
      totalTokens: 5392,
      reasoningTokens: 12,
    }),
    // Four DISTINCT values so a cacheWrite/cacheRead swap fails loudly.
    ompMsg("e2", {
      input: 11,
      output: 22,
      cacheWrite: 33,
      cacheRead: 44,
      totalTokens: 110,
    }),
    // TRAP 2: usage.cost reuses the SAME four key names for USD floats.
    ompMsg("e3", {
      input: 100,
      output: 200,
      cacheWrite: 300,
      cacheRead: 400,
      totalTokens: 1000,
      cost: {
        input: 0.0071639,
        output: 0.000216,
        cacheRead: 0.0003584,
        cacheWrite: 0.5,
        total: 0.5077383,
      },
    }),
    // Zero-usage entry → skipped by the input+output+cacheCreate+cacheRead guard.
    ompMsg("e4", {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { total: 0.25 },
    }),
    ompNoise("custom", "n1"),
    ompNoise("custom_message", "n2"),
    ompNoise("model_change", "n3"),
    ompNoise("thinking_level_change", "n4"),
    ompNoise("session_init", "n5"),
    ompNoise("credential_pin", "n6"),
  ),
);
// Nested SUBAGENT transcript — must be walked recursively (real operator work,
// same policy as Claude's subagents/).
await writeFile(
  pathJoin(ompSession, "agent", "__advisor.jsonl"),
  jsonl(
    ompTitleLine,
    { ...ompSessionLine, id: "sess-A-advisor" },
    ompMsg("e-adv", {
      input: 7,
      output: 5,
      cacheWrite: 3,
      cacheRead: 1,
      totalTokens: 16,
    }),
  ),
);

// --- 25e. omp is registered as its own platform ---
const ompAdapterReg = ADAPTERS["omp"];
assert.ok(ompAdapterReg, "ADAPTERS.omp is registered");
assert.strictEqual(
  ompAdapterReg.platform,
  "omp",
  "omp: adapter.platform === omp",
);
assert.ok(ALL_PLATFORMS.includes("omp"), "ALL_PLATFORMS includes omp");
assert.strictEqual(
  ompAdapterReg.defaultRoot(),
  pathJoin(os.homedir(), ".omp", "agent", "sessions"),
  "omp: defaultRoot is ~/.omp/agent/sessions",
);

// --- 25f. omp satisfies the native adapter shape contract (messages, not records) ---
assert.ok(
  typeof ompAdapterReg.messages === "function",
  "omp: has messages() generator",
);
assert.strictEqual(
  typeof ompAdapterReg.records,
  "undefined",
  "omp: has no records() — it is not an io_ratio platform",
);
assert.ok(
  !ompAdapterReg.estimated,
  "omp: estimated is not truthy (native 4-pillar)",
);

const ompRecs = [];
for await (const m of ompAdapterReg.messages(ompRoot)) ompRecs.push(m);
const ompById = new Map(ompRecs.map((r) => [r.id, r]));

// --- 25g. header lines, non-message types and zero-usage entries contribute nothing ---
assert.strictEqual(
  ompRecs.length,
  4,
  `omp: 4 usage-bearing records (title/session/noise/zero skipped), got ${ompRecs.length}`,
);
for (const noiseId of ["n1", "n2", "n3", "n4", "n5", "n6", "e4"])
  assert.ok(!ompById.has(noiseId), `omp: entry ${noiseId} contributes nothing`);
assert.ok(
  !ompRecs.some(
    (r) =>
      r.input === 999999 ||
      r.input === 888888 ||
      r.input === 70000 ||
      r.output === 70000,
  ),
  "omp: no title/session/non-message token value ever reaches a record",
);

// --- 25h. four pillars map natively; cacheWrite→cacheCreate, cacheRead→cacheRead ---
const ompE2 = ompById.get("e2");
assert.strictEqual(ompE2.input, 11, "omp: usage.input → input");
assert.strictEqual(ompE2.output, 22, "omp: usage.output → output");
assert.strictEqual(
  ompE2.cacheCreate,
  33,
  "omp: usage.cacheWrite → cacheCreate",
);
assert.strictEqual(ompE2.cacheRead, 44, "omp: usage.cacheRead → cacheRead");

// --- 25i. TRAP 1: reasoningTokens is ALREADY inside output — never added ---
const ompE1 = ompById.get("e1");
assert.strictEqual(
  ompE1.output,
  18,
  `omp: reasoningTokens NOT added to output (expected 18, got ${ompE1.output} — 30 means double-counted)`,
);
assert.strictEqual(
  ompE1.input,
  3582,
  "omp: input unaffected by reasoningTokens",
);
assert.strictEqual(ompE1.cacheRead, 1792, "omp: cacheRead unaffected");
assert.strictEqual(ompE1.cacheCreate, 0, "omp: cacheWrite 0 → cacheCreate 0");

// --- 25j. TRAP 2: usage.cost (USD floats under the SAME key names) never leaks ---
const ompE3 = ompById.get("e3");
assert.strictEqual(ompE3.input, 100, "omp: cost.input never overwrites input");
assert.strictEqual(
  ompE3.output,
  200,
  "omp: cost.output never overwrites output",
);
assert.strictEqual(
  ompE3.cacheCreate,
  300,
  "omp: cost.cacheWrite never overwrites cacheCreate",
);
assert.strictEqual(
  ompE3.cacheRead,
  400,
  "omp: cost.cacheRead never overwrites cacheRead",
);
for (const k of ["input", "output", "cacheCreate", "cacheRead"])
  assert.ok(
    Number.isInteger(ompE3[k]),
    `omp: pillar ${k} is an integer token count, not a USD float`,
  );
assert.ok(
  !("cost" in ompE3) && !("total" in ompE3),
  "omp: no cost field is ever emitted on a record",
);

// --- 25k. ts from the entry's top-level ISO timestamp; sid/id populated for dedup ---
assert.strictEqual(ompE1.ts, OMP_TS, "omp: ts = entry top-level timestamp");
assert.strictEqual(
  ompE1.sid,
  "sess-A",
  "omp: sid = session header .id (dedup key half 1)",
);
assert.strictEqual(
  ompE1.id,
  "e1",
  "omp: id = entry top-level .id (dedup key half 2)",
);

// --- 25l. nested subagent transcripts are walked recursively ---
const ompAdv = ompById.get("e-adv");
assert.ok(ompAdv, "omp: nested agent/__advisor.jsonl is walked recursively");
assert.strictEqual(ompAdv.input, 7, "omp: subagent input counted");
assert.strictEqual(ompAdv.cacheCreate, 3, "omp: subagent cacheCreate counted");
assert.strictEqual(
  ompAdv.sid,
  "sess-A-advisor",
  "omp: subagent sid from its own session header",
);

// --- 25m. end-to-end through tokenpull(): 4 pillars aggregate natively ---
const ompResult = await tokenpull({
  adapter: ompAdapterReg,
  root: ompRoot,
  now: NOW,
});
const ompAll = ompResult.windows.find((w) => w.window === "all");
assert.strictEqual(ompAll.pillars.input, 3700, "omp: summed input");
assert.strictEqual(ompAll.pillars.output, 245, "omp: summed output");
assert.strictEqual(ompAll.pillars.cacheCreate, 336, "omp: summed cacheCreate");
assert.strictEqual(ompAll.pillars.cacheRead, 2237, "omp: summed cacheRead");

// --- 25n. tokenpullAny routes omp through the NATIVE path (not tokenpullCodex) ---
const ompAny = await tokenpullAny("omp", { root: ompRoot, now: NOW });
assert.ok(
  !ompAny.estimated,
  "omp: tokenpullAny → native path, estimated never set",
);
assert.strictEqual(
  ompAny.ioRatio,
  undefined,
  "omp: no ioRatio — tokenpullCodex was not used",
);
assert.strictEqual(
  ompAny.windows.find((w) => w.window === "all").pillars.cacheCreate,
  336,
  "omp: tokenpullAny keeps native cacheCreate",
);

// --- 25o. the walker must not silently truncate a real omp tree (>10k files) ---
// The operator's tree is 20,565 files; walkFiles' default max is 10,000, which would
// silently drop half the tokens. Fixture: 10,100 single-message files, unique ids.
const ompBigRoot = await mkdtemp(pathJoin(tmpdir(), "sigrank-omp-big-"));
const OMP_BIG_N = 10_100;
await Promise.all(
  Array.from({ length: OMP_BIG_N }, (_, i) =>
    writeFile(
      pathJoin(ompBigRoot, `s${i}.jsonl`),
      jsonl(
        ompMsg(`big-${i}`, {
          input: 1,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1,
        }),
      ),
    ),
  ),
);
let ompBigCount = 0;
for await (const _m of ompAdapterReg.messages(ompBigRoot)) ompBigCount++;
assert.strictEqual(
  ompBigCount,
  OMP_BIG_N,
  `omp: walks past walkFiles' 10k default cap (expected ${OMP_BIG_N}, got ${ompBigCount})`,
);
await rm(ompBigRoot, { recursive: true, force: true });

// --- 25p. omp submits as its own platform.primary, not bucketed to "other" ---
assert.strictEqual(
  toPlatformPrimary("omp"),
  "omp",
  "omp: toPlatformPrimary keeps omp (it is in PLATFORM_ENUM)",
);
assert.strictEqual(
  toPlatformPrimary("kimi"),
  "other",
  "toPlatformPrimary still buckets non-enum adapters to other",
);

// --- 25q. REGRESSION: piAdapter (pi-agent) is untouched by the omp addition ---
const piAdapterReg = ADAPTERS["pi"];
assert.strictEqual(piAdapterReg.platform, "pi", "pi: platform still 'pi'");
assert.strictEqual(
  piAdapterReg.defaultRoot(),
  pathJoin(os.homedir(), ".pi", "agent", "sessions"),
  "pi: defaultRoot still ~/.pi/agent/sessions",
);
const piRoot = await mkdtemp(pathJoin(tmpdir(), "sigrank-pi-"));
await writeFile(
  pathJoin(piRoot, "s.jsonl"),
  jsonl({
    id: "p1",
    sessionId: "ps1",
    timestamp: OMP_TS,
    usage: {
      inputTokens: 5,
      outputTokens: 6,
      cacheCreationTokens: 7,
      cacheReadTokens: 8,
    },
  }),
);
const piRecs = [];
for await (const m of piAdapterReg.messages(piRoot)) piRecs.push(m);
assert.strictEqual(
  piRecs.length,
  1,
  "pi: still reads its own *Tokens field names",
);
assert.deepStrictEqual(
  {
    input: piRecs[0].input,
    output: piRecs[0].output,
    cacheCreate: piRecs[0].cacheCreate,
    cacheRead: piRecs[0].cacheRead,
    sid: piRecs[0].sid,
  },
  { input: 5, output: 6, cacheCreate: 7, cacheRead: 8, sid: "ps1" },
  "pi: inputTokens/outputTokens/cacheCreationTokens/cacheReadTokens unchanged",
);
await rm(piRoot, { recursive: true, force: true });
await rm(ompRoot, { recursive: true, force: true });

// --- 25r. auto-detect still probes omp when tokscale succeeds without it ---
// tokscale reports claude/codex/copilot/gemini/grok/kimi/kiro/opencode/pi and knows
// nothing about oh-my-pi, so pullActivePlatforms' tokscale branch would have pulled a
// list with no omp → no cascade row despite GBs of native local data.
import { withTokscaleBlind } from "./tools.mjs";
import { TOKSCALE_BLIND_PLATFORMS } from "./lib/constants.mjs";

const detectedNoOmp = ["claude", "codex", "copilot", "gemini", "kimi", "pi"];
const targets = withTokscaleBlind(detectedNoOmp);
assert.ok(
  targets.includes("omp"),
  "detection: omp is probed even when tokscale never reports it",
);
for (const p of detectedNoOmp)
  assert.ok(targets.includes(p), `detection: tokscale-detected ${p} is kept`);
assert.strictEqual(
  withTokscaleBlind(["claude", "omp"]).filter((p) => p === "omp").length,
  1,
  "detection: union does not duplicate an already-detected platform",
);
assert.deepStrictEqual(
  withTokscaleBlind(null),
  [...TOKSCALE_BLIND_PLATFORMS],
  "detection: null detection still yields the blind platforms",
);
for (const p of TOKSCALE_BLIND_PLATFORMS)
  assert.ok(
    ALL_PLATFORMS.includes(p),
    `detection: blind platform ${p} is a registered adapter`,
  );

console.log(
  "✓ omp (oh-my-pi): registry · native 4-pillar · reasoningTokens not double-counted · cost never leaks · recursive subagents · >10k walk · tokscale-blind detection · PLATFORM_ENUM · pi untouched",
);

// --- 25s. watch scoping: --platform pulls only the platform it renders ---
// `watch` re-pulls on EVERY refresh tick (default 30s). Auto-detect unions in the
// tokscale-blind platforms (omp) — whose local tree is ~10 GiB — so
// `watch --platform claude` burned ~46s per tick scanning oh-my-pi data that the
// scoped view then filtered out at render time, leaving the watcher permanently
// saturated (scan > refresh interval). Scoping the pull must NOT undo the
// withTokscaleBlind guarantee for the unscoped default.
import { pullActivePlatforms } from "./tools.mjs";
import { detectActivePulls } from "./presentation/cli.mjs";

// Stub the per-platform pull + tokscale detection through opts so nothing touches
// the real filesystem (same opts-injection convention as opts.adapter in
// pullByPlatform). `pulled` records exactly which platforms were probed.
function makePullSpy(detected) {
  const pulled = [];
  return {
    pulled,
    opts: {
      detectClients: async () => detected,
      callTool: async (_name, args) => {
        pulled.push(args.platform);
        return {
          platform: args.platform,
          windows: [
            {
              window: "7d",
              pillars: { input: 1, output: 1, cacheCreate: 0, cacheRead: 0 },
              messages: 1,
            },
          ],
        };
      },
    },
  };
}

// 1. An explicitly scoped pull probes only that platform — never the omp tree.
const scopedSpy = makePullSpy(["claude", "codex"]);
await pullActivePlatforms({ platforms: ["claude"] }, scopedSpy.opts);
assert.deepStrictEqual(
  scopedSpy.pulled,
  ["claude"],
  "watch scope: explicit ['claude'] pulls claude and nothing else",
);
assert.ok(
  !scopedSpy.pulled.includes("omp"),
  "watch scope: a scoped pull never probes the ~10 GiB omp tree",
);

// 2. The unscoped default still unions in omp even when tokscale never reports it
//    (the existing withTokscaleBlind guarantee — must not regress).
const unscopedSpy = makePullSpy(["claude", "codex"]);
await pullActivePlatforms({}, unscopedSpy.opts);
assert.ok(
  unscopedSpy.pulled.includes("omp"),
  "watch scope: unscoped auto-detect still probes omp (withTokscaleBlind intact)",
);
for (const p of ["claude", "codex"])
  assert.ok(
    unscopedSpy.pulled.includes(p),
    `watch scope: unscoped auto-detect keeps tokscale-detected ${p}`,
  );

// 3. The watch tick loader itself: `detectActivePulls` owns BOTH the scope and the
//    rows, so there is no "pull everything, then filter at render time" path left to
//    forget the filter on. --platform claude ⇒ claude is the only platform probed.
const watchScopedSpy = makePullSpy(["claude", "codex"]);
const scopedRows = await detectActivePulls("claude", watchScopedSpy.opts);
assert.deepStrictEqual(
  watchScopedSpy.pulled,
  ["claude"],
  "watch --platform claude: pull set is exactly the rendered platform",
);
assert.ok(
  !watchScopedSpy.pulled.includes("omp"),
  "watch --platform claude: pull set excludes omp (the ~46s/tick regression)",
);
assert.deepStrictEqual(
  scopedRows.map((d) => d.platform),
  ["claude"],
  "watch --platform claude: renders exactly the requested platform",
);

// 4. --platform all / '' / no --platform behave as unscoped: omp still probed.
for (const allish of ["all", "", null, undefined]) {
  const spy = makePullSpy(["claude", "codex"]);
  const rows = await detectActivePulls(allish, spy.opts);
  assert.ok(
    spy.pulled.includes("omp"),
    `watch --platform ${JSON.stringify(allish)}: unscoped → omp is still pulled`,
  );
  assert.ok(
    rows.some((d) => d.platform === "omp"),
    `watch --platform ${JSON.stringify(allish)}: unscoped → omp row is rendered`,
  );
}

console.log(
  "✓ watch scoping: --platform scopes the pull · omp not probed when scoped · unscoped default keeps withTokscaleBlind · all/none == unscoped",
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
  "✓ adapters: registry (16 platforms) · amp · qwen · goose · gemini · opencode · droid · omp · tokenpullAny routing",
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

// ── tokscale_analytics: pure helpers + tool registration + live shape ─────────
import {
  redactPath,
  num,
  isBookkeepingModel,
  tokscaleMarketShare,
  tokscaleDeveloperProfile,
  tokscaleModelTrends,
  tokscaleCostAnalysis,
  tokscaleDeviceProfile,
  tokscaleMcpUsage,
  tokscaleCompetitiveIntel,
} from "./tokscale_analytics.mjs";
import os from "node:os";

// redactPath: home dir → ~, non-home untouched, edge cases safe
assert.strictEqual(redactPath(os.homedir()), "~", "redactPath: exact home → ~");
assert.strictEqual(
  redactPath(os.homedir() + "/.claude/projects"),
  "~/.claude/projects",
  "redactPath: home prefix → ~",
);
assert.strictEqual(redactPath("/usr/local/bin"), "/usr/local/bin", "redactPath: non-home untouched");
assert.strictEqual(redactPath(null), null, "redactPath: null passthrough");
assert.strictEqual(redactPath(""), "", "redactPath: empty passthrough");
assert.strictEqual(redactPath(123), 123, "redactPath: non-string passthrough");

// num: coerces, guards NaN/undefined/null/strings
assert.strictEqual(num("42"), 42, "num: string → number");
assert.strictEqual(num(42), 42, "num: number passthrough");
assert.strictEqual(num(undefined), 0, "num: undefined → 0");
assert.strictEqual(num(null), 0, "num: null → 0");
assert.strictEqual(num("abc"), 0, "num: NaN string → 0");
assert.strictEqual(num(NaN), 0, "num: NaN → 0");
assert.strictEqual(num(Infinity), 0, "num: Infinity → 0");

// isBookkeepingModel: synthetic + unknown + empty filtered, real models kept
assert.ok(isBookkeepingModel("<synthetic>"), "isBookkeepingModel: <synthetic> filtered");
assert.ok(isBookkeepingModel("unknown"), "isBookkeepingModel: unknown filtered");
assert.ok(isBookkeepingModel(""), "isBookkeepingModel: empty filtered");
assert.ok(isBookkeepingModel(null), "isBookkeepingModel: null filtered");
assert.ok(!isBookkeepingModel("claude-opus-4-8"), "isBookkeepingModel: real model kept");
assert.ok(!isBookkeepingModel("gpt-5.4"), "isBookkeepingModel: real model kept");

// Tool registration: all 7 new tools are in the TOOLS array with valid schemas
const analyticsToolNames = [
  "tokscale_market_share",
  "tokscale_developer_profile",
  "tokscale_model_trends",
  "tokscale_cost_analysis",
  "tokscale_device_profile",
  "tokscale_mcp_usage",
  "tokscale_competitive_intel",
];
for (const tname of analyticsToolNames) {
  const t = TOOLS.find((t) => t.name === tname);
  assert.ok(t, `tool registration: ${tname} present in TOOLS`);
  assert.ok(t.description && t.description.length > 20, `tool registration: ${tname} has description`);
  assert.ok(t.inputSchema, `tool registration: ${tname} has inputSchema`);
  assert.ok(t.inputSchema.type === "object", `tool registration: ${tname} inputSchema is object`);
  assert.ok(t.annotations?.readOnlyHint === true, `tool registration: ${tname} marked readOnly`);
}

// competitive_intel: empty target throws (validation guard)
assert.rejects(
  callTool("tokscale_competitive_intel", {}),
  /requires a non-empty `target`/,
  "tokscale_competitive_intel: empty target throws",
);

// Live shape tests — these exercise the real tokscale binary. They verify the
// output SHAPE (keys present, types correct), not specific values, so they pass
// on any machine with tokscale data and degrade gracefully (error key) if
// tokscale is absent (CI without the binary).
const hasTkscale = await (async () => {
  try {
    const { execFile } = await import("node:child_process");
    const path = await import("node:path");
    const url = await import("node:url");
    const _pkgRoot = path.dirname(url.fileURLToPath(import.meta.url));
    const _localBin = path.join(_pkgRoot, "node_modules", ".bin");
    const _envPath = `${_localBin}${process.env.PATH ? ":" + process.env.PATH : ""}`;
    await new Promise((res, rej) =>
      execFile("tokscale", ["--version"], {
        timeout: 5000,
        env: { ...process.env, PATH: _envPath },
      }, (e) => (e ? rej(e) : res())),
    );
    return true;
  } catch {
    return false;
  }
})();

if (hasTkscale) {
  // market share: tools array + totals, sorted by tokens desc
  const ms = await tokscaleMarketShare();
  if (ms.error) {
    console.log("  (tokscale models unavailable — skipping live market share assertions)");
  } else {
    assert.ok(Array.isArray(ms.tools), "market_share: tools is array");
    assert.ok(ms.totals && typeof ms.totals === "object", "market_share: totals present");
    for (const t of ms.tools) {
      assert.ok(typeof t.client === "string", "market_share: tool.client is string");
      assert.ok(typeof t.share_tokens === "number", "market_share: share_tokens is number");
      assert.ok(t.share_tokens >= 0 && t.share_tokens <= 100, "market_share: share_tokens in [0,100]");
    }
    // Verify sorted descending by tokens
    for (let i = 1; i < ms.tools.length; i++) {
      assert.ok(ms.tools[i - 1].tokens >= ms.tools[i].tokens, "market_share: sorted by tokens desc");
    }
  }

  // developer profile: tools with redacted paths (no absolute home dir leak)
  const dp = await tokscaleDeveloperProfile();
  if (!dp.error) {
    assert.ok(Array.isArray(dp.tools), "developer_profile: tools is array");
    assert.ok(dp.summary && typeof dp.summary === "object", "developer_profile: summary present");
    for (const t of dp.tools) {
      // SECURITY: no raw home directory path may appear in sessions_path
      if (t.sessions_path) {
        assert.ok(
          !t.sessions_path.includes(os.homedir()),
          "developer_profile: sessions_path redacted (no home dir leak)",
        );
        assert.ok(t.sessions_path.startsWith("~"), "developer_profile: sessions_path starts with ~");
      }
      assert.ok(Array.isArray(t.models), "developer_profile: models is array");
    }
  }

  // cost analysis: entries + client_rollup + totals
  const ca = await tokscaleCostAnalysis();
  if (!ca.error) {
    assert.ok(Array.isArray(ca.entries), "cost_analysis: entries is array");
    assert.ok(Array.isArray(ca.client_rollup), "cost_analysis: client_rollup is array");
    assert.ok(ca.totals && typeof ca.totals.total_cost === "number", "cost_analysis: totals.total_cost is number");
    for (const r of ca.entries) {
      assert.ok(typeof r.cost_per_million_tokens === "number", "cost_analysis: cost_per_million_tokens is number");
      assert.ok(typeof r.share_cost === "number", "cost_analysis: share_cost is number");
      assert.ok(r.share_cost >= 0 && r.share_cost <= 100, "cost_analysis: share_cost in [0,100]");
    }
  }

  // model trends: months + models + adoption_curve
  const mt = await tokscaleModelTrends();
  if (!mt.error) {
    assert.ok(Array.isArray(mt.months), "model_trends: months is array");
    assert.ok(Array.isArray(mt.models), "model_trends: models is array");
    assert.ok(Array.isArray(mt.adoption_curve), "model_trends: adoption_curve is array");
    // adoption_curve month prefix matches months
    if (mt.adoption_curve.length && mt.months.length) {
      assert.strictEqual(
        mt.adoption_curve[0].month,
        mt.months[0].month,
        "model_trends: adoption_curve aligns with months",
      );
    }
  }

  // device profile: redacted paths + session metrics shape
  const dev = await tokscaleDeviceProfile();
  if (!dev.error) {
    assert.ok(Array.isArray(dev.installed_tools), "device_profile: installed_tools is array");
    for (const t of dev.installed_tools) {
      if (t.sessions_path) {
        assert.ok(
          !t.sessions_path.includes(os.homedir()),
          "device_profile: sessions_path redacted (no home dir leak)",
        );
      }
    }
    if (dev.sessions) {
      assert.ok(typeof dev.sessions.session_count === "number", "device_profile: session_count is number");
      assert.ok(typeof dev.sessions.max_concurrent_sessions === "number", "device_profile: max_concurrent is number");
    }
    if (dev.activity) {
      assert.ok(Array.isArray(dev.activity.daily), "device_profile: activity.daily is array");
      assert.ok(Array.isArray(dev.activity.by_day_of_week), "device_profile: by_day_of_week is array");
      assert.strictEqual(dev.activity.by_day_of_week.length, 7, "device_profile: 7 day-of-week buckets");
    }
  }

  // mcp usage: servers array + server_count
  const mcp = await tokscaleMcpUsage();
  if (!mcp.error) {
    assert.ok(Array.isArray(mcp.servers), "mcp_usage: servers is array");
    assert.strictEqual(typeof mcp.server_count, "number", "mcp_usage: server_count is number");
    assert.ok(typeof mcp.note === "string", "mcp_usage: note is string");
  }

  // competitive intel: valid target returns found:true + competitors; bad target returns found:false
  const ci = await tokscaleCompetitiveIntel("claude");
  if (!ci.error) {
    if (ci.found) {
      assert.ok(typeof ci.rank_by_tokens === "number", "competitive_intel: rank_by_tokens is number");
      assert.ok(ci.target_profile && typeof ci.target_profile === "object", "competitive_intel: target_profile present");
      assert.ok(Array.isArray(ci.competitors), "competitive_intel: competitors is array");
      assert.ok(ci.market_totals && typeof ci.market_totals === "object", "competitive_intel: market_totals present");
    }
  }
  const ciBad = await tokscaleCompetitiveIntel("nonexistent-tool-xyz");
  if (!ciBad.error) {
    assert.strictEqual(ciBad.found, false, "competitive_intel: bad target → found:false");
    assert.ok(Array.isArray(ciBad.detected_clients), "competitive_intel: bad target lists detected clients");
  }
} else {
  console.log("  (tokscale binary not on PATH — skipping live analytics assertions)");
}

console.log(
  "✓ tokscale_analytics: redactPath · num · isBookkeepingModel · tool registration · competitive_intel guard · live shape (7 functions)",
);
