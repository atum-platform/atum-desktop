import { describe, expect, it, vi } from 'vitest'

import { MatrixAgentDefinitionError, type MatrixAgentDefinitionSnapshot } from './agent-definition'
import { parseMatrixProfilePayload, publishMatrixProfileImport } from './profile-import'

const wire = () => ({
  sha256: 'a'.repeat(64),
  definition: { schema_version: 1, soul: 'Keep my calendar.', model_alias: 'binh-minh', reasoning: null,
    skills: [{ name: 'calendar', sha256: 'b'.repeat(64) }] },
  bundles: [{ schema_version: 1, sha256: 'b'.repeat(64), files: [{ path: 'SKILL.md', content_base64: 'YWJj' }] }]
})

describe('native profile publication', () => {
  it('uploads content before a revision-fenced definition and sends no local config or memory', async () => {
    const payload = parseMatrixProfilePayload({ ...wire(), config: 'local only', memory: 'local only' })
    const order: string[] = []
    const snapshot = { definition: null, definitionRevision: 0, identityRevision: 1 } as MatrixAgentDefinitionSnapshot
    const write = vi.fn(async () => { order.push('definition') })
    const skill = vi.fn(async () => { order.push('skill') })
    await publishMatrixProfileImport(payload, { read: async () => snapshot, skill, write })
    expect(order).toEqual(['skill', 'definition'])
    expect(write).toHaveBeenCalledWith(snapshot, payload.definition)
    expect(Object.keys(payload).sort()).toEqual(['bundles', 'definition', 'sha256'])
  })

  it('does not publish a definition when a bundle upload fails; retry is idempotent', async () => {
    const payload = parseMatrixProfilePayload(wire())
    const write = vi.fn()
    await expect(publishMatrixProfileImport(payload, {
      read: async () => ({ definition: null }) as MatrixAgentDefinitionSnapshot,
      skill: async () => { throw new Error('offline') }, write
    })).rejects.toThrow('offline')
    expect(write).not.toHaveBeenCalled()

    const skill = vi.fn()
    await publishMatrixProfileImport(payload, {
      read: async () => ({ definition: payload.definition }) as MatrixAgentDefinitionSnapshot, skill, write
    })
    expect(skill).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('does not overwrite a definition changed by another device', async () => {
    const payload = parseMatrixProfilePayload(wire())
    const skill = vi.fn(), write = vi.fn()
    await expect(publishMatrixProfileImport(payload, {
      read: async () => ({ definition: { ...payload.definition, soul: 'New owner instructions' } }) as MatrixAgentDefinitionSnapshot,
      skill, write
    })).rejects.toThrow('matrix_profile_import_conflict')
    expect(skill).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('retries only the same immutable skill once after an unavailable response', async () => {
    const payload = parseMatrixProfilePayload(wire())
    const skill = vi.fn().mockRejectedValueOnce(new MatrixAgentDefinitionError('unavailable')).mockResolvedValue(undefined)
    const write = vi.fn()
    await publishMatrixProfileImport(payload, {
      read: async () => ({ definition: null }) as MatrixAgentDefinitionSnapshot, skill, write
    })
    expect(skill).toHaveBeenCalledTimes(2)
    expect(skill.mock.calls.map(call => call[0])).toEqual([payload.bundles[0], payload.bundles[0]])
    expect(write).toHaveBeenCalledTimes(1)
  })

  it.each(['unavailable', 'denied', 'conflict', 'invalid', 'missing'] as const)(
    'does not publish through a persistent %s failure or retry indefinitely', async code => {
      const skill = vi.fn().mockRejectedValue(new MatrixAgentDefinitionError(code))
      const write = vi.fn()
      await expect(publishMatrixProfileImport(parseMatrixProfilePayload(wire()), {
        read: async () => ({ definition: null }) as MatrixAgentDefinitionSnapshot, skill, write
      })).rejects.toThrow(`matrix_agent_definition_${code}`)
      expect(skill).toHaveBeenCalledTimes(code === 'unavailable' ? 2 : 1)
      expect(write).not.toHaveBeenCalled()
    }
  )

  it('refuses malformed digest, missing bundles and a bundle/definition mismatch', () => {
    expect(() => parseMatrixProfilePayload({ ...wire(), sha256: 'bad' })).toThrow()
    expect(() => parseMatrixProfilePayload({ ...wire(), bundles: [] })).toThrow()
    const wrong = wire()
    wrong.bundles[0].sha256 = 'c'.repeat(64)
    expect(() => parseMatrixProfilePayload(wrong)).toThrow()
  })
})
