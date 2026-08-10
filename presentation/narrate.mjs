/**
 * narrate.mjs — deterministic prose "card" for a cascade result.
 *
 * Uses the 10 build archetype composition classifier, synced with the app's
 * lib/analytics/build-archetypes.ts. Every operator lands in exactly one
 * archetype that describes their operating shape — not their rank.
 *
 * Classification precedence (first match wins):
 *   1. CONVERGENT   — P80+ on all 3 axes (leverage + velocity + construction)
 *   2. KINETIC      — velocity >= 0.80
 *   3. Construction  — construction >= 0.02 (BUILDER / RECURSIVE / AMPLIFIER)
 *   4. Reuse depth   — else (INPUT-BOUND / PRIMING / CONTEXTUAL / DEEP READER / ARCHIVIST)
 *
 * The three derived dimensions:
 *   leverage     = cache_read / input
 *   velocity     = output / input
 *   construction = cache_write / cache_read
 *
 * Token-only. No network, no randomness.
 */

// Safe formatters: never emit NaN/Infinity/undefined into the card.
const safeNum = (n) => (Number.isFinite(Number(n)) ? Number(n) : null);
const comma = (n, dec) => {
  const v = safeNum(n);
  return v !== null
    ? v.toLocaleString("en-US", {
        minimumFractionDigits: dec,
        maximumFractionDigits: dec,
      })
    : "—";
};
const plain = (n, dec) => {
  const v = safeNum(n);
  return v !== null ? v.toFixed(dec) : "—";
};

// P80 thresholds calibrated from HCM cut (1,586 operators).
const CONVERGENT_T = { levP80: 74.6, velP80: 0.34, constrP80: 0.0431 };
const VEL_KINETIC = 0.8;
const LEV_INPUT_BOUND = 5;
const LEV_PRIMING = 10;
const LEV_CONTEXTUAL = 15;
const LEV_DEEP_READER = 23;
const CONSTR_ACTIVE = 0.02;
const LEV_BUILDER = 30;
const LEV_RECURSIVE = 50;

/** Classify an operator's cascade into one of 10 build archetypes.
 *  Returns { key, name, family, familyLabel, blurb }. */
export function classifyArchetype(cascade) {
  const v = safeNum(cascade.velocity);
  const l = safeNum(cascade.leverage);
  const cw = cascade.pillars ? Number(cascade.pillars.cacheCreate) : NaN;
  const cr = cascade.pillars ? Number(cascade.pillars.cacheRead) : NaN;
  const input = cascade.pillars ? Number(cascade.pillars.input) : NaN;

  // Derive construction = cache_write / cache_read
  const constr = Number.isFinite(cr) && cr > 0 && Number.isFinite(cw) ? cw / cr : 0;
  const lev = l ?? 0;
  const vel = v ?? 0;

  // 1. CONVERGENT — all three axes elevated (P80+)
  if (
    lev > CONVERGENT_T.levP80 &&
    vel > CONVERGENT_T.velP80 &&
    constr > CONVERGENT_T.constrP80
  ) {
    return {
      key: "convergent",
      name: "CONVERGENT",
      family: "convergence",
      familyLabel: "Convergence",
      blurb:
        "Deep reuse, active construction, and high generation rise together. A rare composition where all three operating axes are elevated without the usual tradeoffs.",
    };
  }

  // 2. KINETIC — generation breakout
  if (vel >= VEL_KINETIC) {
    return {
      key: "kinetic",
      name: "KINETIC",
      family: "generation",
      familyLabel: "Generation",
      blurb:
        "Generation has broken out. Output approaches or exceeds fresh input, making transmission the defining feature of the composition.",
    };
  }

  // 3. Construction branch — active context construction
  if (constr >= CONSTR_ACTIVE) {
    if (lev >= LEV_RECURSIVE) {
      return {
        key: "amplifier",
        name: "AMPLIFIER",
        family: "construction",
        familyLabel: "Active Construction",
        blurb:
          "Deep reuse and active construction are operating together at scale. Existing context produces new work that expands the context available for future cycles.",
      };
    }
    if (lev >= LEV_BUILDER) {
      return {
        key: "recursive",
        name: "RECURSIVE",
        family: "construction",
        familyLabel: "Active Construction",
        blurb:
          "New context is being built on top of an already substantial reusable base. Construction and reuse are now feeding the same operating loop.",
      };
    }
    return {
      key: "builder",
      name: "BUILDER",
      family: "construction",
      familyLabel: "Active Construction",
      blurb:
        "Active context construction has begun. The system is creating material for future reuse while leverage is still developing.",
    };
  }

  // 4. Reuse depth branch — passive (construction < 0.02)
  if (lev >= LEV_DEEP_READER) {
    return {
      key: "archivist",
      name: "ARCHIVIST",
      family: "reuse",
      familyLabel: "Reuse Depth",
      blurb:
        "Extreme reuse of accumulated context. A deep context library carries the system while new construction remains limited.",
    };
  }
  if (lev >= LEV_CONTEXTUAL) {
    return {
      key: "deep-reader",
      name: "DEEP READER",
      family: "reuse",
      familyLabel: "Reuse Depth",
      blurb:
        "Strong accumulated context is carrying the workflow. The operator draws deeply from retained context while creating relatively little new context.",
    };
  }
  if (lev >= LEV_PRIMING) {
    return {
      key: "contextual",
      name: "CONTEXTUAL",
      family: "reuse",
      familyLabel: "Reuse Depth",
      blurb:
        "Retained context is now materially supporting the workflow. Reuse is established, while active construction remains limited.",
    };
  }
  if (lev >= LEV_INPUT_BOUND) {
    return {
      key: "priming",
      name: "PRIMING",
      family: "reuse",
      familyLabel: "Reuse Depth",
      blurb:
        "Reuse is beginning to form. Prior context is returning, but the system has not yet developed deep leverage.",
    };
  }
  return {
    key: "input-bound",
    name: "INPUT-BOUND",
    family: "reuse",
    familyLabel: "Reuse Depth",
    blurb:
      "Fresh input still carries most of the workload. Little prior context is returning, so each cycle depends heavily on new input.",
  };
}

/**
 * Given a cascade result ({ velocity, leverage, dev10x, pillars, class }) and an
 * optional subject name, return "**CLASS.** <archetype blurb with context>".
 * Deterministic — same numbers in → same card out.
 */
export function narrate(cascade, name = "This operator") {
  const klass = cascade.class || cascade.klass || "UNCLASSED";
  const v = safeNum(cascade.velocity);
  const l = safeNum(cascade.leverage);
  const cw = cascade.pillars ? Number(cascade.pillars.cacheCreate) : NaN;

  // Handle non-compounding (stateless pipe) as a special case before the
  // archetype classifier — cascade.mjs leaves dev10x null when cacheCreate is 0.
  const nonCompounding =
    cascade.dev10x == null || !(cw > 0) || v === null || l === null;

  if (nonCompounding) {
    const leverageStr =
      l !== null
        ? `Leverage ${comma(l, 1)}x comes from reuse alone.`
        : "Leverage is undefined (no fresh input recorded).";
    const dev10xNote =
      cascade.dev10x == null
        ? " 10xDEV is undefined — the compounding loop has not formed yet."
        : "";
    const body =
      `${name} runs a stateless pipe — no cache commits, so the cascade can't form. ` +
      `High read volume, but nothing is being built forward. ${leverageStr}${dev10xNote}`;
    return `**${klass}.** ${body}`;
  }

  // Classify into one of 10 build archetypes
  const arch = classifyArchetype(cascade);

  // Build the card with archetype name, family, and context-specific numbers
  const levStr = l !== null ? `${comma(l, 0)}x leverage` : "undefined leverage";
  const velStr = v !== null ? `${plain(v, 2)}x generation` : "undefined generation";
  const cr = cascade.pillars ? Number(cascade.pillars.cacheRead) : NaN;
  const constrStr = `construction ${plain(Number.isFinite(cr) && cr > 0 ? cw / cr : 0, 4)}`;

  const body =
    `${name} is ${arch.name} — ${arch.blurb} ` +
    `${levStr}, ${velStr}, ${constrStr}.`;

  return `**${klass}.** ${body}`;
}
