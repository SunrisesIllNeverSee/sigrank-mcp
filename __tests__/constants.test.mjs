// constants.test.mjs — guards the centralized constants in lib/constants.mjs.
//
// Run: node --test __tests__/constants.test.mjs
//
// Before this guard, TERMS_VERSION / PRIVACY_VERSION were inlined as
// "2026-07-21" in four files (enroll, submit-paste, tokenpull-submit x2,
// submit/index), and TOKSCALE_CLIENT_MAP was duplicated in three. A terms rev
// or a client-map update would have required finding and editing every copy.
// This test asserts the centralized values are well-formed and that the
// isRankedAck predicate matches the canonical "verified + persisted" cut.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TERMS_VERSION,
  PRIVACY_VERSION,
  TOKSCALE_CLIENT_MAP,
  isRankedAck,
} from "../lib/constants.mjs";

test("TERMS_VERSION and PRIVACY_VERSION are ISO date strings", () => {
  assert.match(TERMS_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(PRIVACY_VERSION, /^\d{4}-\d{2}-\d{2}$/);
});

test("TOKSCALE_CLIENT_MAP maps the known clients and skips synthetic", () => {
  assert.equal(TOKSCALE_CLIENT_MAP.claude, "claude");
  assert.equal(TOKSCALE_CLIENT_MAP["devin-cli"], "devin");
  assert.equal(TOKSCALE_CLIENT_MAP.cursor, "other");
  assert.equal(TOKSCALE_CLIENT_MAP.synthetic, null);
});

test("isRankedAck is true only for ok + verified + persisted", () => {
  assert.equal(
    isRankedAck({ ok: true }, { verification_tier: "verified", persisted: true }),
    true,
  );
  // 202 received but not persisted → NOT ranked (the unenrolled-device case).
  assert.equal(
    isRankedAck({ ok: true }, { verification_tier: "verified", persisted: false }),
    false,
  );
  // non-verified tier → not ranked.
  assert.equal(
    isRankedAck({ ok: true }, { verification_tier: "flagged", persisted: true }),
    false,
  );
  // HTTP error → not ranked.
  assert.equal(
    isRankedAck({ ok: false }, { verification_tier: "verified", persisted: true }),
    false,
  );
  // null ack → not ranked.
  assert.equal(isRankedAck({ ok: true }, null), false);
});
