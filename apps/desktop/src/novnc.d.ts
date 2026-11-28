declare module '@novnc/novnc' {
  export interface RfbChannel {
    binaryType: string
    protocol: string
    readyState: number
    close(clean?: boolean): void
    send(bytes: Uint8Array): void
    onerror: (() => void) | null
    onopen: (() => void) | null
    onclose: ((event: { code: number; wasClean: boolean }) => void) | null
    onmessage: ((event: { data: ArrayBuffer }) => void) | null
  }

  export default class RFB {
    constructor(
      target: HTMLElement,
      channel: RfbChannel,
      options?: { shared?: boolean }
    )

    viewOnly: boolean
    scaleViewport: boolean
    resizeSession: boolean
    focusOnClick: boolean
    background: string
    qualityLevel: number

    addEventListener(type: 'connect', listener: () => void): void
    disconnect(): void
    focus(): void
    clipboardPasteFrom(text: string): void
  }
}
