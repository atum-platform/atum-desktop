import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixWorkBridge, MatrixWorkPlanConsent, MatrixWorkProjection } from '../../../shared/matrix-work'

import { WorkRelaySharedContextLine, WorkRelayTurnLine } from './relay-chrome'
import type { WorkRelayTurnChrome } from './relay-view'
import { $work, $workPlanConsent, resetWorkStoreForTests } from './store'
import { WorkScreen } from './work-screen'
import { MatrixWorkSettings } from './work-settings'

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

describe('Settings and the consent sheet (§6)', () => {
  const THIS_MAC = '00000000-0000-4000-8000-00000000a001'

  const OFF: MatrixWorkPlanConsent = {
    state: 'off',
    agents: [],
    eligible: ['rin'],
    macs: [{ id: THIS_MAC, thisMac: true, named: false }],
    alsoWhenScheduled: false
  }

  const port = () => ({
    setWork: vi.fn(async () => {}),
    setAssistants: vi.fn(async () => {}),
    setPlan: vi.fn(async () => {}),
    openPlanConnect: vi.fn(async () => {}),
    readPlanConsent: vi.fn(async () => OFF),
    setPlanConsent: vi.fn(async () => OFF),
    revokePlanConsent: vi.fn(async () => OFF)
  })

  it('adds the plan’s usage to the connected row, never a cost', async () => {
    $work.set({ view: 'ready', assistants: 'on', agents: [], protons: 'ok', planConnect: 'connected' })
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixWorkSettings
          bridge={port()}
          planLimit={{ plan: 'codex', state: 'available', observedAt: 1, usedPercent: 42 }}
        />
      </I18nProvider>
    )

    expect(await screen.findByText('Connected on this Mac · 42% used')).toBeTruthy()
  })

  it('keeps the connected row as it was without a limit', async () => {
    $work.set({ view: 'ready', assistants: 'on', agents: [], protons: 'ok', planConnect: 'connected' })
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixWorkSettings bridge={port()} />
      </I18nProvider>
    )

    expect(await screen.findByText('Connected on this Mac')).toBeTruthy()
  })

  it.each([
    [false, 'Only for work they start on your Mac. Stop it anytime.', 'Also for scheduled tasks'],
    [true, 'Your chats with them run on your Mac with this plan. Stop it anytime.', 'Also for scheduled work']
  ] as const)('says what the plan does once allowed (chats: %s)', async (relayChats, sentence, scheduled) => {
    $work.set({ view: 'ready', assistants: 'on', agents: [], protons: 'ok', plan: 'off' })
    $workPlanConsent.set({})
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixWorkSettings agents={[{ principal: 'rin', name: 'Rin' }]} bridge={port()} relayChats={relayChats} />
      </I18nProvider>
    )

    expect(await screen.findByText(sentence)).toBeTruthy()
    expect(await screen.findByRole('switch', { name: scheduled })).toBeTruthy()
  })
})
