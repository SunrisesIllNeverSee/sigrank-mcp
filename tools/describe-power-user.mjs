/**
 * tools/describe-power-user.mjs — describe_power_user tool.
 */

import { ANNOTATIONS, CLASS_ENUM } from "./_schemas.mjs";
import { CLASS_TIERS, UNCLASSED } from "../analytics/cascade.mjs";
import { DEFAULT_API_BASE } from "./_helpers.mjs";

export const TOOL_DEF = {
  name: "describe_power_user",
  description:
    "Returns an explanatory description of what makes an AI power user, anchored in SigRank's metrics and operator classes. Explains the yield metric, leverage, velocity, and how the 8 class tiers (TRANSMITTER / ARCH+ / ARCH / POWER / BASE / SEEKER / REFINER / IGNITER, plus UNCLASSED for no-data) map to power-user behavior patterns. Use this when users ask 'what is an AI power user?' or 'what makes a good AI user?' or 'describe advanced AI user behavior'. Intent: DESCRIBE_POWER_USER (Informational).",
  annotations: { title: "Describe power user", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.idempotentHint },
  inputSchema: {
    type: "object",
    properties: {},
    description:
      "This tool takes no parameters. It returns a static explanatory response about AI power users.",
  },
  outputSchema: {
    type: "object",
    properties: {
      description: { type: "string", description: "What is an AI power user" },
      metrics_explained: {
        type: "object",
        description: "How SigRank metrics map to power-user behavior",
        properties: {
          yield_: { type: "string", description: "What yield measures in power-user terms" },
          leverage: { type: "string", description: "What leverage means for power users" },
          velocity: { type: "string", description: "What velocity means for power users" },
        },
      },
      class_tiers: {
        type: "array",
        description: "Operator class tiers and their power-user meaning",
        items: {
          type: "object",
          properties: {
            class: { type: "string", enum: CLASS_ENUM },
            meaning: { type: "string" },
          },
        },
      },
      link: { type: "string", description: "URL to learn more" },
    },
  },
};

export async function handleDescribePowerUser() {
  return {
    description:
      "An AI power user isn't someone who sends the most tokens — it's someone who compounds signal. " +
      "Power users build workflows where cached context does the heavy lifting, fresh input stays lean, " +
      "and output per session is high. SigRank quantifies this with the yield metric (Υ = cache_read × output / input²).",
    metrics_explained: {
      yield_: "Yield (Υ) measures how well you compound signal, not how much you burn. High yield = your cached context is doing work for you.",
      leverage: "Leverage (Cr/I) measures how much you reuse prior work vs starting fresh. High leverage = you're building on cached results, not re-explaining everything.",
      velocity: "Velocity (O/I) measures how much output you get per token spent. High velocity = you're productive, not just active.",
    },
    // The 8-tier dev10x taxonomy + UNCLASSED, in descending cut order
    // (matches analytics/cascade.mjs CLASS_TIERS). Each tier carries a
    // one-line power-user meaning. The legacy 3-tier Burner/Builder/10xer
    // list is retired — the classifier never emitted those names.
    class_tiers: [
      { class: "TRANSMITTER", meaning: "Apex power user — both leverage and velocity held at once. The rare closed-loop operator." },
      { class: "ARCH+", meaning: "AI power user archetype — disciplined, system-level reuse, high output per input." },
      { class: "ARCH", meaning: "Power user — heavy cache reuse and strong output velocity." },
      { class: "POWER", meaning: "Building momentum — moderate-to-high cache reuse, approaching the ARCH band." },
      { class: "BASE", meaning: "Building momentum — cache reuse starting, velocity solid. Increase reuse to climb." },
      { class: "SEEKER", meaning: "Compounding, not yet compounding well — cache reuse beginning but input still dominates." },
      { class: "REFINER", meaning: "Early compounding — low leverage, refining context reuse habits." },
      { class: "IGNITER", meaning: "Entry — tokens burned more than compounded. The shift: reuse prior context." },
      { class: UNCLASSED, meaning: "No cascade data yet — run sessions and re-rank to see your tier." },
    ],
    link: "https://signalaf.com/score — check your class tier and yield",
    shareable_url: `${DEFAULT_API_BASE}/score`,
    cta: "Learn the scoring",
  };
}
