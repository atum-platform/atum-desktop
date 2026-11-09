import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { en } from '@/i18n/en'
import { vi as viLocale } from '@/i18n/vi'
import type * as AtumMessaging from '@/store/atum-messaging'

import type { MatrixAwarenessBridge, MatrixAwarenessView } from '../../../shared/matrix-awareness-controls'

const { accountScope } = await vi.hoisted(async () => {
  const { atom } = await import('nanostores')

  return { accountScope: atom<string | null>('account-a') }
})

vi.mock('@/store/atum-messaging', async importOriginal => {
  const original = await importOriginal<typeof AtumMessaging>()

  return { ...original, $atumAccountScopeId: accountScope }
})

import { AtumAwarenessSettings } from './atum-awareness-settings'

const firstIdentity = { userId: '@first:test', deviceId: 'FIRST' }
const secondIdentity = { userId: '@second:test', deviceId: 'SECOND' }

function view(identity = firstIdentity, roomId = '!first:test', name = 'First conversation'): MatrixAwarenessView {
  return {
    identity,
    rooms: [{ roomId, name, included: true, forgotten: false }]
  }
}

function renderSettings(locale: 'en' | 'vi' = 'en') {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <AtumAwarenessSettings />
    </I18nProvider>
  )
}

function install(awareness: MatrixAwarenessBridge) {
  window.atumMatrix = { awareness } as never
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void

  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })

  return { promise, reject, resolve }
}

describe('AtumAwarenessSettings', () => {
  beforeEach(() => {
    accountScope.set('account-a')
  })

  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'atumMatrix')
  })

  it('does not render without the native awareness bridge', () => {
    renderSettings()

    expect(screen.queryByRole('heading', { name: 'Conversation memory' })).toBeNull()
  })

  it('renders nothing for an account that has no awareness controls room (no owner reader)', async () => {
    const pending = deferred<Awaited<ReturnType<MatrixAwarenessBridge['read']>>>()
    const read = vi.fn<MatrixAwarenessBridge['read']>().mockReturnValueOnce(pending.promise)
    const change = vi.fn<MatrixAwarenessBridge['change']>()
    install({ read, change })

    const { container } = renderSettings()

    // No loading row while native has not confirmed the account has controls.
    expect(screen.queryByRole('heading', { name: 'Conversation memory' })).toBeNull()
    pending.resolve({ available: false })

    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(screen.queryByRole('heading', { name: 'Conversation memory' })).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.textContent).toBe('')
    expect(change).not.toHaveBeenCalled()
  })

  it('renders nothing when the first read fails before the account is known to have controls', async () => {
    const read = vi.fn<MatrixAwarenessBridge['read']>().mockRejectedValue(new Error('matrix_awareness_unavailable'))
    install({ read, change: vi.fn() })

    const { container } = renderSettings()

    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('keeps a failed read visible and retries it once the account is known to have controls', async () => {
    const read = vi.fn<MatrixAwarenessBridge['read']>()
      .mockResolvedValueOnce(view())
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(view())

    const change = vi.fn<MatrixAwarenessBridge['change']>().mockRejectedValueOnce(new Error('offline'))
    install({ read, change })

    renderSettings()

    await screen.findByText('First conversation')
    fireEvent.click(screen.getByRole('button', { name: 'Exclude' }))
    expect(await screen.findByText("Couldn't load conversations. Try again.")).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    expect(await screen.findByText("Couldn't load conversations. Try again.")).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('First conversation')).toBeTruthy()
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('discards a stale account read after the account scope changes', async () => {
    const first = deferred<MatrixAwarenessView>()

    const read = vi.fn<MatrixAwarenessBridge['read']>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(view(secondIdentity, '!second:test', 'Second conversation'))

    install({ read, change: vi.fn() })

    renderSettings()
    accountScope.set('account-b')

    expect(await screen.findByText('Second conversation')).toBeTruthy()
    first.resolve(view(firstIdentity, '!first:test', 'First conversation'))

    await waitFor(() => expect(screen.queryByText('First conversation')).toBeNull())
    expect(screen.getByText('Second conversation')).toBeTruthy()
  })

  it('uses the identity returned by native for later room changes and shows an honest pending notice', async () => {
    const change = vi.fn<MatrixAwarenessBridge['change']>()
      .mockResolvedValueOnce({
        identity: secondIdentity,
        rooms: [{ roomId: '!first:test', name: 'First conversation', included: false, forgotten: false }]
      })
      .mockResolvedValueOnce({
        identity: secondIdentity,
        rooms: [{ roomId: '!first:test', name: 'First conversation', included: true, forgotten: false }]
      })

    install({ read: vi.fn().mockResolvedValue(view()), change })

    renderSettings()

    await screen.findByText('First conversation')
    fireEvent.click(screen.getByRole('button', { name: 'Exclude' }))
    expect(await screen.findByText('Your choice is saved. It will apply when your companion connects.')).toBeTruthy()
    expect(change).toHaveBeenNthCalledWith(1, firstIdentity, '!first:test', 'exclude')

    fireEvent.click(screen.getByRole('button', { name: 'Include' }))
    await waitFor(() => expect(change).toHaveBeenNthCalledWith(2, secondIdentity, '!first:test', 'include'))
  })

  it('says, under the heading, that assistants read chats and each chat can be turned off here', async () => {
    install({ read: vi.fn().mockResolvedValue(view()), change: vi.fn() })
    renderSettings()

    await screen.findByText('First conversation')
    expect(screen.getByText(en.atum.awareness.settings.privacy)).toBeTruthy()
  })

  it('says it in Vietnamese', async () => {
    install({ read: vi.fn().mockResolvedValue(view()), change: vi.fn() })
    renderSettings('vi')

    await screen.findByText('First conversation')
    expect(screen.getByText(viLocale.atum.awareness.settings.privacy)).toBeTruthy()
  })

  it('requires an inline confirmation before forgetting a conversation', async () => {
    const change = vi.fn<MatrixAwarenessBridge['change']>().mockResolvedValue(view())
    install({ read: vi.fn().mockResolvedValue(view()), change })

    renderSettings()

    await screen.findByText('First conversation')
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }))
    expect(change).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Forget' }))
    await waitFor(() => expect(change).toHaveBeenCalledWith(firstIdentity, '!first:test', 'forget'))
  })
})
