import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import {
  downloadCompanyFile,
  downloadCompanyFileV2,
  MatrixCompanyFileTransportError,
  uploadCompanyFile,
  uploadCompanyFileV2
} from './company-file-transport'

const file = {
  v: 1 as const,
  company_id: '00000000-0000-4000-8000-8c031eadb7f3',
  channel_id: '00000000-0000-4000-8000-01670d853f95',
  file_id: '00000000-0000-4000-8000-f739b2d7b3b6',
  revision: 1 as const,
  name: 'brief.txt',
  content_type: 'text/plain',
  size: 5,
  sha256: createHash('sha256').update('brief').digest('hex')
}
const nativeGrant = 'A'.repeat(43)
const expiresAtMs = Date.now() + 60_000
const fileV2 = {
  v: 2 as const,
  company_id: file.company_id,
  audience: { kind: 'channel' as const, channel_id: file.channel_id, visibility: 'private' as const },
  file_id: file.file_id,
  revision: file.revision,
  name: file.name,
  content_type: file.content_type,
  size: file.size,
  sha256: file.sha256
}

describe('company file native transport', () => {
  it('uploads exact bytes to the fixed company path without returning custody', async () => {
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      expect(String(_url)).toBe(`https://drive.example/atum/company-files/${file.file_id}`)
      expect(init).toMatchObject({ method: 'PUT', redirect: 'error', credentials: 'omit', cache: 'no-store' })
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${nativeGrant}`)
      expect(new Headers(init?.headers).get('content-length')).toBe('5')
      expect(Buffer.from(init?.body as Uint8Array).toString()).toBe('brief')
      return new Response('{"state":"ready"}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '17' }
      })
    })
    await expect(uploadCompanyFile({ serverUrl: 'https://drive.example', file, nativeGrant, expiresAtMs,
      bytes: new TextEncoder().encode('brief') }, new AbortController().signal, request)).resolves.toBeUndefined()
  })

  it('downloads only the pinned revision, metadata and hash', async () => {
    const request = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(`https://drive.example/atum/company-files/${file.file_id}/revisions/1`)
      expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' })
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${nativeGrant}`)
      expect(new Headers(init?.headers).get('accept')).toBe(file.content_type)
      return new Response('brief', { status: 200, headers: {
        'content-type': 'Text/Plain; charset=utf-8', 'content-length': '5',
        'x-atum-company-file-sha256': file.sha256
      } })
    })
    await expect(downloadCompanyFile({ serverUrl: 'https://drive.example', file, nativeGrant, expiresAtMs },
      new AbortController().signal, request)).resolves.toEqual(new TextEncoder().encode('brief'))
  })

  it('refuses expired grants, byte drift, redirects and revoked reads without leaking a response body', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response('provider detail', { status: 403 }))
    await expect(downloadCompanyFile({ serverUrl: 'https://drive.example', file, nativeGrant, expiresAtMs },
      new AbortController().signal, request)).rejects.toMatchObject({ code: 'denied' })
    await expect(uploadCompanyFile({ serverUrl: 'https://elsewhere.test/path', file, nativeGrant, expiresAtMs,
      bytes: new TextEncoder().encode('brief') }, new AbortController().signal, request)).rejects.toBeInstanceOf(
      MatrixCompanyFileTransportError
    )
    await expect(uploadCompanyFile({ serverUrl: 'https://drive.example', file, nativeGrant,
      expiresAtMs: Date.now() - 1, bytes: new TextEncoder().encode('brief') },
    new AbortController().signal, request)).rejects.toMatchObject({ code: 'denied' })
    await expect(uploadCompanyFile({ serverUrl: 'https://drive.example', file, nativeGrant, expiresAtMs,
      bytes: new TextEncoder().encode('wrong') }, new AbortController().signal, request)).rejects.toMatchObject({
      code: 'invalid'
    })
  })

  it('turns provider and stream failures into closed native errors', async () => {
    const request = vi.fn<typeof fetch>(async () => { throw new Error('private provider detail') })
    await expect(downloadCompanyFile({ serverUrl: 'https://drive.example', file, nativeGrant, expiresAtMs },
      new AbortController().signal, request)).rejects.toEqual(expect.objectContaining({
      code: 'unavailable', message: 'matrix_company_file_unavailable'
    }))
    const conflict = vi.fn<typeof fetch>(async () => new Response('{"private":"detail"}', { status: 409 }))
    await expect(downloadCompanyFile({ serverUrl: 'https://drive.example', file, nativeGrant, expiresAtMs },
      new AbortController().signal, conflict)).rejects.toEqual(expect.objectContaining({
      code: 'version_conflict', message: 'matrix_company_file_version_conflict'
    }))
  })

  it('uses only the v2 ingress path and refuses a revocation recheck before returning bytes', async () => {
    const uploadSessionId = '00000000-0000-4000-8000-807f8b51d026'
    const downloadGrantId = '00000000-0000-4000-8000-79621a787ddf'
    const uploaded = vi.fn<typeof fetch>(async url => {
      expect(String(url)).toBe(`https://drive.example/atum/company-files/v2/${file.file_id}`)
      return new Response('{"schemaVersion":2,"state":"uploaded"}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    await expect(uploadCompanyFileV2({ serverUrl: 'https://drive.example/api/matrix/v1', file: fileV2,
      uploadSessionId, bytes: new TextEncoder().encode('brief') }, new AbortController().signal, uploaded))
      .resolves.toBeUndefined()

    const revoked = vi.fn<typeof fetch>(async url => {
      expect(String(url)).toBe(`https://drive.example/atum/company-files/v2/${file.file_id}/revisions/1`)
      return new Response('{"schemaVersion":2,"status":403}', { status: 403 })
    })
    await expect(downloadCompanyFileV2({ serverUrl: 'https://drive.example/api/matrix/v1', file: fileV2,
      downloadGrantId, expiresAtMs }, new AbortController().signal, revoked)).rejects.toMatchObject({ code: 'denied' })
  })
})
