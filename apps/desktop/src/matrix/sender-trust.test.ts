import {
  EventShieldColour as Colour,
  DeviceVerificationStatus,
  EventShieldReason as Reason
} from 'matrix-js-sdk/lib/crypto-api'
import { expect, it } from 'vitest'

import { trustedMatrixSender } from './sender-trust'

it('admits explicit fingerprint pins, never absent trust or authenticity warnings', () => {
  const local = new DeviceVerificationStatus({ localVerified: true })
  const unverified = new DeviceVerificationStatus({ localVerified: false })
  expect(trustedMatrixSender(local, { shieldColour: Colour.RED, shieldReason: Reason.UNSIGNED_DEVICE })).toBe(true)
  expect(trustedMatrixSender(local, { shieldColour: Colour.NONE, shieldReason: null })).toBe(true)
  expect(trustedMatrixSender(unverified, { shieldColour: Colour.NONE, shieldReason: null })).toBe(false)
  expect(trustedMatrixSender(null, { shieldColour: Colour.NONE, shieldReason: null })).toBe(false)
  expect(trustedMatrixSender(local, null)).toBe(false)

  for (const reason of [
    Reason.AUTHENTICITY_NOT_GUARANTEED,
    Reason.MISMATCHED_SENDER,
    Reason.UNKNOWN_DEVICE,
    Reason.UNKNOWN,
    Reason.VERIFICATION_VIOLATION,
    Reason.UNVERIFIED_IDENTITY
  ]) {
    for (const colour of [Colour.NONE, Colour.GREY, Colour.RED]) {
      expect(trustedMatrixSender(local, { shieldColour: colour, shieldReason: reason })).toBe(false)
    }
  }
})
