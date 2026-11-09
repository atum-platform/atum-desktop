// RETIRED legacy commerce (pre-Matrix app): its Proton sale is removed and the platform switched its wallet spending and rewards off on 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
import { atom } from 'nanostores'

import { parseProtonWallet, type ProtonWallet } from '@/lib/atum-protons'

import { $atumAccountScopeId } from './atum-messaging'

/**
 * One owner-scoped cache for the wallet projection consumed by the account
 * sheet and rail. Main fences the IPC request; this store also refuses a late
 * renderer result after A → B → A account changes.
 */
export type AtumProtonWalletView =
  | { state: 'idle' | 'loading'; accountId: null | string; knownSpendingEnabled: boolean }
  | { state: 'resolved'; accountId: string; knownSpendingEnabled: boolean; wallet: ProtonWallet }
  | { state: 'unavailable'; accountId: string; knownSpendingEnabled: boolean }

export const $atumProtonWallet = atom<AtumProtonWalletView>({
  state: 'idle',
  accountId: $atumAccountScopeId.get(),
  knownSpendingEnabled: false
})

let generation = 0
let inFlight: { generation: number; request: Promise<void> } | null = null

$atumAccountScopeId.listen(accountId => {
  generation += 1
  inFlight = null
  $atumProtonWallet.set({ state: 'idle', accountId, knownSpendingEnabled: false })
})

export function refreshAtumProtonWallet(): Promise<void> {
  if (inFlight?.generation === generation) {
    return inFlight.request
  }

  const accountId = $atumAccountScopeId.get()
  const requestGeneration = generation

  if (!accountId) {
    $atumProtonWallet.set({ state: 'idle', accountId: null, knownSpendingEnabled: false })

    return Promise.resolve()
  }

  const current = $atumProtonWallet.get()
  const knownSpendingEnabled =
    current.accountId === accountId && (current.state === 'resolved' ? current.wallet.spending_enabled : current.knownSpendingEnabled)

  // Preserve only the account-bound mode across a refresh. Ledger values are
  // never reused as fresh financial facts while the authoritative read runs.
  $atumProtonWallet.set({ state: 'loading', accountId, knownSpendingEnabled })

  const request = (window.hermesDesktop?.protons?.wallet() ?? Promise.reject(new Error('proton_wallet_unavailable')))
    .then(value => {
      const wallet = parseProtonWallet(value)

      if (!wallet) {
        throw new Error('proton_wallet_invalid')
      }

      if (requestGeneration === generation && $atumAccountScopeId.get() === accountId) {
        $atumProtonWallet.set({ state: 'resolved', accountId, knownSpendingEnabled: wallet.spending_enabled, wallet })
      }
    })
    .catch(() => {
      if (requestGeneration === generation && $atumAccountScopeId.get() === accountId) {
        $atumProtonWallet.set({ state: 'unavailable', accountId, knownSpendingEnabled })
      }
    })
    .finally(() => {
      if (inFlight?.request === request) {
        inFlight = null
      }
    })

  inFlight = { generation: requestGeneration, request }

  return request
}
