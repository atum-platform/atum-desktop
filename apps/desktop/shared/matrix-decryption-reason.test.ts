import { DecryptionFailureCode } from 'matrix-js-sdk/lib/crypto-api'
import { expect, it } from 'vitest'

import {
  MATRIX_DECRYPTION_REASONS,
  matrixDecryptionAction,
  matrixDecryptionReason,
  matrixMessageBackupAvailable,
  matrixMessageDecryptionReason
} from './matrix-decryption-reason'
import { MATRIX_DECRYPTION_FAILURE_CODES } from './matrix-undecryptable'

it('maps the whole installed SDK vocabulary using the diagnostic codes', () => {
  for (const code of Object.values(DecryptionFailureCode)) {
    expect(MATRIX_DECRYPTION_FAILURE_CODES).toContain(code)
    expect(MATRIX_DECRYPTION_REASONS).toContain(matrixDecryptionReason(code))
  }

  expect(matrixDecryptionReason('next_sdk_reason')).toBe('generic')
  expect(matrixDecryptionReason({ message: 'private raw failure' })).toBe('generic')
})

it('offers Restore only for restorable history or a generic failure with confirmed backup', () => {
  for (const reason of MATRIX_DECRYPTION_REASONS) {
    for (const backup of [false, true]) {
      expect(matrixDecryptionAction(reason, backup) === 'restore').toBe(
        reason === 'restore_possible' || (reason === 'generic' && backup)
      )
    }
  }
})

it('never guesses backup or display reasons from keys, storage, or unknown input', () => {
  expect(
    matrixMessageBackupAvailable({
      storage: 'present',
      kept: true,
      recovery: 'ready'
    })
  ).toBe(false)
  expect(matrixMessageBackupAvailable({ backupAvailable: true })).toBe(true)
  expect(matrixMessageBackupAvailable({ backupAvailable: 'true' })).toBe(false)
  expect(
    matrixMessageDecryptionReason({
      decryptionFailed: true,
      decryptionReason: 'private SDK error'
    } as never)
  ).toBe('generic')
})
