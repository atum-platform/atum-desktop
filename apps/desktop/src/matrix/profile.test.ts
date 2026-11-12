// @vitest-environment node
import { createClient, MemoryStore, User, UserEvent } from 'matrix-js-sdk'
import { expect, it, vi } from 'vitest'

import { MATRIX_PROFILE_PHOTO_MAX_BYTES } from '../../shared/matrix-profile'

import { matrixProfile } from './profile'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const quietLogger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  getChild() {
    return this
  }
}

function server() {
  const profiles = new Map<string, { displayname: string; avatar_url?: string }>()
  const media = new Map<string, Uint8Array>()
  const writes: Array<{ user: string; token: string | null; avatar: string }> = []
  const names: Array<{ user: string; token: string | null; displayname: string }> = []
  let next = 0
  let holdUpload: Promise<unknown> | undefined
  let holdDownload: Promise<unknown> | undefined
  let refuseCommit = false

  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)

    if (url.pathname.endsWith('/upload')) {
      const id = `photo-${++next}`
      media.set(id, new Uint8Array(await (init?.body as Blob).arrayBuffer()))

      if (holdUpload) {
        await holdUpload
      }

      return Response.json({ content_uri: `mxc://matrix.test/${id}` })
    }

    if (url.pathname.includes('/media/download/')) {
      if (holdDownload) {
        await holdDownload
      }

      return new Response(new Uint8Array(media.get(url.pathname.split('/').at(-1)!) ?? png), {
        headers: { 'content-type': 'image/png' }
      })
    }

    const match = url.pathname.match(/\/profile\/([^/]+)(?:\/(avatar_url|displayname))?$/)!
    const user = decodeURIComponent(match[1]!)

    if (init?.method === 'PUT' && match[2] === 'displayname') {
      const displayname = JSON.parse(init.body as string).displayname as string
      names.push({ user, displayname, token: headers.get('authorization') })
      profiles.set(user, { ...profiles.get(user), displayname })

      return Response.json({})
    }

    if (init?.method === 'PUT') {
      if (refuseCommit) {
        return Response.json({ errcode: 'M_UNKNOWN', error: 'synthetic refusal' }, { status: 500 })
      }

      const avatar = JSON.parse(init.body as string).avatar_url as string
      writes.push({ user, avatar, token: headers.get('authorization') })
      profiles.set(user, { displayname: profiles.get(user)?.displayname ?? user, avatar_url: avatar })

      return Response.json({})
    }

    return Response.json(profiles.get(user) ?? { displayname: user })
  })

  function device(userId = '@human:test', token = 'human-test-token') {
    let alive = true

    const client = createClient({
      baseUrl: 'https://matrix.test',
      userId,
      deviceId: 'MAC',
      accessToken: token,
      store: new MemoryStore(),
      fetchFn: fetcher,
      logger: quietLogger
    })

    const changed = vi.fn()
    const profile = matrixProfile(client, () => alive, changed)
    client.on(UserEvent.AvatarUrl, profile.synced)
    client.on(UserEvent.DisplayName, profile.synced)

    return {
      client,
      profile,
      changed,
      stop() {
        alive = false
        profile.stop()
      }
    }
  }

  return {
    device,
    profiles,
    media,
    writes,
    names,
    fetcher,
    holdUpload(value?: Promise<unknown>) {
      holdUpload = value
    },
    holdDownload(value?: Promise<unknown>) {
      holdDownload = value
    },
    refuseCommit(value: boolean) {
      refuseCommit = value
    }
  }
}

function deferred() {
  let resolve!: () => void

  return {
    promise: new Promise<void>(done => {
      resolve = done
    }),
    resolve: () => resolve()
  }
}

it('uses actual SDK upload/set-avatar/get-profile and authenticated Blob download for each own session', async () => {
  const s = server()

  for (const [userId, token] of [
    ['@human:test', 'human-test-token'],
    ['@agent:test', 'agent-test-token']
  ]) {
    const d = s.device(userId, token)
    s.profiles.set(userId!, { displayname: userId === '@human:test' ? 'Minh' : 'Atum' })
    await d.profile.command({ kind: 'profileRead' })
    await d.profile.command({ kind: 'profileOpen', scope: 'editor' })
    await d.profile.command({ kind: 'profileUpload', scope: 'editor', type: 'image/png', bytes: png })
    expect(s.writes).toHaveLength(userId === '@human:test' ? 0 : 2)
    const saved = await d.profile.command({ kind: 'profileCommit', scope: 'editor' })
    expect(saved?.profile.userId).toBe(userId)
    expect(s.writes.at(-1)).toMatchObject({ user: userId, token: `Bearer ${token}` })
    const read = await d.profile.command({ kind: 'profileRead' })
    expect(read?.photo?.bytes).toEqual(png)
    expect(read?.photo?.type).toBe('image/png')
    const download = s.fetcher.mock.calls.filter(([url]) => String(url).includes('/media/download/')).at(-1)!
    expect(String(download[0])).toContain('/_matrix/client/v1/media/download/matrix.test/photo-')
    expect(new Headers(download[1]?.headers).get('authorization')).toBe(`Bearer ${token}`)
    await d.profile.command({ kind: 'profileCommit', scope: 'editor', remove: true })
    expect(s.writes.at(-1)).toMatchObject({ user: userId, avatar: '' })
    expect((await d.profile.command({ kind: 'profileRead' }))?.profile.avatarMxc).toBeNull()
    d.stop()
  }

  for (const [url, init] of s.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/upload'))) {
    expect(String(url)).not.toContain('filename=')
    expect(new Headers(init?.headers).get('content-type')).toBe('image/png')
  }
})

it('does not commit a late upload after SDK lifetime ends or the editor is discarded', async () => {
  for (const stopping of [false, true]) {
    const s = server(),
      d = s.device(),
      held = deferred()

    s.holdUpload(held.promise)
    await d.profile.command({ kind: 'profileOpen', scope: 'old' })
    const upload = d.profile.command({ kind: 'profileUpload', scope: 'old', type: 'image/png', bytes: png })
    const rejected = expect(upload).rejects.toThrow()
    await vi.waitFor(() => expect(s.fetcher).toHaveBeenCalled())

    if (stopping) {
      d.stop()
    } else {
      await d.profile.command({ kind: 'profileDiscard', scope: 'old' })
    }

    held.resolve()
    await rejected
    await expect(d.profile.command({ kind: 'profileCommit', scope: 'old' })).rejects.toThrow('stale')
    expect(s.writes).toEqual([])
  }
})

it('retries only staged photo commit after refusal, without a second upload or identity creation', async () => {
  const s = server(),
    d = s.device()

  await d.profile.command({ kind: 'profileOpen', scope: 'edit' })
  await d.profile.command({ kind: 'profileUpload', scope: 'edit', type: 'image/png', bytes: png })
  s.refuseCommit(true)
  await expect(d.profile.command({ kind: 'profileCommit', scope: 'edit' })).rejects.toThrow()
  s.refuseCommit(false)
  await d.profile.command({ kind: 'profileCommit', scope: 'edit' })
  expect(s.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/upload'))).toHaveLength(1)
  expect(s.writes).toHaveLength(1)
})

it('keeps broken, unsupported and oversized old media replaceable/removable without unsafe projection', async () => {
  const s = server(),
    d = s.device()

  s.profiles.set('@human:test', { displayname: 'Minh', avatar_url: 'mxc://matrix.test/old' })

  for (const bytes of [new TextEncoder().encode('<svg/>'), new Uint8Array(MATRIX_PROFILE_PHOTO_MAX_BYTES + 1)]) {
    s.media.set('old', bytes)
    expect(await d.profile.command({ kind: 'profileRead' })).toMatchObject({
      profile: { avatarMxc: 'mxc://matrix.test/old' },
      photoUnavailable: true
    })
  }

  await d.profile.command({ kind: 'profileOpen', scope: 'edit' })
  await d.profile.command({ kind: 'profileCommit', scope: 'edit', remove: true })
  expect(s.writes.at(-1)?.avatar).toBe('')
})

it('does not return old downloaded bytes after a newer photo commit', async () => {
  const s = server(),
    d = s.device(),
    held = deferred()

  s.profiles.set('@human:test', { displayname: 'Minh', avatar_url: 'mxc://matrix.test/old' })
  s.holdDownload(held.promise)
  const old = d.profile.command({ kind: 'profileRead' })
  await vi.waitFor(() =>
    expect(s.fetcher.mock.calls.some(([url]) => String(url).includes('/media/download/'))).toBe(true)
  )
  await d.profile.command({ kind: 'profileOpen', scope: 'edit' })
  await d.profile.command({ kind: 'profileUpload', scope: 'edit', type: 'image/png', bytes: png })
  await d.profile.command({ kind: 'profileCommit', scope: 'edit' })
  held.resolve()
  expect(await old).toMatchObject({ profile: { avatarMxc: 'mxc://matrix.test/photo-1' }, photoUnavailable: true })
  expect(await old).not.toHaveProperty('photo')
})

it('updates cached display projection from ordinary SDK profile sync, including another device', async () => {
  const s = server(),
    d = s.device()

  s.profiles.set('@human:test', { displayname: 'Before' })
  await d.profile.command({ kind: 'profileRead' })
  const user = new User('@human:test')
  user.displayName = 'After'
  user.avatarUrl = 'mxc://matrix.test/other-device'
  d.client.store.storeUser(user)
  d.client.emit(UserEvent.AvatarUrl, undefined, user)
  expect(d.profile.snapshot()).toEqual({
    userId: '@human:test',
    displayName: 'After',
    avatarMxc: 'mxc://matrix.test/other-device'
  })
})

it('sets the person’s display name with their own session, validated, without touching the photo', async () => {
  const s = server()
  const d = s.device()
  s.profiles.set('@human:test', { displayname: 'minh', avatar_url: 'mxc://matrix.test/kept' })
  await d.profile.command({ kind: 'profileRead' })
  await d.profile.command({ kind: 'profileOpen', scope: 'editor' })
  await expect(d.profile.command({ kind: 'profileName', scope: 'editor', displayName: '' })).rejects.toThrow(
    'name_invalid'
  )
  const saved = await d.profile.command({ kind: 'profileName', scope: 'editor', displayName: ' An Example ' })
  expect(saved?.profile).toMatchObject({ userId: '@human:test', displayName: 'An Example' })
  expect(s.names).toEqual([{ user: '@human:test', displayname: 'An Example', token: 'Bearer human-test-token' }])
  expect(s.writes).toHaveLength(0)
  expect(d.profile.snapshot().displayName).toBe('An Example')
  expect(d.changed).toHaveBeenCalled()
  await expect(d.profile.command({ kind: 'profileName', scope: 'other', displayName: 'X' })).rejects.toThrow('stale')
  d.stop()
})

it('brings an assistant’s public name to its record without an editor, and only when it differs', async () => {
  const s = server()
  const d = s.device()
  s.profiles.set('@human:test', { displayname: 'Lan', avatar_url: 'mxc://matrix.test/kept' })
  await d.profile.command({ kind: 'profileRead' })

  const synced = await d.profile.command({ kind: 'profileSyncName', displayName: 'Lan Anh' })
  expect(synced?.profile).toMatchObject({ displayName: 'Lan Anh', avatarMxc: 'mxc://matrix.test/kept' })
  expect(s.names).toEqual([{ user: '@human:test', displayname: 'Lan Anh', token: 'Bearer human-test-token' }])

  // Already shown: nothing is sent.
  await d.profile.command({ kind: 'profileSyncName', displayName: 'Lan Anh' })
  expect(s.names).toHaveLength(1)
  expect(s.writes).toHaveLength(0)
  d.stop()
})

it('discovers the server photo with an empty own-user cache and no profile writes', async () => {
  const s = server()
  const userId = '@alice:example.org'
  const d = s.device(userId)
  s.profiles.set(userId, { displayname: 'Alice', avatar_url: 'mxc://matrix.test/photo' })
  expect(d.profile.snapshot().avatarMxc).toBeNull()
  const read = await d.profile.command({ kind: 'profileRead' })
  expect(read?.profile.avatarMxc).toBe('mxc://matrix.test/photo')
  expect(read?.photo?.bytes).toEqual(png)
  expect(d.profile.snapshot().avatarMxc).toBe('mxc://matrix.test/photo')
  expect(s.writes).toEqual([])
  d.stop()
})
