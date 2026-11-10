import { describe, expect, it } from 'vitest'

import type { MatrixInvocationResult } from '../../shared/matrix'

import { invocationCopy, invocationNoticeVisible } from './invocation-notice'

const states: MatrixInvocationResult['state'][] = [
  'cancelled',
  'expired',
  'unknown',
  'publication_pending',
  'published',
  'setup_required',
  'ignored'
]

describe('a run outcome notice', () => {
  it('keeps a posted reply out of sight (the reply itself says so) but still announces it', () => {
    expect(invocationNoticeVisible('published')).toBe(false)
    expect(invocationCopy({ state: 'published' }, 'en')).toBe('Reply posted.')
  })

  it('shows every outcome the chat does not already show', () => {
    for (const state of states.filter(state => state !== 'published')) {
      expect(invocationNoticeVisible(state)).toBe(true)
      expect(invocationCopy({ state }, 'en')).toBeTruthy()
    }
  })
})
