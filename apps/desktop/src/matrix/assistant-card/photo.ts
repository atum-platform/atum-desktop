import { MATRIX_PROFILE_PHOTO_MAX_BYTES } from '../../../shared/matrix-profile'

/** The longest side of a picture as it is uploaded: plenty for an 88 px face at 3×. */
export const ASSISTANT_PHOTO_EDGE = 512

/** The scale that fits an image inside the edge without enlarging it. */
export function photoFit(
  width: number,
  height: number,
  edge = ASSISTANT_PHOTO_EDGE
): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height, 1))

  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** A picture ready for the canonical agent-avatar upload. */
export interface PreparedPhoto {
  type: 'image/webp' | 'image/jpeg'
  bytes: Uint8Array
}

export interface PhotoFraming {
  /** Centre in source-image fractions, with zoom relative to the smallest side. */
  x: number
  y: number
  zoom: number
}

export interface PhotoCrop {
  x: number
  y: number
  size: number
}

/** A square wholly inside the source, including when a drag reaches an edge. */
export function photoCrop(width: number, height: number, framing: PhotoFraming): PhotoCrop {
  const size = Math.min(width, height) / Math.max(1, Math.min(4, framing.zoom))

  return {
    x: Math.max(0, Math.min(width - size, framing.x * width - size / 2)),
    y: Math.max(0, Math.min(height - size, framing.y * height - size / 2)),
    size
  }
}

/** Move the image by fractions of the visible square, without accumulating edge overshoot. */
export function movePhotoFraming(
  width: number,
  height: number,
  framing: PhotoFraming,
  dx: number,
  dy: number
): PhotoFraming {
  const crop = photoCrop(width, height, framing)
  const next = photoCrop(width, height, {
    ...framing,
    x: (crop.x + crop.size / 2 - dx * crop.size) / width,
    y: (crop.y + crop.size / 2 - dy * crop.size) / height
  })

  return { zoom: framing.zoom, x: (next.x + next.size / 2) / width, y: (next.y + next.size / 2) / height }
}

/** Re-encode only the chosen pixels: the original file and its metadata never get uploaded. */
export async function prepareBitmapPhoto(bitmap: ImageBitmap, crop: PhotoCrop): Promise<PreparedPhoto> {
  const size = photoFit(crop.size, crop.size)
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')

  if (!context) {
    throw new Error('photo_unreadable')
  }

  context.drawImage(bitmap, crop.x, crop.y, crop.size, crop.size, 0, 0, size.width, size.height)

  for (const [type, quality] of [
    ['image/webp', 0.9],
    ['image/jpeg', 0.88],
    ['image/jpeg', 0.7]
  ] as const) {
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality))

    if (blob && blob.type === type && blob.size <= MATRIX_PROFILE_PHOTO_MAX_BYTES) {
      return { type, bytes: new Uint8Array(await blob.arrayBuffer()) }
    }
  }

  throw new Error('photo_unreadable')
}

/**
 * A preview URL for a prepared photo. The Matrix window's CSP allows `data:` images but not
 * `blob:` (main.ts img-src), so an object URL renders as a broken image there.
 */
export function photoPreviewUrl(photo: Pick<PreparedPhoto, 'bytes' | 'type'>): string {
  const bytes = Uint8Array.from(photo.bytes)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }

  return `data:${photo.type};base64,${btoa(binary)}`
}
