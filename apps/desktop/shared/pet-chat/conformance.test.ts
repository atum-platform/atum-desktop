import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  parseAtumPetChatError,
  parseAtumPetChatHistory,
  parseAtumPetChatHistoryRequest,
  parseAtumPetChatReply,
  parseAtumPetChatRequest
} from './atum-pet-chat'

interface FixtureEntry {
  file: string
  message: string
  expect: 'accept' | 'reject'
}

interface ContractPack {
  pack_files: string[]
  fixtures: FixtureEntry[]
}

interface Vendor {
  path: string
  sha256: string
}

const root = new URL('./', import.meta.url)
const load = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, root), 'utf8'))
const vendor = load<{ packs: Vendor[] }>('VENDORED.json').packs[0]!
const pack = load<ContractPack>(`${vendor.path}/contract.json`)

function packDigest(path: string, files: string[]): string {
  const hash = createHash('sha256')

  for (const file of files) {
    const name = Buffer.from(file, 'utf8')
    const body = readFileSync(new URL(`${path}/${file}`, root))
    const nameSize = Buffer.alloc(4)
    nameSize.writeUInt32BE(name.length)
    const bodySize = Buffer.alloc(8)
    bodySize.writeBigUInt64BE(BigInt(body.length))
    hash.update(nameSize).update(name).update(bodySize).update(body)
  }

  return hash.digest('hex')
}

it('pins every declared provider byte at the frozen source', () => {
  expect(packDigest(vendor.path, pack.pack_files)).toBe(vendor.sha256)
  expect(readFileSync(new URL(`${vendor.path}/PINNED-SHA256`, root), 'utf8').trim()).toBe(vendor.sha256)
})

const parsers: Record<string, (value: unknown) => unknown> = {
  'pet.chat.request': parseAtumPetChatRequest,
  'pet.chat.reply': parseAtumPetChatReply,
  'pet.history.request': parseAtumPetChatHistoryRequest,
  'pet.history.reply': parseAtumPetChatHistory,
  'pet.error': parseAtumPetChatError
}

describe('provider fixture conformance', () => {
  for (const fixture of pack.fixtures) {
    it(`${fixture.expect}: ${fixture.file}`, () => {
      const parse = parsers[fixture.message]!
      const value = load<unknown>(`${vendor.path}/${fixture.file}`)

      if (fixture.expect === 'accept') {
        expect(() => parse(value)).not.toThrow()
      } else {
        expect(() => parse(value)).toThrow()
      }
    })
  }
})
