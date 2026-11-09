export interface MessagingWindowLike {
  isDestroyed(): boolean
  webContents: { isDestroyed(): boolean; send(channel: string, ...args: unknown[]): void }
}

export function fanOutMessagingEvent(
  allWindows: () => MessagingWindowLike[],
  channel: string,
  ...args: unknown[]
): void {
  for (const window of allWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(channel, ...args)
    }
  }
}

export interface MessagingWindowEventsOptions {
  allWindows: () => MessagingWindowLike[]
  setBadgeCount: (count: number) => void
  setDockBadge?: (label: string) => void
}

export function totalUnread(conversations: ReadonlyArray<{ unreadCount: number }>): number {
  return conversations.reduce((total, conversation) => total + Math.max(0, conversation.unreadCount), 0)
}

export function createMessagingWindowEvents(options: MessagingWindowEventsOptions) {
  return (conversations: ReadonlyArray<{ unreadCount: number }>): void => {
    const unread = totalUnread(conversations)
    options.setBadgeCount(unread)
    options.setDockBadge?.(unread > 0 ? String(unread) : '')

    fanOutMessagingEvent(options.allWindows, 'atum:messaging:changed')
  }
}

export function createMessagingTransportWindowEvents(options: Pick<MessagingWindowEventsOptions, 'allWindows'>) {
  return (status: unknown): void => fanOutMessagingEvent(options.allWindows, 'atum:messaging:transport-changed', status)
}
