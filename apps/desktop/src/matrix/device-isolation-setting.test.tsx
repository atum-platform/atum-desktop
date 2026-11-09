import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { MatrixDeviceIsolationSetting } from './device-isolation-setting'

afterEach(cleanup)

function fixture(writable = true) {
  const onChange = vi.fn(async (_value: 'all' | 'signed') => {})
  const onFailure = vi.fn()

  const draw = () =>
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixDeviceIsolationSetting
          locale="en"
          onChange={onChange}
          onFailure={onFailure}
          value="all"
          writable={writable}
        />
      </I18nProvider>
    )

  return { onChange, onFailure, draw }
}

it('requests strict mode explicitly but keeps the native value until readback', async () => {
  const f = fixture()
  let resolve!: () => void
  f.onChange.mockImplementationOnce(
    () =>
      new Promise<void>(done => {
        resolve = done
      })
  )
  f.draw()
  const toggle = screen.getByRole('switch') as HTMLButtonElement
  fireEvent.click(toggle)
  expect(f.onChange).toHaveBeenCalledOnce()
  expect(f.onChange).toHaveBeenCalledWith('signed')
  expect(toggle.disabled).toBe(true)
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  resolve()
  await waitFor(() => expect(toggle.disabled).toBe(false))
  expect(toggle.getAttribute('aria-checked')).toBe('false')
})
it('surfaces a failed native change and leaves the authoritative value alone', async () => {
  const f = fixture()
  f.onChange.mockRejectedValueOnce(new Error('private-fixture'))
  f.draw()
  fireEvent.click(screen.getByRole('switch'))
  await waitFor(() => expect(f.onFailure).toHaveBeenCalledOnce())
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  expect(screen.queryByText('private-fixture')).toBeNull()
})
it('cannot change an unavailable native preference', () => {
  const f = fixture(false)
  f.draw()
  fireEvent.click(screen.getByRole('switch'))
  expect(f.onChange).not.toHaveBeenCalled()
})
