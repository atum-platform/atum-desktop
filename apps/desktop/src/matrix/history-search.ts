import { atom } from 'nanostores'

import type { MatrixMessage, MatrixThread } from '../../shared/matrix'

import { textMatchesChatSearch } from './chat-search-matches'
import { historyMessageText } from './history-message-text'
import { MATRIX_TIMELINE_EVENT_BOUND, MATRIX_TIMELINE_SEARCH_PAGES, type MatrixTimelinePage } from './timeline-history'

export interface MatrixHistoryReveal {
  roomId: string
  eventId: string
  owner?: 'company' | 'pinned'
  threadRootId?: string
  accountKey?: string
}

/** Search lives in the header; the distant transcript owns how much DOM to reveal. */
export const $matrixHistoryReveal = atom<MatrixHistoryReveal | null>(null)

export function revealMatrixHistoryMessage(
  roomId: string,
  eventId: string,
  owner: 'chat' | 'company' | 'pinned' = 'chat',
  threadRootId?: string,
  accountKey?: string
): void {
  $matrixHistoryReveal.set({
    roomId,
    eventId,
    ...(owner === 'chat' ? {} : { owner }),
    ...(threadRootId ? { threadRootId } : {}),
    ...(accountKey ? { accountKey } : {})
  })
}

export function clearMatrixHistoryReveal(roomId?: string, owner: 'chat' | 'company' | 'pinned' = 'chat'): void {
  const current = $matrixHistoryReveal.get()
  if ((!roomId || current?.roomId === roomId) && (current?.owner ?? 'chat') === owner) {
    $matrixHistoryReveal.set(null)
  }
}

/** Retire only the request an async reveal attempt actually consumed. */
export function clearExactMatrixHistoryReveal(reveal: MatrixHistoryReveal): void {
  if ($matrixHistoryReveal.get() === reveal) {
    $matrixHistoryReveal.set(null)
  }
}

/** Whether a company deep link is present in the exact transcript it belongs to. */
export function companyHistoryRevealProjected(
  reveal: MatrixHistoryReveal,
  messages: readonly MatrixMessage[],
  threads: readonly MatrixThread[] = []
): boolean {
  if (!reveal.threadRootId) {
    return messages.some(message => message.id === reveal.eventId)
  }

  const thread = threads.find(candidate => candidate.root.id === reveal.threadRootId)

  return Boolean(thread && (thread.root.id === reveal.eventId ||
    thread.replies.some(message => message.id === reveal.eventId)))
}


/** The newest matching readable message in the loaded projection. */
export function findHistoryMessage(messages: readonly MatrixMessage[], query: string): MatrixMessage | undefined {
  return [...messages]
    .reverse()
    .find(
      message =>
        !message.redacted &&
        !message.decryptionFailed &&
        !message.attachment &&
        textMatchesChatSearch(historyMessageText(message.body), query)
    )
}

export interface MatrixHistorySearchProgress {
  phase: 'searching' | 'found' | 'complete' | 'capped' | 'cancelled'
  pages: number
  searched: number
  bound: number
  eventId?: string
}

export interface MatrixHistorySearchOptions {
  query: string
  messages(): readonly MatrixMessage[]
  loadPage(): Promise<MatrixTimelinePage>
  progress?(value: MatrixHistorySearchProgress): void
  signal?: AbortSignal
  /** Tests may choose a smaller limit; production can never exceed the product bound. */
  maxPages?: number
}

/**
 * Search encrypted history through the SDK's local decrypted timeline, one bounded page at a
 * time. It stops at the first newly reachable result, the room's beginning, or the hard cap.
 */
export async function searchOlderMatrixHistory(
  options: MatrixHistorySearchOptions
): Promise<MatrixHistorySearchProgress> {
  const maxPages = Math.max(0, Math.min(options.maxPages ?? MATRIX_TIMELINE_SEARCH_PAGES, MATRIX_TIMELINE_SEARCH_PAGES))
  const report = (value: MatrixHistorySearchProgress) => {
    options.progress?.(value)

    return value
  }
  const view = (phase: MatrixHistorySearchProgress['phase'], pages: number, eventId?: string) => ({
    phase,
    pages,
    searched: Math.min(options.messages().length, MATRIX_TIMELINE_EVENT_BOUND),
    bound: MATRIX_TIMELINE_EVENT_BOUND,
    ...(eventId ? { eventId } : {})
  })

  const loaded = findHistoryMessage(options.messages(), options.query)

  if (loaded) {
    return report(view('found', 0, loaded.id))
  }

  for (let pages = 1; pages <= maxPages; pages++) {
    if (options.signal?.aborted) {
      return report(view('cancelled', pages - 1))
    }

    report(view('searching', pages - 1))
    const page = await options.loadPage()

    if (options.signal?.aborted) {
      return report(view('cancelled', pages))
    }

    const match = findHistoryMessage(options.messages(), options.query)

    if (match) {
      return report(view('found', pages, match.id))
    }

    if (!page.hasMore) {
      return report(view(page.capped ? 'capped' : 'complete', pages))
    }
  }

  return report(view('capped', maxPages))
}

export { historyMessageText }
