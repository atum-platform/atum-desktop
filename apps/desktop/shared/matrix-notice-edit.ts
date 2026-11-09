import type { MatrixProgressMarker } from './matrix-progress-marker'

/** Additive fields for the owner-applied publishNotice command. */
export interface MatrixNoticeEdit {
  roomId: string
  eventId: string
  body: string
  /** Native active-turn status, separate from the fixed legacy denial notice. */
  statusLine?: true
  /** Allowlisted deterministic publication scope; each notice path validates its own prefix. */
  transactionId?: string
  replaces?: string
  revision?: number
  /** agent-turns/1.3 progress line: the notice and its edits carry `io.atum.progress`. Needs
   * `statusLine`, its `revision` equals the edit's (0 for the original), private chat only. */
  progress?: MatrixProgressMarker
  /** agent-turns/1.4 interim remark: an ordinary `m.text` marked `io.atum.interim`, not a notice,
   * under a deterministic `atum-ci-` transaction. Private chat only; never with `statusLine`,
   * `replaces`, `redact` or `progress`. `body` is the redacted text. */
  interim?: true
  /** agent-turns/1.4: delete the agent's own progress line (`replaces` is its original, `body` is
   * empty) once its turn has ended. Only an `m.notice` the agent sent that carries
   * `io.atum.progress` can be redacted this way. */
  redact?: true
}
