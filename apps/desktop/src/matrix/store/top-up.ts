import { atom } from 'nanostores'

import type { MatrixSnapshot } from '../../../shared/matrix'
import { runMatrixCommand } from '../text-document-actions'

import type { MatrixStoreHubRequest } from './hub-skill'

/** The Store's shelves, in the order the shelf row draws them; top-up is opened from the header. */
export type DiscoverShelf = 'featured' | 'agents' | 'skills' | 'pets' | 'apps' | 'purchased' | 'topups'

/**
 * A shelf another surface asked the Store to open (Settings, the account menu, the
 * composer, an out-of-Protons turn). The Store takes it once — on arrival or, when it is
 * already open, as it changes — and clears it, so a later visit starts on Featured.
 */
export const $matrixStoreShelfRequest = atom<DiscoverShelf | null>(null)

/** Exact public listing requested by a person clicking a recommendation. */
export const $matrixStoreListingRequest = atom<string | null>(null)

/**
 * A Hub skill the Store asked to open (a free listing's "Install from Skills Hub"). The window
 * takes it once, opening that assistant's Skills page on the Hub, and clears it; leaving the
 * page comes back to the Store's Skills shelf.
 */
export const $matrixStoreHubRequest = atom<MatrixStoreHubRequest | null>(null)

/** The in-app top-up lives where the Store does: it needs the Store destination and the checkout. */
export function matrixInAppTopUp(snapshot: Pick<MatrixSnapshot, 'apps' | 'checkout'>): boolean {
  return Boolean(snapshot.apps && snapshot.checkout)
}

/**
 * "Top up" means one place everywhere: the Store's own top-up (packs and the QR, without
 * leaving Atum). A build without that checkout keeps Atum's payments page.
 */
export function openMatrixTopUp(snapshot: Pick<MatrixSnapshot, 'apps' | 'checkout'>): Promise<void> {
  if (!matrixInAppTopUp(snapshot)) {
    return window.atumMatrix.openTopUp()
  }

  $matrixStoreShelfRequest.set('topups')

  return runMatrixCommand({ kind: 'discoverApps' }).then(
    () => undefined,
    error => {
      $matrixStoreShelfRequest.set(null)
      throw error
    }
  )
}
