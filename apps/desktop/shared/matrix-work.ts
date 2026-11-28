import { type AccountConnectionsView } from './account-connections'
import type { FirstRunLabels } from './first-run-labels'
import { WORK_RELAY_PLANS, type WorkRelayPlan } from './matrix-work-relay'
import type { WorkRelayLimit, WorkRelaySelection } from './matrix-work-relay'

/**
 * The Work surface (self-work slice A, lane DW): what the Matrix window may know about Work on this Mac.
 *
 * Main projects the native Work owner view and plan usage into this read-only shape.
 */

export const MATRIX_WORK_IPC = {
  request: 'matrix:work:request',
  changed: 'matrix:work:changed',
  surfaceModeChanged: 'matrix:work:surface-mode-changed',
  sidebarChanged: 'matrix:work:sidebar-changed',
  attentionChanged: 'matrix:work:attention-changed'
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

/** One Mac the consent can name: this one, or another of the owner's Macs with Work that reported a plan. */
export interface MatrixWorkConsentMac {
  id: string
  thisMac: boolean
  named: boolean
  /** The owner's own label for the Mac (the device registry's display name), when the read carried one. Never a hostname or an id. */
  name?: string
}

/**
 * Gate 4b-2, the account's consent for background use of the plan, as the owner's page reads it. Default off. No token, login,
 * e-mail or plan name is part of it.
 */
export interface MatrixWorkPlanConsent {
  state: 'on' | 'off'
  allOwnerAgents?: boolean
  /** Principals of the assistants named. */
  agents: string[]
  /** Principals the owner may name: the owner’s active assistants and any the record names. */
  eligible: string[]
  macs: MatrixWorkConsentMac[]
  alsoWhenScheduled: boolean
  /** The platform's time of the grant (ms). Kept after a revoke. */
  grantedAt?: number
}

export interface MatrixWorkPlanConsentInput {
  agents: string[]
  macs: string[]
  alsoWhenScheduled: boolean
}

/** Token-free status and built-in models from this Mac's direct T3 publication. */
export interface WorkAgentPlans {
  published: boolean
  plans: Partial<Record<WorkRelayPlan, {
    state: 'connected' | 'disconnected'
    models?: readonly { id: string; displayName: string }[]
  }>>
  selection: WorkRelaySelection | null
}

export interface MatrixWorkProjection {
  planLimits?: readonly WorkRelayLimit[]
  view: MatrixWorkViewState
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

export interface WorkSurfaceModeSnapshot { projectId: string; mode: 'work' | 'code' }

/**
 * The view's thread list: open, and its right edge in the view's CSS pixels (the band lines ← → up with it); and
 * whether T3's own history can step back / forward, so the window's ← → go through it first; and the open
 * thread's right panel ('open' / 'closed'; absent while the view has none to offer), so its toggle sits on the
 * title bar's right as every screen's does.
 */
export interface WorkSidebarSnapshot { open: boolean; edge: number; back?: boolean; forward?: boolean; rightPanel?: 'open' | 'closed' }

/** A report from the view, or null when it is not one (the view is another origin's page). */
export function parseWorkSidebar(value: unknown): WorkSidebarSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const row = value as Record<string, unknown>

  const history = (entry: unknown) => entry === undefined || typeof entry === 'boolean'

  const panel = row.rightPanel === undefined || row.rightPanel === 'open' || row.rightPanel === 'closed'

  return typeof row.open === 'boolean' && typeof row.edge === 'number' && Number.isFinite(row.edge) && row.edge >= 0 && row.edge <= 10_000 &&
    history(row.back) && history(row.forward) && panel
    ? {
        open: row.open,
        edge: Math.round(row.edge),
        ...(row.back ? { back: true } : {}),
        ...(row.forward ? { forward: true } : {}),
        ...(row.rightPanel ? { rightPanel: row.rightPanel as 'open' | 'closed' } : {})
      }
    : null
}

/**
 * What waits in the view's thread list, for Work's rail badge (layout r2 G): threads asking the person
 * (an approval or an answer) and threads that finished since the person last looked. Counts only.
 */
export interface WorkAttentionSnapshot { waiting: number; finished: number }

export function parseWorkAttention(value: unknown): WorkAttentionSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const row = value as Record<string, unknown>
  const count = (entry: unknown) => typeof entry === 'number' && Number.isInteger(entry) && entry >= 0 && entry <= 10_000

  return count(row.waiting) && count(row.finished)
    ? { waiting: row.waiting as number, finished: row.finished as number }
    : null
}

/** T3 commands the Work title band offers as buttons over the roster column (spec §1.4). */
export const WORK_BAND_COMMANDS = ['sidebar.toggle', 'chat.new', 'chat.newWorktree', 'project.add', 'history.back', 'history.forward', 'rightPanel.toggle'] as const
export type WorkBandCommand = (typeof WORK_BAND_COMMANDS)[number]

import { isWorkLocalPlan, isWorkLocalPlanAction, type WorkLocalPlan, type WorkLocalPlanAction, type WorkLocalPlanStates } from './work-local-plans'

export type MatrixWorkRequest =
  | { kind: 'getSurfaceMode' }
  | { kind: 'getSidebar' }
  | { kind: 'getAttention' }
  | { kind: 'runCommand'; command: WorkBandCommand }
  | { kind: 'setSurfaceMode'; projectId: string; mode: 'work' | 'code' }
  | { kind: 'readAgentPlans'; principal: string }
  | { kind: 'selectRelay'; principal: string; model: string; plan?: WorkRelayPlan }
  | { kind: 'read' }
  | { kind: 'show'; rect: MatrixWorkRect }
  | { kind: 'hide' }
  | { kind: 'retry' }
  /** Gate 4a: open T3's own Codex connect screen inside Work. Atum never sees the login. */
  | { kind: 'openPlanConnect'; plan?: WorkRelayPlan }
  | { kind: 'readPlanConsent'; plan?: WorkRelayPlan }
  | { kind: 'setPlanConsent'; consent: MatrixWorkPlanConsentInput; plan?: WorkRelayPlan }
  | { kind: 'revokePlanConsent'; plan?: WorkRelayPlan }
  | { kind: 'readConnections' }
  /** First run: this Mac's four connections and their plan names, as T3 reports them (local only). */
  | { kind: 'readPlanLabels' }
  | { kind: 'readLocalPlans' }
  | { kind: 'localPlanAction'; plan: WorkLocalPlan; action: WorkLocalPlanAction }
  /** Settings: Work itself on or off for this account on this Mac (§8.5). */
  | { kind: 'setWork'; on: boolean }

export interface MatrixWorkBridge {
  getSurfaceMode(): Promise<WorkSurfaceModeSnapshot | null>
  /** Runs one of T3's own commands in the owner view; false when the view did not take it. */
  runCommand?(command: WorkBandCommand): Promise<boolean>
  setSurfaceMode(projectId: string, mode: 'work' | 'code'): Promise<void>
  onSurfaceModeChanged(listener: (snapshot: WorkSurfaceModeSnapshot | null) => void): () => void
  /** The view's thread list as it last reported it; null before a report. */
  getSidebar?(): Promise<WorkSidebarSnapshot | null>
  onSidebarChanged?(listener: (snapshot: WorkSidebarSnapshot | null) => void): () => void
  /** The view's threads that wait for the person or finished unseen; null before a report. */
  getAttention?(): Promise<WorkAttentionSnapshot | null>
  onAttentionChanged?(listener: (snapshot: WorkAttentionSnapshot | null) => void): () => void
  readAgentPlans?(principal: string): Promise<WorkAgentPlans | null>
  selectRelay?(principal: string, model: string, plan?: WorkRelayPlan): Promise<WorkRelaySelection>
  /** Null: Work is not available for this account on this build, so the rail has no Work entry. */
  read(): Promise<MatrixWorkProjection | null>
  /** Paint (or move) the owner view over this region. The first call opens and signs the view in. */
  show(rect: MatrixWorkRect): Promise<void>
  /** Take the view off the window, keeping its sign-in. */
  hide(): Promise<void>
  /** After `unavailable`: restart the server and sign the view in again. */
  retry(): Promise<void>
  /** Open T3's own Codex connect screen in Work's view (the caller shows the Work page). */
  openPlanConnect(plan?: WorkRelayPlan): Promise<void>
  readPlanConsent(plan?: WorkRelayPlan): Promise<MatrixWorkPlanConsent>
  setPlanConsent(consent: MatrixWorkPlanConsentInput, plan?: WorkRelayPlan): Promise<MatrixWorkPlanConsent>
  readConnections?(): Promise<AccountConnectionsView | null>
  /** First run: this Mac's four connections (ChatGPT, Claude, Antigravity, OpenCode) and T3's plan names. */
  readPlanLabels?(): Promise<FirstRunLabels>
  readLocalPlans?(): Promise<WorkLocalPlanStates>
  localPlanAction?(plan: WorkLocalPlan, action: WorkLocalPlanAction): Promise<string | void>
  /** One tap, every Mac: revoke the platform's account-wide consent record. */
  revokePlanConsent(plan?: WorkRelayPlan): Promise<MatrixWorkPlanConsent>
  /** Turn Work on or off on this Mac. Off stops what runs and refuses to start it; on lets it start again. */
  setWork(on: boolean): Promise<void>
  subscribe(listener: (projection: MatrixWorkProjection | null) => void): () => void
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

function uuidList(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) {
    return null
  }

  if (!value.every(item => typeof item === 'string' && UUID.test(item)) || new Set(value).size !== value.length) {
    return null
  }

  return [...(value as string[])]
}

function parseConsentInput(value: unknown): MatrixWorkPlanConsentInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const row = value as Record<string, unknown>

  if (Object.keys(row).length !== 3 || typeof row.alsoWhenScheduled !== 'boolean') {
    return null
  }

  const agents = uuidList(row.agents, 256)
  const macs = uuidList(row.macs, 32)

  return agents && macs ? { agents, macs, alsoWhenScheduled: row.alsoWhenScheduled } : null
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

  const relayPlan = WORK_RELAY_PLANS.find(plan => plan === row.plan)

  switch (row.kind) {
    case 'getSurfaceMode': return keys.length === 1 ? { kind: 'getSurfaceMode' } : null

    case 'getSidebar': return keys.length === 1 ? { kind: 'getSidebar' } : null

    case 'getAttention': return keys.length === 1 ? { kind: 'getAttention' } : null
    case 'runCommand': {
      const command = WORK_BAND_COMMANDS.find(each => each === row.command)

      return keys.length === 2 && command ? { kind: 'runCommand', command } : null
    }

    case 'setSurfaceMode':
      return keys.length === 3 && typeof row.projectId === 'string' && row.projectId.length > 0 && row.projectId.length <= 255 && (row.mode === 'work' || row.mode === 'code')
        ? { kind: 'setSurfaceMode', projectId: row.projectId, mode: row.mode } : null

    case 'readAgentPlans':
      return keys.length === 2 && typeof row.principal === 'string' && UUID.test(row.principal)
        ? { kind: 'readAgentPlans', principal: row.principal } : null
    case 'selectRelay': {
      if (row.plan !== undefined && !relayPlan) {return null}

      return keys.length === ('plan' in row ? 4 : 3) && typeof row.principal === 'string' && UUID.test(row.principal) && typeof row.model === 'string' && row.model.length > 0 && row.model.length <= 200
        ? { kind: 'selectRelay', principal: row.principal, model: row.model, ...(relayPlan ? { plan: relayPlan } : {}) } : null
    }

    case 'read':

    case 'hide':

    case 'retry':

    case 'readConnections':

    case 'readLocalPlans':
    case 'readPlanLabels':
      return keys.length === 1 ? { kind: row.kind } : null

    case 'readPlanConsent':

    case 'revokePlanConsent':

    case 'openPlanConnect':
      return keys.length === ('plan' in row ? 2 : 1) && (row.plan === undefined || relayPlan)
        ? { kind: row.kind, ...(relayPlan ? { plan: relayPlan } : {}) } : null
    case 'setPlanConsent': {
      const consent = keys.length === ('plan' in row ? 3 : 2) ? parseConsentInput(row.consent) : null

      return consent && (row.plan === undefined || relayPlan)
        ? { kind: 'setPlanConsent', consent, ...(relayPlan ? { plan: relayPlan } : {}) } : null
    }

    case 'localPlanAction':
      return keys.length === 3 && isWorkLocalPlan(row.plan) && isWorkLocalPlanAction(row.plan, row.action)
        ? { kind: 'localPlanAction', plan: row.plan, action: row.action } : null

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
