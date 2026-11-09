import { afterEach, expect, it, vi } from 'vitest'

import { assistantDefinitionWriteWire, parseAtumPortableDefinition } from '../shared/atum-agent-portability'

import { getPortableProfileDefinition } from './hermes'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('carries the Python export through renderer and main serialization without losing schema or model fields', async () => {
  const definition = { schema_version: 1, soul: '# Atlas\nGiúp tôi viết.', model_alias: 'nguyet-thuc',
    reasoning: { enabled: true, effort: 'high' }, skills: [{ name: 'viết/thơ', sha256: 'a'.repeat(64) }] }

  vi.stubGlobal('hermesDesktop', {
    api: vi.fn().mockResolvedValue({ definition, assistant: {}, profile: { name: 'atlas' } })
  })
  const exported = await getPortableProfileDefinition('atlas')

  const request = assistantDefinitionWriteWire({ definition: exported.definition, displayName: 'Atlas', avatar: '🗺',
    expectedDefinitionRevision: 0, expectedIdentityRevision: 1 })

  expect(request.definition).toEqual(definition)
  expect(request.expected_definition_revision).toBe(0)
})

it('shares cloud/Python empty-SOUL and canonical reasoning rules', () => {
  const definition = { schema_version: 1, soul: '', model_alias: 'binh-minh', reasoning: null, skills: [] }
  expect(parseAtumPortableDefinition(definition).soul).toBe('')

  for (const reasoning of [{ enabled: true, effort: null }, { enabled: true, effort: 'none' }, { enabled: false, effort: 'high' }])
    {expect(() => parseAtumPortableDefinition({ ...definition, reasoning })).toThrow()}
})
