import { useStore } from '@nanostores/react'

import { useI18n } from '@/i18n'
import { $railDestination } from '@/store/atum-shell'

import { AtumNavSwitchSurface } from './shell-surface'

export { AtumNavSwitchSurface } from './shell-surface'

/**
 * The shell's meta-navigation: Home is the chat shell, Discover is everything
 * you can add to Atum, Workplace is drawn, disabled, coming soon.
 *
 * It is rendered once in the shell's narrow, persistent left rail. The rail
 * stays put while the roster collapses, a workspace takes the remainder of
 * the frame, or a compact roster drawer opens — destination controls never
 * become a floating bottom pill.
 */
export function AtumNavSwitch({ tray = false }: { tray?: boolean } = {}) {
  const { t } = useI18n()
  const destination = useStore($railDestination)
  const copy = t.atum.nav

  return (
    <AtumNavSwitchSurface
      ariaLabel={copy.aria}
      destination={destination}
      discoverLabel={copy.discover}
      homeLabel={copy.home}
      onDestinationChange={next => {
        // This shell has not opted into Workplace. Keep its persisted rail
        // vocabulary unchanged while Matrix supplies a native pages host.
        if (next === 'chat' || next === 'discover') {
          $railDestination.set(next)
        }
      }}
      surfaceCopy={t.surfaces}
      tray={tray}
      workplaceSoonLabel={copy.workplaceSoon}
    />
  )
}
