import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { parseMatrixCompanyRequest, parseMatrixCompanyResponse } from './company'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts/atum-company-project-brain-v2')
const read = (file: string) => readFileSync(resolve(root, file))
const json = <T = unknown>(file: string): T => JSON.parse(read(file).toString('utf8')) as T
const companyId = '00000000-0000-4000-8000-435c1d9ce575'
const projectId = '00000000-0000-4000-8000-e860663e054f'
const request = { action: 'project-reader' as const, companyId, projectId }

function digest(files: string[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    const name = Buffer.from(file, 'utf8'), body = read(file), nameLength = Buffer.alloc(4), bodyLength = Buffer.alloc(8)
    nameLength.writeUInt32BE(name.length); bodyLength.writeBigUInt64BE(BigInt(body.length))
    hash.update(nameLength).update(name).update(bodyLength).update(body)
  }
  return hash.digest('hex')
}

describe('vendored company project reader native contract', () => {
  const contract = json<{pack_files: string[]}>('contract.json')
  const vendored = json<{sha256: string; commit: string}>('VENDORED.json')

  it('pins the exact reviewed platform pack', () => {
    expect(vendored.commit).toBe('a4cebd1128ede7f007aade7d3a9768a47fdabac5')
    expect(read('PINNED-SHA256').toString('utf8').trim()).toBe(vendored.sha256)
    expect(digest(contract.pack_files)).toBe(vendored.sha256)
  })

  it('accepts only the fixed company/project reader action and all safe coverage states', () => {
    expect(parseMatrixCompanyRequest(request)).toEqual(request)
    for (const fixture of ['reader-status-pending.response.json', 'reader-status-live.response.json']) {
      expect(parseMatrixCompanyResponse(json(`fixtures/${fixture}`), request)).toEqual(json(`fixtures/${fixture}`))
    }
    expect(() => parseMatrixCompanyRequest({ ...request, actor: 'forbidden' })).toThrow('invalid')
  })

  it('rejects live coverage without its receipt-derived watermark', () => {
    expect(() => parseMatrixCompanyResponse(json('fixtures/reader-status-invalid-live.response.json'), request))
      .toThrow('invalid')
  })
})
