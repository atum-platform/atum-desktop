import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/app/chat/composer/focus', () => ({ requestComposerFocus: vi.fn() }))
vi.mock('@/store/atum-messaging', () => ({ signInToAtum: vi.fn(async () => undefined) }))

import { requestComposerFocus } from '@/app/chat/composer/focus'
import type { ManagedModelAccessAlias } from '@/lib/atum-managed-model-access'
import { refreshManagedModelAccess, resetManagedModelAccess } from '@/store/atum-managed-model'
import { signInToAtum } from '@/store/atum-messaging'

import {
  ManagedModelBanner,
  managedModelPresentation,
  managedModelStatusVisible,
  useManagedModelAccessLifecycle
} from './managed-model-banner'

afterEach(() => {
  cleanup()
  resetManagedModelAccess()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

function Location() { return <output data-testid="location">{useLocation().search}</output> }

function ManagedModelHarness({ accessAlias = 'binh-minh' }: { accessAlias?: ManagedModelAccessAlias | null }) {
  useManagedModelAccessLifecycle(accessAlias)

  return <MemoryRouter><Location />{accessAlias ? <ManagedModelBanner accessAlias={accessAlias} /> : null}</MemoryRouter>
}

describe('ManagedModelBanner', () => {
  it('stays silent for ready, loading, and failed background refreshes', async () => {
    const access = vi.fn().mockResolvedValueOnce({ state: 'ready', access_alias: 'binh-minh' }).mockResolvedValue({ state: 'unavailable' })
    vi.stubGlobal('window', Object.assign(window, { hermesDesktop: { managedModel: { access } } }))
    render(<ManagedModelHarness />)
    await waitFor(() => expect(access).toHaveBeenCalledOnce())
    await refreshManagedModelAccess()
    expect(screen.queryByText('Bình Minh')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('does not alarm when the very first background read fails', async () => {
    const access = vi.fn(async () => ({ state: 'unavailable' as const }))
    vi.stubGlobal('window', Object.assign(window, { hermesDesktop: { managedModel: { access } } }))
    render(<ManagedModelHarness />)
    await waitFor(() => expect(access).toHaveBeenCalledOnce())
    expect(screen.queryByText(/Couldn't|Checking/u)).toBeNull()
  })

  it('offers Protons for a real funding failure and preserves the draft', async () => {
    const access = vi.fn(async () => ({ state: 'insufficient_funds', access_alias: 'binh-minh', billing_currency: 'protons' }) as never)
    vi.stubGlobal('window', Object.assign(window, { hermesDesktop: { managedModel: { access } } }))
    render(<><textarea defaultValue="my task" /><ManagedModelHarness /></>)
    fireEvent.click(await screen.findByRole('button', { name: 'Add Protons' }))
    expect(screen.getByTestId('location').textContent).toBe('?tab=atum:protons')
    expect(screen.getByDisplayValue('my task')).toBeTruthy()
  })

  it('does not query when the lifecycle is inactive', () => {
    const access = vi.fn()
    vi.stubGlobal('window', Object.assign(window, { hermesDesktop: { managedModel: { access } } }))
    render(<ManagedModelHarness accessAlias={null} />)
    expect(access).not.toHaveBeenCalled()
  })

  it('uses actionable funding, service, eligibility and authentication states', () => {
    const authority = { access_alias: 'binh-minh' as const, billing_currency: 'protons' as const }
    expect(managedModelPresentation({ ...authority, state: 'denied', reason: 'funding_required' })).toEqual({ action: 'fund', messageKey: 'funding_required' })
    expect(managedModelPresentation({ ...authority, state: 'service_paused' })).toEqual({ action: 'retry', messageKey: 'service_paused' })
    expect(managedModelPresentation({ ...authority, state: 'model_unavailable', reason: 'model_reserved' })).toEqual({ action: null, messageKey: 'model_reserved' })
    expect(managedModelPresentation({ ...authority, state: 'denied' })).toEqual({ action: null, messageKey: 'denied' })
    expect(managedModelPresentation({ state: 'unavailable' })).toEqual({ action: null, messageKey: null })
  })

  it('reauthenticates and restores composer focus without clearing its draft', async () => {
    const access = vi.fn().mockResolvedValueOnce({ state: 'authentication_expired' }).mockResolvedValueOnce({ state: 'ready', access_alias: 'binh-minh' })
    vi.stubGlobal('window', Object.assign(window, { hermesDesktop: { managedModel: { access } } }))
    render(<><textarea defaultValue="keep my unfinished question" /><ManagedModelHarness /></>)
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(signInToAtum).toHaveBeenCalledOnce())
    await waitFor(() => expect(requestComposerFocus).toHaveBeenCalledWith('active'))
    expect(screen.getByDisplayValue('keep my unfinished question')).toBeTruthy()
  })

  it('requests only the active alias and never sends a renderer bearer', async () => {
    const access = vi.fn(async () => ({ state: 'service_paused', access_alias: 'nguyet-thuc' }) as never)
    vi.stubGlobal('window', Object.assign(window, { hermesDesktop: { managedModel: { access } } }))
    render(<ManagedModelHarness accessAlias="nguyet-thuc" />)
    await waitFor(() => expect(access).toHaveBeenCalledOnce())
    expect(access).toHaveBeenCalledWith('nguyet-thuc')
    expect(access.mock.calls[0]).toHaveLength(1)
    expect(screen.getByText('Nguyệt Thực').getAttribute('data-managed-access-alias')).toBe('nguyet-thuc')
  })

  it('only opens the stack for fresh actionable answers about its alias', () => {
    expect(managedModelStatusVisible('binh-minh', { state: 'loading', accessAlias: 'binh-minh' })).toBe(false)
    const view = { state: 'resolved' as const, accessAlias: 'binh-minh' as const, access: { state: 'insufficient_funds' } as never }
    expect(managedModelStatusVisible('binh-minh', view)).toBe(true)
    expect(managedModelStatusVisible('nguyet-thuc', view)).toBe(false)
    expect(managedModelStatusVisible(null, view)).toBe(false)
    expect(managedModelStatusVisible('binh-minh', { ...view, freshness: { checkedAt: 1, attemptedAt: 2, consecutiveFailures: 1 } })).toBe(false)
  })
})
