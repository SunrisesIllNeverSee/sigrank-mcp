/**
 * tools/describe-power-user.mjs — describe_power_user tool.
 */

import { ANNOTATIONS } from "./_schemas.mjs";
import { DEFAULT_API_BASE } from "./_helpers.mjs";

export const TOOL_DEF = {
  name: "describe_power_user",
  description:
    "Returns an explanatory description of what makes an AI power user, anchored in SigRank's metrics and operator classes. Explains the yield metric, leverage, velocity, and how class tiers (Burner/Builder/10xer) map to power-user behavior patterns. Use this when users ask 'what is an AI power user?' or 'what makes a good AI user?' or 'describe advanced AI user behavior'. Intent: DESCRIBE_POWER_USER (Informational).",
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
            class: { type: "string", enum: ["Burner", "Builder", "10xer"] },
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
    class_tiers: [
      { class: "10xer", meaning: "AI power user archetype — disciplined, system-level reuse, high output per input. Leverage > 10×, high velocity." },
      { class: "Builder", meaning: "Building momentum — moderate cache reuse, approaching power-user patterns. Growing leverage and velocity." },
      { class: "Burner", meaning: "Early-stage — tokens burned more than compounded. Low leverage, low velocity. The shift: reuse prior context." },
    ],
    link: "https://signalaf.com/score — check your class tier and yield",
    shareable_url: `${DEFAULT_API_BASE}/score`,
    cta: "Learn the scoring",
  };
}
