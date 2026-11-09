import type { MatrixClient } from 'matrix-js-sdk/lib/client'
import { Method } from 'matrix-js-sdk/lib/http-api/method'
import { UserEvent, type User } from 'matrix-js-sdk/lib/models/user'

import {
  MATRIX_PROFILE_PHOTO_MAX_BYTES,
  matrixProfileDisplayName,
  matrixProfileMxc,
  matrixProfilePhoto,
  matrixProfilePhotoType,
  type MatrixProfilePhotoChange
} from '../../../apps/desktop/shared/matrix-profile'

export interface BrowserOwnProfile {
  displayName: string
  hasAvatar: boolean
  photo: Blob | null
  photoUnavailable: boolean
  revision: number
}

export interface BrowserOwnProfileEditor {
  read(): Promise<BrowserOwnProfile>
  rename(displayName: string): Promise<BrowserOwnProfile>
  replace(photo: Extract<MatrixProfilePhotoChange, { kind: 'replace' }>): Promise<BrowserOwnProfile>
  remove(): Promise<BrowserOwnProfile>
  close(): void
}

interface ProfileMetadata {
  displayName: string
  avatarMxc: string | null
}

/**
 * The current Matrix client's own human profile. The adapter has no caller-selected
 * user, token, homeserver or media URL, and an editor can never outlive its SDK.
 */
export function createBrowserOwnProfile(client: MatrixClient, alive: () => boolean, available: () => boolean) {
  let known: ProfileMetadata | undefined
  let revision = 0
  let editor:
    | {
        scope: symbol
        changed: () => void
        upload?: AbortController
      }
    | undefined

  const ownUserId = () => client.getSafeUserId()

  function requireAlive(scope?: symbol) {
    if (!alive() || (scope && editor?.scope !== scope)) throw new Error('matrix_profile_stale')
  }

  function requireAvailable(scope?: symbol) {
    requireAlive(scope)
    if (!available()) throw new Error('matrix_profile_offline')
  }

  function retire(scope?: symbol) {
    if (!scope || editor?.scope === scope) {
      editor?.upload?.abort()
      editor = undefined
    }
  }

  function result(photo: Blob | null = null, photoUnavailable = false): BrowserOwnProfile {
    const profile = known ?? { displayName: '', avatarMxc: null }
    return {
      displayName: profile.displayName,
      hasAvatar: Boolean(profile.avatarMxc),
      photo,
      photoUnavailable,
      revision
    }
  }

  async function read(scope: symbol): Promise<BrowserOwnProfile> {
    requireAvailable(scope)
    const startingRevision = revision
    const raw = await client.getProfileInfo(ownUserId())
    requireAvailable(scope)
    if (revision !== startingRevision) throw new Error('matrix_profile_stale')

    known = {
      displayName: raw.displayname?.replace(/\s+/g, ' ').trim() ?? '',
      avatarMxc: matrixProfileMxc(raw.avatar_url)
    }

    if (!known.avatarMxc) return result()
    const [, server, media] = /^mxc:\/\/([^/]+)\/([^/]+)$/.exec(known.avatarMxc)!

    try {
      const blob = await client.http.authedRequest<Blob>(
        Method.Get,
        `/media/download/${encodeURIComponent(server!)}/${encodeURIComponent(media!)}`,
        undefined,
        undefined,
        { prefix: '/_matrix/client/v1', rawResponseBody: true, localTimeoutMs: 30_000 }
      )
      requireAvailable(scope)
      if (revision !== startingRevision) throw new Error('matrix_profile_stale')
      if (blob.size < 1 || blob.size > MATRIX_PROFILE_PHOTO_MAX_BYTES) throw new Error('matrix_profile_photo_size')
      const bytes = new Uint8Array(await blob.arrayBuffer())
      requireAvailable(scope)
      if (revision !== startingRevision) throw new Error('matrix_profile_stale')
      const type = matrixProfilePhotoType(bytes)
      if (!type) throw new Error('matrix_profile_photo_type')
      return result(new Blob([bytes.buffer as ArrayBuffer], { type }))
    } catch (error) {
      requireAvailable(scope)
      if (revision !== startingRevision || (error instanceof Error && error.message === 'matrix_profile_stale')) {
        throw new Error('matrix_profile_stale')
      }
      // An unavailable old photo must not block its replacement or removal.
      return result(null, true)
    }
  }

  async function rename(scope: symbol, value: string): Promise<BrowserOwnProfile> {
    requireAvailable(scope)
    const displayName = matrixProfileDisplayName(value)
    await client.setDisplayName(displayName)
    requireAvailable(scope)
    known = { ...(known ?? { avatarMxc: null }), displayName }
    revision++
    return result()
  }

  async function replace(
    scope: symbol,
    value: Extract<MatrixProfilePhotoChange, { kind: 'replace' }>
  ): Promise<BrowserOwnProfile> {
    requireAvailable(scope)
    const photo = matrixProfilePhoto(value)
    const upload = new AbortController()
    editor!.upload?.abort()
    editor!.upload = upload
    try {
      const uploaded = await client.uploadContent(
        new Blob([photo.bytes.slice().buffer as ArrayBuffer], { type: photo.type }),
        {
          type: photo.type,
          includeFilename: false,
          abortController: upload
        }
      )
      requireAvailable(scope)
      const avatarMxc = matrixProfileMxc(uploaded.content_uri)
      if (!avatarMxc) throw new Error('matrix_profile_upload_failed')
      await client.setAvatarUrl(avatarMxc)
      requireAvailable(scope)
      known = { ...(known ?? { displayName: '' }), avatarMxc }
      revision++
      return result(new Blob([photo.bytes.slice().buffer as ArrayBuffer], { type: photo.type }))
    } finally {
      if (editor?.scope === scope && editor.upload === upload) editor.upload = undefined
    }
  }

  async function remove(scope: symbol): Promise<BrowserOwnProfile> {
    requireAvailable(scope)
    // matrix-js-sdk sends the empty standard avatar_url value, which clears the
    // profile photo on the homeserver and emits its normal own-user update.
    await client.setAvatarUrl('')
    requireAvailable(scope)
    known = { ...(known ?? { displayName: '' }), avatarMxc: null }
    revision++
    return result()
  }

  const synced = (_event: unknown, user: User) => {
    if (!alive() || user.userId !== ownUserId()) return
    known = undefined
    revision++
    editor?.changed()
  }

  client.on(UserEvent.AvatarUrl, synced)
  client.on(UserEvent.DisplayName, synced)

  return {
    open(changed: () => void = () => {}): BrowserOwnProfileEditor {
      requireAlive()
      retire()
      const scope = Symbol('browser-own-profile')
      editor = { scope, changed }
      return {
        read: () => read(scope),
        rename: displayName => rename(scope, displayName),
        replace: photo => replace(scope, photo),
        remove: () => remove(scope),
        close: () => retire(scope)
      }
    },
    stop() {
      retire()
      client.off(UserEvent.AvatarUrl, synced)
      client.off(UserEvent.DisplayName, synced)
    }
  }
}

export type BrowserOwnProfiles = ReturnType<typeof createBrowserOwnProfile>
