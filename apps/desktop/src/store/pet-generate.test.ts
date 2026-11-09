import { GatewayRpcError } from '@hermes/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The generate store on the spec path: voxel is the default style, the status
 * probe reads both lanes, a voxel round sends the style and a remix by draft
 * id, phases land on the store, and a typed failure keeps its code.
 */

const handlers = new Map<string, (event: { payload: unknown }) => void>()
const gateway = {
  on: vi.fn((event: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(event, handler)

    return () => handlers.delete(event)
  })
}

vi.mock('@/store/gateway', async () => {
  const { atom } = await import('nanostores')

  return { $gateway: atom(gateway) }
})
vi.mock('@/store/notifications', () => ({ notify: vi.fn() }))
vi.mock('@/store/native-notifications', () => ({ dispatchNativeNotification: vi.fn() }))
vi.mock('@/store/pet-gallery', () => ({ applyAdoptedPet: vi.fn() }))

const store = await import('./pet-generate')

const emit = (event: string, payload: unknown) => handlers.get(event)?.({ payload })

beforeEach(() => {
  store.resetPetGen()
  store.setPetGenStyle('voxel')
  handlers.clear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('the pet-generate store on the spec path', () => {
  it('defaults to voxel, and remembers illustrated', () => {
    expect(store.$petGenStyle.get()).toBe('voxel')
    store.setPetGenStyle('illustrated')
    expect(store.$petGenStyle.get()).toBe('illustrated')
    expect(store.petGenStyleAvailable('voxel')).toBeNull()
  })

  it('reads both lanes from the status probe, and keeps older gateways honest', async () => {
    const request = vi.fn(async () => ({
      available: true,
      providers: [{ name: 'openrouter', label: 'OpenRouter', default: true }],
      voxel: { available: true, mode: 'byok', reason: '' },
      illustrated: { available: false, providers: [] }
    }))

    await store.checkPetGenAvailable(request as never)

    expect(store.$petGenVoxel.get()).toEqual({ available: true, mode: 'byok', reason: '' })
    expect(store.$petGenAvailable.get()).toBe(false)
    expect(store.petGenStyleAvailable('voxel')).toBe(true)

    const old = vi.fn(async () => ({ available: true, providers: [] }))
    await store.checkPetGenAvailable(old as never)
    expect(store.$petGenVoxel.get()).toEqual({ available: false, mode: null, reason: 'update' })
    expect(store.$petGenAvailable.get()).toBe(true)
  })

  it('sends style voxel, shows the phases, and keeps each draft’s kind and summary', async () => {
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method !== 'pet.generate') {
        return { ok: true }
      }

      emit('pet.generate.progress', { token: 'tok', count: 2, kind: 'voxel', phase: 'designing' })
      expect(store.$petGenPhase.get()).toBe('designing')
      emit('pet.generate.progress', { token: 'tok', count: 2, kind: 'voxel', phase: 'rendering_previews' })
      expect(store.$petGenPhase.get()).toBe('rendering_previews')
      emit('pet.generate.progress', { token: 'tok', count: 2, index: 0, draftId: '0', dataUri: 'data:image/png;base64,AA==', kind: 'voxel', summary: 'Pepper: small, upright ears' })

      return { ok: true, token: 'tok', kind: 'voxel', drafts: [{ index: 0, draftId: '0', dataUri: 'data:image/png;base64,AA==', kind: 'voxel', summary: 'Pepper: small, upright ears' }] }
    })

    const ok = await store.generateDrafts(request as never, { prompt: 'a grey terrier' })

    expect(ok).toBe(true)
    const call = request.mock.calls.find(([method]) => method === 'pet.generate')!
    expect(call[1]).toMatchObject({ style: 'voxel', prompt: 'a grey terrier', count: 4 })
    expect(call[1]).not.toHaveProperty('provider')
    expect(store.$petGenDrafts.get()[0]).toMatchObject({ kind: 'voxel', draftId: '0', summary: 'Pepper: small, upright ears' })
    expect(store.$petGenStatus.get()).toBe('ready')
    expect(store.$petGenPhase.get()).toBeNull()
  })

  it('remixes a voxel draft by id with the note, not by picture', async () => {
    const request = vi.fn(async (method: string, _params?: unknown) => (method === 'pet.generate' ? { ok: true, token: 'tok2', drafts: [{ index: 0, dataUri: 'data:,x', kind: 'voxel', draftId: '0' }] } : { ok: true }))

    await store.generateDrafts(request as never, { prompt: 'rounder ears', remix: { token: 'tok', draftId: '1', note: 'rounder ears' } })

    const call = request.mock.calls.find(([method]) => method === 'pet.generate')!
    expect(call[1]).toMatchObject({ style: 'voxel', remixToken: 'tok', remixDraftId: '1', note: 'rounder ears' })
    expect(call[1]).not.toHaveProperty('referenceImage')
  })

  it('keeps the gateway’s code on a typed failure', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'pet.generate') {
        throw new GatewayRpcError('that kind of animal cannot be hatched yet (asked for: spider)', 4405)
      }

      return { ok: true }
    })

    const ok = await store.generateDrafts(request as never, { prompt: 'a cat' })

    expect(ok).toBe(false)
    expect(store.$petGenStatus.get()).toBe('error')
    expect(store.$petGenErrorCode.get()).toBe(4405)
    expect(store.$petGenError.get()).toContain('spider')
  })

  it('treats a missing method by code as a stale gateway', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'pet.generate') {
        throw new GatewayRpcError('nope', -32601)
      }

      return { ok: true }
    })

    await store.generateDrafts(request as never, { prompt: 'x' })

    expect(store.$petGenStatus.get()).toBe('stale')
  })

  it('ignores a late event from an earlier round, and trusts an older gateway that sends none', async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method !== 'pet.generate') {
        return { ok: true }
      }

      const ours = (params as { opId: string }).opId
      emit('pet.generate.progress', { token: 'OLD', count: 4, opId: 'someone-elses-round' })
      expect(store.$petGenToken.get()).toBeNull()
      emit('pet.generate.progress', { token: 'OLD', count: 4, index: 0, dataUri: 'data:,old', opId: 'someone-elses-round' })
      expect(store.$petGenDrafts.get()).toEqual([])
      emit('pet.generate.progress', { token: 'ours', count: 4, opId: ours })
      expect(store.$petGenToken.get()).toBe('ours')
      emit('pet.generate.progress', { token: 'ours', count: 4, index: 0, dataUri: 'data:,legacy' })
      expect(store.$petGenDrafts.get()).toHaveLength(1)

      return { ok: true, token: 'ours', drafts: [{ index: 0, dataUri: 'data:,legacy' }] }
    })

    await store.generateDrafts(request as never, { prompt: 'x' })

    expect(store.$petGenToken.get()).toBe('ours')
  })

  it('ignores a previous hatch’s late phase', async () => {
    store.$petGenToken.set('tok')
    store.$petGenDrafts.set([{ index: 0, dataUri: 'data:,x', kind: 'voxel', draftId: '0' }])
    store.$petGenSelected.set(0)
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method !== 'pet.hatch') {
        return { ok: true }
      }

      const mine = (params as { cancelToken: string }).cancelToken
      emit('pet.hatch.progress', { event: 'phase', phase: 'publishing', cancelToken: 'an-old-hatch' })
      expect(store.$petGenStage.get()).toBeNull()
      emit('pet.hatch.progress', { event: 'phase', phase: 'rendering', cancelToken: mine })
      expect(store.$petGenStage.get()?.phase).toBe('rendering')

      return { ok: true, slug: 'p', displayName: 'P', pet: { slug: 'p', spritesheetBase64: 'AA==' } }
    })

    await store.hatchSelected(request as never, { name: 'P' })
  })

  it('shows a voxel hatch’s phases and gives it the short deadline', async () => {
    store.$petGenToken.set('tok')
    store.$petGenDrafts.set([{ index: 0, dataUri: 'data:,x', kind: 'voxel', draftId: '0' }])
    store.$petGenSelected.set(0)
    const seen: string[] = []
    const request = vi.fn(async (method: string, _params: unknown, timeout?: number) => {
      if (method !== 'pet.hatch') {
        return { ok: true }
      }

      for (const phase of ['rendering', 'validating', 'publishing']) {
        emit('pet.hatch.progress', { event: 'phase', phase, kind: 'voxel' })
        seen.push(store.$petGenStage.get()?.phase ?? '')
      }
      expect(timeout).toBeLessThan(60_000)

      return { ok: true, slug: 'pepper', displayName: 'Pepper', kind: 'voxel', pet: { slug: 'pepper', spritesheetBase64: 'AA==' } }
    })

    const ok = await store.hatchSelected(request as never, { name: 'Pepper' })

    expect(ok).toBe(true)
    expect(seen).toEqual(['rendering', 'validating', 'publishing'])
    const call = request.mock.calls.find(([method]) => method === 'pet.hatch')!
    expect(call[1]).toMatchObject({ style: 'voxel', token: 'tok', index: 0, name: 'Pepper' })
    expect(store.$petGenStatus.get()).toBe('preview')
  })
})
