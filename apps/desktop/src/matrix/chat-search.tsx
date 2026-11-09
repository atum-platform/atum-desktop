import './chat-search.css'

import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react'

import { Tip, TipKeybindLabel } from '@/components/ui/tooltip'
import { ChevronDown, SearchIcon, X } from '@/lib/icons'

import type { MatrixMessage } from '../../shared/matrix'

import { useChatSearchCopy } from './chat-search-copy'
import { findChatMatches, foldSearchQuery, sameMatchIndex, stepMatch } from './chat-search-matches'
import { focusMatrixComposer } from './composer-focus'
import {
  clearMatrixHistoryReveal,
  type MatrixHistorySearchProgress,
  revealMatrixHistoryMessage,
  searchOlderMatrixHistory
} from './history-search'
import { loadTimelineHistoryPage, waitForTimelineProjection } from './timeline-history'

const ALL_MATCHES = 'atum-chat-search'
const CURRENT_MATCH = 'atum-chat-search-current'

/** The CSS Custom Highlight API, where the window has it: matches are painted over the
 * transcript's own text, so no message is re-rendered to mark a word. */
function highlights() {
  const registry = (globalThis.CSS as { highlights?: HighlightRegistry } | undefined)?.highlights
  const Paint = (globalThis as { Highlight?: typeof Highlight }).Highlight

  return registry && Paint ? { registry, Paint } : null
}

function paint(matches: readonly Range[], current: number) {
  const api = highlights()

  if (!api) {
    return
  }

  if (matches.length === 0) {
    api.registry.delete(ALL_MATCHES)
    api.registry.delete(CURRENT_MATCH)

    return
  }

  const focused = new api.Paint(...(matches[current] ? [matches[current]] : []))
  focused.priority = 1
  api.registry.set(ALL_MATCHES, new api.Paint(...matches))
  api.registry.set(CURRENT_MATCH, focused)
}

function unpaint() {
  const api = highlights()
  api?.registry.delete(ALL_MATCHES)
  api?.registry.delete(CURRENT_MATCH)
}

/** The transcript this header searches: the message list in the same chat panel. */
function transcriptOf(element: Element | null): HTMLElement | null {
  return element?.closest('[data-atum-chat]')?.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]') ?? null
}

/** Bring a match to the middle of the transcript unless it is already in plain view. */
function reveal(range: Range, viewport: HTMLElement) {
  if (typeof range.getBoundingClientRect !== 'function') {
    return
  }

  const place = () => {
    const rect = range.getBoundingClientRect()
    const box = viewport.getBoundingClientRect()
    const margin = Math.min(64, box.height / 4)

    if (rect.width === 0 && rect.height === 0) {
      return true
    }

    if (rect.top >= box.top + margin && rect.bottom <= box.bottom - margin) {
      return true
    }

    viewport.scrollTop += rect.top + rect.height / 2 - (box.top + box.height / 2)

    return false
  }

  // Older turns are laid out lazily (content-visibility): measure again once they are.
  if (!place()) {
    requestAnimationFrame(() => void place())
  }
}

/** Inside the live turn (thinking, steps, the answer as it streams). */
function liveTurn(node: Node) {
  const element = node instanceof Element ? node : node.parentElement

  return Boolean(element?.closest('[data-matrix-hermes-activity]'))
}

function sameRanges(next: readonly Range[], previous: readonly Range[]) {
  return next.length === previous.length && next.every((range, index) => sameMatchIndex([range], previous[index]) === 0)
}

/**
 * The chat header's search (launch night, 2026-10-04): the magnifier slides open into a
 * field in place — Atum's sunk pill, never a centred overlay — and searches the words of
 * the open chat, assistant or people alike. Matches are highlighted in the transcript, the
 * newest first; Enter / ↑ step to older ones, Shift-Enter / ↓ back to newer, and "2/5"
 * says where you are. Esc or × folds it back into the magnifier. ⌘F opens it (`openRef`).
 * Keyed by the room, so a new chat starts a new search.
 */
export function MatrixChatSearch({
  messages = [],
  openRef,
  roomId
}: {
  messages?: readonly MatrixMessage[]
  openRef?: MutableRefObject<(() => void) | null>
  roomId?: string
}) {
  const copy = useChatSearchCopy()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<readonly Range[]>([])
  const [current, setCurrent] = useState(0)
  const [history, setHistory] = useState<MatrixHistorySearchProgress | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  // A match is brought into view when the person asked for it (typing, stepping), never
  // because the transcript changed under them.
  const revealNext = useRef(false)
  const refocusButton = useRef(false)
  const matchesRef = useRef(matches)
  const currentRef = useRef(current)
  const messagesRef = useRef(messages)
  matchesRef.current = matches
  currentRef.current = current
  messagesRef.current = messages

  const show = useCallback(() => {
    setOpen(true)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [])

  useEffect(() => {
    if (!openRef) {
      return
    }

    openRef.current = show

    return () => {
      if (openRef.current === show) {
        openRef.current = null
      }
    }
  }, [openRef, show])

  const searching = open && Boolean(foldSearchQuery(query))

  // A new query starts at the newest match.
  useEffect(() => {
    const viewport = searching ? transcriptOf(rootRef.current) : null
    setMatches(viewport ? findChatMatches(viewport, query) : [])
    setCurrent(0)
  }, [query, searching])

  // If the loaded DOM has no match, extend the encrypted timeline one page at a time. A
  // short debounce avoids turning every keystroke into a homeserver request; changing the
  // query or room aborts the old bounded walk.
  useEffect(() => {
    const controller = new AbortController()
    setHistory(null)

    if (!searching || !roomId) {
      clearMatrixHistoryReveal(roomId)

      return () => controller.abort()
    }

    clearMatrixHistoryReveal(roomId)
    const viewport = transcriptOf(rootRef.current)

    if (viewport && findChatMatches(viewport, query).length > 0) {
      return () => controller.abort()
    }

    const timer = window.setTimeout(() => {
      void searchOlderMatrixHistory({
        query,
        messages: () => messagesRef.current,
        signal: controller.signal,
        progress: value => {
          if (!controller.signal.aborted) {
            setHistory(value)
          }
        },
        loadPage: async () => {
          const before = messagesRef.current.length
          const page = await loadTimelineHistoryPage(roomId)
          await waitForTimelineProjection(() => messagesRef.current.length, before, controller.signal)

          return page
        }
      })
        .then(result => {
          if (controller.signal.aborted || result.phase === 'cancelled') {
            return
          }

          setHistory(result)

          if (result.eventId) {
            revealNext.current = true
            revealMatrixHistoryMessage(roomId, result.eventId)
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setHistory(null)
          }
        })
    }, 180)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
      clearMatrixHistoryReveal(roomId)
    }
  }, [query, roomId, searching])

  // New messages (or an edited one) while searching: the counts follow, the match you are
  // on stays the one you are on, and nothing scrolls.
  useEffect(() => {
    const viewport = searching ? transcriptOf(rootRef.current) : null

    if (!viewport) {
      return
    }

    let frame = 0

    const observer = new MutationObserver(records => {
      // A streaming answer changes every frame but is not searched until it is a message.
      if (frame || records.every(record => liveTurn(record.target))) {
        return
      }

      frame = requestAnimationFrame(() => {
        frame = 0
        const next = findChatMatches(viewport, query)

        if (sameRanges(next, matchesRef.current)) {
          return
        }

        const same = sameMatchIndex(next, matchesRef.current[currentRef.current])
        setMatches(next)
        setCurrent(same >= 0 ? same : Math.max(0, Math.min(currentRef.current, next.length - 1)))
      })
    })

    observer.observe(viewport, { childList: true, subtree: true, characterData: true })

    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [query, searching])

  useEffect(() => {
    if (!open) {
      return
    }

    paint(matches, current)

    if (revealNext.current && matches[current]) {
      revealNext.current = false
      const viewport = transcriptOf(rootRef.current)

      if (viewport) {
        reveal(matches[current], viewport)
      }
    }
  }, [current, matches, open])

  useEffect(() => unpaint, [])

  useEffect(() => {
    if (!open && refocusButton.current) {
      refocusButton.current = false
      buttonRef.current?.focus()
    }
  }, [open])

  /** `keyboard` hands focus back to the magnifier; a click hands it to the message box,
   * so no tooltip pops up under the pointer; a blur leaves it where the person put it. */
  const close = (how: 'keyboard' | 'pointer' | 'blur') => {
    setOpen(false)
    setQuery('')
    setMatches([])
    setCurrent(0)
    setHistory(null)
    clearMatrixHistoryReveal(roomId)
    unpaint()

    if (how === 'keyboard') {
      refocusButton.current = true
    } else if (how === 'pointer' && !focusMatrixComposer()) {
      refocusButton.current = true
    }
  }

  const step = (direction: 'older' | 'newer') => {
    if (matches.length === 0) {
      return
    }

    revealNext.current = true
    setCurrent(value => stepMatch(value, matches.length, direction))
  }

  const historyLine = history
    ? history.phase === 'searching'
      ? copy.searching(history.searched, history.bound)
      : history.phase === 'cancelled'
        ? ''
        : copy.searched(history.searched, history.bound)
    : ''

  const counter = !searching ? null : !historyLine ? (
    matches.length > 0 ? (
      `${current + 1}/${matches.length}`
    ) : (
      <>
        <span className="atum-chat-search-count-long">{copy.noResults}</span>
        <span className="atum-chat-search-count-short">0/0</span>
      </>
    )
  ) : (
    <>
      <span className="atum-chat-search-count-long">
        {matches.length > 0 ? `${current + 1}/${matches.length}` : copy.noResults}
        {` · ${historyLine}`}
      </span>
      <span className="atum-chat-search-count-short">
        {matches.length > 0 ? `${current + 1}/${matches.length}` : '0/0'}
      </span>
    </>
  )

  const announcement = !searching
    ? ''
    : [matches.length > 0 ? copy.result(current + 1, matches.length) : copy.noResults, historyLine]
        .filter(Boolean)
        .join('. ')

  return (
    <div
      className="atum-chat-search"
      data-matrix-chat-search
      data-open={open || undefined}
      onBlur={event => {
        // An empty field has nothing to keep open: it folds back once focus leaves it.
        if (open && !query && !rootRef.current?.contains(event.relatedTarget as Node | null)) {
          close('blur')
        }
      }}
      ref={rootRef}
      role={open ? 'search' : undefined}
    >
      {open ? (
        <>
          <SearchIcon aria-hidden className="size-4 shrink-0 text-(--atum-ink-muted)" />
          <input
            aria-label={copy.search}
            autoComplete="off"
            className="atum-chat-search-input"
            enterKeyHint="search"
            onChange={event => {
              revealNext.current = true
              setQuery(event.target.value)
            }}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) {
                return
              }

              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                close('keyboard')
              } else if (event.key === 'Enter') {
                event.preventDefault()
                step(event.shiftKey ? 'newer' : 'older')
              } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                event.preventDefault()
                step(event.key === 'ArrowUp' ? 'older' : 'newer')
              }
            }}
            placeholder={copy.search}
            ref={inputRef}
            spellCheck={false}
            type="text"
            value={query}
          />
          {counter && (
            <span aria-hidden className="atum-chat-search-count" data-matrix-chat-search-count>
              {counter}
            </span>
          )}
          <span aria-atomic className="sr-only" role="status">
            {announcement}
          </span>
          {searching && matches.length > 0 && (
            <>
              <Tip label={copy.older}>
                <button
                  aria-label={copy.older}
                  className="atum-icon-btn size-6 shrink-0 rounded-full"
                  onClick={() => step('older')}
                  type="button"
                >
                  <ChevronDown aria-hidden className="size-4 rotate-180" />
                </button>
              </Tip>
              <Tip label={copy.newer}>
                <button
                  aria-label={copy.newer}
                  className="atum-icon-btn size-6 shrink-0 rounded-full"
                  onClick={() => step('newer')}
                  type="button"
                >
                  <ChevronDown aria-hidden className="size-4" />
                </button>
              </Tip>
            </>
          )}
          <Tip label={copy.close}>
            <button
              aria-label={copy.close}
              className="atum-icon-btn size-6 shrink-0 rounded-full"
              onClick={event => close(event.detail === 0 ? 'keyboard' : 'pointer')}
              type="button"
            >
              <X aria-hidden className="size-3.5" />
            </button>
          </Tip>
        </>
      ) : (
        <Tip label={<TipKeybindLabel actionId="chat.find" text={copy.search} />}>
          <button
            aria-label={copy.search}
            className="atum-icon-btn size-7 shrink-0"
            onClick={show}
            ref={buttonRef}
            type="button"
          >
            <SearchIcon aria-hidden className="size-4" />
          </button>
        </Tip>
      )}
    </div>
  )
}
