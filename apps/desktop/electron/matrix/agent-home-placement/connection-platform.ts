/** Strict owner/Mac HTTP client for the additive `atum.agent-home/2.5` routes. */
import type { z } from 'zod'

import { type PlacementRoute, placementRoute } from './connection-routes'
import { isUuid } from './contract'
import {
  AGENT_HOME_V25_PROFILE,
  AGENT_HOME_V25_WIRE_HEADER,
  AGENT_HOME_V25_WIRE_VERSION,
  type AgentHomeArchiveImportReceiptV25,
  AgentHomeArchiveImportReceiptV25Schema,
  type AgentHomeOwnerModelChoiceReceiptV25,
  AgentHomeOwnerModelChoiceReceiptV25Schema,
  AgentHomeOwnerModelChoiceRefusalV25Schema,
  type AgentHomeOwnerModelChoiceWriteV25,
  type AgentHomeOwnerMoveCancelV25,
  type AgentHomeOwnerMovePreflightV25,
  AgentHomeOwnerMovePreflightV25Schema,
  type AgentHomeOwnerMoveProgressV25,
  AgentHomeOwnerMoveProgressV25Schema,
  AgentHomeOwnerMoveRefusalV25Schema,
  type AgentHomeOwnerMoveRequestV25,
  type AgentHomeOwnerPlacementSnapshotV25,
  AgentHomeOwnerPlacementSnapshotV25Schema,
  type AgentHomeOwnerPreflightRequestV25,
  type AgentHomePortableArchiveImportV25,
  AgentHomePortableArchiveImportV25Schema,
  type HomeModelApplicationReportV25,
  HomeModelApplicationReportV25Schema,
  type MacConnectionCatalogIngestV25,
  MacConnectionCatalogIngestV25Schema,
  type MacConnectionCatalogReceiptV25,
  MacConnectionCatalogReceiptV25Schema,
  type MacConnectionCatalogV25,
  MacConnectionCatalogV25Schema,
  type ModelApplicationProjectionV25,
  ModelApplicationProjectionV25Schema
} from './contract-v25'

export type PlacementConnectionFailureKind =
  | 'unsupported'
  | 'unauthorized'
  | 'forbidden'
  | 'conflict'
  | 'invalid'
  | 'unavailable'

export interface PlacementConnectionFailure {
  ok: false
  kind: PlacementConnectionFailureKind
  status: number
  /** The platform's closed reason for a refusal (`committed_epoch_preserved`, `catalog_stale`...), when its body named one. */
  reason?: string
  /** How long the platform asked callers to wait (`Retry-After`), in milliseconds. */
  retryAfterMs?: number
}

export type PlacementConnectionResult<T> = { ok: true; value: T } | PlacementConnectionFailure

export interface PlacementConnectionPlatformOptions {
  request<T>(send: (accessToken: string, resource: string) => Promise<T>, signal: AbortSignal): Promise<T>
  fetch?: typeof fetch
  timeoutMs?: number
  /** Ed25519 controller signature against a key pinned by this device's enrollment. */
  verifyController?(message: string, value: unknown): boolean
}

const RESPONSE_LIMIT = 256 * 1024
const CALL_TIMEOUT_MS = 20_000
const MAX_RETRY_AFTER_MS = 3_600_000
const CLOSED_REASON = /^[a-z][a-z0-9_]{0,63}$/u

function requireCurrentProfile<T extends { profile: string }>(value: T): T {
  if (value.profile !== AGENT_HOME_V25_PROFILE) {throw new Error('agent_home_profile_mismatch')}
  return value
}

function requireCurrentSnapshot(value: AgentHomeOwnerPlacementSnapshotV25): AgentHomeOwnerPlacementSnapshotV25 {
  requireCurrentProfile(value)
  if (value.moveCapability.state === 'available' && value.moveCapability.profile !== AGENT_HOME_V25_PROFILE) {
    throw new Error('agent_home_profile_mismatch')
  }
  return value
}

async function json(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) {return undefined}
  const chunks: Uint8Array[] = []
  let size = 0

  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) {break}
      size += next.value.byteLength
      if (size > RESPONSE_LIMIT) {throw new Error('response_too_large')}
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function failure(status: number, reason?: string, retryAfterMs?: number): PlacementConnectionFailure {
  const detail = {
    ...(reason ? { reason } : {}),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs })
  }

  if (status === 404 || status === 405 || status === 501) {return { ok: false, kind: 'unsupported', status, ...detail }}
  if (status === 401) {return { ok: false, kind: 'unauthorized', status, ...detail }}
  if (status === 403) {return { ok: false, kind: 'forbidden', status, ...detail }}
  if (status === 409 || status === 412) {return { ok: false, kind: 'conflict', status, ...detail }}
  if (status === 400 || status === 422) {return { ok: false, kind: 'invalid', status, ...detail }}
  return { ok: false, kind: 'unavailable', status, ...detail }
}

/** `Retry-After` in whole seconds; an HTTP date is not used by these routes. */
function retryAfter(header: string | null): number | undefined {
  if (header === null || !/^[0-9]{1,7}$/u.test(header.trim())) {return undefined}
  return Math.min(Number(header.trim()) * 1000, MAX_RETRY_AFTER_MS)
}

/** The Matrix error envelope `{error: 'matrix_409', details: {reason}}` the Shell uses for closed domain reasons. */
function envelopeReason(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {return undefined}
  const details = (value as Record<string, unknown>).details
  const reason =
    details && typeof details === 'object' && !Array.isArray(details) ? (details as Record<string, unknown>).reason : undefined
  return typeof reason === 'string' && CLOSED_REASON.test(reason) ? reason : undefined
}

/** A success-status body that is really a refusal: thrown out of `parse` so the call reports it as a conflict. */
class RefusedBody extends Error {
  constructor(readonly reason: string) {
    super('refused_body')
  }
}

export class PlacementConnectionPlatform {
  constructor(private readonly options: PlacementConnectionPlatformOptions) {}

  private controller<T>(message: string, value: T): T {
    if (this.options.verifyController && !this.options.verifyController(message, value)) {
      throw new Error('controller_signature_invalid')
    }

    return value
  }

  /** The reason a signed refusal body names, or undefined when it is not one (or its signature is not the controller's). */
  private signedRefusal(message: string, schema: z.ZodType, value: unknown): string | undefined {
    try {
      const parsed = schema.safeParse(value)
      if (!parsed.success) {return undefined}
      const checked = this.controller(message, parsed.data) as { outcome?: unknown; reason?: unknown }
      return checked.outcome === 'refused' && typeof checked.reason === 'string' ? checked.reason : undefined
    } catch {
      return undefined
    }
  }

  private async call<T>(
    agent: string,
    route: PlacementRoute | null,
    body: unknown,
    parse: (value: unknown) => T,
    signal: AbortSignal,
    refusal?: (value: unknown) => string | undefined
  ): Promise<PlacementConnectionResult<T>> {
    if (!isUuid(agent) || !route || !route.path.startsWith('/home/')) {return { ok: false, kind: 'invalid', status: 0 }}

    const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? CALL_TIMEOUT_MS)])
    let response: Response

    try {
      response = await this.options.request(
        async (accessToken, resource) =>
          (this.options.fetch ?? fetch)(`${resource}/agents/${encodeURIComponent(agent)}${route.path}`, {
            method: route.method,
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: 'application/json',
              [AGENT_HOME_V25_WIRE_HEADER]: AGENT_HOME_V25_WIRE_VERSION,
              ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'error',
            signal: bounded
          }),
        bounded
      )
    } catch (error) {
      return error instanceof Error && error.message === 'matrix_s1_authentication'
        ? { ok: false, kind: 'unauthorized', status: 401 }
        : { ok: false, kind: 'unavailable', status: 0 }
    }

    const isJson = Boolean(response.headers.get('content-type')?.startsWith('application/json'))

    if (!response.ok) {
      // A refusal carries its closed reason in the body (a signed refusal, or the Matrix error envelope): read it so
      // the owner is told what happened instead of a bare "conflict".
      let reason: string | undefined

      if (isJson) {
        try {
          const value = await json(response)
          reason = refusal?.(value) ?? envelopeReason(value)
        } catch {
          reason = undefined
        }
      } else {
        await response.body?.cancel().catch(() => undefined)
      }

      return failure(response.status, reason, retryAfter(response.headers.get('retry-after')))
    }

    if (!isJson) {
      await response.body?.cancel().catch(() => undefined)
      return failure(response.status)
    }

    try {
      return { ok: true, value: parse(await json(response)) }
    } catch (error) {
      return error instanceof RefusedBody
        ? { ok: false, kind: 'conflict', status: response.status, reason: error.reason }
        : { ok: false, kind: 'invalid', status: response.status }
    }
  }

  private moveRefusal = (value: unknown) =>
    this.signedRefusal('owner.home.move.refusal', AgentHomeOwnerMoveRefusalV25Schema, value)

  private modelRefusal = (value: unknown) =>
    this.signedRefusal('owner.home.model-choice.refusal', AgentHomeOwnerModelChoiceRefusalV25Schema, value)

  private catalogRefusal = (value: unknown) =>
    this.signedRefusal('home.connection-catalog.receipt', MacConnectionCatalogReceiptV25Schema, value)

  /** A progress body, or (should a platform answer a refusal with a success status) the refusal as a conflict. */
  private progressOrRefusal = (value: unknown): AgentHomeOwnerMoveProgressV25 => {
    const refused = this.moveRefusal(value)
    if (refused !== undefined) {throw new RefusedBody(refused)}
    return requireCurrentProfile(AgentHomeOwnerMoveProgressV25Schema.parse(value))
  }

  readOwner(agent: string, signal: AbortSignal) {
    return this.call(agent, placementRoute('readOwner'), undefined, value =>
      this.controller('owner.home.snapshot', requireCurrentSnapshot(AgentHomeOwnerPlacementSnapshotV25Schema.parse(value))), signal)
  }

  preflight(agent: string, body: AgentHomeOwnerPreflightRequestV25, signal: AbortSignal) {
    return this.call(agent, placementRoute('preflight'), body, value =>
      this.controller('owner.home.move.preflight', AgentHomeOwnerMovePreflightV25Schema.parse(value)), signal)
  }

  requestMove(agent: string, body: AgentHomeOwnerMoveRequestV25, signal: AbortSignal) {
    return this.call(agent, placementRoute('requestMove'), body, this.progressOrRefusal, signal, this.moveRefusal)
  }

  cancelMove(agent: string, body: AgentHomeOwnerMoveCancelV25, signal: AbortSignal) {
    return this.call(agent, placementRoute('cancelMove'), body, this.progressOrRefusal, signal, this.moveRefusal)
  }

  readProgress(agent: string, moveId: string, signal: AbortSignal) {
    return this.call<AgentHomeOwnerMoveProgressV25>(
      agent,
      placementRoute('readProgress', { moveId }),
      undefined,
      value => requireCurrentProfile(AgentHomeOwnerMoveProgressV25Schema.parse(value)),
      signal
    )
  }

  writeModelChoice(agent: string, body: AgentHomeOwnerModelChoiceWriteV25, signal: AbortSignal) {
    return this.call<AgentHomeOwnerModelChoiceReceiptV25>(
      agent,
      placementRoute('writeModelChoice'),
      body,
      value => this.controller('owner.home.model-choice.receipt', AgentHomeOwnerModelChoiceReceiptV25Schema.parse(value)),
      signal,
      this.modelRefusal
    )
  }

  readCatalog(agent: string, deviceServiceId: string, signal: AbortSignal) {
    return this.call<MacConnectionCatalogV25>(
      agent,
      placementRoute('readCatalog', { deviceServiceId }),
      undefined,
      value => requireCurrentProfile(MacConnectionCatalogV25Schema.parse(value)),
      signal
    )
  }

  publishCatalog(agent: string, body: MacConnectionCatalogIngestV25, signal: AbortSignal) {
    MacConnectionCatalogIngestV25Schema.parse(body)
    return this.call<MacConnectionCatalogReceiptV25>(
      agent,
      placementRoute('publishCatalog'),
      body,
      value => this.controller('home.connection-catalog.receipt', MacConnectionCatalogReceiptV25Schema.parse(value)),
      signal,
      this.catalogRefusal
    )
  }

  readModelApplication(agent: string, signal: AbortSignal) {
    return this.call<ModelApplicationProjectionV25>(
      agent,
      placementRoute('readModelApplication'),
      undefined,
      value => requireCurrentProfile(ModelApplicationProjectionV25Schema.parse(value)),
      signal
    )
  }

  /** The controller-signed instruction to import a cloud home's portable archive on this Mac (cloud to Mac moves). */
  readImport(agent: string, moveId: string, signal: AbortSignal) {
    return this.call<AgentHomePortableArchiveImportV25>(
      agent,
      placementRoute('readImport', { moveId }),
      undefined,
      value => this.controller('home.archive.import', AgentHomePortableArchiveImportV25Schema.parse(value)),
      signal
    )
  }

  /** This Mac's signed receipt that it read the imported archive; the move commits only after it. */
  reportImport(agent: string, body: AgentHomeArchiveImportReceiptV25, signal: AbortSignal) {
    AgentHomeArchiveImportReceiptV25Schema.parse(body)
    return this.call<AgentHomeArchiveImportReceiptV25>(
      agent,
      placementRoute('reportImport'),
      body,
      value => AgentHomeArchiveImportReceiptV25Schema.parse(value),
      signal
    )
  }

  reportModelApplication(agent: string, body: HomeModelApplicationReportV25, signal: AbortSignal) {
    HomeModelApplicationReportV25Schema.parse(body)
    return this.call<ModelApplicationProjectionV25>(
      agent,
      placementRoute('reportModelApplication'),
      body,
      value => requireCurrentProfile(ModelApplicationProjectionV25Schema.parse(value)),
      signal
    )
  }
}

export type {
  AgentHomeOwnerMovePreflightV25,
  AgentHomeOwnerMoveProgressV25,
  AgentHomeOwnerPlacementSnapshotV25,
  AgentHomePortableArchiveImportV25,
  ModelApplicationProjectionV25
}
