/**
 * __tests__/peer-matching.test.mjs — tests for the pure peer-matching logic.
 *
 * Uses node:test + assert (same pattern as _04's test suite). Tests the
 * pure functions in tools/_peer-matching.mjs with synthetic board data —
 * no network calls, no identity, no MCP server.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tierRank,
  cascadeShape,
  shapeSimilarity,
  pillarDelta,
  findMentors,
  findPeers,
  findComplementary,
  peerSummary,
} from "../tools/_peer-matching.mjs";

// ── Synthetic board data ────────────────────────────────────────────────────
// 5 operators across 3 class tiers on the same platform (claude).
const BOARD = [
  {
    codename: "Mentor Alpha",
    class_tier: "ARCH I",
    platform: "claude",
    yield_: 50000,
    leverage: 200,
    velocity: 1.5,
    snr: 0.8,
    input_tokens: 50000,
    output_tokens: 75000,
    cache_read_tokens: 10000000,
    cache_creation_tokens: 500000,
    rank: 1,
  },
  {
    codename: "Mentor Beta",
    class_tier: "ARCH II",
    platform: "claude",
    yield_: 45000,
    leverage: 180,
    velocity: 1.4,
    snr: 0.75,
    input_tokens: 60000,
    output_tokens: 84000,
    cache_read_tokens: 10800000,
    cache_creation_tokens: 600000,
    rank: 2,
  },
  {
    codename: "Peer Gamma",
    class_tier: "POWER II",
    platform: "claude",
    yield_: 12000,
    leverage: 50,
    velocity: 1.0,
    snr: 0.6,
    input_tokens: 100000,
    output_tokens: 100000,
    cache_read_tokens: 5000000,
    cache_creation_tokens: 200000,
    rank: 3,
  },
  {
    codename: "You",
    class_tier: "POWER II",
    platform: "claude",
    yield_: 10000,
    leverage: 40,
    velocity: 0.9,
    snr: 0.55,
    input_tokens: 120000,
    output_tokens: 108000,
    cache_read_tokens: 4800000,
    cache_creation_tokens: 180000,
    rank: 4,
  },
  {
    codename: "Peer Delta",
    class_tier: "POWER I",
    platform: "claude",
    yield_: 15000,
    leverage: 60,
    velocity: 1.1,
    snr: 0.65,
    input_tokens: 90000,
    output_tokens: 99000,
    cache_read_tokens: 5400000,
    cache_creation_tokens: 220000,
    rank: 5,
  },
  {
    codename: "Junior Epsilon",
    class_tier: "REFINER I",
    platform: "claude",
    yield_: 500,
    leverage: 5,
    velocity: 0.3,
    snr: 0.3,
    input_tokens: 500000,
    output_tokens: 150000,
    cache_read_tokens: 2500000,
    cache_creation_tokens: 100000,
    rank: 6,
  },
];

const YOU = BOARD.find((op) => op.codename === "You");

// ── Tests ────────────────────────────────────────────────────────────────────

test("tierRank returns correct index for each tier", () => {
  assert.equal(tierRank("ARCH+ I"), 0);
  assert.equal(tierRank("ARCH II"), 1);
  assert.equal(tierRank("POWER III"), 2);
  assert.equal(tierRank("BASE I"), 3);
  assert.equal(tierRank("SEEKER II"), 4);
  assert.equal(tierRank("REFINER I"), 5);
  assert.equal(tierRank("BEARER III"), 6);
  assert.equal(tierRank("IGNITER I"), 7);
  assert.equal(tierRank("UNCLASSED"), -1);
  assert.equal(tierRank(null), -1);
});

test("cascadeShape returns 3D normalized vector", () => {
  const shape = cascadeShape(YOU);
  assert.equal(shape.length, 3);
  assert.ok(shape.every((v) => v >= 0 && v <= 1), "all dimensions in [0,1]");
});

test("shapeSimilarity is 1 for identical shapes, <1 for different", () => {
  const selfSim = shapeSimilarity(YOU, YOU);
  assert.equal(selfSim, 1);
  const mentorSim = shapeSimilarity(YOU, BOARD[0]);
  assert.ok(mentorSim < 1, "similarity to different operator < 1");
  assert.ok(mentorSim >= 0, "similarity >= 0");
});

test("findMentors returns operators 1-2 tiers above, ranked by similarity", () => {
  const mentors = findMentors(YOU, BOARD, { n: 5 });
  assert.ok(mentors.length > 0, "should find mentors");
  // All mentors should be 1-2 tiers above POWER (index 2)
  for (const m of mentors) {
    const rank = tierRank(m.class_tier);
    assert.ok(rank >= 0 && rank < 2, `${m.codename} should be ARCH+ or ARCH tier`);
    assert.ok(rank >= 2 - 2, `${m.codename} should be within 2 tiers above`);
  }
  // Should be sorted by similarity (descending)
  for (let i = 1; i < mentors.length; i++) {
    assert.ok(
      mentors[i - 1].similarity_score >= mentors[i].similarity_score,
      "mentors should be sorted by similarity descending",
    );
  }
  // Each mentor should have pillar_delta
  assert.ok(mentors[0].pillar_delta, "mentor should have pillar_delta");
  assert.ok(mentors[0].pillar_delta.length === 4, "pillar_delta should have 4 pillars");
});

test("findMentors returns empty for ARCH+ (top tier)", () => {
  const archOp = BOARD[0]; // ARCH I
  const mentors = findMentors(archOp, BOARD, { n: 5 });
  // ARCH I is tier index 1, so ARCH+ (index 0) is 1 tier above — should find it
  // But our board has no ARCH+ operators, so this should be empty
  assert.equal(mentors.length, 0, "no ARCH+ operators in board → no mentors for ARCH I");
});

test("findMentors returns empty for UNCLASSED", () => {
  const unclassed = { ...YOU, class_tier: "UNCLASSED" };
  const mentors = findMentors(unclassed, BOARD, { n: 5 });
  assert.equal(mentors.length, 0);
});

test("findPeers returns same-tier operators, ranked by yield proximity", () => {
  const peers = findPeers(YOU, BOARD, { n: 5, apiBase: "https://signalaf.com" });
  // You is POWER II. Peer Gamma is also POWER II. Peer Delta is POWER I (different sub-tier but same base tier).
  assert.ok(peers.length > 0, "should find peers");
  for (const p of peers) {
    assert.equal(tierRank(p.class_tier), tierRank(YOU.class_tier), "peers should be same base tier");
    assert.notEqual(p.codename, "You", "should not include self");
  }
  // Should be sorted by yield proximity (ascending absolute delta)
  for (let i = 1; i < peers.length; i++) {
    assert.ok(
      Math.abs(peers[i - 1].yield_delta_from_you) <= Math.abs(peers[i].yield_delta_from_you),
      "peers should be sorted by yield proximity",
    );
  }
  // Should have shareable_url
  assert.ok(peers[0].shareable_url.includes("signalaf.com/operator/"));
});

test("findPeers returns empty for UNCLASSED", () => {
  const unclassed = { ...YOU, class_tier: "UNCLASSED" };
  const peers = findPeers(unclassed, BOARD, { n: 5 });
  assert.equal(peers.length, 0);
});

test("findComplementary finds operators strong in the operator's weakest dimension", () => {
  const comp = findComplementary(YOU, BOARD, { n: 5, apiBase: "https://signalaf.com" });
  assert.ok(comp.length > 0, "should find complementary operators");
  // You's leverage (40) is likely the weakest relative to board average
  // The first complementary operator should be strong in that dimension
  assert.ok(comp[0].strength_dimension, "should have strength_dimension");
  assert.ok(comp[0].your_weakness, "should have your_weakness");
  assert.ok(comp[0].shareable_url, "should have shareable_url");
  // Should be sorted by strength_value descending
  for (let i = 1; i < comp.length; i++) {
    assert.ok(
      comp[i - 1].strength_value >= comp[i].strength_value,
      "complementary should be sorted by strength descending",
    );
  }
});

test("pillarDelta computes correct multipliers", () => {
  const delta = pillarDelta(YOU, BOARD[0]); // You vs Mentor Alpha
  assert.equal(delta.length, 4);

  // cache_read should be first (order 0)
  assert.equal(delta[0].pillar, "cache_read");
  // Mentor Alpha has 10M cache reads, You has 4.8M → multiplier ≈ 2.1×
  assert.ok(delta[0].multiplier > 2, "cache_read multiplier should be > 2");
  assert.ok(delta[0].absolute_delta > 0, "mentor should have more cache reads");

  // input should be second (order 1)
  assert.equal(delta[1].pillar, "input");
  // Mentor Alpha has 50K input, You has 120K → mentor has LESS input
  assert.ok(delta[1].absolute_delta < 0, "mentor should have less input");
});

test("pillarDelta handles zero operator values", () => {
  const zeroOp = { ...YOU, cache_read_tokens: 0, cache_creation_tokens: 0 };
  const delta = pillarDelta(zeroOp, BOARD[0]);
  assert.equal(delta[0].multiplier, Infinity, "0 operator cache_read → ∞ multiplier");
});

test("peerSummary generates a meaningful summary", () => {
  const mentors = findMentors(YOU, BOARD, { n: 5 });
  const peers = findPeers(YOU, BOARD, { n: 5, apiBase: "https://signalaf.com" });
  const comp = findComplementary(YOU, BOARD, { n: 5, apiBase: "https://signalaf.com" });
  const summary = peerSummary(YOU, mentors, peers, comp);

  assert.ok(summary.includes("POWER II"), "summary should mention the class tier");
  assert.ok(summary.includes("claude"), "summary should mention the platform");
  assert.ok(summary.includes("mentor"), "summary should mention mentors");
});

test("findMentors respects platform filter", () => {
  const mixedBoard = [
    ...BOARD,
    {
      codename: "Other Platform Mentor",
      class_tier: "ARCH I",
      platform: "chatgpt",
      yield_: 50000,
      leverage: 200,
      velocity: 1.5,
      snr: 0.8,
      input_tokens: 50000,
      output_tokens: 75000,
      cache_read_tokens: 10000000,
      cache_creation_tokens: 500000,
      rank: 1,
    },
  ];
  const mentors = findMentors(YOU, mixedBoard, { n: 5, platform: "claude" });
  for (const m of mentors) {
    assert.equal(m.platform, "claude", "should only include same-platform mentors");
  }
});

test("findMentors respects n limit", () => {
  const mentors = findMentors(YOU, BOARD, { n: 1 });
  assert.ok(mentors.length <= 1, "should respect n limit");
});
