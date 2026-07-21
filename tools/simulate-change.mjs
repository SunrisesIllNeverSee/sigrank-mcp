/**
 * tools/simulate-change.mjs — simulate_change tool.
 */

import { cascade, parsePillars } from "../analytics/cascade.mjs";
import { SIMULATE_OUTPUT, ANNOTATIONS } from "./_schemas.mjs";
import { MAX_INPUT, withParseWarnings } from "./_helpers.mjs";

export const TOOL_DEF = {
  name: "simulate_change",
  description:
    "The first PRESCRIPTIVE SigRank tool — 'what if I changed my token mix?' Takes your current 4 pillars (input/output/cacheCreate/cacheRead) and one or more proposed changes, runs the canonical cascade on BOTH the current and simulated values, and returns the exact Υ Yield delta, class change, and per-metric diffs. This is the 'show me the payoff before I do the work' primitive: no network, no submission, pure local math. Use it to answer 'would increasing my cache-read by 50k tokens actually move my class?' before you change your workflow. Accepts the current pillars as JSON or 4 numbers (same as rank_paste) plus a `changes` object with any of the 4 pillar names mapped to new absolute values OR relative deltas (e.g. {cacheRead: '+50000'} or {input: 800000}).",
  annotations: {
    title: "Simulate metric change",
    ...ANNOTATIONS.readOnlyHint,
    ...ANNOTATIONS.idempotentHint,
    ...ANNOTATIONS.openWorldHint,
  },
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description:
          'Current token pillars — ccusage JSON or "input output cacheCreate cacheRead" (same format as rank_paste).',
      },
      changes: {
        type: "object",
        description:
          "Proposed changes to apply. Keys: input, output, cacheCreate, cacheRead. Values are either absolute numbers (replace) or strings starting with +/- for relative deltas (add/subtract). Omitted pillars are unchanged.",
        properties: {
          input: {
            type: ["number", "string"],
            description:
              'new input token count (absolute) or "+/-N" for a relative delta',
          },
          output: {
            type: ["number", "string"],
            description:
              'new output token count (absolute) or "+/-N" for a relative delta',
          },
          cacheCreate: {
            type: ["number", "string"],
            description:
              'new cache-create token count (absolute) or "+/-N" for a relative delta',
          },
          cacheRead: {
            type: ["number", "string"],
            description:
              'new cache-read token count (absolute) or "+/-N" for a relative delta',
          },
        },
      },
    },
    required: ["text", "changes"],
  },
  outputSchema: SIMULATE_OUTPUT,
};

export async function handleSimulateChange(args) {
  // The first prescriptive tool — "what if I changed my token mix?"
  // Pure local math: parse current pillars, apply proposed changes, run the
  // cascade on both, return the delta. No network, no submission.
  if (!args?.text)
    throw new Error(
      "simulate_change requires a non-empty `text` argument (current pillars).",
    );
  if (typeof args.text === "string" && args.text.length > MAX_INPUT) {
    return {
      status: "error",
      reason: "input_too_large",
      detail: `text exceeds ${MAX_INPUT} chars.`,
    };
  }
  if (!args?.changes || typeof args.changes !== "object") {
    throw new Error(
      "simulate_change requires a `changes` object with at least one pillar change.",
    );
  }

  const currentPillars = parsePillars(args.text);
  const current = withParseWarnings(currentPillars, cascade(currentPillars));

  // Apply changes: each pillar is either an absolute number (replace) or a
  // string starting with +/- (relative delta). Omitted pillars are unchanged.
  const PILLAR_KEYS = ["input", "output", "cacheCreate", "cacheRead"];
  const simulated = { ...currentPillars };
  const appliedChanges = {};

  for (const key of PILLAR_KEYS) {
    if (args.changes[key] == null) continue;
    const raw = args.changes[key];
    let newVal;

    if (typeof raw === "number") {
      newVal = raw;
    } else if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed.startsWith("+") || trimmed.startsWith("-")) {
        // Relative delta: add/subtract from current value
        const delta = Number(trimmed);
        if (!Number.isFinite(delta)) {
          return {
            status: "error",
            reason: "invalid_change",
            detail: `changes.${key}: "${raw}" is not a valid relative delta.`,
          };
        }
        newVal = currentPillars[key] + delta;
      } else {
        // Absolute value as a string
        newVal = Number(trimmed);
      }
    } else {
      return {
        status: "error",
        reason: "invalid_change",
        detail: `changes.${key}: expected number or string, got ${typeof raw}.`,
      };
    }

    if (!Number.isFinite(newVal)) {
      return {
        status: "error",
        reason: "invalid_change",
        detail: `changes.${key}: result is not a finite number.`,
      };
    }
    // Clamp to non-negative — token counts can't be negative
    if (newVal < 0) {
      return {
        status: "error",
        reason: "invalid_change",
        detail: `changes.${key}: result ${newVal} is negative — token counts must be >= 0.`,
      };
    }

    simulated[key] = newVal;
    appliedChanges[key] = {
      from: currentPillars[key],
      to: newVal,
      delta: newVal - currentPillars[key],
    };
  }

  if (Object.keys(appliedChanges).length === 0) {
    return {
      status: "error",
      reason: "no_changes",
      detail: "No pillar changes specified in the `changes` object.",
    };
  }

  const simulatedResult = cascade(simulated);

  // Compute deltas for every cascade metric
  const metricDelta = (curr, sim) => {
    if (curr == null && sim == null) return null;
    if (curr == null) return { from: null, to: sim, delta: null };
    if (sim == null) return { from: curr, to: null, delta: null };
    return { from: curr, to: sim, delta: Number((sim - curr).toFixed(4)) };
  };

  const classChanged = current.class !== simulatedResult.class;

  return {
    current: {
      pillars: currentPillars,
      yield: current.yield,
      snr: current.snr,
      leverage: current.leverage,
      velocity: current.velocity,
      dev10x: current.dev10x,
      class: current.class,
    },
    simulated: {
      pillars: {
        input: simulated.input,
        output: simulated.output,
        cacheCreate: simulated.cacheCreate,
        cacheRead: simulated.cacheRead,
      },
      yield: simulatedResult.yield,
      snr: simulatedResult.snr,
      leverage: simulatedResult.leverage,
      velocity: simulatedResult.velocity,
      dev10x: simulatedResult.dev10x,
      class: simulatedResult.class,
    },
    changes: appliedChanges,
    deltas: {
      yield: metricDelta(current.yield, simulatedResult.yield),
      snr: metricDelta(current.snr, simulatedResult.snr),
      leverage: metricDelta(current.leverage, simulatedResult.leverage),
      velocity: metricDelta(current.velocity, simulatedResult.velocity),
      dev10x: metricDelta(current.dev10x, simulatedResult.dev10x),
    },
    class_changed: classChanged,
    ...(classChanged
      ? { class_transition: `${current.class} → ${simulatedResult.class}` }
      : {}),
    ...(simulatedResult.warnings
      ? { simulated_warnings: simulatedResult.warnings }
      : {}),
    note: "Local simulation only — no submission. The actual score depends on server-side RS.xx weights and class thresholds.",
  };
}
