/**
 * retire-operator.mjs — INTERNAL owner-only opt-out / profile scrub tool.
 *
 * NOT part of the public `npx sigrank` CLI. Run directly from a local clone
 * of sigrank-mcp with Supabase service-role credentials in env.
 *
 * WHY THIS EXISTS:
 *   When an operator requests removal (opt-out), we need to:
 *   1. Immediately strip their PII from the public site (Step 1)
 *   2. Keep their token snapshots in the DB for statistical integrity
 *   3. Later, manually review token signatures and delete the operator row (Step 2)
 *
 *   This tool does Step 1. It:
 *     - Strips all PII fields (display_name, handle, avatar_url, bio, links, location)
 *     - Strips claim fields (claim_contact, claim_payment_id, stripe_customer_id, claimed, claimed_at)
 *     - Changes the codename to signal-<hash> (anonymous, matches seeded profile format)
 *     - Sets status='retired'
 *
 *   The operator disappears from the public profile page (redirects to /leaderboard)
 *   and their leaderboard row becomes a non-clickable anonymous entry. Token data
 *   in metric_snapshots is untouched.
 *
 * USAGE:
 *   node retire-operator.mjs --codename imlunahey
 *   node retire-operator.mjs --codename imlunahey --dry-run
 *   node retire-operator.mjs --codename signal-1d5a4aecc3  # already anonymous, just strip + retire
 *
 * ENV VARS:
 *   SUPABASE_URL              — e.g. https://copqtaqzsdvpdbhpwjmt.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY — service-role key (bypasses RLS). NEVER commit.
 *
 * STEP 2 (manual, not this tool):
 *   After reviewing the operator's token signatures (especially Codex operators
 *   where the cache_write/input split needs verification), delete the operator
 *   row from the DB. The metric_snapshots rows will need their operator_id
 *   handled per the FK constraint (either reassign to a sentinel or delete).
 *   This is a manual owner decision, not automated.
 */

import { createHash } from 'node:crypto'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

function usage() {
  console.log(`
Usage: node retire-operator.mjs --codename <codename> [--dry-run]

Options:
  --codename <name>   The operator's codename (e.g. imlunahey, signal-1d5a4aecc3)
  --dry-run           Show what would change without writing to the DB

Env:
  SUPABASE_URL              Supabase project URL
  SUPABASE_SERVICE_ROLE_KEY Service-role key (bypasses RLS)
`.trim())
}

function parseArgs(argv) {
  const args = { dryRun: false }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--codename') args.codename = argv[++i]
    else if (argv[i] === '--dry-run') args.dryRun = true
    else if (argv[i] === '--help' || argv[i] === '-h') { usage(); process.exit(0) }
  }
  if (!args.codename) { usage(); process.exit(1) }
  return args
}

async function fetchOperator(codename) {
  const url = `${SUPABASE_URL}/rest/v1/operators?codename=ilike.${encodeURIComponent(codename)}&select=operator_id,codename,display_name,handle,avatar_url,bio,links,location,claimed,claimed_at,claim_contact,claim_payment_id,stripe_customer_id,status`
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Supabase query failed (${res.status}): ${body}`)
  }
  const rows = await res.json()
  return rows[0] ?? null
}

function generateSignalCodename(operatorId) {
  // Generate a signal-<hash> codename from the operator_id.
  // Uses the first 10 chars of a SHA-256 hash, matching the existing signal-xxx format.
  const hash = createHash('sha256').update(operatorId).digest('hex').slice(0, 10)
  return `signal-${hash}`
}

async function checkCodenameAvailable(codename) {
  const url = `${SUPABASE_URL}/rest/v1/operators?codename=eq.${encodeURIComponent(codename)}&select=operator_id`
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  })
  if (!res.ok) return false
  const rows = await res.json()
  return rows.length === 0
}

async function retireOperator(operator, dryRun) {
  const isAlreadySignal = operator.codename.startsWith('signal-')
  let newCodename = operator.codename

  if (!isAlreadySignal) {
    newCodename = generateSignalCodename(operator.operator_id)
    const available = await checkCodenameAvailable(newCodename)
    if (!available) {
      // Collision — append a suffix
      const hash = createHash('sha256').update(operator.operator_id + '-retired').digest('hex').slice(0, 10)
      newCodename = `signal-${hash}`
    }
  }

  const updates = {
    display_name: null,
    handle: null,
    avatar_url: null,
    bio: null,
    links: {},
    location: null,
    claimed: false,
    claimed_at: null,
    claim_contact: null,
    claim_payment_id: null,
    stripe_customer_id: null,
    status: 'retired',
  }

  if (!isAlreadySignal) {
    updates.codename = newCodename
  }

  console.log('\n--- RETIRE PLAN ---')
  console.log(`Operator ID:   ${operator.operator_id}`)
  console.log(`Current name:  ${operator.codename}`)
  console.log(`New codename:  ${newCodename}`)
  console.log(`Status:        active → retired`)
  console.log(`PII stripped:  display_name, handle, avatar_url, bio, links, location`)
  console.log(`Claim stripped: claim_contact, claim_payment_id, stripe_customer_id, claimed, claimed_at`)
  console.log(`Token snapshots: UNTOUCHED (preserved for statistical integrity)`)

  if (dryRun) {
    console.log('\n[DRY RUN] No changes written to DB.')
    return
  }

  // Write the update
  const url = `${SUPABASE_URL}/rest/v1/operators?operator_id=eq.${operator.operator_id}`
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(updates),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Supabase update failed (${res.status}): ${body}`)
  }

  const updated = await res.json()
  if (updated.length === 0) {
    throw new Error('No rows updated — operator may not exist or already retired.')
  }

  console.log(`\n✓ Operator retired: ${operator.codename} → ${newCodename}`)
  console.log(`✓ PII stripped, status set to retired.`)
  console.log(`✓ Token snapshots preserved.`)
  console.log(`\nStep 2 (manual): review token signatures, then delete the operator row when satisfied.`)
}

async function main() {
  const args = parseArgs(process.argv)

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in env.')
    console.error('Example: SUPABASE_URL=https://copqtaqzsdvpdbhpwjmt.supabase.co SUPABASE_SERVICE_ROLE_KEY=ey... node retire-operator.mjs --codename imlunahey')
    process.exit(1)
  }

  console.log(`Looking up operator: ${args.codename}${args.dryRun ? ' [DRY RUN]' : ''}...`)
  const operator = await fetchOperator(args.codename)

  if (!operator) {
    console.error(`ERROR: No operator found with codename "${args.codename}".`)
    process.exit(1)
  }

  if (operator.status === 'retired') {
    console.log(`Operator "${args.codename}" is already retired. No action needed.`)
    process.exit(0)
  }

  await retireOperator(operator, args.dryRun)
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`)
  process.exit(1)
})
