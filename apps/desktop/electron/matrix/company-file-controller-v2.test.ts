import { describe, expect, it, vi } from 'vitest'

import type { MatrixCompanyFileRefV2 } from '../../shared/matrix-company-files'

import { readCompanyFileV2, sendCompanyFileV2 } from './company-file-controller-v2'
import { MatrixCompanyFileError } from './company-files'

const COMPANY = '00000000-0000-4000-8000-49e71e77e770'
const CHANNEL = '00000000-0000-4000-8000-349a589e80e1'
const FILE_ID = '00000000-0000-4000-8000-1b481f0c36d7'
const ROOM = '!private:test'

const REQUESTS = [
  '00000000-0000-4000-8000-ba95bd789610',
  '00000000-0000-4000-8000-abcb17778b70',
  '00000000-0000-4000-8000-481df826ef49'
]

const authority = {
  companyId: COMPANY,
  audience: { kind: 'channel' as const, channel_id: CHANNEL, visibility: 'private' as const },
  viewerAdmissionEpoch: 3,
  audienceGeneration: 9
}

const file: MatrixCompanyFileRefV2 = {
  v: 2, company_id: COMPANY, audience: authority.audience, file_id: FILE_ID, revision: 1,
  name: 'plans.txt', content_type: 'text/plain', size: 3,
  sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
}

function ports() {
  let request = 0

  const platform = vi.fn(async input => input.action === 'reserve-v2'
    ? { schemaVersion: 2 as const, state: 'reserved' as const, file,
        uploadSessionId: '00000000-0000-4000-8000-7bf3cff94e34', audienceGeneration: 9, replayed: false }
    : input.action === 'publish-v2'
      ? { schemaVersion: 2 as const, state: 'ready' as const, file, audienceGeneration: 9, replayed: false }
      : input.action === 'download-v2'
        ? { schemaVersion: 2 as const, state: 'download' as const, fileId: FILE_ID,
            downloadGrantId: '00000000-0000-4000-8000-cc7c3857de01', expiresAtMs: Date.now() + 60_000,
            audienceGeneration: 9, viewerAdmissionEpoch: 3, replayed: false }
        : { schemaVersion: 2 as const, state: 'ready' as const, fileId: FILE_ID,
            audienceGeneration: 9, viewerAdmissionEpoch: 3 })

  const sdk = vi.fn(async command => command.kind === 'companyFileContext'
    ? { companyId: COMPANY, target: { kind: 'channel', channelId: CHANNEL }, roomId: ROOM,
        ...('threadRootId' in command ? { threadRootId: command.threadRootId, replyTo: command.replyTo } : {}) }
    : '$sent')

  return {
    platform, sdk, current: () => true, serverUrl: 'https://api.atum.test',
    upload: vi.fn(async () => {}), download: vi.fn(async () => new Uint8Array([1, 2, 3])),
    requestId: () => REQUESTS[request++]!
  }
}

describe('audience-scoped protected company files', () => {
  it('uploads a private-channel thread file under the exact current audience and never calls Matrix media', async () => {
    const p = ports()
    await expect(sendCompanyFileV2({ roomId: ROOM, name: file.name, contentType: file.content_type,
      bytes: new TextEncoder().encode('abc'), threadRootId: '$root', replyTo: '$reply' }, authority, p,
    AbortSignal.timeout(1_000))).resolves.toBe('$sent')

    expect(p.platform.mock.calls[0]![0]).toEqual({ action: 'reserve-v2', ...authority,
      requestId: REQUESTS[0], name: file.name, contentType: file.content_type, size: 3, sha256: file.sha256 })
    expect(p.sdk).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'companyFileSend', file, threadRootId: '$root', replyTo: '$reply'
    }))
    expect(p.sdk.mock.calls.flatMap(call => [call[0]])).not.toContainEqual(expect.objectContaining({ kind: 'attach' }))
  })

  it('mints a fresh grant on every download and never serves bytes after revocation', async () => {
    const p = ports()
    await readCompanyFileV2(file, authority, p, AbortSignal.timeout(1_000))
    await readCompanyFileV2(file, authority, p, AbortSignal.timeout(1_000))
    expect(p.platform.mock.calls.filter(call => call[0].action === 'download-v2')).toHaveLength(2)
    expect(p.download).toHaveBeenCalledTimes(2)

    p.platform.mockRejectedValueOnce(new MatrixCompanyFileError('denied', undefined, 'revoked'))
    await expect(readCompanyFileV2(file, authority, p, AbortSignal.timeout(1_000)))
      .rejects.toThrow('matrix_company_file_denied')
    expect(p.download).toHaveBeenCalledTimes(2)
  })
})
