/**
 * The agent's presentation signals in its own chat with its owner (atum-platform
 * spec/agent-turns v1.1 "Presentation signals"): standard Matrix `m.read` and `m.typing`, so
 * every app shows them unmodified. Presentation only: a turn's state is never read from them
 * (v1 rule 10); the turn-state read and the answer's `io.atum.result` stay the authority.
 */
export const MATRIX_AGENT_SIGNALS = {
  /** A typing notice ends on its own after this long: a crashed Mac's never outlives it. */
  typingTimeoutMs: 30_000,
  /** While the Mac holding the lease keeps working, typing is said again this often. */
  typingRenewMs: 20_000,
  /** At most this many messages this Mac took up and is still answering, per room. */
  admittedMax: 64
} as const
