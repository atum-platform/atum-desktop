// RETIRED legacy commerce (pre-Matrix app): its Proton sale is removed and the platform switched its wallet spending and rewards off on 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
import { atom } from 'nanostores'

import { parseProtonRewardClaim, parseProtonRewards, type ProtonRewardKind, type ProtonRewards } from '../../shared/atum-proton-rewards'

import { $atumAccountScopeId } from './atum-messaging'
import { refreshAtumProtonWallet } from './atum-proton-wallet'

interface RewardsView {
  accountId: string | null
  state: 'idle' | 'loading' | 'resolved' | 'unavailable'
  rewards: ProtonRewards | null
  claiming: ProtonRewardKind | null
  notice: 'failed' | 'already_used' | null
}

const initial = (accountId: string | null): RewardsView => ({ accountId, state: 'idle', rewards: null, claiming: null, notice: null })
export const $atumProtonRewards = atom<RewardsView>(initial($atumAccountScopeId.get()))
let generation = 0

$atumAccountScopeId.listen(accountId => {
  generation++
  $atumProtonRewards.set(initial(accountId))
})

export async function refreshAtumProtonRewards(): Promise<void> {
  const accountId = $atumAccountScopeId.get()
  const epoch = ++generation

  if (!accountId) { $atumProtonRewards.set(initial(null));

 return }

  $atumProtonRewards.set({ ...initial(accountId), state: 'loading' })

  try {
    const rewards = parseProtonRewards(await window.hermesDesktop.protons.rewards())

    if (epoch === generation) { $atumProtonRewards.set({ ...initial(accountId), state: 'resolved', rewards }) }
  } catch {
    if (epoch === generation) { $atumProtonRewards.set({ ...initial(accountId), state: 'unavailable' }) }
  }
}

export async function claimAtumConnectionReward(kind: ProtonRewardKind): Promise<void> {
  const current = $atumProtonRewards.get()

  if (!current.accountId || current.state !== 'resolved' || current.claiming || current.rewards?.state !== 'available') { return }

  const epoch = generation
  $atumProtonRewards.set({ ...current, claiming: kind, notice: null })

  try {
    const result = parseProtonRewardClaim(await window.hermesDesktop.protons.claimConnectionReward(kind))

    if (epoch !== generation) { return }

    if (result.state === 'connection_already_rewarded') {
      $atumProtonRewards.set({ ...current, claiming: null, notice: 'already_used' })

      return
    }

    await Promise.all([refreshAtumProtonRewards(), refreshAtumProtonWallet()])
  } catch {
    if (epoch === generation) { $atumProtonRewards.set({ ...current, claiming: null, notice: 'failed' }) }
  }
}
