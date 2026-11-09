/**
 * Renderer-owned browser presentation state. A tab contains no authority: URL
 * validation, partition lifecycle, popups and downloads stay behind the typed
 * native bridge.
 */
export type ConsumerBrowserStatus = 'blocked' | 'error' | 'loading' | 'ready' | 'start'

export interface ConsumerBrowserTab {
  id: string
  partition: string
  status: ConsumerBrowserStatus
  title: string
  url: string
}
