import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  MatrixBackgroundSweepBridge,
  MatrixBackgroundSweepSaveResult,
  MatrixBackgroundSweepSetting
} from '../../../shared/background-sweep'
import { MATRIX_BACKGROUND_SWEEP_SETTING_PROFILE } from '../../../shared/background-sweep'

import { BackgroundSweepRow } from './background-sweep-row'
import { assistantCardCopies } from './copy'
import { $backgroundSweepSettings } from './store'

const AGENT = '00000000-0000-4000-8000-288c0dd127cf'
const setting = (enabled = true, revision = 1): MatrixBackgroundSweepSetting => ({
  profile: MATRIX_BACKGROUND_SWEEP_SETTING_PROFILE,
  assistantId: AGENT,
  enabled,
  revision,
  activeForOwner: true
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function row(bridge: MatrixBackgroundSweepBridge, ownerKey = '@owner:test\nDEVICE') {
  return <BackgroundSweepRow agentPrincipal={AGENT} bridge={bridge} copy={assistantCardCopies.en} ownerKey={ownerKey} />
}

beforeEach(() => {
  $backgroundSweepSettings.set({})
})

describe('the assistant card background follow-up switch', () => {
  it('never paints an unknown read as default-on', async () => {
    const read = deferred<MatrixBackgroundSweepSetting>()
    const bridge = { read: vi.fn(() => read.promise), save: vi.fn() } as unknown as MatrixBackgroundSweepBridge
    render(row(bridge))

    const toggle = screen.getByRole('switch', { name: 'Background follow-ups' }) as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.disabled).toBe(true)
    expect(document.querySelector('.atum-spinner')).toBeTruthy()

    read.reject(new Error('offline'))
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.disabled).toBe(true)
  })

  it('reads true and keeps the short localized accessible label', async () => {
    const bridge = { read: vi.fn(async () => setting()), save: vi.fn() } as unknown as MatrixBackgroundSweepBridge
    render(row(bridge))

    const toggle = await screen.findByRole('switch', { name: 'Background follow-ups' })
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    expect(screen.getByText('Background follow-ups')).toBeTruthy()
    expect(document.querySelector('[data-assistant-card-background-sweep]')?.textContent).toBe('Background follow-ups')
  })

  it('updates optimistically, preserves focus while pending, and commits server truth', async () => {
    const save = deferred<MatrixBackgroundSweepSaveResult>()
    const bridge = {
      read: vi.fn(async () => setting()),
      save: vi.fn(() => save.promise)
    } as MatrixBackgroundSweepBridge
    render(row(bridge))
    const toggle = await screen.findByRole('switch', { name: 'Background follow-ups' })
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))

    toggle.focus()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(document.activeElement).toBe(toggle)
    expect(toggle.getAttribute('aria-busy')).toBe('true')
    expect(bridge.save).toHaveBeenCalledWith(
      AGENT,
      expect.objectContaining({
        profile: MATRIX_BACKGROUND_SWEEP_SETTING_PROFILE,
        expectedRevision: 1,
        enabled: false
      })
    )

    save.resolve({ status: 'saved', setting: setting(false, 2) })
    await waitFor(() => expect(toggle.hasAttribute('aria-busy')).toBe(false))
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(document.activeElement).toBe(toggle)
  })

  it('rolls back a failed save and retries the same intent', async () => {
    const first = deferred<MatrixBackgroundSweepSaveResult>()
    const bridge = {
      read: vi.fn(async () => setting()),
      save: vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValueOnce({ status: 'saved', setting: setting(false, 2) })
    } as MatrixBackgroundSweepBridge
    render(row(bridge))
    const toggle = await screen.findByRole('switch', { name: 'Background follow-ups' })
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))

    fireEvent.click(toggle)
    first.reject(new Error('offline'))
    const retry = await screen.findByRole('button', { name: 'Try again' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(retry)
    await waitFor(() => expect(bridge.save).toHaveBeenCalledTimes(2))
    expect(bridge.save).toHaveBeenLastCalledWith(
      AGENT,
      expect.objectContaining({ enabled: false, expectedRevision: 1 })
    )
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
  })

  it('does not let an older read overwrite a newer request for the same scope', async () => {
    const old = deferred<MatrixBackgroundSweepSetting>()
    const current = deferred<MatrixBackgroundSweepSetting>()
    const bridge = {
      read: vi
        .fn()
        .mockImplementationOnce(() => old.promise)
        .mockImplementationOnce(() => current.promise),
      save: vi.fn()
    } as unknown as MatrixBackgroundSweepBridge
    const view = render(row(bridge))
    view.unmount()
    render(row(bridge))

    current.resolve(setting(false, 2))
    const toggle = screen.getByRole('switch', { name: 'Background follow-ups' }) as HTMLButtonElement
    await waitFor(() => expect(toggle.disabled).toBe(false))
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    await act(async () => old.resolve(setting(true, 1)))
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })
})
