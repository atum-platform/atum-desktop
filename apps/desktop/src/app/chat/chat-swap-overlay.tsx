import { useEffect, useState } from 'react'

import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import type { ProfileInfo } from '@/types/hermes'

/**
 * What to call the backend being woken.
 *
 * This overlay is the one place a swap is visible, so it must say the
 * assistant's NAME rather than the filesystem slug its profile is stored
 * under — "Waking up Trợ lý Marketing…", never "Waking up tro-ly-marketing…".
 * A profile made by hand has no display name and keeps its key, which is what
 * the stock Hermes shell has always shown.
 */
export function swapProfileLabel(profile: null | string, profiles: readonly ProfileInfo[]): null | string {
  if (!profile) {
    return null
  }

  return profiles.find(entry => entry.name.trim() === profile)?.display_name?.trim() || profile
}

// Braille spinner frames — reads as a tiny ASCII loader in monospace.
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// Shown over the conversation while the live gateway swaps to another profile's
// backend (lazily spawned). Keeps the last profile name through the fade-out so
// the label doesn't blank. Purely visual — pointer-events-none.
export function ChatSwapOverlay({ profile }: { profile: string | null }) {
  const { t } = useI18n()
  const [frame, setFrame] = useState(0)
  const [label, setLabel] = useState<null | string>(profile)

  useEffect(() => {
    if (profile) {
      setLabel(profile)
    }
  }, [profile])

  useEffect(() => {
    if (!profile) {
      return
    }

    const id = window.setInterval(() => setFrame(value => (value + 1) % FRAMES.length), 80)

    return () => window.clearInterval(id)
  }, [profile])

  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 z-50 flex items-center justify-center transition-opacity duration-150 ease-out',
        profile ? 'opacity-100' : 'opacity-0'
      )}
    >
      <div className="flex items-center gap-2 bg-[color-mix(in_srgb,var(--dt-card)_92%,transparent)] px-4 py-2 font-mono text-[0.8125rem] text-foreground shadow-composer">
        <span className="w-3 text-(--ui-accent)">{FRAMES[frame]}</span>
        {t.composer.wakingProfile(label ?? '')}
      </div>
    </div>
  )
}
