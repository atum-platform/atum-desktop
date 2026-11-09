import { type MatrixClient, Method } from 'matrix-js-sdk'

import {
  MATRIX_PROFILE_PHOTO_MAX_BYTES,
  matrixProfileDisplayName,
  type MatrixProfileMetadata,
  matrixProfileMxc,
  matrixProfilePhoto,
  matrixProfilePhotoType,
  type MatrixProfileReadResult,
  type MatrixProfileSdkCommand
} from '../../shared/matrix-profile'

/** One SDK's own profile. No caller-selected user IDs, credentials or media URL. */
export function matrixProfile(client: MatrixClient, alive: () => boolean, changed: () => void) {
  let known: MatrixProfileMetadata | undefined
  let revision = 0

  let editor:
    | { scope: string; abort?: AbortController; staged?: MatrixProfileReadResult; pending?: boolean }
    | undefined

  function active(scope?: string) {
    if (!alive() || (scope !== undefined && editor?.scope !== scope)) {
      throw new Error('matrix_profile_stale')
    }
  }

  function snapshot(): MatrixProfileMetadata {
    const userId = client.getSafeUserId()
    const user = client.getUser(userId)

    return known ?? { userId, displayName: user?.displayName ?? userId, avatarMxc: matrixProfileMxc(user?.avatarUrl) }
  }

  function discard(scope?: string) {
    if (scope === undefined || editor?.scope === scope) {
      editor?.abort?.abort()
      editor = undefined
    }
  }

  async function read(): Promise<MatrixProfileReadResult> {
    active()
    const startingRevision = revision
    const raw = await client.getProfileInfo(client.getSafeUserId())
    active()

    if (revision !== startingRevision) {
      return { profile: snapshot(), photoUnavailable: Boolean(snapshot().avatarMxc) }
    }

    known = {
      userId: client.getSafeUserId(),
      displayName: raw.displayname?.trim() || client.getSafeUserId(),
      avatarMxc: matrixProfileMxc(raw.avatar_url)
    }
    changed()
    const profile = { ...known }

    if (!profile.avatarMxc) {
      return { profile }
    }

    const [, server, media] = /^mxc:\/\/([^/]+)\/([^/]+)$/.exec(profile.avatarMxc)!

    try {
      const blob = await client.http.authedRequest<Blob>(
        Method.Get,
        `/media/download/${encodeURIComponent(server!)}/${encodeURIComponent(media!)}`,
        undefined,
        undefined,
        { prefix: '/_matrix/client/v1', rawResponseBody: true, localTimeoutMs: 30000 }
      )

      active()

      if (blob.size > MATRIX_PROFILE_PHOTO_MAX_BYTES) {
        throw new Error('matrix_profile_photo_size')
      }

      const bytes = new Uint8Array(await blob.arrayBuffer())
      active()

      if (revision !== startingRevision) {
        return { profile: snapshot(), photoUnavailable: Boolean(snapshot().avatarMxc) }
      }

      const type = matrixProfilePhotoType(bytes)

      if (!type) {
        throw new Error('matrix_profile_photo_type')
      }

      return { profile, photo: matrixProfilePhoto({ bytes, type }) }
    } catch {
      active()

      if (revision !== startingRevision) {
        return { profile: snapshot(), photoUnavailable: Boolean(snapshot().avatarMxc) }
      }

      // A broken/old photo must not prevent replacing or removing it.
      return { profile, photoUnavailable: true }
    }
  }

  async function command(command: MatrixProfileSdkCommand): Promise<MatrixProfileReadResult | null> {
    if (command.kind === 'profileDiscard') {
      discard(command.scope)

      return null
    }

    active()

    if (command.kind === 'profileRead') {
      return read()
    }

    if (command.kind === 'profileSyncName') {
      // Independent of any open editor: the record's name, sent once it has held still.
      const displayName = matrixProfileDisplayName(command.displayName)

      if (snapshot().displayName === displayName) {
        return { profile: snapshot() }
      }

      await client.setDisplayName(displayName)
      active()
      known = { ...snapshot(), displayName }
      revision++
      changed()

      return { profile: { ...known } }
    }

    if (command.kind === 'profileOpen') {
      discard()
      editor = { scope: command.scope }

      return null
    }

    active(command.scope)
    const current = editor!

    if (current.pending) {
      throw new Error('matrix_profile_pending')
    }

    current.pending = true

    try {
      if (command.kind === 'profileName') {
        const displayName = matrixProfileDisplayName(command.displayName)
        await client.setDisplayName(displayName)
        active(command.scope)
        // A concurrent photo sync is independent of this name edit.
        known = { ...snapshot(), displayName }
        revision++
        changed()

        return { profile: { ...known } }
      }

      if (command.kind === 'profileUpload') {
        const photo = matrixProfilePhoto(command)
        current.staged = undefined
        current.abort = new AbortController()

        const uploaded = await client.uploadContent(new Blob([new Uint8Array(photo.bytes)], { type: photo.type }), {
          type: photo.type,
          includeFilename: false,
          abortController: current.abort
        })

        active(command.scope)
        const avatarMxc = matrixProfileMxc(uploaded.content_uri)

        if (!avatarMxc) {
          throw new Error('matrix_profile_upload_failed')
        }

        current.staged = { profile: { ...snapshot(), avatarMxc }, photo }

        // Staging cannot write a profile. Native rechecks the editor and host first.
        return null
      }

      const result = command.remove ? { profile: { ...snapshot(), avatarMxc: null } } : current.staged

      if (!result) {
        throw new Error('matrix_profile_upload_required')
      }

      active(command.scope)
      await client.setAvatarUrl(result.profile.avatarMxc ?? '')
      active(command.scope)
      // A concurrent display-name sync is independent of this photo edit.
      known = { ...snapshot(), avatarMxc: result.profile.avatarMxc }
      result.profile = known
      revision++
      current.staged = undefined
      changed()

      return result
    } finally {
      current.pending = false
      current.abort = undefined
    }
  }

  return {
    snapshot,
    command,
    synced(_event: unknown, user: { userId: string }) {
      if (user.userId !== client.getSafeUserId()) {
        return
      }

      known = undefined
      revision++
      changed()
    },
    stop: () => discard()
  }
}
