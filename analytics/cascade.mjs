/**
 * cascade.mjs — SigRank yield cascade facade.
 *
 * The canonical cascade math (Υ Yield, SNR, Leverage, Velocity, 10xDEV, and the
 * 24-stage RS05 class taxonomy) now lives in the `@sigrank/cascade` package.
 * This file re-exports the canonical functions and adds local-only helpers that
 * are presentation/MCP-specific and intentionally NOT part of the canonical
 * math package:
 *   - CLASS_TIERS, SIGNAL_CLASSES, UNCLASSED  (display taxonomy)
 *   - tierOf(), stageOf()                      (display helpers)
 *   - detectMode(), MODE_EXPECTED_YIELD, qualityScore()  (mode/quality layer)
 *   - parsePillars()                           (text → 4 pillars extractor)
 *
 * The cascade() wrapper preserves the object-signature
 * ({ input, output, cacheCreate, cacheRead }) used throughout this repo and
 * re-attaches the `mode` field (detectMode) that the canonical package
 * intentionally omits (mode is a presentation-layer concern, not canonical
 * math).
 *
 * Canonical reference: MO§ES Υ 18436.98 from (1251211, 11296121, 128196310, 2555179769).
 *
 * Degenerate-input policy (inherited from the canonical package):
 *   - Any pillar that collapses a denominator (i=0, o=0, cw=0, cr=0) returns null for
 *     the affected metrics rather than Infinity/NaN.
 *   - A `warnings[]` array is attached when any metric is null so callers can surface the
 *     reason without silently corrupting downstream calculations.
 *   - The cascade is NEVER thrown away — even partial results are useful for review/storage.
 *     Callers that require a fully-formed result should check `warnings.length === 0`.
 */

// ─── Canonical math (from @sigrank/cascade) ─────────────────────────────────
import {
  cascade as cascadeCanonical,
  round,
  classify,
  RS05_CLASS_THRESHOLDS,
  fieldStats,
  percentileOf,
  rankOf,
  operatorSignature,
  evaluateOperator,
} from "@sigrank/cascade";

// Re-export the canonical functions so existing import paths keep working.
export {
  round,
  classify,
  RS05_CLASS_THRESHOLDS,
  fieldStats,
  percentileOf,
  rankOf,
  operatorSignature,
  evaluateOperator,
};

/**
 * The four raw token pillars → the cascade.
 *
 * Object-signature wrapper around the canonical `@sigrank/cascade` cascade()
 * (which takes positional args). Re-attaches the `mode` field via detectMode()
 * so the 20+ call sites in this repo that read `result.mode` keep working.
 */
export function cascade({ input, output, cacheCreate, cacheRead }) {
  const result = cascadeCanonical(input, output, cacheCreate, cacheRead);
  // Re-attach mode — the canonical package intentionally omits it (mode is a
  // presentation-layer concern, not canonical math).
  result.mode = detectMode({ input, output, cacheCreate, cacheRead });
  return result;
}

// ─── Local-only display taxonomy (not in @sigrank/cascade) ───────────────────

/**
 * CLASS_TIERS — the 8 base tier names (K.01–K.08) for display: glyph, color,
 * meaning. SINGLE SOURCE OF TRUTH for tier-level display info.
 *
 * The permanent class is an EXPERIENCE ladder keyed on TOTAL TOKENS. Each tier
 * has 3 sub-stages (I/II/III) — 24 stages total. The 24 thresholds live in
 * RS05_CLASS_THRESHOLDS (re-exported from @sigrank/cascade above). classify()
 * returns the full sub-stage string (e.g. "REFINER II"). Use tierOf() to
 * extract the base tier name.
 *
 * TRANSMITTER is NOT on this ladder — it is a temporary peak badge (RS.08).
 * The client does not evaluate the badge (owner is still calibrating it);
 * the server does it on read.
 *
 * Mirrors the server's canon-ids.ts CLASS_TIERS (display). Order is descending
 * (ARCH+ → IGNITER).
 */
export const CLASS_TIERS = [
  "ARCH+",
  "ARCH",
  "POWER",
  "BASE",
  "SEEKER",
  "REFINER",
  "BEARER",
  "IGNITER",
];

/**
 * SIGNAL_CLASSES — the full 24 sub-stage names (8 tiers × 3 sub-stages I/II/III).
 * Mirrors the server's SIGNAL_CLASSES set in lib/board/mappers.ts. The API
 * returns class_tier as one of these 24 values. classify() returns one of these
 * (or UNCLASSED). Use this for schema enums and validation.
 */
export const SIGNAL_CLASSES = [
  "ARCH+ I", "ARCH+ II", "ARCH+ III",
  "ARCH I", "ARCH II", "ARCH III",
  "POWER I", "POWER II", "POWER III",
  "BASE I", "BASE II", "BASE III",
  "SEEKER I", "SEEKER II", "SEEKER III",
  "REFINER I", "REFINER II", "REFINER III",
  "BEARER I", "BEARER II", "BEARER III",
  "IGNITER I", "IGNITER II", "IGNITER III",
];

/** The degenerate-case class returned when totalTokens is null/undefined
 *  (all-zero / empty session). Distinct from IGNITER III (which is a real
 *  low-experience tier) so callers can tell "no data" from "bottom tier". */
export const UNCLASSED = "UNCLASSED";

/** Extract the base tier name from a sub-stage string (e.g. "ARCH+ I" → "ARCH+").
 *  Mirrors the server's tierOf() in components/sigrank/types.ts. Returns the
 *  input as-is if it's not a sub-stage string (e.g. UNCLASSED). */
export function tierOf(cls) {
  if (cls === UNCLASSED || cls == null) return cls;
  const parts = String(cls).split(" ");
  if (parts.length >= 2 && ["I", "II", "III"].includes(parts[parts.length - 1])) {
    return parts.slice(0, -1).join(" ");
  }
  return cls;
}

/** Extract the sub-stage from a sub-stage string (e.g. "ARCH+ I" → "I").
 *  Mirrors the server's stageOf(). Returns null for non-sub-stage strings. */
export function stageOf(cls) {
  if (cls === UNCLASSED || cls == null) return null;
  const parts = String(cls).split(" ");
  const stage = parts[parts.length - 1];
  return stage === "I" || stage === "II" || stage === "III" ? stage : null;
}

// ─── Mode / quality layer (not in @sigrank/cascade) ──────────────────────────

/**
 * detectMode — classify an operator's current working mode from 4 token pillars.
 *
 * Pure ratio math, first-match-wins (same pattern as classify() — descending
 * cuts preserve edge semantics). MAINTAIN checked first (high leverage is
 * strongest signal), then DEBUG (low velocity is distinctive), then EDIT,
 * then BUILD as fallback.
 *
 * Modes:
 *   BUILD    — high input, low/zero cacheRead, output rising (greenfield)
 *   EDIT     — high input, low cacheRead, high output (polishing)
 *   DEBUG    — high input, low output, low cacheRead (investigating)
 *   MAINTAIN — low input, high cacheRead, high output (compounding)
 *   IDLE     — near-zero tokens (not working)
 *
 * Returns { mode, confidence }.
 */
export function detectMode({ input, output, cacheCreate, cacheRead }) {
  const i = Number(input),
    o = Number(output),
    cw = Number(cacheCreate),
    cr = Number(cacheRead);
  const total = i + o + cw + cr;

  // IDLE: near-zero tokens
  if (total < 1000) return { mode: "IDLE", confidence: 1.0 };

  const leverage = i > 0 ? cr / i : 0;
  const velocity = i > 0 ? o / i : 0;
  const input_share = total > 0 ? i / total : 0;

  // MAINTAIN: high leverage + high velocity (the cascade is compounding)
  if (leverage > 10 && velocity > 1)
    return { mode: "MAINTAIN", confidence: 0.9 };
  if (leverage > 3 && velocity > 0.5)
    return { mode: "MAINTAIN", confidence: 0.7 };

  // DEBUG: low velocity + high input share (reading, not producing)
  if (velocity < 0.3 && input_share > 0.5)
    return { mode: "DEBUG", confidence: 0.8 };

  // EDIT: high input share + high velocity (fresh input but producing)
  if (input_share > 0.4 && velocity > 0.5)
    return { mode: "EDIT", confidence: 0.7 };

  // DEBUG (secondary): high input share + low velocity
  if (input_share > 0.4 && velocity < 0.5)
    return { mode: "DEBUG", confidence: 0.6 };

  // BUILD: fallback (high input, no cache reuse yet)
  return { mode: "BUILD", confidence: 0.6 };
}

/**
 * Expected yield per mode — global defaults used before personal baselines
 * exist (needs 7+ days of history). Used by the quality score computation.
 */
export const MODE_EXPECTED_YIELD = {
  BUILD: 15,
  EDIT: 45,
  DEBUG: 10,
  MAINTAIN: 5000,
  IDLE: 0,
};

/**
 * qualityScore — actual yield relative to mode expectation.
 * Fixes the "debug is bad" problem: a DEBUG session at 80% quality is good.
 * Returns a number 0+ (can exceed 1.0 if outperforming the expected yield).
 */
export function qualityScore(actualYield, mode) {
  const expected = MODE_EXPECTED_YIELD[mode] ?? 1;
  if (expected === 0) return actualYield === 0 ? 1.0 : 0;
  return actualYield / expected;
}

// ─── Text parsing (not in @sigrank/cascade) ──────────────────────────────────

/**
 * Extract the 4 pillars from pasted text: JSON object OR 4 whitespace numbers.
 *
 * Hardened parse policy:
 *   - JSON path: requires named keys and numeric values. Rejects strings/null.
 *   - Positional path: requires the input to be ONLY numeric tokens (whitespace/commas
 *     allowed as separators). If the text contains non-numeric words the positional
 *     extractor attaches a `_parseWarnings` flag so downstream can route it to a review
 *     channel instead of treating it as authoritative data.
 *   - Negative values are accepted (not thrown away) but flagged — could be valid in
 *     some edge-case accounting or a data error; the server is the authority on validity.
 *   - We NEVER silently corrupt: if we can't parse 4 pillars we throw. If we parse but
 *     something looks suspicious we surface it in `_parseWarnings` on the returned object.
 */
export function parsePillars(text) {
  const t = String(text || "").trim();
  const pw = []; // parse warnings to attach

  // ── JSON path ──────────────────────────────────────────────────────────────
  try {
    const j = JSON.parse(t);
    if (j && typeof j === "object" && !Array.isArray(j)) {
      const g = (...keys) => {
        for (const k of keys) if (j[k] != null) return j[k];
        return null;
      };
      const input = g(
        "input",
        "tokens_input_fresh",
        "inputTokens",
        "input_tokens",
      );
      const output = g(
        "output",
        "tokens_output",
        "outputTokens",
        "output_tokens",
      );
      const cacheCreate = g(
        "cacheCreate",
        "tokens_cache_creation",
        "cache_creation_tokens",
      );
      const cacheRead = g(
        "cacheRead",
        "tokens_cache_read",
        "cache_read_tokens",
      );
      if ([input, output, cacheCreate, cacheRead].every((v) => v != null)) {
        const pillars = {
          input: Number(input),
          output: Number(output),
          cacheCreate: Number(cacheCreate),
          cacheRead: Number(cacheRead),
        };
        if (
          [
            pillars.input,
            pillars.output,
            pillars.cacheCreate,
            pillars.cacheRead,
          ].some((v) => !Number.isFinite(v))
        )
          throw new Error(
            "Non-numeric pillar value in JSON (got string or non-finite number).",
          );
        if (
          [
            pillars.input,
            pillars.output,
            pillars.cacheCreate,
            pillars.cacheRead,
          ].some((v) => v < 0)
        )
          pw.push(
            "negative_pillar: one or more pillars is negative — may be a data error",
          );
        if (pw.length > 0) pillars._parseWarnings = pw;
        return pillars;
      }
    }
  } catch (e) {
    // JSON.parse syntax error — fall through to positional. Re-throw parse errors we raised ourselves.
    if (e.message.startsWith("Non-numeric")) throw e;
  }

  // ── Positional path ────────────────────────────────────────────────────────
  // Guard: if the text contains alphabetic words, the numeric extraction is unreliable.
  // We still attempt it (don't throw away the data) but flag it for review.
  if (/[a-zA-Z]/.test(t))
    pw.push(
      "positional_from_mixed_text: extracted numbers from text that contains alphabetic characters — verify these are the correct 4 pillars",
    );

  const nums = (t.match(/-?\d[\d,]*\.?\d*/g) || []).map((s) =>
    Number(s.replace(/,/g, "")),
  );
  if (nums.length >= 4) {
    const [input, output, cacheCreate, cacheRead] = nums;
    if (nums.length > 4)
      pw.push(
        `positional_extra_numbers: found ${nums.length} numbers, using first 4 — inspect for positional order error`,
      );
    const pillars = { input, output, cacheCreate, cacheRead };
    if ([input, output, cacheCreate, cacheRead].some((v) => v < 0))
      pw.push(
        "negative_pillar: one or more pillars is negative — may be a data error",
      );
    if (pw.length > 0) pillars._parseWarnings = pw;
    return pillars;
  }
  throw new Error(
    "Could not parse 4 token pillars (input, output, cacheCreate, cacheRead) from the input.",
  );
}
