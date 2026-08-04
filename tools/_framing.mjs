/**
 * tools/_framing.mjs — behavioral framing helpers for intent-based tools.
 *
 * Power-user language + competitive layer shared by get_best_operator,
 * compare_self, compare_operators, and optimize_efficiency.
 *
 * Class-tier language is keyed off the canonical 8-tier dev10x taxonomy
 * (analytics/cascade.mjs CLASS_TIERS) + UNCLASSED. A prior version branched
 * on the legacy 3-tier Burner/Builder/10xer names, which the cascade
 * classifier never emits — every operator was falling through to the
 * "Burner" branch and getting "you are not yet a power user" framing
 * regardless of their actual tier. The framing now groups the 8 tiers into
 * power-user bands (apex / high / mid / early / entry / no-data) and writes
 * one message per band.
 */

import { DEFAULT_API_BASE } from "./_helpers.mjs";
import { CLASS_TIERS, UNCLASSED, tierOf } from "../analytics/cascade.mjs";

/**
 * Map a class tier to a power-user band. The 8 experience tiers collapse into 5
 * behavioral bands + UNCLASSED so the framing stays short without writing 8
 * bespoke messages. Band order matches CLASS_TIERS cut order (descending).
 *
 *   ARCH+, ARCH           → high    (deep experience, power-user archetype)
 *   POWER, BASE           → mid     (building momentum)
 *   SEEKER, REFINER       → early   (accumulating volume, finding patterns)
 *   BEARER, IGNITER       → entry   (first volume, or dormant)
 *   UNCLASSED / unknown   → nodata
 */
const BAND = {
  "ARCH+": "high",
  ARCH: "high",
  POWER: "mid",
  BASE: "mid",
  SEEKER: "early",
  REFINER: "early",
  BEARER: "entry",
  IGNITER: "entry",
  [UNCLASSED]: "nodata",
};

/** Default fallback when a metrics object carries no class — UNCLASSED, not
 *  the legacy "Burner". Callers that did `metrics.class || "Burner"` were
 *  silently relabeling every no-data operator as the bottom legacy tier. */
export const FALLBACK_CLASS = UNCLASSED;

/** Map a class tier (full sub-stage string or base tier) to its power-user
 *  band. Exported so tool handlers can branch on band without re-deriving the
 *  tier→band mapping. Uses tierOf() to extract the base tier from sub-stage
 *  strings (e.g. "REFINER II" → "REFINER" → "early"). */
export function bandOf(klass) {
  return BAND[tierOf(klass)] ?? "nodata";
}

/**
 * Competitive layer for tool responses per SHARED_DESIGN_DECISIONS.md §3/§4/§5.
 * Every tool response that includes operator data must show:
 *   rank, percentile, class_tier, delta_from_average, delta_from_top, shareable_url
 * Response style: factual + competitive ("You rank #12 of 47 operators...")
 */
export function _competitiveLayer(op, board) {
  const allOps = Array.isArray(board?.operators || board)
    ? board.operators || board
    : [];
  const yields = allOps.map((o) => o.yield_ || 0).sort((a, b) => a - b);
  const yourYield = op.yield_ || 0;
  const total = allOps.length;

  // Rank: find operator's position (1-based)
  let rank = op.rank || null;
  if (!rank && total > 0) {
    const sorted = [...allOps].sort((a, b) => (b.yield_ || 0) - (a.yield_ || 0));
    const idx = sorted.findIndex((o) => o.codename === op.codename);
    rank = idx >= 0 ? idx + 1 : null;
  }

  // Percentile: % of operators with yield below this operator
  const percentile = total > 0
    ? Math.round((yields.filter((y) => y < yourYield).length / total) * 100)
    : 0;

  // Delta from average
  const avgYield = total > 0 ? yields.reduce((s, y) => s + y, 0) / total : 0;
  const deltaFromAvg = avgYield > 0
    ? { absolute: Math.round(yourYield - avgYield),
        percent: Math.round(((yourYield - avgYield) / avgYield) * 100) }
    : { absolute: 0, percent: 0 };

  // Delta from top operator
  const topYield = total > 0 ? Math.max(...yields) : 0;
  const deltaFromTop = topYield > 0
    ? { absolute: Math.round(topYield - yourYield),
        percent: Math.round(((topYield - yourYield) / topYield) * 100) }
    : { absolute: 0, percent: 0 };

  // Shareable URL
  const shareableUrl = op.codename && op.codename !== "you (local)"
    ? `${DEFAULT_API_BASE}/operator/${encodeURIComponent(op.codename)}`
    : null;

  return {
    rank,
    total_operators: total,
    percentile,
    class_tier: op.class || FALLBACK_CLASS,
    delta_from_average: deltaFromAvg,
    delta_from_top: deltaFromTop,
    shareable_url: shareableUrl,
  };
}

/** Factual + competitive summary line per SHARED_DESIGN_DECISIONS.md §4 */
export function _competitiveSummary(op, board) {
  const cl = _competitiveLayer(op, board);
  const parts = [];

  if (cl.rank && cl.total_operators > 0) {
    parts.push(`You rank #${cl.rank} of ${cl.total_operators} operators.`);
  }

  const topOp = (board?.operators || board || []).reduce(
    (best, o) => ((o.yield_ || 0) > (best?.yield_ || 0) ? o : best),
    null,
  );
  if (topOp && topOp.codename) {
    parts.push(`Top operator is ${topOp.codename} with Υ ${(topOp.yield_ || 0).toLocaleString()}.`);
  }

  if (cl.delta_from_average.percent !== 0) {
    const dir = cl.delta_from_average.percent > 0 ? "above" : "below";
    parts.push(`You're ${Math.abs(cl.delta_from_average.percent)}% ${dir} average.`);
  }

  if (cl.delta_from_top.percent > 0) {
    parts.push(`${cl.delta_from_top.percent}% below top.`);
  }

  return parts.join(" ");
}

export function _behavioralFraming(op) {
  const y = op.yield_ || 0;
  const l = op.leverage || 0;
  const v = op.velocity || 0;
  const klass = op.class || FALLBACK_CLASS;
  const band = bandOf(klass);

  if (band === "apex")
    return `Closed-loop operator: ${l.toFixed(1)}× leverage over fresh input with ${v.toFixed(2)} output velocity. Both axes held at once — the rare apex profile the leverage/velocity tradeoff says shouldn't exist.`;
  if (band === "high")
    return `Disciplined, system-level reuse: ${l.toFixed(1)}× leverage means heavy cache reuse over fresh input, ${v.toFixed(2)} velocity means more output per token spent. This is the AI power-user archetype.`;
  if (band === "mid")
    return `Building cascade momentum: moderate cache reuse (${l.toFixed(1)}× leverage) with ${v.toFixed(2)} output velocity. Approaching power-user patterns — increase cache reuse to push into the ARCH band.`;
  if (band === "early")
    return `Compounding, not yet compounding well: ${v.toFixed(2)} output velocity with ${l.toFixed(1)}× leverage. Cache reuse is starting but input still dominates. Reuse prior context (templates, prompts, workflows) to build leverage.`;
  if (band === "entry")
    return `Early-stage cascade: ${v.toFixed(2)} output velocity with ${l.toFixed(1)}× leverage. Tokens are being burned more than compounded. Focus on reusing prior context (templates, prompts, workflows) to build leverage.`;
  return `No cascade data yet — run a few sessions and re-rank to see your tier. Yield is computed from four token pillars (input, output, cacheCreate, cacheRead).`;
}

export function _powerUserAssessment(klass, metrics) {
  const l = metrics.leverage || 0;
  const v = metrics.velocity || 0;
  const band = bandOf(klass);

  if (band === "apex")
    return `You are an apex AI power user. Your SigRank class (${klass}) indicates you reuse prior work heavily (${l.toFixed(1)}× leverage), get more out of each token (${v.toFixed(2)} velocity), and keep input lean — both leverage and velocity held at once.`;
  if (band === "high")
    return `You are an AI power user. Your SigRank class (${klass}) indicates you reuse prior work heavily (${l.toFixed(1)}× leverage), get more out of each token (${v.toFixed(2)} velocity), and keep input lean. This is consistent with AI power-user behavior: iterative, efficient, multi-use patterns.`;
  if (band === "mid")
    return `You are becoming an AI power user. Your ${klass} class shows growing cache reuse (${l.toFixed(1)}× leverage) and ${v.toFixed(2)} output velocity. You're building the habits — increase context reuse to push into the ARCH band.`;
  if (band === "early")
    return `You are starting to compound. Your ${klass} class shows ${l.toFixed(1)}× leverage and ${v.toFixed(2)} velocity — cache reuse is beginning but input still dominates. The power-user shift: reuse prior context instead of starting fresh each time.`;
  if (band === "entry")
    return `You are not yet an AI power user. Your ${klass} class means tokens are being spent without compounding. The power-user shift: reuse prior context (prompts, templates, cached results) instead of starting fresh each time. Your leverage (${l.toFixed(1)}×) is the key metric to improve.`;
  return `No cascade data yet — your tier is ${UNCLASSED}. Run a few sessions, re-rank, and the assessment will reflect your actual leverage and velocity.`;
}

export function _classMeaning(klass) {
  const band = bandOf(klass);
  if (band === "apex")
    return "Apex power user — both leverage and velocity held at once. The rare closed-loop operator.";
  if (band === "high")
    return "AI power user archetype — disciplined, system-level reuse, high output per input.";
  if (band === "mid")
    return "Building momentum — moderate reuse, approaching power-user patterns.";
  if (band === "early")
    return "Compounding, not yet compounding well — cache reuse starting, input still dominates.";
  if (band === "entry")
    return "Early-stage — tokens burned more than compounded. Focus on cache reuse.";
  return "No data — run sessions and re-rank to see your tier.";
}

export function _improvementSuggestion(klass, metrics) {
  const l = metrics.leverage || 0;
  const v = metrics.velocity || 0;
  const band = bandOf(klass);

  if (band === "apex")
    return v < 1
      ? "Your leverage is exceptional but velocity is under 1.0 — you're reading more cache than producing output. Push for more output per session."
      : "You're at the apex. Maintain your cache architecture and experiment with longer sessions to compound yield further.";
  if (band === "high")
    return v < 1
      ? "Your leverage is excellent but velocity is under 1.0 — you're reading more cache than producing output. Push for more output per session."
      : "You're at the top tier. Maintain your cache architecture and experiment with longer sessions to compound yield further.";
  if (band === "mid")
    return l < 5
      ? "Increase cache reuse: reuse prompts, templates, and workflows instead of starting from scratch. Each reused token multiplies your yield."
      : "Your leverage is solid. Focus on output velocity — produce more per session to push your yield up.";
  if (band === "early")
    return "Start by reusing prior context. Instead of fresh prompts each time, build on cached results. Even a 2× increase in cache_read will dramatically improve your yield because input² is in the denominator.";
  if (band === "entry")
    return "Start by reusing prior context. Instead of fresh prompts each time, build on cached results. Even a 2× increase in cache_read will dramatically improve your yield because input² is in the denominator.";
  return "No cascade data yet. Run a few sessions so the four token pillars are populated, then re-rank for an actionable suggestion.";
}
