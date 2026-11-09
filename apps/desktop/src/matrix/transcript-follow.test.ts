import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { followTranscriptEnd } from './transcript-follow'

let resize: (() => void) | undefined
const disconnect = vi.fn()

/** A transcript area 600px tall whose scroller holds 1200px of messages. */
function area(following: boolean) {
  const element = document.createElement('div')
  const scroller = document.createElement('div')
  let height = 600

  scroller.dataset.slot = 'aui_thread-viewport'
  scroller.dataset.following = String(following)
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1200 })
  // jsdom does no layout: scrollTop is a plain value here.
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 0, writable: true })
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => height })
  element.append(scroller)

  return {
    element,
    scroller,
    resizeTo(next: number) {
      height = next
      resize?.()
    }
  }
}

describe('a transcript above a growing box', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        disconnect = disconnect

        constructor(callback: () => void) {
          resize = callback
        }

        observe() {}
      }
    )
  })

  afterEach(() => {
    resize = undefined
    disconnect.mockClear()
    vi.unstubAllGlobals()
  })

  it('keeps its latest message in view when its area shrinks while it follows the end', () => {
    const chat = area(true)
    const cleanup = followTranscriptEnd(chat.element)

    chat.scroller.scrollTop = 600
    chat.resizeTo(540)
    expect(chat.scroller.scrollTop).toBe(1200)

    cleanup?.()
    expect(disconnect).toHaveBeenCalled()
  })

  it('leaves someone reading older messages where they are', () => {
    const reading = area(false)
    followTranscriptEnd(reading.element)

    reading.scroller.scrollTop = 200
    reading.resizeTo(540)
    expect(reading.scroller.scrollTop).toBe(200)
  })

  it('leaves growth to the scroll owner', () => {
    const following = area(true)
    followTranscriptEnd(following.element)

    following.scroller.scrollTop = 600
    following.resizeTo(700)
    expect(following.scroller.scrollTop).toBe(600)
  })
})
