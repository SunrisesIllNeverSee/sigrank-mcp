/**
 * cascade.mjs — pure SigRank yield cascade (no deps, no transport).
 * Mirrors sigrank-app/lib/ingest/bridge.ts computeCascadeMetrics() so rank_paste
 * reproduces the canonical MO§ES Υ 18436.98 from its 4 raw token pillars.
 * Paper-and-pencil math, open by design; proprietary threshold cuts stay server-side.
 *
 * Degenerate-input policy (hardened):
 *   - Any pillar that collapses a denominator (i=0, o=0, cw=0, cr=0) returns null for
 *     the affected metrics rather than Infinity/NaN.
 *   - A `warnings[]` array is attached when any metric is null so callers can surface the
 *     reason without silently corrupting downstream calculations.
 *   - The cascade is NEVER thrown away — even partial results are useful for review/storage.
 *     Callers that require a fully-formed result should check `warnings.length === 0`.
 */

export const round = (n, d) =>
  Number.isFinite(n) ? Number(n.toFixed(d)) : null;

/** The four raw token pillars → the cascade. */
export function cascade({ input, output, cacheCreate, cacheRead }) {
  const i = Number(input),
    o = Number(output),
    cw = Number(cacheCreate),
    cr = Number(cacheRead);
  const total = i + o + cw + cr;
  const warnings = [];

  // SNR: undefined when both i and o are 0 (empty session)
  const snrDenom = i + o;
  const snr = snrDenom > 0 ? o / snrDenom : null;
  if (snr === null) warnings.push("snr_undefined: input+output=0");

  // velocity: undefined when i=0 (no fresh input — pure cache-only session)
  const velocity = i > 0 ? o / i : null;
  if (velocity === null) warnings.push("velocity_undefined: input=0");

  // leverage: undefined when i=0
  const leverage = i > 0 ? cr / i : null;
  if (leverage === null) warnings.push("leverage_undefined: input=0");

  // Υ = leverage × velocity = (Cr·O)/I² — null when either component is null
  const yield_ =
    leverage !== null && velocity !== null ? leverage * velocity : null;
  if (yield_ === null && !warnings.some((w) => w.startsWith("yield")))
    warnings.push("yield_undefined: requires input>0");

  // dev10x = log10(Cr/I) — collapses when cw=0 (no cache commits) or i=0 or cr=0.
  // narrate.mjs already has a nonCompounding branch for this case; we return null
  // explicitly so the branch triggers correctly (vs -Infinity on log10(0)).
  let dev10x = null;
  if (i > 0 && o > 0 && cw > 0 && cr > 0) {
    dev10x = Math.log10((o / i) * (cw / o) * (cr / cw)); // = log10(Cr/I)
  } else {
    warnings.push("dev10x_undefined: requires all four pillars > 0");
  }

  const result = {
    pillars: { input: i, output: o, cacheCreate: cw, cacheRead: cr, total },
    yield: round(yield_, 2),
    snr: round(snr, 4),
    leverage: round(leverage, 1),
    velocity: round(velocity, 3),
    dev10x: round(dev10x, 2),
    class: classify(yield_, dev10x),
    mode: detectMode({ input: i, output: o, cacheCreate: cw, cacheRead: cr }),
  };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}

/** MVP class tiering from Υ + 10xDEV (canon assigns from cascade SNR + 10xDEV; this
 *  is the open-MVP approximation — proprietary threshold cuts stay server-side). */
export function classify(yieldVal, dev10x) {
  if (yieldVal >= 1000 || dev10x >= 3) return "TRANSMITTER";
  if (dev10x >= 1.45) return "ARCH+";
  if (dev10x >= 1.35) return "ARCH";
  if (dev10x >= 1.2) return "POWER";
  if (dev10x >= 1.0) return "BASE";
  if (dev10x >= 0) return "SEEKER";
  if (dev10x >= -0.3) return "REFINER";
  return "IGNITER";
}

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
