import assert from 'node:assert/strict'

import { createClient, EventType, type MatrixClient } from 'matrix-js-sdk'
import { Method } from 'matrix-js-sdk/lib/http-api/method'
import type { Logger } from 'matrix-js-sdk/lib/logger'

import { groupPausedCopy } from '../../electron/matrix/groups/budget'
import { publishPausedGroupNotice } from '../../electron/matrix/groups/paused-notice'
import type { MatrixEnrollmentIdentity } from '../../shared/matrix'
import { publishMatrixGroupNotice } from '../../src/matrix/publish-result'

interface Input {
  server: string
  sessions: { userId: string; deviceId: string; accessToken: string }[]
}
const quiet: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, getChild: () => quiet }

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 30000

  while (!check()) {
    if (Date.now() >= deadline) {
      throw Error(`groups_notice_${label}`)
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** Disposable SDK devices, scripted publication authority; separate seam tests use real PG. */
export async function runPausedMatrixProof(input: Input, phase: (value: string) => void = () => {}) {
  const clients: MatrixClient[] = []

  try {
    for (const session of input.sessions) {
      phase('sdk_crypto')
      const client = createClient({ baseUrl: input.server, ...session, logger: quiet })
      clients.push(client)
      await client.initRustCrypto({ useIndexedDB: false })
      client.getCrypto()!.globalBlacklistUnverifiedDevices = false
      phase('sdk_initial_sync')
      await client.startClient({ initialSyncLimit: 30, pollTimeout: 1000 })
      await until(() => client.isInitialSyncComplete(), 'sync_timeout')
    }

    phase('device_identity')
    const [first, second] = clients
    assert.equal(first.getUserId(), second.getUserId())
    assert.notEqual(first.getDeviceId(), second.getDeviceId())

    phase('create_room')
    const roomId = (
      await first.createRoom({
        visibility: 'private',
        initial_state: [
          { type: EventType.RoomEncryption, state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }
        ]
      })
    ).room_id

    phase('room_sync')
    await until(() => clients.every(client => !!client.getRoom(roomId)?.hasEncryptionStateEvent()), 'room_timeout')

    const publish = (client: MatrixClient, transactionId: string) =>
      publishMatrixGroupNotice(
        client,
        { kind: 'publishGroupNotice', roomId, body: groupPausedCopy.en.replace('{cap}', '3'), transactionId },
        'all'
      )

    const control = `atum-gd-${'b'.repeat(64)}`
    phase('cross_device_publish')
    const baseline = await Promise.all(clients.map(client => publish(client, control)))
    assert.notEqual(baseline[0], baseline[1], 'same transaction on distinct devices does not deduplicate')

    // Retry at the HTTP layer, bypassing the SDK helper's retained local echo.
    phase('same_device_retry')
    const wire = await first.fetchRoomEvent(roomId, baseline[0])
    assert.equal(wire.type, EventType.RoomMessageEncrypted)
    assert.ok(wire.content)
    const response = await first.http.authedRequest<{ event_id: string }>(
      Method.Put,
      `/rooms/${encodeURIComponent(roomId)}/send/${EventType.RoomMessageEncrypted}/${control}`,
      undefined,
      wire.content,
      { prefix: '/_matrix/client/v3' }
    )

    assert.equal(response.event_id, baseline[0], 'Synapse deduplicates the actual same-device request')

    let winner: string | undefined,
      receipt: string | undefined,
      lost = true
    const day = new Date().toISOString().slice(0, 10)

    const identities: MatrixEnrollmentIdentity[] = clients.map((client, index) => ({
      issuer: 'https://fixture.test',
      subject: 'owner',
      principal: 'owner',
      agentPrincipal: 'agent',
      executorId: `executor-${index}`,
      userId: client.getSafeUserId(),
      deviceId: client.getDeviceId()!,
      expiresAt: Date.now() + 3600000
    }))

    const ports = (index: number) => ({
      readPolicy: async () => ({
        policy: { v: 1 as const, agents: {}, dailyTurns: 3 },
        usage: { v: 1 as const, day, turns: 3 }
      }),
      requireRoom: async () => 'lease',
      authorize: async (request: { operation: string; executorId: string; publishedEvent?: string }) => {
        if (receipt) {
          return { version: 1, state: 'published', day, eventId: receipt }
        }

        if (request.operation === 'published') {
          receipt = request.publishedEvent

          return { version: 1, state: 'published', day, eventId: receipt }
        }

        winner ??= request.executorId

        if (request.executorId !== winner) {
          return { version: 1, state: 'busy' }
        }
        const id = identities[index]

        return {
          version: 1,
          state: 'publish',
          owner: id.principal,
          roomId,
          day,
          cap: 3,
          executorId: id.executorId,
          agentPrincipal: id.agentPrincipal,
          agentUserId: id.userId,
          deviceId: id.deviceId,
          transactionId: `atum-gd-${'a'.repeat(64)}`
        }
      },
      publish: async (transactionId: string) => {
        const eventId = await publish(clients[index], transactionId)

        if (lost) {
          lost = false
          throw Error('lost_caller_ack')
        }

        return eventId
      },
      recordUsage: async () => {}
    })

    const run = (index: number) =>
      publishPausedGroupNotice({ roomId, identity: identities[index], position: 0 }, ports(index))
    phase('reservation_lost_ack')
    await assert.rejects(() => run(0), /lost_caller_ack/)
    await run(1)
    await run(0)
    assert.ok(receipt?.startsWith('$'))
    await run(1)
    phase('encrypted_history')
    const page = await first.createMessagesRequest(roomId, null, 100, 'b' as never)
    const encrypted = page.chunk?.filter(event => event.type === EventType.RoomMessageEncrypted) ?? []
    assert.equal(encrypted.length, 3, 'two baseline duplicate events plus exactly one reserved notice')

    return {
      complete: true,
      realSdkPublish: true,
      encrypted: true,
      perDeviceTransactionScope: true,
      sameDeviceHttpRetry: true,
      reservationLostCallerAckOneEvent: true,
      scope:
        'real disposable Synapse/MAS + two synthetic SDK devices; scripted authority, separate real-PG seam; no installed Macs/phone or production proof'
    }
  } finally {
    clients.forEach(client => client.stopClient())
  }
}
