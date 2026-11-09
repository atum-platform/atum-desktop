import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixDeviceStatus } from '../../shared/matrix-device'

import { MatrixCloudDeviceSettings } from './cloud-device-settings'

const status: MatrixDeviceStatus = {
  available: true,
  enrolled: true,
  deviceName: 'Test Mac',
  active: false,
  cloudAgents: [{ userId: '@t:test', name: 'T' }],
  grants: [],
  grantable: ['ssh_agent']
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  Reflect.deleteProperty(window, 'atumDevice')
  Reflect.deleteProperty(window, 'atumMatrix')
})

function page(key = 'owner', locale: 'en' | 'vi' | 'ja' | 'zh' | 'zh-hant' = 'en') {
  return (
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixCloudDeviceSettings key={key} />
    </I18nProvider>
  )
}

it('shows automatic enrollment as read-only status and never offers an enrollment prompt', async () => {
  const cloudAgent = vi.fn()
  Object.assign(window, {
    atumDevice: { status: async () => ({ ...status, enrolled: false }) },
    atumMatrix: { cloudAgent }
  })

  render(page())

  expect(await screen.findByText('Reconnecting…')).toBeTruthy()
  expect(screen.queryByRole('switch')).toBeNull()
  expect(screen.queryByRole('button', { name: /turn on|enroll|connect this mac/i })).toBeNull()
  expect(cloudAgent).not.toHaveBeenCalled()
})

it('uses the owner wording for ready and reconnecting in every locale', async () => {
  const states = [
    ['en', 'Ready to use', 'Reconnecting…'],
    ['vi', 'Đang dùng được', 'Đang kết nối lại…'],
    ['ja', '使用できます', '再接続中…'],
    ['zh', '可以使用', '正在重新连接…'],
    ['zh-hant', '可以使用', '正在重新連線…']
  ] as const

  for (const [locale, ready, reconnecting] of states) {
    Object.assign(window, { atumDevice: { status: async () => status } })
    const view = render(page(`ready-${locale}`, locale))
    expect(await screen.findByText(ready)).toBeTruthy()
    view.unmount()

    Object.assign(window, { atumDevice: { status: async () => ({ ...status, enrolled: false }) } })
    const retrying = render(page(`retry-${locale}`, locale))
    expect(await screen.findByText(reconnecting)).toBeTruthy()
    retrying.unmount()
  }
})

it('keeps optional risky standing permissions folded away from the status line', async () => {
  Object.assign(window, { atumDevice: { status: async () => status } })
  const view = render(page('owner', 'vi'))

  await screen.findByText('Đang dùng được')
  expect(screen.queryByRole('switch')).toBeNull()
  const fold = view.container.querySelector('details')
  expect(fold?.open).toBe(false)
  expect(fold?.querySelector('summary')?.textContent).toBe('Nâng cao')
})

it('grants a risky permission through the existing Touch ID path only after both choices', async () => {
  let value: MatrixDeviceStatus = status
  const addGrant = vi.fn(async () => {
    value = {
      ...status,
      grants: [{ id: 'grant-1', capability: 'ssh_agent', target: '', label: 'SSH', agentName: 'T' }]
    }
  })

  Object.assign(window, { atumDevice: { status: async () => value, addGrant, revokeGrant: vi.fn() } })
  render(page())
  const allowButton = await screen.findByRole('button', { name: 'Allow with Touch ID' })
  expect((allowButton as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }))
  fireEvent.click(await screen.findByRole('option', { name: 'T' }))
  fireEvent.click(screen.getByRole('combobox', { name: 'Permission' }))
  fireEvent.click(await screen.findByRole('option'))
  fireEvent.click(allowButton)
  await act(async () => {})
  expect(addGrant).toHaveBeenCalledWith('ssh_agent', '@t:test')
})

it('offers Stop only while an assistant is using this Mac', async () => {
  let value: MatrixDeviceStatus = { ...status, active: true }
  const stop = vi.fn(async () => {
    value = { ...status, active: false }
  })

  Object.assign(window, { atumDevice: { status: async () => value, stop } })
  render(page())
  expect(await screen.findByText('An agent is using this Mac now.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Stop now' }))
  expect(stop).toHaveBeenCalledOnce()
  await act(async () => {})
  expect(screen.queryByRole('button', { name: 'Stop now' })).toBeNull()
})

it('drops a late status reply from the previous account-keyed pane', async () => {
  let resolve!: (value: MatrixDeviceStatus) => void
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<MatrixDeviceStatus>(yes => {
          resolve = yes
        })
    )
    .mockResolvedValue({ ...status, enrolled: false })

  Object.assign(window, { atumDevice: { status: read } })
  const view = render(page('old'))
  view.rerender(page('new'))
  expect(await screen.findByText('Reconnecting…')).toBeTruthy()
  await act(async () => resolve(status))
  expect(screen.queryByText('Ready to use')).toBeNull()
})

it('clears a transient status failure after the automatic read succeeds', async () => {
  vi.useFakeTimers()
  const read = vi.fn().mockRejectedValueOnce(new Error('temporary native read failure')).mockResolvedValue(status)

  Object.assign(window, { atumDevice: { status: read } })
  render(page())
  await act(async () => {})
  expect(screen.getByText(/temporarily unavailable/u)).toBeTruthy()

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000)
  })
  expect(read).toHaveBeenCalledTimes(2)
  expect(screen.queryByText(/temporarily unavailable/u)).toBeNull()
  expect(screen.getByText('Ready to use')).toBeTruthy()
})
