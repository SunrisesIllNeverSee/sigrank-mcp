/**
 * tools/discover-peers.mjs — discover_peers tool.
 *
 * Finds mentors, peers, and complementary operators for YOUR operator on the
 * SigRank leaderboard. Uses the enrolled device identity (ensureIdentity) so
 * the operator's agent doesn't need to pass a codename — it knows who you are.
 *
 * This is the "make connections" piece of the agent workflow loop:
 *   enroll → submit_verified → discover_peers → self_improve → submit again
 *
 * Fetches the operator's profile + the full leaderboard from signalaf.com's
 * public API, then runs pure client-side peer-matching logic:
 *   - Mentors: 1-2 class tiers above, ranked by cascade shape similarity
 *   - Peers: same class tier, ranked by yield proximity
 *   - Complementary: operators whose strength maps to your weakness
 *
 * For each mentor, computes the pillar delta — the specific token difference
 * that explains the yield gap (e.g. "12× your cache reads").
 */

import { ensureIdentity } from "../identity/keystore.mjs";
import { ANNOTATIONS } from "./_schemas.mjs";
import { DEFAULT_API_BASE } from "./_helpers.mjs";
import {
  findMentors,
  findPeers,
  findComplementary,
  peerSummary,
  tierRank,
} from "./_peer-matching.mjs";
import { LEADERBOARD_METRIC } from "../lib/constants.mjs";

export const TOOL_DEF = {
  name: "discover_peers",
  description:
    "Discovers mentors, peers, and complementary operators for YOUR operator on the SigRank leaderboard. Uses your enrolled device identity — no codename needed. Finds operators you should learn from: (1) Mentors — 1-2 class tiers above you with similar cascade shapes, including the specific pillar delta that explains the yield gap (e.g. '12× your cache reads'). (2) Peers — same class tier, ranked by yield proximity. (3) Complementary — operators whose strength is your weakness. Use this after submit_verified to find who to learn from, then chain into self_improve with the mentor's pillar deltas as context. Requires enrollment (npx sigrank-mcp enroll). Intent: DISCOVER_PEERS.",
  annotations: {
    title: "Discover peers and mentors",
    ...ANNOTATIONS.readOnlyHint,
    ...ANNOTATIONS.openWorldHint,
  },
  inputSchema: {
    type: "object",
    properties: {
      platform: {
        type: "string",
        description:
          "Filter peers by platform (default: your operator's primary platform). Use 'all' to search across all platforms.",
      },
      n: {
        type: "integer",
        description:
          "Number of operators to return per category (default: 5, max: 20).",
        minimum: 1,
        maximum: 20,
      },
    },
    description:
      "Optional: platform filter and result count. Uses your enrolled identity to determine your operator.",
  },
  outputSchema: {
    type: "object",
    properties: {
      your_profile: {
        type: "object",
        description: "Your operator's current profile on the board",
        properties: {
          codename: { type: "string" },
          class_tier: { type: "string" },
          platform: { type: "string" },
          yield_: { type: "number" },
          leverage: { type: "number" },
          velocity: { type: "number" },
          rank: { type: "integer" },
        },
      },
      mentors: {
        type: "array",
        description:
          "Operators 1-2 class tiers above you with similar cascade shapes, including pillar deltas",
      },
      peers: {
        type: "array",
        description: "Operators in your class tier, ranked by yield proximity",
      },
      complementary: {
        type: "array",
        description: "Operators whose strength maps to your weakness",
      },
      summary: { type: "string", description: "One-line summary of findings" },
      cta: { type: "string" },
    },
  },
};

export async function handleDiscoverPeers(args, ctx) {
  const id = ctx.opts.identity || ensureIdentity();
  if (!id.codename) {
    return {
      status: "not_enrolled",
      detail:
        "Run `npx sigrank-mcp enroll` to bind this device first, then submit_verified to appear on the board.",
    };
  }

  const apiBase = ctx.apiBase || DEFAULT_API_BASE;
  const n = Math.min(20, Math.max(1, args?.n ?? 5));
  const platformFilter = args?.platform === "all" ? null : args?.platform;

  // Fetch the operator's profile and the full leaderboard in parallel.
  const [profile, board] = await Promise.all([
    ctx.fetchJson(`/api/v1/operators/${encodeURIComponent(id.codename)}`),
    ctx.fetchJson(`/api/v1/leaderboard?metric=${LEADERBOARD_METRIC}&limit=2000`),
  ]);

  // Find the operator's entry in the board (has raw token pillars + class_tier).
  const entries = board.entries || board.operators || board || [];
  const boardEntry = entries.find(
    (op) => op.codename?.toLowerCase() === id.codename?.toLowerCase(),
  );

  if (!boardEntry) {
    return {
      status: "not_on_board",
      codename: id.codename,
      detail:
        "You're enrolled but not on the leaderboard yet. Run submit_verified to publish your snapshots.",
      profile,
    };
  }

  // Merge profile + board entry (board entry has raw pillars, profile has
  // per-window breakdowns). Use board entry as the primary source since it
  // has the fields peer-matching needs.
  const operator = {
    ...boardEntry,
    ...profile,
    // Ensure board entry fields take precedence for peer-matching
    class_tier: boardEntry.class_tier || boardEntry.class || profile.class_tier,
    yield_: boardEntry.yield_ ?? profile.yield_,
    leverage: boardEntry.leverage ?? profile.leverage,
    velocity: boardEntry.velocity ?? profile.velocity,
    snr: boardEntry.snr ?? profile.snr,
    platform: boardEntry.platform || profile.platform,
  };

  const myTier = tierRank(operator.class_tier);
  if (myTier < 0) {
    // UNCLASSED — no class to match on. Return complementary only.
    const complementary = findComplementary(operator, entries, { n, apiBase, platform: platformFilter });
    return {
      your_profile: {
        codename: operator.codename,
        class_tier: operator.class_tier,
        platform: operator.platform,
        yield_: operator.yield_,
        leverage: operator.leverage,
        velocity: operator.velocity,
        rank: operator.rank,
      },
      mentors: [],
      peers: [],
      complementary,
      summary: `You're UNCLASSED — no class tier to match peers on. ${complementary.length} complementary operators found based on cascade dimensions. Submit more snapshots to get classified.`,
      cta: "Submit snapshots",
    };
  }

  const opts = { n, apiBase, platform: platformFilter };
  const mentors = findMentors(operator, entries, opts);
  const peers = findPeers(operator, entries, opts);
  const complementary = findComplementary(operator, entries, opts);

  // Add shareable URLs to mentors
  const mentorsWithUrls = mentors.map((m) => ({
    ...m,
    shareable_url: `${apiBase}/operator/${encodeURIComponent(m.codename)}`,
  }));

  const summary = peerSummary(operator, mentors, peers, complementary);

  return {
    your_profile: {
      codename: operator.codename,
      class_tier: operator.class_tier,
      platform: operator.platform,
      yield_: operator.yield_,
      leverage: operator.leverage,
      velocity: operator.velocity,
      rank: operator.rank,
    },
    mentors: mentorsWithUrls,
    peers,
    complementary,
    summary,
    cta: "Study their cascade",
  };
}
