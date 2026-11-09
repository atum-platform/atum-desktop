import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixCompanyBridge, MatrixCompanyWallet } from '../../shared/matrix-company'
import { matrixCompanyFundingCopy } from '../../shared/matrix-company-funding-copy'

import { formatCompanyTaskLimit, MatrixCompanyFundingPanel, parseCompanyTaskLimit } from './company-funding'

const i18n = vi.hoisted(() => ({ locale: 'en' }))
vi.mock('@/i18n', () => ({ useI18n: () => ({ locale: i18n.locale }) }))

// Radix checkbox observes its browser size; jsdom has no layout observer.
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', TestResizeObserver)

afterEach(() => {
  cleanup()
  i18n.locale = 'en'
})

/** A balance drawn as the Proton mark and the number; the word stays in the DOM for screen readers. */
function protonPhrase(phrase: string) {
  return (_content: string, element: Element | null) => Boolean(element?.matches('[data-proton-amount]') && element.textContent === phrase)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void

  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })

  return { promise, reject, resolve }
}

function wallet(companyId: string, available = 2_500_001, held = 500_000): MatrixCompanyWallet {
  return {
    schemaVersion: 1,
    companyId,
    unit: 'micro_proton',
    balances: { paid: available, earned: 0, promo: 0, held, available },
    checkoutOpen: false,
    funding: { enabled: false, taskLimit: 2_000_000, revision: 1 }
  }
}

function renderPanel(props: Partial<ComponentProps<typeof MatrixCompanyFundingPanel>> = {}) {
  const bridge: MatrixCompanyBridge = {
    pending: vi.fn(async () => ({ ok: true as const, request: null })),
    request: vi.fn(async input =>
      input.action === 'wallet'
        ? { ok: true as const, value: wallet(input.companyId) }
        : { ok: false as const, error: 'invalid' as const }
    )
  }

  return render(
    <MatrixCompanyFundingPanel
      accountKey="account-a"
      blocked={false}
      bridge={bridge}
      companyId="company-a"
      onConfigure={vi.fn()}
      pendingChange={false}
      refreshKey={0}
      {...props}
    />
  )
}

describe('company funding copy', () => {
  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'])('has complete funding copy for %s', locale => {
    const copy = matrixCompanyFundingCopy(locale)

    expect(copy.title).not.toBe('')
    expect(copy.policyUnknown).not.toBe('')
    expect(copy.checkoutUnavailable).not.toBe('')
    // The validation message shows the person how their locale writes the amount.
    expect(copy.limitInvalid(formatCompanyTaskLimit(1_000_000_000, locale))).toContain(formatCompanyTaskLimit(1_000_000_000, locale))
  })
})

describe('parseCompanyTaskLimit', () => {
  it('preserves exact decimal micro-Protons and rejects rounding, nonpositive values, and overflow', () => {
    expect(parseCompanyTaskLimit('1.000001')).toBe(1_000_001)
    expect(parseCompanyTaskLimit('0.000001')).toBe(1)
    expect(parseCompanyTaskLimit('1.0000001')).toBeNull()
    expect(parseCompanyTaskLimit('0')).toBeNull()
    expect(parseCompanyTaskLimit('')).toBeNull()
    expect(parseCompanyTaskLimit('9007199254.740992')).toBeNull()
    expect(parseCompanyTaskLimit('9007199254.740991')).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('reads Vietnamese numbers as Vietnamese: a dot groups thousands and a comma marks decimals', () => {
    // The money bug: "1.000" typed in Vietnamese is one thousand Protons, never one.
    expect(parseCompanyTaskLimit('1.000', 'vi')).toBe(1_000_000_000)
    expect(parseCompanyTaskLimit('1.000.000', 'vi')).toBe(1_000_000_000_000)
    expect(parseCompanyTaskLimit('1,5', 'vi')).toBe(1_500_000)
    expect(parseCompanyTaskLimit('1.000,25', 'vi')).toBe(1_000_250_000)
    expect(parseCompanyTaskLimit('1000', 'vi')).toBe(1_000_000_000)
    expect(parseCompanyTaskLimit('1 000', 'vi')).toBe(1_000_000_000)
  })

  it('refuses a separator that could be read two ways instead of guessing', () => {
    expect(parseCompanyTaskLimit('1.5', 'vi')).toBeNull()
    expect(parseCompanyTaskLimit('1000.50', 'vi')).toBeNull()
    expect(parseCompanyTaskLimit('1,5', 'en')).toBeNull()
    expect(parseCompanyTaskLimit('1,0000', 'en')).toBeNull()
    expect(parseCompanyTaskLimit('1,000', 'en')).toBe(1_000_000_000)
    expect(parseCompanyTaskLimit('1.000', 'en')).toBe(1_000_000)
  })

  it('ignores the spaces around a pasted amount', () => {
    expect(parseCompanyTaskLimit(' 1.000 ', 'vi')).toBe(1_000_000_000)
  })

  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'])('reads back exactly what it shows in %s', locale => {
    for (const value of [1, 1_000_000, 1_500_000, 1_000_000_000, 1_000_250_000, 9007199253999999, Number.MAX_SAFE_INTEGER]) {
      expect(parseCompanyTaskLimit(formatCompanyTaskLimit(value, locale), locale)).toBe(value)
    }
  })
})

describe('MatrixCompanyFundingPanel', () => {
  it.each(['unavailable', 'authentication'] as const)('keeps %s distinct from a genuine zero wallet', async error => {
    const bridge: MatrixCompanyBridge = { pending: vi.fn(async () => ({ ok: true as const, request: null })),
      request: vi.fn<MatrixCompanyBridge['request']>(async () => ({ ok: false, error })) }

    renderPanel({ bridge })
    await screen.findByRole('alert')
    expect(screen.queryByText(protonPhrase('0 Protons'))).toBeNull()
    expect(screen.getByRole('button', { name: 'Save spending settings' }).hasAttribute('disabled')).toBe(true)

    if (error === 'authentication') { expect(screen.getByText('Sign in again to see shared spending.')).toBeTruthy() }
  })

  it('shows actual untouched zero with no invented cap and preserves an existing cap near a floating point boundary', async () => {
    const current = wallet('company-a', 0, 0)
    current.funding = { enabled: false, taskLimit: null, revision: 0 }
    const request = vi.fn<MatrixCompanyBridge['request']>(async () => ({ ok: true, value: current }))
    const bridge: MatrixCompanyBridge = { pending: vi.fn(async () => ({ ok: true as const, request: null })), request }
    const onConfigure = vi.fn()
    const { rerender } = renderPanel({ bridge, onConfigure })
    await screen.findAllByText(protonPhrase('0 Protons'))
    expect((screen.getByLabelText('Limit per task') as HTMLInputElement).value).toBe('')
    current.funding = { enabled: false, taskLimit: 9007199253999999, revision: 1 }
    rerender(<MatrixCompanyFundingPanel accountKey="account-a" blocked={false} bridge={bridge} companyId="company-a"
      onConfigure={onConfigure} pendingChange={false} refreshKey={1} />)
    await waitFor(() => expect((screen.getByLabelText('Limit per task') as HTMLInputElement).value).toBe('9,007,199,253.999999'))
    fireEvent.click(screen.getByRole('button', { name: 'Save spending settings' }))
    expect(onConfigure).toHaveBeenCalledExactlyOnceWith(false, 9007199253999999)
  })

  it('fences a late wallet response across an account and company switch', async () => {
    const old = deferred<Awaited<ReturnType<MatrixCompanyBridge['request']>>>()

    const oldBridge: MatrixCompanyBridge = {
      pending: vi.fn(async () => ({ ok: true as const, request: null })),
      request: vi.fn(() => old.promise)
    }

    const newBridge: MatrixCompanyBridge = {
      pending: vi.fn(async () => ({ ok: true as const, request: null })),
      request: vi.fn(async input => ({ ok: true as const, value: wallet(input.action === 'wallet' ? input.companyId : 'company-b', 7_000_000, 0) }))
    }

    const { rerender } = renderPanel({ bridge: oldBridge })

    rerender(
      <MatrixCompanyFundingPanel
        accountKey="account-b"
        blocked={false}
        bridge={newBridge}
        companyId="company-b"
        onConfigure={vi.fn()}
        pendingChange={false}
        refreshKey={0}
      />
    )
    await screen.findByText(protonPhrase('7 Protons'))
    await act(async () => old.resolve({ ok: true, value: wallet('company-a', 9_000_000, 0) }))
    expect(screen.queryByText(protonPhrase('9 Protons'))).toBeNull()
    expect(screen.getByText(protonPhrase('7 Protons'))).toBeTruthy()
  })

  it('clears a previous wallet before a denied refresh is rendered as an error', async () => {
    const request = vi
      .fn<MatrixCompanyBridge['request']>()
      .mockResolvedValueOnce({ ok: true, value: wallet('company-a') })
      .mockResolvedValueOnce({ ok: false, error: 'denied' })

    const bridge: MatrixCompanyBridge = { pending: vi.fn(async () => ({ ok: true as const, request: null })), request }
    const { rerender } = renderPanel({ bridge })

    await screen.findByText(protonPhrase('2.500001 Protons'))
    rerender(
      <MatrixCompanyFundingPanel
        accountKey="account-a"
        blocked={false}
        bridge={bridge}
        companyId="company-a"
        onConfigure={vi.fn()}
        pendingChange={false}
        refreshKey={1}
      />
    )
    expect(screen.queryByText(protonPhrase('2.500001 Protons'))).toBeNull()
    await screen.findByRole('alert')
    expect(screen.queryByText(protonPhrase('2.500001 Protons'))).toBeNull()
    expect(screen.getByText('You no longer have access to this company’s spending.')).toBeTruthy()
  })

  it('only reads the wallet and delegates a valid configuration through the parent callback', async () => {
    const onConfigure = vi.fn()
    const request = vi.fn<MatrixCompanyBridge['request']>(async input => ({ ok: true as const, value: wallet(input.action === 'wallet' ? input.companyId : 'company-a') }))
    const bridge: MatrixCompanyBridge = { pending: vi.fn(async () => ({ ok: true as const, request: null })), request }

    renderPanel({ bridge, onConfigure })
    await screen.findByText(protonPhrase('2.500001 Protons'))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Let assistants spend company Protons' }))
    fireEvent.change(screen.getByLabelText('Limit per task'), { target: { value: '1.000001' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save spending settings' }))

    expect(onConfigure).toHaveBeenCalledExactlyOnceWith(true, 1_000_001)
    expect(request).toHaveBeenCalledExactlyOnceWith({ action: 'wallet', companyId: 'company-a' })
  })

  it('saves the Vietnamese "1.000" as a one-thousand Proton limit and explains a value it cannot read', async () => {
    i18n.locale = 'vi'
    const onConfigure = vi.fn()
    const current = wallet('company-a')
    current.funding = { enabled: true, taskLimit: 2_000_000_000, revision: 1 }
    const request = vi.fn<MatrixCompanyBridge['request']>(async () => ({ ok: true as const, value: current }))
    const bridge: MatrixCompanyBridge = { pending: vi.fn(async () => ({ ok: true as const, request: null })), request }

    renderPanel({ bridge, onConfigure })
    const limit = (await screen.findByLabelText('Giới hạn mỗi việc')) as HTMLInputElement
    await waitFor(() => expect(limit.value).toBe('2.000'))
    fireEvent.change(limit, { target: { value: '1.5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Lưu cài đặt chi tiêu' }))
    expect(onConfigure).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('Nhập số Proton, ví dụ 1.000.')
    fireEvent.change(limit, { target: { value: '1.000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Lưu cài đặt chi tiêu' }))
    expect(onConfigure).toHaveBeenCalledExactlyOnceWith(true, 1_000_000_000)
  })

  it('shows unknown policy and never delegates configuration while pending or blocked', async () => {
    const onConfigure = vi.fn()
    const request = vi.fn<MatrixCompanyBridge['request']>(async input => ({ ok: true as const, value: wallet(input.action === 'wallet' ? input.companyId : 'company-a') }))
    const bridge: MatrixCompanyBridge = { pending: vi.fn(async () => ({ ok: true as const, request: null })), request }
    const { rerender } = renderPanel({ bridge, onConfigure, pendingChange: true })

    await screen.findByText('Checking the current settings…')
    expect(screen.getByRole('checkbox', { name: 'Let assistants spend company Protons' }).getAttribute('aria-checked')).toBe('mixed')
    expect(screen.getByRole('button', { name: 'Save spending settings' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save spending settings' }))
    expect(onConfigure).not.toHaveBeenCalled()

    rerender(
      <MatrixCompanyFundingPanel
        accountKey="account-a"
        blocked
        bridge={bridge}
        companyId="company-a"
        onConfigure={onConfigure}
        pendingChange={false}
        refreshKey={1}
      />
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save spending settings' }).hasAttribute('disabled')).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Save spending settings' }))
    expect(onConfigure).not.toHaveBeenCalled()
    expect(request.mock.calls.every(([input]) => input.action === 'wallet')).toBe(true)
  })
})
