import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type {
  MatrixProviderOAuthSession,
  MatrixProviderSettingsClient,
  MatrixProviderSnapshot
} from '../../shared/matrix-provider-settings'

import { MatrixProvidersSettings } from './providers'
import { createMatrixProviderSettingsClient } from './providers-client'
import { providersCopy } from './providers-copy'

// The shared model card measures itself (Radix); jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

const snapshot: MatrixProviderSnapshot = {
  current: { provider: 'openrouter', model: 'model-old' },
  providers: [
    {
      id: 'openrouter',
      name: 'OpenRouter',
      ready: true,
      current: true,
      models: ['model-old', 'model-new'],
      keyAvailable: true,
      keySet: true,
      oauth: null
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      ready: true,
      current: false,
      models: ['claude-next'],
      keyAvailable: false,
      keySet: false,
      oauth: { flow: 'pkce', connected: true, supported: true, disconnectable: true }
    },
    {
      id: 'nous',
      name: 'Nous',
      ready: false,
      current: false,
      models: ['deferred-model'],
      keyAvailable: false,
      keySet: false,
      oauth: { flow: 'device_code', connected: false, supported: false, disconnectable: false }
    },
    {
      id: 'qwen',
      name: 'Qwen',
      ready: false,
      current: false,
      models: [],
      keyAvailable: false,
      keySet: false,
      oauth: { flow: 'external', connected: true, supported: false, disconnectable: false }
    }
  ]
}

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(next => {
    resolve = next
  })

  return { promise, resolve }
}

function client(overrides: Partial<MatrixProviderSettingsClient> = {}): MatrixProviderSettingsClient {
  return {
    snapshot: vi.fn().mockResolvedValue(snapshot),
    saveKey: vi.fn().mockResolvedValue({ status: 'applied' }),
    selectModel: vi.fn().mockResolvedValue({ status: 'applied', staleAux: true }),
    addEndpoint: vi.fn().mockResolvedValue({ status: 'applied' }),
    startOAuth: vi.fn().mockResolvedValue({
      status: 'pending',
      session: 'opaque-session',
      provider: 'anthropic',
      flow: 'pkce',
      expiresIn: 900,
      pollInterval: 3
    }),
    pollOAuth: vi.fn().mockResolvedValue({ status: 'pending' }),
    submitOAuth: vi.fn().mockResolvedValue({ status: 'approved' }),
    cancelOAuth: vi.fn().mockResolvedValue({ status: 'cancelled' }),
    disconnectOAuth: vi.fn().mockResolvedValue({ status: 'applied' }),
    ...overrides
  }
}

function setup(overrides: Partial<MatrixProviderSettingsClient> = {}, locale: Locale = 'en') {
  const api = client(overrides)

  const view = render(
    <I18nProvider initialLocale={locale}>
      <MatrixProvidersSettings agentName="Ada" client={api} />
    </I18nProvider>
  )

  return { api, ...view }
}

const loaded = async () => waitFor(() => expect(screen.getByText('OpenRouter')).toBeTruthy())

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('selected-agent provider presentation', () => {
  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as Locale[])(
    'has provider controls and safe scope copy in %s',
    async locale => {
      setup({}, locale)
      await loaded()
      const copy = providersCopy[locale]
      expect(screen.getByRole('heading', { name: copy.title })).toBeTruthy()
      expect(screen.getByText(copy.scope('Ada'))).toBeTruthy()
      expect(screen.getByRole('button', { name: copy.signIn })).toBeTruthy()
      expect(screen.getByRole('button', { name: copy.replaceKey })).toBeTruthy()
      expect(screen.queryByRole('button', { name: new RegExp(`^${copy.model} · Nous`) })).toBeNull()
    }
  )

  it('selects a different provider through the typed client and reports preserved auxiliary slots', async () => {
    const { api } = setup()
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: /^Model · Anthropic/ }))
    const card = await screen.findByRole('dialog', { name: 'Model · Anthropic' })
    fireEvent.click(card.querySelector<HTMLElement>('[data-matrix-model-route="anthropic:claude-next"]')!)
    await waitFor(() => expect(api.selectModel).toHaveBeenCalledWith('anthropic', 'claude-next'))
    expect(await screen.findByText(providersCopy.en.staleAux)).toBeTruthy()
    expect(api.snapshot).toHaveBeenCalledTimes(2)
  })

  it('clears write-only API key immediately and never renders an upstream failure detail', async () => {
    const result = deferred<{ status: 'cancelled' }>()
    const { api } = setup({ saveKey: vi.fn().mockReturnValue(result.promise) })
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: providersCopy.en.replaceKey }))
    fireEvent.change(screen.getByLabelText(providersCopy.en.key), { target: { value: 'synthetic-secret' } })
    fireEvent.click(screen.getByRole('button', { name: providersCopy.en.saveKey }))
    expect(api.saveKey).toHaveBeenCalledWith('openrouter', 'synthetic-secret')
    expect((screen.getByLabelText(providersCopy.en.key) as HTMLInputElement).value).toBe('')
    expect(screen.getByRole('button', { name: providersCopy.en.signIn }).hasAttribute('disabled')).toBe(true)
    await act(async () => result.resolve({ status: 'cancelled' }))
    expect(await screen.findByText(providersCopy.en.cancelled)).toBeTruthy()
  })

  it('adds a no-key local endpoint using the shared existing provider row and cancels without writes', async () => {
    const { api } = setup()
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: /Local \/ custom endpoint/ }))
    fireEvent.change(screen.getByLabelText(providersCopy.en.endpointName), { target: { value: 'Local model' } })
    fireEvent.change(screen.getByLabelText(providersCopy.en.endpointUrl), {
      target: { value: 'http://localhost:11434/v1' }
    })
    fireEvent.change(screen.getByLabelText(providersCopy.en.endpointModel), { target: { value: 'local-model' } })
    fireEvent.click(screen.getByRole('button', { name: providersCopy.en.add }))
    await waitFor(() =>
      expect(api.addEndpoint).toHaveBeenCalledWith({
        name: 'Local model',
        baseUrl: 'http://localhost:11434/v1',
        model: 'local-model',
        apiKey: ''
      })
    )
    await waitFor(() => expect(screen.queryByLabelText(providersCopy.en.endpointName)).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: /Local \/ custom endpoint/ }))
    fireEvent.click(screen.getByRole('button', { name: providersCopy.en.cancel }))
    expect(api.addEndpoint).toHaveBeenCalledTimes(1)
  })

  it('requires refreshed truth before replaying an uncertain mutation but lets busy requests retry', async () => {
    const { api } = setup({
      disconnectOAuth: vi
        .fn()
        .mockRejectedValueOnce(new Error('private-key-host'))
        .mockRejectedValueOnce(new Error('pages_agent_busy'))
    })

    await loaded()
    fireEvent.click(screen.getByRole('button', { name: providersCopy.en.disconnect }))
    expect(await screen.findByText(providersCopy.en.uncertain)).toBeTruthy()
    expect(screen.queryByText('private-key-host')).toBeNull()
    expect(screen.getByRole('button', { name: providersCopy.en.signIn }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: providersCopy.en.reload }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: providersCopy.en.signIn }).hasAttribute('disabled')).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: providersCopy.en.disconnect }))
    expect(await screen.findByText(providersCopy.en.busy)).toBeTruthy()
    expect(api.disconnectOAuth).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: providersCopy.en.disconnect }).hasAttribute('disabled')).toBe(false)
  })

  it('hands off PKCE without renderer URL controls, then clears code and refreshes on approval', async () => {
    const { api } = setup()
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: providersCopy.en.signIn }))
    expect(await screen.findByText(providersCopy.en.oauthPending)).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
    fireEvent.change(screen.getByLabelText(providersCopy.en.authCode), { target: { value: 'synthetic-code' } })
    fireEvent.click(screen.getByRole('button', { name: providersCopy.en.submitCode }))
    await waitFor(() => expect(api.submitOAuth).toHaveBeenCalledWith('opaque-session', 'synthetic-code'))
    await waitFor(() => expect(screen.queryByLabelText(providersCopy.en.authCode)).toBeNull())
    expect(api.snapshot).toHaveBeenCalledTimes(2)
  })

  it('cancels OAuth synchronously and retires its continuation on unmount', async () => {
    const cancel = deferred<{ status: 'cancelled' }>()
    const { api, unmount } = setup({ cancelOAuth: vi.fn().mockReturnValue(cancel.promise) })
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: providersCopy.en.signIn }))
    await screen.findByText(providersCopy.en.oauthPending)
    fireEvent.click(screen.getByRole('button', { name: providersCopy.en.cancel }))
    expect(screen.queryByText(providersCopy.en.oauthPending)).toBeNull()
    expect(api.cancelOAuth).toHaveBeenCalledWith('opaque-session')
    await act(async () => cancel.resolve({ status: 'cancelled' }))
    fireEvent.click(screen.getByRole('button', { name: providersCopy.en.signIn }))
    await screen.findByText(providersCopy.en.oauthPending)
    unmount()
    expect(api.cancelOAuth).toHaveBeenCalledTimes(2)
  })

  it('does not publish late provider setup into a replacement agent/client', async () => {
    const late = deferred<MatrixProviderOAuthSession>()
    const { api, rerender } = setup({ startOAuth: vi.fn().mockReturnValue(late.promise) })
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: providersCopy.en.signIn }))
    const replacement = client({ snapshot: vi.fn().mockResolvedValue({ current: null, providers: [] }) })
    rerender(
      <I18nProvider initialLocale="en">
        <MatrixProvidersSettings agentName="Bea" client={replacement} />
      </I18nProvider>
    )
    await screen.findByText(providersCopy.en.empty)
    await act(async () =>
      late.resolve({
        status: 'pending',
        session: 'old-session',
        provider: 'anthropic',
        flow: 'pkce',
        expiresIn: 900,
        pollInterval: 3
      })
    )
    expect(screen.queryByText(providersCopy.en.oauthPending)).toBeNull()
    expect(api.submitOAuth).not.toHaveBeenCalled()
    expect(screen.getByText(providersCopy.en.scope('Bea'))).toBeTruthy()
  })

  it('recovers a failed initial read without presenting raw exception text', async () => {
    setup({ snapshot: vi.fn().mockRejectedValueOnce(new Error('private-backend')).mockResolvedValueOnce(snapshot) })
    expect(await screen.findByText(providersCopy.en.loadFailed)).toBeTruthy()
    expect(screen.queryByText('private-backend')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: providersCopy.en.reload }))
    await loaded()
  })
})

it('Escape cancels exactly the focused key or endpoint interaction', async () => {
  const { api } = setup()
  await loaded()
  fireEvent.click(screen.getByRole('button', { name: providersCopy.en.replaceKey }))
  fireEvent.change(screen.getByLabelText(providersCopy.en.key), { target: { value: 'synthetic-secret' } })
  fireEvent.keyDown(screen.getByLabelText(providersCopy.en.key), { key: 'Escape' })
  expect(screen.queryByLabelText(providersCopy.en.key)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Local \/ custom endpoint/ }))
  fireEvent.keyDown(screen.getByLabelText(providersCopy.en.endpointName), { key: 'Escape' })
  expect(screen.queryByLabelText(providersCopy.en.endpointName)).toBeNull()
  expect(api.saveKey).not.toHaveBeenCalled()
  expect(api.addEndpoint).not.toHaveBeenCalled()
})

it('polls the opaque device-code session and refreshes once on approval', async () => {
  const { api } = setup({
    startOAuth: vi.fn().mockResolvedValue({
      status: 'pending',
      session: 'opaque-device',
      provider: 'anthropic',
      flow: 'device_code',
      userCode: 'CODE-1234',
      expiresIn: 600,
      pollInterval: 2
    }),
    pollOAuth: vi.fn().mockResolvedValue({ status: 'approved' })
  })

  await loaded()
  vi.useFakeTimers()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: providersCopy.en.signIn }))
    await Promise.resolve()
  })
  expect(screen.getByText('CODE-1234')).toBeTruthy()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(api.pollOAuth).toHaveBeenCalledExactlyOnceWith('opaque-device')
  expect(screen.queryByText(providersCopy.en.oauthPending)).toBeNull()
  expect(api.snapshot).toHaveBeenCalledTimes(2)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(api.pollOAuth).toHaveBeenCalledTimes(1)
})

it('says the sign-in did not work when the backend holding it is gone, instead of waiting in silence', async () => {
  const pending = {
    status: 'pending',
    session: 'opaque-device',
    provider: 'anthropic',
    flow: 'device_code',
    userCode: 'CODE-1234',
    expiresIn: 600,
    pollInterval: 2
  } as const

  const { api } = setup({
    startOAuth: vi.fn().mockResolvedValue(pending),
    pollOAuth: vi.fn().mockRejectedValue(new Error('matrix_pages_agent_unavailable'))
  })

  await loaded()
  vi.useFakeTimers()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: providersCopy.en.signIn }))
    await Promise.resolve()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(api.pollOAuth).toHaveBeenCalledOnce()
  expect(api.cancelOAuth).toHaveBeenCalledWith('opaque-device')
  expect(screen.getByText(providersCopy.en.oauthFailed)).toBeTruthy()
  expect(screen.queryByText('CODE-1234')).toBeNull()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(api.pollOAuth).toHaveBeenCalledOnce()
})

it('ends a sign-in whose polls keep failing after a few tries', async () => {
  const { api } = setup({
    startOAuth: vi.fn().mockResolvedValue({
      status: 'pending',
      session: 'opaque-flaky',
      provider: 'anthropic',
      flow: 'device_code',
      userCode: 'CODE-5678',
      expiresIn: 600,
      pollInterval: 2
    }),
    pollOAuth: vi.fn().mockRejectedValue(new Error('matrix_pages_failed'))
  })

  await loaded()
  vi.useFakeTimers()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: providersCopy.en.signIn }))
    await Promise.resolve()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000)
  })
  expect(api.pollOAuth).toHaveBeenCalledTimes(3)
  expect(api.cancelOAuth).toHaveBeenCalledWith('opaque-flaky')
  expect(screen.getByText(providersCopy.en.oauthFailed)).toBeTruthy()
})

it('keeps a cancelled sign-in cancelled when its in-flight poll fails afterwards', async () => {
  const poll = deferred<never>()

  let failPoll = (_error: Error) => {}

  const { api } = setup({
    startOAuth: vi.fn().mockResolvedValue({
      status: 'pending',
      session: 'opaque-race',
      provider: 'anthropic',
      flow: 'device_code',
      userCode: 'CODE-9999',
      expiresIn: 600,
      pollInterval: 2
    }),
    pollOAuth: vi.fn().mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failPoll = reject
          void poll.promise
        })
    )
  })

  await loaded()
  vi.useFakeTimers()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: providersCopy.en.signIn }))
    await Promise.resolve()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(api.pollOAuth).toHaveBeenCalledOnce()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: providersCopy.en.cancel }))
    failPoll(new Error('matrix_provider_request_failed'))
    await Promise.resolve()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(api.cancelOAuth).toHaveBeenCalledExactlyOnceWith('opaque-race')
  expect(screen.getByText(providersCopy.en.cancelled)).toBeTruthy()
  expect(screen.queryByText(providersCopy.en.failed)).toBeNull()
  expect(api.pollOAuth).toHaveBeenCalledOnce()
})

it('uses only exact synthetic routes and fixed typed bodies from the presentation client', async () => {
  const request = vi.fn().mockResolvedValue({ status: 'applied' })
  const api = createMatrixProviderSettingsClient(request)
  await api.snapshot()
  await api.saveKey('openrouter', 'synthetic-key')
  await api.selectModel('anthropic', 'model')
  await api.startOAuth('anthropic')
  await api.pollOAuth('opaque')
  await api.submitOAuth('opaque', 'code')
  await api.cancelOAuth('opaque')
  await api.disconnectOAuth('anthropic')
  expect(request.mock.calls).toEqual([
    [{ path: '/api/provider-settings/snapshot', method: 'GET' }],
    [{ path: '/api/provider-settings/key', method: 'PUT', body: { provider: 'openrouter', value: 'synthetic-key' } }],
    [{ path: '/api/provider-settings/select', method: 'POST', body: { provider: 'anthropic', model: 'model' } }],
    [{ path: '/api/provider-settings/oauth/acknowledge', method: 'POST', body: { provider: 'anthropic' } }],
    [{ path: '/api/provider-settings/oauth/start', method: 'POST', body: { provider: 'anthropic' } }],
    [{ path: '/api/provider-settings/oauth/poll', method: 'POST', body: { session: 'opaque' } }],
    [{ path: '/api/provider-settings/oauth/submit', method: 'POST', body: { session: 'opaque', code: 'code' } }],
    [{ path: '/api/provider-settings/oauth/cancel', method: 'POST', body: { session: 'opaque' } }],
    [{ path: '/api/provider-settings/oauth/disconnect', method: 'POST', body: { provider: 'anthropic' } }]
  ])
})
