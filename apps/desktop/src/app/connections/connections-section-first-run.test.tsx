import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { ACCOUNT_CONNECTIONS_FIXTURE } from '../../../shared/account-connections'
import type { MatrixWorkPlanConsent } from '../../../shared/matrix-work'

import { AccountSubscriptionsSection } from './connections-section'
import { $firstRunAutoEnabled, $firstRunRepick, bindFirstRunAccount, resetFirstRunForTests } from './first-run-store'
import { $accountConnections, resetAccountConnectionsForTest } from './store'

const on: MatrixWorkPlanConsent = { state: 'on', agents: [], eligible: [], macs: [], alsoWhenScheduled: true, grantedAt: 1 }
const off: MatrixWorkPlanConsent = { ...on, state: 'off' }

beforeEach(() => {
  resetFirstRunForTests()
  resetAccountConnectionsForTest()
  window.localStorage.clear()
  bindFirstRunAccount('@an:atum.chat')
})

describe('Settings › Connections, first run', () => {
  it('names the plan in use, Stop using revokes it and re-picks; the switch is the lasting off', async () => {
    // ChatGPT is connected on this Mac in the fixture.
    $accountConnections.set(ACCOUNT_CONNECTIONS_FIXTURE)

    const bridge = {
      openPlanConnect: vi.fn(async () => {}),
      readConnections: vi.fn(async () => ACCOUNT_CONNECTIONS_FIXTURE),
      readPlanConsent: vi.fn(async (plan?: string) => (plan === 'codex' ? on : off)),
      revokePlanConsent: vi.fn(async () => off),
      readPlanLabels: vi.fn(async () => ({ codex: { state: 'ready' as const, label: 'ChatGPT Plus' } }))
    }

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <AccountSubscriptionsSection bridge={bridge} />
      </I18nProvider>
    )

    await waitFor(() => expect(screen.getByText('ChatGPT Plus · your assistants use it')).toBeTruthy())

    const before = $firstRunRepick.get()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop using' }))
    })
    expect(bridge.revokePlanConsent).toHaveBeenCalledWith('codex')
    await waitFor(() => expect($firstRunRepick.get()).toBeGreaterThan(before))

    const toggle = screen.getByRole('switch', { name: 'Pick the best plan automatically' })
    expect(screen.getByText('For all your assistants, chats and schedules')).toBeTruthy()
    fireEvent.click(toggle)
    expect($firstRunAutoEnabled.get()).toBe(false)
  })
})
