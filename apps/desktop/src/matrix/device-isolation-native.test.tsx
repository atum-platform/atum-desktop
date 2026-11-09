import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixCommand, MatrixSnapshot } from '../../shared/matrix'

import { MatrixAdvancedSettings, matrixAdvancedSettingsAvailable } from './advanced-settings'
import { MatrixPeerIdentityPanel } from './peer-identity-panel'

const identity = { userId: '@owner:test', deviceId: 'OWNER' }
const snapshot = (extra: Partial<MatrixSnapshot> = {}): MatrixSnapshot => ({
  state: 'ready',
  identity,
  rooms: [
    { id: '!room:test', name: 'Group', membership: 'join', encrypted: true },
    { id: '!old:test', name: 'Old', membership: 'join', encrypted: true }
  ],
  roomId: null,
  messages: [],
  error: null,
  deviceIsolation: { value: 'all', writable: true },
  ...extra
})
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})
function bridge(
  command: ReturnType<typeof vi.fn<(command: MatrixCommand) => Promise<unknown>>> = vi.fn(
    async (): Promise<unknown> => null
  )
) {
  Object.assign(window, { atumMatrix: { command } })
  return command
}
function view(s: MatrixSnapshot) {
  return (
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixAdvancedSettings snapshot={s} />
    </I18nProvider>
  )
}

it('offers the native trust setting without assistant pages and waits for authoritative value', async () => {
  let resolve!: () => void
  const command = bridge(
    vi.fn(
      () =>
        new Promise<void>(done => {
          resolve = done
        })
    )
  )
  const s = snapshot()
  expect(matrixAdvancedSettingsAvailable(s)).toBe(true)
  const rendered = render(view(s))
  const toggle = screen.getByRole('switch', { name: 'Strict device trust (beta)' })
  fireEvent.click(toggle)
  expect(command).toHaveBeenCalledWith({ kind: 'deviceIsolation', identity, value: 'signed' })
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(toggle.hasAttribute('disabled')).toBe(true)
  await act(async () => resolve())
  rendered.rerender(view(snapshot({ deviceIsolation: { value: 'signed', writable: true } })))
  expect(toggle.getAttribute('aria-checked')).toBe('true')
})

it('does not write a busy setting or label a failed native change strict', async () => {
  const command = bridge(
    vi.fn(async () => {
      throw new Error('matrix_device_isolation_unavailable')
    })
  )
  const rendered = render(view(snapshot({ deviceIsolation: { value: 'all', writable: false } })))
  fireEvent.click(screen.getByRole('switch'))
  expect(command).not.toHaveBeenCalled()
  rendered.rerender(view(snapshot()))
  fireEvent.click(screen.getByRole('switch'))
  await waitFor(() => expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(false))
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
})

it('displays SDK changed and lost-verification facts distinctly and only asks native to act', async () => {
  const command = bridge(
    vi.fn(async command =>
      command.kind === 'peerIdentity' && command.action === 'read' ? 'verification_required' : null
    )
  )
  const s = snapshot({
    roomId: '!room:test',
    members: [{ userId: '@peer:test', name: 'Friend', membership: 'join', canRemove: false }]
  })
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixPeerIdentityPanel snapshot={s} />
    </I18nProvider>
  )
  await screen.findByText('Review Friend’s identity before sending again.')
  expect(screen.queryByText('Friend has a new identity. Review it before sending.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Review identity' }))
  await waitFor(() =>
    expect(command).toHaveBeenCalledWith({
      kind: 'peerIdentity',
      identity,
      roomId: '!room:test',
      userId: '@peer:test',
      action: 'review'
    })
  )
  expect(command.mock.calls.every(([input]) => input.kind === 'peerIdentity')).toBe(true)
})

it('drops a delayed peer read after switching accounts or rooms', async () => {
  let resolve!: (value: unknown) => void
  bridge(
    vi.fn(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
  )
  const s = snapshot({
    roomId: '!old:test',
    members: [{ userId: '@peer:test', name: 'Old friend', membership: 'join', canRemove: false }]
  })
  const element = (value: MatrixSnapshot) => (
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixPeerIdentityPanel snapshot={value} />
    </I18nProvider>
  )
  const rendered = render(element(s))
  rendered.rerender(element(snapshot({ identity: { userId: '@new:test', deviceId: 'NEW' } })))
  await act(async () => resolve('changed'))
  expect(screen.queryByRole('button', { name: 'Review identity' })).toBeNull()
})
