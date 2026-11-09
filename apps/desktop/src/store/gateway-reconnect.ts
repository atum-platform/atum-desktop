export const GATEWAY_RECONNECT_REQUEST_EVENT = 'hermes:gateway-reconnect-request'

/** User-initiated reconnect nudge. The gateway boot hook remains the sole
 * owner of socket lifecycle; UI surfaces only dispatch this narrow intent. */
export function requestGatewayReconnect(): void {
  window.dispatchEvent(new Event(GATEWAY_RECONNECT_REQUEST_EVENT))
}
