import { describe, expect, it, vi } from 'vitest'

import type { AtumCloudMemory, AtumMemorySnapshot } from '../../../shared/atum-agent-content'
import { MatrixAgentDefinitionError } from '../agent-definition'

import type { MatrixAgentContentHelper } from './helper'
import { syncMatrixAgentMemory } from './memory'

const ASSISTANT = '00000000-0000-4000-8000-bd7662a5eeb4'
const runtime = { python: '/unused/python', source: '/unused/source', profiles: '/unused/profiles' }
const copy = (snapshot: AtumMemorySnapshot): AtumMemorySnapshot => structuredClone(snapshot)

function fixture(input: {
  local: AtumMemorySnapshot
  cloud: AtumCloudMemory
  base?: { revision: number; snapshot: AtumMemorySnapshot }
}) {
  let local = copy(input.local)
  let cloud = structuredClone(input.cloud)
  let receipt = input.base ? structuredClone(input.base) : undefined

  const helper: MatrixAgentContentHelper = vi.fn(async (_runtime, _home, operation, request) => {
    if (operation === 'memory-read') {
      return { ok: true, snapshot: copy(local), receipt: receipt ? structuredClone(receipt) : null }
    }

    if (operation !== 'memory-apply') {
      throw new Error('unexpected_operation')
    }

    const body = request as { expected_snapshot: AtumMemorySnapshot; snapshot: AtumMemorySnapshot; revision: number }

    if (JSON.stringify(body.expected_snapshot) !== JSON.stringify(local)) {
      return { ok: true, result: { success: false, snapshot: copy(local) } }
    }

    local = copy(body.snapshot)
    receipt = { revision: body.revision, snapshot: copy(body.snapshot) }

    return { ok: true, result: { success: true, snapshot: copy(local) } }
  })

  const memory = vi.fn(async () => structuredClone(cloud))
  const writeMemory = vi.fn(
    async (write: { expected_revision: number; enabled: boolean; snapshot: AtumMemorySnapshot }) => {
      if (write.expected_revision !== cloud.revision) {
        throw new MatrixAgentDefinitionError('conflict')
      }

      cloud = {
        assistantId: ASSISTANT,
        revision: cloud.revision + 1,
        enabled: write.enabled,
        snapshot: copy(write.snapshot)
      }

      return structuredClone(cloud)
    }
  )

  const target = {
    home: '/profiles/home',
    runtime,
    live: () => true,
    memory,
    writeMemory
  }

  return {
    helper,
    target,
    writeMemory,
    local: () => copy(local),
    cloud: () => structuredClone(cloud),
    receipt: () => (receipt ? structuredClone(receipt) : undefined)
  }
}

describe('Matrix local-memory continuity', () => {
  it('seeds an absent account row from this home, then records the accepted base', async () => {
    const local = { memory: ['Remember this'], user: ['Owner'] }
    const f = fixture({
      local,
      cloud: { assistantId: ASSISTANT, revision: 0, enabled: true, snapshot: { memory: [], user: [] } }
    })

    await expect(syncMatrixAgentMemory(f.target, new AbortController().signal, f.helper)).resolves.toBe('synced')
    expect(f.writeMemory).toHaveBeenCalledExactlyOnceWith(
      { expected_revision: 0, enabled: true, snapshot: local },
      expect.any(AbortSignal)
    )
    expect(f.cloud()).toMatchObject({ revision: 1, enabled: true, snapshot: local })
    expect(f.receipt()).toEqual({ revision: 1, snapshot: local })
  })

  it('downloads a remote-only edit and uploads a local-only edit from the same base', async () => {
    const base = { memory: ['Base'], user: ['Owner'] }
    const remote = fixture({
      local: base,
      cloud: { assistantId: ASSISTANT, revision: 4, enabled: true, snapshot: { ...base, memory: ['Remote'] } },
      base: { revision: 3, snapshot: base }
    })
    await expect(syncMatrixAgentMemory(remote.target, new AbortController().signal, remote.helper)).resolves.toBe(
      'synced'
    )
    expect(remote.writeMemory).not.toHaveBeenCalled()
    expect(remote.local()).toEqual({ ...base, memory: ['Remote'] })

    const local = fixture({
      local: { ...base, user: ['Owner', 'Local'] },
      cloud: { assistantId: ASSISTANT, revision: 3, enabled: true, snapshot: base },
      base: { revision: 3, snapshot: base }
    })
    await expect(syncMatrixAgentMemory(local.target, new AbortController().signal, local.helper)).resolves.toBe(
      'synced'
    )
    expect(local.cloud()).toMatchObject({ revision: 4, snapshot: { ...base, user: ['Owner', 'Local'] } })
  })

  it('merges independent MEMORY and USER edits but refuses two edits to the same target', async () => {
    const base = { memory: ['Base'], user: ['Owner'] }
    const merged = fixture({
      local: { memory: ['Local memory'], user: base.user },
      cloud: {
        assistantId: ASSISTANT,
        revision: 4,
        enabled: true,
        snapshot: { memory: base.memory, user: ['Remote user'] }
      },
      base: { revision: 3, snapshot: base }
    })
    await expect(syncMatrixAgentMemory(merged.target, new AbortController().signal, merged.helper)).resolves.toBe(
      'synced'
    )
    expect(merged.local()).toEqual({ memory: ['Local memory'], user: ['Remote user'] })
    expect(merged.cloud().snapshot).toEqual(merged.local())

    const conflict = fixture({
      local: { ...base, memory: ['Local'] },
      cloud: { assistantId: ASSISTANT, revision: 4, enabled: true, snapshot: { ...base, memory: ['Remote'] } },
      base: { revision: 3, snapshot: base }
    })
    await expect(syncMatrixAgentMemory(conflict.target, new AbortController().signal, conflict.helper)).resolves.toBe(
      'conflict'
    )
    expect(conflict.writeMemory).not.toHaveBeenCalled()
    expect(vi.mocked(conflict.helper).mock.calls.map(([, , operation]) => operation)).toEqual(['memory-read'])
  })

  it('respects a saved pause and treats a cloud CAS race as a conflict', async () => {
    const snapshot = { memory: ['One'], user: [] }
    const paused = fixture({
      local: snapshot,
      cloud: { assistantId: ASSISTANT, revision: 2, enabled: false, snapshot },
      base: { revision: 2, snapshot }
    })
    await expect(syncMatrixAgentMemory(paused.target, new AbortController().signal, paused.helper)).resolves.toBe(
      'disabled'
    )
    expect(paused.helper).not.toHaveBeenCalled()

    const absentButDisabled = fixture({
      local: snapshot,
      cloud: { assistantId: ASSISTANT, revision: 0, enabled: false, snapshot: { memory: [], user: [] } }
    })
    await expect(
      syncMatrixAgentMemory(absentButDisabled.target, new AbortController().signal, absentButDisabled.helper)
    ).resolves.toBe('disabled')
    expect(absentButDisabled.helper).not.toHaveBeenCalled()
    expect(absentButDisabled.writeMemory).not.toHaveBeenCalled()

    const raced = fixture({
      local: { memory: ['Local'], user: [] },
      cloud: { assistantId: ASSISTANT, revision: 2, enabled: true, snapshot },
      base: { revision: 2, snapshot }
    })
    raced.writeMemory.mockRejectedValueOnce(new MatrixAgentDefinitionError('conflict'))
    await expect(syncMatrixAgentMemory(raced.target, new AbortController().signal, raced.helper)).resolves.toBe(
      'conflict'
    )
    expect(raced.receipt()).toEqual({ revision: 2, snapshot })
  })

  it('leaves the home and receipt untouched when the platform route is unavailable', async () => {
    const snapshot = { memory: ['Local'], user: ['Owner'] }
    const f = fixture({
      local: snapshot,
      cloud: { assistantId: ASSISTANT, revision: 2, enabled: true, snapshot },
      base: { revision: 2, snapshot }
    })
    f.target.memory.mockRejectedValueOnce(new MatrixAgentDefinitionError('unavailable'))

    await expect(syncMatrixAgentMemory(f.target, new AbortController().signal, f.helper)).resolves.toBe(
      'unavailable'
    )
    expect(f.helper).not.toHaveBeenCalled()
    expect(f.writeMemory).not.toHaveBeenCalled()
    expect(f.local()).toEqual(snapshot)
    expect(f.receipt()).toEqual({ revision: 2, snapshot })
  })

  it('does not even read a Google-latched home or contact the account relay', async () => {
    const snapshot = { memory: ['Protected'], user: [] }
    const f = fixture({
      local: snapshot,
      cloud: { assistantId: ASSISTANT, revision: 1, enabled: true, snapshot },
      base: { revision: 1, snapshot }
    })

    await expect(
      syncMatrixAgentMemory({ ...f.target, memoryAllowed: () => false }, new AbortController().signal, f.helper)
    ).resolves.toBe('local_only')
    expect(f.helper).not.toHaveBeenCalled()
    expect(f.target.memory).not.toHaveBeenCalled()
    expect(f.writeMemory).not.toHaveBeenCalled()
  })

  it('stops before account egress when the Google latch appears during the local read', async () => {
    const snapshot = { memory: ['Protected'], user: [] }
    const f = fixture({
      local: snapshot,
      cloud: { assistantId: ASSISTANT, revision: 1, enabled: true, snapshot },
      base: { revision: 1, snapshot }
    })
    let allowed = true
    const original = vi.mocked(f.helper).getMockImplementation()!
    vi.mocked(f.helper).mockImplementationOnce(async (...args) => {
      const result = await original(...args)
      allowed = false

      return result
    })

    await expect(
      syncMatrixAgentMemory(
        { ...f.target, memoryAllowed: () => allowed },
        new AbortController().signal,
        f.helper
      )
    ).resolves.toBe('local_only')
    expect(f.helper).toHaveBeenCalledOnce()
    expect(f.target.memory).toHaveBeenCalledOnce()
    expect(f.writeMemory).not.toHaveBeenCalled()
  })
})
