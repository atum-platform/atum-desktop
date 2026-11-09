import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfirmDialog } from './confirm-dialog'

describe('ConfirmDialog done beat', () => {
  beforeEach(() => void vi.useFakeTimers())

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  async function confirmAndSettle(onClose: () => void) {
    const view = render(<ConfirmDialog onClose={onClose} onConfirm={async () => {}} open title="Delete chat" />)

    fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
    await act(async () => {})

    return view
  }

  it('closes after the done beat', async () => {
    const onClose = vi.fn()

    await confirmAndSettle(onClose)
    expect(onClose).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(600))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not call back once unmounted during the done beat', async () => {
    const onClose = vi.fn()
    const view = await confirmAndSettle(onClose)

    view.unmount()
    act(() => void vi.advanceTimersByTime(600))
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('ConfirmDialog when the action stops being available', () => {
  afterEach(cleanup)

  it('says why and turns Confirm off, by button and by keyboard, while Cancel still works', () => {
    const onConfirm = vi.fn(async () => {})
    const onClose = vi.fn()

    render(<ConfirmDialog blockedReason="Your role changed." onClose={onClose} onConfirm={onConfirm} open title="Make Lan the owner?" />)

    expect(screen.getByRole('alert').textContent).toContain('Your role changed.')
    expect(screen.getByRole('button', { name: /confirm/i }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('confirms normally while nothing blocks it, and again once the block lifts', async () => {
    const onConfirm = vi.fn(async () => {})
    const view = render(<ConfirmDialog blockedReason="No." onClose={() => {}} onConfirm={onConfirm} open title="Archive?" />)

    view.rerender(<ConfirmDialog onClose={() => {}} onConfirm={onConfirm} open title="Archive?" />)
    expect(screen.queryByRole('alert')).toBeNull()

    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /confirm/i })))
    expect(onConfirm).toHaveBeenCalledOnce()
  })
})
