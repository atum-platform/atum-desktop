import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

import { AwarenessReader } from './reader'
import type { AwarenessEnvelope, AwarenessRevision, AwarenessTransport } from './types'

// Selected schemas/vectors are test inputs from the immutable central pack.
// This small test-only matcher is not shipped as a schema/authority framework.
const pack = JSON.parse(readFileSync(new URL('./fixtures/contract-inputs.json', import.meta.url), 'utf8'))

function matches(schema: any, value: any): boolean {
  if (schema.ref) {
    return matches(pack.types[schema.ref], value)
  }

  if (schema.anyOf) {
    return schema.anyOf.some((item: any) => matches(item, value))
  }

  if ('const' in schema) {
    return JSON.stringify(value) === JSON.stringify(schema.const)
  }

  if (schema.enum) {
    return schema.enum.includes(value)
  }

  if (schema.type === 'string') {
    return (
      typeof value === 'string' &&
      (schema.min === undefined || Array.from(value).length >= schema.min) &&
      (schema.max === undefined || Array.from(value).length <= schema.max) &&
      (!schema.pattern || new RegExp(`^(?:${schema.pattern})$`, 'u').test(value))
    )
  }

  if (schema.type === 'integer') {
    return Number.isSafeInteger(value) && value >= schema.min && value <= (schema.max ?? Number.MAX_SAFE_INTEGER)
  }

  if (schema.type === 'boolean') {
    return typeof value === 'boolean'
  }

  if (schema.type === 'array') {
    return (
      Array.isArray(value) &&
      value.length >= schema.min &&
      value.length <= schema.max &&
      (!schema.unique || new Set(value.map(item => JSON.stringify(item))).size === value.length) &&
      value.every(item => matches(schema.items, item))
    )
  }

  if (schema.type === 'object') {
    return (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.entries(schema.required ?? {}).every(
        ([key, entry]) => Object.hasOwn(value, key) && matches(entry, value[key])
      ) &&
      Object.entries(schema.optional ?? {}).every(
        ([key, entry]) => !Object.hasOwn(value, key) || matches(entry, value[key])
      ) &&
      (schema.additional ||
        Object.keys(value).every(
          key => Object.hasOwn(schema.required ?? {}, key) || Object.hasOwn(schema.optional ?? {}, key)
        ))
    )
  }

  return false
}

it('every exported reader wire value conforms to the exact selected central message schema', async () => {
  const checked: string[] = []

  const check = (name: string, value: unknown) => {
    expect(matches(pack.messages[name].schema, value), name).toBe(true)
    checked.push(name)
  }

  const fixture = pack.vectors['envelope-human-group-message.managed.json'] as AwarenessEnvelope

  const transport: AwarenessTransport = {
    async prepare() {},
    async ingest(envelope) {
      check('envelope.managed', envelope)
      const { replaces: _replaces, ...object } = envelope.object

      const value = {
        operationId: envelope.operationId,
        source: envelope.source,
        object,
        state: 'duplicate',
        acceptedRevision: object.revision
      }

      check('ingestion.receipt', value)

      return value
    },
    async withdraw(request) {
      check('withdrawal', request)

      const value = {
        withdrawalId: request.withdrawalId,
        state: 'recorded',
        recordedAt: 100,
        purgeBy: 200,
        suppressionIds: ['00000000-0000-4000-8000-d63d65f98f72']
      }

      check('withdrawal.receipt', value)

      return value
    },
    async fence(notice) {
      check('fence.notice', notice)
      const value = { active: true, since: notice.since }
      check('fence.ack', value)

      return value
    },
    async coverage(report) {
      check('coverage.report', report)
    }
  }

  const reader = await AwarenessReader.open({
    create: true,
    binding: 'account/device',
    destination: 'managed',
    store: {
      async read() {
        return null
      },
      async write() {}
    },
    transport,
    live: () => true,
    now: () => 100,
    readAccess: () => ({ active: true, keysAvailable: true, visibility: 'shared', readable: () => true })
  })

  await reader.register(fixture.source)

  const revision: AwarenessRevision = {
    source: fixture.source,
    object: fixture.object,
    author: fixture.author,
    eventTime: fixture.eventTime,
    content: fixture.content
  }

  await reader.ingest({ source: fixture.source, revisions: [revision], after: null, through: 100, complete: false })
  await reader.observeFence({ v: 1, since: 50 })
  await reader.withdraw({ kind: 'object', source: fixture.source, objectId: '$forgotten' }, 'forget')
  await reader.setIncluded(fixture.source, false)
  await reader.reportCoverage()
  expect(new Set(checked)).toEqual(
    new Set([
      'envelope.managed',
      'ingestion.receipt',
      'fence.notice',
      'fence.ack',
      'withdrawal',
      'withdrawal.receipt',
      'coverage.report'
    ])
  )
})

it('the selected schema matcher refuses forbidden owners, marked managed envelopes and contentful redactions', () => {
  const fixture = pack.vectors['envelope-human-group-message.managed.json']
  const schema = pack.messages['envelope.managed'].schema
  expect(matches(schema, fixture)).toBe(true)
  expect(matches(schema, { ...fixture, owner: 'forged' })).toBe(false)
  expect(matches(schema, { ...fixture, policy: { ...fixture.policy, googleDerived: true } })).toBe(false)
  expect(matches(schema, { ...pack.vectors['envelope-redaction.managed.json'], content: fixture.content })).toBe(false)
})
