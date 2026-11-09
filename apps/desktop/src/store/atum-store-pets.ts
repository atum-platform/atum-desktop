// RETIRED legacy commerce (pre-Matrix app): its Proton sale is removed and the platform switched its wallet spending and rewards off on 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
import { computed } from 'nanostores'

import { $atumStoreCatalog } from './atum-store-catalog'
import { $petGallery, mergeStorePetRows } from './pet-gallery'

/**
 * The pets the storefront shelves render: the gateway gallery merged with the
 * store catalog (see `mergeStorePetRows` in `./pet-gallery` for the rules).
 *
 * This is its own module so `pet-gallery` — and the surfaces that only manage
 * pets — never import the account-scoped store chain. The catalog store resets
 * itself on an account hand-off, so a view read here always belongs to the
 * account in front.
 */
export const $storePetRows = computed([$petGallery, $atumStoreCatalog], (gallery, storeView) =>
  // The catalog has answered when it holds rows (ready, or stale over a warm
  // cache). Signed out (no account scope) there is no store to answer, so the
  // gallery stands on its own; with an account but no catalog yet — idle,
  // loading, error — a bundled pet's price is unknown and fails closed.
  mergeStorePetRows(gallery, storeView.catalog, storeView.accountId === null || storeView.catalog !== null)
)
