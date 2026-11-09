import { useEffect, useMemo, useRef, useState } from 'react'

import type { Ledge } from '@/components/pet/roam-geometry'
import type { RoamSurface } from '@/components/pet/use-pet-roam'

/** Must match the overlay root's `paddingBottom`. */
const PET_PADDING_BOTTOM = 24

/** How often the desktop's walkable geometry is re-measured, ms. */
const SURFACE_REFRESH_MS = 4000

/**
 * Moving a window is a main-process round trip, unlike a CSS transform. The
 * wander walks at roughly 46 px/s at the default scale, so a commit every 33ms
 * moves it ~1.5px — indistinguishable from per-frame, at a fraction of the IPC.
 */
const COMMIT_MS = 33

interface ScreenRoamOptions {
  /** On-screen size of the sprite. */
  petW: number
  petH: number
  /** Skip the work entirely when the pet is not roaming. */
  enabled: boolean
}

/**
 * A `RoamSurface` for the popped-out pet: the whole desktop.
 *
 * The in-window pet walks a `<div>` around the app's DOM. Out here the pet is
 * fixed inside its own transparent window and it is the WINDOW that moves, so
 * this translates between the two: "where is the pet" is the window's origin
 * plus the sprite's offset within it, and "put the pet here" is a `setBounds`.
 *
 * Ledges come from the main process (displays, the Dock, the app's title bar)
 * and are cached, because the wander asks for them synchronously mid-beat while
 * the IPC that produces them is async.
 */
export function useScreenRoam({ petW, petH, enabled }: ScreenRoamOptions): null | RoamSurface {
  const [ready, setReady] = useState(false)
  const ledgesRef = useRef<Ledge[]>([])
  const lastCommit = useRef(0)
  const pending = useRef<null | { x: number; y: number }>(null)

  // Keep the geometry fresh: displays get plugged in, the Dock hides, the app
  // window moves. Cheap enough to poll, and polling means no subscription to
  // leak when the overlay closes.
  useEffect(() => {
    if (!enabled) {
      return
    }

    let cancelled = false

    const pull = async () => {
      try {
        const result = await window.hermesDesktop?.petOverlay?.surfaces({ petH, petW })

        if (!cancelled && result?.ledges) {
          ledgesRef.current = result.ledges.map(l => ({ left: l.left, right: l.right, y: l.y }))
          setReady(ledgesRef.current.length > 0)
        }
      } catch {
        // Cosmetic: an unavailable surface just means the pet stays put.
      }
    }

    void pull()

    const timer = window.setInterval(() => void pull(), SURFACE_REFRESH_MS)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [enabled, petW, petH])

  return useMemo(() => {
    if (!enabled || !ready) {
      return null
    }

    // The sprite sits bottom-centred in its window, so the window origin and the
    // pet's screen position differ by a fixed inset.
    const insetX = () => (window.innerWidth - petW) / 2
    const insetY = () => window.innerHeight - PET_PADDING_BOTTOM - petH

    return {
      ledges: () => ledgesRef.current,
      read: () => ({ x: window.screenX + insetX(), y: window.screenY + insetY() }),
      write: point => {
        pending.current = point

        const now = performance.now()

        if (now - lastCommit.current < COMMIT_MS) {
          return
        }

        lastCommit.current = now
        const next = pending.current
        pending.current = null

        window.hermesDesktop?.petOverlay?.setBounds({
          height: window.innerHeight,
          width: window.innerWidth,
          x: Math.round(next.x - insetX()),
          y: Math.round(next.y - insetY())
        })
      }
    }
  }, [enabled, ready, petW, petH])
}
