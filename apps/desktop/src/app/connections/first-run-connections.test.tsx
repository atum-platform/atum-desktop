import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { FirstRunConnections, firstRunRows } from './first-run-connections'
import { FIRST_RUN_CONNECTIONS_COPY, firstRunConnectionsCopy } from './first-run-copy'
import { $firstRunLabels, $firstRunOpenCodeGo, resetFirstRunForTests } from './first-run-store'
import { $accountConnectProgress, resetAccountConnectionsForTest } from './store'

const en = firstRunConnectionsCopy('en')

beforeEach(() => {
  resetFirstRunForTests()
  resetAccountConnectionsForTest()
})

describe('first-run Connections rows', () => {
  it('lists the four connections, Ready ones first with their plan, in the owner order', () => {
    const rows = firstRunRows({ claude: { state: 'ready', label: 'Claude Pro' }, codex: { state: 'signed_out' } }, false, null, en)

    expect(rows.map(row => [row.provider, row.state, row.line])).toEqual([
      ['claude', 'ready', 'Claude Pro'],
      ['codex', 'connect', undefined],
      ['antigravity', 'connect', undefined],
      ['opencode', 'connect', undefined]
    ])
  })

  it('says a free plan serves small tasks, and OpenCode Go reads Ready from the account key', () => {
    const rows = firstRunRows({ codex: { state: 'ready', label: 'ChatGPT Free' } }, true, null, en)

    expect(rows.find(row => row.provider === 'codex')?.line).toBe('ChatGPT Free · used for small tasks')
    expect(rows.find(row => row.provider === 'opencode')).toEqual({ provider: 'opencode', state: 'ready', line: 'OpenCode Go' })
  })

  it('shows "Finish in your browser" while that provider sign-in is open', () => {
    const rows = firstRunRows({}, false, { plan: 'antigravity', phase: 'signing_in' }, en)

    expect(rows.find(row => row.provider === 'antigravity')).toEqual({ provider: 'antigravity', state: 'signing_in', line: en.finishInBrowser })
  })

  it('has every line in all five languages, each under 60 characters', () => {
    for (const words of Object.values(FIRST_RUN_CONNECTIONS_COPY)) {
      const lines = [words.header, words.ready, words.connect, words.finishInBrowser, words.connected, words.autoTitle, words.autoLine, words.stopUsing, words.freeLine('ChatGPT Free'), words.inUse('Claude Pro')]

      for (const line of lines) {
        expect(line.length).toBeGreaterThan(0)
        expect(line.length).toBeLessThan(60)
      }
    }
  })

  it('Connect opens the provider’s native sign-in; OpenCode opens the key sheet path', () => {
    const connect = vi.fn()
    $firstRunLabels.set({ claude: { state: 'ready', label: 'Claude Pro' } })
    $firstRunOpenCodeGo.set(false)

    render(
      <I18nProvider initialLocale="en">
        <FirstRunConnections connect={connect} />
      </I18nProvider>
    )

    const block = screen.getByRole('region', { name: 'Connections' })
    expect(within(block).getByText('Claude Pro')).toBeTruthy()
    expect(within(block).getByText('Ready')).toBeTruthy()

    fireEvent.click(block.querySelector('[data-atum-first-run-connect="codex"]')!)
    expect(connect).toHaveBeenCalledWith({ plan: 'codex', mode: 'connect' })
  })

  it('disables Connect for the row whose sign-in is open', () => {
    $accountConnectProgress.set({ plan: 'codex', phase: 'signing_in' })

    render(
      <I18nProvider initialLocale="en">
        <FirstRunConnections connect={vi.fn()} />
      </I18nProvider>
    )

    expect(screen.getByText('Finish in your browser')).toBeTruthy()
    expect((document.querySelector('[data-atum-first-run-connect="codex"]') as HTMLButtonElement).disabled).toBe(true)
  })
})
