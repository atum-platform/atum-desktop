import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { CompactMarkdown } from './compact-markdown'

afterEach(cleanup)

it('links only web addresses in a tool body; anything else keeps its words, inert', async () => {
  const view = render(
    <CompactMarkdown text="[Docs](https://example.com/docs), [mail](mailto:a@example.com) and [here](/etc/passwd)" />
  )

  expect((await screen.findByRole('link', { name: /Docs/ })).getAttribute('href')).toBe('https://example.com/docs')
  expect([...view.container.querySelectorAll('a')].map(anchor => anchor.getAttribute('href'))).toEqual([
    'https://example.com/docs'
  ])
  expect(screen.getByText('mail').closest('a')).toBeNull()
  expect(screen.getByText('here').closest('a')).toBeNull()
})
