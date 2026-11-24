import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ComposerSurface } from './composer-surface'

describe('ComposerSurface', () => {
  it('provides one shared floating pill with explicit input and control slots', () => {
    const { container } = render(
      <ComposerSurface
        actions={<button type="button">Send</button>}
        before={<p>Before</p>}
        bottom={<p>Bottom</p>}
        input={<textarea aria-label="Message" />}
        leading={<button type="button">Attach</button>}
        stacked
        top={<p>Top</p>}
      >
        <p>Status</p>
      </ComposerSurface>
    )

    expect(container.querySelector('[data-slot="composer-surface"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="composer-fill"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="composer-fade"]')).not.toBeNull()
    expect(screen.getByLabelText('Message')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Attach' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
    expect(screen.getByText('Status')).toBeTruthy()
    expect(screen.getByText('Before')).toBeTruthy()
    expect(screen.getByText('Top')).toBeTruthy()
    expect(screen.getByText('Bottom')).toBeTruthy()
  })

  it("lays out T3's recipe: the editor above a footer with leading controls left and actions right", () => {
    const { container } = render(
      <ComposerSurface
        actions={<button type="button">Send</button>}
        input={<textarea aria-label="Message" />}
        leading={<button type="button">Attach</button>}
        recipe="t3"
        stacked
        top={<p>Top</p>}
      />
    )

    const surface = container.querySelector('[data-slot="composer-surface"]')
    const body = container.querySelector('[data-slot="composer-body"]')
    const footer = container.querySelector('[data-slot="composer-footer"]')

    expect(surface?.getAttribute('data-composer-recipe')).toBe('t3')
    expect(body?.contains(screen.getByLabelText('Message'))).toBe(true)
    expect(footer?.querySelector('[data-slot="composer-leading"]')?.textContent).toBe('Attach')
    expect(footer?.querySelector('[data-slot="composer-actions"]')?.textContent).toBe('Send')
    // The editor comes first, the footer after it.
    expect(body?.compareDocumentPosition(footer!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(container.querySelector('[data-slot="composer-top"]')?.textContent).toBe('Top')
  })

  it('keeps the Atum layout by default', () => {
    const { container } = render(<ComposerSurface input={<textarea aria-label="Message" />} />)

    expect(container.querySelector('[data-slot="composer-surface"]')?.hasAttribute('data-composer-recipe')).toBe(false)
    expect(container.querySelector('[data-slot="composer-footer"]')).toBeNull()
  })
})
