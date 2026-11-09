import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MarkdownContent } from './markdown-surface'

// The Matrix window's host: it opens web links through main and loads no images.
function renderMessage(text: string, isRunning = false) {
  const openLink = vi.fn()
  const view = render(<MarkdownContent host={{ openLink }} isRunning={isRunning} text={text} />)

  return { openLink, view }
}

const hrefs = (root: HTMLElement) => [...root.querySelectorAll('a')].map(anchor => anchor.getAttribute('href'))

afterEach(cleanup)

describe('links in a message someone sent', () => {
  it.each([
    ['javascript:', '[Open](javascript:alert(document.domain))'],
    ['vbscript:', '[Open](vbscript:msgbox(1))'],
    ['data:', '[Open](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
    ['file:', '[Open](file:///etc/passwd)'],
    ['mailto:', '[Open](mailto:someone@example.com)'],
    ['a relative path', '[Open](/settings)'],
    ['a dot-relative path', '[Open](./secret.txt)'],
    ['a protocol-relative path', '[Open](//evil.example/x)'],
    ['credentials in the address', '[Open](https://google.com@evil.example/)'],
    ['raw HTML with javascript:', '<a href="javascript:alert(1)">Open</a>'],
    ['raw HTML with data:', '<a href="data:text/html,hi">Open</a>']
  ])('shows a link to %s as inert words', async (_, text) => {
    const { openLink, view } = renderMessage(text)
    const words = await screen.findByText('Open')

    expect(words.closest('a')).toBeNull()
    expect(hrefs(view.container)).toEqual([])
    // No English marker in the person's message either.
    expect(view.container.textContent).not.toContain('blocked')
    fireEvent.click(words)
    expect(openLink).not.toHaveBeenCalled()
  })

  it('opens a web link through the host, and leaves the unsafe one beside it inert', async () => {
    const { openLink, view } = renderMessage('See [the guide](https://example.com/guide) or [this](javascript:alert(1)).')

    fireEvent.click(await screen.findByRole('link', { name: /the guide/ }))
    expect(openLink).toHaveBeenCalledExactlyOnceWith('https://example.com/guide')
    expect(hrefs(view.container)).toEqual(['https://example.com/guide'])
    expect(screen.getByText('this').closest('a')).toBeNull()
  })

  it('keeps a link that is still streaming in as words until it is complete', async () => {
    const { view } = renderMessage('Read [the guide](https://exa', true)

    expect(await screen.findByText(/the guide/)).toBeTruthy()
    expect(hrefs(view.container)).toEqual([])
    expect(view.container.textContent).not.toContain('blocked')
  })

  it('never loads an image: a web image is a link to it, anything else only its description', async () => {
    const { view } = renderMessage(
      [
        '![Cat](https://example.com/cat.png)',
        '![Pixel](javascript:alert(1))',
        '<img src="https://tracker.example/p.gif" alt="Tracker">',
        '<img src="data:image/png;base64,iVBORw0KGgo=" alt="Inline">'
      ].join('\n\n')
    )

    expect(await screen.findByRole('link', { name: /Cat/ })).toBeTruthy()
    expect(view.container.querySelector('img')).toBeNull()
    expect(hrefs(view.container)).toEqual(['https://example.com/cat.png'])

    for (const description of ['Pixel', 'Tracker', 'Inline']) {
      expect(screen.getByText(description).closest('a')).toBeNull()
    }
  })

  it('draws an SVG from a message without any link inside it', async () => {
    const { view } = renderMessage(
      '```svg\n<svg xmlns="http://www.w3.org/2000/svg"><a href="https://evil.example/"><text>Tap</text></a></svg>\n```'
    )

    expect(await screen.findByText('Tap')).toBeTruthy()
    expect(view.container.querySelector('svg')).toBeTruthy()
    expect(view.container.querySelector('a')).toBeNull()
  })
})
