import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect } from 'react'

import { $atumShellEnabled } from '@/store/atum-shell'

import { useOpenStorefront } from './use-open-storefront'

/**
 * `/pets` is a one-shot deep link, never a resting URL. Under the Atum shell,
 * arriving here opens the storefront on the Pets shelf — rail first, shelf
 * intent second, then a REPLACE back to the chat route, so the address bar
 * never rests on `/pets` and two navigation systems never stay alive at once.
 * (It also keeps `$workspaceIsPage` honest for free: the composer keys that
 * flag gates can't go stale while the storefront shows.)
 *
 * Rollback path: with `$atumShellEnabled` off there is no rail at all, so the
 * legacy shell keeps rendering the Pet Store workspace page exactly as it
 * always has.
 */
export function PetsAppView({ legacyPage }: { legacyPage: ReactNode }) {
  const shellEnabled = useStore($atumShellEnabled)
  const openStorefront = useOpenStorefront()

  useEffect(() => {
    if (shellEnabled) {
      openStorefront('pets', { replace: true })
    }
  }, [openStorefront, shellEnabled])

  return shellEnabled ? null : <>{legacyPage}</>
}
