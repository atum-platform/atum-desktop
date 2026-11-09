/**
 * The local turn marker (plan  §4.4).
 *
 * A message typed in this app on the Mac that runs this assistant is a local turn: main
 * mints its ID, runs it through the local Hermes, and posts the question and the answer
 * to the room for every other device. Both events carry the same marker. It is display
 * correlation for renderers and the fence's key for the server path, never authority.
 */
export const MATRIX_TURN_KEY = 'io.atum.turn'

/**
 * The handoff marker: a question typed on a Mac that holds a guest copy of a named agent,
 * for the Mac that answers that agent now (it answers it as it answers the phone, because
 * it carries no local-turn marker). Its value is the turn ID, for the sending Mac's
 * read-back and transcript only; never authority, and every other device ignores it.
 */
export const MATRIX_HANDOFF_KEY = 'io.atum.handoff'

/**
 * A typed question's `m.room.message` content, exactly as the SDK sends it: the text, the turn
 * marker (the handoff marker for a question another Mac or the cloud answers) and, for a reply,
 * its standard relation. Main signs an origin assertion over this content's request digest v2 and
 * the SDK host sends this same object, so the digest always covers the bytes that go out.
 */
export function matrixTurnContent(question: {
  body: string
  turnId: string
  handoff?: true
  replyTo?: string
}): Record<string, unknown> {
  return {
    msgtype: 'm.text',
    body: question.body,
    [question.handoff === true ? MATRIX_HANDOFF_KEY : MATRIX_TURN_KEY]: question.turnId,
    ...(question.replyTo ? { 'm.relates_to': { 'm.in_reply_to': { event_id: question.replyTo } } } : {})
  }
}

/** A message's turn for display correlation: its local-turn marker or its handoff marker. */
export function matrixTurnMarker(content: Record<string, unknown>): string | undefined {
  return matrixTurnId(content[MATRIX_TURN_KEY]) ?? matrixTurnId(content[MATRIX_HANDOFF_KEY])
}

const TURN_ID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/

/** A turn ID as main mints it (`randomUUID`): a lowercase v4 UUID, nothing else. */
export function matrixTurnId(value: unknown): string | undefined {
  return typeof value === 'string' && TURN_ID.test(value) ? value : undefined
}

/** Fixed per turn, reused on every attempt, so the chat server can deduplicate. */
export const matrixQuestionTransaction = (turnId: string) => `atum-q-${turnId}`
export const matrixAnswerTransaction = (turnId: string) => `atum-a-${turnId}`

/** `findTurn` read-back bounds: named tunables, logged with every call (plan §4.4). */
export const MATRIX_FIND_TURN = {
  /** At most this many `/messages` pages after the live timeline. */
  pages: 5,
  /** Events per page. */
  pageSize: 50,
  /** The whole read-back, decryption included. */
  deadlineMs: 20_000,
  /** How far before the turn's creation the scan must reach to prove absence (clock skew). */
  skewMs: 5 * 60_000
} as const

/**
 * The scheduled-post marker (plan  §4.5). An
 * agent posts a Hermes cron run's result into its room under the run's ID: Hermes's
 * execution ID as a UUID. A repeated delivery of the same run finds that post (`findTurn`
 * with marker `cron`) and never posts twice.
 */
export const MATRIX_CRON_KEY = 'io.atum.cron'
export const matrixCronTransaction = (runId: string) => `atum-c-${runId}`

/** Hermes execution IDs are `uuid4.hex`: the same v4 UUID in its canonical form. */
export function matrixCronRunId(executionId: unknown): string | undefined {
  if (typeof executionId !== 'string' || !/^[\da-f]{32}$/.test(executionId)) {
    return undefined
  }

  const e = executionId

  return matrixTurnId(`${e.slice(0, 8)}-${e.slice(8, 12)}-${e.slice(12, 16)}-${e.slice(16, 20)}-${e.slice(20)}`)
}

export function matrixCronMarker(content: Record<string, unknown>): string | undefined {
  const marker = content[MATRIX_CRON_KEY]

  return marker && typeof marker === 'object' ? matrixTurnId((marker as { run?: unknown }).run) : undefined
}
