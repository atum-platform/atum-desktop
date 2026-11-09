import assert from 'node:assert/strict'

import { expect, test } from 'vitest'

import {
  appViewPartition,
  type DirectoryEntry,
  discoverAppViewPartitions,
  forEachBounded,
  legacyAppPartition,
  parseAppViewPartition
} from './partitions'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)

function dir(name: string, extra: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return { name, isDirectory: true, isSymbolicLink: false, ...extra }
}

test('partition names are deterministic, account-keyed, and never carry an Atum id', () => {
  expect(appViewPartition(KEY_A, 'moon')).toBe(`persist:atum-app-${KEY_A}-moon`)
  expect(legacyAppPartition('moon')).toBe('persist:atum-app-moon')
  assert.throws(() => appViewPartition('00000000-0000-4000-8000-303617b97302', 'moon'), /invalid_account_key/)
  assert.throws(() => appViewPartition(KEY_A, 'Moon'), /invalid_app_id/)
  assert.throws(() => appViewPartition(KEY_A, '../x'), /invalid_app_id/)
})

test('both grammars parse and nothing else is ever claimed', () => {
  expect(parseAppViewPartition(`persist:atum-app-${KEY_A}-moon`)).toEqual({ partition: `persist:atum-app-${KEY_A}-moon`, accountKey: KEY_A, app: 'moon' })
  expect(parseAppViewPartition('persist:atum-app-moon')).toEqual({ partition: 'persist:atum-app-moon', accountKey: null, app: 'moon' })
  expect(parseAppViewPartition('persist:atum-app-')).toBeNull()
  expect(parseAppViewPartition('atum-app-moon')).toBeNull()
  expect(parseAppViewPartition('persist:atum-consumer-browser-x')).toBeNull()
  expect(parseAppViewPartition('persist:hermes-preview')).toBeNull()
  expect(parseAppViewPartition(`persist:atum-app-${KEY_A.slice(1)}-moon`)).toBeNull()
  expect(parseAppViewPartition(`persist:atum-app-${KEY_A}-Moon`)).toBeNull()
})

test('discovery derives every partition an account root can produce and every one Chromium persisted', async () => {
  const reads: string[] = []

  const partitions = await discoverAppViewPartitions({
    userDataPath: '/ud',
    knownAppIds: ['moon', 'andy', 'Bad Id'],
    livePartitions: [`persist:atum-app-${KEY_B}-moon`, 'persist:hermes-preview'],
    readDirectory: async path => {
      reads.push(path)

      if (path === '/ud/accounts') {
        return [dir(KEY_A), dir('not-a-key'), dir(KEY_B, { isSymbolicLink: true }), dir('file.txt', { isDirectory: false })]
      }

      if (path === '/ud/Partitions') {
        return [
          dir(`atum-app-${KEY_B}-taylor`),
          dir('atum-app-moon'),
          dir('atum-consumer-browser-x'),
          dir(`atum-app-${KEY_A}-moon`, { isSymbolicLink: true }),
          dir('atum-app-..'),
          dir('atum-app-' + 'c'.repeat(64) + '-moon', { isDirectory: false })
        ]
      }

      return null
    }
  })

  expect(reads).toEqual(['/ud/accounts', '/ud/Partitions'])
  expect(partitions).toEqual([
    `persist:atum-app-${KEY_A}-andy`,
    `persist:atum-app-${KEY_A}-moon`,
    `persist:atum-app-${KEY_B}-moon`,
    `persist:atum-app-${KEY_B}-taylor`,
    'persist:atum-app-andy',
    'persist:atum-app-moon'
  ].sort())
})

test('a missing directory is the empty set; an unreadable one is a failure', async () => {
  const empty = await discoverAppViewPartitions({ userDataPath: '/ud', knownAppIds: ['moon'], readDirectory: async () => null })
  expect(empty).toEqual(['persist:atum-app-moon'])
  await assert.rejects(discoverAppViewPartitions({
    userDataPath: '/ud',
    knownAppIds: ['moon'],
    readDirectory: async path => {
      if (path === '/ud/Partitions') {throw new Error('EACCES')}

      return null
    }
  }), /EACCES/)
})

test('bounded iteration never exceeds its limit and reports the first failure after the rest settle', async () => {
  let inFlight = 0
  let peak = 0
  const seen: number[] = []
  await assert.rejects(forEachBounded([1, 2, 3, 4, 5, 6], 2, async item => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise(resolve => setTimeout(resolve, 2))
    seen.push(item)
    inFlight -= 1

    if (item === 3) {throw new Error('boom')}
  }), /boom/)
  expect(peak).toBe(2)
  expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6])
  await forEachBounded([], 4, async () => undefined)
})
