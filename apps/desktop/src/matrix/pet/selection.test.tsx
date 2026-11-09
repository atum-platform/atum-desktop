import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AtumPetBinding } from '../../../shared/atum-account-preferences'
import type { MatrixPetBridge, MatrixPetView } from '../../../shared/matrix-pet'

import { usePetSelection } from './selection'

const original: AtumPetBinding = { ref: { kind: 'bundled', slug: 'gigi' }, enabled: true, scale: 1 }
const changed: AtumPetBinding = { ref: { kind: 'bundled', slug: 'mochi' }, enabled: true, scale: 1.2 }

function view(revision: number, pet: AtumPetBinding): MatrixPetView {
  return {
    selection: {
      owner: '@owner:test',
      agent: '@agent:test',
      revision,
      pet,
      provenance: 'explicit',
      access: 'owned',
      visitEndsAt: null,
      serverTime: '2026-10-20T00:00:00.000Z'
    },
    freshness: 'current',
    catalogUnavailable: true
  }
}

function bridge(read: MatrixPetBridge['read'], write: MatrixPetBridge['write']): MatrixPetBridge {
  return {
    read,
    write,
    catalog: vi.fn(),
    beginVisit: vi.fn(),
    choosePhoto: vi.fn(),
    generate: vi.fn(),
    hatch: vi.fn(),
    adoptPending: vi.fn(),
    recovery: vi.fn(async () => ({ state: 'none', canDiscard: false })),
    retryPending: vi.fn(),
    discardPending: vi.fn(),
    cancel: vi.fn(),
    onHatchProgress: vi.fn(() => () => {})
  } as MatrixPetBridge
}

describe('pet selection write reconciliation', () => {
  it('accepts a saved choice after the write reply is lost, without replaying the write', async () => {
    const read = vi
      .fn<MatrixPetBridge['read']>()
      .mockResolvedValueOnce(view(1, original))
      .mockResolvedValue(view(2, changed))
    const write = vi.fn<MatrixPetBridge['write']>().mockRejectedValue(new Error('matrix_agent_definition_unavailable'))
    const api = bridge(read, write)
    const hook = renderHook(() => usePetSelection({ bridge: api, scope: 'owner', agent: '@agent:test' }))

    await waitFor(() => expect(hook.result.current.view?.selection.revision).toBe(1))
    await act(async () => {
      await hook.result.current.write(changed)
    })

    expect(write).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledTimes(2)
    expect(hook.result.current.view?.selection).toMatchObject({ revision: 2, pet: changed })
    expect(hook.result.current.error).toBeUndefined()
  })

  it('reports a real failure when neither the write nor its reconciliation can be read', async () => {
    const read = vi
      .fn<MatrixPetBridge['read']>()
      .mockResolvedValueOnce(view(1, original))
      .mockRejectedValueOnce(new Error('offline'))
    const write = vi.fn<MatrixPetBridge['write']>().mockRejectedValue(new Error('matrix_agent_definition_unavailable'))
    const api = bridge(read, write)
    const hook = renderHook(() => usePetSelection({ bridge: api, scope: 'owner', agent: '@agent:test' }))

    await waitFor(() => expect(hook.result.current.view?.selection.revision).toBe(1))
    await act(async () => {
      await hook.result.current.write(changed)
    })

    expect(write).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledTimes(2)
    expect(hook.result.current.error).toBe('unavailable')
  })
})
