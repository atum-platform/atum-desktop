import { createHash } from 'node:crypto'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixMessage } from '../../shared/matrix'
import type { MatrixVideoConsentAllowResult, MatrixVideoConsentStatus } from '../../shared/matrix-video-consent'

import { useVideoConsentAsk } from './video-consent-ask'
import { type VideoConsentBridge, VideoConsentCard } from './video-consent-card'

afterEach(cleanup)

/** The platform's hashes of wording `minimax-video-v1` (SHA-256 of each UTF-8 sentence). */
const PINNED = {
  en: {
    checkbox: 'c6a62b6ab9e77b2cf058c155b230005a2b4af01a91c27184fdc6185ada83a5ca',
    disclosure: '0f233f9f8402ed9dc5ed3e78370ac08ae1982ae865f1bcd257366648bb12f880'
  },
  vi: {
    checkbox: '8b1ddba977956f6eb18788f37a8cf103324340cb4c4ccc8c9ca419c60a65d1f1',
    disclosure: '5edfc042a10c709893beb2f961fa06227cf62552ea7aac0b09c3b26b66e366ac'
  }
} as const

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

type Line = Pick<MatrixMessage, 'id' | 'presentation'>

const asks = (id = '$line-a'): Line => ({ id, presentation: { version: 1, code: 'video_consent_required', args: {} } })

const status = (value: Partial<MatrixVideoConsentStatus> = {}): MatrixVideoConsentStatus => ({
  current: false,
  locale: 'en',
  confirmedAt: null,
  ...value
})

/**
 * Only the two consent calls exist on this bridge; any other use (a chat send, anything) is recorded
 * as a call that should never happen.
 */
function bridge(reads: Array<MatrixVideoConsentStatus | Error>, allows: MatrixVideoConsentAllowResult[] = []) {
  const other = vi.fn()

  const consent = {
    videoConsent: vi.fn(async () => {
      const next = reads.length > 1 ? reads.shift()! : reads[0]!

      if (next instanceof Error) {
        throw next
      }

      return next
    }),
    allowVideoConsent: vi.fn(async () => allows.shift() ?? ({ status: 'unavailable' } as const))
  }

  const value = new Proxy(consent, {
    get: (target, name) => (name in target ? target[name as keyof typeof target] : other)
  }) as VideoConsentBridge & typeof consent

  return { value, other }
}

function Conversation({ line, value, room = '!room-a' }: { line?: Line; value: VideoConsentBridge; room?: string }) {
  // The same latch and card the conversation renders under its working line (app.tsx).
  const ask = useVideoConsentAsk(room, line)

  return ask.asking ? <VideoConsentCard bridge={value} onDismiss={ask.close} onSettled={ask.close} settleMs={0} /> : null
}

function show(props: { line?: Line; value: VideoConsentBridge; room?: string }, locale: 'en' | 'vi' = 'en') {
  const view = (next: typeof props) => (
    <I18nProvider configClient={null} initialLocale={locale}>
      <Conversation {...next} />
    </I18nProvider>
  )

  const result = render(view(props))

  return { rerender: (next: typeof props) => result.rerender(view(next)) }
}

const card = () => document.querySelector<HTMLElement>('[data-matrix-video-consent]')
const box = () => document.querySelector<HTMLButtonElement>('[data-matrix-video-consent-checkbox]')!
const allow = () => document.querySelector<HTMLButtonElement>('[data-matrix-video-consent-allow]')

describe('the one-time video consent in the conversation', () => {
  it('appears only for the consent-required code, and only when the platform says not current', async () => {
    const current = bridge([status({ current: true, confirmedAt: Date.UTC(2026, 10, 17) })])
    const { rerender } = show({ value: current.value })

    rerender({ value: current.value, line: { id: '$line-a' } })
    rerender({ value: current.value, line: { id: '$line-a', presentation: { version: 1, code: 'approval_wait', args: {} } } })
    expect(current.value.videoConsent).not.toHaveBeenCalled()

    rerender({ value: current.value, line: asks() })
    await waitFor(() => expect(current.value.videoConsent).toHaveBeenCalledOnce())
    expect(card()).toBeNull()

    cleanup()
    const missing = bridge([status()])
    show({ value: missing.value, line: asks() })
    await waitFor(() => expect(card()?.dataset.matrixVideoConsent).toBe('asking'))
  })

  it('starts unticked, gates Allow on the tick, and sends only on that press', async () => {
    const value = bridge([status()], [{ status: 'allowed', consent: status({ current: true, confirmedAt: 1 }) }])
    show({ value: value.value, line: asks() })

    await waitFor(() => expect(box()).toBeTruthy())
    expect(box().getAttribute('aria-checked')).toBe('false')
    expect(allow()!.disabled).toBe(true)
    fireEvent.click(allow()!)
    expect(value.value.allowVideoConsent).not.toHaveBeenCalled()

    fireEvent.click(box())
    expect(allow()!.disabled).toBe(false)
    fireEvent.click(allow()!)

    await waitFor(() => expect(value.value.allowVideoConsent).toHaveBeenCalledOnce())
    // Settles quietly: one line, then the card is gone. Nothing else was used: no chat text.
    await waitFor(() => expect(card()).toBeNull())
    expect(value.other).not.toHaveBeenCalled()
  })

  it('shows a 503 read as couldn’t reach, never as not consented, and never sends', async () => {
    const value = bridge([new Error('matrix_video_consent_unavailable'), status()])
    show({ value: value.value, line: asks() })

    await waitFor(() => expect(card()?.dataset.matrixVideoConsent).toBe('unavailable'))
    expect(box()).toBeNull()
    expect(allow()).toBeNull()
    expect(screen.getByText('Couldn’t reach Atum. Nothing was changed.')).toBeTruthy()
    expect(value.value.allowVideoConsent).not.toHaveBeenCalled()

    fireEvent.click(document.querySelector('[data-matrix-video-consent-retry]')!)
    await waitFor(() => expect(card()?.dataset.matrixVideoConsent).toBe('asking'))
    expect(value.value.allowVideoConsent).not.toHaveBeenCalled()
  })

  it('says a refusal (409, unknown wording) calmly and offers no retry loop', async () => {
    const value = bridge([status()], [{ status: 'refused' }])
    show({ value: value.value, line: asks() })

    await waitFor(() => expect(box()).toBeTruthy())
    fireEvent.click(box())
    fireEvent.click(allow()!)

    await waitFor(() => expect(card()?.dataset.matrixVideoConsent).toBe('refused'))
    expect(screen.getByText('Video can’t be allowed for this account right now.')).toBeTruthy()
    expect(allow()).toBeNull()
    expect(box().getAttribute('aria-checked')).toBe('false')
    expect(value.value.allowVideoConsent).toHaveBeenCalledOnce()
  })

  it('keeps the tick after an unavailable save and lets the person try again', async () => {
    const value = bridge([status()], [{ status: 'unavailable' }, { status: 'allowed', consent: status({ current: true }) }])
    show({ value: value.value, line: asks() })

    await waitFor(() => expect(box()).toBeTruthy())
    fireEvent.click(box())
    fireEvent.click(allow()!)
    await waitFor(() => expect(card()?.dataset.matrixVideoConsent).toBe('unavailable'))
    expect(allow()!.textContent).toBe('Try again')

    fireEvent.click(allow()!)
    await waitFor(() => expect(card()).toBeNull())
    expect(value.value.allowVideoConsent).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['en', 'vi'],
    ['vi', 'en']
  ] as const)('shows the wording the platform records (%s) whatever the app language (%s), hash for hash', async (server, app) => {
    const value = bridge([status({ locale: server })])
    show({ value: value.value, line: asks() }, app)

    await waitFor(() => expect(box()).toBeTruthy())
    const sentence = document.querySelector('[data-matrix-video-consent-sentence]')!
    const disclosure = document.querySelector('[data-matrix-video-consent-disclosure]')!

    expect(sha256(sentence.textContent!)).toBe(PINNED[server].checkbox)
    expect(sha256(disclosure.textContent!)).toBe(PINNED[server].disclosure)
    expect(sentence.getAttribute('lang')).toBe(server)
    // The app's own chrome follows the app language.
    expect(allow()!.textContent).toBe(app === 'vi' ? 'Cho phép tạo video' : 'Allow video')
  })

  it('stays away once put away for that line, and asks again for the next refused step', async () => {
    const value = bridge([status()])
    const { rerender } = show({ value: value.value, line: asks('$line-a') })

    await waitFor(() => expect(card()).toBeTruthy())
    fireEvent.click(document.querySelector('[data-matrix-video-consent-dismiss]')!)
    expect(card()).toBeNull()

    // The line ends (the turn is over) and comes back the same: still put away.
    rerender({ value: value.value })
    rerender({ value: value.value, line: asks('$line-a') })
    expect(card()).toBeNull()

    rerender({ value: value.value, line: asks('$line-b') })
    await waitFor(() => expect(card()).toBeTruthy())
    expect(value.value.allowVideoConsent).not.toHaveBeenCalled()
    expect(value.other).not.toHaveBeenCalled()
  })

  it('outlives the working line until it is answered, in that room only', async () => {
    const value = bridge([status()])
    const { rerender } = show({ value: value.value, line: asks() })

    await waitFor(() => expect(card()).toBeTruthy())
    rerender({ value: value.value })
    expect(card()).toBeTruthy()

    rerender({ value: value.value, room: '!room-b' })
    expect(card()).toBeNull()
  })
})
