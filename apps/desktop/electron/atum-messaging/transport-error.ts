/**
 * Stable error shape consumed by the direct-message engine.
 *
 * Transport/auth implementations may construct this error, but the S5 engine
 * must not import the token-owning HTTP client merely to classify failures.
 */
export class MessagingTransportError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly requestId: string | null,
    readonly retryAfterMs: number | null,
    readonly details: Record<string, unknown> | null
  ) {
    super(code)
  }
}
