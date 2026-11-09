import { expect, test } from 'vitest'

import { createMessagingWindowEvents, totalUnread } from './window-events'

test('derives and clears the badge from roster totals', () => {
  expect(totalUnread([{ unreadCount: 2 }, { unreadCount: 3 }, { unreadCount: -1 }])).toBe(5)
  const badges: Array<number | string> = []
  createMessagingWindowEvents({
    allWindows: () => [],
    setBadgeCount: count => badges.push(count),
    setDockBadge: label => badges.push(label)
  })([])
  expect(badges).toEqual([0, ''])
})

test('fans changes out only to live web contents', () => {
  const channels: string[] = []

  const window = (destroyed: boolean, contentsDestroyed: boolean) => ({
    isDestroyed: () => destroyed,
    webContents: { isDestroyed: () => contentsDestroyed, send: (channel: string) => channels.push(channel) }
  })

  createMessagingWindowEvents({
    allWindows: () => [window(false, false), window(true, false), window(false, true)],
    setBadgeCount: () => undefined
  })([{ unreadCount: 1 }])
  expect(channels).toEqual(['atum:messaging:changed'])
})
