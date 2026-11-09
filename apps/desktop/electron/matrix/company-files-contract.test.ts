import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { matrixCompanyFileContent } from '../../shared/matrix-company-files'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts/atum-company-drive-files-v1.1')
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

describe('vendored company Drive file contract', () => {
  const contract = json<{ contract_id: string; version: string; pack_files: string[] }>('contract.json')
  const vendored = json<{ contract: string; repository: string; commit: string; path: string; sha256: string }>(
    'VENDORED.json'
  )
  const expected = {
    companyId: '00000000-0000-4000-8000-8c031eadb7f3',
    target: { kind: 'channel' as const, channelId: '00000000-0000-4000-8000-01670d853f95' }
  }

  it('pins the exact immutable platform pack', () => {
    expect(contract).toMatchObject({ contract_id: 'atum.company-drive-files', version: '1.1' })
    expect(vendored).toEqual({
      publicationStatus: 'sanitised public pack; historical acceptance not applicable',
      contract: 'atum.company-drive-files/1.1',
      repository: 'https://github.com/atum-platform/atum-platform.git',
      commit: 'b7e36a27c1481a265984b312facd059e182bcaa4',
      path: 'spec/company-drive-files/v1.1',
      sha256: '3a456a31c87a6cd8e096cec8ef70f7685a8a975b755e9bf23d26386a6531c128'
    })
    expect(read('PINNED-SHA256').toString('utf8').trim()).toBe(vendored.sha256)
    expect(digest(contract.pack_files)).toBe(vendored.sha256)
  })

  it('accepts the channel and flat-thread references and rejects protected mxc', () => {
    expect(matrixCompanyFileContent(json('fixtures/matrix-file-channel.content.json'), expected)).toMatchObject({
      company_id: expected.companyId,
      channel_id: expected.target.channelId,
      revision: 1
    })
    expect(matrixCompanyFileContent(json('fixtures/matrix-file-thread.content.json'), expected)).toMatchObject({
      company_id: expected.companyId,
      channel_id: expected.target.channelId,
      revision: 1
    })
    expect(matrixCompanyFileContent(json('fixtures/matrix-file-mxc.content.json'), expected)).toBeNull()
  })
})
