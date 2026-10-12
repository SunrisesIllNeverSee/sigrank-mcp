# Tokenpull Investigation — tokscale TUI timeout, Claude submissions, and the input-reporting era shift

**Date:** 2026-10-12 · **Author:** DREP1 · **Repo:** `_02_sigrank-mcp` · **Fix commit:** `d02de91` (main, pushed — no release dispatched)

## Executive summary

Three findings from one investigation pass:

1. **tokscale disappearing in the TUI was a timeout bug** — `tokscale models --json` now takes ~57–120s on this machine but every caller hardcoded a 60s `execFile` timeout. The subprocess was being killed mid-scan and every call site silently degraded to `null`. Fixed via `TOKSCALE_SCAN_TIMEOUT_MS` (default 180s, env `SIGRANK_TOKSCALE_TIMEOUT_MS`), committed `d02de91`, pushed to main. **Note:** the published `npx sigrank` binary still carries the bug — it ships on the next explicit release dispatch.
2. **All historical Claude submissions were isolated** — 580 `snapshot_submissions` rows `platform='claude'`, 2026-06-26 → 2026-10-11, 15 codenames.
3. **The numbers pulled today are faithful to the logs — and the logs changed.** Claude Code 2.1.296-era records report `input_tokens ≈ 2/msg` where 2.1.16x-era records averaged `797.7/msg`. Same field, same schema, different accounting. With `input²` in the Υ denominator, new-era windows produce yields ~1000× the old era's — the "19,372.7K" shown on the 7d row is **19.37 million**, not ~19K.

---

## 1. tokenpull mechanics (reference)

tokenpull is SigRank's in-house, on-device usage reader. It reads **token counts only** — never message text — and nothing leaves the machine unless the user submits.

| Component | File | Role |
|---|---|---|
| Core pull | `adapters/tokenpull.mjs` | `tokenpull()` / `tokenpullCodex()` / `tokenpullAny()` + fresh verifier readers |
| Adapter registry | `adapters/index.mjs` | 17 adapters (amp, kimi, qwen, pi, openclaw, droid, codebuff, gemini, copilot, opencode, goose, kilo, hermes, devin, other, omp, proxy, antigravity, grok, zcode) |
| MCP tools | `tools/tokenpull.mjs`, `tools/tokenpull-submit.mjs` | zero-paste preview; submit preview only (publish = `submit_verified` → ed25519 → `/api/v1/snapshots`) |
| External verifiers | `freshVerifierPillars()` in `adapters/tokenpull.mjs` | ccusage, tokscale, token-dash — Compare tab only, all-time sums |

**Claude adapter mechanics:**

- Walks `~/.claude/projects/**/*.jsonl` recursively (includes `subagents/`), symlink-safe, capped at `SIGRANK_MAX_JSONL_FILES` (default 10k).
- Yields per-message `{id, sid, ts, input, output, cacheCreate, cacheRead}` from `message.usage`.
- **Dedup by `message.id` keep-last** — Claude Code writes 2–3 partial→final lines per response; only the final tally matches billing.
- Window bucketing: 7d/30d/90d by parsed `timestamp`; records without a parseable timestamp land in `all` only (no fabricated times).
- `EXCLUDE_TOOLING` regex drops background tooling dirs (claude-mem, mem0, observers, etc.) — subagents are KEPT.
- Non-Claude platforms report combined input → split via ioRatio (Beta = operator's Claude input/output ratio, Alpha = 2.0 fallback).

## 2. tokscale TUI bug — root cause and fix

**Symptom (user report):** "tokscale didn't pull in my most recent attempt in the TUI" — Compare tab shows `no data from: tokscale (npm i -g tokscale)`.

**Root cause:** the tokscale scan walks every local session log and on this machine reports `processingTimeMs: 57125` — i.e. ~57s of CPU time, ~60–120s wall clock. All six call sites hardcoded a **60s** `execFile` timeout. `freshVerifierPillars('claude')` reproduced live: `tokscale: null` at exactly **60,019ms** — subprocess killed mid-scan.

**Fix (`d02de91`):**

- New `TOKSCALE_SCAN_TIMEOUT_MS` (default 180s, env `SIGRANK_TOKSCALE_TIMEOUT_MS`) in `lib/constants.mjs` — under tokscale's own `nativeTimeoutMs` default of 300s.
- Applied to all call sites: `_freshTokscale` (adapters/tokenpull.mjs), `_tokscaleDetectClients` (tools/index.mjs), `_tokscalePillars` (tools/_verifiers.mjs), `tokscaleModelBreakdown` (tools/tokscale-breakdown.mjs), `T_MODELS/T_MONTHLY/T_CLIENTS/T_GRAPH/T_REPORT` (tokscale_analytics.mjs), `tokscalePillars` (presentation/cli.mjs).
- TUI hint corrected: `tokscale (not installed, or scan timed out)` — a timeout is not a missing binary.

**Verified:** fresh pull now returns claude pillars `in 14.4M / out 25.9M / cw 255M / cr 6.34B`. Gates: `node test.mjs` all suites green (incl. 7 live tokscale analytics calls), `node --test __tests__/sign.test.mjs` 1/1.

**Residual risk:** the scan duration grows with log volume — 180s is headroom, not a bound. If fleets see ≥3min scans, the deeper fix is tokscale's own incremental caching (`tui-data-cache.json`) or a `--since`-bounded fallback for windowed views.

## 3. Claude submissions — historical isolation

Source: `snapshot_submissions` (Supabase), `platform='claude'`.

- **580 rows total**, 2026-06-26 → 2026-10-11: 148×7d, 146×30d, 143×90d, 143×all_time.
- **15 codenames.** Most active: `signal-92b4f9f485` (155 rows, this device), `signal-ff39a3d631` (103), `signal-3b92921881` (72), `signal-ae3b5c3c55` (52), `signal-148d593199` (40), `signal-d4e0290661` (36), `signal-c0de0d1f7c` (24), `signal-9c82e916f9` (24).
- Most recent claude submission: `signal-d4e0290661` @ 2026-10-11 01:16 UTC (verified, scored).

Notable per-codename trajectories (all_time window):

| Codename | Span | all-time input | all-time output | out/in |
|---|---|---|---|---|
| signal-92b4f9f485 | Jun 26 → Oct 8 | 9.8M → 14.4M | 16.9M → 21.1M | ~1.5× (stable) |
| signal-d4e0290661 | Jul 14 | 99,358 | 352,025 | 3.5× |
| signal-d4e0290661 | Oct 2 | 75,334 | 39,620,224 | **526×** |
| signal-d4e0290661 | Oct 11 | 141,336 | 69,973,066 | **495×** |

`signal-92b4f9f485`'s Oct 2/Oct 8 submissions show populated all-time but **zero 7d/30d/90d** — the machine had no billable claude messages in-window during the Jul→Oct usage gap (verified below; consistent, not a bug).

## 4. Today's pull — full decomposition

User's pull, `platform: claude` (reproduced live from `~/.claude/projects`, 1,040 files, 28,999 deduped messages):

| Window | Input | Output | CacheW | CacheR | Υ |
|---|---|---|---|---|---|
| 7d | 6,558 | 1,590,141 | 15,098,738 | 504,200,281 | **≈19.37M** (displayed `19372.7K`) |
| 30d | identical | identical | identical | identical | identical |
| 90d | identical | identical | identical | identical | identical |
| all | 14,374,614 | 22,716,360 | 214,854,482 | 6,103,401,880 | 575.1 |

**7d = 30d = 90d is genuine, not a bug:** zero billable messages carry timestamps between ~Jul 14 and Oct 5. ccusage independently shows the same windowed values. The gap is real usage history (operator was on Devin — devin adapter 30d shows ~28.5M input).

**The pull is live, not stale:** the all-time delta vs the Oct 8 board submission equals the 7d window *exactly* — `out +1,590,141`, `cw +15,098,738`, `cr +504,200,281`. Today's pull = Oct 8 all-time + the Oct 5–12 burst.

**The Υ display is misleading at this magnitude:** `fmtTok` divides by 1,000 and appends `K`, so Υ 19,372,700 renders `19372.7K` — easily misread as ~19.4K (the MO§ES seed Υ is 18,436.98 ≈ "18K"). Actual value: ~1,050× that benchmark.

## 5. The input-reporting era shift — evidence

Per-message `usage` stats, raw jsonl, tooling dirs excluded:

| Era | Claude Code version | msgs sampled | avg `input_tokens` | avg `cacheRead` | avg `cacheCreate` | avg `output` |
|---|---|---|---|---|---|---|
| ≤ Jul 15 | 2.1.161 / 2.1.168 | 54,105 | **797.7** | 213,234 | 9,574 | 941 |
| Oct 5–12 | 2.1.296 | 6,538 | **2.1** | 159,740 | 4,809 | 423 |

- Same field, same schema, ~380× lower reported input. New-era records add `output_tokens_details`, `fallback_credit` keys — consistent with a newer harness build.
- Under the new reporting, virtually all prompt context flows through cache write/read; `input_tokens` is only the marginal uncached remainder.
- Effect on canon Υ = `cache_read × output / input²`: the denominator collapses ~150,000×, so yields on new-era windows inflate into the tens of millions while old-era submissions stay in the hundreds.

## 6. Ruled out

- **Plugin-booster exclusion:** the all-time tokenpull↔ccusage delta (out +14%, cw +19%, cr +4%) is fully accounted by `EXCLUDE_TOOLING` — 5,505 background-tooling messages (15.9%). Unfiltered totals match ccusage (out 25.91M vs 25.9M). Working as designed.
- **Wrong/missed root:** the new account writes to `~/.claude/projects` and is being read (recent burst present, matches ccusage window-for-window).
- **Stale cache:** deltas reconcile exactly against the Oct 8 submission.
- **Schema change breaking the parser:** all pillar fields present and populated; values parsed correctly.

## 7. Open decision for the owner (canon-level)

`input_tokens` under new reporting no longer carries the meaning it had when Υ was calibrated. Options:

- **A — accept:** pillars are billing-faithful; yields inflate on new-era data. Cheapest, but breaks cross-era comparability on the board.
- **B — normalize input:** `input' = input_tokens + cache_creation_input_tokens` (total fresh input ≈ pre-change `input` semantics). Would put today's 7d input at ~15.1M → Υ ≈ 3.4K. Changes scoring — requires a ruleset version bump.
- **C — flag only:** mark windows `estimated:true` or annotate when `avg input/msg < threshold` (era-shift detection), keep formula untouched.

Recommendation: flag first (C) so detection is visible, then decide B as a ruleset-level change. The frozen invariants (MOSES seeds → Υ 18,436.98) are unaffected — seed pillars keep their values; only the *source mapping* from logs to `input` is in question.

## Appendix — reproduction

```bash
cd _02_sigrank-mcp
# Fresh verifier pull (was null at 60s, now OK under 180s)
node -e "import('./adapters/tokenpull.mjs').then(async m=>{
  const t=Date.now(); const r=await m.freshVerifierPillars('claude');
  console.log(Date.now()-t+'ms', 'tokscale:', r.tokscale?'OK':'NULL'); })"
# Claude submissions history (Supabase)
#   SELECT platform, window_type, count(*), min(submitted_at), max(submitted_at)
#   FROM snapshot_submissions GROUP BY platform, window_type;
# Era-shift probe: compare avg input_tokens/msg on jsonl before 2026-07-15 vs after 2026-10-05.
```
