import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DesktopLocale } from '../../shared/desktop-locale'

import { MatrixNewSignInDetail, matrixNewSignInDevice, matrixNewSignInLabel } from './new-sign-in-notice'

afterEach(() => {
  cleanup()
})

// What the sign-in server actually names a phone whose software it can't read (owner screenshot
// 2026-11-05): "<client> on Unknown device".
const PHONE = 'Atum for iPhone on Unknown device'

const expected: Record<
  DesktopLocale,
  { phone: string; named: string; unknown: string; itWasMe: string; signOut: string; ask: string }
> = {
  en: {
    phone: 'New sign-in on an iPhone. Was this you?',
    named: 'New sign-in on MacBook Air. Was this you?',
    unknown: 'New sign-in on another device. Was this you?',
    itWasMe: 'It was me',
    signOut: 'Sign it out',
    ask: 'Was this you?'
  },
  vi: {
    phone: 'Đăng nhập mới trên một iPhone. Có phải bạn không?',
    named: 'Đăng nhập mới trên MacBook Air. Có phải bạn không?',
    unknown: 'Đăng nhập mới trên một thiết bị khác. Có phải bạn không?',
    itWasMe: 'Là tôi',
    signOut: 'Đăng xuất thiết bị đó',
    ask: 'Có phải bạn không?'
  },
  ja: {
    phone: 'iPhoneで新しいサインインがありました。あなたですか？',
    named: 'MacBook Airで新しいサインインがありました。あなたですか？',
    unknown: '別のデバイスで新しいサインインがありました。あなたですか？',
    itWasMe: '自分です',
    signOut: 'サインアウトさせる',
    ask: 'あなたですか？'
  },
  zh: {
    phone: 'iPhone上有新的登录。是你本人吗？',
    named: 'MacBook Air上有新的登录。是你本人吗？',
    unknown: '其他设备上有新的登录。是你本人吗？',
    itWasMe: '是我',
    signOut: '让它退出登录',
    ask: '是你本人吗？'
  },
  'zh-hant': {
    phone: 'iPhone上有新的登入。是你本人嗎？',
    named: 'MacBook Air上有新的登入。是你本人嗎？',
    unknown: '其他裝置上有新的登入。是你本人嗎？',
    itWasMe: '是我',
    signOut: '讓它登出',
    ask: '是你本人嗎？'
  }
}

describe('the device, in words', () => {
  it.each([
    ['Atum for iPhone on Unknown device', 'an iPhone'],
    ['Atum for iPhone on iPhone', 'an iPhone'],
    ['Atum for iPad on Unknown device', 'an iPad'],
    ['Atum for Mac on macOS', 'a Mac'],
    ['Atum for desktop', 'a computer'],
    ['Element X on Unknown device', 'Element X'],
    ['MacBook Air', 'MacBook Air'],
    ['Unknown device', 'another device'],
    ['   ', 'another device'],
    [undefined, 'another device']
  ])('%s → %s', (name, words) => {
    expect(matrixNewSignInDevice(name, 'en')).toBe(words)
  })

  it('never says the server’s “Unknown device” in any language', () => {
    for (const locale of Object.keys(expected) as DesktopLocale[]) {
      expect(matrixNewSignInLabel({ deviceId: 'PHONE', name: PHONE }, locale)).not.toMatch(/unknown/i)
    }
  })

  it('keeps a long name to one short line', () => {
    const words = matrixNewSignInDevice('x'.repeat(200), 'en')

    expect(words.length).toBeLessThanOrEqual(40)
    expect(words.endsWith('…')).toBe(true)
  })
})

describe('the popover’s line and answers', () => {
  for (const locale of Object.keys(expected) as DesktopLocale[]) {
    it(`says it in ${locale} for an Atum phone, a named device and an unnamed one`, () => {
      const props = { locale, onDismiss: vi.fn(), onSignOut: vi.fn() }
      const { rerender } = render(<MatrixNewSignInDetail {...props} view={{ deviceId: 'PHONE', name: PHONE }} />)

      expect(screen.getByText(expected[locale].phone)).toBeTruthy()
      expect(screen.getByRole('button', { name: expected[locale].itWasMe })).toBeTruthy()
      expect(screen.getByRole('button', { name: expected[locale].signOut })).toBeTruthy()

      rerender(<MatrixNewSignInDetail {...props} view={{ deviceId: 'LAPTOP', name: 'MacBook Air' }} />)
      expect(screen.getByText(expected[locale].named)).toBeTruthy()

      rerender(<MatrixNewSignInDetail {...props} view={{ deviceId: 'LAPTOP' }} />)
      expect(screen.getByText(expected[locale].unknown)).toBeTruthy()

      rerender(<MatrixNewSignInDetail {...props} headed view={{ deviceId: 'LAPTOP' }} />)
      expect(screen.getByText(expected[locale].ask)).toBeTruthy()
    })
  }

  it('“It was me” accounts for that device; “Sign it out” opens that device’s sign-out step', async () => {
    const onSignOut = vi.fn(async () => {})
    const onDismiss = vi.fn(async () => {})
    render(
      <MatrixNewSignInDetail
        locale="en"
        onDismiss={onDismiss}
        onSignOut={onSignOut}
        view={{ deviceId: 'PHONE', name: PHONE }}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Sign it out' }))
    await vi.waitFor(() => expect(onSignOut).toHaveBeenCalledExactlyOnceWith('PHONE'))
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: 'It was me' }).hasAttribute('disabled')).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: 'It was me' }))
    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledExactlyOnceWith('PHONE'))
  })

  it('stays, and says so in one line, when the sign-out step cannot open', async () => {
    const onSignOut = vi.fn(async () => {
      throw new Error('matrix_offline')
    })

    render(
      <MatrixNewSignInDetail
        locale="en"
        onDismiss={vi.fn()}
        onSignOut={onSignOut}
        view={{ deviceId: 'PHONE', name: PHONE }}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Sign it out' }))

    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t open the sign-out page. Try again.')
    expect(screen.getByText('New sign-in on an iPhone. Was this you?')).toBeTruthy()
  })
})
