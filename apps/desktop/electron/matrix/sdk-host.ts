import type { AppDescriptor } from '../../shared/app-catalog'
import type {
  MatrixAppEnrollment,
  MatrixIdentity,
  MatrixRefreshResult,
  MatrixSdkConfiguration,
  MatrixSnapshot
} from '../../shared/matrix'

/** Human SDK readiness is the main snapshot, not host.ready (agent/app only). */
export function matrixHumanSdkReady(state: MatrixSnapshot['state'], host: object | undefined): boolean {
  return state === 'ready' && Boolean(host)
}

/** `agent` is the default agent; `agent:<principal>` is another of the person's agents
 * ( §2.3). */
export type MatrixHostRole = 'human' | 'agent' | `app:${string}` | `agent:${string}`

/** Native-owned host selection; neither a UI nor an SDK sender selects a slug. */
export function matrixHostApp(role: MatrixHostRole): string | undefined {
  return role.startsWith('app:') ? role.slice(4) : undefined
}

/** Another agent's host: its principal. The default agent's role (`agent`) has none. */
export function matrixHostAgent(role: MatrixHostRole): string | undefined {
  return role.startsWith('agent:') ? role.slice(6) : undefined
}

/** Intentional stop/expiry of one participant must not cancel another engine's turn. */
export function matrixInvocationUses(role: MatrixHostRole, appSlug?: string): boolean {
  return role === 'human' || role === (appSlug ? `app:${appSlug}` : 'agent')
}

/** Temporary outages suspend custody; changed/revoked authority ends it. */
export function appHostDisposition(
  enrolled: MatrixAppEnrollment,
  app?: Pick<AppDescriptor, 'app_id' | 'app_version_id' | 'availability' | 'link' | 'matrix_room_context'>
): 'restore' | 'suspend' | 'withdraw' {
  if (enrolled.state === 'absent') {
    return 'suspend'
  }

  if (
    enrolled.state === 'revoking' ||
    enrolled.state === 'expired' ||
    !app ||
    app.link.state !== 'linked' ||
    enrolled.selection?.appId !== app.app_id ||
    enrolled.selection?.appVersionId !== app.app_version_id
  ) {
    return 'withdraw'
  }

  // Pending issuance is never replayed in the background. Explicit retry or
  // withdrawal must decide its disposition; retain the exact selection meanwhile.
  return enrolled.state === 'ready' && app.availability === 'available' && app.matrix_room_context === 'addressed_only'
    ? 'restore'
    : 'suspend'
}

export function boundSdkConfiguration(
  account: {
    sdkConfiguration(): MatrixSdkConfiguration
    agentSdkConfiguration(slug?: string | { agent: string }): MatrixSdkConfiguration
  },
  role: MatrixHostRole,
  identity: MatrixIdentity,
  /** An agent host's refresh handle (matrixAgentSdkRefresh): its SDK asks main for the
   * renewed token with it. Never a credential. */
  refreshHandle?: string
): MatrixSdkConfiguration {
  const agent = matrixHostAgent(role)

  // Each agent's host gets its own credentials: never the default agent's or an app's.
  const value =
    role === 'human'
      ? account.sdkConfiguration()
      : agent !== undefined
        ? account.agentSdkConfiguration({ agent })
        : account.agentSdkConfiguration(matrixHostApp(role))

  if (value.userId !== identity.userId || value.deviceId !== identity.deviceId) {
    throw new Error('matrix_sdk_identity_changed')
  }

  // Only the person's desktop projection needs SDK threads. Agent, app-bot and controller
  // engines consume room events as intake and must retain the SDK's threadSupport=false default.
  const scoped = role === 'human' ? { ...value, threadSupport: true as const } : value

  return refreshHandle !== undefined && matrixAgentRenews(role) ? { ...scoped, refreshToken: refreshHandle } : scoped
}

/** The hosts whose credential main renews before it expires: the person's agents, never the
 * person's own (MAS refreshes it) and never an app's (its consent is not renewed). */
export function matrixAgentRenews(role: MatrixHostRole): boolean {
  return role === 'agent' || matrixHostAgent(role) !== undefined
}

/**
 * Core SDK renderers are replaceable I/O surfaces. Their main-owned account/agent runtime,
 * Hermes process and lease survive a renderer crash; app renderers own the app execution itself.
 */
export function matrixSdkRendererRestartable(role: MatrixHostRole, hasAgentRuntime: boolean): boolean {
  return role === 'human' || (matrixAgentRenews(role) && hasAgentRuntime)
}

/** How long an agent SDK's refresh waits for main's renewal in flight (matrixAgentSdkRefresh). */
export const MATRIX_AGENT_REFRESH_WAIT_MS = 45_000

/**
 * An agent host's token refresh (launch checklist G1-12; RT slice 2). Its SDK asks when the
 * server refused its token, or when main tells it that it renewed the executor's credential.
 * It gets main's current token only when that is not the one it already holds: main renews,
 * the SDK never does, so a renderer cannot extend its own lifetime, and a token the server
 * refused is never handed back to be refused again.
 *
 * - The wrong handle, or no current credential for this host: sign out (the host is ending).
 * - The vault could not be read just now (`matrix_vault_unavailable`): a passing failure, asked
 *   again later; never a sign-out, which would end the agent's engine over a busy disk.
 * - A newer token: handed over, and `holds` becomes it.
 * - The same token while main is renewing, or when a due renewal starts now because of
 *   this refusal: the answer waits for that renewal (at most `waitMs`). MAS revokes the old
 *   token as the platform rotates, a moment before main hears back, and a request that falls
 *   in that moment gets the new token instead of failing. The default covers a renewal's
 *   worst case: a domain-grant refresh and two enrollment requests of up to 10 s each.
 * - The same token otherwise: a transient failure; main's next renewal fixes it.
 */
export async function matrixAgentSdkRefresh(input: {
  handle: string
  expected: string | undefined
  /** This host's current configuration (boundSdkConfiguration); throws when it has none. */
  configuration(): MatrixSdkConfiguration
  /** A digest of the token this host holds. */
  holds: string | undefined
  digest(token: string): string
  /** Main's renewal of this host's credential, while one is in flight. */
  renewing?(): Promise<unknown> | undefined
  waitMs?: number
}): Promise<{ result: MatrixRefreshResult; holds?: string }> {
  if (!input.expected || input.handle !== input.expected) {
    return { result: { ok: false, reauthenticate: true } }
  }

  const answer = (): { result: MatrixRefreshResult; holds?: string } => {
    let current: MatrixSdkConfiguration

    try {
      current = input.configuration()
    } catch (error) {
      return {
        result: {
          ok: false,
          reauthenticate: !(error instanceof Error && error.message === 'matrix_vault_unavailable')
        }
      }
    }

    const holds = input.digest(current.accessToken)

    return holds === input.holds
      ? { result: { ok: false, reauthenticate: false } }
      : { result: { ok: true, accessToken: current.accessToken, refreshToken: input.expected! }, holds }
  }

  const first = answer()
  const renewing = first.result.ok === false && !first.result.reauthenticate ? input.renewing?.() : undefined

  if (!renewing) {
    return first
  }

  let timer: ReturnType<typeof setTimeout> | undefined

  await Promise.race([
    renewing.catch(() => {}),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, input.waitMs ?? MATRIX_AGENT_REFRESH_WAIT_MS)
    })
  ])
  clearTimeout(timer)

  return answer()
}

/** App storage failure cannot leave either SDK running or block Matrix logout.
 * The view controller retains its deny barrier; cold sweep retries cleanup. */
export async function stopSdkWithApps(
  resetApps: () => Promise<void>,
  stopHuman: () => Promise<void>,
  stopAgent: () => Promise<void>,
  appCleanupFailed: () => void
) {
  await resetApps().catch(() => appCleanupFailed())
  await Promise.all([stopHuman(), stopAgent()])
}

/** One command queue per SDK process. Responses cannot cross human/agent hosts. It lives
 * with the SDK seam, so browser and headless hosts use the same queue (G8-36). */
export { MatrixSdkHost } from '../../src/matrix/sdk-host-queue'
