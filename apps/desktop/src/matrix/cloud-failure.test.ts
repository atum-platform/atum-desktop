import { describe, expect, it } from 'vitest'

import { cloudEnrollFailure, needsCloudEntitlement } from './cloud-failure'

const ipc = (code: string) => new Error(`Error invoking remote method 'matrix:ui': Error: ${code}`)

describe('what the person is told when this Mac is not enrolled', () => {
  it.each([
    ['matrix_signed_out', 'signed_out'],
    ['device_owner_not_ready', 'not_ready'],
    ['matrix_not_ready', 'not_ready'],
    ['device_owner_fingerprint_unavailable', 'key_unreadable'],
    ['device_enrollment_approval_denied', 'cancelled'],
    ['device_enrollment_approval_timeout', 'cancelled'],
    ['device_enrollment_timeout', 'cancelled'],
    ['device_enrollment_approval_unavailable', 'no_prompt'],
    ['device_unavailable', 'unavailable'],
    ['device_enrollment_unavailable', 'offline'],
    ['device_registry_0_invalid', 'offline'],
    ['device_registry_503', 'offline'],
    ['device_enrollment_refused:bad_signature', 'refused'],
    ['device_enrollment_refused', 'refused'],
    ['device_enrollment_keys_unavailable', 'keys'],
    ['unexpected', 'generic'],
    ['device_registry_4031', 'generic']
  ])('%s → %s', (code, failure) => {
    expect(cloudEnrollFailure(ipc(code))).toBe(failure)
    expect(cloudEnrollFailure(new Error(code))).toBe(failure)
  })
})

it('offers the trial only for a refusal for want of cloud access', () => {
  expect(needsCloudEntitlement('device_registry_403_entitlement_required')).toBe(true)
  expect(needsCloudEntitlement(ipc('device_registry_403_entitlement_required'))).toBe(true)
  expect(needsCloudEntitlement('device_registry_403_not_offered')).toBe(false)
  expect(needsCloudEntitlement('device_registry_400_consent_required')).toBe(false)
})
