import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { MATRIX_PET_INTENT_PACK_SHA256, matrixPetReplyMixin, parseMatrixPetIntents, parseMatrixPetReply } from './matrix-pet-intent'

const pack = new URL('./fixtures/pet-intent/v1/', import.meta.url)
const contract = JSON.parse(readFileSync(new URL('contract.json', pack), 'utf8'))

describe('frozen pet intent pack', () => {
  it.each(contract.fixtures)(
    '$file $expect',
    ({ file, message, expect: expected }: { file: string; message: string; expect: string }) => {
      const input = JSON.parse(readFileSync(new URL(file, pack), 'utf8'))
      const parsed = message === 'pet.mixin' ? parseMatrixPetIntents(input) : parseMatrixPetReply(input)
      expect(Boolean(parsed)).toBe(expected === 'accept')
    }
  )

  it('preserves every raw pack byte under the pinned framing digest', () => {
    const hash = createHash('sha256')

    for (const name of [...contract.pack_files].sort()) {
      const path = Buffer.from(name)
      const body = readFileSync(fileURLToPath(new URL(name, pack)))
      const pathLength = Buffer.alloc(4)
      pathLength.writeUInt32BE(path.length)
      const bodyLength = Buffer.alloc(8)
      bodyLength.writeBigUInt64BE(BigInt(body.length))
      hash.update(pathLength)
      hash.update(path)
      hash.update(bodyLength)
      hash.update(body)
    }

    // Framing matches the two independent standard-library pack checkers.
    expect(hash.digest('hex')).toBe(MATRIX_PET_INTENT_PACK_SHA256)
    expect(readFileSync(new URL('PINNED-SHA256', pack), 'utf8').trim()).toBe(MATRIX_PET_INTENT_PACK_SHA256)
  })

  it('returns new data-only commands without retaining sender objects', () => {
    const intent = { action: 'go', place: 'left' }
    const value = parseMatrixPetIntents({ v: 1, intents: [intent, { action: 'wave' }] })!
    intent.place = 'right'
    expect(value).toEqual([{ action: 'go', place: 'left' }, { action: 'wave' }])
  })

  it('parses only the last native final part, with playback still opt-in', () => {
    const pet = { v: 1, intents: [{ action: 'wave' }, { action: 'go', place: 'center' }] }
    const parts = [
      { msgtype: 'm.text', body: 'First part', 'io.atum.turn': 'turn' },
      { msgtype: 'm.text', body: 'Last part', 'io.atum.turn': 'turn', 'io.atum.pet': pet }
    ]
    expect(parts.map(parseMatrixPetReply)).toEqual([undefined, pet.intents])
    expect(matrixPetReplyMixin(pet, true)).toEqual({})
    expect(matrixPetReplyMixin(pet, true, true)).toEqual({ 'io.atum.pet': pet })
    expect(matrixPetReplyMixin(pet, false, true)).toEqual({})
    expect(parseMatrixPetReply({ msgtype: 'm.text', body: 'Cron result' })).toBeUndefined()
  })

  it('drops malformed cosmetic metadata without changing the text', () => {
    const content = { msgtype: 'm.text', body: 'Successful answer', 'io.atum.pet': { v: 1, intents: [{ action: 'fly' }] } }
    expect(parseMatrixPetReply(content)).toBeUndefined()
    expect(content.body).toBe('Successful answer')
    expect(matrixPetReplyMixin(content['io.atum.pet'], true, true)).toEqual({})
  })
})
