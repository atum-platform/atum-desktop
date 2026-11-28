import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixNativeSshView } from '../../../shared/matrix-native-mac'

import { FirstRunConnections, firstRunMacReachRow, firstRunRows } from './first-run-connections'
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

  it('shows a spinner, not a second Connect, for the row whose sign-in is open', () => {
    $accountConnectProgress.set({ plan: 'codex', phase: 'signing_in' })

    render(
      <I18nProvider initialLocale="en">
        <FirstRunConnections connect={vi.fn()} />
      </I18nProvider>
    )

    expect(screen.getByText('Finish in your browser')).toBeTruthy()
    expect(document.querySelector('[data-atum-first-run-row="codex"]')!.getAttribute('data-atum-first-run-state')).toBe('connecting')
    expect(document.querySelector('[data-atum-first-run-connect="codex"]')).toBeNull()
  })

  it('has every new list line in all five languages, each under 60 characters', () => {
    for (const words of Object.values(FIRST_RUN_CONNECTIONS_COPY)) {
      const lines = [
        words.greetingRetrying, words.greetingQuiet('Atum'), words.tryAgain, words.groups.plans, words.groups.accounts,
        words.groups.mac, words.cloudLine('Atum'), words.skipRest, words.skipped, words.connecting, words.notAllowed,
        words.unavailable, words.openSettings, words.restart, words.failed, words.macReach('Atum'), words.macReachLine,
        words.macReachPassword, words.fullDiskLine
      ]

      for (const line of lines) {
        expect(line.length).toBeGreaterThan(0)
        expect(line.length).toBeLessThan(60)
      }
    }
  })

  it('Skip the rest marks every open plan skipped and keeps its Connect', () => {
    $firstRunLabels.set({ claude: { state: 'ready', label: 'Claude Pro' } })

    render(
      <I18nProvider initialLocale="en">
        <FirstRunConnections connect={vi.fn()} />
      </I18nProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Skip the rest' }))

    const state = (provider: string) =>
      document.querySelector(`[data-atum-first-run-row="${provider}"]`)!.getAttribute('data-atum-first-run-state')

    expect(state('claude')).toBe('ready')
    expect(state('codex')).toBe('skipped')
    expect(state('opencode')).toBe('skipped')
    expect(screen.queryByRole('button', { name: 'Skip the rest' })).toBeNull()
    expect(screen.getAllByText('Skipped')).toHaveLength(3)
  })
})

describe('This Mac reach-down row', () => {
  const view = (status: MatrixNativeSshView['status']): MatrixNativeSshView => ({ status, settingsUrl: 'x-apple.systempreferences:' })

  it('maps the native setup result to one row with one action', () => {
    expect(firstRunMacReachRow({ manual: false }, false)).toBeNull()
    expect(firstRunMacReachRow({ view: view('connected'), manual: false }, false)).toEqual({ state: 'ready' })
    expect(firstRunMacReachRow({ view: view('needs_remote_login'), manual: false }, false)).toEqual({ state: 'connect', action: 'enable_remote_login' })
    expect(firstRunMacReachRow({ view: view('needs_remote_login'), manual: true }, false)).toEqual({ state: 'settings', action: 'open_settings' })
    expect(firstRunMacReachRow({ view: view('needs_full_disk_access_hint'), manual: false }, false)).toEqual({ state: 'settings', note: 'fullDisk', action: 'open_settings' })
    expect(firstRunMacReachRow({ view: view('error'), manual: false }, true)).toEqual({ state: 'skipped', note: 'unavailable', action: 'connect' })
    expect(firstRunMacReachRow({ view: view('needs_remote_login'), manual: false, running: 'enable_remote_login' }, false)).toEqual({ state: 'connecting', action: 'enable_remote_login' })
  })

  it('asks for Remote Login only from its own row', async () => {
    const ssh = vi.fn(async (action: string) => view(action === 'enable_remote_login' ? 'connected' : 'needs_remote_login'))

    render(
      <I18nProvider initialLocale="en">
        <FirstRunConnections assistantName="Nova" connect={vi.fn()} nativeMac={{ ssh, confirmCommand: vi.fn() }} />
      </I18nProvider>
    )

    const macRow = await screen.findByText('Let Nova use this Mac')
    expect(ssh).not.toHaveBeenCalledWith('enable_remote_login')

    fireEvent.click(within(macRow.closest('li')!).getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(ssh).toHaveBeenCalledWith('enable_remote_login'))
    await waitFor(() => expect(document.querySelector('[data-atum-first-run-row="mac-reach"]')!.getAttribute('data-atum-first-run-state')).toBe('ready'))
  })
})
