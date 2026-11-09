import type { PetState } from './pet'

/** Why a chat companion's engine (re)started: the first stage for this agent in this window, a
 * stage again after she left the screen (a room switch, the Store, an app), a different sprite,
 * or a different stage size. A focus is none of these: it must not restart her. */
export const MATRIX_PET_START_REASONS = ['mount', 'remount', 'sprite', 'size'] as const
/** Where she stands: the floor, the ledge kind she is on, or nowhere safe (hidden). */
export const MATRIX_PET_SURFACES = ['floor', 'composer', 'rail', 'toolbar', 'perch', 'hidden'] as const
export const MATRIX_PET_WORK_SIGNALS = ['idle', 'working', 'waiting', 'failed'] as const
/** The window around her: only `hidden` and `covered` may freeze her; `unfocused` must not. */
export const MATRIX_PET_WINDOW_STATES = ['focused', 'unfocused', 'hidden', 'covered'] as const

const POSES: readonly PetState[] = [
  'idle',
  'wave',
  'run',
  'failed',
  'review',
  'jump',
  'waiting',
  'lounging',
  'sleep',
  'carried'
]

/**
 * One closed, payload-free line about a chat companion's stage (pet lifecycle diagnostics,
 * 0.19.4): every value is a listed code or a small number, never text from a chat. `agent` is at
 * most the first eight characters of the agent principal, as other main.log agent lines show it.
 */
export interface MatrixPetDiagnostic {
  event: 'start' | 'state'
  /** Start lines only. */
  reason?: (typeof MATRIX_PET_START_REASONS)[number]
  /** Start lines only: back at her remembered resting place, or the default entry point. */
  restore?: 'saved' | 'default'
  agent: string
  work: (typeof MATRIX_PET_WORK_SIGNALS)[number]
  pose: PetState
  surface: (typeof MATRIX_PET_SURFACES)[number]
  /** Her place across the walkable width in tenths (0 = left edge, 9 = right); null before she
   * has measured her world. */
  x: number | null
  window: (typeof MATRIX_PET_WINDOW_STATES)[number]
  /** How many times this line came up, unwritten, since it was last written. */
  repeats: number
}

const AGENT = /^[A-Za-z0-9_-]{1,8}$/

function listed<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

/** The line exactly as listed, or undefined: anything else in it says nothing. */
export function parseMatrixPetDiagnostic(value: unknown): MatrixPetDiagnostic | undefined {
  const row = value as Partial<Record<keyof MatrixPetDiagnostic, unknown>> | null

  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return undefined
  }

  const start = row.event === 'start'

  const allowed = new Set<string>([
    'event',
    'agent',
    'work',
    'pose',
    'surface',
    'x',
    'window',
    'repeats',
    ...(start ? ['reason', 'restore'] : [])
  ])

  if (
    (row.event !== 'start' && row.event !== 'state') ||
    Object.keys(row).some(key => !allowed.has(key)) ||
    typeof row.agent !== 'string' ||
    !AGENT.test(row.agent) ||
    !listed(MATRIX_PET_WORK_SIGNALS, row.work) ||
    !listed(POSES, row.pose) ||
    !listed(MATRIX_PET_SURFACES, row.surface) ||
    !(row.x === null || (Number.isInteger(row.x) && (row.x as number) >= 0 && (row.x as number) <= 9)) ||
    !listed(MATRIX_PET_WINDOW_STATES, row.window) ||
    !(Number.isInteger(row.repeats) && (row.repeats as number) >= 0 && (row.repeats as number) <= 1_000_000) ||
    (start && (!listed(MATRIX_PET_START_REASONS, row.reason) || (row.restore !== 'saved' && row.restore !== 'default')))
  ) {
    return undefined
  }

  return {
    event: row.event,
    ...(start ? { reason: row.reason as MatrixPetDiagnostic['reason'], restore: row.restore as 'saved' | 'default' } : {}),
    agent: row.agent,
    work: row.work,
    pose: row.pose,
    surface: row.surface,
    x: row.x as number | null,
    window: row.window,
    repeats: row.repeats as number
  }
}

/** `[Matrix] pet agent=… event=start reason=… restore=… work=… pose=… surface=… x=… window=…` */
export function formatMatrixPetDiagnostic(line: MatrixPetDiagnostic): string {
  return [
    '[Matrix] pet',
    `agent=${line.agent}`,
    `event=${line.event}`,
    ...(line.event === 'start' ? [`reason=${line.reason}`, `restore=${line.restore}`] : []),
    `work=${line.work}`,
    `pose=${line.pose}`,
    `surface=${line.surface}`,
    `x=${line.x ?? 'na'}`,
    `window=${line.window}`,
    ...(line.repeats ? [`repeats=${line.repeats}`] : [])
  ].join(' ')
}
