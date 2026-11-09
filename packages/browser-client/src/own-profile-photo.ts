import {
  MATRIX_PROFILE_PHOTO_MAX_BYTES,
  MATRIX_PROFILE_PHOTO_TYPES,
  matrixProfilePhoto,
  type MatrixProfilePhotoChange,
  type MatrixProfilePhotoType
} from '../../../apps/desktop/shared/matrix-profile'

const MAX_EDGE = 1024
const MIN_EDGE = 128

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
}

function encoded(canvas: HTMLCanvasElement, type: MatrixProfilePhotoType, signal?: AbortSignal): Promise<Blob> {
  abortIfNeeded(signal)
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => {
        try {
          abortIfNeeded(signal)
          if (!blob) throw new Error('matrix_profile_photo_type')
          resolve(blob)
        } catch (error) {
          reject(error)
        }
      },
      type,
      type === 'image/png' ? undefined : 0.9
    )
  })
}

/**
 * Center-crop and re-encode in the browser. Re-encoding intentionally drops EXIF
 * and other source metadata before bytes reach matrix-js-sdk.
 */
export async function prepareBrowserOwnProfilePhoto(
  file: File,
  signal?: AbortSignal
): Promise<Extract<MatrixProfilePhotoChange, { kind: 'replace' }>> {
  abortIfNeeded(signal)
  if (
    file.size < 1 ||
    file.size > MATRIX_PROFILE_PHOTO_MAX_BYTES ||
    !MATRIX_PROFILE_PHOTO_TYPES.includes(file.type as MatrixProfilePhotoType)
  ) {
    throw new Error(
      file.size > MATRIX_PROFILE_PHOTO_MAX_BYTES ? 'matrix_profile_photo_size' : 'matrix_profile_photo_type'
    )
  }

  // Check declared type against the real source bytes before asking the image decoder.
  matrixProfilePhoto({ type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) })
  abortIfNeeded(signal)

  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    abortIfNeeded(signal)
    const sourceEdge = Math.min(bitmap.width, bitmap.height)
    if (!Number.isFinite(sourceEdge) || sourceEdge < 1) throw new Error('matrix_profile_photo_type')
    const sourceX = Math.floor((bitmap.width - sourceEdge) / 2)
    const sourceY = Math.floor((bitmap.height - sourceEdge) / 2)
    let targetEdge = Math.min(MAX_EDGE, sourceEdge)

    while (targetEdge >= MIN_EDGE) {
      const canvas = document.createElement('canvas')
      canvas.width = targetEdge
      canvas.height = targetEdge
      const context = canvas.getContext('2d', { alpha: file.type !== 'image/jpeg' })
      if (!context) throw new Error('matrix_profile_photo_type')
      context.drawImage(bitmap, sourceX, sourceY, sourceEdge, sourceEdge, 0, 0, targetEdge, targetEdge)
      const blob = await encoded(canvas, file.type as MatrixProfilePhotoType, signal)
      if (blob.size <= MATRIX_PROFILE_PHOTO_MAX_BYTES) {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        abortIfNeeded(signal)
        return matrixProfilePhoto({ type: file.type, bytes })
      }
      targetEdge = Math.floor(targetEdge / 2)
    }
    throw new Error('matrix_profile_photo_size')
  } finally {
    bitmap.close()
  }
}
