import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AtumAccountForm } from './atum-account-form'

const copy = {
  identifier: 'Tên đăng nhập',
  identifierHint: '@tên, email hoặc số điện thoại',
  identifierPlaceholder: '@tenban · fixture-5475e50c25@example.invalid · 0912…',
  identifierRequired: 'Nhập tên đăng nhập, email hoặc số điện thoại.',
  password: 'Mật khẩu',
  passwordRequired: 'Nhập mật khẩu.',
  signIn: 'Đăng nhập',
  signingIn: 'Đang đăng nhập...'
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  sessionStorage.clear()
})

describe('AtumAccountForm', () => {
  it('identifies an editable password before and after typing in the auth gate', () => {
    render(<AtumAccountForm appearance="atum" copy={copy} failureKind="network" onSubmit={vi.fn()} pending={false} />)
    const password = screen.getByLabelText('Mật khẩu') as HTMLInputElement
    expect(password.placeholder).toBe('Mật khẩu')
    expect(password.disabled).toBe(false)
    expect(screen.getByText('Mật khẩu').className).not.toContain('sr-only')
    fireEvent.change(password, { target: { value: 'test-only-password' } })
    expect(password.value).toBe('test-only-password')
    expect(password.type).toBe('password')
    expect(screen.getByText('Mật khẩu').className).not.toContain('sr-only')
  })
  it('submits credentials once and clears the password when the request settles', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true)
    render(<AtumAccountForm copy={copy} failureKind={null} onSubmit={onSubmit} pending={false} />)

    fireEvent.change(screen.getByRole('textbox', { name: /Tên đăng nhập/ }), { target: { value: ' @minh ' } })
    fireEvent.change(screen.getByLabelText('Mật khẩu'), { target: { value: 'one-shot-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ identifier: '@minh', password: 'one-shot-secret' }))
    await waitFor(() => expect((screen.getByLabelText('Mật khẩu') as HTMLInputElement).value).toBe(''))
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('disables every credential control while the native request is pending', () => {
    render(<AtumAccountForm copy={copy} failureKind={null} onSubmit={vi.fn().mockResolvedValue(false)} pending />)

    expect((screen.getByRole('textbox', { name: /Tên đăng nhập/ }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('Mật khẩu') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Đang đăng nhập...' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('validates required fields, links the error, and focuses the first invalid field', async () => {
    const onSubmit = vi.fn()
    render(
      <AtumAccountForm copy={copy} failureKind={null} onSubmit={onSubmit.mockResolvedValue(false)} pending={false} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }))
    const identifier = screen.getByRole('textbox', { name: /Tên đăng nhập/ })
    expect(identifier.getAttribute('aria-invalid')).toBe('true')
    expect(identifier.getAttribute('aria-describedby')).toContain('atum-identifier-error')
    expect(globalThis.document.activeElement).toBe(identifier)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('clears the password after credential failure but preserves it for a network failure', () => {
    const submit = vi.fn().mockResolvedValue(false)
    const { rerender } = render(<AtumAccountForm copy={copy} failureKind={null} onSubmit={submit} pending={false} />)
    const identifier = screen.getByRole('textbox', { name: /Tên đăng nhập/ })
    const password = screen.getByLabelText('Mật khẩu') as HTMLInputElement
    fireEvent.change(identifier, { target: { value: '@minh' } })
    fireEvent.change(password, { target: { value: 'one-shot-secret' } })

    rerender(<AtumAccountForm copy={copy} failureKind="network" onSubmit={submit} pending={false} />)
    expect(password.value).toBe('one-shot-secret')
    rerender(<AtumAccountForm copy={copy} failureKind="credentials" onSubmit={submit} pending={false} />)
    expect(password.value).toBe('')
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})
