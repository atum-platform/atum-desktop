import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Slider } from './slider'

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

function SizeControl({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState([0.33])

  return (
    <Slider
      aria-label="Size"
      aria-valuetext={`${Math.round(value[0] * 100)}%`}
      disabled={disabled}
      max={3}
      min={0.1}
      onValueChange={setValue}
      step={0.01}
      value={value}
    />
  )
}

describe('Slider', () => {
  it('supports arrow sizing, Home/End and a current spoken value on the thumb', () => {
    render(<SizeControl />)
    const slider = screen.getByRole('slider', { name: 'Size' })
    slider.focus()
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(slider.getAttribute('aria-valuenow')).toBe('0.34')
    expect(slider.getAttribute('aria-valuetext')).toBe('34%')
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    expect(slider.getAttribute('aria-valuenow')).toBe('0.33')
    fireEvent.keyDown(slider, { key: 'Home' })
    expect(slider.getAttribute('aria-valuenow')).toBe('0.1')
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    expect(slider.getAttribute('aria-valuenow')).toBe('0.1')
    fireEvent.keyDown(slider, { key: 'End' })
    expect(slider.getAttribute('aria-valuenow')).toBe('3')
    expect(slider.getAttribute('aria-valuetext')).toBe('300%')
  })

  it('keeps a disabled size unchanged on keyboard input', () => {
    render(<SizeControl disabled />)
    const slider = screen.getByRole('slider', { name: 'Size' })
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(slider.getAttribute('aria-valuenow')).toBe('0.33')
    expect(slider.getAttribute('aria-disabled')).toBe('true')
  })

  it('associates the visible label with the actual slider', () => {
    render(
      <>
        <span id="size-label">Companion size</span>
        <Slider aria-labelledby="size-label" defaultValue={[1]} max={3} min={0.1} />
      </>
    )
    expect(screen.getByRole('slider', { name: 'Companion size' }).getAttribute('aria-valuenow')).toBe('1')
  })
})
