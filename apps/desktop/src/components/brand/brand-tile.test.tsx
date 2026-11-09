import { cleanup, render } from '@testing-library/react'
import type { SVGProps } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { BrandTile } from './brand-tile'

function Mark(props: SVGProps<SVGSVGElement>) {
  return <svg data-testid="mark" {...props} />
}

describe('BrandTile', () => {
  afterEach(() => {
    cleanup()
  })

  it('fills a brand mark but leaves an outline glyph unfilled', () => {
    const { getAllByTestId } = render(
      <>
        <BrandTile glyph={Mark} />
        <BrandTile glyph={Mark} outline />
      </>
    )

    const [filled, outline] = getAllByTestId('mark')
    expect(filled.getAttribute('fill')).toBe('currentColor')
    expect(outline.hasAttribute('fill')).toBe(false)
  })

  it('draws the first letter of the monogram when there is no mark, at every size', () => {
    for (const size of ['xs', 'sm', 'md'] as const) {
      const { container, unmount } = render(<BrandTile monogram="slack" size={size} />)
      expect(container.textContent).toBe('S')
      unmount()
    }
  })

  it('forwards its ref so a tooltip trigger can attach', () => {
    let node: HTMLSpanElement | null = null
    render(<BrandTile monogram="x" ref={el => void (node = el)} />)
    expect(node).toBeInstanceOf(HTMLSpanElement)
  })
})
