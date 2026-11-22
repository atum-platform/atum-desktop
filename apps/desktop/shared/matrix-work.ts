/**
 * The Work surface (self-work slice A, lane DW): what the Matrix window may know about Work on this Mac.
 *
 * Main projects the sidecar (lane S), the owner view (lane R) and the Work gate (lane G) into this one
 * read-only shape. The renderer draws it and asks for a handful of owner actions; it never calls the
 * gate's tools and never sees a pairing URL, a grant or a credential.
 */

export const MATRIX_WORK_IPC = {
  request: 'matrix:work:request',
  changed: 'matrix:work:changed'
} as const

/** The owner's own Work view, which fills the page. */
export type MatrixWorkViewState =
  /** The server is starting or the view is signing in. */
  | 'starting'
  /** The view is painted over the page's host region. */
  | 'ready'
  /** It could not start or sign in: one line and "Try again". */
  | 'unavailable'
  /** Work is turned off on this Mac (§8.5): nothing runs until it is turned back on. */
  | 'off'

/** "Assistants can start work here" on this Mac, as one quiet state. */
export type MatrixWorkAssistants =
  /** This Mac has no Work route (not enrolled, or no gate for this account): nothing is drawn. */
  | 'not_enrolled'
  /** D9: the enrollment text has not been accepted on this Mac yet. */
  | 'needs_grant'
  | 'on'
  | 'off'
  /** An update, a reset or a route-wide stop holds new work for a moment. */
  | 'holding'
  /** The list of who may work here is older than its bound: new work waits until it is fresh. */
  | 'stale'
  /** The route's socket could not be bound: assistants cannot reach this Mac. */
  | 'unreachable'

/**
 * "Agents may use my ChatGPT plan here" on this Mac (gate 4b). Drawn only when a plan is connected here or the switch is on, so
 * the owner can always turn it off. It is OFF until the owner turns it on: OpenAI asks for express consent for background use.
 */
export type MatrixWorkPlan = 'off' | 'on'

export interface MatrixWorkAgentActivity {
  /** The agent's principal. The renderer names it from the account's own agent record, never from the agent. */
  principal: string
  /** Sessions this agent started that are running now. */
  running: number
  /** A stop is owed and not yet confirmed. */
  stopping: boolean
}

export interface MatrixWorkProjection {
  view: MatrixWorkViewState
  assistants: MatrixWorkAssistants
  /** Absent: no plan is connected on this Mac and the switch is off, so nothing is drawn. */
  plan?: MatrixWorkPlan
  /** Only agents with something running or a stop owed, in a stable order. */
  agents: MatrixWorkAgentActivity[]
  /** The Atum provider's balance read (lane S). No figure ever crosses. */
  protons: 'ok' | 'empty' | 'unknown'
}

/** The page's host region in CSS pixels of the Matrix window, before zoom. */
export interface MatrixWorkRect {
  x: number
  y: number
  width: number
  height: number
}

export type MatrixWorkRequest =
  | { kind: 'read' }
  | { kind: 'show'; rect: MatrixWorkRect }
  | { kind: 'hide' }
  | { kind: 'retry' }
  | { kind: 'allowAssistants' }
  | { kind: 'setAssistants'; on: boolean }
  | { kind: 'setPlan'; on: boolean }
  /** Settings: Work itself on or off for this account on this Mac (§8.5). */
  | { kind: 'setWork'; on: boolean }
  | { kind: 'reconnectAssistants' }

export interface MatrixWorkBridge {
  /** Null: Work is not available for this account on this build, so the rail has no Work entry. */
  read(): Promise<MatrixWorkProjection | null>
  /** Paint (or move) the owner view over this region. The first call opens and signs the view in. */
  show(rect: MatrixWorkRect): Promise<void>
  /** Take the view off the window, keeping its sign-in. */
  hide(): Promise<void>
  /** After `unavailable`: restart the server and sign the view in again. */
  retry(): Promise<void>
  /** Accept the enrollment text once (D9) and let assistants start work here. */
  allowAssistants(): Promise<void>
  setAssistants(on: boolean): Promise<void>
  /** "Agents may use my ChatGPT plan here". Off interrupts every plan thread at once. */
  setPlan(on: boolean): Promise<void>
  /** Turn Work on or off on this Mac. Off stops what runs and refuses to start it; on lets it start again. */
  setWork(on: boolean): Promise<void>
  /** After `unreachable`: bind the route again. */
  reconnectAssistants(): Promise<void>
  subscribe(listener: (projection: MatrixWorkProjection | null) => void): () => void
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Main's check of what a renderer may ask. Anything else is refused, not trimmed. */
export function parseMatrixWorkRequest(value: unknown): MatrixWorkRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const row = value as Record<string, unknown>
  const keys = Object.keys(row)

  switch (row.kind) {
    case 'read':
    case 'hide':
    case 'retry':
    case 'allowAssistants':
    case 'reconnectAssistants':
      return keys.length === 1 ? { kind: row.kind } : null
    case 'setAssistants':
      return keys.length === 2 && typeof row.on === 'boolean' ? { kind: 'setAssistants', on: row.on } : null
    case 'setPlan':
      return keys.length === 2 && typeof row.on === 'boolean' ? { kind: 'setPlan', on: row.on } : null
    case 'setWork':
      return keys.length === 2 && typeof row.on === 'boolean' ? { kind: 'setWork', on: row.on } : null
    case 'show': {
      const rect = row.rect as Record<string, unknown> | null

      if (
        keys.length !== 2 ||
        !rect ||
        typeof rect !== 'object' ||
        Object.keys(rect).length !== 4 ||
        !isFiniteNonNegative(rect.x) ||
        !isFiniteNonNegative(rect.y) ||
        !isFiniteNonNegative(rect.width) ||
        !isFiniteNonNegative(rect.height)
      ) {
        return null
      }

      return { kind: 'show', rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
    }
    default:
      return null
  }
}
