/**
 * narrate.mjs — deterministic prose "card" for a cascade result.
 *
 * Port of _template() from ~/Desktop/moses-sigrank/narrate.py. The model path
 * (MiniCPM4-0.5B) is intentionally SKIPPED: the template is the trustworthy,
 * instant, auditable fallback — same numbers in → same card out, and it can never
 * emit a metric the cascade didn't produce. A model hook can layer behind this same
 * narrate() interface later without a rewrite.
 *
 * Token-only. No network, no randomness.
 *
 * Updated to use the 10 build archetype system (replacing the 5-regime classifier).
 * Each archetype is defined by a different primary dimension of the token cascade:
 *   - leverage     = cache_read / input
 *   - velocity     = output / input
 *   - construction = cache_write / cache_read
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

// ── Build archetype thresholds ──────────────────────────────────────────────
// P80 thresholds calibrated from HCM cut (1,586 operators).
const CONVERGENT_T = { levP80: 74.6, velP80: 0.34, constrP80: 0.0431 };

const VEL_OUTPUT = 0.8;
const LEV_INPUT_LOW = 5;
const LEV_INPUT_HIGH = 10;
const LEV_READ_LOW = 15;
const LEV_READ_HIGH = 23;
const CONSTR_ACTIVE = 0.02;
const LEV_COMPOUND_LOW = 30;
const LEV_COMPOUND_HIGH = 50;

/** Classify an operator into one of 10 build archetypes. */
function buildArchetypeOf(lev, vel, constr, name) {
  // 1. CONVERGENT — P80 on all 3
  if (
    lev > CONVERGENT_T.levP80 &&
    vel > CONVERGENT_T.velP80 &&
    constr > CONVERGENT_T.constrP80
  ) {
    return {
      word: "convergent",
      blurb:
        `${name} is elite on all three axes — ${comma(lev, 0)}x leverage, ${plain(vel, 2)}x velocity, ` +
        `${plain(constr, 4)} construction. The rare operator who breaks the tradeoffs.`,
    };
  }

  // 2. KINETIC PRODUCER
  if (vel >= VEL_OUTPUT) {
    return {
      word: "kinetic producer",
      blurb:
        `${name} generates more than consumed — ${plain(vel, 2)}x output velocity. ` +
        `The engine of the field, converting input to output at high rate.`,
    };
  }

  // 3-4. Input types
  if (lev < LEV_INPUT_LOW) {
    return {
      word: "raw injector",
      blurb:
        `${name} injects raw input with barely any cache reuse (${plain(lev, 1)}x leverage). ` +
        `Tokens going in, not much coming back yet.`,
    };
  }
  if (lev < LEV_INPUT_HIGH) {
    return {
      word: "cache warming",
      blurb:
        `${name} is warming up — reuse is forming (${plain(lev, 1)}x leverage) but still shallow. ` +
        `Cache is starting to build, finding its rhythm.`,
    };
  }

  // 5-7. Cache read types (passive)
  if (constr < CONSTR_ACTIVE) {
    if (lev < LEV_READ_LOW) {
      return {
        word: "shallow reader",
        blurb:
          `${name} reads context moderately (${plain(lev, 1)}x leverage) but doesn't build new context. ` +
          `Passive consumption — holds lightly, generates little.`,
      };
    }
    if (lev < LEV_READ_HIGH) {
      return {
        word: "reader",
        blurb:
          `${name} holds context well (${plain(lev, 0)}x leverage) but executes little with it. ` +
          `Solid reuse, still passive.`,
      };
    }
    return {
      word: "archival",
      blurb:
        `${name} is an archival sponge — ${comma(lev, 0)}x reuse but only ${plain(vel, 2)}x generation. ` +
        `Holds everything, generates little. The context library is massive.`,
    };
  }

  // 8. Builder
  if (lev < LEV_COMPOUND_LOW) {
    return {
      word: "builder",
      blurb:
        `${name} is actively building new context (${plain(constr, 4)} construction ratio) ` +
        `with moderate reuse (${plain(lev, 1)}x leverage). Construction is happening.`,
    };
  }

  // 9-10. Compounder
  if (lev < LEV_COMPOUND_HIGH) {
    return {
      word: "recursive momentum",
      blurb:
        `${name} is building on built — the feedback loop. ${comma(lev, 0)}x leverage plus ` +
        `active construction (${plain(constr, 4)}). Compounding forward.`,
    };
  }
  return {
    word: "compound amplifier",
    blurb:
      `${name} runs the loop at scale — ${comma(lev, 0)}x leverage with active construction. ` +
      `Returns amplifying on returns. The context library is massive and still growing.`,
  };
}

/**
 * Given a cascade result ({ velocity, leverage, dev10x, pillars, class }) and an
 * optional subject name, return "**CLASS.** <one or two sentences>". Deterministic.
 */
export function narrate(cascade, name = "This operator") {
  const klass = cascade.class || cascade.klass || "UNCLASSED";
  const v = safeNum(cascade.velocity);
  const l = safeNum(cascade.leverage);

  // "non-compounding" = a stateless pipe: no cache commits, so the cascade can't
  // form. cascade.mjs leaves dev10x null when cacheCreate is 0 (the cw/o term
  // collapses), which is exactly metrics.py's non_compounding flag.
  // Also catches zero-input sessions where velocity/leverage are null.
  const cw = cascade.pillars ? Number(cascade.pillars.cacheCreate) : NaN;
  const cr = cascade.pillars ? Number(cascade.pillars.cacheRead) : NaN;
  const nonCompounding =
    cascade.dev10x == null || !(cw > 0) || v === null || l === null;

  let body;
  if (nonCompounding) {
    const leverageStr =
      l !== null
        ? `Leverage ${comma(l, 1)}x comes from reuse alone.`
        : "Leverage is undefined (no fresh input recorded).";
    const dev10xNote =
      cascade.dev10x == null
        ? " 10xDEV is undefined — the compounding loop has not formed yet."
        : "";
    body =
      `${name} runs a stateless pipe — no cache commits, so the cascade can't form. ` +
      `High read volume, but nothing is being built forward. ${leverageStr}${dev10xNote}`;
  } else {
    const vel = v ?? 0;
    const lev = l ?? 0;
    const constr = cr > 0 ? cw / cr : 0;
    const arch = buildArchetypeOf(lev, vel, constr, name);
    body = arch.blurb;
  }
  return `**${klass}.** ${body}`;
}
