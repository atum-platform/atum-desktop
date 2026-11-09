import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import { MATRIX_STATUS_TEXT_MAX } from '../../shared/matrix-presence'

import { MatrixStatusEditor } from './status-editor'

const snapshot: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@me:test', deviceId: 'ONE' },
  rooms: [], roomId: null, messages: [], error: null
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
  vi.unstubAllGlobals()
})

function draw() {
  const command = vi.fn().mockResolvedValue(null)
  const onOpenChange = vi.fn()
  window.atumMatrix = { command } as unknown as MatrixUiBridge
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixStatusEditor onOpenChange={onOpenChange} open snapshot={snapshot} />
    </I18nProvider>
  )

  return { command, onOpenChange }
}

it('saves bounded status and DND as one expiring Matrix command', async () => {
  const f = draw()
  fireEvent.change(screen.getByLabelText('Emoji'), { target: { value: '🏡' } })
  fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'Working from home' } })
  fireEvent.click(screen.getByRole('switch', { name: 'Do not disturb' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))

  await waitFor(() => expect(f.command).toHaveBeenCalledOnce())
  expect(f.command.mock.calls[0]![0]).toMatchObject({
    kind: 'setStatus',
    status: { emoji: '🏡', text: 'Working from home', dnd: true, expiresAt: expect.any(Number) }
  })
  expect(f.onOpenChange).toHaveBeenCalledWith(false)
})

it('keeps Save disabled beyond the 100-character bound', () => {
  draw()
  fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'a'.repeat(MATRIX_STATUS_TEXT_MAX + 1) } })
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
})
