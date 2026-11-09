import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { EncryptedStore } from '../encrypted-store'

import { PendingMatrixDrafts } from './draft-pending'

const temporary: string[] = []
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value).reverse(),
  decryptString: (value: Buffer) => Buffer.from(value).reverse().toString()
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

describe('durable pending Matrix drafts', () => {
  it('survives an offline write and restart, then flushes without another edit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atum-drafts-'))
    temporary.push(directory)
    const file = join(directory, 'drafts.json')
    const command = {
      kind: 'draft' as const,
      identity: { userId: '@owner:test', deviceId: 'MAC' },
      roomId: '!launch:test',
      text: 'Keep the launch notes'
    }
    const offline = new PendingMatrixDrafts(new EncryptedStore(file, safeStorage))

    await expect(offline.submit(command, async () => {throw new Error('matrix_sdk_unavailable')})).resolves.toEqual({
      status: 'pending'
    })
    expect(readFileSync(file, 'utf8')).not.toContain(command.text)

    const deliver = vi.fn(async () => null)
    const restarted = new PendingMatrixDrafts(new EncryptedStore(file, safeStorage))
    await restarted.drain(command.identity, deliver)

    expect(deliver).toHaveBeenCalledExactlyOnceWith(command)
    expect(new EncryptedStore(file, safeStorage).keys('draft:')).toEqual([])
  })
})
