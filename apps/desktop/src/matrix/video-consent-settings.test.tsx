import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type {
  MatrixVideoConsentAllowResult,
  MatrixVideoConsentRevokeResult,
  MatrixVideoConsentStatus
} from '../../shared/matrix-video-consent'

import { VideoConsentSettings } from './video-consent-settings'

afterEach(cleanup)

const ALLOWED_AT = Date.UTC(2026, 10, 17, 3)

const status = (value: Partial<MatrixVideoConsentStatus> = {}): MatrixVideoConsentStatus => ({
  current: true,
  locale: 'en',
  confirmedAt: ALLOWED_AT,
  ...value
})

function bridge(
  reads: Array<MatrixVideoConsentStatus | Error>,
  revokes: Array<MatrixVideoConsentRevokeResult | Promise<MatrixVideoConsentRevokeResult>> = [],
  allows: MatrixVideoConsentAllowResult[] = []
) {
  return {
    videoConsent: vi.fn(async () => {
      const next = reads.length > 1 ? reads.shift()! : reads[0]!

      if (next instanceof Error) {
        throw next
      }

      return next
    }),
    revokeVideoConsent: vi.fn(async () => (await revokes.shift()) ?? ({ status: 'unavailable' } as const)),
    allowVideoConsent: vi.fn(async () => allows.shift() ?? ({ status: 'unavailable' } as const))
  }
}

function show(value: ReturnType<typeof bridge>, locale: 'en' | 'vi' = 'en') {
  render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <VideoConsentSettings bridge={value} scopeKey="owner" />
    </I18nProvider>
  )
}

const row = () => document.querySelector<HTMLElement>('[data-matrix-video-consent-settings]')
const toggle = () => document.querySelector<HTMLButtonElement>('[data-matrix-video-consent-switch]')!

describe('Settings › Connections: video generation', () => {
  it('shows when video was allowed; Turning off… stays until the platform confirms, then off', async () => {
    let finish: (value: MatrixVideoConsentRevokeResult) => void = () => {}
    const slow = new Promise<MatrixVideoConsentRevokeResult>(resolve => { finish = resolve })
    const value = bridge([status()], [slow])
    show(value)

    await waitFor(() => expect(row()?.dataset.matrixVideoConsentSettings).toBe('allowed'))
    expect(row()!.textContent).toContain('Allowed')
    expect(toggle().getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle())
    await waitFor(() => expect(row()?.dataset.matrixVideoConsentSettings).toBe('turning_off'))
    expect(screen.getByText('Turning off…')).toBeTruthy()
    expect(toggle().disabled).toBe(true)

    await act(async () => finish({ status: 'revoked' }))
    await waitFor(() => expect(row()?.dataset.matrixVideoConsentSettings).toBe('off'))
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(value.revokeVideoConsent).toHaveBeenCalledOnce()
  })

  it('keeps asking main (which reuses its saved key) while the platform has not confirmed', async () => {
    const pending = Array.from({ length: 8 }, () => ({ status: 'pending' as const }))
    const value = bridge([status()], [...pending, { status: 'revoked' }])
    show(value)

    await waitFor(() => expect(row()?.dataset.matrixVideoConsentSettings).toBe('allowed'))
    fireEvent.click(toggle())
    await waitFor(() => expect(row()?.dataset.matrixVideoConsentSettings).toBe('pending'))
    expect(screen.getByText('Still turning off. Try again in a moment.')).toBeTruthy()
    expect(toggle().getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle())
    await waitFor(() => expect(row()?.dataset.matrixVideoConsentSettings).toBe('off'))
    expect(value.revokeVideoConsent).toHaveBeenCalledTimes(9)
  })

  it('resumes a turn-off main still holds from before a restart', async () => {
    const value = bridge([status({ revoking: true })], [{ status: 'revoked' }])
    show(value)

    await waitFor(() => expect(row()?.dataset.matrixVideoConsentSettings).toBe('off'))
    expect(value.revokeVideoConsent).toHaveBeenCalledOnce()
  })

  it('never shows a failed read as off', async () => {
    const value = bridge([new Error('matrix_video_consent_unavailable'), status({ current: false, confirmedAt: null })])
    show(value)

    await waitFor(() => expect(row()?.dataset.matrixVideoConsentSettings).toBe('failed'))
    expect(document.querySelector('[data-matrix-video-consent-switch]')).toBeNull()
    expect(screen.getByText('Couldn’t check this right now.')).toBeTruthy()

    fireEvent.click(screen.getByText('Try again'))
    await waitFor(() => expect(row()?.dataset.matrixVideoConsentSettings).toBe('off'))
    expect(value.revokeVideoConsent).not.toHaveBeenCalled()
  })

  it('turns back on only through the same explicit card', async () => {
    const off = status({ current: false, confirmedAt: null, locale: 'vi' })
    const value = bridge([off, off, status({ locale: 'vi' })], [], [{ status: 'allowed', consent: status({ locale: 'vi' }) }])
    show(value)

    await waitFor(() => expect(row()?.dataset.matrixVideoConsentSettings).toBe('off'))
    fireEvent.click(toggle())
    expect(value.allowVideoConsent).not.toHaveBeenCalled()

    const box = await waitFor(() => {
      const found = document.querySelector<HTMLButtonElement>('[data-matrix-video-consent-checkbox]')
      expect(found).toBeTruthy()

      return found!
    })
    expect(document.querySelector('[data-matrix-video-consent-sentence]')!.getAttribute('lang')).toBe('vi')
    expect(box.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(box)
    fireEvent.click(document.querySelector('[data-matrix-video-consent-allow]')!)

    await waitFor(() => expect(row()?.dataset.matrixVideoConsentSettings).toBe('allowed'), { timeout: 4000 })
    expect(value.allowVideoConsent).toHaveBeenCalledOnce()
  })

  it('words the row in Vietnamese', async () => {
    show(bridge([status({ current: false, confirmedAt: null })]), 'vi')

    await waitFor(() => expect(screen.getByText('Chưa bật. Atum sẽ hỏi một lần, vào lần đầu trợ lý tạo video.')).toBeTruthy())
    expect(screen.getByText('Tạo video')).toBeTruthy()
  })
})
