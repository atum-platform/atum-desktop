import type { ChatDraft, ChatSend, ChatStorage } from './chat-storage'
import type { BrowserChatMessage } from './chat-types'

export class UncertainChatSend extends Error {
  constructor() {
    super('send_uncertain')
  }
}

/** Persist before IO. An uncertain send is retried only by intent, with the same device/txn. */
export class ChatOutbox {
  private closed = false
  private busy = new Set<string>()
  constructor(
    private readonly store: Pick<ChatStorage, 'putSend' | 'dropSend' | 'sends'>,
    private readonly identity: { userId: string; deviceId: string },
    private readonly send: (roomId: string, body: string, transactionId: string) => Promise<string>,
    private readonly epoch: () => string
  ) {}
  list() {
    return this.store.sends(this.identity.userId, this.identity.deviceId)
  }
  close() {
    this.closed = true
  }
  async submit(roomId: string, body: string, draft?: ChatDraft, persisted?: () => void): Promise<void> {
    if (this.closed || !body.trim() || body.length > 32000) throw new Error('send_unavailable')
    const record: ChatSend = {
      ...this.identity,
      roomId,
      body,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      credentialEpoch: this.epoch(),
      phase: 'uncertain'
    }
    await this.store.putSend(record, draft)
    persisted?.()
    try {
      await this.retry(record)
    } catch {
      throw new UncertainChatSend()
    }
  }
  canRetry(record: ChatSend): boolean {
    return !this.closed && record.phase === 'uncertain' && record.credentialEpoch === this.epoch()
  }
  async retry(record: ChatSend): Promise<void> {
    if (
      !this.canRetry(record) ||
      this.busy.has(record.id) ||
      record.userId !== this.identity.userId ||
      record.deviceId !== this.identity.deviceId
    )
      throw new Error('send_unavailable')
    this.busy.add(record.id)
    try {
      if (this.closed) throw new Error('send_unavailable')
      const eventId = await this.send(record.roomId, record.body, record.id)
      if (typeof eventId !== 'string' || !eventId.startsWith('$')) throw new Error('send_uncertain')
      // A server event id confirms the transaction. Remove the journal entry
      // instead of publishing a second "sent" write that can race the SDK echo.
      await this.store.dropSend(record.id)
    } finally {
      this.busy.delete(record.id)
    }
  }
  async reconcile(roomId: string, messages: readonly BrowserChatMessage[]): Promise<void> {
    const sends = await this.list()
    for (const record of sends) {
      if (
        record.roomId === roomId &&
        messages.some(
          message =>
            message.own && message.sent && message.matrixTransactionId === record.id
        )
      )
        await this.store.dropSend(record.id)
    }
  }
}
