import { expect, it, vi } from 'vitest'

import { readDrive } from './google-drive'

it('escapes literal search terms and reports a partial or paginated inventory', async () => {
  const fetchImpl = vi.fn(async (url: any, init: any) => {
    const request = new URL(String(url))
    expect(request.origin).toBe('https://www.googleapis.com')
    expect(request.searchParams.get('q')).toBe("trashed = false and fullText contains 'Q1\\'s \\\\ budget'")
    expect(request.searchParams.get('pageSize')).toBe('20')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-token')
    expect(init.redirect).toBe('error')

    return Response.json({ files: [{ id: 'report' }], incompleteSearch: true })
  }) as typeof fetch

  await expect(readDrive(fetchImpl, 'test-token', { action: 'files', query: "Q1's \\ budget" })).resolves.toMatchObject({ files: [{ id: 'report' }], more: true })
})

it('orders by last viewed and bounds a search to recently modified files', async () => {
  const fetchImpl = vi.fn(async (url: any) => {
    const request = new URL(String(url))
    expect(request.searchParams.get('orderBy')).toBe('viewedByMeTime desc')
    expect(request.searchParams.get('q')).toBe(
      "trashed = false and fullText contains 'budget' and modifiedTime > '2026-01-01T00:00:00.000Z'"
    )

    return Response.json({ files: [] })
  }) as typeof fetch

  await readDrive(fetchImpl, 'test-token', { action: 'files', query: 'budget', sort: 'viewed', modifiedAfter: '2026-01-01' })
})

it.each([
  ['application/vnd.google-apps.document', 'text/plain', undefined],
  ['application/vnd.google-apps.presentation', 'text/plain', undefined],
  ['application/vnd.google-apps.spreadsheet', 'text/csv', 'First sheet only (CSV export).']
])('exports %s with a machine-visible format limitation', async (mimeType, exportType, contentNote) => {
  const calls: URL[] = []

  const fetchImpl = vi.fn(async (url: any) => {
    const request = new URL(String(url))
    calls.push(request)

    return request.pathname.endsWith('/export') ? new Response('Synthetic document') : Response.json({ id: 'doc', mimeType })
  }) as typeof fetch

  const result = await readDrive(fetchImpl, 'test-token', { action: 'file', id: 'doc' })
  expect(result.text).toBe('Synthetic document')
  expect(result.contentNote).toBe(contentNote)
  expect(calls[1].searchParams.get('mimeType')).toBe(exportType)
})

it('stops reading large text and advertises truncation', async () => {
  const cancel = vi.fn()

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new TextEncoder().encode('a'.repeat(80_000))) }, cancel
  })

  const fetchImpl = vi.fn(async (url: any) => new URL(String(url)).searchParams.get('alt') === 'media'
    ? new Response(stream) : Response.json({ id: 'text', mimeType: 'text/plain' })) as typeof fetch

  const result = await readDrive(fetchImpl, 'test-token', { action: 'file', id: 'text' })
  expect(result.text).toHaveLength(40_000)
  expect(result.more).toBe(true)
  expect(cancel).toHaveBeenCalled()
})

it('returns metadata for unsupported or download-restricted files without claiming to read them', async () => {
  const fetchImpl = vi.fn(async () => Response.json({ id: 'pdf', mimeType: 'application/pdf' })) as typeof fetch
  const result = await readDrive(fetchImpl, 'test-token', { action: 'file', id: 'pdf' })
  expect(result.contentUnavailable).toBe('unsupported_type')
  expect(result.text).toBeUndefined()
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  vi.mocked(fetchImpl).mockResolvedValueOnce(Response.json({ id: 'blocked', mimeType: 'text/plain', capabilities: { canDownload: false } }))
  expect((await readDrive(fetchImpl, 'test-token', { action: 'file', id: 'blocked' })).contentUnavailable).toBe('download_restricted')
})

it('truncates text without returning half of an emoji', async () => {
  const prefix = 'a'.repeat(39_999)

  const fetchImpl = vi.fn(async (url: any) => new URL(String(url)).searchParams.get('alt') === 'media'
    ? new Response(`${prefix}😀tail`) : Response.json({ id: 'text', mimeType: 'text/plain' })) as typeof fetch

  const result = await readDrive(fetchImpl, 'test-token', { action: 'file', id: 'text' })
  expect(result.text.length).toBe(prefix.length)
  expect(result.text.endsWith('a')).toBe(true)
  expect(result.more).toBe(true)
})

it('reports provider export limits without treating the account grant as revoked', async () => {
  const fetchImpl = vi.fn(async (url: any) => String(url).includes('/export?')
    ? Response.json({ error: { message: 'private provider detail', errors: [{ reason: 'exportSizeLimitExceeded' }] } }, { status: 403 })
    : Response.json({ id: 'large', mimeType: 'application/vnd.google-apps.document' })) as typeof fetch

  const result = await readDrive(fetchImpl, 'test-token', { action: 'file', id: 'large' })
  expect(result.contentUnavailable).toBe('export_too_large')
  expect(JSON.stringify(result)).not.toContain('private provider detail')
})

it('rejects arbitrary URLs, write actions and oversized queries before network access', async () => {
  const fetchImpl = vi.fn() as typeof fetch

  for (const input of [
    { action: 'file', id: 'https://example.com/file' },
    { action: 'delete', id: 'doc' },
    { action: 'files', query: 'x'.repeat(501) },
    { action: 'files', sort: 'name' },
    { action: 'files', modifiedAfter: '2026-13-01' },
    { action: 'files', modifiedAfter: '2026-02-31' }
  ]) {
    await expect(readDrive(fetchImpl, 'test-token', input)).rejects.toMatchObject({ code: 'invalid_input' })
  }

  expect(fetchImpl).not.toHaveBeenCalled()
})
