// RETIRED legacy wallet (pre-Matrix app): the read-only Proton wallet and connection rewards. The desktop checkout was retired 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
import type { ProtonRewardClaim, ProtonRewardKind, ProtonRewards } from '../shared/atum-proton-rewards'

import { accountKeyFor, type AccountRootAuthority } from './atum-messaging/account-roots'
import { MessagingHttpError } from './atum-messaging/http-client'
import type { MessagingClientBoundary, ProtonWallet } from './atum-messaging/types'

export interface AtumProtonsSession {
  user: { id: string }
}

export interface AtumProtonsServiceOptions {
  accountRoots: AccountRootAuthority
  session: () => AtumProtonsSession | null
  client: Pick<MessagingClientBoundary, 'protonWallet'> &
    Partial<Pick<MessagingClientBoundary, 'protonRewards' | 'claimProtonConnectionReward'>>
  withGoogleConnectionProof?: (kind: ProtonRewardKind, consume: (accessToken: string) => Promise<ProtonRewardClaim>) => Promise<ProtonRewardClaim>
}

interface AccountFence {
  accountId: string
  accountKey: string
  generation: number
}

export interface ProtonWalletWire {
  balance_protons: number
  spending_enabled: boolean
  funded: boolean
  available_protons: number
  held_protons: number
  trial_protons: number
  ai_protons_per_usd: number
}

/**
 * Main-only wallet transport. The hosted client gets its bearer from the
 * existing messaging runtime; renderer IPC carries no inputs.
 */
export class AtumProtonsService {
  constructor(private readonly options: AtumProtonsServiceOptions) {}

  async rewards(): Promise<ProtonRewards> {
    const fence = this.captureFence()

    if (!this.options.client.protonRewards) { throw new Error('proton_rewards_unavailable') }
    const rewards = await this.options.client.protonRewards()
    this.assertFence(fence)

    return rewards
  }

  async claimConnectionReward(kind: ProtonRewardKind): Promise<ProtonRewardClaim> {
    const fence = this.captureFence()

    if (!this.options.withGoogleConnectionProof || !this.options.client.claimProtonConnectionReward) {
      throw new Error('proton_rewards_unavailable')
    }

    // The connector retains account/revision custody of credentials throughout.
    // No credential is returned through IPC, persisted here, or passed to Hermes.
    const result = await this.options.withGoogleConnectionProof(kind, async token => {
      this.assertFence(fence)

      return this.options.client.claimProtonConnectionReward!(kind, token)
    })

    this.assertFence(fence)

    return result
  }

  async wallet(): Promise<ProtonWalletWire> {
    const fence = this.captureFence()
    const wallet = await this.options.client.protonWallet()
    this.assertFence(fence)

    return walletWire(wallet)
  }

  private captureFence(): AccountFence {
    const session = this.options.session()

    if (!session?.user.id) {
      throw new MessagingHttpError('auth_unavailable', 401, false, null, null, null)
    }

    const committed = this.options.accountRoots.committed()
    const accountKey = accountKeyFor(session.user.id)

    if (!committed || committed.marker.accountKey !== accountKey) {
      throw new MessagingHttpError('account_context_mismatch', 409, false, null, null, null)
    }

    return { accountId: session.user.id, accountKey, generation: committed.marker.generation }
  }

  private assertFence(expected: AccountFence): void {
    const session = this.options.session()
    const committed = this.options.accountRoots.committed()

    if (
      session?.user.id !== expected.accountId ||
      !committed ||
      committed.marker.accountKey !== expected.accountKey ||
      committed.marker.generation !== expected.generation
    ) {
      throw new MessagingHttpError('account_context_changed', 409, false, null, null, null)
    }
  }
}

function walletWire(wallet: ProtonWallet): ProtonWalletWire {
  return {
    balance_protons: wallet.balanceProtons,
    spending_enabled: wallet.spendingEnabled,
    funded: wallet.funded,
    available_protons: wallet.availableProtons,
    held_protons: wallet.heldProtons,
    trial_protons: wallet.trialProtons,
    ai_protons_per_usd: wallet.aiProtonsPerUsd
  }
}
