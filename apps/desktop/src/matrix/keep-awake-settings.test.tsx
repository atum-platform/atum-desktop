import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixKeepAwakeBridge } from '../../shared/matrix-keep-awake'

import { MatrixKeepAwakeSettings } from './keep-awake-settings'

afterEach(cleanup)

it('reads and changes the one main-owned per-Mac preference', async () => {
  let actual = true
  const bridge: MatrixKeepAwakeBridge = {
    status: vi.fn(async () => actual),
    setEnabled: vi.fn(async enabled => (actual = enabled))
  }

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixKeepAwakeSettings bridge={bridge} />
    </I18nProvider>
  )

  const control = await screen.findByRole('switch', { name: 'Keep this Mac awake for Atum' })
  await waitFor(() => expect(control.getAttribute('data-state')).toBe('checked'))
  fireEvent.click(control)
  await waitFor(() => expect(bridge.setEnabled).toHaveBeenCalledWith(false))
  await waitFor(() => expect(control.getAttribute('data-state')).toBe('unchecked'))
})
