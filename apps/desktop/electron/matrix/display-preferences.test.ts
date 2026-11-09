import { expect, it, vi } from 'vitest'

import { DESKTOP_LOCALES } from '../../shared/desktop-locale'
import type { MatrixSnapshot } from '../../shared/matrix'

import { applyMatrixDisplayZoom, requireMatrixDisplayIdentity } from './display-preferences'
import { parseMatrixCommand } from './ipc-policy'

const identity = { userId: '@alice:test', deviceId: 'ONE' }

it.each(['notifications', 'sound'])(
  'admits only a literal %s boolean through the existing identity-bound command parser',
  field => {
    for (const value of [true, false]) {
      expect(parseMatrixCommand({ kind: 'displayPreference', identity, field, value })).toEqual({
        kind: 'displayPreference',
        identity,
        field,
        value
      })
    }

    for (const value of ['false', 0, 1, null, {}, []]) {
      expect(() => parseMatrixCommand({ kind: 'displayPreference', identity, field, value })).toThrow('invalid')
    }
  }
)

it('accepts each canonical desktop language with the rendered identity and no renderer-selected event type', () => {
  for (const value of DESKTOP_LOCALES) {
    expect(
      parseMatrixCommand({ kind: 'displayPreference', identity, field: 'language', value, eventType: 'm.other' })
    ).toEqual({ kind: 'displayPreference', identity, field: 'language', value })
  }

  for (const value of ['', 'de', 'en-US', 'vi-VN', 'JA', null, {}, 42]) {
    expect(() => parseMatrixCommand({ kind: 'displayPreference', identity, field: 'language', value })).toThrow(
      'invalid'
    )
  }
})

it('accepts only closed fields, bounded identities and literal values, stripping arbitrary renderer metadata', () => {
  expect(
    parseMatrixCommand({
      kind: 'displayPreference',
      identity,
      field: 'appearance',
      value: 'dark',
      token: 'fixture',
      raw: {}
    })
  ).toEqual({ kind: 'displayPreference', identity, field: 'appearance', value: 'dark' })

  for (const bad of [
    { field: 'arbitrary', value: 'dark' },
    { field: 'appearance', value: 'invalid' },
    { field: 'textSize', value: '110' },
    { field: 'textSize', value: 1000 },
    { identity: null },
    { identity: { userId: 'alice', deviceId: 'ONE' } },
    { identity: { userId: '@alice:test', deviceId: '' } },
    { identity: { userId: '@alice:test', deviceId: 'X'.repeat(300) } }
  ]) {
    expect(() =>
      parseMatrixCommand({ kind: 'displayPreference', identity, field: 'textSize', value: 110, ...bad })
    ).toThrow()
  }
})

it('refuses stale account/device or withdrawn identity at the native boundary', () => {
  expect(() => requireMatrixDisplayIdentity(identity, identity)).not.toThrow()

  for (const actual of [null, undefined, { ...identity, userId: '@bob:test' }, { ...identity, deviceId: 'TWO' }]) {
    expect(() => requireMatrixDisplayIdentity(identity, actual)).toThrow('stale')
  }
})

it('uses existing Chromium zoom conversion, avoids redundant writes and resets on sign-out or malformed scale', () => {
  let factor = 1
  const contents = { getZoomFactor: () => factor, setZoomLevel: vi.fn((level: number) => (factor = 1.2 ** level)) }

  const snapshot = (value: unknown, signedIn = true) =>
    ({ identity: signedIn ? identity : null, displayPreferences: { textSize: { value } } }) as MatrixSnapshot

  applyMatrixDisplayZoom(contents, snapshot(110))
  expect(factor).toBeCloseTo(1.1)
  applyMatrixDisplayZoom(contents, snapshot(110))
  expect(contents.setZoomLevel).toHaveBeenCalledOnce()
  applyMatrixDisplayZoom(contents, snapshot(90))
  expect(factor).toBeCloseTo(0.9)
  applyMatrixDisplayZoom(contents, snapshot(110, false))
  expect(factor).toBeCloseTo(1)

  for (const malformed of [undefined, NaN, 0, 900, '110']) {
    applyMatrixDisplayZoom(contents, snapshot(malformed))
    expect(factor).toBeCloseTo(1)
  }
})
