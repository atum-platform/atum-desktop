import { describe, expect, it, vi } from 'vitest'

import type { MatrixCompanyAIFileRef } from '../../shared/matrix-company-ai'

import { openMatrixCompanyBoardAttachment } from './company-board-attachment'
import type { MatrixCompanyFileControllerPorts } from './company-file-controller'
import { MatrixCompanyFileError } from './company-files'

const file = {
  v: 2,
  company_id: '00000000-0000-4000-8000-3fff02fcbe73',
  audience: {
    kind: 'channel',
    channel_id: '00000000-0000-4000-8000-af517c7d26bd',
    visibility: 'private'
  },
  file_id: '00000000-0000-4000-8000-134a41dbb670',
  revision: 1,
  name: 'launch-plan.pdf',
  content_type: 'application/pdf',
  size: 3,
  sha256: 'a'.repeat(64)
} satisfies MatrixCompanyAIFileRef

function fixture() {
  const transportFile = {
    v: 1 as const,
    company_id: file.company_id,
    channel_id: file.audience.channel_id,
    file_id: file.file_id,
    revision: 1 as const,
    name: file.name,
    content_type: file.content_type,
    size: file.size,
    sha256: file.sha256
  }
  const platform = vi.fn(async () => ({
    schemaVersion: 1 as const,
    state: 'ready' as const,
    file: transportFile,
    serverUrl: 'https://drive.test',
    downloadGrant: { nativeGrant: 'A'.repeat(43), expiresAtMs: Date.now() + 60_000 }
  }))
  const download = vi.fn(async () => new Uint8Array([1, 2, 3]))
  const ports = {
    pending: () => null,
    remember: () => {},
    clear: () => {},
    platform,
    sdk: async () => null,
    current: () => true,
    download
  } satisfies MatrixCompanyFileControllerPorts

  return { download, platform, ports, transportFile }
}

describe('company board protected attachment open', () => {
  it('revalidates the current audience and mints a new download grant on every open', async () => {
    const f = fixture()
    const save = vi.fn(async () => {})

    await openMatrixCompanyBoardAttachment(file, f.ports, save, AbortSignal.timeout(2000))
    await openMatrixCompanyBoardAttachment(file, f.ports, save, AbortSignal.timeout(2000))

    expect(f.platform).toHaveBeenCalledTimes(2)
    expect(f.platform).toHaveBeenNthCalledWith(1, {
      action: 'download',
      companyId: file.company_id,
      channelId: file.audience.channel_id,
      fileId: file.file_id,
      revision: 1
    }, expect.any(AbortSignal))
    expect(f.download).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenNthCalledWith(1, { name: file.name, bytes: new Uint8Array([1, 2, 3]) })
  })

  it('never reaches the save boundary after the authority route revokes the file', async () => {
    const f = fixture()
    const save = vi.fn(async () => {})
    f.platform.mockRejectedValueOnce(new MatrixCompanyFileError('denied', undefined, 'revoked'))

    await expect(
      openMatrixCompanyBoardAttachment(file, f.ports, save, AbortSignal.timeout(2000))
    ).rejects.toThrow('matrix_company_file_denied')
    expect(f.download).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })
})
