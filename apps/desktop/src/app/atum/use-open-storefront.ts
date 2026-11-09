// RETIRED legacy commerce (pre-Matrix app): its Proton sale is removed and the platform switched its wallet spending and rewards off on 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
import { useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { $atumShellEnabled, $railDestination, type AtumDiscoverShelf, setDiscoverShelf, setRosterDrawerOpen } from '@/store/atum-shell'

import { appViewForPath, NEW_CHAT_ROUTE, PETS_ROUTE } from '../routes'

export interface OpenStorefrontOptions {
  /** Replace the current history entry instead of pushing — for one-shot deep
   *  links (`/pets`) that must never rest in the address bar. */
  replace?: boolean
  /** Runs after the shell state is planted and BEFORE any navigation — the
   *  ordering rule for a caller inside a modal sheet (the assistant editor's
   *  pet picker): set shell state, close the sheet, then navigate. A sheet
   *  left open would float over the storefront, and once the roster collapses
   *  on Discover its unmount would take an open sheet with it. */
  beforeNavigate?: () => void
}

/**
 * The one opener into the storefront. Discover is the store — rail state, not
 * a page — so every "open the store / find people / browse pets" affordance in
 * the app goes through here instead of navigating to a route of its own.
 *
 * ORDERING RULE: set shell state first, navigate second. Within the shell
 * state the rail flips BEFORE the shelf seed, because arriving at Discover
 * reseeds Featured (the `$railDestination.listen` in `store/atum-shell.ts`) —
 * the intent only survives if it is planted after the flip. The roster's
 * invariant ("every roster navigation returns the plate to chat; nothing else
 * may call navigate() from this panel", roster-panel.tsx) depends on the same
 * set-then-navigate shape, as do the existing sites in `skills.ts` and
 * `discover-panel.tsx`.
 *
 * LEGACY SHELL: with the Atum shell off there is no rail and no Discover
 * panel, so the atoms alone would light nothing. The one storefront shelf with
 * a legacy surface is Pets — the `/pets` page — so the opener falls back to
 * navigating there (decision 9 / W6: the Pet Store stays a working page with
 * the Atum shell off).
 *
 * Why a hook and not a store setter: the store layer has no router seam, and
 * from an overlay (Settings…) or a full page (Skills, /pets…) the atom alone
 * would light the rail BEHIND the current view and look broken — the
 * navigation is how an overlay gets out of the way. From chat or a DM the URL
 * is already where Discover shows, so nothing navigates.
 */
export function useOpenStorefront(): (shelf: AtumDiscoverShelf, options?: OpenStorefrontOptions) => void {
  const location = useLocation()
  const navigate = useNavigate()

  return useCallback(
    (shelf, options) => {
      if (!$atumShellEnabled.get()) {
        // Legacy shell: the store is the /pets page, not a rail destination.
        // (Only the Pets shelf has a legacy surface; the shelves that don't
        // are reachable only from Atum-shell chrome, which never lands here.)
        options?.beforeNavigate?.()
        navigate(PETS_ROUTE, options?.replace ? { replace: true } : undefined)

        return
      }

      $railDestination.set('discover')
      setDiscoverShelf(shelf)
      // Below the compact breakpoint the roster is a MODAL drawer over a
      // scrim, and it puts the main column inert. Every opener that lives
      // inside it — the account menu's "Pet Store" and "Find people" — left
      // the drawer and its scrim floating over the storefront it had just
      // Preserve the recovery and user-visible behavior covered by this path.
      // `$sidebarOpen`, the person's preference, is untouched.
      setRosterDrawerOpen(false)
      options?.beforeNavigate?.()

      const view = appViewForPath(location.pathname)

      if (view !== 'chat' && view !== 'dm') {
        navigate(NEW_CHAT_ROUTE, options?.replace ? { replace: true } : undefined)
      }
    },
    [location.pathname, navigate]
  )
}
