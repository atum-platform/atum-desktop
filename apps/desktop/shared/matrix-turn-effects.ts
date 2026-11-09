import { createHash } from 'node:crypto'

/**
 * What a Hermes turn did, as far as this Mac saw it (reliability plan R3, "resume instead of
 * refuse"). A turn that ends without an answer is one of three things:
 *
 *  - `none` / `read_only`: nothing reached Hermes, or only model calls and read-only tools ran.
 *    Running it again cannot repeat an effect, so it goes back in the queue silently.
 *  - `side_effect_possible`: a tool that may change something outside the conversation started
 *    (or this Mac lost sight of the turn after it was submitted). It runs once more as a check only:
 *    the assistant looks at what was done, repeats nothing, reports, and asks before redoing anything.
 *    A check that is itself cut off is not followed by another; the owner is told once.
 *  - `unknown`: this Mac cannot say (the run was never tracked). Nothing runs again on its own and
 *    the owner is told once.
 *
 * "Unknown" is the safe default everywhere: only a run that was tracked from the start can prove
 * `none` or `read_only`, and a model request that may already have been sent is cost, not an
 * effect (`api_call_count = 0` is not proof of anything).
 */
export type MatrixTurnEffect = 'none' | 'read_only' | 'side_effect_possible' | 'unknown'

/** Effects the ledger and the continuation note may carry: a proven or possible outcome, never "unknown". */
export type MatrixTurnKnownEffect = Exclude<MatrixTurnEffect, 'unknown'>

export interface MatrixTurnEvidence {
  effect: MatrixTurnEffect
  /** The tools that may have changed something, by Hermes name, in the order they started. */
  tools: string[]
  /** This Mac lost sight of the turn after submitting it: whatever ran since is not known. */
  blind: boolean
}

/**
 * Tools that read and never change anything outside the conversation. Anything else, unknown or
 * plugin tools included, counts as a possible side effect: calling a read-only tool a side effect
 * only costs a resumed run, while the reverse repeats a real action.
 *
 * `todo` is on the list although it also writes: it changes nothing outside the conversation. It
 * is the session's own in-memory plan (`TodoStore`, one per `AIAgent`, never saved to a file, a
 * database or a service) and a resumed run rebuilds it from the conversation history
 * (`_hydrate_todo_store`), so running a `todo` write again repeats nothing a person could see.
 * Counting it as a possible side effect would only add "couldn't confirm" notices to runs that
 * did nothing but plan. If `todo` ever persists anywhere beyond the session, take it off this list.
 */
export const MATRIX_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'web_search',
  'web_extract',
  'read_file',
  'search_files',
  'vision_analyze',
  'skills_list',
  'skill_view',
  'session_search',
  'todo',
  'browser_snapshot',
  'browser_get_images',
  'read_terminal',
  'kanban_show',
  'kanban_list',
  'ha_list_entities',
  'ha_get_state',
  'ha_list_services'
])

/** How many times one message may be run again after a failed run (the original run is not counted). */
export const MATRIX_TURN_RERUNS = 2

/**
 * A run that provably did NOTHING (`effect: 'none'`: no prompt left, no tool started) cannot repeat anything, so a count is the wrong
 * bound for it: a platform outage of ten minutes spends any count in seconds and loses a message that was never touched. Such a run is
 * put back for this long instead (measured by the caller from the first time the message was found unrunnable), then the owner is told
 * once. `read_only` runs and runs that may have acted keep the count: they cost model calls, or could repeat an effect.
 */
export const MATRIX_NONE_RETRY_WINDOW_MS = 30 * 60_000

const MAX_TOOLS = 12
const TOOL_NAME = /^[A-Za-z0-9_.:/-]{1,64}$/

/** A list of tool names from a record: the well-formed ones, at most the bound. Never throws. */
export function matrixToolNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((tool): tool is string => typeof tool === 'string' && TOOL_NAME.test(tool)).slice(0, MAX_TOOLS)
    : []
}

/**
 * Follows one run of Hermes for the caller that dispatched it. The caller creates it, the execution
 * layer drives it (`attach` when it takes the run, `submit` immediately before the prompt leaves,
 * `toolStarted` for every tool the run starts, `blind` when the connection drops after submission),
 * and the caller reads `evidence()` when the run ends without an answer.
 */
export class MatrixTurnEffects {
  #attached = false
  #submitted = false
  #blind = false
  #more = false
  #visible = false
  #toolSeen = false
  #tools: string[] = []

  /** The execution layer has taken the run: anything that fails from here to `submit` ran nothing. */
  attach(): void {
    this.#attached = true
  }

  /** Called immediately before the prompt is sent to Hermes: from here the run may have done anything. */
  submit(): void {
    this.#attached = true
    this.#submitted = true
  }

  /** A tool started (its Hermes name, as received). Read-only tools leave no mark. */
  toolStarted(name: string): void {
    this.#toolSeen = true

    if (MATRIX_READ_ONLY_TOOLS.has(name)) {
      return
    }

    const safe = TOOL_NAME.test(name) ? name : 'unnamed_tool'

    if (this.#tools.includes(safe)) {
      return
    }

    if (this.#tools.length >= MAX_TOOLS) {
      this.#more = true

      return
    }

    this.#tools.push(safe)
  }

  /**
   * What the session reported as its tool-progress mode (Hermes announces a tool's start only when
   * it is not `off`). Tool starts are the only evidence of what a run did, so a run is provably
   * read-only only if they could be seen: with no report, an `off` report, or anything unrecognised,
   * a submitted run that ended without an answer is treated as one that may have changed something.
   */
  toolProgress(mode: unknown): void {
    this.#visible = mode === 'new' || mode === 'all' || mode === 'verbose'
  }

  /** The connection to Hermes ended after submission: events since then were not seen. */
  blind(): void {
    if (this.#submitted) {
      this.#blind = true
    }
  }

  get submitted(): boolean {
    return this.#submitted
  }

  /**
   * Whether retiring the owned Hermes process is still required after a failed turn. Hidden tool
   * progress or a blind connection means a tool may have started unseen. Any observed tool start
   * remains conservative too: a completed call may have left an intentional background process,
   * and only the process group can prove that no child survives an uncertain turn.
   */
  get runtimeMayHaveActiveTool(): boolean {
    if (!this.#attached || !this.#submitted) {
      return false
    }

    return this.#blind || !this.#visible || this.#toolSeen
  }

  evidence(): MatrixTurnEvidence {
    const tools = [...this.#tools]

    if (!this.#attached) {
      return { effect: 'unknown', tools, blind: this.#blind }
    }

    if (!this.#submitted) {
      return { effect: 'none', tools, blind: false }
    }

    return {
      effect: this.#blind || this.#more || !this.#visible || tools.length ? 'side_effect_possible' : 'read_only',
      tools,
      blind: this.#blind
    }
  }
}

const EFFECT_RANK: Record<MatrixTurnEffect, number> = { none: 0, read_only: 1, side_effect_possible: 2, unknown: 3 }

/**
 * What a run showed, together with what the runs before it were known to have done. A run that
 * only read after one which may have changed something has not made that go away: the facts add
 * up (the stronger effect, the tools of both), and a message that may have been acted on once is
 * never described as if it had not.
 */
export function matrixTurnEvidenceWith(
  evidence: MatrixTurnEvidence,
  prior?: Pick<MatrixTurnResume, 'effect' | 'tools'>
): MatrixTurnEvidence {
  if (!prior) {
    return evidence
  }

  const effect = EFFECT_RANK[prior.effect] > EFFECT_RANK[evidence.effect] ? prior.effect : evidence.effect
  const tools = [...new Set([...prior.tools, ...evidence.tools])].slice(0, MAX_TOOLS)

  return { ...evidence, effect, tools }
}

/** What to do with a run that ended without an answer. */
export type MatrixTurnSettlement =
  | { kind: 'leave' }
  | { kind: 'requeue'; effect: MatrixTurnKnownEffect; tools: string[] }
  | { kind: 'notice'; code: 'couldnt_confirm' | 'failed' }

/**
 * The plan's three cases, as one decision.
 *
 *  - `leave`: the owner pressed Stop. Nothing resumes and nothing is said (as before).
 *  - `requeue`: (a) nothing reached Hermes or only read-only work ran, silently; (b) a side-effecting
 *    tool may have run: one check turn that only looks and reports (`matrixResumeNote`), never a repeat.
 *    Both go back in the queue.
 *  - `notice`: (c) neither is safe or allowed any more (unknown, out of reruns, out of time). The owner
 *    is told once: "couldn't confirm" when something may have half-run, "failed, try again" when
 *    provably nothing did.
 */
export function matrixTurnSettlement(input: {
  evidence: MatrixTurnEvidence
  /** Reruns this message has already had. */
  reruns: number
  /** The owner pressed Stop (or the fence says another run owns the message): this run leaves it be. */
  stopped: boolean
  /** The run hit its time limit: running it again would only hit the same wall. */
  timedOut: boolean
  /** What the runs before this one are known to have done; `side_effect_possible` means this run already was the check. */
  prior?: Pick<MatrixTurnResume, 'effect'>
  /** How long this message has been unrunnable (first failed attempt to now), when the caller tracks it; see `MATRIX_NONE_RETRY_WINDOW_MS`. */
  unrunnableMs?: number
}): MatrixTurnSettlement {
  if (input.stopped) {
    return { kind: 'leave' }
  }

  const { effect, tools } = input.evidence

  if (effect === 'unknown') {
    return { kind: 'notice', code: 'couldnt_confirm' }
  }

  if (effect === 'side_effect_possible') {
    // One check per interrupted turn (`matrixResumeNote`): it is its own allowance, not one of the silent reruns, and a check
    // that is itself cut off (the facts of an earlier run already say so) is never followed by another.
    return input.timedOut || input.prior?.effect === 'side_effect_possible'
      ? { kind: 'notice', code: 'couldnt_confirm' }
      : { kind: 'requeue', effect, tools }
  }

  // Nothing ran: retry by age, not by count (the count stays the bound for runs that read or may have acted).
  const youngNone = effect === 'none' && input.unrunnableMs !== undefined && input.unrunnableMs < MATRIX_NONE_RETRY_WINDOW_MS

  if (input.timedOut || (input.reruns >= MATRIX_TURN_RERUNS && !youngNone)) {
    return { kind: 'notice', code: 'failed' }
  }

  return { kind: 'requeue', effect, tools }
}

/** What a platform record or a local one says about the earlier runs of the same message. */
export interface MatrixTurnResume {
  /** Reruns so far (1 after the first requeue). */
  attempt: number
  effect: MatrixTurnKnownEffect
  tools: string[]
}

const KNOWN_EFFECTS: ReadonlySet<string> = new Set(['none', 'read_only', 'side_effect_possible'])

/**
 * The `resume` a grant carries, or nothing if it is absent or malformed. A malformed one is read as
 * absent on purpose: the facts only ever add care to a run, and a bad record must not stop a message
 * from being answered.
 */
export function matrixTurnResume(value: unknown): MatrixTurnResume | undefined {
  const item = value as { attempt?: unknown; effect?: unknown; tools?: unknown } | null | undefined

  if (
    !item ||
    typeof item !== 'object' ||
    !Number.isSafeInteger(item.attempt) ||
    (item.attempt as number) < 1 ||
    (item.attempt as number) > 100 ||
    typeof item.effect !== 'string' ||
    !KNOWN_EFFECTS.has(item.effect) ||
    !Array.isArray(item.tools)
  ) {
    return undefined
  }

  return {
    attempt: item.attempt as number,
    effect: item.effect as MatrixTurnKnownEffect,
    tools: matrixToolNames(item.tools)
  }
}

/** Most of a prompt the continuation note may take. */
export const MATRIX_RESUME_NOTE_MAX = 900

/**
 * The check turn's instruction: the facts of an earlier attempt, for the one prompt of the run that
 * looks at what it did (it repeats nothing, reports, and asks before redoing). Written to the
 * assistant, not to the owner, and labelled as Atum's so it never passes for the owner's words. It
 * is part of the new turn's single message (after the owner's own text), never an extra message and
 * never a rewrite of anything earlier, so the conversation's cached prefix and its role alternation
 * stay as they were.
 *
 * It always fits `MATRIX_RESUME_NOTE_MAX`: the warning is the part that matters, so when the tool
 * names would not fit beside it the list is shortened ("a, b and 4 more"), never the warning.
 */
export function matrixResumeNote(resume: Pick<MatrixTurnResume, 'tools'>): string {
  const tools = matrixToolNames(resume.tools)

  const build = (ran: string) =>
    '[Atum note, not written by the person: an earlier attempt at this same request was cut off by a ' +
    `technical problem after it had begun work. ${ran} Some of that work may already be done. ` +
    'This turn is only a check. Do not repeat or redo any action, whatever the request above asks: ' +
    'do not send, write, change, delete, buy, schedule or run anything again. Look at what was actually done ' +
    '(files, sent messages, calendar entries, the results of tools), then tell the person in plain words what is ' +
    'finished and what is not. If something is left, say what and ask whether to do it; do it only after they say yes.]'

  if (!tools.length) {
    return build('It is not known which tools it had started. What they did was lost.')
  }

  for (let shown = tools.length; shown >= 0; shown -= 1) {
    const listed = tools.slice(0, shown).join(', ')
    const rest = tools.length - shown

    const names =
      rest === 0
        ? listed
        : shown > 0
          ? `${listed} and ${rest} more`
          : `${rest} tool${rest === 1 ? '' : 's'} (not named here)`

    const note = build(`Before it stopped it had started: ${names}. What they did was lost.`)

    if (note.length <= MATRIX_RESUME_NOTE_MAX) {
      return note
    }
  }

  return build('It is not known which tools it had started. What they did was lost.')
}

/**
 * The prompt of a resumed run: the original, then the note. The note always fits, and a prompt that
 * leaves it no room gives up its own end, never the note: a rerun that may repeat a real action
 * must carry the warning, and a prompt this long already came from one the first run handled.
 */
export function matrixResumePrompt(prompt: string, resume: Pick<MatrixTurnResume, 'tools'>, max: number): string {
  const note = matrixResumeNote(resume)
  const room = max - note.length - 2

  return `${prompt.length > room ? prompt.slice(0, Math.max(0, room)) : prompt}\n\n${note}`
}

/**
 * A transaction ID for a status notice about one message, the same on every attempt and on every
 * Mac: the notice goes out under it, so a repeat is the same event, never a second notice. It has the
 * shape of an ID the ledger issues so every check on result IDs accepts it.
 */
export function matrixStatusTransaction(parts: {
  agentPrincipal: string
  roomId: string
  eventId: string
  code: string
}): string {
  const hex = createHash('sha256')
    .update(JSON.stringify(['atum-status-v1', parts.agentPrincipal, parts.roomId, parts.eventId, parts.code]))
    .digest('hex')

  // A version-4 shape (what `matrixTurnId` and every other check on a result's IDs accept).
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
