import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { MatrixSnapshot } from '../../../shared/matrix'

import { PET_FAILED_MS } from './presentation'
import { usePetWork } from './use-work'

function Work({ snapshot }: { snapshot: MatrixSnapshot }) {
  return <output data-work={usePetWork(snapshot)} />
}

const work = () => window.document.querySelector('[data-work]')!.getAttribute('data-work')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('shows a fresh unsent message briefly, then lets her go back to her day with no new snapshot', () => {
  const snapshot = {
    roomId: '!here',
    rooms: [],
    messages: [],
    state: 'ready',
    identity: null,
    error: null,
    localTurns: [
      {
        turnId: 'turn',
        roomId: '!here',
        text: '',
        createdAt: 1_000_000 - 120_000,
        state: 'not_sent',
        failedAt: 1_000_000,
        synced: { question: false, answer: false }
      }
    ]
  } as MatrixSnapshot

  render(<Work snapshot={snapshot} />)
  expect(work()).toBe('failed')

  act(() => void vi.advanceTimersByTime(PET_FAILED_MS - 1_000))
  expect(work()).toBe('failed')

  act(() => void vi.advanceTimersByTime(2_000))
  expect(work()).toBe('idle')
  expect(vi.getTimerCount()).toBe(0)
})
