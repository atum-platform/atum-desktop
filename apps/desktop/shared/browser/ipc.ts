export const CONSUMER_BROWSER_IPC = {
  prepare: 'atum:consumer-browser:prepare',
  release: 'atum:consumer-browser:release',
  popup: 'atum:consumer-browser:popup',
  state: 'atum:consumer-browser:state'
} as const

export interface ConsumerBrowserPrepareInput {
  partition: string
  url: string
}

export interface ConsumerBrowserPrepareResult {
  url: string
}

export interface ConsumerBrowserPopup {
  sourceWebContentsId: number
  url: string
}

export interface ConsumerBrowserNotice {
  sourceWebContentsId: number
  type: 'download_refused' | 'download_busy' | 'download_failed' | 'navigation_blocked'
}

export interface BrowserBoundsInput {
  height: number
  width: number
  x: number
  y: number
}
