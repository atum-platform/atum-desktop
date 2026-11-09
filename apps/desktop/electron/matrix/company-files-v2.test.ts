import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixCompanyFileError } from './company-files'
import { requestMatrixCompanyFileV2 } from './company-files-v2'

const COMPANY = '00000000-0000-4000-8000-49e71e77e770'
const CHANNEL = '00000000-0000-4000-8000-349a589e80e1'
const REQUEST = '00000000-0000-4000-8000-abd61e4a475a'

afterEach(() => vi.unstubAllGlobals())

describe('company Drive files 1.2 platform capability', () => {
  const reserve = {
    action: 'reserve-v2' as const,
    companyId: COMPANY,
    audience: { kind: 'channel' as const, channel_id: CHANNEL, visibility: 'private' as const },
    viewerAdmissionEpoch: 3,
    audienceGeneration: 9,
    requestId: REQUEST,
    name: 'plans.txt',
    contentType: 'text/plain',
    size: 3,
    sha256: 'a'.repeat(64)
  }

  const grant = { accessToken: 'native-only', sessionId: 'session', expiresAt: Date.now() + 60_000 }

  it('sends the closed audience/epoch/generation request on the 1.5 selector', async () => {
    const request = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify({
      schemaVersion: 2,
      file: { v: 2, company_id: COMPANY, audience: reserve.audience,
        file_id: '00000000-0000-4000-8000-1b481f0c36d7', revision: 1, name: reserve.name,
        content_type: reserve.contentType, size: reserve.size, sha256: reserve.sha256 },
      uploadSessionId: '00000000-0000-4000-8000-bb8859f17dee',
      audienceGeneration: 9,
      replayed: false
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    vi.stubGlobal('fetch', request)
    await requestMatrixCompanyFileV2('https://api.atum.test/api/matrix/v1', grant as never, reserve,
      AbortSignal.timeout(1_000))
    expect(request).toHaveBeenCalledExactlyOnceWith(
      `https://api.atum.test/api/matrix/v1/companies/${COMPANY}/files/reserve`,
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'Atum-Company-Wire': '1.5' }) })
    )
    expect(JSON.parse(String(request.mock.calls[0]![1].body))).toEqual({
      requestId: REQUEST, companyId: COMPANY, audience: reserve.audience,
      viewerAdmissionEpoch: 3, audienceGeneration: 9, name: reserve.name,
      contentType: reserve.contentType, size: 3, sha256: reserve.sha256
    })
  })

  it('turns a missing 1.2 route into an honest unsupported refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
    await expect(requestMatrixCompanyFileV2('https://api.atum.test/api/matrix/v1', grant as never, reserve,
      AbortSignal.timeout(1_000))).rejects.toEqual(expect.objectContaining<Partial<MatrixCompanyFileError>>({
        code: 'unsupported', message: 'matrix_company_file_unsupported'
      }))
  })
})
