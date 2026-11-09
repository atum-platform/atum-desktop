/**
 * Renderer seam for the two per-app surfaces — **intake** (what an app still
 * needs before it can work) and **connect** (linking to an account the user
 * already holds on the app's own service).
 *
 * Everything here is a thin, total wrapper over the preload bridge. The
 * network call, the bearer token, and the connect authorize URL all live in
 * Electron main; this module only ever sees a parsed result or a stable error
 * code. A runtime without the bridge gets an inert client rather than a throw,
 * the same posture `atum-account-client.ts` takes.
 */

import type { ParticipantDisplay } from '../../shared/atum-participants'

export type IntakeFieldType = 'date' | 'select' | 'text' | 'time'

export interface IntakeFieldOption {
  value: string
  label: string | null
}

export interface IntakeFieldSpec {
  name: string
  type: IntakeFieldType
  label: string | null
  placeholder: string | null
  options: IntakeFieldOption[]
}

export interface IntakeStatus {
  complete: boolean
  fields: IntakeFieldSpec[]
}

export type ConnectCandidateStatus = 'available' | 'dismissed' | 'linked' | 'none'
export type ConnectLifecycleStatus = 'never_linked' | 'linked' | 'unlinked'

export interface AppConnectionStatus {
  status: ConnectLifecycleStatus
  browserStep?: string
  cleanup?: 'pending' | 'complete' | 'unconfirmed'
  connectionRequired?: boolean
  available?: boolean
  connectAvailable?: boolean
  readiness?: 'not_linked' | 'pending' | 'ready' | 'unavailable'
}

export interface AppSurfaceFailure {
  error: string
  /** Set when an app rejected one specific field, so the form can point at it. */
  field?: string
}

export interface DesktopAppCatalogEntry {
  app: string
  app_id: string
  app_version_id: string
  name: { vi: string; en: string }
  subtitle: { vi: string; en: string } | null
  icon: { url: string; sha256: string } | null
  verified: boolean
  availability: 'available' | 'unavailable'
  supported_modes: Array<'direct' | 'private_group' | 'shared_group'>
  link: { mode: 'none' | 'external_account'; state: 'never_linked' | 'linked' | 'unlinked' }
}

export interface DesktopAppCatalog { apps: DesktopAppCatalogEntry[] }

export type AppSurfaceResult<T> = AppSurfaceFailure | T

export type AppRoutePlacement = 'menu' | 'composer'

/** A manifest route as the renderer may know it: identity and placement, never a path or origin. */
export interface AppRoute {
  id: string
  label: { vi: string; en: string }
  icon: string
  placements: AppRoutePlacement[]
  session: 'required' | 'none'
}

export interface AppRoutes {
  app: string
  routes: AppRoute[]
  launch: boolean
  participant?: ParticipantDisplay
}

export interface AtumAppSurfaceClient {
  catalog(force?: boolean): Promise<AppSurfaceResult<DesktopAppCatalog>>
  /** Routes the app declares, from the server-authored manifest main holds. */
  routes(app: string): Promise<AppSurfaceResult<AppRoutes>>
  intakeStatus(app: string): Promise<AppSurfaceResult<IntakeStatus>>
  submitIntake(app: string, values: Record<string, string>): Promise<AppSurfaceResult<IntakeStatus>>
  connectStatus(app: string): Promise<AppSurfaceResult<AppConnectionStatus>>
  connectCandidate(app: string): Promise<AppSurfaceResult<{ status: ConnectCandidateStatus }>>
  /** Resolves once main has handed the authorize URL to the system browser. */
  connectStart(app: string): Promise<AppSurfaceResult<{ opened: true }>>
  connectDismiss(app: string): Promise<AppSurfaceResult<{ status: ConnectCandidateStatus }>>
}

const UNAVAILABLE: AppSurfaceFailure = { error: 'app_surface_unavailable' }

export function atumAppSurfaceClient(): AtumAppSurfaceClient {
  return (
    window.hermesDesktop?.appSurface ?? {
      catalog: async () => UNAVAILABLE,
      routes: async () => UNAVAILABLE,
      intakeStatus: async () => UNAVAILABLE,
      submitIntake: async () => UNAVAILABLE,
      connectStatus: async () => UNAVAILABLE,
      connectCandidate: async () => UNAVAILABLE,
      connectStart: async () => UNAVAILABLE,
      connectDismiss: async () => UNAVAILABLE
    }
  )
}

export function isAppSurfaceFailure<T>(result: AppSurfaceResult<T>): result is AppSurfaceFailure {
  return typeof (result as AppSurfaceFailure)?.error === 'string'
}

/**
 * The capability an app must advertise before Atum is allowed to put an intake
 * modal in front of the user.
 *
 * `null` means the conversation payload carries no capability list at all —
 * an older server projection, not a refusal. In that case the intake status
 * endpoint is the authority: an app with no intake answers `complete: true`
 * and nothing is ever shown. But when a list IS present and does not include
 * `intake.modal`, the modal is suppressed outright, whatever the status says.
 */
export const INTAKE_MODAL_CAPABILITY = 'intake.modal'

export function appProtocolCapabilities(payload: Record<string, unknown> | null | undefined): string[] | null {
  const declared = payload?.protocol_capabilities ?? payload?.protocolCapabilities ?? (payload?.capabilities as unknown)

  if (!Array.isArray(declared)) {
    return null
  }

  return declared.filter((entry): entry is string => typeof entry === 'string')
}

export function allowsIntakeModal(payload: Record<string, unknown> | null | undefined): boolean {
  const capabilities = appProtocolCapabilities(payload)

  return capabilities === null || capabilities.includes(INTAKE_MODAL_CAPABILITY)
}
