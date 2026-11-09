import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { matrixCompanyFileContent } from '../../shared/matrix-company-files'

import { parseMatrixCompanyFileRequestV2 } from './company-files-v2'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts/atum-company-drive-files-v1.2')
const read = (file: string) => readFileSync(resolve(root, file))
const json = <T = unknown>(file: string): T => JSON.parse(read(file).toString('utf8')) as T

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

describe('vendored company Drive file 1.2 contract', () => {
  const contract = json<{ contract_id: string; version: string; pack_files: string[] }>('contract.json')
  const vendored = json<{ contract: string; repository: string; commit: string; path: string; sha256: string }>('VENDORED.json')

  it('pins the exact immutable audience-scoped platform pack', () => {
    expect(contract).toMatchObject({ contract_id: 'atum.company-drive-files', version: '1.2' })
    expect(vendored).toEqual({
      publicationStatus: 'sanitised public pack; historical acceptance not applicable',
      contract: 'atum.company-drive-files/1.2',
      repository: 'https://github.com/atum-platform/atum-platform.git',
      commit: '28becd378eae5255e5940295038f0489a1f60ffe',
      path: 'spec/company-drive-files/v1.2',
      sha256: 'ea95890d6cc735954b7ee67f61a51bb8646b14554955fc6703409ac3c6ebb779'
    })
    expect(read('PINNED-SHA256').toString('utf8').trim()).toBe(vendored.sha256)
    expect(digest(contract.pack_files)).toBe(vendored.sha256)
  })

  it('accepts exact private-channel/conversation references and rejects any mxc fallback', () => {
    const channel = json<Record<string, unknown>>('fixtures/matrix-file-channel.content.json')
    const conversation = json<Record<string, unknown>>('fixtures/matrix-file-conversation.content.json')
    expect(matrixCompanyFileContent(channel)).toMatchObject({
      v: 2, audience: { kind: 'channel', visibility: 'private' }
    })
    expect(matrixCompanyFileContent(conversation)).toMatchObject({
      v: 2, audience: { kind: 'conversation' }
    })
    expect(matrixCompanyFileContent(json('fixtures/matrix-file-mxc.content.json'))).toBeNull()
  })

  it('parses the frozen private-channel and conversation reserve requests', () => {
    for (const file of ['reserve-private-channel.request.json', 'reserve-conversation.request.json']) {
      expect(parseMatrixCompanyFileRequestV2({ action: 'reserve-v2', ...json<Record<string, unknown>>(`fixtures/${file}`) }))
        .toMatchObject({ action: 'reserve-v2' })
    }
  })
})
