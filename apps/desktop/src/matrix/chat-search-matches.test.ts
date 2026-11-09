import { afterEach, describe, expect, it } from 'vitest'

import {
  findChatMatches,
  foldSearchQuery,
  sameMatchIndex,
  stepMatch,
  textMatchesChatSearch
} from './chat-search-matches'

/** A transcript as the Matrix window renders it: answers and your own bubbles, oldest first. */
function transcript(html: string) {
  const root = document.createElement('div')
  root.setAttribute('data-slot', 'aui_thread-viewport')
  root.innerHTML = html
  document.body.append(root)

  return root
}

const answer = (html: string) => `<div data-slot="aui_assistant-message-content">${html}</div>`
const own = (html: string) =>
  `<div data-slot="aui_user-bubble-actions"><div class="composer-human-message">${html}</div></div>`

afterEach(() => {
  document.body.replaceChildren()
})

describe('chat search matching', () => {
  it('folds case and Vietnamese marks the way the roster search does', () => {
    const root = transcript(answer("<p>Here's a calm three days in Đà Lạt for mid-October.</p>"))

    expect(findChatMatches(root, 'da lat').map(range => range.toString())).toEqual(['Đà Lạt'])
    expect(findChatMatches(root, 'ĐÀ LẠT').map(range => range.toString())).toEqual(['Đà Lạt'])
    expect(foldSearchQuery('  Đà   Lạt ')).toBe('da lat')
  })

  it('finds words across formatting, but never across a paragraph or list item', () => {
    const root = transcript(
      answer('<p>Coffee in <strong>Đà</strong> Lạt</p>') + answer('<ul><li>Morning at Đà</li><li>Lạt market</li></ul>')
    )

    const matches = findChatMatches(root, 'da lat')
    expect(matches.map(range => range.toString())).toEqual(['Đà Lạt'])
    expect(matches[0]?.startContainer.parentElement?.tagName).toBe('STRONG')
  })

  it('reads the words of messages, never the controls, quotes or hidden text around them', () => {
    const root = transcript(
      `<div data-matrix-sender>Linh</div>` +
        answer(
          '<blockquote data-matrix-reply-quote>Lunch plans?</blockquote><p>Lunch at noon.</p>' +
            '<button type="button">Lunch</button><span class="sr-only">Lunch</span><span aria-hidden="true">Lunch</span>'
        ) +
        '<div data-matrix-steps>Lunch search</div>'
    )

    expect(findChatMatches(root, 'lunch').map(range => range.toString())).toEqual(['Lunch'])
  })

  it('still searches while a dialog hides the window from screen readers', () => {
    const root = transcript(answer('<p>The flower market</p>'))
    root.setAttribute('aria-hidden', 'true')

    expect(findChatMatches(root, 'flower')).toHaveLength(1)
  })

  it('puts the newest match first and finds every occurrence in a message', () => {
    const root = transcript(own('<p>Quiet, good coffee.</p>') + answer('<p>Coffee here, coffee there.</p>'))

    const matches = findChatMatches(root, 'coffee')
    expect(matches.map(range => range.toString())).toEqual(['coffee', 'Coffee', 'coffee'])
    expect(matches[0]?.startContainer.textContent).toBe('Coffee here, coffee there.')
    expect(matches[2]?.startContainer.textContent).toBe('Quiet, good coffee.')
  })

  it('looks for nothing until there is something to look for', () => {
    const root = transcript(answer('<p>Anything</p>'))

    expect(findChatMatches(root, '')).toEqual([])
    expect(findChatMatches(root, '   ')).toEqual([])
    expect(textMatchesChatSearch('Đà Lạt\nmarket', 'da lat')).toBe(true)
    expect(textMatchesChatSearch('Đà\nLạt', 'da lat')).toBe(false)
  })

  it('keeps the match you are on when the transcript changes, and steps with wrap-around', () => {
    const root = transcript(answer('<p>Pines and more pines</p>'))
    const before = findChatMatches(root, 'pines')

    root.insertAdjacentHTML('beforeend', answer('<p>New pines</p>'))
    const after = findChatMatches(root, 'pines')

    expect(after).toHaveLength(3)
    expect(sameMatchIndex(after, before[0])).toBe(1)
    expect(sameMatchIndex(after, undefined)).toBe(-1)

    // Up is older (a higher number), down is newer; both wrap.
    expect(stepMatch(0, 3, 'older')).toBe(1)
    expect(stepMatch(2, 3, 'older')).toBe(0)
    expect(stepMatch(0, 3, 'newer')).toBe(2)
    expect(stepMatch(0, 0, 'older')).toBe(-1)
  })
})
