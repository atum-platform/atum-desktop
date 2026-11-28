import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { firstRunAutoConnectable } from '@/matrix/first-run-sources'

import type { MatrixNativeSshView } from '../../../shared/matrix-native-mac'

import { FirstRunConnections, firstRunEffectivePresentation, firstRunJoin, firstRunMacReachRow, firstRunPendingSteps, firstRunProgressLine, firstRunRows } from './first-run-connections'
import { $firstRunAsk } from './first-run-controller'
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

describe('the conversational ask row', () => {
  const names = { folders: 'Mac folders', messages: 'Messages', 'mac-reach': 'this Mac', google: 'Google' } as const

  it('runs only rows still on Connect, and Remote Login only as its own prompt or a promptless setup', () => {
    const rows = [
      { kind: 'google', state: 'connect' },
      { kind: 'folders', state: 'connect' },
      { kind: 'messages', state: 'ready' },
      { kind: 'browser', state: 'connect' }
    ] as const

    expect(firstRunPendingSteps(rows, { state: 'connect', action: 'enable_remote_login' })).toEqual(['folders', 'mac-reach', 'google'])
    expect(firstRunPendingSteps(rows, { state: 'settings', action: 'open_settings' })).toEqual(['folders', 'google'])
    expect(firstRunPendingSteps(rows, null)).toEqual(['folders', 'google'])
  })

  it('shows the ask row only for an open first run, or while an answered ask still runs after the welcome closed', () => {
    expect(firstRunEffectivePresentation('ask', true, 'ask')).toBe('ask')
    expect(firstRunEffectivePresentation('ask', false, 'running')).toBe('ask')
    expect(firstRunEffectivePresentation('ask', false, 'later')).toBe('ask')
    // An old welcome from an earlier session: the plain list, never a second Sure.
    expect(firstRunEffectivePresentation('ask', false, 'ask')).toBe('list')
    expect(firstRunEffectivePresentation('hidden', false, 'ask')).toBe('hidden')
    expect(firstRunEffectivePresentation('list', true, 'running')).toBe('list')
  })

  it('says one compact progress line: the step now, then what comes next', () => {
    expect(firstRunProgressLine({ step: 'folders', next: 'messages', folders: ['Documents', 'Desktop'] }, en, names, 'en')).toBe(
      'Reading Documents and Desktop… · Messages next'
    )
    expect(firstRunProgressLine({ step: 'mac-reach', next: 'google', folders: [], macAction: 'enable_remote_login' }, en, names, 'en')).toBe(
      'Enter your Mac password · Google next'
    )
    expect(firstRunProgressLine({ step: 'google', folders: [] }, en, names, 'en')).toBe('Finish in your browser')
    expect(firstRunJoin('en', ['Google', 'Documents', 'Messages'])).toBe('Google, Documents and Messages')
  })

  it('has the ask row in all five languages, each line under 60 characters', () => {
    for (const words of Object.values(FIRST_RUN_CONNECTIONS_COPY)) {
      const lines = [
        words.ask.sure, words.ask.notNow, words.ask.choose, words.ask.connectGoogle, words.ask.reading('Documents'),
        words.ask.fullDisk, words.ask.next('Google'), words.ask.thisMac, words.ask.connected('Google')
      ]

      for (const line of lines) {
        expect(line.length).toBeGreaterThan(0)
        expect(line.length).toBeLessThan(60)
      }
    }
  })

  it('Sure asks for Remote Login with its one native password prompt and ends on one summary line', async () => {
    let status: MatrixNativeSshView['status'] = 'needs_remote_login'

    const ssh = vi.fn(async (action: string) => {
      if (action === 'enable_remote_login') {
        status = 'connected'
      }

      return { status, settingsUrl: 'x-apple.systempreferences:' } as MatrixNativeSshView
    })

    render(
      <I18nProvider initialLocale="en">
        <FirstRunConnections assistantName="Nova" connect={vi.fn()} learningOffered nativeMac={{ ssh, confirmCommand: vi.fn() }} presentation="ask" />
      </I18nProvider>
    )

    // Nothing was asked by itself: the password prompt waits for Sure.
    await waitFor(() => expect(ssh).toHaveBeenCalledWith('status'))
    expect(ssh).not.toHaveBeenCalledWith('enable_remote_login')

    fireEvent.click(screen.getByRole('button', { name: 'Sure' }))
    await waitFor(() => expect(ssh).toHaveBeenCalledWith('enable_remote_login'))
    await waitFor(() => expect($firstRunAsk.get().phase).toBe('done'))
    expect(await screen.findByText('Connected this Mac')).toBeTruthy()
    // The plain list stays one tap away.
    fireEvent.click(screen.getByRole('button', { name: 'Choose what to connect' }))
    expect(screen.getByRole('region', { name: 'Connections' }).querySelector('[data-atum-first-run-row="mac-reach"]')).not.toBeNull()
  })
})

describe('the automatic pass', () => {
  const none = { foldersGranted: false, fullDisk: false, googleConnected: false }
  const all = { foldersGranted: true, fullDisk: true, googleConnected: true }

  it('connects only what macOS and the browser would not ask about', () => {
    for (const kind of ['location', 'teamSpaces'] as const) {
      expect(firstRunAutoConnectable({ kind, state: 'connect' }, none)).toBe(true)
    }

    for (const kind of ['folders', 'messages', 'google'] as const) {
      expect(firstRunAutoConnectable({ kind, state: 'connect' }, none)).toBe(false)
      expect(firstRunAutoConnectable({ kind, state: 'connect' }, all)).toBe(true)
    }

    expect(firstRunAutoConnectable({ kind: 'unknown', state: 'connect', status: 'ready' }, none)).toBe(true)
    expect(firstRunAutoConnectable({ kind: 'unknown', state: 'connect', status: 'not_connected' }, all)).toBe(false)
  })

  it('never imports the browser by itself, and never reconnects a row the person skipped', () => {
    expect(firstRunAutoConnectable({ kind: 'browser', state: 'connect', status: 'ready' }, all)).toBe(false)
    expect(firstRunAutoConnectable({ kind: 'location', state: 'skipped' }, all)).toBe(false)
  })
})
