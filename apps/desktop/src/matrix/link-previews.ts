import { atom } from 'nanostores'

import type { MatrixMessage } from '../../shared/matrix'
import { matrixFirstPreviewLink, type MatrixLinkPreview, type MatrixLinkPreviewBridge } from '../../shared/matrix-link-preview'

/**
 * Link preview cards the window has asked about, by link and day (`matrixLinkPreviewKey`): a
 * card scrolled away and back, or the same link in two messages, is asked for once a day. `null`
 * is "no card" (none, refused, or the read failed) and is remembered too, so a page without a
 * preview is not asked about again while it scrolls.
 */
export const $matrixLinkPreviews = atom<Record<string, MatrixLinkPreview | null>>({})

/** Messages whose card this viewer closed (×): local to this Mac, never sent anywhere. */
export const $matrixHiddenLinkPreviews = atom<readonly string[]>(readHidden())

const HIDDEN_KEY = 'io.atum.linkPreviews.hidden'
const HIDDEN_MAX = 500
const pending = new Set<string>()

function readHidden(): readonly string[] {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(HIDDEN_KEY) ?? '[]')

    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(-HIDDEN_MAX) : []
  } catch {
    return []
  }
}

export function hideMatrixLinkPreview(eventId: string) {
  const next = [...$matrixHiddenLinkPreviews.get().filter(id => id !== eventId), eventId].slice(-HIDDEN_MAX)

  $matrixHiddenLinkPreviews.set(next)

  try {
    globalThis.localStorage?.setItem(HIDDEN_KEY, JSON.stringify(next))
  } catch {
    // Storage off: hidden until the window reloads.
  }
}

/**
 * The link a message may show a card for, or null: a sent text message in a room without
 * end-to-end encryption. Files, deleted or unreadable messages, and anything still sending have none.
 */
export function matrixMessagePreviewLink(message: MatrixMessage, roomEncrypted: boolean): string | null {
  if (
    roomEncrypted ||
    message.encrypted ||
    message.attachment ||
    message.redacted ||
    message.decryptionFailed ||
    message.pending ||
    message.failed ||
    !message.id.startsWith('$')
  ) {
    return null
  }

  return matrixFirstPreviewLink(message.body)
}

function bridge(): MatrixLinkPreviewBridge | undefined {
  // The web client shares this module without the native bridge: read it structurally so both build.
  return typeof window === 'undefined'
    ? undefined
    : (window as unknown as { atumMatrix?: { linkPreviews?: MatrixLinkPreviewBridge } }).atumMatrix?.linkPreviews
}

/** Ask native for one message's card once per key; the answer lands in `$matrixLinkPreviews`. */
export function loadMatrixLinkPreview(roomId: string, eventId: string, key: string) {
  const read = bridge()?.read

  if (!read || key in $matrixLinkPreviews.get() || pending.has(key)) {
    return
  }

  pending.add(key)

  const settle = (preview: MatrixLinkPreview | null) => {
    pending.delete(key)
    $matrixLinkPreviews.set({ ...$matrixLinkPreviews.get(), [key]: preview })
  }

  read(roomId, eventId).then(
    preview => settle(preview ?? null),
    () => settle(null)
  )
}
