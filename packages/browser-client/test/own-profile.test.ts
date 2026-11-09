import { MatrixClient } from 'matrix-js-sdk/lib/client'
import type { Logger } from 'matrix-js-sdk/lib/logger'
import { UserEvent, type User } from 'matrix-js-sdk/lib/models/user'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createBrowserOwnProfile } from '../src/own-profile'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const quietLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  getChild() {
    return quietLogger
  }
}

interface ServerProfile {
  displayName: string
  avatarMxc: string
  photo: Uint8Array
}

function sdkFixture(userId: string, profile: ServerProfile, uploadGate?: Promise<void>) {
  const requests: Array<{ method: string; path: string; body?: unknown }> = []
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = init?.method ?? 'GET'
    if (url.pathname.includes('/profile/') && method === 'GET') {
      return Response.json({ displayname: profile.displayName, avatar_url: profile.avatarMxc })
    }
    if (url.pathname.endsWith('/displayname') && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as { displayname: string }
      requests.push({ method, path: url.pathname, body })
      profile.displayName = body.displayname
      return Response.json({})
    }
    if (url.pathname.endsWith('/avatar_url') && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as { avatar_url: string }
      requests.push({ method, path: url.pathname, body })
      profile.avatarMxc = body.avatar_url
      return Response.json({})
    }
    if (url.pathname.endsWith('/media/v3/upload') && method === 'POST') {
      requests.push({ method, path: url.pathname, body: init?.body })
      if (uploadGate) await uploadGate
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      profile.photo = new Uint8Array(await (init?.body as Blob).arrayBuffer())
      return Response.json({ content_uri: 'mxc://matrix.test/replaced' })
    }
    if (url.pathname.includes('/media/download/')) {
      return new Response(profile.photo.slice().buffer as ArrayBuffer, { headers: { 'content-type': 'image/png' } })
    }
    throw new Error(`unexpected fixture request: ${method} ${url.pathname}`)
  })
  const client = new MatrixClient({
    baseUrl: 'https://matrix.test',
    accessToken: 'fixture-token',
    userId,
    deviceId: 'WEB_PROFILE',
    logger: quietLogger,
    fetchFn
  })
  return { client, fetchFn, requests }
}

afterEach(() => vi.restoreAllMocks())

describe('browser own Matrix profile', () => {
  it('reads, renames, replaces and clears through the pinned matrix-js-sdk boundary', async () => {
    const server = { displayName: 'An', avatarMxc: 'mxc://matrix.test/original', photo: png }
    const fixture = sdkFixture('@an:matrix.test', server)
    let alive = true
    let online = true
    const profiles = createBrowserOwnProfile(
      fixture.client,
      () => alive,
      () => online
    )
    const editor = profiles.open()

    const initial = await editor.read()
    expect(initial).toMatchObject({ displayName: 'An', hasAvatar: true, photoUnavailable: false })
    expect(new Uint8Array(await initial.photo!.arrayBuffer())).toEqual(png)

    expect(await editor.rename('  An   Trần ')).toMatchObject({ displayName: 'An Trần' })
    expect(server.displayName).toBe('An Trần')

    const replaced = await editor.replace({ kind: 'replace', type: 'image/png', bytes: png })
    expect(replaced).toMatchObject({ displayName: 'An Trần', hasAvatar: true })
    expect(server.avatarMxc).toBe('mxc://matrix.test/replaced')
    expect(fixture.requests.find(row => row.path.endsWith('/media/v3/upload'))?.body).toBeInstanceOf(Blob)

    expect(await editor.remove()).toMatchObject({ hasAvatar: false, photo: null })
    expect(server.avatarMxc).toBe('')
    expect(fixture.requests.at(-1)).toMatchObject({ body: { avatar_url: '' } })

    online = false
    await expect(editor.read()).rejects.toThrow('matrix_profile_offline')
    alive = false
    await expect(editor.rename('Too late')).rejects.toThrow('matrix_profile_stale')
    profiles.stop()
  })

  it('invalidates an open presentation on a native own-user profile sync', async () => {
    const server = { displayName: 'First', avatarMxc: '', photo: png }
    const fixture = sdkFixture('@sync:matrix.test', server)
    const changed = vi.fn()
    const profiles = createBrowserOwnProfile(
      fixture.client,
      () => true,
      () => true
    )
    const editor = profiles.open(changed)
    const first = await editor.read()

    server.displayName = 'From another device'
    fixture.client.emit(UserEvent.DisplayName, undefined, { userId: '@sync:matrix.test' } as User)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(await editor.read()).toMatchObject({ displayName: 'From another device', revision: first.revision + 1 })

    fixture.client.emit(UserEvent.AvatarUrl, undefined, { userId: '@other:matrix.test' } as User)
    expect(changed).toHaveBeenCalledTimes(1)
    profiles.stop()
  })

  it('cancels a retired A editor and never commits its upload through replacement B or A runtimes', async () => {
    let releaseUpload!: () => void
    const uploadGate = new Promise<void>(resolve => {
      releaseUpload = resolve
    })
    const firstServer = { displayName: 'A old', avatarMxc: '', photo: png }
    const first = sdkFixture('@a:matrix.test', firstServer, uploadGate)
    let firstAlive = true
    const firstProfiles = createBrowserOwnProfile(
      first.client,
      () => firstAlive,
      () => true
    )
    const stale = firstProfiles.open().replace({ kind: 'replace', type: 'image/png', bytes: png })
    await vi.waitFor(() => expect(first.requests.some(row => row.path.endsWith('/media/v3/upload'))).toBe(true))

    firstAlive = false
    firstProfiles.stop()
    const replacementB = sdkFixture('@b:matrix.test', { displayName: 'B', avatarMxc: '', photo: png })
    const replacementA = sdkFixture('@a:matrix.test', { displayName: 'A new', avatarMxc: '', photo: png })
    const bProfiles = createBrowserOwnProfile(
      replacementB.client,
      () => true,
      () => true
    )
    const aProfiles = createBrowserOwnProfile(
      replacementA.client,
      () => true,
      () => true
    )
    expect(await bProfiles.open().read()).toMatchObject({ displayName: 'B' })
    expect(await aProfiles.open().read()).toMatchObject({ displayName: 'A new' })

    releaseUpload()
    await expect(stale).rejects.toThrow()
    expect(first.requests.some(row => row.path.endsWith('/avatar_url'))).toBe(false)
    expect(replacementB.requests.some(row => row.method !== 'GET')).toBe(false)
    expect(replacementA.requests.some(row => row.method !== 'GET')).toBe(false)
    bProfiles.stop()
    aProfiles.stop()
  })

  it('rejects invalid or oversized profile media before SDK upload', async () => {
    const fixture = sdkFixture('@media:matrix.test', { displayName: 'Media', avatarMxc: '', photo: png })
    const profiles = createBrowserOwnProfile(
      fixture.client,
      () => true,
      () => true
    )
    const editor = profiles.open()
    await expect(editor.replace({ kind: 'replace', type: 'image/jpeg', bytes: png })).rejects.toThrow(
      'matrix_profile_photo_type'
    )
    await expect(
      editor.replace({
        kind: 'replace',
        type: 'image/png',
        bytes: new Uint8Array(2 * 1024 * 1024 + 1).fill(1)
      })
    ).rejects.toThrow('matrix_profile_photo_size')
    expect(fixture.requests).toEqual([])
    profiles.stop()
  })
})
