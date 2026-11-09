import { BOT_API_MATRIX_METADATA } from '../../../../../packages/bot-api-v1'
import type { AppDescriptor } from '../../../shared/app-catalog'
import { authorizedBotApi, type BotApiRoomContext, isBotApiRoomForApp } from '../../../shared/bot-api-room'
import type { MatrixBotApiMessage, MatrixMessage } from '../../../shared/matrix'

export { authorizedBotApi }

/** The official bot identity shape; a person or any other member is never one. */
const OFFICIAL_BOT_USER = /^@app-[a-z][a-z0-9_-]{0,63}:[\w.-]+(?::\d+)?$/u
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu
const FILE_REF = /^mref_[A-Za-z0-9_-]{16,192}$/u
const MAX_TEXT = 4_096
const MAX_CAPTION = 1_024
const MAX_FORMATTED = 16_384
const MAX_BUTTON_LABEL = 64
const MAX_BUTTON_URL = 4_096

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function photo(value: unknown): MatrixBotApiMessage['photo'] {
  if (value === undefined) {
    return undefined
  }

  const candidate = record(value)

  if (
    !candidate ||
    !hasOnlyKeys(candidate, ['file_ref', 'width', 'height', 'mime_type', 'caption']) ||
    typeof candidate.file_ref !== 'string' ||
    !FILE_REF.test(candidate.file_ref) ||
    !Number.isSafeInteger(candidate.width) ||
    !Number.isSafeInteger(candidate.height) ||
    (candidate.width as number) < 1 ||
    (candidate.width as number) > 65_535 ||
    (candidate.height as number) < 1 ||
    (candidate.height as number) > 65_535 ||
    (candidate.mime_type !== 'image/jpeg' &&
      candidate.mime_type !== 'image/png' &&
      candidate.mime_type !== 'image/webp') ||
    (candidate.caption !== undefined &&
      (typeof candidate.caption !== 'string' || candidate.caption.length > MAX_CAPTION))
  ) {
    return undefined
  }

  return {
    fileRef: candidate.file_ref,
    width: candidate.width as number,
    height: candidate.height as number,
    mimeType: candidate.mime_type,
    ...(candidate.caption ? { caption: candidate.caption } : {})
  }
}

/** URL buttons are HTTPS-only and never carry embedded credentials. */
export function safeBotApiButtonUrl(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_BUTTON_URL ||
    value.trim() !== value
  ) {
    return undefined
  }

  try {
    const url = new URL(value)

    return url.protocol === 'https:' && !url.username && !url.password ? value : undefined
  } catch {
    return undefined
  }
}

function keyboard(value: unknown): MatrixBotApiMessage['keyboard'] | null {
  if (value === undefined) {
    return undefined
  }

  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    return null
  }

  const rows: NonNullable<MatrixBotApiMessage['keyboard']> = []

  for (const candidateRow of value) {
    if (!Array.isArray(candidateRow) || candidateRow.length < 1 || candidateRow.length > 4) {
      return null
    }

    const row: NonNullable<MatrixBotApiMessage['keyboard']>[number] = []

    for (const candidateButton of candidateRow) {
      const button = record(candidateButton)
      const url = safeBotApiButtonUrl(button?.url)

      if (
        !button ||
        !hasOnlyKeys(button, ['label', 'kind', 'url']) ||
        typeof button.label !== 'string' ||
        button.label.length < 1 ||
        button.label.length > MAX_BUTTON_LABEL ||
        button.kind !== 'url' ||
        !url
      ) {
        return null
      }

      row.push({ label: button.label, kind: 'url', url })
    }

    rows.push(row)
  }

  return rows
}

export function isOfficialAppBotUser(userId: string | undefined): boolean {
  return Boolean(userId && OFFICIAL_BOT_USER.test(userId))
}

/**
 * Strictly decode one `io.atum.bot_api/1` payload into what the window may draw. Anything
 * unknown or out of bounds makes the whole message metadata unusable: the ordinary Matrix
 * message still shows, but no bot-api photo, URL keyboard or formatting is offered. V1.1 admits
 * only bounded HTTPS URL buttons; callback and every other native button kind remain unsupported.
 */
export function parseBotApiMessage(input: {
  sender: string | undefined
  own: boolean
  content: unknown
  formattedBody?: unknown
}): MatrixBotApiMessage | undefined {
  if (input.own || !isOfficialAppBotUser(input.sender)) {
    return undefined
  }

  const content = record(input.content)

  if (!content) {
    return undefined
  }

  const metadata = record(content['io.atum.bot_api'])

  if (
    !metadata ||
    !hasOnlyKeys(metadata, ['version', 'bot_id', 'public_message_id', 'keyboard', 'photo', 'fallback_text']) ||
    metadata.version !== BOT_API_MATRIX_METADATA ||
    typeof metadata.bot_id !== 'string' ||
    !UUID.test(metadata.bot_id) ||
    !Number.isSafeInteger(metadata.public_message_id) ||
    (metadata.public_message_id as number) < 1
  ) {
    return undefined
  }

  const parsedPhoto = photo(metadata.photo)
  const parsedKeyboard = keyboard(metadata.keyboard)

  if ((metadata.photo !== undefined && !parsedPhoto) || parsedKeyboard === null) {
    return undefined
  }

  if (
    metadata.fallback_text !== undefined &&
    (typeof metadata.fallback_text !== 'string' ||
      metadata.fallback_text.length < 1 ||
      metadata.fallback_text.length > MAX_TEXT)
  ) {
    return undefined
  }

  const formatted =
    input.formattedBody === undefined
      ? undefined
      : typeof input.formattedBody === 'string' &&
          input.formattedBody.length > 0 &&
          input.formattedBody.length <= MAX_FORMATTED
        ? input.formattedBody
        : null

  if (formatted === null) {
    return undefined
  }

  return {
    version: BOT_API_MATRIX_METADATA,
    botId: metadata.bot_id,
    publicMessageId: metadata.public_message_id as number,
    ...(parsedKeyboard ? { keyboard: parsedKeyboard } : {}),
    ...(parsedPhoto ? { photo: parsedPhoto } : {}),
    ...(typeof metadata.fallback_text === 'string' ? { fallbackText: metadata.fallback_text } : {}),
    ...(formatted ? { formattedBody: formatted } : {})
  }
}

/** The catalog app whose official bot sent this message, if any. */
export function botApiAppForMessage(
  apps: readonly AppDescriptor[] | undefined,
  message: Pick<MatrixMessage, 'sender'>
): AppDescriptor | undefined {
  return apps?.find(app => app.bot?.user_id === message.sender)
}

/** A bot-api room has authenticated reply metadata, or is the exact direct room whose signed
 * catalog bot declares Bot API. Legacy rooms keep the old setup, outcome and send paths; an
 * official-shaped stranger's metadata cannot switch the room's mode either. */
export function isBotApiRoom(
  messages: readonly MatrixMessage[],
  apps: readonly AppDescriptor[] | undefined,
  roomEncrypted: boolean,
  context?: BotApiRoomContext
): boolean {
  return Boolean(apps?.some(app => isBotApiRoomForApp(messages, app, roomEncrypted, context)))
}
