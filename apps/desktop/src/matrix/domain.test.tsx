import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixEnrollment, MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'

import { AssistantRepair, DomainIdentity } from './domain'

const absent: MatrixEnrollment = { state: 'absent', identity: null }
const ready: MatrixEnrollment = { state: 'ready', identity: null }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void

  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })

  return { promise, resolve, reject }
}

function fixture() {
  const enrollment = vi.fn(async (): Promise<MatrixEnrollment> => absent)
  const enrollHermes = vi.fn(async (): Promise<MatrixEnrollment> => ready)
  const revokeHermes = vi.fn(async (): Promise<MatrixEnrollment> => absent)
  window.atumMatrix = { enrollment, enrollHermes, revokeHermes } as unknown as MatrixUiBridge

  const element = (visible: boolean) => (
    <I18nProvider configClient={null} initialLocale="en">
      <DomainIdentity visible={visible} />
    </I18nProvider>
  )

  const view = render(element(false))

  return {
    enrollment,
    enrollHermes,
    revokeHermes,
    ...view,
    reveal: (visible = true) => view.rerender(element(visible))
  }
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

it('refreshes on reveal, rejects older reads, and never enrolls or revokes automatically', async () => {
  const f = fixture()
  expect(f.enrollment).not.toHaveBeenCalled()
  const old = deferred<MatrixEnrollment>()
  f.enrollment.mockReturnValueOnce(old.promise)
  f.reveal()
  f.reveal(false)
  f.reveal()
  await screen.findByText('Not connected')
  await act(async () => old.resolve(ready))
  expect(screen.queryByText('Connected on this Mac')).toBeNull()
  expect(f.enrollment).toHaveBeenCalledTimes(2)
  expect(f.enrollHermes).not.toHaveBeenCalled()
  expect(f.revokeHermes).not.toHaveBeenCalled()
})

it('does not refresh over a pending write or let an earlier read undo its result', async () => {
  const f = fixture()
  f.reveal()
  await screen.findByText('Not connected')
  const stale = deferred<MatrixEnrollment>()
  f.enrollment.mockReturnValueOnce(stale.promise)
  f.reveal(false)
  f.reveal()
  const write = deferred<MatrixEnrollment>()
  f.enrollHermes.mockReturnValueOnce(write.promise)
  fireEvent.click(screen.getByRole('button', { name: 'Connect assistant' }))
  f.reveal(false)
  f.reveal()
  expect(f.enrollment).toHaveBeenCalledTimes(2)
  expect((screen.getByRole('button', { name: 'Connect assistant' }) as HTMLButtonElement).disabled).toBe(true)
  f.reveal(false)
  await act(async () => write.resolve(ready))
  await act(async () => stale.resolve(absent))
  expect(screen.getByText('Connected on this Mac')).toBeTruthy()
  expect(f.enrollHermes).toHaveBeenCalledOnce()
  f.reveal()
  await screen.findByText('Not connected')
  expect(f.enrollment).toHaveBeenCalledTimes(3)
})

it('reports failed refresh as unknown instead of showing stale registration, and can retry', async () => {
  const f = fixture()
  f.enrollment.mockResolvedValueOnce(ready)
  f.reveal()
  await screen.findByText('Connected on this Mac')
  f.reveal(false)
  f.enrollment.mockRejectedValueOnce(new Error('private vault details'))
  f.reveal()
  const retry = await screen.findByRole('button', { name: 'Reconnect' })
  expect(screen.queryByText('Connected on this Mac')).toBeNull()
  expect(screen.queryByText(/private vault/)).toBeNull()
  expect((screen.getByRole('button', { name: 'Connect assistant' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(retry)
  await screen.findByText('Not connected')
  expect(f.enrollHermes).not.toHaveBeenCalled()
})

it('ignores a previous account read after unmount', async () => {
  const f = fixture()
  const old = deferred<MatrixEnrollment>()
  f.enrollment.mockReturnValueOnce(old.promise)
  f.reveal()
  f.unmount()
  const next = fixture()
  next.reveal()
  await screen.findByText('Not connected')
  await act(async () => old.resolve(ready))
  expect(screen.queryByText('Connected on this Mac')).toBeNull()
})

it('keeps a withdrawn connection visible without offering enrollment or destructive disconnect as recovery', async () => {
  const f = fixture()
  f.enrollment.mockResolvedValue({ state: 'withdrawn', identity: null })
  f.reveal()
  await screen.findByText('This Mac can no longer run this assistant. Your chats and saved setup are kept.')
  expect(screen.queryByRole('button', { name: 'Connect assistant' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull()
  expect(f.enrollHermes).not.toHaveBeenCalled()
  expect(f.revokeHermes).not.toHaveBeenCalled()
  f.reveal(false)
  f.reveal()
  await screen.findByText('This Mac can no longer run this assistant. Your chats and saved setup are kept.')
  expect(f.enrollment).toHaveBeenCalledTimes(2)
  expect(f.enrollHermes).not.toHaveBeenCalled()
  expect(f.revokeHermes).not.toHaveBeenCalled()
})

describe('Assistant not answering? Repair', () => {
  const snapshot = (readiness: MatrixSnapshot['readiness']): MatrixSnapshot => ({
    state: 'ready',
    identity: { userId: '@owner:test', deviceId: 'D' },
    rooms: [],
    roomId: null,
    messages: [],
    error: null,
    readiness
  })

  function draw(value: MatrixSnapshot) {
    const retryReadiness = vi.fn(async () => {})
    window.atumMatrix = { retryReadiness } as unknown as MatrixUiBridge

    const view = render(
      <I18nProvider configClient={null} initialLocale="en">
        <AssistantRepair snapshot={value} />
      </I18nProvider>
    )

    return { retryReadiness, view }
  }

  it('runs the checks again and says the assistant is ready', async () => {
    vi.useFakeTimers()

    try {
      const { retryReadiness } = draw(snapshot({ phase: 'ready', since: 1 }))
      fireEvent.click(screen.getByRole('button', { name: 'Repair' }))
      expect(retryReadiness).toHaveBeenCalledOnce()
      expect(screen.getByText('Checking your assistant…')).toBeTruthy()
      await act(async () => vi.advanceTimersByTime(1_600))
      expect(screen.getByText('Your assistant is ready.')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says what is wrong in plain words, with the one action that helps', async () => {
    vi.useFakeTimers()

    try {
      draw(snapshot({ phase: 'blocked', step: 'ai', code: 'ai_unavailable', since: 1 }))
      fireEvent.click(screen.getByRole('button', { name: 'Repair' }))
      await act(async () => vi.advanceTimersByTime(1_600))
      expect(screen.getByText('Atum’s AI isn’t responding')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
      expect(screen.queryByText(/principal/i)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
