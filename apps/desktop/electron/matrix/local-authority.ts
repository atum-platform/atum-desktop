import { createHash, randomUUID } from 'node:crypto'

import type { EncryptedStore } from '../encrypted-store'

import { MATRIX_TURN_RERUNS, matrixToolNames, type MatrixTurnResume } from './turn-effects'

/** A local turn's own cap, as quiet time rather than a wall clock (reliability plan §6.1 A):
 * 30 minutes, the same default as Hermes's `agent.gateway_timeout` inactivity timeout
 * (gateway/run.py). The lease (its signal aborts before it could lapse), Stop and the
 * activity watchdog end a run sooner; a run that keeps producing stream tokens or tool
 * calls may go as long as it stays active. It is also the local claim's own lifetime: a
 * claim not dispatched within it lapses and is renewed with a new fence, as on the server.
 * It was two hours (2026-10-10, "never put unnecessary constraints on them"); the audit
 * found the wall clock was doing the opposite of what it was meant to — cutting active
 * work while letting a silent hang sit for hours. */
export const LOCAL_TURN_LIMIT_MS = 30 * 60_000

interface LocalGrant {
  invocationId: string
  state: 'claimed' | 'dispatched' | 'completed'
  expiresAt: number
  requestHash: string
  senderDevice: string
  transactionId?: string
  publishedEvent?: string
  /** Set once the message has been queued again after a run that ended without an answer. */
  resume?: MatrixTurnResume
}

const text = (value: unknown, pattern: RegExp, max = 1024): value is string =>
  typeof value === 'string' && value.length <= max && pattern.test(value)

/** Which authority answers for one message on this Mac. It is chosen once, when the
 * message is first handled, and never changes, so a retry cannot run it twice. */
export type MatrixInvocationRoute = 'local' | 'platform'

export interface LocalInvocationRecords {
  /** The authority already chosen for this message, or null if it was never handled here. */
  route(roomId: string, eventId: string): MatrixInvocationRoute | null
  /** Records, before the platform is first asked, that the platform answers for it. */
  markPlatform(roomId: string, eventId: string): void
  /** The local record's grants. Only a lease holder may start a turn (claim a new record
   * or dispatch); without the lease a local record can still finish its publication. */
  authorize(input: Record<string, unknown>, leaseHeld: boolean): Promise<unknown>
}

const recordKey = (kind: 'grant' | 'platform-route', agentPrincipal: string, roomId: unknown, eventId: unknown) =>
  `matrix-local-${kind}-${createHash('sha256').update(JSON.stringify([agentPrincipal, roomId, eventId])).digest('hex')}`

/**
 * The exactly-once record the platform keeps in matrix_invocation, kept in this
 * executor's encrypted store for messages it answers under the answering lease
 * (platform 0145). It has the same key (room, event, agent), fences and transitions,
 * and returns grants of the same shape, so invocation.ts validates them exactly like
 * the server's. A record is written before its answer is returned: a crash after
 * dispatch leaves "dispatched", which is never run again.
 */
export function localInvocationRecords(
  store: EncryptedStore,
  agent: { principal: string; agentPrincipal: string; deviceId: string },
  now: () => number = Date.now
): LocalInvocationRecords {
  const read = (key: string) => {
    const raw = store.getItem(key)

    if (store.failureCode()) {
      throw new Error('matrix_vault_unavailable')
    }

    return raw
  }

  const route = (roomId: string, eventId: string): MatrixInvocationRoute | null =>
    read(recordKey('grant', agent.agentPrincipal, roomId, eventId))
      ? 'local'
      : read(recordKey('platform-route', agent.agentPrincipal, roomId, eventId))
        ? 'platform'
        : null

  const markPlatform = (roomId: string, eventId: string) => {
    store.assertEncryptionAvailable()
    store.setItem(recordKey('platform-route', agent.agentPrincipal, roomId, eventId), '1')
  }

  const authorize = async (input: Record<string, unknown>, leaseHeld: boolean): Promise<unknown> => {
    const { operation, roomId, eventId, requestHash, senderDevice, executorId, invocationId, publishedEvent } = input

    if (
      !['claim', 'dispatch', 'complete', 'published', 'requeue'].includes(operation as string) ||
      !text(roomId, /^!.+/) ||
      !text(eventId, /^\$.+/) ||
      !text(requestHash, /^[a-f0-9]{64}$/) ||
      !text(senderDevice, /^.+$/, 255) ||
      !text(executorId, /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i) ||
      Object.keys(input).some(
        key =>
          ![
            'operation',
            'roomId',
            'eventId',
            'requestHash',
            'senderDevice',
            'executorId',
            'invocationId',
            'publishedEvent',
            'effect',
            'tools'
          ].includes(key)
      )
    ) {
      throw new Error('matrix_invalid')
    }

    const key = recordKey('grant', agent.agentPrincipal, roomId, eventId)
    const raw = read(key)

    let grant = raw ? (JSON.parse(raw) as LocalGrant) : undefined
    const at = now()

    // Starting a turn needs the lease; finishing one that already ran does not.
    if (!leaseHeld && (operation === 'dispatch' || (operation === 'claim' && (!grant || grant.state === 'claimed')))) {
      throw new Error('matrix_lease_required')
    }

    if (operation === 'claim') {
      if (!grant) {
        grant = { invocationId: randomUUID(), state: 'claimed', expiresAt: at + LOCAL_TURN_LIMIT_MS, requestHash, senderDevice }
      } else if (grant.state === 'claimed' && grant.expiresAt <= at) {
        // A lapsed, never-dispatched claim is renewed with a new fence, as on the server.
        grant = { ...grant, invocationId: randomUUID(), expiresAt: at + LOCAL_TURN_LIMIT_MS, senderDevice }
      }
    }

    if (
      !grant ||
      grant.requestHash !== requestHash ||
      grant.senderDevice !== senderDevice ||
      (operation !== 'claim' && invocationId !== grant.invocationId)
    ) {
      throw new Error('matrix_denied')
    }

    if (operation === 'dispatch') {
      if (grant.state !== 'claimed' || grant.expiresAt <= at) {
        throw new Error('matrix_denied')
      }

      grant.state = 'dispatched'
    } else if (operation === 'complete') {
      if (grant.state !== 'dispatched' && grant.state !== 'completed') {
        throw new Error('matrix_denied')
      }

      grant.state = 'completed'
      grant.transactionId ??= randomUUID()
    } else if (operation === 'requeue') {
      // A run that was dispatched and ended without an answer goes back in the queue, with what
      // it is known to have done. The fence is new, so the run that ended can never complete it,
      // and the claim is lapsed so the next claim takes it. Bounded: a message runs again at most
      // MATRIX_TURN_RERUNS times. Needs no lease: the usual reason for it is a lost one.
      const effect = input.effect
      const attempt = (grant.resume?.attempt ?? 0) + 1

      if (
        grant.state !== 'dispatched' ||
        (effect !== 'none' && effect !== 'read_only' && effect !== 'side_effect_possible') ||
        attempt > MATRIX_TURN_RERUNS
      ) {
        throw new Error('matrix_denied')
      }

      grant = {
        ...grant,
        state: 'claimed',
        invocationId: randomUUID(),
        expiresAt: at,
        resume: { attempt, effect, tools: matrixToolNames(input.tools) }
      }
    } else if (operation === 'published') {
      if (
        grant.state !== 'completed' ||
        !grant.transactionId ||
        !text(publishedEvent, /^\$.+/) ||
        (grant.publishedEvent !== undefined && grant.publishedEvent !== publishedEvent)
      ) {
        throw new Error('matrix_denied')
      }

      grant.publishedEvent = publishedEvent
    }

    store.assertEncryptionAvailable()
    store.setItem(key, JSON.stringify(grant))

    return {
      roomId,
      eventId,
      requestHash,
      senderDevice,
      executorId,
      owner: agent.principal,
      payer: agent.principal,
      capability: 'local-hermes-turn',
      agentPrincipal: agent.agentPrincipal,
      agentDevice: agent.deviceId,
      invocationId: grant.invocationId,
      state: grant.state,
      expiresAt: grant.expiresAt,
      ...(grant.transactionId ? { transactionId: grant.transactionId } : {}),
      ...(grant.publishedEvent ? { publishedEvent: grant.publishedEvent } : {}),
      ...(grant.resume ? { resume: grant.resume } : {})
    }
  }

  return { route, markPlatform, authorize }
}
