/**
 * Single local mirror of the atum.bot-api/1.1 types used by the app host and
 * desktop while this checkout remains pinned to `@atum/protocol` 0.7.36.
 *
 * The normative mirror is `@atum/protocol/bot-api` 0.7.44. Delete this file
 * and point both consumers at that package when the repository-wide protocol
 * update lands; do not create another local copy in either consumer.
 */
export const BOT_API_PROTOCOL = 'atum.bot-api/1.1' as const
export const BOT_API_MATRIX_METADATA = 'io.atum.bot_api/1' as const

export type BotApiPhotoMimeType = 'image/jpeg' | 'image/png' | 'image/webp'

export interface BotApiIngressPhotoDraft {
  object_ref: string
  mime: BotApiPhotoMimeType
  width: number
  height: number
  size: number
  sha256: string
}

export interface BotApiIngressPhotoUploadRequest {
  mime: BotApiPhotoMimeType
  size: number
  sha256: string
}

export interface BotApiIngressPhotoUploadResponse {
  upload_url: string
  object_ref: string
  expires_at: string
}

export interface BotApiIngressDraft {
  sender_principal_ref: string
  display_name: string
  timestamp: number
  kind: 'text' | 'photo' | 'start'
  text?: string
  caption?: string
  reply_source_event_ref?: string
}

export interface BotApiIngressAdmitRequest {
  room_ref: string
  event_ref: string
  source_kind: 'message' | 'start'
  admitted_room_ref: string
  draft: BotApiIngressDraft
  photo?: BotApiIngressPhotoDraft[]
}

export interface BotApiIngressAdmitResponse {
  duplicate: boolean
  update_id: number
}

export interface BotApiWebhookLease {
  delivery_id: string
  app_id: string
  bot_id: string
  chat_id: number
  update_id: number
  config_epoch: number
  lease_owner: string
  lease_fence: number
  lease_expires_at: string
  attempt: number
  endpoint: string
  /** Additive 0350 claim authority. Absent during a rolling platform deployment means no exception. */
  allowed_hosts?: string[]
  /** Plain UTF-8 from the service-role-only private table; H1 sends it unchanged. */
  secret_token: string
  exact_body: string
  exact_body_sha256: string
}

export type BotApiWebhookOutcome =
  | 'accepted'
  | 'retry'
  | 'paused'
  | 'dead_letter'
  | 'terminal_not_received'
  | 'quarantined'

export interface BotApiWebhookCompleteRequest {
  delivery_id: string
  lease_owner: string
  lease_fence: number
  config_epoch: number
  outcome: BotApiWebhookOutcome
  retry_at?: string
  reason?: string
  http_status?: number
}

export interface BotApiWebhookCompleteResponse {
  state: BotApiWebhookOutcome
  update_id: number
}

export interface BotApiReservedMessage {
  message_id: number
  [key: string]: unknown
}

export interface BotApiOutboundLease {
  outbound_id: string
  app_id: string
  bot_id: string
  chat_id: number
  admitted_room_ref: string
  method: 'sendMessage' | 'sendPhoto' | 'sendChatAction'
  request: Record<string, unknown>
  message?: BotApiReservedMessage
  matrix_transaction_id: string
  device_generation: number
  lease_owner: string
  lease_fence: number
  lease_expires_at: string
}

export interface BotApiOutboundPublishRequest {
  bot_id: string
  outbound_id: string
  lease_owner: string
  lease_fence: number
  outcome: 'confirmed' | 'unknown' | 'failed' | 'access_revoked'
  matrix_event_ref?: string
}

export interface BotApiOutboundPublishResponse {
  state: 'confirmed' | 'unknown' | 'failed' | 'access_revoked'
  message_id?: number
}

export interface BotApiMatrixPhotoMetadata {
  file_ref: string
  width: number
  height: number
  mime_type: BotApiPhotoMimeType
  caption?: string
}

/** Exact v1.1 Matrix presentation metadata. URL buttons live only in formatted_body. */
export interface BotApiMatrixMetadata {
  version: typeof BOT_API_MATRIX_METADATA
  bot_id: string
  public_message_id: number
  photo?: BotApiMatrixPhotoMetadata
  fallback_text?: string
}

/** One H1-ready photo staged by Shell on the outbound lease as `request.photo`. */
export interface BotApiOutboundPhoto {
  /** Short-lived signed URL on the configured platform storage origin. */
  url: string
  mime_type: BotApiPhotoMimeType
  width: number
  height: number
  file_ref: string
  sha256: string
  size: number
}

export interface BotApiPlatformAdapter {
  requestIngressPhotoUpload(
    botSlug: string,
    input: BotApiIngressPhotoUploadRequest,
    signal?: AbortSignal
  ): Promise<BotApiIngressPhotoUploadResponse>
  /** PUTs exact bytes to the configured HTTPS storage origin without host credentials. */
  uploadIngressPhoto(
    uploadUrl: string,
    bytes: Uint8Array,
    mime: BotApiPhotoMimeType,
    signal?: AbortSignal
  ): Promise<void>
  admit(botSlug: string, input: BotApiIngressAdmitRequest, signal?: AbortSignal): Promise<BotApiIngressAdmitResponse>
  claimWebhook(
    botSlug: string,
    leaseOwner: string,
    limit: number,
    signal?: AbortSignal
  ): Promise<BotApiWebhookLease[]>
  completeWebhook(botSlug: string, result: BotApiWebhookCompleteRequest, signal?: AbortSignal): Promise<BotApiWebhookCompleteResponse>
  claimOutbound(
    botSlug: string,
    owner: string,
    limit: number,
    signal?: AbortSignal
  ): Promise<BotApiOutboundLease[]>
  /** Fetches only from the configured HTTPS storage origin and verifies size + SHA-256. */
  fetchOutboundPhoto(photo: BotApiOutboundPhoto, signal?: AbortSignal): Promise<Uint8Array>
  completeOutbound(botSlug: string, input: BotApiOutboundPublishRequest, signal?: AbortSignal): Promise<BotApiOutboundPublishResponse>
}
