/**
 * tools/compare-operators.mjs — compare_operators tool.
 */

import { COMPARE_OPERATORS_OUTPUT, ANNOTATIONS } from "./_schemas.mjs";
import { _behavioralFraming, _classMeaning, _competitiveLayer } from "./_framing.mjs";

export const TOOL_DEF = {
  name: "compare_operators",
  description:
    "Compares two operators side-by-side with a behavioral verdict. Fetches both profiles from the board and returns their yield, leverage, velocity, class, and rank side-by-side, plus a verdict explaining who is more efficient and why in power-user language. Use this when users ask 'compare operator X vs Y' or 'who is more efficient' or 'how do two AI users compare'. Intent: COMPARE_OPERATORS.",
  annotations: { title: "Compare two operators", ...ANNOTATIONS.readOnlyHint, ...ANNOTATIONS.openWorldHint },
  inputSchema: {
    type: "object",
    properties: {
      codename_a: {
        type: "string",
        description:
          "First operator's codename from the SigRank leaderboard. Case-insensitive.",
      },
      codename_b: {
        type: "string",
        description:
          "Second operator's codename from the SigRank leaderboard. Case-insensitive.",
      },
    },
    required: ["codename_a", "codename_b"],
    description:
      "Requires both codenames. Both must exist on the board.",
  },
  outputSchema: COMPARE_OPERATORS_OUTPUT,
};

export async function handleCompareOperators(args, ctx) {
  const nameA = String(args?.codename_a || "").trim();
  const nameB = String(args?.codename_b || "").trim();
  if (!nameA || !nameB)
    throw new Error(
      "compare_operators requires both `codename_a` and `codename_b`.",
    );

  const [opA, opB, board] = await Promise.all([
    ctx.fetchJson(`/api/v1/operators/${encodeURIComponent(nameA)}`),
    ctx.fetchJson(`/api/v1/operators/${encodeURIComponent(nameB)}`),
    ctx.fetchJson("/api/v1/leaderboard?metric=yield_"),
  ]);

  const yieldA = opA.yield_ || 0;
  const yieldB = opB.yield_ || 0;
  const delta = yieldA - yieldB;

  const winner = yieldA > yieldB ? opA : opB;
  const loser = yieldA > yieldB ? opB : opA;
  const verdict = `${winner.codename} is more token-efficient (${winner.yield_?.toLocaleString?.() || winner.yield_} vs ${loser.yield_?.toLocaleString?.() || loser.yield_} Υ). ${_behavioralFraming(winner)} ${loser.codename} ${_classMeaning(loser.class).toLowerCase()}`;

  return {
    operator_a: {
      codename: opA.codename,
      yield_: opA.yield_,
      leverage: opA.leverage,
      velocity: opA.velocity,
      class: opA.class,
      rank: opA.rank,
      competitive: _competitiveLayer(opA, board),
    },
    operator_b: {
      codename: opB.codename,
      yield_: opB.yield_,
      leverage: opB.leverage,
      velocity: opB.velocity,
      class: opB.class,
      rank: opB.rank,
      competitive: _competitiveLayer(opB, board),
    },
    verdict,
    yield_delta: delta,
    cta: "Compare me to others",
  };
}
