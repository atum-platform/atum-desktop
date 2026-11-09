/**
 * Standing grants, signed by the device approval key (S1 build plan §3, WS-4 `device/grants-store.ts`).
 *
 * A standing grant is the owner saying, on the Mac itself, "T may use the SSH agent on this MacBook" —
 * so an approved capability no longer prompts each time. **Creating one takes Touch ID**: the record is
 * signed by the Secure Enclave approval key (`.userPresence`), which a clicking agent cannot satisfy
 * (G0-SE). The store verifies that signature against the enrolled approval key before trusting a grant,
 * so a forged or tampered grant file is rejected, not honoured. Grants are never grantable from the
 * cloud (Astra follow-up #1).
 *
 * Settings lists them and revokes them. Revocation is local and immediate.
 */
import { deviceSignedBytes, verifyDeviceSignature } from './canonical'
import type { DeviceProtectedCapability } from './contracts'

const STORE_KEY = 'device-standing-grants'

export interface StandingGrant {
  readonly id: string
  readonly capability: DeviceProtectedCapability
  /** `*` matches any target; otherwise an exact target or a `prefix/*` form. */
  readonly target: string
  readonly label: string
  readonly createdAt: number
  /** The agent (Matrix user ID) it is for: "T may use the SSH agent on this Mac". Required: a grant
   * that names no agent is a legacy record and is dropped on read. */
  readonly agent: string
}

/** The sealed record: the grant plus the approval-key signature that authorized it. */
export interface SignedStandingGrant {
  readonly grant: StandingGrant
  readonly kid: string
  readonly sig: string
}

export interface GrantsStoreBackend {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The enrolled approval key this device verifies standing grants against. */
export interface ApprovalKeyRef {
  readonly kid: string
  readonly spki: string
}

export function standingGrantMatches(
  grant: StandingGrant,
  capability: DeviceProtectedCapability,
  target: string,
  agent: string
): boolean {
  if (grant.capability !== capability) {
    return false
  }

  if (grant.agent !== agent) {
    return false
  }

  if (grant.target === '*') {
    return true
  }

  if (grant.target.endsWith('/*')) {
    return target.startsWith(grant.target.slice(0, -1))
  }

  return grant.target === target
}

export class GrantsStore {
  private cache?: SignedStandingGrant[]

  constructor(
    private readonly store: GrantsStoreBackend,
    private readonly approvalKey: () => ApprovalKeyRef | null,
    private readonly log: (line: string) => void = () => {}
  ) {}

  /** The verified, live standing grants. A grant whose signature or key no longer checks out is
   * silently dropped from the returned list (and will be pruned on the next write). A legacy grant
   * that names no agent cannot be admitted for anyone and is dropped, logged, on read. */
  list(): StandingGrant[] {
    return this.verified().map(entry => entry.grant)
  }

  private verified(): SignedStandingGrant[] {
    if (!this.cache) {
      const raw = this.store.getItem(STORE_KEY)
      let parsed: SignedStandingGrant[] = []

      if (raw) {
        try {
          const value = JSON.parse(raw)

          if (Array.isArray(value)) {
            parsed = value
          }
        } catch {
          parsed = []
        }
      }

      this.cache = parsed.filter(entry => {
        if (typeof entry?.grant?.agent === 'string' && entry.grant.agent) {
          return true
        }

        this.log(`[Device] standing permission dropped: it named no agent (${entry?.grant?.id ?? 'unknown'})`)

        return false
      })
    }

    const key = this.approvalKey()

    if (!key) {
      return []
    }

    return this.cache.filter(
      entry => entry.kid === key.kid && verifyDeviceSignature('StandingGrant', entry.grant, key.spki, entry.sig)
    )
  }

  /**
   * True when a standing grant covers this capability and target. Used in admission step 10 so a
   * protected command the owner has standing-granted runs without a fresh prompt.
   */
  covers(capability: DeviceProtectedCapability, target: string, agent: string): boolean {
    return this.verified().some(entry => standingGrantMatches(entry.grant, capability, target, agent))
  }

  /**
   * Create a standing grant the owner asked for in Settings. The record is signed by the Secure Enclave
   * approval key behind a fresh Touch ID (the macOS password on a Mac without Touch ID) whose sheet
   * names the grant, so only the owner, at this Mac, can create one. Rejects (and stores nothing) when
   * the owner cancels or the signature does not verify.
   */
  async create(
    input: { id: string; capability: DeviceProtectedCapability; target: string; label: string; agent: string; reason: string },
    signer: { approve(bytes: Uint8Array, reason: string): Promise<{ kid: string; sig: string }> },
    now: number
  ): Promise<StandingGrant> {
    if (!this.approvalKey()) {
      throw new Error('device_standing_grant_unavailable')
    }

    const grant: StandingGrant = {
      id: input.id,
      capability: input.capability,
      target: input.target,
      label: input.label,
      createdAt: now,
      agent: input.agent
    }

    const signature = await signer.approve(deviceSignedBytes('StandingGrant', grant), input.reason)
    this.add(grant, signature.kid, signature.sig)

    return grant
  }

  /**
   * Store an owner-authorized standing grant. The signature MUST verify against the enrolled approval
   * key (Touch ID produced it) or the grant is refused — this is what stops a clicking agent, or a
   * tampered grants file, from adding a grant.
   */
  add(grant: StandingGrant, kid: string, sig: string): void {
    const key = this.approvalKey()

    if (!key || kid !== key.kid || !verifyDeviceSignature('StandingGrant', grant, key.spki, sig)) {
      throw new Error('device_standing_grant_unauthorized')
    }

    const entries = this.verified().filter(entry => entry.grant.id !== grant.id)
    entries.push({ grant, kid, sig })
    this.write(entries)
  }

  revoke(id: string): void {
    const entries = this.verified().filter(entry => entry.grant.id !== id)
    this.write(entries)
  }

  private write(entries: SignedStandingGrant[]): void {
    this.cache = entries
    this.store.setItem(STORE_KEY, JSON.stringify(entries))
  }
}
