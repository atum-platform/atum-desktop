import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MatrixCompanyFileError,
  requestMatrixCompanyFile
} from './company-files'

const companyId = '00000000-0000-4000-8000-8c031eadb7f3'
const channelId = '00000000-0000-4000-8000-01670d853f95'
const requestId = '00000000-0000-4000-8000-46dfc9f2c745'
const fileId = '00000000-0000-4000-8000-f739b2d7b3b6'
const roomId = '!launch:atum.example'
const eventId = '$company-file-event'
const transactionId = `atum-cf-${requestId}`
const sha256 = 'a'.repeat(64)
const grant = { issuer: 'https://id.test/', subject: 'alice', accessToken: 'access', refreshToken: 'refresh' }
const file = {
  v: 1,
  company_id: companyId,
  channel_id: channelId,
  file_id: fileId,
  revision: 1,
  name: 'brief.pdf',
  content_type: 'application/pdf',
  size: 1048576,
  sha256
}

afterEach(() => vi.unstubAllGlobals())

describe('native company Drive files adapter', () => {
  it('uses only the four fixed platform routes and exact frozen request bodies', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ schemaVersion: 1, state: 'reserved', requestId, file, serverUrl: 'https://drive.atumplatform.com', uploadGrant: { token: 'A'.repeat(43), expiresAtMs: 1791878400000 } }))
      .mockResolvedValueOnce(Response.json({ schemaVersion: 1, state: 'ready', requestId, file, resource: { storage: 'storage-users-1', space: '00000000-0000-4000-8000-e49db4f83c68', opaque: '00000000-0000-4000-8000-3850afc27747' }, etag: '"team-space-v1"' }))
      .mockResolvedValueOnce(Response.json({ schemaVersion: 1, state: 'published', file, roomId, eventId, matrixTransactionId: transactionId }))
      .mockResolvedValueOnce(Response.json({ schemaVersion: 1, state: 'ready', file, serverUrl: 'https://drive.atumplatform.com/', downloadGrant: { token: 'B'.repeat(43), expiresAtMs: 1791878400000 } }))
    vi.stubGlobal('fetch', fetcher)

    const signal = AbortSignal.timeout(2000)
    const reserved = await requestMatrixCompanyFile('https://api.test/api/matrix/v1', grant, {
      action: 'reserve', companyId, channelId, requestId, name: file.name, contentType: file.content_type, size: file.size, sha256
    }, signal)
    await requestMatrixCompanyFile('https://api.test/api/matrix/v1', grant, { action: 'status', companyId, channelId, requestId }, signal)
    await requestMatrixCompanyFile('https://api.test/api/matrix/v1', grant, {
      action: 'publish', companyId, channelId, requestId, fileId, revision: 1, roomId, eventId, matrixTransactionId: transactionId
    }, signal)
    const download = await requestMatrixCompanyFile('https://api.test/api/matrix/v1', grant, {
      action: 'download', companyId, channelId, fileId, revision: 1
    }, signal)

    expect(fetcher.mock.calls.map(call => [call[0], call[1].method, call[1].body])).toEqual([
      [`https://api.test/api/matrix/v1/companies/${companyId}/channels/${channelId}/files`, 'POST', JSON.stringify({ requestId, name: file.name, contentType: file.content_type, size: file.size, sha256 })],
      [`https://api.test/api/matrix/v1/companies/${companyId}/channels/${channelId}/files/by-request/${requestId}`, 'GET', undefined],
      [`https://api.test/api/matrix/v1/companies/${companyId}/channels/${channelId}/files/${fileId}/publish`, 'POST', JSON.stringify({ requestId, fileId, revision: 1, roomId, eventId, matrixTransactionId: transactionId })],
      [`https://api.test/api/matrix/v1/companies/${companyId}/channels/${channelId}/files/${fileId}/download`, 'POST', JSON.stringify({ revision: 1 })]
    ])
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store', headers: expect.objectContaining({ Authorization: 'Bearer access' }) })
      expect(init.headers['X-Atum-Native-Grant-Digest']).toBeUndefined()
    }
    expect(reserved).toMatchObject({ state: 'reserved', uploadGrant: { nativeGrant: 'A'.repeat(43), expiresAtMs: 1791878400000 } })
    expect(download).toMatchObject({ state: 'ready', downloadGrant: { nativeGrant: 'B'.repeat(43), expiresAtMs: 1791878400000 } })
    expect('uploadGrant' in reserved && 'token' in reserved.uploadGrant).toBe(false)
    expect('downloadGrant' in download && 'token' in download.downloadGrant).toBe(false)
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('A'.repeat(43))
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('B'.repeat(43))
  })

  it('rejects non-root HTTPS provider origins and malformed success projections closed', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ schemaVersion: 1, state: 'reserved', requestId, file, serverUrl: 'https://drive.atumplatform.com/redirect', uploadGrant: { token: 'A'.repeat(43), expiresAtMs: 1 } }))
      .mockResolvedValueOnce(Response.json({ schemaVersion: 1, state: 'reserved', requestId, file, serverUrl: 'https://drive.atumplatform.com', uploadGrant: { token: 'A'.repeat(43), expiresAtMs: 1 }, providerCredential: 'forbidden' }))
    vi.stubGlobal('fetch', fetcher)
    const input = { action: 'reserve' as const, companyId, channelId, requestId, name: file.name, contentType: file.content_type, size: file.size, sha256 }
    await expect(requestMatrixCompanyFile('https://api.test', grant, input, AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'invalid' })
    await expect(requestMatrixCompanyFile('https://api.test', grant, input, AbortSignal.timeout(2000))).rejects.toMatchObject({ code: 'invalid' })
  })

  it('accepts only the closed recovery states for reserve replay and status polling', async () => {
    const ready = { schemaVersion: 1, state: 'ready', requestId, file,
      resource: { storage: 'storage-users-1', space: '00000000-0000-4000-8000-e49db4f83c68', opaque: '00000000-0000-4000-8000-3850afc27747' }, etag: '"team-space-v1"' }
    const published = { schemaVersion: 1, state: 'published', requestId, file, roomId, eventId, matrixTransactionId: transactionId,
      resource: ready.resource, etag: ready.etag }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(ready))
      .mockResolvedValueOnce(Response.json(published))
      .mockResolvedValueOnce(Response.json({ schemaVersion: 1, state: 'unknown', requestId, file }))
    vi.stubGlobal('fetch', fetcher)
    const reserve = { action: 'reserve' as const, companyId, channelId, requestId, name: file.name, contentType: file.content_type, size: file.size, sha256 }
    const polling = { action: 'status' as const, companyId, channelId, requestId }
    await expect(requestMatrixCompanyFile('https://api.test', grant, reserve, AbortSignal.timeout(2000))).resolves.toMatchObject({ state: 'ready', resource: ready.resource })
    await expect(requestMatrixCompanyFile('https://api.test', grant, polling, AbortSignal.timeout(2000))).resolves.toMatchObject({ state: 'published', roomId, eventId, matrixTransactionId: transactionId })
    await expect(requestMatrixCompanyFile('https://api.test', grant, polling, AbortSignal.timeout(2000))).resolves.toMatchObject({ state: 'unknown', requestId, file })
  })

  it('maps only valid platform errors and fails malformed error responses closed', async () => {
    const denied = { schemaVersion: 1, status: 403, headers: { cacheControl: 'no-store' }, body: { errcode: 'matrix_denied', reason: 'revoked' } }
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(denied, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ ...denied, body: { ...denied.body, rawError: 'private' } }, { status: 403 }))
    vi.stubGlobal('fetch', fetcher)
    const input = { action: 'status' as const, companyId, channelId, requestId }
    await expect(requestMatrixCompanyFile('https://api.test', grant, input, AbortSignal.timeout(2000))).rejects.toEqual(
      expect.objectContaining({ code: 'denied', reason: 'revoked', message: 'matrix_company_file_denied' })
    )
    await expect(requestMatrixCompanyFile('https://api.test', grant, input, AbortSignal.timeout(2000))).rejects.toEqual(expect.objectContaining({ code: 'unavailable' }))
    expect(MatrixCompanyFileError).toBeTypeOf('function')
  })

  it('redacts native transport failures before they leave the adapter', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('private upstream URL and token') }))
    const input = { action: 'status' as const, companyId, channelId, requestId }
    await expect(requestMatrixCompanyFile('https://api.test', grant, input, AbortSignal.timeout(2000))).rejects.toEqual(
      expect.objectContaining({ code: 'unavailable', message: 'matrix_company_file_unavailable' })
    )
  })
})
