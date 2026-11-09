import { execFile } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { expect, test } from 'vitest'

import { AccountRootAuthority } from './atum-messaging/account-roots'
import { parseStoreEntitlementEnvelope } from './atum-messaging/http-client'
import type { StoreEntitlementProof } from './atum-messaging/types'
import { ATUM_STORE_DIR, ATUM_STORE_ENTITLEMENT_FILE, AtumStoreService } from './atum-store'

/**
 * Contract C6 / review B1: the desktop writer and the Hermes reader must agree
 * on the ONE place the signed entitlement proof lives. Each side was
 * unit-tested against its own idea of the path, so every test passed while
 * enforcement was a no-op. This test exercises both REAL components on the
 * same temporary account root: the real `AtumStoreService` persists a v3
 * envelope through the real `AccountRootAuthority`, then the real
 * `hermes_cli.atum_store_proof` — pointed at exactly the HERMES_HOME main
 * would pass for that account — must find it, verify it, and enforce it.
 * If the two sides ever disagree on the path or the shape again, this fails.
 *
 * Opt in with the repository Python environment:
 *   ATUM_SYNC_PYTHON=<repo>/.venv/bin/python npx vitest run ...
 */

const ACCOUNT = '00000000-0000-4000-8000-303617b97302'
const OTHER_ACCOUNT = '00000000-0000-4000-8000-00f765af1c54'
const ASSISTANT = '00000000-0000-4000-8000-7cac378a5787'
const IDENTITY = '00000000-0000-4000-8000-d3b5d0600970'
const KEY_ID = 'it-k1'
const OWNED_HASH = 'a'.repeat(64)

const ENTITLED_SKILL = { kind: 'skill', id: 'official/creative/pixel-art', identifier: 'official/creative/pixel-art' }
const LOCKED_SKILL = { kind: 'skill', id: 'official/creative/locked', identifier: 'official/creative/locked' }
const LOCKED_PET = { kind: 'pet', id: 'bundled/mocha', identifier: 'mocha' }

// The test's own throwaway key, generated per run — no key material is committed.
// The probe pins it the way a release pins `k1` (a shipped build pins keys, so
// the pre-launch development override is ignored by design).
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const spki = publicKey.export({ format: 'der', type: 'spki' })
const TEST_KEY_PIN = `${KEY_ID}:${spki.subarray(spki.length - 32).toString('base64url')}`

/** The platform's canonicalisation, stated once in contract C2: keys sorted,
 * no whitespace, UTF-8, `signature` excluded. Keys here are ASCII, where
 * UTF-16 code-unit order equals code-point order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }

  return JSON.stringify(value)
}

/**
 * A platform-shaped v3 envelope over the test key. The RAW text is deliberately
 * non-canonical: main must persist these exact bytes, never a re-serialisation
 * (Hermes re-canonicalises the parsed payload before verifying).
 */
function signedEnvelope(account: string): string {
  const payload = {
    v: 3,
    account_id: account,
    issued_at: 1_789_000_000,
    expires_at: 4_000_000_000, // 2106: still ahead whenever this test runs
    key_id: KEY_ID,
    entitlements: [{ kind: ENTITLED_SKILL.kind, id: ENTITLED_SKILL.id, state: 'active', assistant_id: ASSISTANT, assistant_identity_id: IDENTITY }],
    catalog_owned: [
      { ...ENTITLED_SKILL, delivery: 'local', hashes: [OWNED_HASH] },
      { ...LOCKED_SKILL, delivery: 'local', hashes: [] },
      { ...LOCKED_PET, delivery: 'local', hashes: [] }
    ]
  }

  const signature = sign(null, Buffer.from(canonicalJson(payload), 'utf8'), privateKey).toString('base64url')

  return (
    `{"signature":"${signature}","catalog_owned":${JSON.stringify(payload.catalog_owned)},"v":3,` +
    `"expires_at":${payload.expires_at},"key_id":"${KEY_ID}","issued_at":${payload.issued_at},` +
    `"entitlements":${JSON.stringify(payload.entitlements)},"account_id":"${account}"}`
  )
}

const PROBE = `
import json
import os
from hermes_cli import atum_store_proof as proof
from hermes_cli.profiles import adopt_profile_identity
from pathlib import Path
adopt_profile_identity(Path(os.environ["HERMES_HOME"]), ${JSON.stringify(IDENTITY)})

# Pin the test key exactly as a release pins the platform key.
_pin_id, _, _pin_key = os.environ["ATUM_STORE_TEST_KEY_PIN"].partition(":")
proof.PINNED_PUBLIC_KEYS = {_pin_id: _pin_key}

def outcome(kind, identifier):
    try:
        proof.enforce_catalog_item(kind, identifier)
        return "allowed"
    except proof.StoreEntitlementError as error:
        return error.code

print(json.dumps({
    "store_dir": str(proof.store_dir()),
    "proof_error": proof.proof_error(),
    "entitled_skill": outcome(${JSON.stringify(ENTITLED_SKILL.kind)}, ${JSON.stringify(ENTITLED_SKILL.identifier)}),
    "locked_skill": outcome(${JSON.stringify(LOCKED_SKILL.kind)}, ${JSON.stringify(LOCKED_SKILL.identifier)}),
    "locked_pet": outcome(${JSON.stringify(LOCKED_PET.kind)}, ${JSON.stringify(LOCKED_PET.identifier)}),
    "free_item": outcome("skill", "community/free-thing"),
}))
`

interface ProbeResult {
  store_dir: string
  proof_error: string | null
  entitled_skill: string
  locked_skill: string
  locked_pet: string
  free_item: string
}

test.skipIf(!process.env.ATUM_SYNC_PYTHON)(
  'the desktop writer and the Hermes reader agree on the proof: one path, one signed file',
  async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'atum-store-contract-'))
    const execute = promisify(execFile)
    // The repository root, so `import hermes_cli` resolves to the real source.
    const repo = fileURLToPath(new URL('../../../', import.meta.url))

    try {
      // 1. A temporary account whose root follows the real layout, so FX-H's
      //    location binding (`<accounts>/<accountKeyFor(id)>/hermes`) applies.
      const roots = new AccountRootAuthority(scratch)
      roots.commit(ACCOUNT, 1)
      const hermesHome = roots.pathsForAccount(ACCOUNT).hermesStateRoot

      // 2-3. Sign a v3 envelope with the test key and let the REAL store
      //      service persist it through the real account-root authority.
      const raw = signedEnvelope(ACCOUNT)
      const proof: StoreEntitlementProof = { envelope: parseStoreEntitlementEnvelope(JSON.parse(raw)), raw }

      const service = new AtumStoreService({
        accountRoots: roots,
        session: () => ({ user: { id: ACCOUNT } }),
        client: {
          catalog: async () => ({ items: [], entitlements: [], availableProtons: 0, skippedUnknownItems: 0 }),
          purchase: async () => {
            throw new Error('unused')
          },
          purchaseStatus: async () => {
            throw new Error('unused')
          },
          entitlements: async () => proof
        }
      })

      await service.refresh()

      const proofPath = join(hermesHome, ATUM_STORE_DIR, ATUM_STORE_ENTITLEMENT_FILE)

      expect(existsSync(proofPath)).toBe(true)
      expect(readFileSync(proofPath, 'utf8')).toBe(raw)
      expect(statSync(proofPath).mode & 0o777).toBe(0o600)

      // 4. The REAL Hermes verifier, with HERMES_HOME set to exactly what main
      //    passes for this account and the test key pinned by the probe. No
      //    account id is handed to Hermes: the location binding alone must
      //    bind the proof to this account.
      const env = { ...process.env, HERMES_HOME: hermesHome, ATUM_STORE_TEST_KEY_PIN: TEST_KEY_PIN }

      const run = async (): Promise<ProbeResult> => {
        const { stdout } = await execute(process.env.ATUM_SYNC_PYTHON!, ['-c', PROBE], {
          cwd: repo,
          env,
          maxBuffer: 4 * 1024 * 1024
        })

        return JSON.parse(stdout) as ProbeResult
      }

      // 5a. Hermes finds the file at the one path both sides share, verifies
      //     it, and enforces the signed sets.
      const own = await run()

      expect(own.store_dir).toBe(join(hermesHome, ATUM_STORE_DIR))
      expect(own.proof_error).toBeNull()
      expect(own.entitled_skill).toBe('allowed')
      expect(own.locked_skill).toBe('purchase_required')
      expect(own.locked_pet).toBe('purchase_required')
      expect(own.free_item).toBe('allowed')

      // 5b. An envelope belonging to a DIFFERENT account planted in this
      //     account's root: the location binding refuses every catalog item.
      //     (The desktop itself refuses to persist a foreign envelope, so this
      //     file is planted directly — the attack the binding exists to stop.)
      writeFileSync(proofPath, signedEnvelope(OTHER_ACCOUNT), { mode: 0o600 })

      const foreign = await run()

      expect(foreign.proof_error).toBe('account_mismatch')
      expect(foreign.entitled_skill).toBe('entitlement_unavailable_offline')
      expect(foreign.locked_skill).toBe('entitlement_unavailable_offline')
      expect(foreign.locked_pet).toBe('entitlement_unavailable_offline')
      // A free item still installs: the foreign proof can only fail closed on
      // what its signed catalog names, never take the machine offline.
      expect(foreign.free_item).toBe('allowed')
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  },
  30_000
)
