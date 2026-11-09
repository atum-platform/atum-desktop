import { afterEach, expect, it, vi } from 'vitest'

import { readMatrixPetRoaming } from './pet-roaming'

const owner = '00000000-0000-4000-8000-b9c47b970683'
const grant = { accessToken: 'synthetic', refreshToken: 'synthetic', issuer: 'https://mas.test', subject: 'owner' }
afterEach(() => vi.unstubAllGlobals())

it.each([true, false])('reads the exact current owner preference %s without any write', async petRoaming => {
  const transport = vi.fn(async () => Response.json({ owner, revision: 3, petRoaming }))
  vi.stubGlobal('fetch', transport)
  const signal = new AbortController().signal
  expect(await readMatrixPetRoaming('https://atum.test/api/matrix/v1', grant, owner, signal)).toBe(petRoaming)
  expect(transport).toHaveBeenCalledWith('https://atum.test/api/matrix/v1/preferences/pet-roaming', {
    headers: { Authorization: 'Bearer synthetic' }, redirect: 'error', signal
  })
})

it.each([
  { owner: '00000000-0000-4000-8000-c4c55763870b', revision: 3, petRoaming: false },
  { owner, revision: -1, petRoaming: false },
  { owner, revision: 3, petRoaming: 'false' },
  { owner, revision: 3, petRoaming: false, arbitrary: true }
])('rejects a malformed or foreign-owner projection', async value => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(value)))
  await expect(readMatrixPetRoaming('https://atum.test', grant, owner, new AbortController().signal)).rejects.toThrow('matrix_pet_invalid')
})

it('does not follow redirects or expose an unsuccessful response', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 403 })))
  await expect(readMatrixPetRoaming('https://atum.test', grant, owner, new AbortController().signal)).rejects.toThrow('matrix_pet_preferences_unavailable')
})
