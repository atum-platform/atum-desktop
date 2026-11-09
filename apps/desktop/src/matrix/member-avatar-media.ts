import { EventType, type MatrixClient, Method } from 'matrix-js-sdk'

import type { MatrixCompanyAvatarMedia, MatrixCompanyAvatarPhoto } from '../../shared/matrix-company'
import { companyChannelRoomBinding } from '../../shared/matrix-company-channel-room'
import {
  MATRIX_PROFILE_PHOTO_MAX_BYTES,
  type MatrixMemberAvatar,
  matrixProfileMxc,
  matrixProfilePhoto,
  matrixProfilePhotoType
} from '../../shared/matrix-profile'

/** Bounded, per-SDK cache of members' profile photos, as data URLs the window may paint. */
const CACHE_LIMIT = 128

/**
 * One member of the chat on screen: their current public Matrix profile photo, downloaded
 * through this SDK's authenticated media endpoint (the same path the person's own profile
 * uses). The caller may never name media: only a joined member of a joined room.
 */
export function matrixMemberAvatars(client: MatrixClient, alive: () => boolean) {
  const cache = new Map<string, string>()
  const reads = new Map<string, Promise<string>>()

  function remember(mxc: string, dataUrl: string) {
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next().value

      if (oldest !== undefined) {
        cache.delete(oldest)
      }
    }

    cache.set(mxc, dataUrl)
  }

  async function download(mxc: string): Promise<string> {
    const cached = cache.get(mxc)

    if (cached) {
      return cached
    }

    const inFlight = reads.get(mxc)

    if (inFlight) {
      return inFlight
    }

    const request = (async () => {
      const match = /^mxc:\/\/([^/]+)\/([^/]+)$/u.exec(mxc)

      if (!match) {
        throw new Error('matrix_member_avatar_unavailable')
      }

      const blob = await client.http.authedRequest<Blob>(
        Method.Get,
        `/media/download/${encodeURIComponent(match[1]!)}/${encodeURIComponent(match[2]!)}`,
        undefined,
        undefined,
        { prefix: '/_matrix/client/v1', rawResponseBody: true, localTimeoutMs: 30_000 }
      )

      if (!alive() || blob.size > MATRIX_PROFILE_PHOTO_MAX_BYTES) {
        throw new Error('matrix_member_avatar_unavailable')
      }

      const bytes = new Uint8Array(await blob.arrayBuffer())
      const type = matrixProfilePhotoType(bytes)

      if (!type) {
        throw new Error('matrix_member_avatar_unavailable')
      }

      let binary = ''

      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
      }

      const value = `data:${type};base64,${btoa(binary)}`
      remember(mxc, value)

      return value
    })()

    reads.set(mxc, request)

    try {
      return await request
    } finally {
      reads.delete(mxc)
    }
  }

  return {
    async uploadCompany(photo: MatrixCompanyAvatarPhoto): Promise<string> {
      const prepared = matrixProfilePhoto(photo)
      const uploaded = await client.uploadContent(
        new Blob([new Uint8Array(prepared.bytes)], { type: prepared.type }),
        { type: prepared.type, includeFilename: false }
      )
      const mxc = matrixProfileMxc(uploaded.content_uri)

      if (!alive() || !mxc) {
        throw new Error('matrix_company_avatar_unavailable')
      }

      return mxc
    },

    async readCompanyRoom(roomId: string): Promise<MatrixCompanyAvatarMedia> {
      const room = client.getRoom(roomId)

      if (!alive() || !room || room.getMyMembership() !== 'join') {
        throw new Error('matrix_company_avatar_unavailable')
      }

      const creation = room.currentState.getStateEvents(EventType.RoomCreate, '')

      if (!creation || Array.isArray(creation) || !companyChannelRoomBinding(creation.getContent(), creation.getSender())) {
        throw new Error('matrix_company_avatar_unavailable')
      }

      const avatar = room.currentState.getStateEvents(EventType.RoomAvatar, '')

      if (Array.isArray(avatar)) {
        throw new Error('matrix_company_avatar_unavailable')
      }

      const mxc = matrixProfileMxc(avatar?.getContent()?.url)

      return { roomId, avatarMxc: mxc, avatarUrl: mxc ? await download(mxc) : null }
    },

    async read(roomId: string, userId: string): Promise<MatrixMemberAvatar> {
      const room = client.getRoom(roomId)

      if (!alive() || !room || room.getMyMembership() !== 'join') {
        throw new Error('matrix_member_avatar_unavailable')
      }

      const member = room.getMember(userId)

      if (!member || !['join', 'invite'].includes(member.membership ?? '')) {
        throw new Error('matrix_member_avatar_unavailable')
      }

      const mxc = matrixProfileMxc(member.getMxcAvatarUrl())

      return { userId, avatarUrl: mxc ? await download(mxc) : null }
    }
  }
}
