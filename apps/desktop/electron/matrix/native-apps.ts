import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import type { LauncherSupportSnapshot, SkillInfo } from '../../shared/hermes-skills'
import type { MatrixEnrollment } from '../../shared/matrix'
import { MATRIX_NATIVE_APPS } from '../../shared/matrix-native-apps'
import type { NativeAppLaunchRequest } from '../../shared/skills-launcher'
import type { NativeAppInventory } from '../native-app-inventory'
import type { NativeAppsController } from '../native-apps'

import type { MatrixAgentRuntime } from './agent-runtime'
import type { MatrixHermesConnection, MatrixHermesRuntimeConfig } from './hermes-runtime'

export interface MatrixNativeAppSource {
  authority(): string
  roomId(): string | undefined
  runtime(): MatrixHermesRuntimeConfig | undefined
  agent(roomId: string): MatrixAgentRuntime | undefined
  enrollment(agent: MatrixAgentRuntime): MatrixEnrollment
  blocked(agent: MatrixAgentRuntime): boolean
  connect(agent: MatrixAgentRuntime): Promise<MatrixHermesConnection | undefined>
  connection(agent: MatrixAgentRuntime): MatrixHermesConnection | undefined
}

/** Read-only facts in the selected agent's existing home. Expiry-only credential
 * renewal is not a new identity; withdrawal/runtime/account/room changes are. */
export async function readMatrixNativeAppReadiness(source: MatrixNativeAppSource, roomId: unknown, refresh: unknown) {
  const authority = source.authority()
  const runtime = source.runtime()
  const agent = typeof roomId === 'string' && roomId === source.roomId() ? source.agent(roomId) : undefined

  if (!authority || !runtime || !agent || source.blocked(agent)) {
    throw new Error('matrix_native_apps_unavailable')
  }

  const initial = source.enrollment(agent)
  const identity = initial.identity

  if (initial.state !== 'ready' || !identity) {
    throw new Error('matrix_native_apps_unavailable')
  }

  const current = () => {
    if (
      source.authority() !== authority ||
      source.runtime() !== runtime ||
      source.roomId() !== roomId ||
      source.agent(roomId as string) !== agent ||
      source.blocked(agent)
    ) {
      return false
    }

    const enrolled = source.enrollment(agent)

    return (
      enrolled.state === 'ready' &&
      Boolean(
        enrolled.identity &&
        ['issuer', 'subject', 'principal', 'agentPrincipal', 'executorId', 'userId', 'deviceId'].every(
          key => enrolled.identity![key as keyof typeof identity] === identity[key as keyof typeof identity]
        )
      )
    )
  }

  const assertCurrent = () => {
    if (!current()) {
      throw new Error('matrix_native_apps_unavailable')
    }
  }

  assertCurrent()
  const connection = await source.connect(agent)
  assertCurrent()

  if (!connection?.pages) {
    throw new Error('matrix_native_apps_unavailable')
  }

  const assertConnection = () => {
    assertCurrent()

    if (source.connection(agent) !== connection) {
      throw new Error('matrix_native_apps_unavailable')
    }
  }

  assertConnection()
  const skills = await connection.pages({ path: '/api/skills?profile=default', method: 'GET' })
  assertConnection()

  const query = new URLSearchParams({
    cwd: connection.workspace,
    refresh: String(refresh === true),
    profile: 'default'
  })

  const support = await connection.pages({ path: `/api/skills/app-readiness?${query}`, method: 'GET' })
  assertConnection()

  // These are upstream contracts, not a second skill or probe authority.
  if (!Array.isArray(skills) || !support || typeof support !== 'object') {
    throw new Error('matrix_native_apps_unavailable')
  }

  const facts = support as LauncherSupportSnapshot
  const record = (value: unknown) => Boolean(value && typeof value === 'object' && !Array.isArray(value))

  // A changed/malformed optional response must not crash the human launcher or
  // advertise readiness. Validate only the facts consumed by the shared view.
  if (
    skills.some(skill => !skill || typeof skill.name !== 'string' || typeof skill.enabled !== 'boolean') ||
    !Array.isArray(facts.bundled) ||
    facts.bundled.some(row => !row || typeof row.name !== 'string') ||
    !Array.isArray(facts.verified_bundled) ||
    facts.verified_bundled.some(name => typeof name !== 'string') ||
    !record(facts.routes) ||
    Object.values(facts.routes).some(
      route =>
        !record(route) ||
        !record(route.operations) ||
        Object.values(route.operations).some(
          operation =>
            !operation ||
            !['ready', 'needs-setup', 'unknown'].includes(operation.state) ||
            !Array.isArray(operation.reasons) ||
            operation.reasons.some(reason => typeof reason !== 'string')
        )
    )
  ) {
    throw new Error('matrix_native_apps_unavailable')
  }

  return { skills: skills as SkillInfo[], support: facts }
}

export function registerMatrixNativeApps(
  ipc: Pick<IpcMain, 'handle'>,
  deps: {
    assertTrusted(event: IpcMainInvokeEvent): void
    authority(): string
    inventory: NativeAppInventory
    controller: NativeAppsController
    readiness(roomId: unknown, refresh: unknown): Promise<unknown>
    openSettings(): Promise<void>
  }
) {
  const register = (name: string, operation: (...args: unknown[]) => Promise<unknown>, cleanup = false) => {
    ipc.handle(name, async (event, ...args) => {
      deps.assertTrusted(event)
      const authority = deps.authority()

      if (!authority && !cleanup) {
        throw new Error('matrix_native_apps_unavailable')
      }

      const result = await operation(...args)
      deps.assertTrusted(event)

      if (authority !== deps.authority()) {
        throw new Error('NATIVE_APP_CANCELLED')
      }

      return result
    })
  }

  register(MATRIX_NATIVE_APPS.list, refresh => deps.inventory.list(refresh === true))
  register(MATRIX_NATIVE_APPS.launch, input => {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(key => !['appId', 'requestId', 'mode', 'windowId'].includes(key))
    ) {
      throw new Error('NATIVE_APP_INVALID_REQUEST')
    }

    return deps.controller.launch(input as NativeAppLaunchRequest)
  })
  register(
    MATRIX_NATIVE_APPS.end,
    id => {
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/iu.test(id)) {
        throw new Error('NATIVE_APP_INVALID_REQUEST')
      }

      return deps.controller.end(id)
    },
    true
  )
  register(MATRIX_NATIVE_APPS.settings, () => deps.openSettings())
  register(MATRIX_NATIVE_APPS.readiness, (roomId, refresh) => deps.readiness(roomId, refresh))
}
