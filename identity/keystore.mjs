// keystore.mjs — local ed25519 device identity for SigRank signed submit (D7 §4.5).
//
// Persists a per-device keypair at ~/.sigrank-mcp/identity.json (dir 0700, file 0600).
// The PRIVATE key never leaves this machine; only the raw 32-byte public key (as
// "ed25519:<base64>") is sent to the server at enroll time. The device_id (uuid) is
// generated once and is the immutable binding target server-side.
//
// Public-key export MUST match the server's publicKeyFromAgent: generateKeyPairSync
// exports SPKI DER with a 12-byte prefix; we strip it to the raw 32 bytes, base64 it,
// and prefix "ed25519:". The server re-adds the SPKI prefix to verify. Round-trip is
// locked by sign.test.mjs + the canon-parity fixture.

import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
  unlinkSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { generateKeyPairSync, randomUUID } from "node:crypto";

const DIR = join(homedir(), ".sigrank-mcp");
const PATH = join(DIR, "identity.json");
const BACKUP_PREFIX = "identity.json.bak-";
const MAX_BACKUPS = 5;

/** SPKI DER prefix length for an ed25519 public key (12 bytes before the raw 32). */
const SPKI_PREFIX_LEN = 12;

/** Resolve this package's version for the agent_version stamp (best-effort). */
function agentVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
    );
    return `sigrank-mcp/${pkg.version}`;
  } catch {
    return "sigrank-mcp";
  }
}

export function keystorePath() {
  return PATH;
}

/** Read the stored identity, or null if absent/corrupt. */
export function loadIdentity() {
  if (!existsSync(PATH)) return null;
  try {
    return JSON.parse(readFileSync(PATH, "utf-8"));
  } catch {
    return null;
  }
}

/** Write the identity with strict perms (dir 0700, file 0600). Backs up the existing
 * file before overwriting so a corrupt write or accidental reset can be recovered. */
export function persistIdentity(identity) {
  mkdirSync(DIR, { recursive: true });
  try {
    chmodSync(DIR, 0o700);
  } catch {
    /* best-effort on platforms without chmod */
  }
  // Back up the existing identity before overwriting (resilience: if the write
  // fails or the file is later lost, the backup carries the binding + keys).
  if (existsSync(PATH)) {
    try {
      const stamp = Date.now();
      copyFileSync(PATH, join(DIR, `${BACKUP_PREFIX}${stamp}`));
      pruneBackups();
    } catch {
      /* best-effort — don't block the write */
    }
  }
  writeFileSync(PATH, `${JSON.stringify(identity, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    chmodSync(PATH, 0o600);
  } catch {
    /* best-effort */
  }
  return identity;
}

/** Build a fresh keypair record (pure — no fs). Exposed for tests. */
export function generateIdentity({ device_id } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const rawPub = Buffer.from(spki).subarray(SPKI_PREFIX_LEN); // the raw 32 bytes
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
  return {
    device_id: device_id || randomUUID(),
    codename: null,
    operator_id: null,
    public_key: `ed25519:${rawPub.toString("base64")}`,
    private_key_pkcs8_b64: Buffer.from(pkcs8).toString("base64"),
    agent_version: agentVersion(),
    enrolled_at: null,
  };
}

/**
 * Decide the binding (codename/operator_id/enrolled_at) to carry onto a freshly
 * generated identity. The binding is tied to device_id: if device_id is CHANGING
 * (a new device, e.g. after a reset/re-enroll where the old file was deleted), the
 * old binding is INVALIDATED — never preserve a stale codename/operator onto a
 * different device. That mismatch is the "Frankenstein identity" root cause: a new
 * device_id + an old codename → the server sees a mismatch → tags submissions
 * `unverified` → never ranks, yet `isSignedIn` reads the local codename as present.
 * Only reuse the binding when the SAME device_id is being kept. Pure — exposed for
 * tests (no fs, so the owner's live identity is never at risk during a test run).
 */
export function bindingForFreshIdentity(existing, fresh) {
  if (!existing)
    return { codename: null, operator_id: null, enrolled_at: null };
  if (existing.device_id && fresh.device_id === existing.device_id) {
    return {
      codename: existing.codename ?? null,
      operator_id: existing.operator_id ?? null,
      enrolled_at: existing.enrolled_at ?? null,
    };
  }
  // device_id changed → the old binding belongs to a different device; drop it.
  return { codename: null, operator_id: null, enrolled_at: null };
}

/**
 * Load the existing identity, or generate + persist a fresh one. Idempotent: a
 * complete existing identity is returned untouched (never rotates a live key).
 * Self-healing: if the identity has keys + device_id but no codename (binding
 * lost via partial write / version transition), scans backups for a matching
 * device_id and restores the binding before returning.
 */
export function ensureIdentity() {
  const existing = loadIdentity();
  if (
    existing?.private_key_pkcs8_b64 &&
    existing?.public_key &&
    existing?.device_id
  ) {
    // Self-healing: keys present but binding lost → try to restore from backups.
    if (!existing.codename || !existing.operator_id) {
      const restored = restoreBindingFromBackups(existing.device_id);
      if (restored) {
        existing.codename = restored.codename;
        existing.operator_id = restored.operator_id;
        existing.enrolled_at = restored.enrolled_at;
        return persistIdentity(existing);
      }
    }
    return existing;
  }
  // Regeneration path: a partial/corrupt record. The binding is tied to device_id —
  // if a new device_id is generated, the old codename/operator MUST NOT carry over
  // (bindingForFreshIdentity drops them). Only a reused device_id keeps its binding.
  const fresh = generateIdentity({ device_id: existing?.device_id });
  const binding = bindingForFreshIdentity(existing, fresh);
  fresh.codename = binding.codename;
  fresh.operator_id = binding.operator_id;
  fresh.enrolled_at = binding.enrolled_at;
  return persistIdentity(fresh);
}

/** Record a successful enrollment (codename/operator_id + enrolled_at) into the keystore. */
export function recordEnrollment({ codename, operator_id }) {
  const id = ensureIdentity();
  // OVERWRITE from the server's enroll response — a new enroll is a new binding, full
  // stop. Never `??`-preserve a stale codename/operator onto this device (the other
  // half of the Frankenstein bug: a re-enroll used to keep the old codename when the
  // new one was absent). A 201 enrolled always carries both.
  id.codename = codename ?? null;
  id.operator_id = operator_id ?? null;
  id.enrolled_at = new Date().toISOString();
  return persistIdentity(id);
}

/** Clear the local identity (sign out). Next enroll provisions a fresh device_id. */
export function clearIdentity() {
  try {
    if (existsSync(PATH)) unlinkSync(PATH);
  } catch {
    /* best-effort */
  }
}

/** Keep at most MAX_BACKUPS backup files (oldest deleted first). */
function pruneBackups() {
  try {
    const files = readdirSync(DIR)
      .filter((f) => f.startsWith(BACKUP_PREFIX))
      .sort(); // timestamp-suffixed → lexicographic = chronological
    while (files.length > MAX_BACKUPS) {
      unlinkSync(join(DIR, files.shift()));
    }
  } catch {
    /* best-effort */
  }
}

/** Scan backup files for one with the same device_id that carries a codename +
 * operator_id binding. Returns { codename, operator_id, enrolled_at } or null.
 * Used by ensureIdentity() to self-heal when the live file lost its binding
 * (e.g. a partial write or version transition that preserved keys but dropped
 * the binding metadata). Only restores from a backup with the SAME device_id —
 * never crosses device boundaries (Frankenstein-identity guard). */
export function restoreBindingFromBackups(device_id) {
  if (!device_id) return null;
  try {
    const files = readdirSync(DIR)
      .filter((f) => f.startsWith(BACKUP_PREFIX))
      .sort()
      .reverse(); // newest first — prefer the most recent binding
    for (const f of files) {
      try {
        const bak = JSON.parse(readFileSync(join(DIR, f), "utf-8"));
        if (
          bak.device_id === device_id &&
          bak.codename &&
          bak.operator_id
        ) {
          return {
            codename: bak.codename,
            operator_id: bak.operator_id,
            enrolled_at: bak.enrolled_at ?? null,
          };
        }
      } catch {
        /* skip corrupt backups */
      }
    }
  } catch {
    /* best-effort */
  }
  return null;
}
