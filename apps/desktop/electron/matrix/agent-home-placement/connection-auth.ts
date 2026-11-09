/** Identity-key signing for `atum.agent-home/2.5` owner and Mac messages. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'

import {
  MacExecutorSignedMetaV25Schema,
  OwnerClientSignedMetaV25Schema,
  placementConnectionSignedBytes,
  type S3_V25_MESSAGE_SCHEMAS
} from './contract-v25'
import type { ExecutorKey } from './executor-auth'

interface SequenceStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  failureCode(): string | null
}

export type PlacementConnectionAuthFailure =
  | 'device_not_enrolled'
  | 'key_mismatch'
  | 'store_unavailable'
  | 'signing_failed'
  | 'invalid_frame'

export class PlacementConnectionAuthError extends Error {
  constructor(readonly code: PlacementConnectionAuthFailure) {
    super(`agent_home_connection_${code}`)
    this.name = 'PlacementConnectionAuthError'
  }
}

export interface PlacementConnectionAuthOptions {
  key(): ExecutorKey | null
  store: SequenceStore
  now?(): number
  uuid?(): string
  random?(size: number): Uint8Array
}

type Message = keyof typeof S3_V25_MESSAGE_SCHEMAS

/**
 * A retry of one logical operation keeps its `requestId` (with the operation's idempotency key, which the caller
 * owns); everything else in the metadata is renewed, because authentication is not part of the operation's identity.
 */
export interface PlacementSigningOptions {
  requestId?: string
}
type OwnerMeta = Omit<ReturnType<typeof OwnerClientSignedMetaV25Schema.parse>, 'signature'>
type MacMeta = Omit<ReturnType<typeof MacExecutorSignedMetaV25Schema.parse>, 'signature'>

const TTL_MS = 5 * 60_000
const BACKDATE_MS = 5_000
const MAX_LIFETIME_MS = 7_200_000
const UNSIGNED = 'A'.repeat(86)

export class PlacementConnectionAuth {
  constructor(private readonly options: PlacementConnectionAuthOptions) {}

  deviceServiceId(): string | null {
    return this.options.key()?.deviceServiceId ?? null
  }

  private nextSequence(deviceServiceId: string, signer: 'owner_client' | 'mac_executor'): number {
    const key = `agent-home-v24-${signer}-sequence-v1:${deviceServiceId}`
    const raw = this.options.store.getItem(key)

    if (this.options.store.failureCode()) {throw new PlacementConnectionAuthError('store_unavailable')}

    const last = raw === null ? 0 : Number(raw)
    if (!Number.isSafeInteger(last) || last < 0) {throw new PlacementConnectionAuthError('store_unavailable')}

    const next = Math.max(last + 1, this.options.now?.() ?? Date.now())
    try {
      this.options.store.setItem(key, String(next))
    } catch {
      throw new PlacementConnectionAuthError('store_unavailable')
    }

    return next
  }

  private async signed<B extends { meta: Record<string, unknown> & { signature?: string } }>(
    message: Message,
    signer: 'owner_client' | 'mac_executor',
    build: (meta: OwnerMeta | MacMeta) => B,
    options: PlacementSigningOptions = {}
  ): Promise<B & { meta: B['meta'] & { signature: string } }> {
    const key = this.options.key()
    if (!key) {throw new PlacementConnectionAuthError('device_not_enrolled')}

    const issuedAt = (this.options.now?.() ?? Date.now()) - BACKDATE_MS
    const expiresAt = issuedAt + TTL_MS
    if (issuedAt < 0 || expiresAt <= issuedAt || expiresAt > issuedAt + MAX_LIFETIME_MS) {
      throw new PlacementConnectionAuthError('invalid_frame')
    }

    const common = {
      requestId: options.requestId ?? this.options.uuid?.() ?? randomUUID(),
      commandId: this.options.uuid?.() ?? randomUUID(),
      signerKeyId: key.identityKid,
      sequence: this.nextSequence(key.deviceServiceId, signer),
      issuedAt,
      expiresAt,
      nonce: createHash('sha256')
        .update(this.options.random?.(32) ?? randomBytes(32))
        .digest('base64url')
    }
    const complete =
      signer === 'owner_client'
        ? OwnerClientSignedMetaV25Schema.parse({
            ...common,
            signer,
            surface: 'desktop',
            authenticatedChannel: 'desktop',
            signature: UNSIGNED
          })
        : MacExecutorSignedMetaV25Schema.parse({
            ...common,
            signer,
            deviceServiceId: key.deviceServiceId,
            signature: UNSIGNED
          })
    const { signature: _signature, ...meta } = complete
    const body = build(meta)
    const unsigned = { ...body, meta: { ...body.meta, signature: UNSIGNED } } as B & {
      meta: B['meta'] & { signature: string }
    }

    let signed: { kid: string; sig: string }
    try {
      signed = await key.signIdentity(placementConnectionSignedBytes(message, unsigned))
    } catch {
      throw new PlacementConnectionAuthError('signing_failed')
    }

    const current = this.options.key()
    if (
      signed.kid !== key.identityKid ||
      !current ||
      current.identityKid !== key.identityKid ||
      current.deviceServiceId !== key.deviceServiceId ||
      current.enrollmentEpoch !== key.enrollmentEpoch
    ) {
      throw new PlacementConnectionAuthError('key_mismatch')
    }

    return { ...body, meta: { ...body.meta, signature: signed.sig } }
  }

  signOwner<B extends { meta: Record<string, unknown> }>(
    message: Extract<Message, `owner.${string}`>,
    build: (meta: OwnerMeta) => B,
    options?: PlacementSigningOptions
  ) {
    return this.signed(message, 'owner_client', meta => build(meta as OwnerMeta), options)
  }

  signMac<B extends { meta: Record<string, unknown> }>(
    message: Extract<Message, `home.${string}`>,
    build: (meta: MacMeta) => B,
    options?: PlacementSigningOptions
  ) {
    return this.signed(message, 'mac_executor', meta => build(meta as MacMeta), options)
  }
}
