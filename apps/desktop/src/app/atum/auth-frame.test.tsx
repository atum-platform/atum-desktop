import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AuthFrame } from './auth-frame'

describe('AuthFrame', () => {
  it('keeps the compact Atum material while leaving interaction to its caller', () => {
    const onKeyDown = vi.fn()

    const { container } = render(
      <AuthFrame
        description="Continue securely in your browser."
        exiting
        footer={<p>Terms apply.</p>}
        onKeyDown={onKeyDown}
        title="Sign in"
      >
        <button type="button">Continue</button>
      </AuthFrame>
    )

    const frame = container.querySelector('[data-atum-auth]')!
    const petStage = frame.querySelector('[data-pet-stage]')!

    expect(frame.querySelector('[data-atum-auth-lights]')).not.toBeNull()
    expect(frame.querySelector('[data-atum-motion="exiting"]')).not.toBeNull()
    expect(frame.hasAttribute('data-pet-stage')).toBe(false)
    expect(petStage.classList.contains('[-webkit-app-region:no-drag]')).toBe(true)
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy()
    expect(screen.getByText('Continue securely in your browser.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy()
    expect(screen.getByText('Terms apply.')).toBeTruthy()

    fireEvent.keyDown(frame, { key: 'Escape' })
    expect(onKeyDown).toHaveBeenCalledOnce()
  })
})
