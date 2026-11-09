import { describe, expect, it, vi } from 'vitest'

import {
  loadTimelineHistoryPage,
  MATRIX_TIMELINE_EVENT_BOUND,
  MATRIX_TIMELINE_INITIAL_EVENTS,
  MATRIX_TIMELINE_PAGE_EVENTS,
  MATRIX_TIMELINE_SEARCH_PAGES,
  nextTimelineEventLimit
} from './timeline-history'

describe('bounded timeline history', () => {
  it('grows a 200-event window by fixed pages and stops at the declared bound', () => {
    let visible = MATRIX_TIMELINE_INITIAL_EVENTS

    for (let page = 0; page < MATRIX_TIMELINE_SEARCH_PAGES; page++) {
      visible = nextTimelineEventLimit(visible)
    }

    expect(MATRIX_TIMELINE_PAGE_EVENTS).toBe(50)
    expect(visible).toBe(MATRIX_TIMELINE_EVENT_BOUND)
    expect(nextTimelineEventLimit(visible)).toBe(MATRIX_TIMELINE_EVENT_BOUND)
  })

  it('uses one existing command and accepts only a closed bounded result', async () => {
    const command = vi.fn(async () => ({ loaded: 50, visible: 250, hasMore: true, capped: false }))

    await expect(loadTimelineHistoryPage('!room:test', command)).resolves.toEqual({
      loaded: 50,
      visible: 250,
      hasMore: true,
      capped: false
    })
    expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'paginateTimeline', roomId: '!room:test' })

    await expect(
      loadTimelineHistoryPage(
        '!room:test',
        vi.fn(async () => ({ visible: 250, hasMore: true }))
      )
    ).rejects.toThrow('matrix_timeline_unavailable')
  })
})
