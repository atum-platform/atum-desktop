import { describe, expect, it } from 'vitest'

import { formatMatrixPetDiagnostic, type MatrixPetDiagnostic, parseMatrixPetDiagnostic } from './matrix-pet-diagnostic'

const start: MatrixPetDiagnostic = {
  event: 'start',
  reason: 'remount',
  restore: 'saved',
  agent: '895ac081',
  work: 'idle',
  pose: 'idle',
  surface: 'floor',
  x: 3,
  window: 'focused',
  repeats: 0
}

const state: MatrixPetDiagnostic = {
  event: 'state',
  agent: '895ac081',
  work: 'failed',
  pose: 'failed',
  surface: 'composer',
  x: null,
  window: 'unfocused',
  repeats: 4
}

describe('companion diagnostics lines', () => {
  it('accepts exactly the closed shape and writes every field as a code', () => {
    expect(parseMatrixPetDiagnostic(start)).toEqual(start)
    expect(parseMatrixPetDiagnostic(state)).toEqual(state)
    expect(formatMatrixPetDiagnostic(start)).toBe(
      '[Matrix] pet agent=895ac081 event=start reason=remount restore=saved work=idle pose=idle surface=floor x=3 window=focused'
    )
    expect(formatMatrixPetDiagnostic(state)).toBe(
      '[Matrix] pet agent=895ac081 event=state work=failed pose=failed surface=composer x=na window=unfocused repeats=4'
    )
  })

  it.each([
    ['free text in a code', { ...state, pose: 'hello there' }],
    ['an extra field', { ...state, text: 'a message' }],
    ['a start reason on a state line', { ...state, reason: 'mount' }],
    ['a start without its reason', { ...start, reason: undefined }],
    ['an unlisted restart reason', { ...start, reason: 'focus' }],
    ['a full principal', { ...state, agent: '00000000-0000-4000-8000-efa29b6dcd4a' }],
    ['an agent with spaces', { ...state, agent: 'a b' }],
    ['a raw coordinate', { ...state, x: 412.5 }],
    ['an out-of-range tenth', { ...state, x: 10 }],
    ['an unlisted window state', { ...state, window: 'minimised' }],
    ['no window state', { ...state, window: undefined }],
    ['a negative count', { ...state, repeats: -1 }],
    ['an unknown event', { ...state, event: 'message' }],
    ['not an object', 'pet ok'],
    ['an array', [state]]
  ])('says nothing for %s', (_label, value) => {
    expect(parseMatrixPetDiagnostic(value)).toBeUndefined()
  })
})
