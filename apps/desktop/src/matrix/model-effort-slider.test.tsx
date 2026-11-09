import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type { MatrixProductEffort } from '../../shared/matrix-model-choice'

import { MatrixModelEffortSlider } from './model-effort-slider'

beforeEach(() =>
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** The card as the picker holds it: the parent owns the saved level, as `io.atum.model` does. */
function Card({
  capability,
  initial,
  onChange,
  ...extra
}: Omit<React.ComponentProps<typeof MatrixModelEffortSlider>, 'onChange' | 'value'> & {
  initial?: MatrixProductEffort
  onChange: (effort: MatrixProductEffort) => void
}) {
  const [value, setValue] = useState(initial)

  return (
    <MatrixModelEffortSlider
      capability={capability}
      onChange={next => {
        onChange(next)
        setValue(next)
      }}
      value={value}
      {...extra}
    />
  )
}

function card(capability: unknown, locale: Locale = 'en', extra: Partial<React.ComponentProps<typeof Card>> = {}) {
  const onChange = vi.fn()
  render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <Card capability={capability} onChange={onChange} {...extra} />
    </I18nProvider>
  )

  return onChange
}

const capability = (efforts: unknown) => ({ id: 'nguyet-thuc', displayName: 'Nguyệt Thực', efforts })
const slider = () => screen.getByRole('slider', { name: 'Thinking' })

it('makes a stop of exactly each advertised level, quickest first, and saves a key step', () => {
  const change = card(capability(['high', 'low']), 'en', { initial: 'low' })

  expect(slider().getAttribute('aria-valuemin')).toBe('0')
  expect(slider().getAttribute('aria-valuemax')).toBe('1')
  expect(slider().getAttribute('aria-valuetext')).toBe('Quick')
  expect(window.document.querySelectorAll('[data-matrix-model-effort-stop]')).toHaveLength(2)
  expect(screen.queryByText('Balanced')).toBeNull()
  expect(screen.queryByText('Maximum')).toBeNull()

  fireEvent.keyDown(slider(), { key: 'ArrowRight' })
  expect(change).toHaveBeenCalledExactlyOnceWith('high')
  expect(slider().getAttribute('aria-valuetext')).toBe('Thorough')
  // The level's name is the card's headline.
  expect(window.document.querySelector('[data-matrix-model-effort-label]')?.textContent).toBe('Thorough')
})

it('jumps to the ends with Home and End, and saves nothing past them', () => {
  const change = card(capability(['low', 'medium', 'high']), 'en', { initial: 'medium' })

  fireEvent.keyDown(slider(), { key: 'End' })
  expect(slider().getAttribute('aria-valuetext')).toBe('Thorough')
  fireEvent.keyDown(slider(), { key: 'ArrowRight' })
  fireEvent.keyDown(slider(), { key: 'Home' })
  expect(slider().getAttribute('aria-valuetext')).toBe('Quick')
  expect(change.mock.calls).toEqual([['high'], ['low']])
})

it.each([undefined, {}, capability([]), capability(['xhigh']), capability(['high', 'high']), { reasoning: true }])(
  'shows no levels for an absent, empty or invalid capability without inferring support: %j',
  value => {
    card(value)
    expect(screen.queryByRole('slider')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  }
)

it("keeps the model's line when the model takes no level", () => {
  card(capability([]), 'en', { model: <span>ChatGPT · gpt-5.5</span> })
  expect(screen.getByText('ChatGPT · gpt-5.5')).toBeTruthy()
  expect(screen.queryByRole('slider')).toBeNull()
})

it('rests on Balanced when it is advertised and nothing was chosen, and saves nothing by itself', () => {
  const change = card(capability(['low', 'medium', 'high']))

  expect(slider().getAttribute('aria-valuenow')).toBe('1')
  expect(slider().getAttribute('aria-valuetext')).toBe('Balanced')
  expect(screen.getByRole('status').textContent).toBe('Right for most things.')
  // Already the default: nothing to reset.
  expect(screen.queryByRole('button', { name: 'Reset to Balanced' })).toBeNull()
  expect(change).not.toHaveBeenCalled()
})

it('resets to Balanced in one press, and offers no reset where Balanced is not a level', () => {
  const change = card(capability(['low', 'medium', 'high']), 'en', { initial: 'high' })

  fireEvent.click(screen.getByRole('button', { name: 'Reset to Balanced' }))
  expect(change).toHaveBeenCalledExactlyOnceWith('medium')
  expect(slider().getAttribute('aria-valuetext')).toBe('Balanced')
  expect(screen.queryByRole('button', { name: 'Reset to Balanced' })).toBeNull()
  cleanup()

  card(capability(['low', 'high']), 'en', { initial: 'high' })
  expect(screen.queryByRole('button', { name: /Reset/ })).toBeNull()
})

it("says the model's own default applies when the saved level is not one it takes, never charging a connection", () => {
  card(capability(['low']), 'en', { initial: 'high', managed: false })

  expect(window.document.querySelector('[data-matrix-model-effort-label]')?.textContent).toBe('Model default')
  expect(screen.getByRole('status').textContent).toMatch(/model’s default/)
  expect(screen.queryByText(/Protons/)).toBeNull()
})

it('says when a level costs more Protons on Atum’s model, and keeps busy controls still', () => {
  const change = card(capability(['medium', 'high']), 'en', { disabled: true, managed: true, initial: 'high' })

  fireEvent.keyDown(slider(), { key: 'ArrowLeft' })
  fireEvent.click(screen.getByRole('button', { name: 'Reset to Balanced' }))
  expect(change).not.toHaveBeenCalled()
  expect(slider().getAttribute('aria-valuetext')).toBe('Thorough')
  expect(screen.getByRole('status').textContent).toMatch(/more Protons/)
})

it.each(['vi', 'en', 'ja', 'zh', 'zh-hant'] as const)('speaks every level, its help and the reset in %s', locale => {
  card(capability(['low', 'medium', 'high']), locale, { initial: 'low' })
  const thumb = screen.getByRole('slider')

  expect(thumb.getAttribute('aria-label')?.length).toBeGreaterThan(1)
  expect(thumb.getAttribute('aria-valuetext')?.length).toBeGreaterThan(1)
  expect(screen.getByRole('status').textContent?.length).toBeGreaterThan(4)
  expect(
    window.document.querySelector('[data-matrix-model-effort-reset]')?.getAttribute('aria-label')?.length
  ).toBeGreaterThan(2)
  const quick = thumb.getAttribute('aria-valuetext')

  fireEvent.keyDown(thumb, { key: 'ArrowRight' })
  fireEvent.keyDown(thumb, { key: 'ArrowRight' })
  expect(thumb.getAttribute('aria-valuenow')).toBe('2')
  expect(thumb.getAttribute('aria-valuetext')).not.toBe(quick)
  expect(window.document.querySelector('[data-matrix-model-effort-label]')?.textContent).toBe(
    thumb.getAttribute('aria-valuetext')
  )
})

it('speaks Vietnamese naturally', () => {
  card(capability(['low', 'medium', 'high']), 'vi', { initial: 'high' })

  expect(screen.getByRole('slider', { name: 'Mức suy nghĩ' }).getAttribute('aria-valuetext')).toBe('Kỹ')
  expect(screen.getByRole('button', { name: 'Đặt lại về Cân bằng' })).toBeTruthy()
})
