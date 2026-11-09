/**
 * app-surfaces-ipc.ts
 *
 * Renderer seam for the intake and connect lanes. Every handler returns a
 * plain, already-parsed value or a stable `{ error }` envelope — the renderer
 * never sees a token, an authorize URL, or an upstream response body.
 *
 * Argument validation lives here rather than in the client so a hostile or
 * buggy renderer cannot reach the network with an unvalidated app id.
 */

import type { ParticipantDisplay } from '../../shared/atum-participants'

import type { AppManifestRoute, AtumAppSurfacesClient, ConnectCandidate, ConnectLifecycle, DesktopAppCatalog, IntakeStatus } from './app-surfaces'
import { MessagingHttpError } from './http-client'

interface IpcMainLike {
  handle(channel: string, listener: (_event: unknown, ...args: any[]) => unknown): void
  removeHandler?(channel: string): void
}

export const ATUM_APP_SURFACE_IPC_CHANNELS = [
  'atum:app:catalog',
  'atum:app:routes',
  'atum:app:intake:status',
  'atum:app:intake:submit',
  'atum:app:connect:status',
  'atum:app:connect:candidate',
  'atum:app:connect:start',
  'atum:app:connect:dismiss'
] as const

export interface AppSurfaceFailure {
  error: string
  /** Present only when an app rejected one specific intake field. */
  field?: string
}

export type AppSurfaceResult<T> = AppSurfaceFailure | T

/** The renderer-safe projection of a manifest route: identity and placement, never a path. */
export type AppRouteProjection = Omit<AppManifestRoute, 'path'>

export interface AppRoutesProjection {
  app: string
  routes: AppRouteProjection[]
  /** Whether the app implements `atum.app-launch/1`; session-required routes exist only when it does. */
  launch: boolean
  participant?: ParticipantDisplay
}

export function projectAppRoutes(manifest: Awaited<ReturnType<AtumAppSurfacesClient['manifest']>>): AppRoutesProjection {
  return {
    app: manifest.manifest.app.slug,
    launch: manifest.manifest.launch !== null,
    ...(manifest.participant ? { participant: manifest.participant } : {}),
    routes: manifest.manifest.routes.map(route => ({
      id: route.id,
      label: route.label,
      icon: route.icon,
      placements: route.placements,
      session: route.session
    }))
  }
}

/**
 * Collapse anything thrown into a stable code. `MessagingHttpError.code` is
 * already a closed vocabulary produced by our own parsers or by the desktop
 * error envelope; anything else is deliberately anonymised.
 */
function failure(error: unknown): AppSurfaceFailure {
  if (error instanceof MessagingHttpError) {
    const field = error.details && typeof error.details.field === 'string' ? error.details.field : null

    return field ? { error: error.code, field } : { error: error.code }
  }

  return { error: 'app_surface_failed' }
}

export function registerAtumAppSurfaceIpc(ipc: IpcMainLike, client: AtumAppSurfacesClient): () => void {
  ipc.handle('atum:app:catalog', async (_event, force): Promise<AppSurfaceResult<DesktopAppCatalog>> => {
    try { return await client.catalog(undefined, force === true) } catch (error) { return failure(error) }
  })
  ipc.handle('atum:app:routes', async (_event, app): Promise<AppSurfaceResult<AppRoutesProjection>> => {
    try {return projectAppRoutes(await client.manifest(app))} catch (error) {return failure(error)}
  })
  ipc.handle('atum:app:intake:status', async (_event, app): Promise<AppSurfaceResult<IntakeStatus>> => {
    try {
      return await client.intakeStatus(app)
    } catch (error) {
      return failure(error)
    }
  })

  ipc.handle('atum:app:intake:submit', async (_event, app, values): Promise<AppSurfaceResult<IntakeStatus>> => {
    try {
      return await client.intakeSubmit(app, values)
    } catch (error) {
      return failure(error)
    }
  })

  ipc.handle('atum:app:connect:candidate', async (_event, app): Promise<AppSurfaceResult<ConnectCandidate>> => {
    try {
      return await client.connectCandidate(app)
    } catch (error) {
      return failure(error)
    }
  })

  ipc.handle('atum:app:connect:status', async (_event, app): Promise<AppSurfaceResult<ConnectLifecycle>> => {
    try {
      return await client.connectStatus(app)
    } catch (error) {
      return failure(error)
    }
  })

  ipc.handle('atum:app:connect:start', async (_event, app): Promise<AppSurfaceResult<{ opened: true }>> => {
    try {
      return await client.connectStart(app)
    } catch (error) {
      return failure(error)
    }
  })

  ipc.handle('atum:app:connect:dismiss', async (_event, app): Promise<AppSurfaceResult<ConnectCandidate>> => {
    try {
      return await client.connectDismiss(app)
    } catch (error) {
      return failure(error)
    }
  })

  return () => {
    for (const channel of ATUM_APP_SURFACE_IPC_CHANNELS) {
      ipc.removeHandler?.(channel)
    }
  }
}
