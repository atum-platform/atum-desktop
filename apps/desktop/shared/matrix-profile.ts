/** Supported photo bytes shared by human Matrix profiles and canonical agent avatars. */
export const MATRIX_PROFILE_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export const MATRIX_PROFILE_PHOTO_MAX_BYTES = 2 * 1024 * 1024
export type MatrixProfilePhotoType = (typeof MATRIX_PROFILE_PHOTO_TYPES)[number]

export interface MatrixProfileMetadata {
  userId: string
  displayName: string
  avatarMxc: string | null
}

/** Safe authenticated image projection, not a new identity/media store. */
export interface MatrixProfile extends MatrixProfileMetadata {
  avatarUrl: string | null
  photoUnavailable?: boolean
}

export type MatrixProfileTarget = { kind: 'human' } | { kind: 'agent'; principal: string }
export type MatrixProfilePhotoChange =
  | { kind: 'replace'; type: MatrixProfilePhotoType; bytes: Uint8Array }
  | { kind: 'remove' }
/** The person's own display name (an agent's name belongs to the platform, not here). */
export type MatrixProfileNameChange = { kind: 'name'; displayName: string }
export type MatrixProfileChange = MatrixProfilePhotoChange | MatrixProfileNameChange

/** Long enough for a full name, short enough for a roster row and a notification. */
export const MATRIX_PROFILE_NAME_MAX = 64

export interface MatrixProfileReadResult {
  profile: MatrixProfileMetadata
  photo?: { type: MatrixProfilePhotoType; bytes: Uint8Array }
  photoUnavailable?: boolean
}

/** Trusted native → SDK only. Upload stages media; commit alone changes the profile. */
export type MatrixProfileSdkCommand =
  | { kind: 'profileRead' }
  | { kind: 'profileOpen'; scope: string }
  | { kind: 'profileUpload'; scope: string; type: MatrixProfilePhotoType; bytes: Uint8Array }
  | { kind: 'profileCommit'; scope: string; remove?: true }
  | { kind: 'profileName'; scope: string; displayName: string }
  /** An assistant's public name brought to its platform record (assistant-name-sync.ts):
   * no editor scope, never from the window. */
  | { kind: 'profileSyncName'; displayName: string }
  | { kind: 'profileDiscard'; scope: string }

/** One member of the open chat, projected for its rows: no profile editor, no target. */
export interface MatrixMemberAvatar {
  userId: string
  /** `data:image/...` bytes the window may paint under its CSP, or null when it has no photo. */
  avatarUrl: string | null
}

export interface MatrixProfilesBridge {
  read(target: MatrixProfileTarget): Promise<MatrixProfile>
  /** One transient editor scope. A new editor retires the old one, even A → B → A. */
  open(target: MatrixProfileTarget): Promise<{ scope: string }>
  change(scope: string, change: MatrixProfileChange): Promise<MatrixProfile>
  close(scope: string): Promise<void>
  /** A member of the chat on screen, by Matrix user ID. Native checks the membership. */
  member(userId: string): Promise<MatrixMemberAvatar>
}

export function matrixProfileMxc(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 2048 && /^mxc:\/\/[^/\s?#]+\/[^/\s?#]+$/.test(value)
    ? value
    : null
}

/** Check actual file bytes as well as MIME, before upload and at the native boundary. */
export function matrixProfilePhotoType(bytes: Uint8Array): MatrixProfilePhotoType | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }

  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) {
    return 'image/png'
  }

  if (
    bytes.length >= 12 &&
    [0x52, 0x49, 0x46, 0x46].every((value, index) => bytes[index] === value) &&
    [0x57, 0x45, 0x42, 0x50].every((value, index) => bytes[index + 8] === value)
  ) {
    return 'image/webp'
  }

  return undefined
}

export function matrixProfilePhoto(value: unknown): Extract<MatrixProfilePhotoChange, { kind: 'replace' }> {
  const row = value as { type?: unknown; bytes?: unknown } | null

  if (!(row?.bytes instanceof Uint8Array) || row.bytes.byteLength < 1) {
    throw new Error('matrix_profile_photo_type')
  }

  if (row.bytes.byteLength > MATRIX_PROFILE_PHOTO_MAX_BYTES) {
    throw new Error('matrix_profile_photo_size')
  }

  const type = matrixProfilePhotoType(row.bytes)

  if (!type || type !== row.type) {
    throw new Error('matrix_profile_photo_type')
  }

  return { kind: 'replace', type, bytes: new Uint8Array(row.bytes) }
}

/** A display name as people will see it: trimmed, one line, not empty, not too long. Checked
 * in the window, at the native boundary and in the SDK host alike. */
export function matrixProfileDisplayName(value: unknown): string {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''

  if (!name || [...name].length > MATRIX_PROFILE_NAME_MAX || /\p{Cc}/u.test(name)) {
    throw new Error('matrix_profile_name_invalid')
  }

  return name
}

export function matrixProfileTarget(value: unknown): MatrixProfileTarget {
  const row = value as { kind?: unknown; principal?: unknown } | null

  if (row?.kind === 'human') {
    return { kind: 'human' }
  }

  if (
    row?.kind === 'agent' &&
    typeof row.principal === 'string' &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(row.principal)
  ) {
    return { kind: 'agent', principal: row.principal }
  }

  throw new Error('matrix_profile_target_invalid')
}
