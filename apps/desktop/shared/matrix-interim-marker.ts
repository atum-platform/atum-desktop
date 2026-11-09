/**
 * The `io.atum.interim` marker of `atum.agent-turns/1.4` (spec/agent-turns/v1.4,
 * `interim_content`): an interim remark of the agent, an ordinary `m.text` that is not the answer.
 * Dependency-free so the publisher, the SDK builder and every renderer read the same shape.
 * Presentation only: it confers no execution authority.
 */
export const MATRIX_INTERIM_KEY = 'io.atum.interim'

export const MATRIX_INTERIM_BODY_MAX = 1_000

/** An interim transaction: fixed per remark so an ambiguous retry never posts a second copy. */
export const MATRIX_INTERIM_TRANSACTION = /^atum-ci-[a-f0-9]{64}$/

/** True for the content of an interim message: an `m.text` carrying the marker exactly as `true`. */
export function matrixInterimMarker(content: unknown): boolean {
  const body = content as Record<string, unknown> | null | undefined

  return body?.msgtype === 'm.text' && body[MATRIX_INTERIM_KEY] === true
}
