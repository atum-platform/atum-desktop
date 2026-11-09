import type { AppDescriptor } from '../../shared/app-catalog'
import type { MatrixDevice, MatrixIdentity, MatrixSdkCommand } from '../../shared/matrix'

import type { MatrixAccount } from './account'

export interface AppConversationHost {
  identity: MatrixIdentity
  queue: { command(command: MatrixSdkCommand, timeoutMs?: number): Promise<unknown> }
}

/** Fingerprints come from the two native-owned SDKs, never room content/UI. */
export async function connectAppRoom(
  roomId: string,
  human: AppConversationHost,
  app: AppConversationHost,
  live: () => void,
  readOnly = false,
  join = false
): Promise<void> {
  const check = { kind: 'readAppRoom' as const, roomId, ownerId: human.identity.userId, agentId: app.identity.userId }
  live()

  if (readOnly) {
    // Reply recovery may inspect existing membership, never accept an invite
    // or change device trust as a side effect of retrying an old event.
    await human.queue.command(check)
    live()
    await app.queue.command(check)
    live()

    return
  }

  await human.queue.command({ ...check, allowInvite: join })
  live()

  if (join) {
    await app.queue.command({ kind: 'joinAgentRoom', roomId, ownerId: human.identity.userId, scope: 'app' })
  }

  live()
  await human.queue.command(check)
  await app.queue.command(check)
  live()

  const own = ((await human.queue.command({ kind: 'devices', userId: human.identity.userId })) as MatrixDevice[]).find(
    device => device.userId === human.identity.userId && device.deviceId === human.identity.deviceId
  )

  const other = ((await app.queue.command({ kind: 'devices', userId: app.identity.userId })) as MatrixDevice[]).find(
    device => device.userId === app.identity.userId && device.deviceId === app.identity.deviceId
  )

  live()

  if (!own || !other) {
    throw new Error('matrix_app_unavailable')
  }

  await human.queue.command({ kind: 'verify', ...other })
  live()
  await app.queue.command({ kind: 'verify', ...own })
  live()
}

/** Enrollment is not room membership. The native disclosure authorizes only a
 * newly created encrypted conversation; it never imports an existing transcript. */
export async function createAppConversation(deps: {
  groupName?: string
  descriptor(): AppDescriptor
  account: Pick<MatrixAccount, 'identity' | 'appScope' | 'enrollApp'>
  human: AppConversationHost
  start(slug: string): Promise<AppConversationHost>
  confirm(app: AppDescriptor): Promise<boolean>
  active(): boolean
}): Promise<string | null> {
  const descriptor = structuredClone(deps.descriptor())
  const scope = JSON.stringify(deps.account.appScope())

  const live = () => {
    if (
      !deps.active() ||
      scope !== JSON.stringify(deps.account.appScope()) ||
      JSON.stringify(deps.descriptor()) !== JSON.stringify(descriptor) ||
      JSON.stringify(deps.account.identity()) !== JSON.stringify(deps.human.identity)
    ) {
      throw new Error('matrix_app_cancelled')
    }
  }

  live()

  if (!(await deps.confirm(descriptor))) {
    return null
  }

  live()

  const enrolled = await deps.account.enrollApp(
    {
      slug: descriptor.app,
      appId: descriptor.app_id,
      appVersionId: descriptor.app_version_id
    },
    true
  )

  live()

  if (
    enrolled.state !== 'ready' ||
    !enrolled.identity ||
    enrolled.identity.appId !== descriptor.app_id ||
    enrolled.identity.appVersionId !== descriptor.app_version_id
  ) {
    throw new Error('matrix_app_unavailable')
  }

  const app = await deps.start(descriptor.app)
  live()

  if (app.identity.userId !== enrolled.identity.userId || app.identity.deviceId !== enrolled.identity.deviceId) {
    throw new Error('matrix_app_unavailable')
  }

  const roomId = (await deps.human.queue.command(
    deps.groupName !== undefined
      ? { kind: 'createAppGroup', name: deps.groupName, app: app.identity.userId }
      : { kind: 'create', name: '', direct: true, invite: [app.identity.userId], appPair: true }
  )) as string

  live()
  await connectAppRoom(roomId, deps.human, app, live, false, true)

  return roomId
}
