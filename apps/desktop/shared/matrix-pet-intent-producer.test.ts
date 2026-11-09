import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

import { matrixPetCompletionIntents, matrixPetIntentEnvelope, matrixPetReplyMixin } from './matrix-pet-intent'

const pack = new URL('./fixtures/pet-intent/v1/', import.meta.url)
const contract = JSON.parse(readFileSync(new URL('contract.json', pack), 'utf8'))

it.each(contract.fixtures.filter((entry: { message: string }) => entry.message === 'pet.mixin'))(
  'producer respects frozen $file $expect',
  ({ file, expect: expected }: { file: string; expect: string }) => {
    const value = JSON.parse(readFileSync(new URL(file, pack), 'utf8'))
    const envelope = matrixPetIntentEnvelope(value)
    expect(Boolean(envelope)).toBe(expected === 'accept')

    if (envelope) {
      expect(matrixPetCompletionIntents(value.intents, true)).toEqual(envelope)
      expect(matrixPetReplyMixin(envelope, true, true)).toEqual({ 'io.atum.pet': envelope })
    }
  }
)

it('omits cosmetic data with the build flag off, a missing surface or a non-private room', () => {
  const pet = { v: 1, intents: [{ action: 'wave' }] }
  expect(matrixPetReplyMixin(pet, true)).toEqual({})
  expect(matrixPetReplyMixin(pet, false, true)).toEqual({})
  expect(matrixPetCompletionIntents(pet.intents, false)).toBeUndefined()
  expect(matrixPetReplyMixin({ ...pet, text: 'extra' }, true, true)).toEqual({})
})

it('copies the validated completion before persistence and never retains mutable model objects', () => {
  const input = [{ action: 'go', place: 'left' }, { action: 'wave' }]
  const pet = matrixPetCompletionIntents(input, true)
  input[0].place = 'right'
  input.push({ action: 'jump' })
  expect(pet).toEqual({ v: 1, intents: [{ action: 'go', place: 'left' }, { action: 'wave' }] })
  expect(matrixPetReplyMixin(JSON.parse(JSON.stringify(pet)), true, true)).toEqual({ 'io.atum.pet': pet })
})
