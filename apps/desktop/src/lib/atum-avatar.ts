/**
 * Profile photo limits, the same the hosted avatar bucket enforces
 * (`atum.desktop-identity/1`): JPEG, PNG, or WebP up to 2 MiB. Checked in the
 * renderer before any reservation is spent, and again by the plane.
 */
export const ATUM_AVATAR_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export const ATUM_AVATAR_MAX_BYTES = 2_097_152
export const ATUM_AVATAR_ACCEPT = ATUM_AVATAR_CONTENT_TYPES.join(',')

/**
 * The visible initial is a grapheme, rather than a UTF-16 code unit. This
 * keeps names beginning with an emoji, a combined Vietnamese character, or a
 * non-Latin script intact in every profile projection.
 */
export function atumAvatarInitial(name: string): string {
  // A handle shown as a name ("@minh") draws its first letter, never the "@" (Atum Kit).
  const value = name.trim().replace(/^[@#]+/u, '') || name.trim()

  if (!value) {
    return ''
  }

  const Segmenter = Intl.Segmenter

  const first = Segmenter
    ? (new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)[Symbol.iterator]().next().value?.segment ??
      '')
    : (Array.from(value)[0] ?? '')

  return first.toLocaleUpperCase()
}

/** The signed object upload step shared by human and assistant photo flows. */
export async function putAtumAvatarUpload(
  file: Blob & { type: string },
  reservation: { uploadHeaders: Record<string, string>; uploadUrl: string },
  onProgress: (progress: number) => void
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', reservation.uploadUrl)

    for (const [name, value] of Object.entries({ 'content-type': file.type, ...reservation.uploadHeaders })) {
      xhr.setRequestHeader(name, value)
    }

    xhr.upload.onprogress = event => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100))
      }
    }

    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('avatar_upload_failed')))
    xhr.onerror = () => reject(new Error('avatar_upload_failed'))
    xhr.send(file)
  })
}
