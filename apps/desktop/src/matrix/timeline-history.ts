import type { MatrixUiBridge } from '../../shared/matrix'

/** The initial projection stays small; older events arrive only when the person asks for them. */
export const MATRIX_TIMELINE_INITIAL_EVENTS = 200
export const MATRIX_TIMELINE_PAGE_EVENTS = 50
/** Search may cross at most this many network pages for one query. */
export const MATRIX_TIMELINE_SEARCH_PAGES = 40
/** One selected room can expose at most this many events to the renderer in one SDK session. */
export const MATRIX_TIMELINE_EVENT_BOUND =
  MATRIX_TIMELINE_INITIAL_EVENTS + MATRIX_TIMELINE_PAGE_EVENTS * MATRIX_TIMELINE_SEARCH_PAGES

export interface MatrixTimelinePage {
  /** Raw timeline events newly learned by the SDK. Already-cached events may make this zero. */
  loaded: number
  /** Events currently admitted to the selected-room projection. */
  visible: number
  /** The server has another page and the renderer bound has not been reached. */
  hasMore: boolean
  /** The renderer bound, rather than the start of the room, stopped pagination. */
  capped: boolean
}

/** One bounded step in the selected room's renderer window. */
export function nextTimelineEventLimit(current = MATRIX_TIMELINE_INITIAL_EVENTS): number {
  return Math.min(
    MATRIX_TIMELINE_EVENT_BOUND,
    Math.max(MATRIX_TIMELINE_INITIAL_EVENTS, current) + MATRIX_TIMELINE_PAGE_EVENTS
  )
}

/**
 * Whether the renderer's window of a room reaches the room's very start: every loaded event is in
 * the window and the first is the room's creation, or the server has nothing older to give (a room
 * whose history is hidden from before the person's join ends at their join instead).
 */
export function timelineReachesStart(
  events: readonly { getType(): string }[],
  limit: number,
  backwardToken: string | null
): boolean {
  return events.length <= limit && (events[0]?.getType() === 'm.room.create' || backwardToken === null)
}

function timelinePage(value: unknown): MatrixTimelinePage {
  const page = value as Partial<MatrixTimelinePage> | null

  if (
    !page ||
    !Number.isSafeInteger(page.loaded) ||
    page.loaded! < 0 ||
    !Number.isSafeInteger(page.visible) ||
    page.visible! < 0 ||
    page.visible! > MATRIX_TIMELINE_EVENT_BOUND ||
    typeof page.hasMore !== 'boolean' ||
    typeof page.capped !== 'boolean'
  ) {
    throw new Error('matrix_timeline_unavailable')
  }

  return page as MatrixTimelinePage
}

/** Ask the existing native command bridge for exactly one older page. */
export async function loadTimelineHistoryPage(
  roomId: string,
  // This pure helper is also compiled by packages that deliberately do not load the
  // Desktop renderer's global.d.ts. Keep the preload bridge dependency structural here.
  command: MatrixUiBridge['command'] = value =>
    (window as unknown as { atumMatrix: MatrixUiBridge }).atumMatrix.command(value)
): Promise<MatrixTimelinePage> {
  return timelinePage(await command({ kind: 'paginateTimeline', roomId }))
}

/**
 * IPC publishes the new snapshot before it resolves the command, but React may commit it a
 * frame later. Give that projection a short, bounded chance to arrive before inspecting it.
 */
export async function waitForTimelineProjection(
  readCount: () => number,
  previous: number,
  signal?: AbortSignal,
  frames = 8
): Promise<number> {
  for (let frame = 0; frame < frames && !signal?.aborted; frame++) {
    const count = readCount()

    if (count !== previous) {
      return count
    }

    await new Promise<void>(resolve => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => resolve())
      } else {
        setTimeout(resolve, 0)
      }
    })
  }

  return readCount()
}
