import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { PetHeartField, playVibeHearts } from '@/components/chat/vibe-hearts'
import { PetBubble } from '@/components/pet/pet-bubble'
import { PetSprite, roamWalkRow } from '@/components/pet/pet-sprite'
import { usePetRoam } from '@/components/pet/use-pet-roam'
import { usePetSleep } from '@/components/pet/use-pet-sleep'
import { type PetZoomAnchor, usePetZoomGesture } from '@/components/pet/use-pet-zoom-gesture'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { useI18n } from '@/i18n'
import { AppWindow, EyeOff, Mail, PawPrint, Settings } from '@/lib/icons'
import { $petActivity, $petInfo, petDrawScale, playPetGesture, setPetInfo } from '@/store/pet'
import { $petAtRest, $petRoam, $petRoamDir } from '@/store/pet'
import { overlayWindowSize } from '@/store/pet-overlay'
import { setAwaitingResponse, setBusy } from '@/store/session'

import { useScreenRoam } from './use-screen-roam'


// Fallbacks mirror pet-sprite's defaults; the gateway normally sends real values.
const DEFAULT_FRAME_W = 192
const DEFAULT_FRAME_H = 208

// Must match the root's paddingBottom — the sprite renders bottom-centered, this
// many px above the window's bottom edge. Used to anchor the resize.
const PET_PADDING_BOTTOM = 24
// The `carried` row holds while a drag lasts; the release clears it.
const CARRIED_HOLD_MS = 10 * 60_000

// A sprite pixel counts as "solid" (interactive) at/above this alpha (0-255).
// Low enough to catch anti-aliased edges, high enough that the faint halo around
// the art still clicks through.
const ALPHA_HIT_THRESHOLD = 16

/**
 * The pop-out overlay's only view: a transparent, draggable mascot with a mini
 * composer.
 *
 * This runs in a separate, gateway-less BrowserWindow (`?win=overlay`). It is a
 * pure puppet — the main renderer pushes the live pet state over IPC and we
 * mirror it into the same atoms the in-window pet reads, so `PetSprite` /
 * `PetBubble` render identically with zero extra logic.
 *
 * The window is a full rectangle but mostly transparent; we toggle OS-level
 * mouse click-through so only the sprite (or the open composer) is interactive
 * and the empty margins pass clicks through to whatever is behind.
 *
 * Gestures on the pet: drag to move it anywhere on screen (even outside the
 * app), shift-click to pop it back into the window, single-click to open a small
 * composer, double-click to toggle the app window (minimize ↔ restore). A mail
 * icon (shown only when a turn finished while you were away) raises the app on
 * the most recent thread.
 */

// Below this much pointer travel, a press counts as a click, not a drag.
const CLICK_SLOP_PX = 3
// A second click within this window is a double-click (raise app) and cancels
// the deferred single-click (open composer), so a double never flashes it open.
const DOUBLE_CLICK_MS = 250

interface DragState {
  startX: number
  startY: number
  offX: number
  offY: number
  width: number
  height: number
  moved: boolean
}

export function PetOverlayApp() {
  const { t } = useI18n()
  const info = useStore($petInfo)
  const roamEnabled = useStore($petRoam)
  const atRest = useStore($petAtRest)
  const roamDir = useStore($petRoamDir)
  const [composerOpen, setComposerOpen] = useState(false)
  // Right-click menu. Like the composer it must suspend click-through: the menu
  // paints over the transparent margin, where a pixel-alpha hit test says
  // "nothing here" and the OS would send the click straight past it.
  const [menuOpen, setMenuOpen] = useState(false)
  const [draft, setDraft] = useState('')
  // Mirrored from the main renderer: a finish landed while you were away.
  const [unread, setUnread] = useState(false)

  const dragRef = useRef<DragState | null>(null)
  // Last Alt+wheel anchor, consumed by the resize effect to zoom toward the
  // cursor; null means a non-wheel scale change (slider) → anchor bottom-center.
  const zoomAnchorRef = useRef<PetZoomAnchor | null>(null)
  const petRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // Last mirrored reaction id — a bump means the main window fired a reaction.
  const lastReactionRef = useRef<number | null>(null)
  const ignoreRef = useRef(true)
  const composerOpenRef = useRef(false)
  const menuOpenRef = useRef(false)
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const setIgnore = (ignore: boolean) => {
    if (ignoreRef.current !== ignore) {
      ignoreRef.current = ignore
      window.hermesDesktop?.petOverlay?.setIgnoreMouse(ignore)
    }
  }

  // Mirror pushed state into the shared atoms so PetSprite/PetBubble just work.
  useEffect(() => {
    const off = window.hermesDesktop?.petOverlay?.onState(payload => {
      setPetInfo(payload.info)
      $petActivity.set(payload.activity ?? {})
      setBusy(Boolean(payload.busy))
      setAwaitingResponse(Boolean(payload.awaiting))
      setUnread(Boolean(payload.unread))

      // Play a reaction on a new id (ignore the first sync, which just primes it).
      const reaction = payload.reaction ?? null

      if (lastReactionRef.current === null) {
        lastReactionRef.current = reaction?.id ?? 0
      } else if (reaction && reaction.id > lastReactionRef.current) {
        lastReactionRef.current = reaction.id

        if (reaction.kind === 'vibe') {
          playVibeHearts()
        }
      }
    })

    // Tell the main renderer we're mounted so it pushes the current frame (the
    // subscribe-time pushes during open() can land before this view exists).
    window.hermesDesktop?.petOverlay?.control({ type: 'ready' })

    return off
  }, [])

  // Click-through: make only the *solid* sprite pixels (plus the bubble / mail
  // button / open composer) interactive — clicks on the transparent rectangle
  // around the art pass through to whatever's behind. With ignore+forward, the
  // renderer still receives mousemove so we can re-arm the moment the cursor
  // returns to a solid pixel.
  useEffect(() => {
    setIgnore(true)

    // True when the point sits on a solid sprite pixel or on the pet's other
    // interactive chrome (bubble, mail button). Over the canvas we sample the
    // rendered alpha; elsewhere inside the pet (bubble/button) we trust DOM
    // hit-testing. Anything else is transparent backdrop.
    const isInteractiveAt = (x: number, y: number): boolean => {
      const pet = petRef.current
      const target = document.elementFromPoint(x, y)

      if (!pet || !target || !pet.contains(target)) {
        return false
      }

      if (!(target instanceof HTMLCanvasElement)) {
        return true
      }

      const rect = target.getBoundingClientRect()

      if (rect.width === 0 || rect.height === 0) {
        return true
      }

      const ctx = target.getContext('2d')

      if (!ctx) {
        return true
      }

      const px = Math.floor((x - rect.left) * (target.width / rect.width))
      const py = Math.floor((y - rect.top) * (target.height / rect.height))

      try {
        return ctx.getImageData(px, py, 1, 1).data[3] >= ALPHA_HIT_THRESHOLD
      } catch {
        // Tainted/zero-size read — fail open so the pet stays grabbable.
        return true
      }
    }

    const onMove = (ev: MouseEvent) => {
      if (dragRef.current || composerOpenRef.current || menuOpenRef.current) {
        setIgnore(false)

        return
      }

      setIgnore(!isInteractiveAt(ev.clientX, ev.clientY))
    }

    window.addEventListener('mousemove', onMove)

    return () => {
      window.removeEventListener('mousemove', onMove)
      clearTimeout(clickTimerRef.current)
    }
  }, [])

  // The whole window must stay interactive while the composer is open (so the
  // input keeps focus); focus it on open. The overlay is a non-activating panel
  // (so it never steals the app's cmd/alt-tab anchor) — flip it focusable while
  // the composer needs the keyboard, then back to non-activating when it closes.
  useEffect(() => {
    composerOpenRef.current = composerOpen
    menuOpenRef.current = menuOpen

    // The context menu needs the same treatment as the composer: a
    // non-activating panel cannot take keyboard focus, so Escape and arrow keys
    // would do nothing and the menu would only close by clicking away.
    const modal = composerOpen || menuOpen
    window.hermesDesktop?.petOverlay?.setFocusable(modal)

    if (modal) {
      setIgnore(false)
    }

    if (composerOpen) {
      // The OS window has to become key first (setFocusable + focus happen in
      // the main process), so focus the input on the next frame.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [composerOpen, menuOpen])

  const onPetPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) {
      return
    }

    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    dragRef.current = {
      height: window.outerHeight,
      moved: false,
      offX: e.screenX - window.screenX,
      offY: e.screenY - window.screenY,
      startX: e.screenX,
      startY: e.screenY,
      width: window.outerWidth
    }
    // Picked up (v4 `carried` row; a sheet without it draws idle).
    playPetGesture('carried', CARRIED_HOLD_MS)
  }

  const onPetPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current

    if (!drag) {
      return
    }

    if (Math.hypot(e.screenX - drag.startX, e.screenY - drag.startY) > CLICK_SLOP_PX) {
      drag.moved = true
    }

    window.hermesDesktop?.petOverlay?.setBounds({
      height: drag.height,
      width: drag.width,
      x: e.screenX - drag.offX,
      y: e.screenY - drag.offY
    })
  }

  const onPetPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current
    dragRef.current = null
    ;(e.target as Element).releasePointerCapture?.(e.pointerId)

    if (!drag) {
      return
    }

    playPetGesture(null, 0) // put down

    if (drag.moved) {
      // A drag cancels any deferred single-click so the composer can't pop open
      // after you reposition the pet.
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = undefined

      // Remember the spot on the desktop (screen coords) so the pet reopens here
      // next time / after a restart.
      window.hermesDesktop?.petOverlay?.control({
        bounds: { height: drag.height, width: drag.width, x: e.screenX - drag.offX, y: e.screenY - drag.offY },
        type: 'bounds'
      })

      return
    }

    // Shift-click always pops the pet back in (no double-click ambiguity).
    if (e.shiftKey) {
      window.hermesDesktop?.petOverlay?.control({ type: 'pop-in' })

      return
    }

    // Double-click toggles the app window (minimize ↔ restore); defer the
    // single-click composer toggle so a double never flashes the composer open.
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = undefined
      window.hermesDesktop?.petOverlay?.control({ type: 'toggle-app' })

      return
    }

    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = undefined
      setComposerOpen(open => !open)
    }, DOUBLE_CLICK_MS)
  }

  const send = () => {
    const text = draft.trim()

    if (text) {
      window.hermesDesktop?.petOverlay?.control({ text, type: 'submit' })
    }

    setDraft('')
    setComposerOpen(false)
  }

  const openApp = () => {
    // Hide the icon immediately; the main renderer also clears the source flag.
    setUnread(false)
    window.hermesDesktop?.petOverlay?.control({ type: 'open-app' })
  }

  // Alt+wheel over the popped-out pet resizes it. The overlay has no gateway,
  // so paint the new scale locally for instant feedback, then ask the main
  // renderer to persist it (it pushes the reconciled scale back). Stash the
  // cursor anchor for the resize effect; the window itself is grown to fit there.
  const onScale = useCallback((next: number, anchor: PetZoomAnchor) => {
    zoomAnchorRef.current = anchor
    setPetInfo({ ...$petInfo.get(), scale: next })
    window.hermesDesktop?.petOverlay?.control({ scale: next, type: 'scale' })
  }, [])

  usePetZoomGesture(petRef, onScale, Boolean(info.enabled && info.spritesheetBase64))

  // Grow/shrink the OS overlay window to fit the pet at its current scale so the
  // sprite is never cropped — covers both the wheel gesture here and a scale
  // changed from the app's settings slider (pushed in as a state update). With a
  // wheel anchor we zoom toward the cursor (keep the pixel under it fixed);
  // otherwise we anchor the bottom-center (the pet's feet stay planted). New
  // bounds are persisted so the pet reopens at the right size.
  useEffect(() => {
    if (!info.enabled || !info.spritesheetBase64) {
      return
    }

    const { width, height } = overlayWindowSize(
      info.frameW ?? DEFAULT_FRAME_W,
      info.frameH ?? DEFAULT_FRAME_H,
      petDrawScale(info)
    )

    const curW = window.outerWidth
    const curH = window.outerHeight

    if (width === curW && height === curH) {
      zoomAnchorRef.current = null

      return
    }

    const anchor = zoomAnchorRef.current
    zoomAnchorRef.current = null

    // The sprite scales about its bottom-center, at window-local (curW/2,
    // curH - paddingBottom). Hold the anchor pixel fixed on screen as it scales;
    // with no wheel anchor we pin the bottom-center itself (ratio 1 ⇒ no shift).
    const ratio = anchor?.ratio ?? 1
    const ax = anchor?.clientX ?? curW / 2
    const ay = anchor?.clientY ?? curH - PET_PADDING_BOTTOM

    const bounds = {
      height,
      width,
      x: Math.round(window.screenX + ax - (ax - curW / 2) * ratio - width / 2),
      y: Math.round(window.screenY + ay - (ay - (curH - PET_PADDING_BOTTOM)) * ratio - (height - PET_PADDING_BOTTOM))
    }

    window.hermesDesktop?.petOverlay?.setBounds(bounds)
    window.hermesDesktop?.petOverlay?.control({ bounds, type: 'bounds' })
  }, [info.enabled, info.spritesheetBase64, info.scale, info.size, info.frameW, info.frameH])

  // Wander the desktop. The same loop as the in-window pet, pointed at a surface
  // made of the screen's real geometry rather than the app's DOM: she walks the
  // floor above the Dock, climbs onto the app's title bar, and crosses to a
  // second display.
  const petW = (info.frameW ?? DEFAULT_FRAME_W) * petDrawScale(info)
  const petH = (info.frameH ?? DEFAULT_FRAME_H) * petDrawScale(info)
  const roamActive = roamEnabled && atRest && !composerOpen
  const surface = useScreenRoam({ enabled: roamActive, petH, petW })
  const walk = roamWalkRow(roamDir, info.stateRows)

  // Both callbacks MUST be stable. `usePetRoam` lists them in its effect deps,
  // and this component re-renders on every state push from the main window — an
  // inline arrow would tear the wander down and restart it several times a
  // second, resetting her to a fresh pause before she could ever plan a move.
  // That is exactly what kept her standing still on the Dock.
  const noCommit = useCallback(() => {}, [])
  const isDragging = useCallback(() => dragRef.current !== null, [])

  usePetRoam({
    commit: noCommit,
    enabled: roamActive && Boolean(surface),
    isInteracting: isDragging,
    loopMs: info.loopMs ?? 1100,
    overlayOpen: false,
    petH,
    petW,
    surface: surface ?? undefined
  })

  // A long idle of the person's and she sleeps (v4 `sleep` row); any
  // movement wakes her.
  usePetSleep({ enabled: Boolean(info.enabled && info.spritesheetBase64) })

  if (!info.enabled || !info.spritesheetBase64) {
    return null
  }

  return (
    <div
      // Carries the Atum palette into this window: the tokens are scoped to the
      // shell root, which the overlay has no part of (see styles.css).
      className="atum-pet-surface"
      onPointerDown={e => {
        // Click on the transparent backdrop (not the pet/composer) dismisses
        // the composer.
        if (composerOpen && e.target === e.currentTarget) {
          setComposerOpen(false)
        }
      }}
      style={{
        alignItems: 'center',
        background: 'transparent',
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        justifyContent: 'flex-end',
        paddingBottom: PET_PADDING_BOTTOM,
        userSelect: 'none',
        width: '100vw'
      }}
    >
      {composerOpen && (
        <input
          className="atum-pet-glass atum-pet-composer"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            } else if (e.key === 'Escape') {
              setComposerOpen(false)
            }
          }}
          placeholder={t.atum.pet.composerPlaceholder}
          ref={inputRef}
          style={{ fontSize: 12, marginBottom: 8, padding: '7px 12px', width: 196 }}
          value={draft}
        />
      )}

      <ContextMenu onOpenChange={setMenuOpen}>
        <ContextMenuTrigger asChild>
          <div
            onPointerDown={onPetPointerDown}
            onPointerMove={onPetPointerMove}
            onPointerUp={onPetPointerUp}
            ref={petRef}
            style={{
              alignItems: 'center',
              cursor: 'grab',
              display: 'flex',
              flexDirection: 'column',
              position: 'relative',
              touchAction: 'none'
            }}
          >
            <div style={{ marginBottom: 4 }}>
              <PetBubble />
            </div>
            {/* Face the way she is walking. Without this the desktop wander plays
                the in-place run row and she moonwalks across the screen. */}
            <div
              style={{
                lineHeight: 0,
                position: 'relative',
                transform: roamDir !== 0 && walk.mirror ? 'scaleX(-1)' : 'none'
              }}
            >
              <PetSprite info={info} rowOverride={walk.row} />

              {/* Hearts on the popped-out pet — identical to in-window. */}
              <PetHeartField petH={petH} petW={petW} />

              {/* Mail icon: only when a finish landed while you were away. Jumps to
                  the app's most recent thread. Anchored to the sprite (kept inside
                  its box so the overlay's click-through hit-test still catches it);
                  stopPropagation keeps a click from starting a window drag. */}
              {unread && (
                <button
                  aria-label="Open in Atum"
                  onClick={openApp}
                  onPointerDown={e => e.stopPropagation()}
                  onPointerUp={e => e.stopPropagation()}
                  style={{
                    alignItems: 'center',
                    background: 'var(--ui-bg-elevated)',
                    border: '1px solid var(--ui-stroke-secondary)',
                    borderRadius: 999,
                    boxShadow: '0 4px 14px rgba(0,0,0,0.22)',
                    color: 'var(--foreground)',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    height: 24,
                    justifyContent: 'center',
                    padding: 0,
                    position: 'absolute',
                    right: 0,
                    top: 0,
                    width: 24
                  }}
                  title="Open in Atum"
                  type="button"
                >
                  <Mail style={{ height: 13, width: 13 }} />
                </button>
              )}
            </div>
          </div>
        </ContextMenuTrigger>
        {/* The in-window pet's menu, mirrored. "Put back" is the same verb as a
            shift-click; "Hide" turns the pet off everywhere (the main renderer
            owns that write — this window has no gateway). */}
        <ContextMenuContent className="w-52">
          <ContextMenuItem onSelect={() => window.hermesDesktop?.petOverlay?.control({ type: 'pop-in' })}>
            <AppWindow aria-hidden />
            {t.atum.pet.putBack}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => window.hermesDesktop?.petOverlay?.control({ type: 'hide' })}>
            <EyeOff aria-hidden />
            {t.atum.pet.hide}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => window.hermesDesktop?.petOverlay?.control({ type: 'store' })}>
            <PawPrint aria-hidden />
            {t.atum.pet.store}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => window.hermesDesktop?.petOverlay?.control({ type: 'settings' })}>
            <Settings aria-hidden />
            {t.atum.pet.settings}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}
