import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $work, resetWorkStoreForTests } from '@/app/work/store'
import { I18nProvider } from '@/i18n'

import { AccountConnectProgress, AccountConnectSheet } from './connect-sheet'
import { $accountConnectProgress, openAccountConnect, resetAccountConnectionsForTest } from './store'

const port = () => ({
  readConnections: vi.fn(async () => null),
  openPlanConnect: vi.fn(async () => {}),
  readPlanConsent: vi.fn(),
  setPlanConsent: vi.fn(),
  setPlan: vi.fn(async () => {})
})

function show(node: React.ReactNode, locale: 'en' | 'vi' = 'en') {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      {node}
    </I18nProvider>
  )
}

beforeEach(() => {
  resetAccountConnectionsForTest()
  resetWorkStoreForTests()
})

afterEach(() => {
  cleanup()
  resetAccountConnectionsForTest()
})

describe('AccountConnectSheet: Ask', () => {
  it('is the plan’s mark, one title, one line and the one consent sentence, with no checkbox', () => {
    $work.set({ view: 'ready', assistants: 'on', agents: [], protons: 'ok' })
    show(<AccountConnectSheet bridge={port()} />)
    act(() => openAccountConnect('claude'))

    const dialog = screen.getByRole('dialog', { name: 'Connect Claude' })
    expect(dialog.textContent).toContain('Sign in with Anthropic. Atum never sees your login.')
    expect(dialog.textContent).toContain('Your assistants can use this plan through this Mac.')
    expect(dialog.querySelector('[role="checkbox"], input[type="checkbox"]')).toBeNull()
    expect(dialog.textContent).not.toMatch(/Protons|price|\$/u)
  })

  it('Continue closes what covers Work and opens the plan’s own sign-in there', async () => {
    $work.set({ view: 'ready', assistants: 'on', agents: [], protons: 'ok' })
    const bridge = port()
    const leave = vi.fn()
    show(<AccountConnectSheet bridge={bridge} onLeave={leave} />)
    act(() => openAccountConnect('antigravity'))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    })

    expect(leave).toHaveBeenCalledOnce()
    expect(bridge.openPlanConnect).toHaveBeenCalledWith('antigravity')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('on a device without Work, says where to connect instead', () => {
    $work.set(null)
    show(<AccountConnectSheet bridge={port()} />, 'vi')
    act(() => openAccountConnect('codex'))

    const dialog = screen.getByRole('dialog', { name: 'Kết nối ChatGPT' })
    expect(dialog.textContent).toContain('Mở Atum trên máy Mac để kết nối.')
    expect(screen.queryByRole('button', { name: 'Tiếp tục' })).toBeNull()
  })
})

describe('AccountConnectProgress: Finish and Done in the Work title band', () => {
  it('reads the phase in one line; a failed sign-in offers Try again, which reopens the sheet', () => {
    show(<><AccountConnectProgress /><AccountConnectSheet bridge={port()} /></>)

    act(() => $accountConnectProgress.set({ plan: 'claude', phase: 'signing_in' }))
    expect(screen.getByRole('status').textContent).toBe('Finish signing in to Claude')

    act(() => $accountConnectProgress.set({ plan: 'claude', phase: 'done' }))
    expect(screen.getByRole('status').textContent).toBe('Claude is connected')

    act(() => $accountConnectProgress.set({ plan: 'claude', phase: 'failed' }))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect($accountConnectProgress.get()).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Connect Claude' })).toBeTruthy()
  })
})
