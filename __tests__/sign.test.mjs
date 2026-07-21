// sign.test.mjs — canon-parity + ed25519 round-trip for the signed-submit path.
//
// Run: node sign.test.mjs. Asserts the committed canon-parity fixture is exactly
// reproducible by sign.mjs. The sigrank-app canon_parity gate asserts the SAME
// fixture (its canonicalJson/snapshotHash/verifySignature), so the two together
// prove the MCP and the server agree byte-for-byte — a single drifting byte would
// hard-reject (422) every verified submission.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  canonicalJson,
  snapshotHash,
  signPayload,
  verifyPayload,
  canonicalBytes,
} from "../sign.mjs";
import { generateIdentity } from "../keystore.mjs";

const fx = JSON.parse(
  readFileSync(
    new URL("../tests/fixtures/canon_parity.json", import.meta.url),
    "utf-8",
  ),
);

// 1. canonicalJson is byte-stable vs the committed fixture.
assert.strictEqual(
  canonicalJson(fx.payload),
  fx.expected_canonical,
  "canonical JSON drift vs fixture",
);

// 2. snapshot_hash reproduces.
assert.strictEqual(
  snapshotHash(fx.payload),
  fx.expected_snapshot_hash,
  "snapshot_hash drift vs fixture",
);

// 3. signature reproduces (ed25519 is deterministic) + verifies against the public key.
const sig = signPayload(fx.payload, fx.private_key_pkcs8_b64);
assert.strictEqual(sig, fx.expected_signature, "signature drift vs fixture");
assert.ok(
  verifyPayload(fx.payload, sig, fx.public_key),
  "verify must accept a freshly-signed payload",
);

// 4. a tampered payload must FAIL verification (the gate's whole point).
const tampered = JSON.parse(JSON.stringify(fx.payload));
tampered.raw_telemetry.tokens_output += 1;
assert.ok(
  !verifyPayload(tampered, sig, fx.public_key),
  "verify must reject a tampered payload",
);

// 5. canonical excludes the derived agent fields (signature/snapshot_hash).
const stripped = JSON.parse(JSON.stringify(fx.payload));
delete stripped.agent.snapshot_hash;
delete stripped.agent.signature;
assert.strictEqual(
  canonicalJson(stripped),
  fx.expected_canonical,
  "canonical must ignore derived agent fields",
);

// 6. a fresh generated identity round-trips sign→verify, and exports a 32-byte raw key.
const id = generateIdentity();
const s2 = signPayload(fx.payload, id.private_key_pkcs8_b64);
assert.ok(
  verifyPayload(fx.payload, s2, id.public_key),
  "generated keypair must sign→verify",
);
assert.ok(
  id.public_key.startsWith("ed25519:"),
  "public key carries the ed25519: prefix",
);
assert.strictEqual(
  Buffer.from(id.public_key.slice("ed25519:".length), "base64").length,
  32,
  "raw public key is 32 bytes",
);

console.log(
  `✓ sign.test.mjs — canon parity + ed25519 round-trip (canonical ${canonicalBytes(fx.payload).length} bytes)`,
);
