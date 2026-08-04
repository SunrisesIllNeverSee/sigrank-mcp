# SigRank Class Tiers

Every operator is classified into one of eight tiers (the **dev10x** taxonomy)
based on their Yield (Υ = Cache Reads × Output / Input²) and 10xDEV score
(`log10(T × C × R)` where T = output/input, C = cacheCreate/output,
R = cacheRead/cacheCreate). The classifier is `classify()` in
`analytics/cascade.mjs` — the canonical source of truth. The TUI, CLI, MCP
output schemas, and this doc all read from that one list.

A ninth value, **UNCLASSED**, is returned when both Υ and 10xDEV are null
(empty / all-zero session). It is distinct from IGNITER so callers can tell
"no data" from "bottom tier".

## TRANSMITTER (Υ ≥ 1000 or 10xDEV ≥ 3)
- **Profile:** Cascade-optimized operators. High cache reads, minimal input, efficient output.
- **Behavior:** Surgical — minimal new input, maximum cache reuse, high-yield output.
- **Typical:** Power users with long-running sessions, tight context windows, and aggressive cache strategies.
- **Maintain:** Keep cache hit rate high. Avoid context bloat. Monitor with watch_tokenpull.

## ARCH+ (10xDEV ≥ 1.45)
- **Profile:** High-leverage architect. Strong compounding loop.
- **Behavior:** Builds forward aggressively while reusing prior context.
- **Fix:** Push cache reads higher to cross into TRANSMITTER.

## ARCH (1.35 ≤ 10xDEV < 1.45)
- **Profile:** Established architect. Solid compounding, room to tighten.
- **Behavior:** Reliable reuse + generation balance.
- **Fix:** Increase cacheCreate quality (better summaries, tighter prompts) to reach ARCH+.

## POWER (1.2 ≤ 10xDEV < 1.35)
- **Profile:** Productive operator with a forming compounding loop.
- **Behavior:** Moderate cache leverage, decent output efficiency.
- **Fix:** Reuse sessions more aggressively to lift cache reads.

## BASE (1.0 ≤ 10xDEV < 1.2)
- **Profile:** Balanced operator. Some cache, decent output efficiency.
- **Behavior:** Productive — reasonable input-to-output ratio, some cache leverage.
- **Typical:** Experienced AI coders who use CLAUDE.md, project context, and session continuity.
- **Fix:** Increase cache reads by reusing sessions. Reduce input by trimming unnecessary context.

## SEEKER (0 ≤ 10xDEV < 1.0)
- **Profile:** Learning operator. Compounding loop not yet formed.
- **Behavior:** Exploring — input-heavy, building toward reuse.
- **Fix:** Commit context to cache (longer sessions, --continue) to start compounding.

## REFINER (-0.3 ≤ 10xDEV < 0)
- **Profile:** Raw volume operators. High input tokens, low cache reuse.
- **Behavior:** Brute-force — lots of context fed in, relatively little output back.
- **Typical:** New AI users, verbose prompters, no session continuity.
- **Fix:** Build cache across sessions. Stop re-explaining context. Use --continue.

## IGNITER (10xDEV < -0.3)
- **Profile:** Sub-baseline. Negative compounding — context is being lost faster than it's built.
- **Behavior:** Each turn re-ingests more than it reuses; the loop runs in reverse.
- **Fix:** Stop starting fresh sessions. Commit context once and reuse it.

## UNCLASSED (no data)
- **Profile:** Empty session — all four pillars are zero.
- **Behavior:** No tokens recorded for this window.
- **Fix:** Run some sessions; the tier will resolve once there is data.

Tiers are recalculated on every submission. Your tier can change between windows (7d, 30d, 90d, all-time).
