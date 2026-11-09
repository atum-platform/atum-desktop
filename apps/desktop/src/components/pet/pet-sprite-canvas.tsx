import { memo, useEffect, useMemo, useRef } from 'react'

import { petDrawScale, type PetInfo, type PetState } from '../../../shared/pet'

const DEFAULT_FRAME_W = 192
const DEFAULT_FRAME_H = 208
const DEFAULT_FRAMES = 6
const DEFAULT_LOOP_MS = 1100
// The shortest wait between cells, whatever the tempo: a fast loop still never spins.
const MIN_STEP_MS = 16
const IMAGE_POLL_MS = 50

// Mirrors agent.pet.constants.CODEX_STATE_ROWS (Petdex current taxonomy).
export const DEFAULT_STATE_ROWS = [
  'idle',
  'running-right',
  'running-left',
  'waving',
  'jumping',
  'failed',
  'waiting',
  'running',
  'review'
]

const STATE_ALIASES: Record<PetState, string[]> = {
  idle: ['idle'],
  wave: ['wave', 'waving'],
  jump: ['jump', 'jumping'],
  run: ['run', 'running'],
  failed: ['failed'],
  review: ['review'],
  waiting: ['waiting'],
  lounging: ['lounging'],
  sleep: ['sleep'],
  carried: ['carried']
}

// States a sheet may lack, and the pose that stands in — kept apart from the
// aliases (a state's own row names) exactly as agent/pet/constants does, so a
// Codex/petdex pet asked to lounge sits rather than flashing idle. The chain
// resolves: a v3 sheet asked to sleep lounges; a Codex sheet lounges → sits.
const STATE_FALLBACKS: Partial<Record<PetState, PetState>> = {
  lounging: 'waiting',
  sleep: 'lounging',
  carried: 'idle'
}

const ROW_TO_STATE: Record<string, PetState> = {
  idle: 'idle',
  wave: 'wave',
  waving: 'wave',
  jump: 'jump',
  jumping: 'jump',
  run: 'run',
  running: 'run',
  'running-right': 'run',
  'running-left': 'run',
  failed: 'failed',
  review: 'review',
  waiting: 'waiting',
  lounging: 'lounging',
  sleep: 'sleep',
  carried: 'carried'
}

/**
 * Pick the running row + mirror for a horizontal travel direction.
 *
 * Codex sheets ship dedicated `running-left` / `running-right` locomotion rows
 * (already facing their way → no flip). Pets without them fall back to the
 * in-place `running`/`run` row, which faces left by convention, so rightward
 * travel is mirrored. Returns no `row` in that fallback case so the caller lets
 * activity resolve it (and applies `mirror`).
 */
export function roamWalkRow(dir: -1 | 0 | 1, stateRows?: string[]): { row?: string; mirror: boolean } {
  if (dir === 0) {
    return { mirror: false }
  }

  const rows = stateRows ?? DEFAULT_STATE_ROWS
  const hasLeft = rows.includes('running-left')
  const hasRight = rows.includes('running-right')

  if (dir > 0) {
    if (hasRight) {
      return { mirror: false, row: 'running-right' }
    }

    if (hasLeft) {
      return { mirror: true, row: 'running-left' }
    }

    return { mirror: true }
  }

  if (hasLeft) {
    return { mirror: false, row: 'running-left' }
  }

  if (hasRight) {
    return { mirror: true, row: 'running-right' }
  }

  return { mirror: false }
}

/** Read-only activity input. The renderer knows neither profiles nor accounts. */
export interface PetSpriteActivity<T> {
  get(): T
  listen(listener: (value: T) => void): () => void
}

export interface PetSpriteProps {
  info: PetInfo
  activity?: PetSpriteActivity<PetState>
  tempo?: PetSpriteActivity<number>
  /** Freeze on the pose's first frame for reduced motion. */
  paused?: boolean
  /** On-screen scale multiplier applied on top of the pet's native scale. */
  zoom?: number
  /**
   * Force a specific animation state instead of reading the live activity.
   * Used by the generate-flow preview to showcase every row without driving (or
   * being driven by) the real agent activity that moves the floating mascot.
   */
  stateOverride?: PetState
  /** Force a concrete row name from `info.stateRows` (e.g. `running-right`). */
  rowOverride?: string
}

/**
 * Canvas renderer for a petdex spritesheet — the one piece that must be
 * TypeScript (the engine's decode/encode is Python). Draws the row matching the
 * supplied activity, stepping `framesPerState` frames across a `loopMs` loop.
 *
 * State is read from a read-only source via a ref + subscription rather than a prop,
 * so the frequent activity-driven state changes during an agent turn update the
 * canvas (on its own step timer) WITHOUT triggering a React re-render. Combined
 * with `memo`, this component effectively never re-renders after mount until
 * the pet itself changes.
 */
function PetSpriteImpl({ info, activity, tempo: tempoSource, paused = false, zoom = 1, stateOverride, rowOverride }: PetSpriteProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stateRef = useRef<PetState>(activity?.get() ?? 'idle')
  const overrideRef = useRef<PetState | undefined>(stateOverride)
  const rowOverrideRef = useRef<string | undefined>(rowOverride)
  // Draws now instead of at the next step, so a new pose shows at once.
  const wakeRef = useRef<() => void>(() => {})

  // Keep the override current without re-running the animation setup effect.
  useEffect(() => {
    overrideRef.current = stateOverride
    wakeRef.current()
  }, [stateOverride])

  useEffect(() => {
    rowOverrideRef.current = rowOverride
    wakeRef.current()
  }, [rowOverride])

  const frameW = info.frameW ?? DEFAULT_FRAME_W
  const frameH = info.frameH ?? DEFAULT_FRAME_H
  const frames = info.framesPerState ?? DEFAULT_FRAMES
  const framesByState = info.framesByState
  const framesByRow = info.framesByRow
  const loopMs = info.loopMs ?? DEFAULT_LOOP_MS
  // The person's scale × the pet's own size; a container that fits the sprite
  // to itself (a store card) divides its zoom by `size` to cancel it.
  const scale = petDrawScale(info) * zoom
  const rows = info.stateRows ?? DEFAULT_STATE_ROWS

  const drawW = Math.round(frameW * scale)
  const drawH = Math.round(frameH * scale)
  const staticState = paused ? stateOverride : undefined
  const staticRow = paused ? rowOverride : undefined

  const image = useMemo(() => {
    if (!info.spritesheetBase64) {
      return null
    }

    const img = new Image()
    img.src = `data:${info.mime ?? 'image/webp'};base64,${info.spritesheetBase64}`

    return img
  }, [info.spritesheetBase64, info.mime])

  useEffect(() => {
    const canvas = canvasRef.current

    if (!canvas || !image) {
      return
    }

    // willReadFrequently: the pop-out overlay samples this canvas's alpha under
    // the cursor (per-pixel click-through), so opt into the CPU-readback path.
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    if (!ctx) {
      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined

    // Track state via subscription, not a prop — no re-render on activity ticks.
    stateRef.current = activity?.get() ?? 'idle'

    const unsubState = activity?.listen(next => {
      stateRef.current = next
      wake()
    })

    // The wander's tempo for the current pose, read the same way: no re-render.
    let tempo = tempoSource?.get() ?? 1

    const unsubTempo = tempoSource?.listen(next => {
      tempo = next
      wake()
    })

    let frame = 0
    let lastStep = performance.now()
    let drawnFrame = -1
    let drawnRow = -1
    let activeRow = -1
    let activeCount = -1

    const rowIndexForState = (s: PetState): number => {
      for (const key of STATE_ALIASES[s] ?? [s]) {
        const idx = rows.indexOf(key)

        if (idx >= 0) {
          return idx
        }
      }

      const standIn = STATE_FALLBACKS[s]

      return standIn ? rowIndexForState(standIn) : 0
    }

    // Resolve a state to the row it draws and its real frame count. A state
    // with no real frames (ragged sheet, empty row) falls back to idle rather
    // than flashing blank padding.
    const resolve = (s: PetState): { row: number; count: number } => {
      const real = framesByState?.[s] ?? frames

      if (real > 0) {
        return { row: rowIndexForState(s), count: real }
      }

      return { row: rowIndexForState('idle'), count: Math.max(1, framesByState?.idle ?? frames) }
    }

    const resolveRow = (rowName: string): { row: number; count: number } => {
      const row = rows.indexOf(rowName)
      const state = ROW_TO_STATE[rowName]

      const count = Math.max(
        1,
        framesByRow?.[rowName] ?? framesByState?.[rowName] ?? (state ? framesByState?.[state] : 0) ?? frames
      )

      return { row: row >= 0 ? row : rowIndexForState(state ?? 'idle'), count }
    }

    const render = () => {
      timer = undefined
      const now = performance.now()
      const forcedRow = rowOverrideRef.current
      const { row, count } = forcedRow ? resolveRow(forcedRow) : resolve(overrideRef.current ?? stateRef.current)

      if (row !== activeRow || count !== activeCount) {
        activeRow = row
        activeCount = count
        frame = 0
        lastStep = now
        drawnFrame = -1
      }

      // Per-state step keeps every state's loop ~loopMs even when frame counts
      // differ; counts vary per row so derive the cadence here, not once. The
      // tempo stretches or shortens the loop for this pose.
      const stepMs = (loopMs * tempo) / count

      if (!paused && now - lastStep >= stepMs) {
        frame += 1
        lastStep = now
      }

      frame %= count

      // Only touch the canvas when the visible cell actually changes.
      if ((frame !== drawnFrame || row !== drawnRow) && image.complete && image.naturalWidth > 0) {
        const sx = frame * frameW
        const sy = row * frameH
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(image, sx, sy, frameW, frameH, 0, 0, drawW, drawH)
        drawnFrame = frame
        drawnRow = row
      }

      // Wake only when the next cell is due (the sheet steps ~5 times a second, not
      // 60), never while the window is hidden, and not at all once a still pose is
      // drawn. An image still loading is checked again shortly.
      if (!image.complete) {
        timer = setTimeout(render, IMAGE_POLL_MS)
      } else if (!paused && !document.hidden) {
        timer = setTimeout(render, Math.max(MIN_STEP_MS, stepMs - (performance.now() - lastStep)))
      }
    }

    function wake() {
      clearTimeout(timer)
      timer = setTimeout(render, 0)
    }

    // A window shown again resumes where it was; hidden, nothing is scheduled.
    const visibility = () => {
      if (!document.hidden) {
        wake()
      }
    }

    wakeRef.current = wake
    document.addEventListener('visibilitychange', visibility)
    wake()

    return () => {
      clearTimeout(timer)

      wakeRef.current = () => {}
      document.removeEventListener('visibilitychange', visibility)
      unsubState?.()
      unsubTempo?.()
    }
  }, [image, frameW, frameH, frames, framesByState, framesByRow, loopMs, drawW, drawH, rows, activity, tempoSource, paused, staticState, staticRow])

  return (
    <canvas
      aria-label={info.displayName ? `${info.displayName} pet` : 'pet'}
      height={drawH}
      ref={canvasRef}
      style={{ height: drawH, width: drawW }}
      width={drawW}
    />
  )
}

/**
 * Memoized so a parent re-render (e.g. a position commit on drag-end) doesn't
 * re-run the canvas setup. Props change only when the pet itself changes.
 */
export const PetSpriteCanvas = memo(PetSpriteImpl)
