/**
 * The visible "T is using this Mac · Stop" indicator (S1 build plan §3, WS-4 `device/indicator.ts`).
 *
 * Reach-down is never invisible: while any grant is live a menu-bar item names the agent using this
 * Mac and offers Stop, and the first action of each turn raises a notification (Astra follow-up #4).
 * The Electron `Tray`/`Menu`/`Notification` are injected so this is testable without a display and so
 * the renderer never drives it. The words are in the owner's language (Vietnamese by default).
 */
export interface TrayLike {
  setToolTip(text: string): void
  setContextMenu(menu: unknown): void
  setTitle?(title: string): void
  destroy(): void
}

export type IndicatorLocale = 'en' | 'vi' | 'ja' | 'zh' | 'zh-hant'

export interface IndicatorWords {
  /** "T is using this Mac" (the menu-bar title). */
  using(agent: string, device: string): string
  stop: string
  /** The notification on a turn's first action. */
  notifyTitle(agent: string, device: string): string
  notifyBody: string
  /** The generic name when the Mac has none. */
  thisMac: string
}

const WORDS: Record<IndicatorLocale, IndicatorWords> = {
  en: {
    using: (agent, device) => `${agent} is using ${device}`,
    stop: 'Stop',
    notifyTitle: (agent, device) => `${agent} is using ${device}`,
    notifyBody: 'Shell, file and screen actions are running here. Stop them from the menu bar.',
    thisMac: 'this Mac'
  },
  vi: {
    using: (agent, device) => `${agent} đang dùng ${device}`,
    stop: 'Dừng',
    notifyTitle: (agent, device) => `${agent} đang dùng ${device}`,
    notifyBody: 'Các thao tác dòng lệnh, tệp và màn hình đang chạy trên máy này. Dừng chúng từ thanh menu.',
    thisMac: 'máy Mac này'
  },
  ja: {
    using: (agent, device) => `${agent} が ${device} を使用中`,
    stop: '停止',
    notifyTitle: (agent, device) => `${agent} が ${device} を使用中`,
    notifyBody: 'シェル・ファイル・画面の操作がこのMacで実行されています。メニューバーから停止できます。',
    thisMac: 'このMac'
  },
  zh: {
    using: (agent, device) => `${agent} 正在使用${device}`,
    stop: '停止',
    notifyTitle: (agent, device) => `${agent} 正在使用${device}`,
    notifyBody: '命令行、文件和屏幕操作正在这台 Mac 上运行。可从菜单栏停止。',
    thisMac: '这台 Mac'
  },
  'zh-hant': {
    using: (agent, device) => `${agent} 正在使用${device}`,
    stop: '停止',
    notifyTitle: (agent, device) => `${agent} 正在使用${device}`,
    notifyBody: '命令列、檔案和螢幕操作正在這台 Mac 上執行。可從選單列停止。',
    thisMac: '這台 Mac'
  }
}

/** The indicator's words for a locale; Vietnamese is the product default. */
export function indicatorWords(locale?: string): IndicatorWords {
  const key = (locale ?? '').toLowerCase()

  if (key.startsWith('zh')) {
    return /hant|tw|hk|mo/.test(key) ? WORDS['zh-hant'] : WORDS.zh
  }

  if (key.startsWith('en')) {
    return WORDS.en
  }

  if (key.startsWith('ja')) {
    return WORDS.ja
  }

  return WORDS.vi
}

export interface IndicatorDeps {
  /** Create the tray (once), with the Stop handler wired to its menu item. */
  createTray(onStop: () => void): TrayLike
  /** Build a context menu with a disabled status line and one enabled "Stop" item calling `onStop`. */
  buildStopMenu(status: string, stopLabel: string, onStop: () => void): unknown
  /** Raise a transient notification (first action of a turn). */
  notify(title: string, body: string): void
  words(): IndicatorWords
  /** The agent's display name ("T"), from the roster. */
  agentName(agentUserId: string): string
  /** This Mac's name ("MacBook Pro"), or null for the generic words. */
  deviceName(): string | null
}

export class DeviceIndicator {
  private tray?: TrayLike
  private readonly active = new Map<string, string>()
  private readonly notified = new Set<string>()

  constructor(
    private readonly deps: IndicatorDeps,
    private readonly onStop: () => void
  ) {}

  /** A grant went live: show who is using this Mac, with Stop. */
  grantActive(grantId: string, agentUserId: string): void {
    this.active.set(grantId, agentUserId)
    this.render()
  }

  /** The first action of a turn: notify once per grant. */
  firstAction(grantId: string, agentUserId: string): void {
    if (!this.active.has(grantId)) {
      this.active.set(grantId, agentUserId)
      this.render()
    }

    if (this.notified.has(grantId)) {
      return
    }

    this.notified.add(grantId)
    const words = this.deps.words()
    this.deps.notify(words.notifyTitle(this.deps.agentName(agentUserId), this.device(words)), words.notifyBody)
  }

  /** A grant ended (turn over, expired, stopped): hide when none is live. */
  grantEnded(grantId: string): void {
    this.active.delete(grantId)
    this.notified.delete(grantId)
    this.render()
  }

  /** True while the indicator is shown (a grant is live). */
  get visible(): boolean {
    return this.tray !== undefined
  }

  /** The device is shutting down: clear all state and remove the tray. */
  dispose(): void {
    this.active.clear()
    this.notified.clear()
    this.render()
  }

  private device(words: IndicatorWords): string {
    return this.deps.deviceName() ?? words.thisMac
  }

  private render(): void {
    if (this.active.size === 0) {
      this.tray?.destroy()
      this.tray = undefined

      return
    }

    const words = this.deps.words()
    const agents = [...new Set([...this.active.values()].map(agent => this.deps.agentName(agent)))].join(', ')
    const status = words.using(agents, this.device(words))

    this.tray ??= this.deps.createTray(this.onStop)
    this.tray.setToolTip(`${status} · ${words.stop}`)
    this.tray.setTitle?.(status)
    this.tray.setContextMenu(this.deps.buildStopMenu(status, words.stop, this.onStop))
  }
}
