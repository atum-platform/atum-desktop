import { Buffer } from 'node:buffer'

import { MATRIX_MAX_FILE_BYTES, type MatrixBotApiPhoto } from '../../shared/matrix'

/**
 * Convert the SDK host's closed media result into the only image capability the
 * renderer receives. MXC locations, encryption descriptors and credentials do
 * not cross this boundary.
 */
export function appBotPhotoForRenderer(value: unknown): MatrixBotApiPhoto | null {
  const media = value !== null && typeof value === 'object'
    ? value as { bytes?: unknown; mimeType?: unknown; width?: unknown; height?: unknown }
    : null

  const bytes = media?.bytes
  const mime = media?.mimeType

  if (
    !media ||
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 12 ||
    bytes.byteLength > MATRIX_MAX_FILE_BYTES ||
    (mime !== 'image/jpeg' && mime !== 'image/png' && mime !== 'image/webp') ||
    !Number.isSafeInteger(media.width) ||
    !Number.isSafeInteger(media.height) ||
    (media.width as number) < 1 ||
    (media.height as number) < 1 ||
    (media.width as number) > 65_535 ||
    (media.height as number) > 65_535
  ) {
    return null
  }

  return {
    url: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`,
    width: media.width as number,
    height: media.height as number,
    mimeType: mime
  }
}
