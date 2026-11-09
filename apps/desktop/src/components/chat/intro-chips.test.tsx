import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/app/chat/composer/focus', () => ({ requestComposerInsert: vi.fn() }))
vi.mock('@/store/atum-shell', async () => {
  const { atom } = await import('nanostores')

  return { $atumShellEnabled: atom(true) }
})

import { requestComposerInsert } from '@/app/chat/composer/focus'
import { $managedModelAccess, resetManagedModelAccess } from '@/store/atum-managed-model'
import { $currentModel, $currentProvider } from '@/store/session'

import { atumManagedReadyAction, Intro } from './intro'

const CHIPS = {
  summarize: 'Tóm tắt tài liệu này giúp mình.',
  openFile: 'Mở một tệp trên máy',
  moon: 'Mở Moon xem lá số',
  today: 'Hôm nay mình nên tập trung vào việc gì?'
}

afterEach(() => {
  cleanup()
  resetManagedModelAccess()
  vi.clearAllMocks()
})

describe('managed-ready empty state', () => {
  it('offers exactly one focused useful action', () => {
    const action = atumManagedReadyAction(CHIPS)

    action.run()
    expect(action.label).toBe(CHIPS.today)
    expect(requestComposerInsert).toHaveBeenCalledOnce()
    expect(requestComposerInsert).toHaveBeenCalledWith(CHIPS.today)
  })

  it.each(['unavailable', 'authentication_expired', 'insufficient_funds'] as const)('keeps the employee and starter actions visible when access is %s', state => {
    $managedModelAccess.set({ state: 'resolved', accessAlias: 'binh-minh', access: { state } as never })
    const { container } = render(<Intro seed={0} />)
    expect(container.querySelector('[data-atum-empty]')).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(3)
  })

  it('covers the synthetic managed-ready happy path without provider setup', () => {
    $currentProvider.set('atum-managed')
    $currentModel.set('binh-minh')
    $managedModelAccess.set({
      state: 'resolved',
      accessAlias: 'binh-minh',
      access: { state: 'ready' } as never
    })

    const { container } = render(<Intro seed={0} />)

    expect(container.querySelector('[data-atum-empty]')).toBeTruthy()
    // Mock 1d: three suggestion pills — two prompts and the Files tab.
    expect(screen.getAllByRole('button')).toHaveLength(3)
    expect(container.textContent).not.toMatch(/API key|OpenRouter|OpenAI|choose (?:a )?provider/iu)
  })
})
