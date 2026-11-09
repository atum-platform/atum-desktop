import type { MessagingTokenSource } from './http-client'
import type { MessagingRealtimeAdvertisement, MessagingSyncStatus, MessagingTransportStatus } from './types'

interface RealtimeChannelLike {
  on(type: 'broadcast', filter: { event: string }, callback: (message: unknown) => void): RealtimeChannelLike
  subscribe(callback: (status: string, error?: Error) => void): RealtimeChannelLike
  unsubscribe(): Promise<unknown> | unknown
  send?(payload: { type: 'broadcast'; event: string; payload: Record<string, unknown> }): Promise<unknown>
}

interface RealtimeClientLike {
  channel(topic: string, options: { config: { private: true } }): RealtimeChannelLike
  connect(): void
  disconnect(): void
  setAuth(token: string): void
}

export interface MessagingSyncCoordinatorOptions {
  realtimeUrl: string
  anonKey: string
  tokens: MessagingTokenSource
  advertisement: () => Promise<MessagingRealtimeAdvertisement>
  sync: () => Promise<MessagingSyncStatus>
  status: () => Promise<MessagingSyncStatus>
  /** A current-account cursor-ahead hint can wake dependent job intake. */
  onActivity?: () => void
  transportChanged?: (status: MessagingTransportStatus) => void
  typingChanged?: (payload: { conversationId: string; accountId: string; typing: boolean }) => void
  log?: (message: string) => void
  createClient?: (url: string, anonKey: string) => Promise<RealtimeClientLike>
  now?: () => number
  random?: () => number
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  debounceMs?: number
  keepaliveMs?: number
  refreshSkewMs?: number
}

const SUBSCRIBED = 'SUBSCRIBED'
const CLOSED_STATUSES = new Set(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'])

function realtimeEndpoint(url: string): string {
  const parsed = new URL(url)
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, '')}/realtime/v1`
  parsed.search = ''
  parsed.hash = ''

  return parsed.toString().replace(/\/$/u, '')
}

async function defaultCreateClient(url: string, anonKey: string): Promise<RealtimeClientLike> {
  const { RealtimeClient } = (await import('@supabase/realtime-js')) as {
    RealtimeClient: new (endpoint: string, options: Record<string, unknown>) => RealtimeClientLike
  }

  return new RealtimeClient(realtimeEndpoint(url), { params: { apikey: anonKey } })
}

function cursorParts(cursor: string): { prefix: string; sequence: bigint } | null {
  const match = /^(.*?)(\d+)$/u.exec(cursor)

  return match ? { prefix: match[1], sequence: BigInt(match[2]) } : null
}

export function cursorHintIsAhead(hint: string | null, local: string | null): boolean {
  if (!hint || hint === local) {
    return false
  }

  if (!local) {
    return true
  }

  const hinted = cursorParts(hint)
  const current = cursorParts(local)

  return !hinted || !current || hinted.prefix !== current.prefix || hinted.sequence > current.sequence
}

function cursorHint(message: unknown): string | null {
  if (!message || typeof message !== 'object') {
    return null
  }

  const envelope = message as Record<string, unknown>
  const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : envelope
  const hint = (payload as Record<string, unknown>).cursor_hint

  return typeof hint === 'string' && hint.length <= 8_192 ? hint : null
}

export class MessagingSyncCoordinator {
  private readonly now: () => number
  private readonly random: () => number
  private readonly setTimer: NonNullable<MessagingSyncCoordinatorOptions['setTimer']>
  private readonly clearTimer: NonNullable<MessagingSyncCoordinatorOptions['clearTimer']>
  private readonly createClient: NonNullable<MessagingSyncCoordinatorOptions['createClient']>
  private readonly debounceMs: number
  private readonly keepaliveMs: number
  private readonly refreshSkewMs: number
  private epoch = 0
  private client: RealtimeClientLike | null = null
  private channel: RealtimeChannelLike | null = null
  private readonly typingChannels = new Map<string, RealtimeChannelLike>()
  private accountId: string | null = null
  private healthy = false
  private dirty = false
  private syncing = false
  private trailingTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0

  constructor(private readonly options: MessagingSyncCoordinatorOptions) {
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
    this.createClient = options.createClient ?? defaultCreateClient
    this.debounceMs = options.debounceMs ?? 350
    this.keepaliveMs = options.keepaliveMs ?? 120_000
    this.refreshSkewMs = options.refreshSkewMs ?? 60_000
  }

  status(): MessagingTransportStatus {
    return {
      accountId: this.accountId,
      healthy: this.healthy,
      state: this.accountId ? (this.healthy ? 'healthy' : this.client ? 'connecting' : 'degraded') : 'disabled'
    }
  }

  async start(): Promise<void> {
    const epoch = await this.beginLifecycle()
    const session = this.options.tokens.current()

    if (!session) {
      this.publishStatus()

      return
    }

    this.accountId = session.user.id
    this.publishStatus()

    try {
      const advertisement = await this.options.advertisement()

      if (!this.isCurrent(epoch, session.user.id)) {
        return
      }

      const client = await this.createClient(this.options.realtimeUrl, this.options.anonKey)

      if (!this.isCurrent(epoch, session.user.id)) {
        client.disconnect()

        return
      }

      this.client = client
      client.setAuth(session.tokens.accessToken)
      const channel = client.channel(advertisement.topic, { config: { private: true } })
      this.channel = channel
      channel
        .on(
          'broadcast',
          { event: advertisement.event },
          message => void this.handleHint(epoch, session.user.id, message)
        )
        .subscribe((status, error) => this.handleChannelStatus(epoch, session.user.id, status, error))
      client.connect()
      this.scheduleRefresh(epoch, session.user.id)
      this.scheduleKeepalive(epoch, session.user.id)
    } catch (error) {
      if (this.isCurrent(epoch, session.user.id)) {
        this.degrade(error)
        this.scheduleReconnect(epoch, session.user.id)
      }
    }
  }

  async stop(): Promise<void> {
    await this.beginLifecycle()
  }

  reconnect(): void {
    if (this.options.tokens.current()) {
      void this.start()
    }
  }

  async sendTyping(conversationId: string, typing: boolean): Promise<boolean> {
    const accountId = this.accountId
    const epoch = this.epoch

    if (!accountId || !this.healthy || !this.client || !this.isCurrent(epoch, accountId)) {
      return false
    }
    let channel = this.typingChannels.get(conversationId)

    if (!channel) {
      channel = this.client.channel(`conversation:${conversationId}:typing:v1`, { config: { private: true } })
      this.typingChannels.set(conversationId, channel)
      channel
        .on('broadcast', { event: 'typing' }, message => this.handleTyping(epoch, accountId, message))
        .subscribe(() => undefined)
    }

    if (!channel.send) {
      return false
    }
    await channel.send({
      type: 'broadcast',
      event: 'typing',
      payload: { conversation_id: conversationId, account_id: accountId, typing }
    })

    return this.isCurrent(epoch, accountId)
  }

  private handleTyping(epoch: number, accountId: string, message: unknown): void {
    if (!this.isCurrent(epoch, accountId) || !message || typeof message !== 'object') {
      return
    }
    const envelope = message as Record<string, unknown>
    const payload = (envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : envelope) as Record<
      string,
      unknown
    >

    if (
      typeof payload.conversation_id !== 'string' ||
      typeof payload.account_id !== 'string' ||
      typeof payload.typing !== 'boolean' ||
      payload.account_id === accountId
    ) {
      return
    }
    this.options.typingChanged?.({
      conversationId: payload.conversation_id,
      accountId: payload.account_id,
      typing: payload.typing
    })
  }

  private async beginLifecycle(): Promise<number> {
    this.epoch += 1
    this.healthy = false
    this.dirty = false
    this.syncing = false
    this.accountId = null
    this.cancelTimers()
    const channel = this.channel
    const typingChannels = [...this.typingChannels.values()]
    const client = this.client
    this.channel = null
    this.typingChannels.clear()
    this.client = null
    client?.disconnect()

    await Promise.allSettled([
      ...(channel ? [Promise.resolve(channel.unsubscribe())] : []),
      ...typingChannels.map(typingChannel => Promise.resolve(typingChannel.unsubscribe()))
    ])

    return this.epoch
  }

  private handleChannelStatus(epoch: number, accountId: string, status: string, error?: Error): void {
    if (!this.isCurrent(epoch, accountId)) {
      return
    }

    if (status === SUBSCRIBED) {
      this.healthy = true
      this.reconnectAttempt = 0
      this.publishStatus()

      return
    }

    if (CLOSED_STATUSES.has(status)) {
      this.degrade(error ?? new Error(status.toLowerCase()))
      this.scheduleReconnect(epoch, accountId)
    }
  }

  private async handleHint(epoch: number, accountId: string, message: unknown): Promise<void> {
    if (!this.isCurrent(epoch, accountId)) {
      return
    }
    const local = (await this.options.status()).cursor

    if (!this.isCurrent(epoch, accountId) || !cursorHintIsAhead(cursorHint(message), local)) {
      return
    }

    this.options.onActivity?.()
    this.dirty = true

    if (!this.trailingTimer) {
      void this.flush(epoch, accountId)
    }

    this.trailingTimer && this.clearTimer(this.trailingTimer)
    this.trailingTimer = this.setTimer(() => {
      this.trailingTimer = null
      void this.flush(epoch, accountId)
    }, this.debounceMs)
  }

  private async flush(epoch: number, accountId: string): Promise<void> {
    if (!this.isCurrent(epoch, accountId) || this.syncing || !this.dirty) {
      return
    }
    this.dirty = false
    this.syncing = true

    try {
      await this.options.sync()
    } catch (error) {
      // A failed pull must never become an unhandled rejection from a timer
      // callback; the poll fallback and the next hint retry it.
      this.options.log?.(`[atum-realtime] sync failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.syncing = false

      if (this.isCurrent(epoch, accountId) && this.dirty && !this.trailingTimer) {
        void this.flush(epoch, accountId)
      }
    }
  }

  private scheduleKeepalive(epoch: number, accountId: string): void {
    this.keepaliveTimer = this.setTimer(async () => {
      this.keepaliveTimer = null

      if (!this.isCurrent(epoch, accountId)) {
        return
      }

      try {
        await this.options.sync()
      } catch (error) {
        // One failed keepalive sync must not end keepalives forever.
        this.options.log?.(
          `[atum-realtime] keepalive sync failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }

      if (this.isCurrent(epoch, accountId)) {
        this.scheduleKeepalive(epoch, accountId)
      }
    }, this.keepaliveMs)
  }

  private scheduleRefresh(epoch: number, accountId: string): void {
    const expiresAt = this.options.tokens.current()?.tokens.expiresAt

    if (!expiresAt) {
      return
    }
    const delay = Math.max(0, expiresAt * 1_000 - this.now() - this.refreshSkewMs)
    this.refreshTimer = this.setTimer(() => void this.refreshAuth(epoch, accountId), delay)
  }

  private async refreshAuth(epoch: number, accountId: string): Promise<void> {
    const current = this.options.tokens.current()

    if (!current || !this.isCurrent(epoch, accountId)) {
      return
    }
    const refreshed = await this.options.tokens.refresh(current)

    if (!refreshed || !this.isCurrent(epoch, accountId)) {
      return
    }
    this.client?.setAuth(refreshed.tokens.accessToken)
    this.scheduleRefresh(epoch, accountId)
  }

  private scheduleReconnect(epoch: number, accountId: string): void {
    if (this.reconnectTimer || !this.isCurrent(epoch, accountId)) {
      return
    }
    const ceiling = Math.min(1_000 * 2 ** Math.min(this.reconnectAttempt++, 6), 60_000)
    const delay = Math.round(ceiling * (0.5 + this.random() * 0.5))
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null

      if (this.isCurrent(epoch, accountId)) {
        void this.start()
      }
    }, delay)
  }

  private degrade(error: unknown): void {
    this.healthy = false
    this.publishStatus()
    this.options.log?.(`[atum-realtime] degraded: ${error instanceof Error ? error.message : String(error)}`)
  }

  private publishStatus(): void {
    this.options.transportChanged?.(this.status())
  }

  private isCurrent(epoch: number, accountId: string): boolean {
    return epoch === this.epoch && this.accountId === accountId && this.options.tokens.current()?.user.id === accountId
  }

  private cancelTimers(): void {
    for (const timer of [this.trailingTimer, this.reconnectTimer, this.keepaliveTimer, this.refreshTimer]) {
      if (timer) {
        this.clearTimer(timer)
      }
    }

    this.trailingTimer = this.reconnectTimer = this.keepaliveTimer = this.refreshTimer = null
  }
}
