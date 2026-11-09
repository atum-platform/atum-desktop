import type { CSSProperties } from 'react'

import { LAUNCH_STEPS } from './launch-progress'

export type LaunchPhase = 'checking' | 'blocked' | 'lit' | 'leaving'

/**
 * Each check is an electron (the approved welcome motion, "Atum welcome motion" design
 * artifact): which of the three orbits it rides, and whether it starts half a turn on.
 */
const ELECTRONS: ReadonlyArray<{ ring: 0 | 1 | 2; half: boolean }> = [
  { ring: 0, half: false },
  { ring: 1, half: false },
  { ring: 2, half: false },
  { ring: 0, half: true },
  { ring: 1, half: true }
]

/** Where each settled check rests: a pentagon on the corona, in % of the 540 hero box. */
const POINTS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 50, y: 28.148 },
  { x: 70.778, y: 43.241 },
  { x: 62.852, y: 67.685 },
  { x: 37.148, y: 67.685 },
  { x: 29.222, y: 43.241 }
]

/** The bead of the mark (the diamond ring), where the settled checks converge. */
const BEAD = { x: 60.926, y: 39.074 }

export interface LaunchFlight {
  x: number
  y: number
  scale: number
}

/**
 * The eclipse: sun, moon, corona and rays, three orbits, and one electron per launch check.
 * A passed check leaves its orbit and rests on the corona; a blocked one stops where it is.
 * When all have passed they converge into the bead, the ring flashes, and the eclipse
 * flies to the mark in the chat's header. Only opacity and transform animate.
 */
export function LaunchHero({
  current,
  flight,
  phase,
  settled
}: {
  /** The running (or blocked) check. */
  current: number
  flight?: LaunchFlight
  phase: LaunchPhase
  /** How many checks have passed. */
  settled: number
}) {
  const style = flight
    ? ({
        '--atum-launch-fly-x': `${flight.x}px`,
        '--atum-launch-fly-y': `${flight.y}px`,
        '--atum-launch-fly-scale': flight.scale
      } as CSSProperties)
    : undefined

  return (
    <div aria-hidden className="atum-launch-hero" data-phase={phase} style={style}>
      <div className="atum-launch-corona" />
      <div className="atum-launch-rays">
        <i />
      </div>
      <svg className="atum-launch-orbits" viewBox="0 0 540 540">
        <ellipse cx="270" cy="270" rx="262" ry="78" />
        <ellipse cx="270" cy="270" rx="262" ry="78" transform="rotate(60 270 270)" />
        <ellipse cx="270" cy="270" rx="262" ry="78" transform="rotate(-60 270 270)" />
      </svg>
      {ELECTRONS.map(({ half, ring }, index) => (
        <div
          className="atum-launch-track"
          data-half={half || undefined}
          data-ring={ring}
          data-state={index < settled ? 'settled' : index === current && phase === 'blocked' ? 'halted' : 'orbiting'}
          key={LAUNCH_STEPS[index]}
        >
          {(['lead', 'trail', 'tail'] as const).map(part => (
            <div className="atum-launch-x" data-part={part} key={part}>
              <div className="atum-launch-y">
                <i className="atum-launch-electron" />
              </div>
            </div>
          ))}
        </div>
      ))}
      {POINTS.map((point, index) => (
        <span
          className="atum-launch-point"
          data-on={index < settled || undefined}
          key={LAUNCH_STEPS[index]}
          style={
            {
              left: `${point.x}%`,
              top: `${point.y}%`,
              // The way to the bead, as a share of the hero's size (CSS multiplies it out).
              '--atum-launch-to-x': (BEAD.x - point.x) / 100,
              '--atum-launch-to-y': (BEAD.y - point.y) / 100
            } as CSSProperties
          }
        />
      ))}
      {/* The ring's flash stays where it happened; the mark itself flies. */}
      <div className="atum-launch-glow">
        <div className="atum-launch-ripple" />
        <div className="atum-launch-ripple" data-late />
        <div className="atum-launch-flare">
          <b />
          <b data-vertical />
        </div>
      </div>
      <div className="atum-launch-eclipse">
        <div className="atum-launch-sun" />
        <div className="atum-launch-moon" />
        <div className="atum-launch-bead" />
      </div>
    </div>
  )
}
