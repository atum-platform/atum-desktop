import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { ACME, botApp } from '../../../shared/app-catalog.test-support'
import type { MatrixSnapshot, MatrixUiBridge } from '../../../shared/matrix'

import { AppBotSettings } from './settings'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

it('lists chat apps as squircle sources with a switch, never a stop-using text action', async () => {
  const app = botApp(ACME)
  const botRevoke = vi.fn(async () => {})
  const refresh = vi.fn(async () => {})
  window.atumMatrix = { apps: { botRevoke, refresh } } as unknown as MatrixUiBridge

  const snapshot: MatrixSnapshot = {
    state: 'ready',
    identity: { userId: '@owner:test', deviceId: 'MAC' },
    rooms: [],
    roomId: null,
    messages: [],
    error: null,
    apps: { state: 'ready', apps: [app], connections: {} }
  }

  const { container } = render(
    <I18nProvider configClient={null} initialLocale="en">
      <AppBotSettings snapshot={snapshot} />
    </I18nProvider>
  )

  expect(screen.getByText('Used in your chats')).toBeTruthy()
  expect(container.querySelector('.ak-appicon')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Stop using/u })).toBeNull()
  fireEvent.click(screen.getByRole('switch', { name: app.bot!.display_name }))
  await waitFor(() => expect(botRevoke).toHaveBeenCalledWith(app.app_id))
  expect(refresh).toHaveBeenCalledOnce()
})
