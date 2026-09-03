/**
 * tools/describe-power-user.mjs — describe_power_user tool.
 */

import { ANNOTATIONS, CLASS_ENUM } from "./_schemas.mjs";
import { CLASS_TIERS, UNCLASSED } from "../analytics/cascade.mjs";
import { DEFAULT_API_BASE } from "./_helpers.mjs";

export const TOOL_DEF = {
  name: "describe_power_user",
  description:
    "Returns an explanatory description of what makes an AI power user, anchored in SigRank's metrics and operator classes. Explains the yield metric, leverage, velocity, and how the 8 experience tiers (ARCH+ / ARCH / POWER / BASE / SEEKER / REFINER / BEARER / IGNITER, each with 3 sub-stages I/II/III, plus UNCLASSED for no-data) map to power-user behavior patterns. Use this when users ask 'what is an AI power user?' or 'what makes a good AI user?' or 'describe advanced AI user behavior'. Intent: DESCRIBE_POWER_USER (Informational).",
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
      velocity: "Velocity (O/I) measures how much output you get per token spent. High velocity = you're efficient, not just active.",
    },
    // The 8 base tiers + UNCLASSED, in descending cut order (matches
    // analytics/cascade.mjs CLASS_TIERS). Each tier has 3 sub-stages (I/II/III)
    // — 24 stages total. TRANSMITTER is a peak badge, not a class.
    class_tiers: [
      { class: "ARCH+", sub_stages: ["ARCH+ I", "ARCH+ II", "ARCH+ III"], meaning: "Deepest field experience — volume that became architecture. The AI power user archetype." },
      { class: "ARCH", sub_stages: ["ARCH I", "ARCH II", "ARCH III"], meaning: "System builder — sustained volume, coherent output, heavy cache reuse." },
      { class: "POWER", sub_stages: ["POWER I", "POWER II", "POWER III"], meaning: "Above the center — volume compounding, building momentum." },
      { class: "BASE", sub_stages: ["BASE I", "BASE II", "BASE III"], meaning: "The center of the field — the average operator's experience. Building momentum." },
      { class: "SEEKER", sub_stages: ["SEEKER I", "SEEKER II", "SEEKER III"], meaning: "Approaching the center — experience accumulating, reuse patterns forming." },
      { class: "REFINER", sub_stages: ["REFINER I", "REFINER II", "REFINER III"], meaning: "Practicing with purpose — early sustained volume, refining context reuse." },
      { class: "BEARER", sub_stages: ["BEARER I", "BEARER II", "BEARER III"], meaning: "Quiet accumulation — the first real volume. Session continuity starting." },
      { class: "IGNITER", sub_stages: ["IGNITER I", "IGNITER II", "IGNITER III"], meaning: "Entry — dormant potential. First sessions, minimal accumulated volume." },
      { class: UNCLASSED, sub_stages: null, meaning: "No cascade data yet — run sessions and re-rank to see your tier." },
    ],
    link: "https://signalaf.com/score — check your class tier and yield",
    shareable_url: `${DEFAULT_API_BASE}/score`,
    cta: "Learn the scoring",
  };
}
