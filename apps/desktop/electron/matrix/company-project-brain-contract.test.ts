import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { parseMatrixCompanyRequest, parseMatrixCompanyResponse } from './company'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts/atum-company-project-brain-v1')
const read = (file: string) => readFileSync(resolve(root, file))
const json = <T = unknown>(file: string): T => JSON.parse(read(file).toString('utf8')) as T
const companyId = '00000000-0000-4000-8000-fdbcc0bff542'
const projectId = '00000000-0000-4000-8000-d98016d67fb8'

function digest(files: string[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    const name = Buffer.from(file, 'utf8')
    const body = read(file)
    const nameLength = Buffer.alloc(4)
    const bodyLength = Buffer.alloc(8)
    nameLength.writeUInt32BE(name.length)
    bodyLength.writeBigUInt64BE(BigInt(body.length))
    hash.update(nameLength).update(name).update(bodyLength).update(body)
  }

  return hash.digest('hex')
}

describe('vendored company project brain contract', () => {
  const contract = json<{ pack_files: string[] }>('contract.json')
  const vendored = json<{ sha256: string; commit: string }>('VENDORED.json')

  it('pins the exact reviewed platform pack', () => {
    expect(vendored.commit).toBe('de584acd353e5302a59f5f4b753e76e2427f044a')
    expect(read('PINNED-SHA256').toString('utf8').trim()).toBe(vendored.sha256)
    expect(digest(contract.pack_files)).toBe(vendored.sha256)
  })

  it('accepts every provider request and response fixture the desktop consumes', () => {
    const channel = json<Record<string, unknown>>('fixtures/include-channel.request.json')
    const file = json<Record<string, unknown>>('fixtures/include-file.request.json')
    const withdraw = json<Record<string, unknown>>('fixtures/withdraw.request.json')
    const { operation: _channelOperation, ...channelFields } = channel
    const { operation: _fileOperation, ...fileFields } = file
    const { operation: _withdrawOperation, ...withdrawFields } = withdraw

    expect(parseMatrixCompanyRequest({ action: 'include-project-channel-source', companyId, projectId,
      ...channelFields })).toMatchObject({ action: 'include-project-channel-source', companyId, projectId })
    expect(parseMatrixCompanyRequest({ action: 'include-project-file-source', companyId, projectId,
      ...fileFields })).toMatchObject({ action: 'include-project-file-source', companyId, projectId })
    expect(parseMatrixCompanyRequest({ action: 'withdraw-project-source', companyId, projectId,
      ...withdrawFields })).toMatchObject({ action: 'withdraw-project-source', companyId, projectId })
    expect(parseMatrixCompanyResponse(json('fixtures/source-document-empty.response.json'),
      { action: 'project-sources', companyId, projectId })).toEqual(json('fixtures/source-document-empty.response.json'))
    expect(parseMatrixCompanyResponse(json('fixtures/source-document-pending.response.json'),
      { action: 'project-sources', companyId, projectId })).toEqual(json('fixtures/source-document-pending.response.json'))
  })

  it('refuses client authority and impossible source variants from the frozen pack', () => {
    const authority = json<Record<string, unknown>>('fixtures/include-channel-client-authority.request.json')
    const { operation: _operation, ...fields } = authority

    expect(() => parseMatrixCompanyRequest({ action: 'include-project-channel-source', companyId, projectId,
      ...fields })).toThrow('invalid')
    expect(() => parseMatrixCompanyResponse(json('fixtures/source-document-kind-mismatch.response.json'),
      { action: 'project-sources', companyId, projectId })).toThrow('invalid')
  })
})
