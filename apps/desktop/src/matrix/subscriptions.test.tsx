import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixSubscriptionsBridge } from '../../shared/matrix'
import type {
  MatrixSubscriptionPoll,
  MatrixSubscriptionsStatus,
  MatrixSubscriptionStart
} from '../../shared/matrix-subscriptions'

import { matrixSettingsCopy } from './settings-copy'
import { SubscriptionConnectDialog } from './subscriptions'

// Radix's dialog measures itself; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

const EMPTY: MatrixSubscriptionsStatus = { scope: 'account', providers: [] }

function bridge(start: MatrixSubscriptionStart, poll?: MatrixSubscriptionPoll): MatrixSubscriptionsBridge {
  return {
    status: vi.fn(async (): Promise<MatrixSubscriptionsStatus> => EMPTY),
    catalog: vi.fn(async () => ({ destination: 'this_mac' as const, providers: [] })),
    startChatGpt: vi.fn(async (): Promise<MatrixSubscriptionStart> => start),
    pollChatGpt: vi.fn(async (): Promise<MatrixSubscriptionPoll> => poll ?? { status: 'failed' }),
    cancelChatGpt: vi.fn(async () => undefined),
    disconnectChatGpt: vi.fn(async () => undefined),
    useThisMacForChatGpt: vi.fn(async () => ({ status: 'applied' as const })),
    connectOpenCode: vi.fn(async () => ({ status: 'applied' as const })),
    disconnectOpenCode: vi.fn(async () => undefined)
  }
}

const waiting: MatrixSubscriptionStart = {
  status: 'pending',
  session: 'opaque',
  provider: 'openai-codex',
  userCode: 'ABCD-1234',
  url: 'https://auth.openai.com/codex/device',
  expiresIn: 900,
  pollInterval: 0.01
}

function open(value: MatrixSubscriptionsBridge, locale: Locale = 'en') {
  const onClose = vi.fn()
  const onConnected = vi.fn()

  render(
    <I18nProvider initialLocale={locale}>
      <SubscriptionConnectDialog
        bridge={value}
        onClose={onClose}
        onConnected={onConnected}
        open
        provider="openai-codex"
      />
    </I18nProvider>
  )

  return { onClose, onConnected }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('a ChatGPT sign-in this account cannot keep', () => {
  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as Locale[])(
    'says it in one plain line, with no code, when main refuses to start in %s',
    async locale => {
      const copy = matrixSettingsCopy(locale)
      const api = bridge({ status: 'carried' })
      open(api, locale)

      expect(await screen.findByText(copy.chatgptCarried)).toBeTruthy()
      expect(api.pollChatGpt).not.toHaveBeenCalled()
      expect(screen.queryByText(copy.failed)).toBeNull()
      expect(screen.queryByText(copy.tryAgain)).toBeNull()
      // No sign-in code was ever shown: nothing started.
      expect(screen.queryByText('ABCD-1234')).toBeNull()
    }
  )

  it('says the same thing when the flow ends with a discarded sign-in', async () => {
    const api = bridge(waiting, { status: 'carried' })
    open(api)

    expect(await screen.findByText(matrixSettingsCopy('en').chatgptCarried)).toBeTruthy()
    expect(screen.queryByText(matrixSettingsCopy('en').failed)).toBeNull()
  })

  it('still offers Try again for an ordinary failure', async () => {
    const api = bridge(waiting, { status: 'failed' })
    open(api)

    expect(await screen.findByText(matrixSettingsCopy('en').failed)).toBeTruthy()
    expect(screen.getByRole('button', { name: matrixSettingsCopy('en').tryAgain })).toBeTruthy()
    expect(screen.queryByText(matrixSettingsCopy('en').chatgptCarried)).toBeNull()
  })
})
