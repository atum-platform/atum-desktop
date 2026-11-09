import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProviderSetupOverlay } from '@/components/onboarding'
import { I18nProvider } from '@/i18n'
import { $desktopOnboarding, cancelOnboardingFlow, closeManualOnboarding, startManualOnboarding, startManualProviderOAuth } from '@/store/onboarding'

const initial = $desktopOnboarding.get()
afterEach(() => {
  cleanup()
  cancelOnboardingFlow()
  closeManualOnboarding()
  $desktopOnboarding.set(initial)
  vi.restoreAllMocks()
})

function setup() {
  $desktopOnboarding.set({ ...initial, manual: false, configured: true, requested: false, flow: { status: 'idle' } })

  const api = vi.fn(async ({ path }: { path: string }) => {
    if (path === '/api/providers/oauth') {
      return { providers: [{ id: 'openai-codex', name: 'ChatGPT', flow: 'device_code', status: { logged_in: false } }] }
    }

    if (path === '/api/providers/oauth/openai-codex/start') {
      return { flow: 'device_code', session_id: 'test-session', user_code: 'TEST-CODE', verification_url: 'https://example.com/device', expires_in: 600 }
    }

    if (path.startsWith('/api/model/options')) {
      return { providers: [{ slug: 'example-api', name: 'Example API', key_env: 'EXAMPLE_API_KEY', auth_type: 'api_key', models: [] }] }
    }

    return { providers: [], status: 'pending' }
  })

  const openExternal = vi.fn(async () => undefined)
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { api, openExternal } })
  const requestGateway = vi.fn(async () => undefined as never)
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <button onClick={() => startManualProviderOAuth('openai-codex')}>Set up provider</button>
      <button onClick={() => startManualOnboarding(null)}>Add provider</button>
      <ProviderSetupOverlay atumShell enabled profile="default" requestGateway={requestGateway} />
    </I18nProvider>
  )

  return { api, openExternal, requestGateway }
}

describe('Existing provider setup through the Atum overlay gate', () => {
  it('keeps automatic Hermes onboarding and its startup effects unmounted in Atum', () => {
    const { api, requestGateway } = setup()
    expect(screen.queryByTestId('desktop-onboarding-overlay')).toBeNull()
    expect(api).not.toHaveBeenCalled()
    expect(requestGateway).not.toHaveBeenCalled()
  })

  it('starts the real Codex device-code flow from an existing provider entry point', async () => {
    const { api, openExternal } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Set up provider' }))
    await waitFor(() => expect($desktopOnboarding.get().flow.status).toBe('polling'))
    expect(screen.getByTestId('desktop-onboarding-overlay')).toBeTruthy()
    expect(api).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/providers/oauth/openai-codex/start', method: 'POST' }))
    expect(openExternal).toHaveBeenCalledWith('https://example.com/device')
    expect((await screen.findByRole('button', { name: 'Copy' })).textContent).toBe('TEST–CODE')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(api).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/providers/oauth/sessions/test-session', method: 'DELETE' }))
    expect(screen.queryByTestId('desktop-onboarding-overlay')).toBeNull()
  })

  it('cancels a late OAuth start after the user closes setup', async () => {
    const { api, openExternal } = setup()
    const original = api.getMockImplementation()!
    let finishStart!: (value: never) => void
    const pendingStart = new Promise<never>(resolve => { finishStart = resolve })
    api.mockImplementation(request => request.path.endsWith('/start') ? pendingStart : original(request))
    fireEvent.click(screen.getByRole('button', { name: 'Set up provider' }))
    await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/providers/oauth/openai-codex/start' })))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    finishStart({ flow: 'device_code', session_id: 'late-session', verification_url: 'https://example.com', user_code: 'LATE' } as never)
    await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/providers/oauth/sessions/late-session', method: 'DELETE' })))
    expect(openExternal).not.toHaveBeenCalled()
    expect(screen.queryByTestId('desktop-onboarding-overlay')).toBeNull()
    expect($desktopOnboarding.get().flow.status).toBe('idle')
  })

  it('offers backend catalog providers in the existing generic key form', async () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }))
    await waitFor(() => expect($desktopOnboarding.get().providers).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'I have an API key' }))
    fireEvent.click(await screen.findByRole('button', { name: /Example API/ }))
    expect(screen.getByTestId('desktop-onboarding-overlay')).toBeTruthy()
    expect(screen.getByText('Direct API access to Example API.')).toBeTruthy()
    expect(globalThis.document.querySelector('input[type="password"]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByTestId('desktop-onboarding-overlay')).toBeNull()
    expect(screen.getByRole('button', { name: 'Add provider' })).toBeTruthy()
  })
})
