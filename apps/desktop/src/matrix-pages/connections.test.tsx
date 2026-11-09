import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type {
  MatrixProviderRow,
  MatrixProviderSettingsClient,
  MatrixProviderSnapshot
} from '../../shared/matrix-provider-settings'

import { localConnectionName, MatrixConnections } from './connections'
import { connectionsCopy } from './connections-copy'

// The shared model card measures itself (Radix); jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

const row = (id: string, extra: Partial<MatrixProviderRow> = {}): MatrixProviderRow => ({
  id,
  name: id,
  ready: false,
  current: false,
  models: [],
  keyAvailable: false,
  keySet: false,
  oauth: null,
  ...extra
})

function base(): MatrixProviderSnapshot {
  return {
    current: { provider: 'atum-gateway', model: 'nguyet-thuc' },
    providers: [
      row('atum-gateway', { name: 'Atum', ready: true, current: true, models: ['nguyet-thuc'] }),
      row('openai-codex', {
        name: 'OpenAI Codex',
        oauth: { flow: 'device_code', connected: false, supported: true, disconnectable: true }
      }),
      row('openai-api', { name: 'OpenAI API', keyAvailable: true }),
      row('gemini', { name: 'Google AI Studio', keyAvailable: true }),
      row('anthropic', {
        name: 'Anthropic',
        keyAvailable: true,
        oauth: { flow: 'pkce', connected: false, supported: false, disconnectable: true }
      }),
      row('openrouter', {
        name: 'OpenRouter',
        keyAvailable: true,
        keySet: true,
        ready: true,
        models: ['a/one', 'b/two']
      }),
      row('nvidia', { name: 'NVIDIA', keyAvailable: true })
    ]
  }
}

function client(snapshots: MatrixProviderSnapshot[], overrides: Partial<MatrixProviderSettingsClient> = {}) {
  const queue = [...snapshots]
  let last = queue[0]!

  return {
    snapshot: vi.fn(async () => {
      last = queue.shift() ?? last

      return last
    }),
    saveKey: vi.fn().mockResolvedValue({ status: 'applied' }),
    selectModel: vi.fn().mockResolvedValue({ status: 'applied' }),
    addEndpoint: vi.fn().mockResolvedValue({ status: 'applied' }),
    startOAuth: vi.fn().mockResolvedValue({
      status: 'pending',
      session: 'opaque',
      provider: 'openai-codex',
      flow: 'device_code',
      userCode: 'ABCD-1234',
      expiresIn: 900,
      pollInterval: 0.01
    }),
    pollOAuth: vi.fn().mockResolvedValue({ status: 'pending' }),
    submitOAuth: vi.fn(),
    cancelOAuth: vi.fn().mockResolvedValue({ status: 'cancelled' }),
    disconnectOAuth: vi.fn().mockResolvedValue({ status: 'applied' }),
    ...overrides
  } satisfies MatrixProviderSettingsClient
}

function setup(api: MatrixProviderSettingsClient, locale: Locale = 'en') {
  const openExternal = vi.fn()
  const openAdvanced = vi.fn()

  render(
    <I18nProvider initialLocale={locale}>
      <MatrixConnections agentName="Ada" client={api} onOpenAdvanced={openAdvanced} onOpenExternal={openExternal} />
    </I18nProvider>
  )

  return { openExternal, openAdvanced }
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Connections, for a person who is not technical', () => {
  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as Locale[])('guides each part in plain words in %s', async locale => {
    const copy = connectionsCopy[locale]
    setup(client([base()]), locale)
    expect(await screen.findByRole('heading', { name: copy.title })).toBeTruthy()
    expect(screen.getByText(copy.usingAtum)).toBeTruthy()
    expect(screen.queryByRole('button', { name: copy.getCode })).toBeNull()
    expect(screen.getByText(copy.advancedHelp)).toBeTruthy()
    expect(screen.getByText(copy.keysTitle)).toBeTruthy()
    expect(screen.getByText(copy.localTitle)).toBeTruthy()
    // No engine words in the primary copy.
    expect(window.document.body.textContent).not.toMatch(/OAuth|provider|endpoint|token/i)
  })

  it('offers API keys only for the four named services', async () => {
    setup(client([base()]))
    await screen.findByText('API keys')

    for (const name of ['OpenAI', 'Google AI Studio', 'Anthropic API', 'OpenRouter']) {
      expect(screen.getByText(name)).toBeTruthy()
    }

    expect(screen.queryByText('NVIDIA')).toBeNull()
  })

  it('keeps new plan sign-ins in the native Advanced page, including a forged supported snapshot', async () => {
    const api = client([base()])
    const { openAdvanced } = setup(api)
    fireEvent.click(await screen.findByText(connectionsCopy.en.advancedHelp))
    expect(openAdvanced).toHaveBeenCalledOnce()
    expect(api.startOAuth).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Get a code' })).toBeNull()
  })

  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as Locale[])(
    'shows ChatGPT while signed out, with one button to the page where the sign-in lives, in %s',
    async locale => {
      const copy = connectionsCopy[locale]
      const api = client([base()])
      const { openAdvanced } = setup(api, locale)

      fireEvent.click(await screen.findByRole('button', { name: copy.chatgptSignIn }))
      expect(openAdvanced).toHaveBeenCalledOnce()
      expect(api.startOAuth).not.toHaveBeenCalled()
      expect(screen.getByText(copy.chatgptTitle)).toBeTruthy()
      expect(screen.queryByText(copy.chatgptConnected)).toBeNull()
      expect(screen.queryByRole('button', { name: copy.useChatgpt })).toBeNull()
      expect(screen.queryByRole('button', { name: copy.disconnect })).toBeNull()
    }
  )

  it('shows no ChatGPT card when the engine has no ChatGPT plan', async () => {
    const without = base()
    without.providers = without.providers.filter(provider => provider.id !== 'openai-codex')
    setup(client([without]))
    await screen.findByText('API keys')
    expect(screen.queryByText(connectionsCopy.en.chatgptTitle)).toBeNull()
    expect(screen.queryByRole('button', { name: connectionsCopy.en.chatgptSignIn })).toBeNull()
  })

  it('keeps an existing plan visible and disconnectable on Connections', async () => {
    const connected = base()
    connected.providers[1] = row('openai-codex', {
      ready: true,
      models: ['gpt-5.5'],
      oauth: { flow: 'device_code', connected: true, supported: false, disconnectable: true }
    })
    const api = client([connected])
    const { openAdvanced } = setup(api)
    expect(await screen.findByText('Connected')).toBeTruthy()
    expect(screen.queryByRole('button', { name: connectionsCopy.en.chatgptSignIn })).toBeNull()
    expect(screen.getByRole('button', { name: connectionsCopy.en.useChatgpt })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(openAdvanced).not.toHaveBeenCalled()
    await waitFor(() => expect(api.disconnectOAuth).toHaveBeenCalledWith('openai-codex'))
    expect(api.startOAuth).not.toHaveBeenCalled()
  })

  it('says why, and opens Advanced to sign in again, when the assistant answers with ChatGPT and is signed out', async () => {
    const signedOut = base()
    signedOut.current = { provider: 'openai-codex', model: 'gpt-5.5' }
    const api = client([signedOut])
    const { openAdvanced } = setup(api)

    expect(await screen.findByText(connectionsCopy.en.chatgptSignInAgain)).toBeTruthy()
    // One sign-in action, not two side by side: the band explains, the card's button acts.
    expect(screen.queryByRole('button', { name: connectionsCopy.en.advancedTitle })).toBeNull()
    const signIn = screen.getAllByRole('button', { name: connectionsCopy.en.chatgptSignIn })
    expect(signIn).toHaveLength(1)
    fireEvent.click(signIn[0]!)
    expect(openAdvanced).toHaveBeenCalledOnce()
    expect(api.startOAuth).not.toHaveBeenCalled()
    cleanup()

    // On Atum's AI, nothing to sign in again.
    setup(client([base()]))
    await screen.findByText('API keys')
    expect(screen.queryByText(connectionsCopy.en.chatgptSignInAgain)).toBeNull()
  })

  it('saves a key, then uses a model it unlocks', async () => {
    const api = client([base()])
    setup(api)
    await screen.findByText('API keys')
    fireEvent.click(screen.getAllByRole('button', { name: 'Add key' })[0]!)
    fireEvent.change(screen.getByLabelText('OpenAI key'), { target: { value: 'synthetic-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
    await waitFor(() => expect(api.saveKey).toHaveBeenCalledWith('openai-api', 'synthetic-key'))

    // OpenRouter already has a key: its models are in the shared model card, one click each.
    fireEvent.click(screen.getByRole('button', { name: 'Choose a model · OpenRouter' }))
    const card = await screen.findByRole('dialog', { name: 'Choose a model · OpenRouter' })
    expect(card.querySelector('[data-matrix-model-rail-item="openrouter"]')).toBeTruthy()
    expect(within(card).getByRole('textbox', { name: 'Search models…' })).toBeTruthy()
    fireEvent.click(card.querySelector<HTMLElement>('[data-matrix-model-route="openrouter:a/one"]')!)
    await waitFor(() => expect(api.selectModel).toHaveBeenCalledWith('openrouter', 'a/one'))
  })

  it('connects a model on this Mac by its name, and reuses the same one next time', async () => {
    const after = base()
    after.providers.push(
      row('atum-provider-1', { name: 'LM Studio llama3.2-3b', ready: true, models: ['llama3.2:3b'] })
    )
    const api = client([base(), after])
    setup(api)
    await screen.findByText('Models on this Mac')
    fireEvent.click(screen.getByRole('button', { name: 'LM Studio' }))
    fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'llama3.2:3b' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() =>
      expect(api.addEndpoint).toHaveBeenCalledWith({
        name: 'LM Studio llama3.2-3b',
        baseUrl: 'http://127.0.0.1:1234/v1',
        model: 'llama3.2:3b',
        apiKey: ''
      })
    )
    await waitFor(() => expect(api.selectModel).toHaveBeenCalledWith('atum-provider-1', 'llama3.2:3b'))

    cleanup()
    const again = client([after])
    setup(again)
    await screen.findByText('Models on this Mac')
    fireEvent.click(screen.getByRole('button', { name: 'LM Studio' }))
    fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'llama3.2:3b' } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(again.selectModel).toHaveBeenCalledWith('atum-provider-1', 'llama3.2:3b'))
    expect(again.addEndpoint).not.toHaveBeenCalled()
  })

  it("names what answers now and goes back to Atum's AI in one step", async () => {
    const onChatGpt = base()
    onChatGpt.current = { provider: 'openai-codex', model: 'gpt-5.5' }
    const api = client([onChatGpt])
    setup(api)
    expect(await screen.findByText('Answering with ChatGPT · GPT-5.5')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Switch back to Atum’s AI' }))
    await waitFor(() => expect(api.selectModel).toHaveBeenCalledWith('atum-gateway', 'nguyet-thuc'))
  })

  it('names a local connection the way the engine accepts', () => {
    expect(localConnectionName('Ollama', 'qwen2.5:7b-instruct')).toBe('Ollama qwen2.5-7b-instruct')
    expect(localConnectionName('LM Studio', 'org/model@q4')).toBe('LM Studio org-model-q4')
    expect(/^[\p{L}\p{N}][\p{L}\p{N} ._()-]*$/u.test(localConnectionName('Ollama', 'a/b:c'))).toBe(true)
  })
})
