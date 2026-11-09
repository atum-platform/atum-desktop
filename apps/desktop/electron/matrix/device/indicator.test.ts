import { describe, expect, it, vi } from 'vitest'

import { DeviceIndicator, indicatorWords, type TrayLike } from './indicator'

function harness(locale = 'vi', deviceName: string | null = 'MacBook Pro') {
  const trays: (TrayLike & { title?: string; tooltip?: string; menu?: unknown; destroyed: boolean })[] = []
  const notifications: [string, string][] = []
  const onStop = vi.fn()

  const indicator = new DeviceIndicator(
    {
      createTray: () => {
        const tray = {
          destroyed: false,
          setToolTip(text: string) {
            tray.tooltip = text
          },
          setTitle(text: string) {
            tray.title = text
          },
          setContextMenu(menu: unknown) {
            tray.menu = menu
          },
          destroy() {
            tray.destroyed = true
          }
        } as TrayLike & { title?: string; tooltip?: string; menu?: unknown; destroyed: boolean }
        trays.push(tray)

        return tray
      },
      buildStopMenu: (status, stopLabel, stop) => ({ status, stopLabel, stop }),
      notify: (title, body) => void notifications.push([title, body]),
      words: () => indicatorWords(locale),
      agentName: userId => (userId.startsWith('@agent-t') ? 'T' : 'Other'),
      deviceName: () => deviceName
    },
    onStop
  )

  return { indicator, trays, notifications, onStop }
}

describe('DeviceIndicator', () => {
  it('shows "T is using this Mac · Stop" in Vietnamese while a grant is live, and Stop works from the menu', () => {
    const { indicator, trays, onStop } = harness()
    indicator.grantActive('g1', '@agent-t:x')

    expect(indicator.visible).toBe(true)
    expect(trays[0].title).toBe('T đang dùng MacBook Pro')
    expect(trays[0].tooltip).toBe('T đang dùng MacBook Pro · Dừng')
    const menu = trays[0].menu as { stopLabel: string; stop: () => void }
    expect(menu.stopLabel).toBe('Dừng')
    menu.stop()
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('notifies once per turn on the first action, and hides when the last grant ends', () => {
    const { indicator, trays, notifications } = harness('en', null)
    indicator.grantActive('g1', '@agent-t:x')
    indicator.firstAction('g1', '@agent-t:x')
    indicator.firstAction('g1', '@agent-t:x')

    expect(notifications).toEqual([['T is using this Mac', 'Shell, file and screen actions are running here. Stop them from the menu bar.']])

    indicator.grantActive('g2', '@agent-t:x')
    indicator.grantEnded('g1')
    expect(indicator.visible).toBe(true)
    indicator.grantEnded('g2')
    expect(indicator.visible).toBe(false)
    expect(trays[0].destroyed).toBe(true)

    // A new turn notifies again.
    indicator.firstAction('g3', '@agent-t:x')
    expect(notifications).toHaveLength(2)
  })

  it('speaks each product locale, Vietnamese by default', () => {
    expect(indicatorWords(undefined).stop).toBe('Dừng')
    expect(indicatorWords('ja').stop).toBe('停止')
    expect(indicatorWords('zh-Hant-TW').thisMac).toBe('這台 Mac')
    expect(indicatorWords('zh-CN').thisMac).toBe('这台 Mac')
    expect(indicatorWords('en-US').thisMac).toBe('this Mac')
  })
})
