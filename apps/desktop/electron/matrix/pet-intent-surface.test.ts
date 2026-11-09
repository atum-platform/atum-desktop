import { expect, it, vi } from 'vitest'

import type { MatrixPetView } from '../../shared/matrix-pet'

import { readMatrixPetIntentSurface } from './pet-intent-surface'

function fixture() {
  const view = {
    freshness: 'current',
    selection: {
      owner: 'synthetic-owner', agent: 'synthetic-agent', revision: 1,
      pet: { enabled: true, scale: 1, ref: { kind: 'bundled', slug: 'gigi' } },
      access: 'owned', provenance: 'explicit', visitEndsAt: null, serverTime: '2026-10-07T12:00:00Z'
    }
  } as MatrixPetView

  return {
    view,
    input: {
      owner: view.selection.owner,
      target: { scope: 'synthetic-account:1', agent: view.selection.agent },
      privateRoom: true,
      current: vi.fn(() => true),
      read: vi.fn(async () => view)
    }
  }
}

it.each(['off', 'group', 'excluded', 'retired'] as const)('does no platform read for %s', async reason => {
  const f = fixture()

  if (reason === 'group') { f.input.privateRoom = false }

  if (reason === 'retired') { f.input.current.mockReturnValue(false) }
  expect(await readMatrixPetIntentSurface({ ...f.input, excluded: reason === 'excluded' }, reason !== 'off')).toBe(false)
  expect(f.input.read).not.toHaveBeenCalled()
})

it('requires an enabled authoritative binding, independent of sprite visibility', async () => {
  const f = fixture()
  expect(await readMatrixPetIntentSurface(f.input, true)).toBe(true)
  expect(f.input.read).toHaveBeenCalledWith(f.input.target)
  f.view.selection.pet!.enabled = false
  expect(await readMatrixPetIntentSurface(f.input, true)).toBe(false)
  f.view.selection.pet = null
  expect(await readMatrixPetIntentSurface(f.input, true)).toBe(false)
})

it('an explicit none binding never grants a pet surface', async () => {
  const f = fixture()
  f.view.selection.pet!.ref = null
  expect(await readMatrixPetIntentSurface(f.input, true)).toBe(false)
})

it.each(['active', 'expired', 'missing'] as const)('uses the authoritative clock for a %s visit', async state => {
  const f = fixture()
  f.view.selection.access = 'visiting'
  f.view.selection.visitEndsAt = state === 'active' ? '2026-10-07T12:01:00Z' :
    state === 'expired' ? '2026-10-07T12:00:00Z' : null
  expect(await readMatrixPetIntentSurface(f.input, true)).toBe(state === 'active')
})

it.each(['offline', 'owner', 'agent', 'expired', 'available'] as const)('rejects %s capability facts', async reason => {
  const f = fixture()

  if (reason === 'offline') { f.view.freshness = 'offline' }

  if (reason === 'owner') { f.view.selection.owner = 'other' }

  if (reason === 'agent') { f.view.selection.agent = 'other' }

  if (reason === 'expired') { f.view.visitUnavailable = true }

  if (reason === 'available') { f.view.selection.access = 'available' }
  expect(await readMatrixPetIntentSurface(f.input, true)).toBe(false)
})

it('refuses a late binding read after account generation changed', async () => {
  const f = fixture()
  f.input.read.mockImplementation(async () => { f.input.current.mockReturnValue(false);

 return f.view })
  expect(await readMatrixPetIntentSurface(f.input, true)).toBe(false)
})

it('missing capability and transport failure preserve the ordinary text path', async () => {
  const f = fixture()
  f.input.read.mockRejectedValue(new Error('synthetic unavailable'))
  expect(await readMatrixPetIntentSurface(f.input, true)).toBe(false)
})
