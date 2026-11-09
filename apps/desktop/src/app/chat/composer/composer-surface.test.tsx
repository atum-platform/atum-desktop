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
})
