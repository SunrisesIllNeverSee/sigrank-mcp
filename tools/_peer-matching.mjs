/**
 * tools/_peer-matching.mjs — pure peer-discovery logic for discover_peers.
 *
 * Shared between _02_sigrank-mcp (operator's agent, uses enrolled identity)
 * and _04_bestuser-router-mcp (marketing layer, takes codename arg). The
 * canonical version lives here; _04 vendors a copy.
 *
 * All functions are pure — no network, no side effects. They operate on
 * leaderboard entry objects as returned by the signalaf.com API:
 *   { codename, class_tier, platform, yield_, leverage, velocity, snr,
 *     input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
 *     rank, ... }
 *
 * Three categorization functions:
 *   findMentors     — operators 1-2 class tiers above, ranked by cascade shape similarity
 *   findPeers       — operators in the same class tier, ranked by yield proximity
 *   findComplementary — operators whose strength maps to the operator's weakness
 *
 * Plus pillar delta computation: the specific token difference that explains
 * the yield gap between an operator and a mentor.
 */

import { CLASS_TIERS, UNCLASSED, tierOf } from "../analytics/cascade.mjs";

/**
 * Class tier rank index (0 = ARCH+ top, 7 = IGNITER bottom, -1 = UNCLASSED).
 * Used to determine who is "above" an operator in the experience ladder.
 */
export function tierRank(klass) {
  const base = tierOf(klass);
  if (base === UNCLASSED || base == null) return -1;
  return CLASS_TIERS.indexOf(base);
}

/**
 * Normalize a cascade shape into a 3D vector for similarity comparison.
 * The three dimensions are the cascade ratios that define an operator's
 * "shape" independent of scale:
 *   - leverage (Cr/I): how much they reuse prior context
 *   - velocity (O/I): how much output they get per input token
 *   - snr (O/(I+O)): signal cleanliness
 *
 * Each is log-scaled and normalized to [0,1] so operators at different scales
 * can be compared by shape, not absolute magnitude. An operator with 100x
 * leverage and one with 1000x leverage have similar *shapes* — both are
 * high-leverage operators, just at different scales.
 */
export function cascadeShape(op) {
  const l = Number(op.leverage) || 0;
  const v = Number(op.velocity) || 0;
  const s = Number(op.snr) || 0;
  // Log-scale, clamp to [0,1]. Log thresholds chosen so typical ranges map well:
  //   leverage: 0-1000x → log1p(0)-log1p(1000) ≈ 0-6.9
  //   velocity: 0-10x   → log1p(0)-log1p(10)   ≈ 0-2.4
  //   snr:      0-1     → log1p(0)-log1p(1)    ≈ 0-0.69
  const norm = (val, max) => Math.min(1, Math.log1p(Math.max(0, val)) / Math.log1p(max));
  return [
    norm(l, 1000),
    norm(v, 10),
    norm(s, 1),
  ];
}

/**
 * Euclidean distance between two cascade shapes, normalized to [0,1].
 * 0 = identical shape, 1 = maximally different. Used to rank mentors:
 * closer shape = "they were where you are but scaled up."
 */
export function shapeDistance(opA, opB) {
  const a = cascadeShape(opA);
  const b = cascadeShape(opB);
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum / a.length);
}

/**
 * Similarity score = 1 - distance. Higher = more similar cascade shape.
 */
export function shapeSimilarity(opA, opB) {
  return 1 - shapeDistance(opA, opB);
}

/**
 * Compute the pillar delta between an operator and a mentor.
 * Returns the specific token differences that explain the yield gap,
 * expressed as both absolute tokens and multipliers.
 *
 *   { pillar, mentor_value, operator_value, multiplier, absolute_delta, explanation }
 *
 * The pillar with the largest yield impact is listed first. Since yield =
 * (cacheRead × output) / input², the impact ranking is:
 *   1. cache_read (linear multiplier in yield)
 *   2. input (quadratic denominator — reducing input has squared impact)
 *   3. output (linear multiplier in yield)
 *   4. cache_create (enables future cache reads — indirect)
 */
export function pillarDelta(operator, mentor) {
  const opI = Number(operator.input_tokens) || 0;
  const opO = Number(operator.output_tokens) || 0;
  const opCr = Number(operator.cache_read_tokens) || 0;
  const opCw = Number(operator.cache_creation_tokens) || 0;

  const mtI = Number(mentor.input_tokens) || 0;
  const mtO = Number(mentor.output_tokens) || 0;
  const mtCr = Number(mentor.cache_read_tokens) || 0;
  const mtCw = Number(mentor.cache_creation_tokens) || 0;

  const safeMult = (mt, op) => (op > 0 ? mt / op : mt > 0 ? Infinity : 1);
  const fmtMult = (m) => (m === Infinity ? "∞" : `${m.toFixed(1)}×`);

  const deltas = [
    {
      pillar: "cache_read",
      mentor_value: mtCr,
      operator_value: opCr,
      multiplier: safeMult(mtCr, opCr),
      absolute_delta: mtCr - opCr,
      explanation:
        opCr > 0
          ? `${fmtMult(safeMult(mtCr, opCr))} your cache reads — the strongest yield multiplier`
          : `You have no cache reads; mentor has ${mtCr.toLocaleString()} — this is the entire yield gap`,
    },
    {
      pillar: "input",
      mentor_value: mtI,
      operator_value: opI,
      multiplier: safeMult(mtI, opI),
      absolute_delta: mtI - opI,
      explanation:
        mtI < opI
          ? `${fmtMult(opI / mtI)} less input than you — input² is in the denominator, so leaner input has quadratic payoff`
          : `${fmtMult(safeMult(mtI, opI))} your input — they use more fresh tokens but compensate with cache reuse`,
    },
    {
      pillar: "output",
      mentor_value: mtO,
      operator_value: opO,
      multiplier: safeMult(mtO, opO),
      absolute_delta: mtO - opO,
      explanation: `${fmtMult(safeMult(mtO, opO))} your output — linear yield multiplier`,
    },
    {
      pillar: "cache_create",
      mentor_value: mtCw,
      operator_value: opCw,
      multiplier: safeMult(mtCw, opCw),
      absolute_delta: mtCw - opCw,
      explanation:
        opCw > 0
          ? `${fmtMult(safeMult(mtCw, opCw))} your cache writes — enables future cache reads`
          : `You have no cache writes; mentor has ${mtCw.toLocaleString()} — they're investing in future cache`,
    },
  ];

  // Sort by yield impact: cache_read first (strongest), then input (quadratic),
  // then output (linear), then cache_create (indirect).
  const order = { cache_read: 0, input: 1, output: 2, cache_create: 3 };
  deltas.sort((a, b) => order[a.pillar] - order[b.pillar]);

  return deltas;
}

/**
 * Find mentors: operators 1-2 class tiers above, ranked by cascade shape
 * similarity. These are operators who were where you are and broke through.
 *
 * @param {object} operator — the operator's leaderboard entry
 * @param {array} board — all leaderboard entries
 * @param {object} opts — { platform: string|null, n: number }
 * @returns {array} mentors sorted by similarity (descending)
 */
export function findMentors(operator, board, opts = {}) {
  const n = Math.min(20, Math.max(1, opts.n ?? 5));
  const myTier = tierRank(operator.class_tier || operator.class);
  if (myTier < 0) return []; // UNCLASSED — no mentors

  const myPlatform = operator.platform;

  return board
    .filter((op) => op.codename !== operator.codename)
    .filter((op) => {
      if (opts.platform && op.platform !== opts.platform) return false;
      if (!opts.platform && myPlatform && op.platform !== myPlatform) return false;
      return true;
    })
    .filter((op) => {
      const theirTier = tierRank(op.class_tier || op.class);
      // 1-2 tiers above (lower index = higher tier)
      return theirTier >= 0 && theirTier < myTier && theirTier >= myTier - 2;
    })
    .map((op) => ({
      ...op,
      similarity_score: Math.round(shapeSimilarity(operator, op) * 100) / 100,
      pillar_delta: pillarDelta(operator, op),
    }))
    .sort((a, b) => b.similarity_score - a.similarity_score)
    .slice(0, n);
}

/**
 * Find peers: operators in the same class tier (same base tier, any sub-stage),
 * ranked by yield proximity. These are your direct competitors.
 *
 * @param {object} operator
 * @param {array} board
 * @param {object} opts
 * @returns {array} peers sorted by yield proximity (ascending delta)
 */
export function findPeers(operator, board, opts = {}) {
  const n = Math.min(20, Math.max(1, opts.n ?? 5));
  const myTier = tierOf(operator.class_tier || operator.class);
  if (myTier === UNCLASSED || myTier == null) return [];

  const myPlatform = operator.platform;
  const myYield = Number(operator.yield_) || 0;

  return board
    .filter((op) => op.codename !== operator.codename)
    .filter((op) => {
      if (opts.platform && op.platform !== opts.platform) return false;
      if (!opts.platform && myPlatform && op.platform !== myPlatform) return false;
      return true;
    })
    .filter((op) => tierOf(op.class_tier || op.class) === myTier)
    .map((op) => ({
      codename: op.codename,
      class_tier: op.class_tier || op.class,
      yield_: op.yield_,
      leverage: op.leverage,
      velocity: op.velocity,
      platform: op.platform,
      rank: op.rank,
      yield_delta_from_you: Math.round((Number(op.yield_) || 0) - myYield),
      shareable_url: op.codename
        ? `${opts.apiBase || "https://signalaf.com"}/operator/${encodeURIComponent(op.codename)}`
        : null,
    }))
    .sort((a, b) => Math.abs(a.yield_delta_from_you) - Math.abs(b.yield_delta_from_you))
    .slice(0, n);
}

/**
 * Find complementary operators: those whose strongest dimension is the
 * operator's weakest. Surfaces operators whose strengths map to your gaps.
 *
 * Determines the operator's weakest cascade dimension (leverage, velocity, or
 * snr) relative to the board, then finds operators who are strongest in that
 * dimension.
 *
 * @param {object} operator
 * @param {array} board
 * @param {object} opts
 * @returns {array} complementary operators with strength/weakness annotation
 */
export function findComplementary(operator, board, opts = {}) {
  const n = Math.min(20, Math.max(1, opts.n ?? 5));
  const myPlatform = operator.platform;

  const filtered = board
    .filter((op) => op.codename !== operator.codename)
    .filter((op) => {
      if (opts.platform && op.platform !== opts.platform) return false;
      if (!opts.platform && myPlatform && op.platform !== myPlatform) return false;
      return true;
    });

  if (filtered.length === 0) return [];

  // Compute board averages for each dimension
  const avg = (key) =>
    filtered.reduce((s, op) => s + (Number(op[key]) || 0), 0) / filtered.length;

  const avgLeverage = avg("leverage");
  const avgVelocity = avg("velocity");
  const avgSnr = avg("snr");

  // Find the operator's weakest dimension (furthest below average)
  const myLeverage = Number(operator.leverage) || 0;
  const myVelocity = Number(operator.velocity) || 0;
  const mySnr = Number(operator.snr) || 0;

  const weaknesses = [
    { dimension: "leverage", value: myLeverage, avg: avgLeverage, gap: avgLeverage - myLeverage },
    { dimension: "velocity", value: myVelocity, avg: avgVelocity, gap: avgVelocity - myVelocity },
    { dimension: "snr", value: mySnr, avg: avgSnr, gap: avgSnr - mySnr },
  ].sort((a, b) => b.gap - a.gap); // largest gap first

  const weakest = weaknesses[0];

  // If the operator is above average in all dimensions, find the dimension
  // where they're closest to average (their "relatively weakest")
  const targetDimension = weakest.gap > 0 ? weakest.dimension : weaknesses[0].dimension;

  // Find operators strongest in that dimension
  return filtered
    .map((op) => ({
      codename: op.codename,
      class_tier: op.class_tier || op.class,
      yield_: op.yield_,
      platform: op.platform,
      rank: op.rank,
      strength_dimension: targetDimension,
      strength_value: Number(op[targetDimension]) || 0,
      your_weakness: {
        dimension: targetDimension,
        your_value: Number(operator[targetDimension]) || 0,
        board_average: Math.round(weakest.avg * 100) / 100,
      },
      shareable_url: op.codename
        ? `${opts.apiBase || "https://signalaf.com"}/operator/${encodeURIComponent(op.codename)}`
        : null,
    }))
    .sort((a, b) => b.strength_value - a.strength_value)
    .slice(0, n);
}

/**
 * Generate the summary line for discover_peers output.
 */
export function peerSummary(operator, mentors, peers, complementary) {
  const klass = operator.class_tier || operator.class || UNCLASSED;
  const platform = operator.platform || "all";
  const parts = [];

  parts.push(`You're ${klass} on ${platform}.`);

  if (mentors.length > 0) {
    const topMentor = mentors[0];
    const topDelta = topMentor.pillar_delta[0];
    parts.push(
      `${mentors.length} mentor${mentors.length > 1 ? "s" : ""} found — operators whose cascade shape is closest to yours but 1-2 tiers higher.`,
    );
    if (topDelta) {
      parts.push(`Key gap: ${topDelta.explanation.toLowerCase()}.`);
    }
  } else {
    const myTier = tierRank(klass);
    if (myTier === 0) {
      parts.push("You're at the top tier (ARCH+) — you are the mentor.");
    } else {
      parts.push("No mentors found in the 1-2 tier range above you.");
    }
  }

  if (peers.length > 0) {
    parts.push(`${peers.length} direct peer${peers.length > 1 ? "s" : ""} in the ${tierOf(klass)} tier.`);
  }

  if (complementary.length > 0) {
    const comp = complementary[0];
    parts.push(
      `Study ${comp.codename} for ${comp.strength_dimension} (${comp.strength_value.toFixed(1)} vs your ${(Number(operator[comp.strength_dimension]) || 0).toFixed(1)}).`,
    );
  }

  return parts.join(" ");
}
