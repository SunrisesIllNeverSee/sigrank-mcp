# ops-review.mjs — Internal Ratio Review + Apply Tool

**NOT part of the public `npx sigrank` CLI.** Owner-only. Run from a local clone
of sigrank-mcp with Supabase service-role credentials.

## Why this exists

ChatGPT/Codex bundles `cache_write` into `input` and reports `cache_write` as
near-zero. This causes SigRank to flag these operators as non-compounding, null
their yield, and sort them to the bottom of the leaderboard.

The re-parse tool splits `combined_input` into `input + cache_write` using a
reference operating ratio, then recalculates the cascade. The correct ratio is
identified by the **cache_write convergence test** (see Methodology below).

This tool modifies operator profiles. It does NOT belong in the public CLI.
Every apply is logged as a submission entry on the operator's profile with
`source='ops_reparse'` so the action is transparent and auditable.

## Setup

```bash
# From inside the sigrank-mcp repo directory
export SUPABASE_URL=https://copqtaqzsdvpdbhpwjmt.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=<your service-role key>
```

The service-role key bypasses RLS. NEVER commit it to the repo.

## Three modes

### 1. calc — run the ratio review on raw numbers (no DB)

```bash
node ops-review.mjs calc --output 23655246 --cache-read 5845750656 --combined-input 280931419
```

Takes three real telemetry values and runs all three reference ratios. Shows
which ratios pass cache_write validation, which has the best leverage match,
and the recalculated cascade metrics for each. No Supabase credentials needed.

### 2. lookup — pull operator from Supabase, then review

```bash
node ops-review.mjs lookup --codename kr-yeon
```

Pulls the operator's latest metric_snapshot from Supabase, extracts the four
token pillars, and runs the full ratio review. The stored `input_tokens` is
treated as `combined_input` (since that's what Codex reports). Shows the
stored pillars alongside the re-parsed results.

### 3. apply — re-parse + write to Supabase

```bash
# Dry run first (shows what would be written, no DB changes)
node ops-review.mjs apply --codename kr-yeon --ratio "Codex PU" --dry-run

# Real apply (prompts for confirmation)
node ops-review.mjs apply --codename kr-yeon --ratio "Codex PU"

# Skip confirmation prompt
node ops-review.mjs apply --codename kr-yeon --ratio "Codex PU" --yes

# Apply with manual numbers (instead of DB lookup)
node ops-review.mjs apply --codename kr-yeon --ratio "AA avg" \
  --output 23655246 --cache-read 5845750656 --combined-input 280931419
```

**What apply does:**
1. Pulls the operator's current pillars from Supabase (or uses manual flags).
2. Splits `combined_input` into `input + cache_write` using the chosen ratio.
3. Recalculates the full cascade (yield, leverage, velocity, SNR, 10xDEV, class, mode).
4. Inserts a new row in `snapshot_submissions` with `source='ops_reparse'`,
   the ratio used, original pillars, re-parsed pillars, and cascade results.
   This is the transparency log — it shows up in the operator's submission history.
5. Upserts `metric_snapshots` with the re-parsed pillars + new class tier.
   This is what the leaderboard reads, so the operator's rank updates.

## Methodology — the cache_write convergence test

### The problem

Codex (and ChatGPT) report token telemetry differently than Claude:

| Pillar | Claude reports | Codex reports |
|--------|---------------|---------------|
| Input | fresh input only | fresh input + cache_write combined |
| Cache write | actual cache_write | near-zero (bundled into input) |
| Cache read | actual cache_read | actual cache_read |
| Output | actual output | actual output |

SigRank's yield formula is `Υ = (cache_read * output) / input^2`. When
cache_write is bundled into input, the input denominator is inflated, leverage
collapses, and yield nulls out. The operator looks like a non-compounding
beginner when they're actually a high-leverage power user.

### The fix

We split the combined input using a reference operating ratio:

```
1. Pick a reference velocity (output/input ratio) for the operator type
2. estimated_input = output / velocity
3. cache_write = combined_input - estimated_input   (the remainder)
4. Recompute all cascade metrics from the split pillars
```

The reference only sets the velocity (how we split). The operator's LEVERAGE
is computed from their real `cache_read` against the new `input` — it is
their own number, not the reference.

### The three reference ratios

| Ratio | Format | Velocity | Description |
|-------|--------|----------|-------------|
| AA avg | 3.5:1:0.5 | 0.5 | all-users average |
| HCM | 20:1:0.1 | 0.1 | human center of mass (median human operator) |
| Codex PU | 243:1:1.03 | 1.03 | Codex power-user (top-tier) |

Format is `cache_read : input : output` (input=1). The velocity is the
output/input term. The cache term is the reference leverage (cache_read/input).

### How to pick the right ratio

Run the review. Two tests eliminate wrong ratios:

**Test 1: cache_write convergence.** After splitting, the derived cache_write
should land in the same range as other operators on that ratio (roughly
230-320M for 30-day windows). If one ratio produces a cache_write >50% below
the peer median, that ratio is broken for this operator — the velocity
assumption doesn't match their actual working pattern.

**Test 2: leverage match.** The operator's actual leverage (cache_read /
estimated_input) should be close to the ratio's reference cache term. If
actual leverage is 254:1 but the reference says 3.5:1, the operator doesn't
work like that ratio's archetype. Look for levMatch closest to 1.0x.

### Worked example: kr-yeon

**Real telemetry:**
- Output: 23,655,246 (23.7M)
- Cache read: 5,845,750,656 (5.85B)
- Combined input: 280,931,419 (280.9M)

**Results:**

| | AA avg (3.5:1:0.5) | HCM (20:1:0.1) | Codex PU (243:1:1.03) |
|---|---|---|---|
| Input (est) | 47.3M | 236.6M | 23.0M |
| Cache write | 233.6M | 44.4M | 258.0M |
| Leverage | 123.6:1 | 24.7:1 | 254.5:1 |
| Yield | 61.78 | 2.47 | 262.17 |
| CW valid | PASS | FAIL (outlier) | PASS |
| Lev match | 35.3x (WEAK) | 1.24x (STRONG) | 1.05x (STRONG) |
| Class | ARCH+ | ARCH | ARCH+ |

**Analysis:**
- HCM eliminated: cache_write 44.4M is >50% below peer median (outlier).
- AA avg passes cache_write but leverage 123.6:1 is 35x off the reference 3.5:1.
  The operator doesn't work like an average user.
- Codex PU passes cache_write AND leverage 254.5:1 matches reference 243:1
  (1.05x). This operator works like a Codex power-user.

**Result:** kr-yeon re-parsed with Codex PU. Yield 262.17, class ARCH+.
Rank jumped from #1514 to #137.

### Known limitation

For massive operators (39B+ combined input), all three ratios may pass
cache_write validation. Leverage match becomes the only signal. May need a
secondary signal (platform check, velocity threshold) for edge cases.

## What gets written to Supabase

### snapshot_submissions (the transparency log)

A new row with:
- `source: 'ops_reparse'` in payload_json
- `ratio_used`, `ratio_label`, `applied_at`, `applied_by` in payload_json
- `original_pillars` and `reparsed_pillars` in payload_json
- Full cascade results in payload_json
- The four re-parsed pillar columns (input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens)
- `status: 'scored'`, `ruleset_version: 'ops-reparse-v1'`

This shows up in the operator's submission history on their profile.

### metric_snapshots (the board read layer)

An upserted row with:
- The four re-parsed pillar columns
- Updated `class_tier` from the recalculated cascade
- `ruleset_version: 'ops-reparse-v1'`

This is what the leaderboard reads, so the operator's rank updates immediately.

## Files

- `ops-review.mjs` — the tool (this README's companion)
- `cascade.mjs` — the pure cascade math (shared with the public CLI)
- `review.mjs` — the old review subcommand code (kept for reference, no longer dispatched from cli.mjs)

## Decision history

- **2026-07-16:** Removed `review` from public `npx sigrank` CLI (owner decision:
  the tool modifies operator profiles, doesn't belong in the public CLI). Built
  `ops-review.mjs` as an internal owner-only entry point. Apply writes to
  Supabase via REST API (service-role key, no new dependency). Re-parse logged
  as a submission entry on the operator's profile for transparency.
