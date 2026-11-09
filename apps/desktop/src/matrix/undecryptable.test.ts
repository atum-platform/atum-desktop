import { EventEmitter } from 'node:events'

import { MatrixEventEvent } from 'matrix-js-sdk'
import { DecryptionFailureCode } from 'matrix-js-sdk/lib/crypto-api'
import { expect, it } from 'vitest'

import { MATRIX_DECRYPTION_FAILURE_CODES, type MatrixUndecryptableObservation } from '../../shared/matrix-undecryptable'

import { observeMatrixUndecryptable } from './undecryptable'

function event(roomId: string | undefined, failure: DecryptionFailureCode | null) {
  return {
    getRoomId: () => roomId,
    isDecryptionFailure: () => failure !== null,
    decryptionFailureReason: failure,
    getContent: () => ({ body: 'never read' })
  }
}

it('offers each failed decryption as its room and the SDK’s own reason, and nothing for a readable one', () => {
  const client = new EventEmitter()
  const offered: MatrixUndecryptableObservation[] = []
  const stop = observeMatrixUndecryptable(client as never, value => offered.push(value))

  client.emit(MatrixEventEvent.Decrypted, event('!a:atum.example', DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID))
  client.emit(MatrixEventEvent.Decrypted, event('!a:atum.example', null))
  client.emit(MatrixEventEvent.Decrypted, event(undefined, DecryptionFailureCode.UNKNOWN_ERROR))

  expect(offered).toEqual([{ roomId: '!a:atum.example', code: 'MEGOLM_UNKNOWN_INBOUND_SESSION_ID' }])

  stop()
  client.emit(MatrixEventEvent.Decrypted, event('!a:atum.example', DecryptionFailureCode.MEGOLM_KEY_WITHHELD))
  expect(offered).toHaveLength(1)
})

it('names every reason the SDK can give with the same code main accepts', () => {
  for (const code of Object.values(DecryptionFailureCode)) {
    expect(MATRIX_DECRYPTION_FAILURE_CODES).toContain(code)
  }
})

it('never lets a failing host break the SDK’s event handling', () => {
  const client = new EventEmitter()

  observeMatrixUndecryptable(client as never, () => {
    throw new Error('host gone')
  })

  expect(() =>
    client.emit(MatrixEventEvent.Decrypted, event('!a:atum.example', DecryptionFailureCode.UNKNOWN_ERROR))
  ).not.toThrow()
})
