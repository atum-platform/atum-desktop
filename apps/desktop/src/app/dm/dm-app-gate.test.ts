import { describe, expect, it } from 'vitest'

import { allowsIntakeModal, appProtocolCapabilities } from '@/lib/atum-app-surfaces'
import type { IntakeFieldSpec } from '@/lib/atum-app-surfaces'

import {
  humanizeFieldName,
  intakeFieldLabel,
  intakeRequiredByLastTurn,
  mayShowIntake,
  missingIntakeValues,
  normalizeIntakeValues
} from './dm-app-gate'

function field(name: string, overrides: Partial<IntakeFieldSpec> = {}): IntakeFieldSpec {
  return { name, type: 'text', label: null, placeholder: null, options: [], ...overrides }
}

function dispatch(state: string, errorCode: null | string = null) {
  return { metadata: { specialist_dispatch: { state, specialist: 'moon', error_code: errorCode } } }
}

describe('intakeRequiredByLastTurn', () => {
  it('is false for a thread that has never dispatched to an app', () => {
    expect(intakeRequiredByLastTurn([])).toBe(false)
    expect(intakeRequiredByLastTurn([{ metadata: null }, { metadata: {} }])).toBe(false)
  })

  it('is true when the most recent turn failed on the intake gate', () => {
    expect(intakeRequiredByLastTurn([dispatch('succeeded'), dispatch('failed', 'intake_required')])).toBe(true)
  })

  it('is false when the last failure was something else entirely', () => {
    expect(intakeRequiredByLastTurn([dispatch('failed', 'rate_limited')])).toBe(false)
    expect(intakeRequiredByLastTurn([dispatch('failed', null)])).toBe(false)
  })

  it('does not resurrect an old gate that was already satisfied', () => {
    // The failed message stays in the transcript forever. Re-opening the form
    // on top of a working conversation would be a bug, not a reminder.
    expect(intakeRequiredByLastTurn([dispatch('failed', 'intake_required'), dispatch('succeeded')])).toBe(false)
  })

  it('looks past messages that carry no dispatch at all', () => {
    expect(
      intakeRequiredByLastTurn([dispatch('failed', 'intake_required'), { metadata: null }, { metadata: {} }])
    ).toBe(true)
  })

  it('waits rather than guessing while a turn is still in flight', () => {
    expect(intakeRequiredByLastTurn([dispatch('failed', 'intake_required'), dispatch('running')])).toBe(false)
  })
})

describe('mayShowIntake', () => {
  const fields = [field('dob')]

  it('never shows a form for a person-to-person thread', () => {
    expect(mayShowIntake({ isApp: false, payload: null, fields })).toBe(false)
  })

  it('never shows a form when the server declares nothing missing', () => {
    // The Andy case: an app that declares no intake must never see a form,
    // no matter what any client-side catalog thinks its fields are.
    expect(mayShowIntake({ isApp: true, payload: null, fields: [] })).toBe(false)
    expect(mayShowIntake({ isApp: true, payload: { protocol_capabilities: ['intake.modal'] }, fields: [] })).toBe(false)
  })

  it('respects an app that does not advertise intake.modal', () => {
    expect(mayShowIntake({ isApp: true, payload: { protocol_capabilities: ['response.streaming'] }, fields })).toBe(
      false
    )
    expect(mayShowIntake({ isApp: true, payload: { protocol_capabilities: [] }, fields })).toBe(false)
  })

  it('shows the form when the app advertises the capability and fields are outstanding', () => {
    expect(
      mayShowIntake({
        isApp: true,
        payload: { protocol_capabilities: ['intake.modal', 'panel.artifact'] },
        fields
      })
    ).toBe(true)
  })

  it('treats a missing capability list as unknown, not as a refusal', () => {
    // An older server projection carries no capabilities. The intake status
    // endpoint is then the authority — and it already said a field is missing.
    expect(mayShowIntake({ isApp: true, payload: {}, fields })).toBe(true)
    expect(mayShowIntake({ isApp: true, payload: undefined, fields })).toBe(true)
  })
})

describe('appProtocolCapabilities', () => {
  it('reads either casing and ignores non-string entries', () => {
    expect(appProtocolCapabilities({ protocol_capabilities: ['a', 1, null, 'b'] })).toEqual(['a', 'b'])
    expect(appProtocolCapabilities({ protocolCapabilities: ['a'] })).toEqual(['a'])
    expect(appProtocolCapabilities({ capabilities: ['a'] })).toEqual(['a'])
  })

  it('returns null — not an empty list — when nothing is declared', () => {
    expect(appProtocolCapabilities({})).toBeNull()
    expect(appProtocolCapabilities(null)).toBeNull()
    expect(appProtocolCapabilities({ protocol_capabilities: 'intake.modal' })).toBeNull()
    expect(allowsIntakeModal(null)).toBe(true)
  })
})

describe('intake values', () => {
  const fields = [field('preferred_name'), field('dob', { type: 'date' })]

  it('treats every declared field as required', () => {
    expect(missingIntakeValues(fields, {})).toEqual(['preferred_name', 'dob'])
    expect(missingIntakeValues(fields, { preferred_name: '   ', dob: '1990-01-01' })).toEqual(['preferred_name'])
    expect(missingIntakeValues(fields, { preferred_name: 'Minh', dob: '1990-01-01' })).toEqual([])
  })

  it('submits exactly the declared fields, trimmed — nothing extra rides along', () => {
    expect(normalizeIntakeValues(fields, { preferred_name: '  Minh ', dob: '1990-01-01', stale: 'x' })).toEqual({
      preferred_name: 'Minh',
      dob: '1990-01-01'
    })
  })
})

describe('field labels', () => {
  it('prefers the label the app declared', () => {
    expect(intakeFieldLabel(field('birth_city', { label: 'Nơi sinh' }))).toBe('Nơi sinh')
  })

  it('falls back to a readable name rather than printing an identifier', () => {
    expect(intakeFieldLabel(field('birth_city'))).toBe('Birth city')
    expect(humanizeFieldName('dob')).toBe('Dob')
    expect(humanizeFieldName('preferred_name')).toBe('Preferred name')
    expect(humanizeFieldName('')).toBe('')
  })
})
