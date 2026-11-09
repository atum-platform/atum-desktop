/** Node 22 exposes EventTarget/Event/MessageEvent but not CloseEvent. */
if (typeof globalThis.CloseEvent === 'undefined') {
  class NodeCloseEvent extends Event {
    readonly code: number
    readonly reason: string
    readonly wasClean: boolean

    constructor(type: string, init: CloseEventInit = {}) {
      super(type, init)
      this.code = init.code ?? 0
      this.reason = init.reason ?? ''
      this.wasClean = init.wasClean ?? false
    }
  }

  Object.defineProperty(globalThis, 'CloseEvent', {
    configurable: true,
    value: NodeCloseEvent,
    writable: true
  })
}
