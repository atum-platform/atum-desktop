import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AtumAssistantAvatar } from './assistant-avatar'

describe('AtumAssistantAvatar', () => {
  it('draws every avatar in the one shared squircle frame, keeping the caller size', () => {
    const { container } = render(
      <AtumAssistantAvatar avatarUrl="https://cdn.atum.test/mai.webp" className="size-7 shrink-0" id="assistant-1" name="Mai" />
    )
    const image = container.querySelector('img')!

    expect(image.classList.contains('atum-avatar')).toBe(true)
    expect(image.classList.contains('size-7')).toBe(true)
  })

  it('falls back to the initial when an image fails, then retries a replacement URL', () => {
    const { container, rerender } = render(
      <AtumAssistantAvatar avatarUrl="https://cdn.atum.test/old.webp" className="size-8" id="assistant-1" name="Mai" />
    )

    const old = container.querySelector('img')!

    fireEvent.error(old)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('M')
    expect(container.querySelector('.ak-avatar')?.className).toContain('bg-(--ak-fill-quiet)')
    expect(container.querySelector('.ak-avatar')?.className).toContain('text-(--ak-ink-2)')

    rerender(<AtumAssistantAvatar avatarUrl="https://cdn.atum.test/new.webp" className="size-8" id="assistant-1" name="Mai" />)
    expect(container.querySelector('img')?.getAttribute('src')).toContain('new.webp')
  })

  it('wears the Atum logo file, not a drawn crescent, for the primary assistant', () => {
    const { container } = render(<AtumAssistantAvatar brand className="size-12" id="main" name="Atum" />)

    const face = container.querySelector('[data-atum-eclipse-face]')!
    const logo = face.querySelector('img[data-atum-mark]')!
    expect(logo.getAttribute('src')).toMatch(/atum-mark\.svg$/u)
    expect(face.querySelector('svg')).toBeNull()
  })
})
