# SigRank Class Tiers

Every operator is classified into one of **24 experience stages** — 8 tiers ×
3 sub-stages (I/II/III) — based on their **total tokens** (input + output +
cacheCreate + cacheRead). The ladder mirrors the server's
`RS05_CLASS_THRESHOLDS` (`lib/analytics/ruleset.ts` in sigrank-app) — the
client's `classify()` in `analytics/cascade.mjs` is the canonical local source
of truth. The TUI, CLI, MCP output schemas, and this doc all read from that
one list.

The class is an **experience** axis — it measures how much volume the operator
has accumulated. It is separate from the **build archetype** (the operator's
composition shape: CONVERGENT, KINETIC, INPUT-BOUND, ARCHIVIST, AMPLIFIER, etc.)
and from the **TRANSMITTER peak badge** (a temporary state — see below).

A 25th value, **UNCLASSED**, is returned when total tokens are null or
non-finite (empty / all-zero session). It is distinct from IGNITER III so
callers can tell "no data" from "bottom tier".

## The 8 base tiers (K.01–K.08)

Each tier has 3 sub-stages (I/II/III) split by total-token thresholds. The
sub-stage is the granular experience level; the base tier is the display
grouping (color, glyph, meaning).

### ARCH+ (K.01) — total ≥ 7.07T
- **Sub-stages:** ARCH+ I (≥ 7.07T), ARCH+ II (≥ 7.07T), ARCH+ III (≥ 7.07T)
- **Profile:** Deepest field experience. Volume that became architecture.
- **Note:** Aspirational — currently 1 operator in the static board.

### ARCH (K.02) — total ≥ 68.8B
- **Sub-stages:** ARCH I (≥ 186B), ARCH II (≥ 98.5B), ARCH III (≥ 68.8B)
- **Profile:** System builders. Sustained volume, coherent output.

### POWER (K.03) — total ≥ 19.1B
- **Sub-stages:** POWER I (≥ 40.0B), POWER II (≥ 27.0B), POWER III (≥ 19.1B)
- **Profile:** Above the center. Volume compounding.

### BASE (K.04) — total ≥ 7.7B
- **Sub-stages:** BASE I (≥ 14.0B), BASE II (≥ 10.2B), BASE III (≥ 7.7B)
- **Profile:** The center of the field. The average operator's experience.

### SEEKER (K.05) — total ≥ 3.0B
- **Sub-stages:** SEEKER I (≥ 5.4B), SEEKER II (≥ 4.0B), SEEKER III (≥ 3.0B)
- **Profile:** Approaching the center. Experience accumulating.

### REFINER (K.06) — total ≥ 1.3B
- **Sub-stages:** REFINER I (≥ 2.4B), REFINER II (≥ 1.8B), REFINER III (≥ 1.3B)
- **Profile:** Practicing with purpose. Early sustained volume.

### BEARER (K.07) — total ≥ 432M
- **Sub-stages:** BEARER I (≥ 984M), BEARER II (≥ 715M), BEARER III (≥ 432M)
- **Profile:** Quiet accumulation. The first real volume.

### IGNITER (K.08) — total ≥ 0
- **Sub-stages:** IGNITER I (≥ 216M), IGNITER II (≥ 89.0M), IGNITER III (≥ 0)
- **Profile:** Dormant potential. The still soul. Waiting.

## UNCLASSED (no data)
- **Profile:** Empty session — all four pillars are zero.
- **Fix:** Run some sessions; the stage will resolve once there is data.

## TRANSMITTER (peak badge, not a class)

TRANSMITTER is **not** on the experience ladder. It is a temporary peak badge
(RS.08) that any experience tier can earn during a high-frequency,
high-resonance window. An operator "transmits" when they hit both:

- **High frequency:** token throughput (total tokens in window) ≥ 1B
- **High resonance:** SIGNA RATE (composite signal quality) ≥ 85

The badge is per-window (daily/weekly) and lapses when frequency or resonance
drops. The server evaluates it via `evaluateTransmitterBadge()` in
`lib/analytics/transmitter-badge.ts`; the client does not evaluate the badge
locally (the owner is still calibrating the thresholds). The server is the
authority.

---

Tiers are recalculated on every submission. Your stage can change between
windows (7d, 30d, 90d, all-time) as total tokens accumulate.
