// sign.mjs — canonical JSON + ed25519 signing for SigRank signed snapshot submit.
//
// BYTE-COMPATIBLE PORT of sigrank-app lib/ingest/signature.ts. This is the highest-
// risk file in the client: the server VERIFIES the signature over ITS recomputation
// of these exact canonical bytes, so a single divergent byte hard-rejects (422) every
// verified submission. Keep this a line-for-line mirror of the server canonicalizer:
//   canonical JSON = recursively sorted keys, compact separators, UTF-8, with the
//   derived agent.signature + agent.snapshot_hash stripped before serialization.
//   snapshot_hash = "sha256:" + hex(sha256(canonical_bytes)).
//   public key    = "ed25519:<base64 of the 32 raw verify-key bytes>".
//   signature     = base64 of the 64-byte ed25519 signature over canonical_bytes.
// The canon-parity fixture (tests/fixtures/canon_parity.json) + sign.test.mjs + the
// sigrank-app canon_parity gate together lock this byte-for-byte.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";

/** Agent fields excluded from the canonical (signed/hashed) body — they derive from it. */
const DERIVED_AGENT_FIELDS = ["signature", "snapshot_hash"];

/** Recursively sort object keys (matches the server's Object.keys(...).sort()); arrays keep order. */
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

/** Canonical JSON string the agent signs/hashes (derived agent fields stripped). */
export function canonicalJson(payload) {
  const clone = JSON.parse(JSON.stringify(payload));
  const agent = clone.agent;
  if (agent && typeof agent === "object") {
    for (const f of DERIVED_AGENT_FIELDS) delete agent[f];
  }
  return JSON.stringify(sortDeep(clone));
}

/** UTF-8 bytes of the canonical JSON — the exact bytes that get signed. */
export function canonicalBytes(payload) {
  return Buffer.from(canonicalJson(payload), "utf-8");
}

/** "sha256:<hex>" over the canonical bytes (matches the server snapshotHash). */
export function snapshotHash(payload) {
  return `sha256:${createHash("sha256").update(canonicalBytes(payload)).digest("hex")}`;
}

/** SPKI DER prefix for a raw 32-byte ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Build a node KeyObject from an "ed25519:<base64>" (or bare base64) public key, or null. */
function publicKeyFrom(pk) {
  try {
    const body = pk.startsWith("ed25519:") ? pk.slice("ed25519:".length) : pk;
    const raw = Buffer.from(body, "base64");
    if (raw.length !== 32) return null;
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
}

/**
 * Sign the payload's canonical bytes with the PKCS8-DER-base64 private key → base64 sig.
 * The returned string is the X-Agent-Signature header value.
 */
export function signPayload(payload, privateKeyPkcs8B64) {
  const key = createPrivateKey({
    key: Buffer.from(privateKeyPkcs8B64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return edSign(null, canonicalBytes(payload), key).toString("base64");
}

/**
 * Local verify (parity with the server's verifySignature) — used by the self-test
 * and as a pre-send sanity check. Returns false on any malformation, never throws.
 */
export function verifyPayload(payload, signatureB64, publicKey) {
  const key = publicKeyFrom(publicKey);
  if (!key) return false;
  try {
    return edVerify(
      null,
      canonicalBytes(payload),
      key,
      Buffer.from(signatureB64, "base64"),
    );
  } catch {
    return false;
  }
}
