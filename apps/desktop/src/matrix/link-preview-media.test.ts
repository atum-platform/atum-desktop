import { describe, expect, it, vi } from 'vitest'

import { matrixLinkPreviews } from './link-preview-media'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const DAY = Date.UTC(2026, 10, 7)

interface FakeEvent {
  id: string
  body: string
  msgtype?: string
  encrypted?: boolean
}

/** A joined room's events, its encryption as the SDK sees it, and the homeserver's preview answers. */
function fakeClient({
  events,
  encrypted = false,
  og = { 'og:title': 'Atum', 'og:site_name': 'Example', 'og:image': 'mxc://chat.example/pic' },
  membership = 'join'
}: {
  events: FakeEvent[]
  encrypted?: boolean
  og?: unknown
  membership?: string
}) {
  const room = {
    roomId: '!plain:test',
    getMyMembership: () => membership,
    hasEncryptionStateEvent: () => encrypted,
    findEventById: (id: string) => {
      const event = events.find(value => value.id === id)

      return event
        ? {
            isEncrypted: () => Boolean(event.encrypted),
            isRedacted: () => false,
            getType: () => 'm.room.message',
            getContent: () => ({ msgtype: event.msgtype ?? 'm.text', body: event.body })
          }
        : undefined
    }
  }

  const getUrlPreview = vi.fn(async () => og)
  const authedRequest = vi.fn(async (..._args: unknown[]) => new Blob([PNG]))

  const client = {
    getRoom: vi.fn((id: string) => (id === room.roomId ? room : null)),
    getCrypto: () => ({ isEncryptionEnabledInRoom: async () => encrypted }),
    getUrlPreview,
    http: { authedRequest }
  }

  return { client: client as never, getUrlPreview, authedRequest }
}

describe('matrixLinkPreviews', () => {
  it('asks the homeserver about the first link only and fetches its picture as a thumbnail', async () => {
    const fake = fakeClient({ events: [{ id: '$a', body: 'https://example.com/one and https://example.org/two' }] })
    const previews = matrixLinkPreviews(fake.client, () => true, () => DAY + 5000)

    const preview = await previews.read('!plain:test', '$a')

    expect(fake.getUrlPreview).toHaveBeenCalledOnce()
    expect(fake.getUrlPreview).toHaveBeenCalledWith('https://example.com/one', DAY)
    expect(fake.authedRequest.mock.calls[0]?.[1]).toBe('/media/thumbnail/chat.example/pic')
    expect(preview).toMatchObject({ url: 'https://example.com/one', title: 'Atum', siteName: 'Example' })
    expect(preview?.image?.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('never asks about a link in an encrypted room', async () => {
    const fake = fakeClient({ events: [{ id: '$a', body: 'https://example.com/' }], encrypted: true })

    await expect(matrixLinkPreviews(fake.client, () => true).read('!plain:test', '$a')).resolves.toBeNull()
    expect(fake.getUrlPreview).not.toHaveBeenCalled()
  })

  it('reads only joined rooms, known events and text messages', async () => {
    const fake = fakeClient({
      events: [
        { id: '$file', body: 'https://example.com/a.pdf', msgtype: 'm.file' },
        { id: '$sealed', body: 'https://example.com/', encrypted: true },
        { id: '$none', body: 'no link here' }
      ]
    })
    const previews = matrixLinkPreviews(fake.client, () => true)

    for (const id of ['$file', '$sealed', '$none', '$missing']) {
      await expect(previews.read('!plain:test', id)).resolves.toBeNull()
    }

    await expect(previews.read('!other:test', '$none')).resolves.toBeNull()
    expect(fake.getUrlPreview).not.toHaveBeenCalled()

    const left = fakeClient({ events: [{ id: '$a', body: 'https://example.com/' }], membership: 'leave' })

    await expect(matrixLinkPreviews(left.client, () => true).read('!plain:test', '$a')).resolves.toBeNull()
    expect(left.getUrlPreview).not.toHaveBeenCalled()
  })

  it('asks once per link per day, across messages and scrolling', async () => {
    let now = DAY + 1000
    const fake = fakeClient({
      events: [
        { id: '$a', body: 'https://example.com/' },
        { id: '$b', body: 'again https://example.com/' }
      ]
    })
    const previews = matrixLinkPreviews(fake.client, () => true, () => now)

    await previews.read('!plain:test', '$a')
    await previews.read('!plain:test', '$a')
    await previews.read('!plain:test', '$b')
    expect(fake.getUrlPreview).toHaveBeenCalledOnce()

    now += 86_400_000
    await previews.read('!plain:test', '$a')
    expect(fake.getUrlPreview).toHaveBeenCalledTimes(2)
  })

  it('is no card without a title or a picture, and a picture that fails still leaves the words', async () => {
    const bare = fakeClient({ events: [{ id: '$a', body: 'https://example.com/' }], og: { 'og:description': 'words' } })

    await expect(matrixLinkPreviews(bare.client, () => true).read('!plain:test', '$a')).resolves.toBeNull()

    const broken = fakeClient({ events: [{ id: '$a', body: 'https://example.com/' }] })
    broken.authedRequest.mockRejectedValueOnce(new Error('timeout'))

    const preview = await matrixLinkPreviews(broken.client, () => true).read('!plain:test', '$a')

    expect(preview).toMatchObject({ title: 'Atum' })
    expect(preview?.image).toBeUndefined()
  })

  it('does not remember a failed read, so the next view asks again', async () => {
    const fake = fakeClient({ events: [{ id: '$a', body: 'https://example.com/' }] })
    fake.getUrlPreview.mockRejectedValueOnce(new Error('M_UNKNOWN'))
    const previews = matrixLinkPreviews(fake.client, () => true)

    await expect(previews.read('!plain:test', '$a')).rejects.toThrow('M_UNKNOWN')
    await expect(previews.read('!plain:test', '$a')).resolves.toMatchObject({ title: 'Atum' })
    expect(fake.getUrlPreview).toHaveBeenCalledTimes(2)
  })
})
