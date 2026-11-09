import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { ConversationWrite, MigrationInput } from './types'

import {
  buildConversationMarker,
  CONVERSATION_MARKER_FLOOR,
  CONVERSATION_PLAIN_FLOOR,
  conversationAppVersionType,
  conversationFleetReady,
  conversationSweepCandidates,
  decideConversationTurn,
  parseConversationAppVersion,
  parseConversationMarker,
  planConversationMigration,
  rankConversationCandidates,
  resolveConversationRoom,
  rollbackConversationWrites,
  shouldPostEarlierNotice
} from './index'

interface FixtureEntry {
  file: string
  message?: string
  machine?: string
  expect: 'accept' | 'reject'
}

const root = new URL('./', import.meta.url)
const load = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, root), 'utf8'))
const packs = load<{ packs: { path: string; sha256: string }[] }>('VENDORED.json').packs
const vendor = packs[0]
const pack = load<{ pack_files: string[]; fixtures: FixtureEntry[] }>(`${vendor.path}/contract.json`)

/** The framed pin over a pack's declared files (spec/_tools contract_pack). */
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

it('pins every declared provider byte, including evidence and scenarios', () => {
  expect(packDigest(vendor.path, pack.pack_files)).toBe(vendor.sha256)
  expect(readFileSync(new URL(`${vendor.path}/PINNED-SHA256`, root), 'utf8').trim()).toBe(vendor.sha256)
})

it('pins every vendored amendment, and each amendment pins this base', () => {
  for (const amendment of packs.slice(1)) {
    const contract = load<{ pack_files: string[]; base: { sha256: string } }>(`${amendment.path}/contract.json`)
    expect(packDigest(amendment.path, contract.pack_files)).toBe(amendment.sha256)
    expect(readFileSync(new URL(`${amendment.path}/PINNED-SHA256`, root), 'utf8').trim()).toBe(amendment.sha256)
    expect(contract.base.sha256).toBe(vendor.sha256)
  }
})

function migrationScenario(input: MigrationInput & { failAt?: number }): unknown {
  const planned = planConversationMigration(input, 100)

  if (planned.status === 'blocked') {
    return planned
  }

  let writes = planned.writes
  let status = 'ready'

  if (input.failAt !== undefined) {
    const succeeded = writes.slice(0, input.failAt)
    writes = [...succeeded, ...rollbackConversationWrites(succeeded)]
    status = 'rolled_back'
  }

  return {
    status,
    writes: writes.map(write => ({
      roomId: write.roomId,
      role: 'role' in write.content ? write.content.role : 'unmarked'
    }))
  }
}

describe('pure policy scenarios from the candidate pack', () => {
  for (const fixture of pack.fixtures.filter(item => item.message?.endsWith('.scenario'))) {
    it(fixture.file, () => {
      // Each message dispatches to a real pure function. No scenario is silently skipped.
      const sample = load<{ input: never; expected: unknown }>(`${vendor.path}/${fixture.file}`)
      let actual: unknown

      switch (fixture.message) {
        case 'parse.scenario':
          actual = parseConversationMarker(sample.input)

          break
        case 'resolve.scenario': {
          const input = sample.input as {
            rooms: Parameters<typeof resolveConversationRoom>[0]
            previous?: Parameters<typeof resolveConversationRoom>[1]
          }

          try {
            actual = resolveConversationRoom(input.rooms, input.previous)
          } catch (error) {
            actual = { code: (error as { code: string }).code }
          }

          break
        }

        case 'rank.scenario': {
          const input = sample.input as { candidates: Parameters<typeof rankConversationCandidates>[0]; now: number }
          actual = rankConversationCandidates(input.candidates, input.now)

          break
        }

        case 'admit.scenario':
          actual = decideConversationTurn(sample.input)

          break
        case 'sweep.scenario': {
          const input = sample.input as { resolution: Parameters<typeof conversationSweepCandidates>[0]; at: number }
          actual = conversationSweepCandidates(input.resolution, input.at)

          break
        }

        case 'notice.scenario':
          actual = { post: shouldPostEarlierNotice(sample.input), modelCalls: 0, claims: 0, holds: 0 }

          break

        case 'migration.scenario':
          actual = migrationScenario(sample.input)

          break

        default:
          throw new Error(`Unexecuted pure consumer scenario: ${fixture.message}`)
      }

      expect(actual).toEqual(sample.expected)
    })
  }
})

it('produces the known-field main and earlier marker fixtures', () => {
  for (const name of ['marker-main', 'marker-earlier', 'marker-future-keys']) {
    const { roomId, content } = load<{ roomId: string; content: Parameters<typeof buildConversationMarker>[0] }>(
      `${vendor.path}/fixtures/${name}.json`
    )

    expect(buildConversationMarker({ ...content, roomId })).toEqual({
      v: 1,
      role: content.role,
      main: content.main,
      at: content.at
    })
  }
})

it('refuses malformed known marker fields instead of constructing state', () => {
  const categories = ['wrong-version', 'negative-time', 'missing-main', 'invalid-role', 'main-other-room']

  for (const name of categories) {
    const { roomId, content } = load<{ roomId: string; content: Record<string, unknown> }>(
      `${vendor.path}/fixtures/marker-reject-${name}.json`
    )

    expect(
      parseConversationMarker({
        roomId,
        ownerId: 'owner',
        event: { type: 'io.atum.conversation', state_key: '', sender: 'owner', content }
      })
    ).toBeNull()
  }
})

it('keeps unknown fields and private content out of constructed state', () => {
  for (const name of ['content-text', 'nested-secret']) {
    const { roomId, content } = load<{ roomId: string; content: Parameters<typeof buildConversationMarker>[0] }>(
      `${vendor.path}/fixtures/marker-reject-${name}.json`
    )

    expect(buildConversationMarker({ ...content, roomId })).toEqual({
      v: 1,
      role: content.role,
      main: content.main,
      at: content.at
    })
  }
})

it('uses per-Mac version records and a numeric 0.19.0 readiness floor', () => {
  for (const name of ['version-mac-a', 'version-mac-b']) {
    const { type, content } = load<{ type: string; content: unknown }>(`${vendor.path}/fixtures/${name}.json`)
    expect(conversationAppVersionType(type.slice('io.atum.app_version.'.length))).toBe(type)
    expect(parseConversationAppVersion(content)).toEqual(content)
  }

  const report = (version: string) => ({ v: 1, version, at: 100 })
  expect(conversationFleetReady([report('0.19.0'), report('0.20.0')])).toBe(true)
  expect(conversationFleetReady([report('0.19.0'), report('0.18.5')])).toBe(false)
  expect(conversationFleetReady([report('0.19.0'), report('0.9.9')])).toBe(false)
  expect(conversationFleetReady([report('0.19.0'), null])).toBe(false)
  expect(conversationFleetReady([report('0.19.0-beta')])).toBe(false)
  expect(() => conversationAppVersionType('')).toThrow('matrix_invalid_conversation_device')
})

// atum.agent-conversation/1.1 A1: replacing an encrypted main with a plain room needs every
// Mac on 0.20.0; every other marker write keeps the 0.19.0 floor.
it('holds the plain replacement at the 0.20.0 floor and leaves marker writes at 0.19.0', () => {
  const report = (version: string) => ({ v: 1, version, at: 100 })
  expect(conversationFleetReady([report('0.19.3'), report('0.20.0')])).toBe(true)
  expect(conversationFleetReady([report('0.19.3'), report('0.20.0')], CONVERSATION_PLAIN_FLOOR)).toBe(false)
  expect(conversationFleetReady([report('0.20.0'), report('0.20.1'), report('1.0.0')], CONVERSATION_PLAIN_FLOOR)).toBe(
    true
  )
  expect(conversationFleetReady([report('0.20.0'), null], CONVERSATION_PLAIN_FLOOR)).toBe(false)
  expect(conversationFleetReady([report('0.19.0')], CONVERSATION_MARKER_FLOOR)).toBe(true)
})

it('preserves input arrays and previous resolution on retry', () => {
  const previous = {
    main: '!a:proof.test',
    earlier: ['!b:proof.test'],
    stray: [],
    unreachable: [],
    source: 'marked' as const
  }

  const actual = resolveConversationRoom([{ roomId: '!a:proof.test', read: 'transient' }], previous)
  actual.earlier.push('!c:proof.test')
  expect(previous.earlier).toEqual(['!b:proof.test'])

  const written: ConversationWrite[] = [
    { roomId: '!a:proof.test', content: { v: 1, role: 'main', main: '!a:proof.test', at: 100 } }
  ]

  expect(rollbackConversationWrites(written)).toEqual([{ roomId: '!a:proof.test', content: {} }])
  expect(written[0].content).toHaveProperty('role', 'main')
})
