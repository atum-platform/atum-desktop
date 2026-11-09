import { createHash } from 'node:crypto'

import type { PublicationEventType } from './agent-home-placement/contract'
import type { PublicationStore } from './agent-home-placement/publication'

const KEY_PREFIX = 'agent-sweep-publication-v1:'
const MAX_PAYLOAD_BYTES = 64 * 1024

interface PublicationRecord {
  v: 1
  agent: string
  occurrenceId: string
  outboxId: string
  roomId: string
  transactionId: string
  eventType: PublicationEventType
  payloadBase64: string
  payloadSha256: string
  bodySha256: string
}

export interface BackgroundSweepPublicationInput {
  agent: string
  occurrenceId: string
  roomId: string
  body: string
  google: boolean
}

export interface BackgroundSweepPublicationStage {
  outboxId: string
  bodySha256: string
}

export interface BackgroundSweepPublicationDeps {
  store(agent: string): PublicationStore | null
  prepare(input: BackgroundSweepPublicationInput & { transactionId: string }): Promise<{
    eventType: PublicationEventType
    content: object
  }>
  enqueue(record: Readonly<PublicationRecord>, signal: AbortSignal): Promise<void>
}

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')

function outboxIdOf(agent: string, occurrenceId: string): string {
  const bytes = createHash('sha256')
    .update(`atum.agent-home/2.1 publication ${agent} job ${occurrenceId} 0`)
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const keyOf = (agent: string, occurrenceId: string) => `${KEY_PREFIX}${agent}:${occurrenceId}`

function readRecord(store: PublicationStore, key: string): PublicationRecord | null {
  try {
    const value = JSON.parse(store.getItem(key) ?? 'null') as PublicationRecord | null

    return value?.v === 1 ? value : null
  } catch {
    return null
  }
}

/** Stages exact Matrix event bytes in the normal home-publication outbox before sweep settlement. */
export class MatrixBackgroundSweepPublication {
  private readonly inflight = new Map<string, Promise<BackgroundSweepPublicationStage>>()

  constructor(private readonly deps: BackgroundSweepPublicationDeps) {}

  stage(input: BackgroundSweepPublicationInput, signal: AbortSignal): Promise<BackgroundSweepPublicationStage> {
    const key = keyOf(input.agent, input.occurrenceId)
    const running = this.inflight.get(key)

    if (running) {
      return running
    }

    const run = this.run(input, key, signal).finally(() => {
      if (this.inflight.get(key) === run) {
        this.inflight.delete(key)
      }
    })
    this.inflight.set(key, run)
    return run
  }

  settled(agent: string, occurrenceId: string): void {
    try {
      this.deps.store(agent)?.removeItem(keyOf(agent, occurrenceId))
    } catch {
      // The platform owns the admitted/refused row; a stale local copy only replays identical bytes.
    }
  }

  private async run(
    input: BackgroundSweepPublicationInput,
    key: string,
    signal: AbortSignal
  ): Promise<BackgroundSweepPublicationStage> {
    const store = this.deps.store(input.agent)

    if (!store) {
      throw new Error('matrix_background_sweep_publication_unavailable')
    }

    const transactionId = `atum-sweep-${input.occurrenceId}`
    const expectedOutbox = outboxIdOf(input.agent, input.occurrenceId)
    const expectedBody = sha256(input.body)
    let record = readRecord(store, key)

    if (
      record &&
      (record.outboxId !== expectedOutbox ||
        record.roomId !== input.roomId ||
        record.transactionId !== transactionId ||
        record.bodySha256 !== expectedBody)
    ) {
      throw new Error('matrix_background_sweep_publication_conflict')
    }

    if (!record) {
      signal.throwIfAborted()
      const prepared = await this.deps.prepare({ ...input, transactionId })
      const bytes = Buffer.from(JSON.stringify(prepared.content), 'utf8')

      if (
        !['m.room.message', 'm.room.encrypted'].includes(prepared.eventType) ||
        bytes.length < 2 ||
        bytes.length > MAX_PAYLOAD_BYTES
      ) {
        throw new Error('matrix_background_sweep_publication_invalid')
      }

      record = {
        v: 1,
        agent: input.agent,
        occurrenceId: input.occurrenceId,
        outboxId: expectedOutbox,
        roomId: input.roomId,
        transactionId,
        eventType: prepared.eventType,
        payloadBase64: bytes.toString('base64'),
        payloadSha256: sha256(bytes),
        bodySha256: expectedBody
      }
      store.setItem(key, JSON.stringify(record))
    }

    signal.throwIfAborted()
    await this.deps.enqueue(record, signal)
    return { outboxId: record.outboxId, bodySha256: record.payloadSha256 }
  }
}
