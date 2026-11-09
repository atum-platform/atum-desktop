import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { MatrixBotApiKeyboard, MatrixBotApiText, safeBotApiLink } from './bot-api-text'

afterEach(cleanup)

it('renders the platform’s bounded formatting as real elements', () => {
  const { container } = render(
    <MatrixBotApiText
      body="Choose one"
      formattedBody={
        '<blockquote><u>Choose</u> <strong>one</strong></blockquote>' +
        '<p><span data-mx-spoiler>secret</span> and <code>two</code></p>'
      }
    />
  )

  expect(container.querySelector('strong')?.textContent).toBe('one')
  expect(container.querySelector('code')?.textContent).toBe('two')
  expect(container.querySelector('u')?.textContent).toBe('Choose')
  expect(container.querySelector('blockquote')?.textContent).toContain('Choose one')
  expect(container.querySelector('[data-matrix-bot-api-spoiler]')?.textContent).toBe('secret')
})

it('keeps an unsafe link inert and opens a safe one through the host', () => {
  const open = vi.fn()
  const { container, rerender } = render(
    <MatrixBotApiText body="x" formattedBody={'<a href="javascript:alert(1)">bad</a>'} onOpenLink={open} />
  )

  expect(container.querySelector('a')).toBeNull()
  expect(screen.getByText('bad')).toBeTruthy()

  rerender(
    <MatrixBotApiText body="x" formattedBody={'<a href="https://moon.example/sign-in">Sign in</a>'} onOpenLink={open} />
  )
  fireEvent.click(screen.getByText('Sign in'))
  expect(open).toHaveBeenCalledWith('https://moon.example/sign-in')
})

it('renders native URL buttons in their declared rows and opens the exact HTTPS URL', () => {
  const open = vi.fn()
  const { container } = render(
    <MatrixBotApiKeyboard
      keyboard={[
        [
          { label: 'Sign in', kind: 'url', url: 'https://moon.example/sign-in#continue' },
          { label: 'Learn more', kind: 'url', url: 'https://moon.example/about' }
        ],
        [{ label: 'Privacy', kind: 'url', url: 'https://moon.example/privacy' }]
      ]}
      onOpenLink={open}
    />
  )

  const rows = container.querySelectorAll('[data-matrix-bot-api-keyboard-row]')

  expect(rows).toHaveLength(2)
  expect(rows[0]?.querySelectorAll('button')).toHaveLength(2)
  expect((rows[0] as HTMLElement).style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))')
  expect(rows[1]?.querySelectorAll('button')).toHaveLength(1)
  expect((rows[1] as HTMLElement).style.gridTemplateColumns).toBe('repeat(1, minmax(0, 1fr))')

  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  expect(open).toHaveBeenCalledExactlyOnceWith('https://moon.example/sign-in#continue')
})

it('keeps contract links, including fragments and mail, while rejecting credentials', () => {
  expect(safeBotApiLink('http://example.com/path#part')).toBe('http://example.com/path#part')
  expect(safeBotApiLink('https://example.com:8443/path#part')).toBe('https://example.com:8443/path#part')
  expect(safeBotApiLink('mailto:hello@example.com?subject=Hello')).toBe('mailto:hello@example.com?subject=Hello')
  expect(safeBotApiLink('mailto:hello@example.com?cc=other@example.com')).toBeUndefined()
  expect(safeBotApiLink('https://user:secret@example.com')).toBeUndefined()
  expect(safeBotApiLink('javascript:alert(1)')).toBeUndefined()
})

it('falls back to the plain body when the platform sent no formatting', () => {
  render(<MatrixBotApiText body="Hello *not markdown*" />)
  expect(screen.getByText('Hello *not markdown*')).toBeTruthy()
})
