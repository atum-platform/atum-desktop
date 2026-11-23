import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixWorkBridge, MatrixWorkProjection } from '../../../shared/matrix-work'

import { WorkRelaySharedContextLine, WorkRelayTurnLine } from './relay-chrome'
import type { WorkRelayTurnChrome } from './relay-view'
import { resetWorkStoreForTests } from './store'
import { WorkScreen } from './work-screen'

beforeEach(resetWorkStoreForTests)
afterEach(cleanup)

const NOW = Date.UTC(2026, 10, 22, 8, 0)

function line(chrome: WorkRelayTurnChrome, locale: 'en' | 'vi' = 'en', handlers: { onStop?: () => void; onOpenWork?: () => void } = {}) {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <WorkRelayTurnLine chrome={chrome} now={NOW} {...handlers} />
    </I18nProvider>
  )
}

describe('WorkRelayTurnLine: one line, at most one action, UI chrome only', () => {
  it('draws nothing for a turn answered on the plan', () => {
    const { container } = line({ kind: 'none' })
    expect(container.textContent).toBe('')
  })

  it('names the Atum model that answered and why, with no action and no cost', () => {
    line({ kind: 'fallback', at: 'reply', reason: 'mac_off' })
    const shown = screen.getByRole('note')

    expect(shown.textContent).toBe('Nguyệt Thực answered · your Mac was off')
    expect(shown.querySelector('button')).toBeNull()
    expect(shown.dataset.workRelayLine).toBe('fallback')
  })

  it('holds with Stop as the one action', () => {
    const onStop = vi.fn()
    line({ kind: 'waiting', at: 'message', action: 'stop' }, 'en', { onStop })

    const status = screen.getByRole('status')
    expect(status.textContent).toContain('Waiting for your Mac')
    expect(status.querySelectorAll('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('shows a chat question as waiting for an answer and keeps Stop available', () => {
    line({ kind: 'waiting', at: 'message', action: 'stop', waitingForAnswer: true }, 'en', { onStop: vi.fn() })

    expect(screen.getByRole('status').textContent).toContain('Waiting for your answer')
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open Work' })).toBeNull()
  })

  it('asks the owner to reply again after T3 rejects the answer', () => {
    line({ kind: 'waiting', at: 'message', action: 'stop', waitingForAnswer: true, invalidAnswer: true }, 'en', { onStop: vi.fn() })

    expect(screen.getByRole('status').textContent).toContain('Reply again with a valid answer')
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
  })

  it('offers Open Work for an OK the owner can give on this Mac', () => {
    const onOpenWork = vi.fn()
    line({ kind: 'needs_ok', at: 'message', action: 'open_work' }, 'vi', { onOpenWork })

    expect(screen.getByRole('status').textContent).toContain('Cần bạn đồng ý trên máy Mac')
    fireEvent.click(screen.getByRole('button', { name: 'Mở Work' }))
    expect(onOpenWork).toHaveBeenCalledTimes(1)
  })

  it('draws no button when the surface gives no handler for the action', () => {
    line({ kind: 'limit', at: 'message', action: 'stop' })
    expect(screen.getByRole('status').textContent).toBe('ChatGPT limit reached · continues when it resets')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it.each([
    [{ kind: 'stopped', at: 'message' }, 'Stopped'],
    [{ kind: 'queued', at: 'message' }, 'Waiting for the reply above'],
    [{ kind: 'empty', at: 'message' }, 'Finished on your Mac · no answer'],
    [{ kind: 'failed', at: 'message' }, 'Didn’t finish on your Mac']
  ] satisfies [WorkRelayTurnChrome, string][])('words %o', (chrome, text) => {
    line(chrome)
    expect(screen.getByText(text)).toBeTruthy()
  })
})

describe('the shared-context line (O14)', () => {
  const words = (names: string[]) =>
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <WorkRelaySharedContextLine names={names} />
      </I18nProvider>
    )

  it('says once that what the owner types there can show up in the replies', () => {
    words(['Rin'])
    expect(screen.getByRole('note').textContent).toBe('What you type in Rin’s chat here can show up in its replies.')

    cleanup()
    words(['Rin', 'Luna'])
    expect(screen.getByRole('note').textContent).toBe('What you type in your assistants’ chats here can show up in their replies.')

    cleanup()
    const { container } = words([])
    expect(container.textContent).toBe('')
  })

  it('is drawn on the Work page only for assistants whose chat runs here', () => {
    const projection: MatrixWorkProjection = { view: 'ready', assistants: 'on', agents: [], protons: 'ok' }
    const bridge = { read: vi.fn(async () => null), place: vi.fn(async () => {}), hide: vi.fn(async () => {}), retry: vi.fn(async () => {}) } as unknown as MatrixWorkBridge

    const page = (relayChats?: string[]) =>
      render(
        <I18nProvider configClient={null} initialLocale="en">
          <WorkScreen
            agentName={principal => (principal === 'rin' ? 'Rin' : undefined)}
            bridge={bridge}
            obstructed={false}
            onAddProtons={() => {}}
            projection={projection}
            relayChats={relayChats}
          />
        </I18nProvider>
      )

    expect(page().container.querySelector('[data-work-relay-shared-context]')).toBeNull()

    cleanup()
    expect(page(['rin', 'rin']).container.querySelector('[data-work-relay-shared-context]')?.textContent).toContain('Rin’s chat')
  })
})
