import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixSubscriptionsBridge } from '../../shared/matrix'
import type { MatrixChatGptTrainingRevokeResult, MatrixChatGptTrainingStatus } from '../../shared/matrix-subscriptions'

import { ChatGptTrainingSettings } from './chatgpt-training-settings'

afterEach(cleanup)

const CONFIRMED_AT = Date.UTC(2026, 10, 16, 3)

const status = (value: Partial<MatrixChatGptTrainingStatus> = {}): MatrixChatGptTrainingStatus => ({
  required: true,
  current: true,
  connectionId: '0a1b2c3d-0000-4000-8000-00000000000a',
  confirmedAt: CONFIRMED_AT,
  ...value
})

const revoked: MatrixChatGptTrainingRevokeResult = {
  status: 'revoked',
  training: status({ current: false, connectionId: null, confirmedAt: null })
}

function bridge(read: MatrixChatGptTrainingStatus | Error, revoke: Array<MatrixChatGptTrainingRevokeResult | Promise<MatrixChatGptTrainingRevokeResult>> = []) {
  const queue = [...revoke]

  return {
    chatGptTraining: vi.fn<NonNullable<MatrixSubscriptionsBridge['chatGptTraining']>>(async () => {
      if (read instanceof Error) {
        throw read
      }

      return read
    }),
    revokeChatGptTraining: vi.fn<NonNullable<MatrixSubscriptionsBridge['revokeChatGptTraining']>>(
      async () => (await queue.shift()) ?? { status: 'unavailable' }
    )
  }
}

function show(value: ReturnType<typeof bridge>, locale: 'en' | 'vi' = 'en') {
  render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <ChatGptTrainingSettings bridge={value} scopeKey="owner" />
    </I18nProvider>
  )
}

const row = () => document.querySelector<HTMLElement>('[data-matrix-chatgpt-training-settings]')

describe('Settings › Connections: ChatGPT with Google data', () => {
  it('shows the confirmation date and Revoke; Revoking… stays until the drain lands, then not confirmed', async () => {
    let finish: (value: MatrixChatGptTrainingRevokeResult) => void = () => {}

    const slow = new Promise<MatrixChatGptTrainingRevokeResult>(resolve => {
      finish = resolve
    })

    const value = bridge(status(), [{ status: 'pending' }, slow])
    show(value)

    const date = new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(CONFIRMED_AT)
    expect(await screen.findByText(`Training off, confirmed ${date}`)).toBeTruthy()
    expect(row()?.dataset.matrixChatgptTrainingSettings).toBe('confirmed')

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(value.revokeChatGptTraining).toHaveBeenCalledTimes(2))
    expect(row()?.dataset.matrixChatgptTrainingSettings).toBe('revoking')
    expect((screen.getByRole('button', { name: 'Revoking…' }) as HTMLButtonElement).disabled).toBe(true)

    await act(async () => finish(revoked))
    expect(await screen.findByText(/Not confirmed\. You’ll be asked once/u)).toBeTruthy()
    expect(row()?.dataset.matrixChatgptTrainingSettings).toBe('not_confirmed')
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull()
  })

  it('resumes a revocation pending from before a restart without a press, and reads Revoking…', async () => {
    let finish: (value: MatrixChatGptTrainingRevokeResult) => void = () => {}

    const value = bridge(status({ revoking: true }), [
      new Promise(resolve => {
        finish = resolve
      })
    ])

    show(value)

    await waitFor(() => expect(value.revokeChatGptTraining).toHaveBeenCalledOnce())
    expect(row()?.dataset.matrixChatgptTrainingSettings).toBe('revoking')
    expect(screen.getAllByText('Revoking…').length).toBeGreaterThan(0)

    await act(async () => finish(revoked))
    expect(row()?.dataset.matrixChatgptTrainingSettings).toBe('not_confirmed')
  })

  it('a long drain or a failure is one calm line with Try again, which retries', async () => {
    const value = bridge(status(), [
      ...Array.from({ length: 8 }, () => ({ status: 'pending' as const })),
      { status: 'unavailable' },
      revoked
    ])

    show(value)

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }))
    expect(await screen.findByText(/still finishing/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Couldn’t revoke right now. Try again.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(row()?.dataset.matrixChatgptTrainingSettings).toBe('not_confirmed'))
  })

  it('a failed read offers Try again; an account with no Google and nothing confirmed shows no row', async () => {
    const failing = bridge(new Error('offline'))
    show(failing)
    expect(await screen.findByText('Couldn’t check this right now.')).toBeTruthy()

    cleanup()
    const quiet = bridge(status({ required: false, current: false, confirmedAt: null }))
    show(quiet)
    await waitFor(() => expect(quiet.chatGptTraining).toHaveBeenCalled())
    expect(row()).toBeNull()
  })

  it('reads in Vietnamese', async () => {
    show(bridge(status()), 'vi')

    expect(await screen.findByText(/^Đã tắt huấn luyện, xác nhận ngày /u)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Thu hồi' })).toBeTruthy()
    expect(screen.getByText('ChatGPT với dữ liệu Google')).toBeTruthy()
  })
})
