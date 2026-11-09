/**
 * The one per-turn instruction that asks the agent to speak up while it works (`atum.agent-turns/1.4`):
 * a short first sentence before its first tool call, a short progress sentence every few calls, then the
 * full answer. The cloud controller appends it to the owner's turn inside its turn context (`turnContext`)
 * and a Mac appends it to the turn it will narrate (`runMatrixHermesTurn`), so both behave the same.
 *
 * It rides in the owner's new message, never the system prompt: a stored conversation's cached prefix and
 * its role alternation stay as they were, and a conversation that began before this existed gets it on its
 * next turn. The words the agent answers with are published by `MatrixTurnVoice`, which also covers a model
 * that ignores this line (`matrixAcknowledgementCopy`).
 */

/** The header the cloud's turn context opens with; a Mac's carries the style line alone under it. */
export const MATRIX_TURN_CONTEXT_HEADER = '[Atum turn context v1]'

export const MATRIX_TURN_STYLE =
  'style: before your first tool call, send the owner one short sentence — the quick answer if you already know the gist, otherwise what you are about to do; on longer work add one short progress sentence every few tool calls; then give the full answer.'

/**
 * The Hermes `display` settings that carry an agent's narration to the owner: its remarks between tool
 * calls (`message.interim`, `display.interim_assistant_messages`), a Codex model's commentary
 * (`display.show_commentary`) and the started-tool events behind the working line
 * (`display.tool_progress`, which `tool.start` honours: `off` sends none). Hermes already defaults to
 * these values; a new Mac home and every cloud sandbox write them out so a raw-config reader or a
 * future default can never silence the owner's progress. They shape events, not the system prompt or
 * the tool list, so they are not part of a conversation's configuration digest.
 */
export const MATRIX_NARRATION_DISPLAY = {
  tool_progress: 'all',
  interim_assistant_messages: true,
  show_commentary: true
} as const

/**
 * The one coarse fact a Mac may add for a turn: its IANA zone. A Mac knows no city or region from
 * the OS without asking for location permission, which Atum never does, and the locale's region is
 * a language preference, not where the person is, so it is never presented as a location.
 */
export interface MatrixOwnerFacts {
  /** The Mac's system IANA zone, e.g. "Asia/Ho_Chi_Minh"; absent when ICU does not expose one. */
  timeZone?: string
}

const IANA_TIME_ZONE = /^[A-Z][A-Za-z0-9_+-]{0,63}(\/[A-Z][A-Za-z0-9_+-]{0,63}){0,2}$/u

/**
 * The Mac path's fallback fact when the platform did not hand this turn a coarse place: the Mac's
 * system zone, clearly labelled as the machine's own. The locale region is deliberately ignored; a
 * person who reads the app in Vietnamese may be anywhere. Explicit input keeps it deterministic.
 */
export function macOwnerFacts(input: { timeZone?: string } = {}): MatrixOwnerFacts {
  let timeZone = input.timeZone

  if (timeZone === undefined) {
    try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } catch { timeZone = undefined }
  }

  return timeZone && IANA_TIME_ZONE.test(timeZone) ? { timeZone } : {}
}

/**
 * The prompt a Mac hands Hermes for a turn it narrates: the owner's words and anything attached, then
 * the style under the cloud's header (the cloud's origin, devices and software lines are facts about the cloud,
 * not about a Mac turn), then the Mac's own time zone when known. Added only when the whole prompt
 * still fits in `max`; a prompt that leaves no room keeps its words alone, never cut.
 */
export function matrixTurnStyledPrompt(prompt: string, max: number, owner: MatrixOwnerFacts = {}): string {
  const zone = owner.timeZone ? `\ntime zone: ${owner.timeZone} (from this Mac)` : ''
  const styled = `${prompt}\n\n${MATRIX_TURN_CONTEXT_HEADER}\n${MATRIX_TURN_STYLE}${zone}`

  return styled.length <= max ? styled : prompt
}
