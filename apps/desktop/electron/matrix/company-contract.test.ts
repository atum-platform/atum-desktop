import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { parseMatrixCompanyRequest, parseMatrixCompanyResponse } from './company'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts/atum-company-channels-v1')
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

describe('vendored company channel contract', () => {
  const contract = json<{pack_files: string[]}>('contract.json')
  const vendored = json<{sha256: string; commit: string}>('VENDORED.json')

  it('pins the exact reviewed platform pack', () => {
    expect(vendored.commit).toBe('874f15925714dda05a6e4852132c31f1acc8a664')
    expect(read('PINNED-SHA256').toString('utf8').trim()).toBe(vendored.sha256)
    expect(digest(contract.pack_files)).toBe(vendored.sha256)
  })

  it('accepts the provider fixtures the desktop consumes', () => {
    const companyId = '00000000-0000-4000-8000-8c031eadb7f3'
    const channelId = '00000000-0000-4000-8000-01670d853f95'
    const create = json<Record<string, unknown>>('fixtures/channel-create.request.json')
    expect(parseMatrixCompanyRequest({ action: 'create-channel', companyId, ...create })).toEqual({
      action: 'create-channel', companyId, ...create
    })
    expect(parseMatrixCompanyResponse(json('fixtures/channel.directory.json'),
      { action: 'list-channels', companyId })).toEqual(json('fixtures/channel.directory.json'))
    expect(parseMatrixCompanyResponse(json('fixtures/channel.snapshot.json'),
      { action: 'read-channel', companyId, channelId })).toEqual(json('fixtures/channel.snapshot.json'))
  })

  it('refuses the contract fixtures that carry client authority or impossible readiness', () => {
    const companyId = '00000000-0000-4000-8000-8c031eadb7f3'
    const channelId = '00000000-0000-4000-8000-01670d853f95'
    expect(() => parseMatrixCompanyRequest({ action: 'create-channel', companyId,
      ...json<Record<string, unknown>>('fixtures/channel-create-client-authority.request.json') })).toThrow('invalid')
    expect(() => parseMatrixCompanyResponse(json('fixtures/channel-room.ready-null.json'),
      { action: 'read-channel', companyId, channelId })).toThrow('invalid')
  })

  it('keeps T1 ready, archived, failed, and roster invariants on the native parser path', () => {
    const companyId = '00000000-0000-4000-8000-8c031eadb7f3'
    const channelId = '00000000-0000-4000-8000-01670d853f95'
    const base = json<Record<string, unknown>>('fixtures/channel.snapshot.json')
    const ready = { ...base, channel: { ...(base.channel as object), state: 'active' },
      memberPrincipals: ['00000000-0000-4000-8000-6b8e755910f9'],
      room: { state: 'ready', roomId: '!launch:atum.example' } }

    expect(parseMatrixCompanyResponse(ready, { action: 'read-channel', companyId, channelId })).toEqual(ready)
    expect(parseMatrixCompanyResponse({ ...ready, channel: { ...(ready.channel as object), state: 'archived' } },
      { action: 'read-channel', companyId, channelId })).toMatchObject({
      channel: { state: 'archived' }, room: { state: 'ready', roomId: '!launch:atum.example' }
    })
    expect(parseMatrixCompanyResponse({ ...ready, room: { state: 'failed', roomId: null } },
      { action: 'read-channel', companyId, channelId })).toMatchObject({ room: { state: 'failed', roomId: null } })
    expect(() => parseMatrixCompanyResponse({ ...ready, memberPrincipals: [] },
      { action: 'read-channel', companyId, channelId })).toThrow('invalid')
  })
})
