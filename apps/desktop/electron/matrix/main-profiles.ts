import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import type { MatrixEnrollment, MatrixIdentity, MatrixSnapshot } from '../../shared/matrix'
import type { MatrixMemberAvatar, MatrixProfileTarget } from '../../shared/matrix-profile'

import type { MatrixAccount } from './account'
import type { MatrixAgentRuntime } from './agent-runtime'
import { sameMatrixEnrollment } from './enrollment'
import type { MatrixProfileHost, MatrixProfiles } from './profile'
import { type MatrixHostRole, matrixHumanSdkReady, type MatrixSdkHost } from './sdk-host'

interface Host {
  identity: MatrixIdentity
  ready?: boolean
  queue: Pick<MatrixSdkHost, 'command'>
}

export interface MatrixMainProfilesSource {
  account(): Pick<MatrixAccount, 'identity' | 'appScope'> | undefined
  state(): Pick<MatrixSnapshot, 'state' | 'identity'>
  closing(): boolean
  hosts: ReadonlyMap<MatrixHostRole, Host>
  agents(): readonly MatrixAgentRuntime[]
  enrollment(agent: MatrixAgentRuntime): MatrixEnrollment
  blocked(agent: MatrixAgentRuntime): boolean
}

const sameIdentity = (a: MatrixIdentity | null | undefined, b: MatrixIdentity | null | undefined) =>
  Boolean(a && b && a.userId === b.userId && a.deviceId === b.deviceId)

/**
 * The joined room whose members include this Matrix user, for an authenticated roster avatar
 * read. The open chat wins; otherwise any joined room the person shares is enough, because a
 * Matrix profile photo is the same in every room. Membership is re-checked by the SDK host.
 */
export function matrixMemberAvatarRoom(
  state: Pick<MatrixSnapshot, 'roomId' | 'rooms'>,
  userId: string
): string | undefined {
  const hasMember = (room: MatrixSnapshot['rooms'][number]) =>
    room.membership === 'join' &&
    Boolean(
      room.participants?.some(
        member => member.userId === userId && ['join', 'invite'].includes(member.membership)
      )
    )

  return state.rooms.find(room => room.id === state.roomId && hasMember(room))?.id ?? state.rooms.find(hasMember)?.id
}

/** Native selects an existing own SDK session. Photos require neither a Hermes turn
 * nor an execution lease. Human profile access remains independent of agent enrollment. */
export function matrixMainProfileHost(
  source: MatrixMainProfilesSource,
  target: MatrixProfileTarget
): MatrixProfileHost | undefined {
  const account = source.account()
  const human = source.hosts.get('human')
  const owner = source.state().identity

  const humanCurrent = () =>
    Boolean(
      account &&
      human &&
      !source.closing() &&
      source.account() === account &&
      source.hosts.get('human') === human &&
      matrixHumanSdkReady(source.state().state, human) &&
      sameIdentity(source.state().identity, owner) &&
      sameIdentity(account.identity(), owner) &&
      sameIdentity(human.identity, owner)
    )

  if (!humanCurrent()) {
    return undefined
  }

  if (target.kind === 'human') {
    return {
      identity: human!.identity,
      current: humanCurrent,
      command: command => human!.queue.command(command, 60_000)
    }
  }

  const matches = source.agents().filter(agent => agent.agentPrincipal === target.principal)
  const agent = matches.length === 1 ? matches[0] : undefined
  const scope = account!.appScope()

  if (!agent || !scope || agent.closed || source.blocked(agent)) {
    return undefined
  }

  const enrollment = source.enrollment(agent)
  const host = source.hosts.get(agent.role)

  if (
    !host?.ready ||
    enrollment.state !== 'ready' ||
    !enrollment.identity ||
    enrollment.identity.agentPrincipal !== target.principal ||
    !sameIdentity(host.identity, enrollment.identity)
  ) {
    return undefined
  }

  const current = () => {
    if (!humanCurrent() || agent.closed || source.blocked(agent) || !source.agents().includes(agent)) {
      return false
    }

    const nextScope = account!.appScope()

    return Boolean(
      nextScope &&
      nextScope.accountKey === scope.accountKey &&
      nextScope.generation === scope.generation &&
      agent.agentPrincipal === target.principal &&
      source.hosts.get(agent.role) === host &&
      host.ready &&
      sameIdentity(host.identity, enrollment.identity) &&
      sameMatrixEnrollment(source.enrollment(agent), enrollment)
    )
  }

  return { identity: host.identity, current, command: command => host.queue.command(command, 60_000) }
}

/** Fixed trusted UI operations; no user IDs, access tokens or SDK commands from the renderer. */
export function registerMatrixProfilesIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  profiles: MatrixProfiles,
  requireCaller: (event: IpcMainInvokeEvent) => void
) {
  ipc.handle('matrix:profiles:read', (event, target: unknown) => {
    requireCaller(event)

    return profiles.read(target)
  })
  ipc.handle('matrix:profiles:open', (event, target: unknown) => {
    requireCaller(event)

    return profiles.open(target)
  })
  ipc.handle('matrix:profiles:change', (event, scope: unknown, change: unknown) => {
    requireCaller(event)

    return profiles.change(scope, change)
  })
  ipc.handle('matrix:profiles:close', (event, scope: unknown) => {
    requireCaller(event)

    return profiles.close(scope)
  })
}

/** A member's photo for the chat on screen. Native names the member: the window never picks
 * media, and the SDK host checks the membership again before downloading it. */
export function registerMatrixMemberAvatarIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  read: (userId: unknown) => Promise<MatrixMemberAvatar | null>,
  requireCaller: (event: IpcMainInvokeEvent) => void
) {
  ipc.handle('matrix:profiles:member', (event, userId: unknown) => {
    requireCaller(event)

    return read(userId)
  })
}
