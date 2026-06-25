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

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { generateKeyPairSync, randomUUID } from 'node:crypto'

const DIR = join(homedir(), '.sigrank-mcp')
const PATH = join(DIR, 'identity.json')

/** SPKI DER prefix length for an ed25519 public key (12 bytes before the raw 32). */
const SPKI_PREFIX_LEN = 12

/** Resolve this package's version for the agent_version stamp (best-effort). */
function agentVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))
    return `sigrank-mcp/${pkg.version}`
  } catch {
    return 'sigrank-mcp'
  }
}

export function keystorePath() {
  return PATH
}

/** Read the stored identity, or null if absent/corrupt. */
export function loadIdentity() {
  if (!existsSync(PATH)) return null
  try {
    return JSON.parse(readFileSync(PATH, 'utf-8'))
  } catch {
    return null
  }
}

/** Write the identity with strict perms (dir 0700, file 0600). */
export function persistIdentity(identity) {
  mkdirSync(DIR, { recursive: true })
  try {
    chmodSync(DIR, 0o700)
  } catch {
    /* best-effort on platforms without chmod */
  }
  writeFileSync(PATH, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(PATH, 0o600)
  } catch {
    /* best-effort */
  }
  return identity
}

/** Build a fresh keypair record (pure — no fs). Exposed for tests. */
export function generateIdentity({ device_id } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const rawPub = Buffer.from(spki).subarray(SPKI_PREFIX_LEN) // the raw 32 bytes
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' })
  return {
    device_id: device_id || randomUUID(),
    codename: null,
    operator_id: null,
    public_key: `ed25519:${rawPub.toString('base64')}`,
    private_key_pkcs8_b64: Buffer.from(pkcs8).toString('base64'),
    agent_version: agentVersion(),
    enrolled_at: null,
  }
}

/**
 * Load the existing identity, or generate + persist a fresh one. Idempotent: a
 * complete existing identity is returned untouched (never rotates a live key).
 */
export function ensureIdentity() {
  const existing = loadIdentity()
  if (existing?.private_key_pkcs8_b64 && existing?.public_key && existing?.device_id) {
    return existing
  }
  // Preserve any partial fields (e.g. a device_id) across a regeneration.
  const fresh = generateIdentity({ device_id: existing?.device_id })
  if (existing) {
    fresh.codename = existing.codename ?? null
    fresh.operator_id = existing.operator_id ?? null
    fresh.enrolled_at = existing.enrolled_at ?? null
  }
  return persistIdentity(fresh)
}

/** Record a successful enrollment (codename/operator_id + enrolled_at) into the keystore. */
export function recordEnrollment({ codename, operator_id }) {
  const id = ensureIdentity()
  id.codename = codename ?? id.codename
  id.operator_id = operator_id ?? id.operator_id
  id.enrolled_at = new Date().toISOString()
  return persistIdentity(id)
}
