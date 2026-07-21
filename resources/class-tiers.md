# SigRank Class Tiers

Every operator is classified into one of three tiers based on their Yield (Υ = Cache Reads × Output / Input²).

## Burner (Υ < 1.0)
- **Profile:** Raw volume operators. High input tokens, low cache reuse.
- **Behavior:** Brute-force — lots of context fed in, relatively little output back.
- **Typical:** New AI users, verbose prompters, no session continuity.
- **Fix:** Build cache across sessions. Stop re-explaining context. Use --continue.

## Builder (1.0 ≤ Υ < 10.0)
- **Profile:** Balanced operators. Moderate cache, decent output efficiency.
- **Behavior:** Productive — reasonable input-to-output ratio, some cache leverage.
- **Typical:** Experienced AI coders who use CLAUDE.md, project context, and session continuity.
- **Fix:** Increase cache reads by reusing sessions. Reduce input by trimming unnecessary context.

## 10xer (Υ ≥ 10.0)
- **Profile:** Cascade-optimized operators. High cache reads, minimal input, efficient output.
- **Behavior:** Surgical — minimal new input, maximum cache reuse, high-yield output.
- **Typical:** Power users with long-running sessions, tight context windows, and aggressive cache strategies.
- **Maintain:** Keep cache hit rate high. Avoid context bloat. Monitor with watch_tokenpull.

Tiers are recalculated on every submission. Your tier can change between windows (7d, 30d, 90d, all-time).
