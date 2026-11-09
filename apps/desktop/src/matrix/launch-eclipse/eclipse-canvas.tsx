import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useAppViewOverlayHold } from '@/store/use-app-view-overlay'

import {
  advanceEclipse,
  createEclipse,
  type EclipseDirection,
  eclipseFrame,
  type EclipseInputs,
  type EclipsePoint,
  MARK
} from './engine'
import { createEclipseRenderer, type EclipseRenderer } from './renderer'

/** The sun is 35.556% of the hero box (the brand's ratios, as the CSS hero has them). */
const HERO_SUN = 0.35556
/** Physics steps at a fixed rate, whatever the display's refresh. */
const STEP = 1 / 240

/** What drives the picture this frame; where it rests and lands are measured here. */
export type EclipseFacts = Omit<EclipseInputs, 'home' | 'dest'>

function homeOf(box: HTMLElement | null): EclipsePoint | null {
  const rect = box?.getBoundingClientRect()

  return rect?.width ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, r: (rect.width * HERO_SUN) / 2 } : null
}

/** A mark on screen the eclipse lands on (its round face fills the element). */
function pointOf(selector: string): EclipsePoint | undefined {
  const rect = window.document.querySelector<HTMLElement>(selector)?.getBoundingClientRect()

  return rect?.width ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, r: rect.width / 2 / MARK.face } : undefined
}

/**
 * The live eclipse: the hero box keeps its place in the layout, and a canvas over the window
 * draws the eclipse there and carries it to the mark it lands on (`landOn`), which waits hidden
 * (styles.css) until the eclipse dissolves into it. Where WebGL is missing or lost, `fallback`
 * stands in. Shared by the launch and the first-launch story, so both are one piece of motion.
 */
export function EclipseCanvas({
  className,
  direction,
  facts,
  fallback,
  landOn,
  layer
}: {
  className?: string
  direction: EclipseDirection
  /** Read every frame, so a parent can script the facts by time without re-rendering. */
  facts: () => EclipseFacts
  fallback: ReactNode
  /** The selector of the mark to land on, measured once as the flight begins. */
  landOn: string
  /** The canvas's stacking layer: just above the overlay it belongs to (styles.css default 1201). */
  layer?: number
}) {
  // The canvas covers the window: any native app view steps aside while it is up.
  useAppViewOverlayHold()
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const read = useRef(facts)
  const [failed, setFailed] = useState(false)

  read.current = facts

  useLayoutEffect(() => {
    const node = canvas.current
    const renderer: EclipseRenderer | null = node ? createEclipseRenderer(node) : null

    if (!node || !renderer) {
      setFailed(true)

      return
    }

    const state = createEclipse(direction, read.current().reduced)
    const root = window.document.documentElement
    root.dataset.atumLaunchMark = 'hidden'
    let raf = 0
    let last = performance.now()
    let dest: EclipsePoint | undefined
    let size = ''

    const frame = (now: number) => {
      const width = window.innerWidth
      const height = window.innerHeight
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const key = `${width}x${height}@${ratio}`

      if (key !== size) {
        size = key
        renderer.resize(width, height, ratio)
      }

      const home = homeOf(box.current)
      const now_ = read.current()

      // The mark is measured once, as the flight begins: the screen under it is laid out by then.
      if (now_.phase === 'leaving' && !dest) {
        dest = pointOf(landOn)
      }

      if (home) {
        // Catch up with the clock however few frames arrive (a launch is when the Mac is busiest):
        // the timers around the picture run on the clock, so the picture must keep pace.
        let left = Math.min(0.5, Math.max(0, now - last) / 1000)

        while (left > 1e-6) {
          const dt = Math.min(STEP, left)
          advanceEclipse(state, dt, { ...read.current(), home, dest: now_.phase === 'leaving' ? dest : undefined })
          left -= dt
        }

        if (now_.phase === 'leaving' && (state.landing || now_.reduced || !dest)) {
          delete root.dataset.atumLaunchMark
        }

        const picture = eclipseFrame(state, now_)
        node.style.opacity = picture.opacity.toFixed(3)
        renderer.draw(picture)
      }

      last = now
      raf = requestAnimationFrame(frame)
    }

    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      renderer.dispose()
      delete root.dataset.atumLaunchMark
    }
  }, [direction, landOn])

  // A lost GPU context: the fallback takes over rather than leaving a blank night.
  useEffect(() => {
    const node = canvas.current

    if (!node) {
      return
    }

    const lost = (event: Event) => {
      event.preventDefault()
      setFailed(true)
    }

    node.addEventListener('webglcontextlost', lost)

    return () => node.removeEventListener('webglcontextlost', lost)
  }, [])

  if (failed) {
    return <>{fallback}</>
  }

  // The canvas covers the window from the document's root: an animated (transformed) ancestor
  // would otherwise pin a fixed canvas to itself instead of the window.
  return (
    <div aria-hidden className={className ?? 'atum-launch-hero'} data-launch-eclipse ref={box}>
      {createPortal(
        <canvas aria-hidden className="atum-launch-eclipse-canvas" ref={canvas} style={layer ? { zIndex: layer } : undefined} />,
        window.document.body
      )}
    </div>
  )
}
