import { describe, expect, it, vi } from 'vitest'

import { matrixAgentAvatarDataUrl, MatrixAgentAvatarProjection, readMatrixAgentAvatar } from './agent-avatar'

const owner = '00000000-0000-4000-8000-576f18824476'
const assistant = '00000000-0000-4000-8000-951c747b3afc'
const upload = '00000000-0000-4000-8000-b62b874557d6'
const bytes = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3])
const url = `https://public-config.example.invalid/storage/v1/object/public/atum-avatars-v1/assistants/principals/${owner}/${assistant}/${upload}.png`

it('projects only the exact canonical owner/assistant object without credentials or redirects', async () => {
  const fetcher = vi.fn(async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }))

  await expect(readMatrixAgentAvatar({ assistantId: assistant, url }, { fetch: fetcher })).resolves.toBe(
    matrixAgentAvatarDataUrl('image/png', bytes)
  )
  expect(fetcher).toHaveBeenCalledWith(new URL(url), expect.objectContaining({ credentials: 'omit', redirect: 'error' }))
})

it('supports the explicit local Supabase port used by development stacks', async () => {
  const local = url.replace('https://public-config.example.invalid', 'http://127.0.0.1:54321')
  const fetcher = vi.fn(async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }))

  await expect(readMatrixAgentAvatar(
    { assistantId: assistant, url: local },
    { allowLocal: true, fetch: fetcher }
  )).resolves.toBe(
    matrixAgentAvatarDataUrl('image/png', bytes)
  )
})

it.each([
  url.replace('public-config.example.invalid', 'example.com'),
  url.replace('public-config.example.invalid', 'another-project.supabase.co'),
  url.replace(assistant, '00000000-0000-4000-8000-131f2cfdc809'),
  url + '?token=secret',
  url + '#fragment',
  url.replace('https://', 'https://user:secret@')
])('refuses an unbound avatar URL without fetching it: %s', async refused => {
  const fetcher = vi.fn()
  await expect(readMatrixAgentAvatar({ assistantId: assistant, url: refused }, { fetch: fetcher })).resolves.toBeNull()
  expect(fetcher).not.toHaveBeenCalled()
})

it('refuses an invalid assistant selector before constructing the path expression', async () => {
  const fetcher = vi.fn()
  await expect(readMatrixAgentAvatar({ assistantId: '.*', url }, { fetch: fetcher })).resolves.toBeNull()
  expect(fetcher).not.toHaveBeenCalled()
})

describe('download validation', () => {
  it('refuses wrong media bytes and oversized bodies', async () => {
    const wrong = vi.fn(async () => new Response('not png', { headers: { 'content-type': 'image/png' } }))
    await expect(readMatrixAgentAvatar({ assistantId: assistant, url }, { fetch: wrong })).resolves.toBeNull()

    const wrongExtension = vi.fn(async () => new Response(bytes, { headers: { 'content-type': 'image/jpeg' } }))
    await expect(readMatrixAgentAvatar({ assistantId: assistant, url }, { fetch: wrongExtension })).resolves.toBeNull()

    const large = vi.fn(async () => new Response(Buffer.alloc(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } }))
    await expect(readMatrixAgentAvatar({ assistantId: assistant, url }, { fetch: large })).resolves.toBeNull()
  })

  it('refuses redirects, HTTP errors and unsupported content types', async () => {
    for (const response of [
      new Response(null, { status: 404 }),
      new Response(bytes, { headers: { 'content-type': 'image/svg+xml' } })
    ]) {
      await expect(readMatrixAgentAvatar(
        { assistantId: assistant, url },
        { fetch: vi.fn(async () => response) }
      )).resolves.toBeNull()
    }
  })
})

describe('runtime projection', () => {
  const target = () => ({ avatarUrl: null as string | null, closed: false })
  const deferred = () => {
    let resolve!: (value: string | null) => void
    const promise = new Promise<string | null>(done => {resolve = done})

    return { promise, resolve }
  }

  it('publishes only the newest read when an earlier source finishes late', async () => {
    const first = deferred()
    const second = deferred()
    const read = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const changed = vi.fn()
    const projection = new MatrixAgentAvatarProjection({ changed, read })
    const runtime = target()

    projection.project(runtime, assistant, url)
    projection.project(runtime, assistant, url.replace(`${upload}.png`, '00000000-0000-4000-8000-131f2cfdc809.png'))
    first.resolve('data:image/png;base64,b2xk')
    await first.promise
    expect(runtime.avatarUrl).toBeNull()
    second.resolve('data:image/png;base64,bmV3')
    await vi.waitFor(() => expect(runtime.avatarUrl).toBe('data:image/png;base64,bmV3'))
    expect(changed).toHaveBeenCalledOnce()
  })

  it('uses validated uploaded bytes immediately without a fetch and clears them on removal', () => {
    const read = vi.fn()
    const projection = new MatrixAgentAvatarProjection({ changed: vi.fn(), read })
    const runtime = target()

    projection.project(runtime, assistant, url, { type: 'image/png', bytes })
    expect(runtime.avatarUrl).toBe(matrixAgentAvatarDataUrl('image/png', bytes))
    expect(read).not.toHaveBeenCalled()
    projection.project(runtime, assistant, null)
    expect(runtime.avatarUrl).toBeNull()
  })

  it('retries a failed read at the next reconciliation and ignores a closed runtime', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('data:image/png;base64,b2s=')
    const changed = vi.fn()
    const projection = new MatrixAgentAvatarProjection({ changed, read })
    const runtime = target()

    projection.project(runtime, assistant, url)
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    await new Promise(resolve => setTimeout(resolve, 0))
    projection.project(runtime, assistant, url)
    runtime.closed = true
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    expect(runtime.avatarUrl).toBeNull()
    expect(changed).not.toHaveBeenCalled()
  })
})
