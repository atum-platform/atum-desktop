import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type {
  BudgetFacts,
  ChainEvent,
  ChainFacts,
  ContextEvent,
  EffectiveModeFacts,
  FloorFacts,
  FreshnessFacts,
  GroupTriggerFacts,
  RoomContextInput,
  SessionProfileFlags
} from './types'

import {
  classifyGroupTrigger,
  effectiveMode,
  isGroupFresh,
  parseRoomPolicy,
  parseRoomUsage,
  planFloor,
  projectRecentContext,
  roomBudget,
  roomSessionProfile,
  verifyChain
} from './index'

interface FixtureEntry {
  file: string
  message: string
  expect: 'accept' | 'reject'
}
interface Pack {
  contract_id: string
  version: number
  pack_files: string[]
  fixtures: FixtureEntry[]
}
interface Vendor {
  path: string
  sha256: string
  source: string
}
const root = new URL('./', import.meta.url)
const load = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, root), 'utf8'))
const vendors = load<{ packs: Vendor[] }>('VENDORED.json').packs

for (const vendor of vendors) {
  const pack = load<Pack>(`${vendor.path}/contract.json`)
  describe(pack.contract_id, () => {
    it('vendors every declared byte at the provider pin', () => {
      const hash = createHash('sha256')

      for (const path of pack.pack_files) {
        const name = Buffer.from(path, 'utf8')
        const body = readFileSync(new URL(`${vendor.path}/${path}`, root))
        const nameSize = Buffer.alloc(4)
        nameSize.writeUInt32BE(name.length)
        const bodySize = Buffer.alloc(8)
        bodySize.writeBigUInt64BE(BigInt(body.length))
        hash.update(nameSize).update(name).update(bodySize).update(body)
      }

      expect(hash.digest('hex')).toBe(vendor.sha256)
      expect(readFileSync(new URL(`${vendor.path}/PINNED-SHA256`, root), 'utf8').trim()).toBe(vendor.sha256)
    })

    for (const fixture of pack.fixtures) {
      const path = `${vendor.path}/${fixture.file}`

      if (fixture.expect === 'accept' && fixture.message.endsWith('.scenario')) {
        it(fixture.file, async () => {
          const sample = load<{ facts: unknown; expected: unknown }>(path)
          let actual: unknown

          switch (fixture.message) {
            case 'trigger.scenario':
              actual = classifyGroupTrigger(sample.facts as GroupTriggerFacts)

              break

            case 'floor.scenario':
              actual = await planFloor(sample.facts as FloorFacts)

              break

            case 'effective.scenario':
              actual = effectiveMode(sample.facts as EffectiveModeFacts)

              break

            case 'budget.scenario':
              actual = roomBudget(sample.facts as BudgetFacts)

              break

            case 'freshness.scenario':
              actual = isGroupFresh(sample.facts as FreshnessFacts)

              break

            case 'profile.scenario':
              actual = roomSessionProfile(sample.facts as SessionProfileFlags)

              break
            case 'chain.scenario': {
              const facts = sample.facts as ChainFacts & { events: ChainEvent[] }
              actual = await verifyChain(facts, {
                readOwnerEvent: async (_roomId, eventId) =>
                  facts.events.find(event => event.eventId === eventId) ?? null
              })

              break
            }

            case 'context.scenario': {
              const input = load<{
                input: RoomContextInput
                roomMode: 'meeting' | 'shared' | 'private'
                events: ContextEvent[]
              }>(path)

              actual = projectRecentContext(input.input, input.roomMode, input.events)

              break
            }

            default:
              throw new Error(`Unexecuted consumer scenario: ${fixture.message}`)
          }

          expect(actual).toEqual(sample.expected)
        })
      }

      if (fixture.message === 'policy' || fixture.message === 'agent.entry' || fixture.message === 'usage') {
        it(`parses ${fixture.file} with the declared outcome`, () => {
          const value = load<unknown>(path)

          const parsed =
            fixture.message === 'usage'
              ? parseRoomUsage(value)
              : parseRoomPolicy(
                  fixture.message === 'agent.entry'
                    ? { v: 1, agents: { '@assistant-a:example.invalid': value } }
                    : value
                )

          expect(parsed.ok).toBe(fixture.expect === 'accept')

          if (parsed.ok && fixture.message !== 'agent.entry') {
            expect(parsed.value).toEqual(value)
          }
        })
      }
    }
  })
}
