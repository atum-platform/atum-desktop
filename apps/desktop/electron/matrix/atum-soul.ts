/**
 * The primary assistant's own persona (golden path, 
 * §5 item 1). Its definition on the platform may carry a persona; when it carries none, the
 * assistant is Atum, never the engine's default ("Hermes Agent … Nous Research"). Another
 * agent keeps the persona its person gave it, and plain Hermes keeps its own default.
 */

import { PRIMARY_ASSISTANT_KEEPS_NAME } from '../../shared/matrix-assistant-name'
import { renameSoulHeading } from '../../shared/matrix-assistant-persona'

/** The persona's first line, one per answer to owner decision D1 (`PRIMARY_ASSISTANT_KEEPS_NAME`
 * in shared/matrix-assistant-name.ts). The primary is renameable (D1 answered 2026-10-05), so
 * the line says the name it goes by now and, as before the card, takes another one when the
 * person gives it in chat. With the name locked, it would say the name stays Atum. Renaming
 * by asking in chat changing the name others see comes, if ever, after a security review
 * (D9). */
function nameLine(name: string, keeps: boolean): string {
  return keeps
    ? `You are ${name}, the person’s own assistant in the Atum app. If they want to call you something else, tell them they can change your picture and how you work from your card, and that your name stays ${name}.`
    : `You are ${name}, the person’s own assistant in the Atum app. If they give you another name, use it from then on and remember it.`
}

/** Either D1 answer's first line, for any name (a name is one line of at most 40 characters). */
const NAME_LINE =
  /^You are ([^\n]{1,80}?), the person’s own assistant in the Atum app\. (?:If they give you another name, use it from then on and remember it\.|If they want to call you something else, tell them they can change your picture and how you work from your card, and that your name stays \1\.)$/m

/** The body before agent-turns/1.3 "acknowledge, then progress". A home that still holds it
 * (with Atum's built-in first line) carries nobody's edits, so it is recognised as built in
 * and updated to the current body. */
const LEGACY_LEAD =
  'You run on their Mac and can do real work there for them: read and organise files, write and edit documents, run commands, search and browse the web, use their apps, and keep reminders and scheduled tasks. macOS asks them before you first open Desktop, Documents or Downloads; if something is blocked, tell them in one line how to allow it.'

const LEGACY_PRIMARY_BODY = [
  LEGACY_LEAD,
  '',
  'Be warm, brief and capable. Reply in the language they write in; when you can’t tell, use Vietnamese. Lead with the answer or the result, then offer one useful next step. Do the work rather than explain how, and ask only when the choice is truly theirs. Remember what matters about them so they never have to repeat themselves. Before sending anything on their behalf, spending money or deleting something for good, check with them unless they clearly asked for exactly that.'
].join('\n')

/** One sentence: before a multi-step task, say what you will do. Hermes's narration of the
 * work that follows becomes the app's one progress line (shared/matrix-progress-line.ts). */
const ACKNOWLEDGE_FIRST = 'Before a multi-step task, say in one short line what you will do, then do it.'

/** The body between "acknowledge, then progress" and the place-neutral lead below. Still recognised as
 * built in, so a home that holds it is brought to the current body. */
const PREVIOUS_PRIMARY_BODY = LEGACY_PRIMARY_BODY.replace(
  'and ask only when the choice is truly theirs.',
  `and ask only when the choice is truly theirs. ${ACKNOWLEDGE_FIRST}`
)

/** Where the assistant runs is not the persona's to say: the persona is one text for a Mac and for
 * Atum's cloud (a cloud-at-sign-up account is seeded with these very bytes, atum-persona.ts in the
 * platform), and "You run on their Mac" made a cloud assistant promise Mac actions it cannot do
 * (walkthrough r3, G5). The "Where you run" section of the system prompt (agent/prompt_builder.py) is
 * the one place that states it, per place, and the prompt stays byte-stable per conversation. */
const PLACE_NEUTRAL_LEAD =
  'You can do real work for them: read and organise files, write and edit documents, run commands, search and browse the web, use their apps, and keep reminders and scheduled tasks. Where you run, and what you can reach from there, is in the “Where you run” section; go by it, and say where you run only as it says. If macOS blocks something on their Mac, tell them in one line how to allow it.'

const PRIMARY_BODY = PREVIOUS_PRIMARY_BODY.replace(LEGACY_LEAD, PLACE_NEUTRAL_LEAD)

function primarySoul(line: string): string {
  return `${line}\n\n${PRIMARY_BODY}`
}

/** The primary assistant's built-in persona, for the name it goes by (Atum until renamed).
 * English instructions; it answers in the person's language (Vietnamese when it cannot tell). */
export function matrixPrimarySoul(name = 'Atum'): string {
  return primarySoul(nameLine(name.trim() || 'Atum', PRIMARY_ASSISTANT_KEEPS_NAME))
}

/** Written as the primary assistant's SOUL.md when its definition has no persona and it is
 * still called Atum. */
export const ATUM_ASSISTANT_SOUL = matrixPrimarySoul('Atum')

/** The primary persona exactly as it shipped before the acknowledge-first sentence: still
 * recognised as built in, so existing homes update. */
export const ATUM_ASSISTANT_SOUL_LEGACY = `${nameLine('Atum', PRIMARY_ASSISTANT_KEEPS_NAME)}\n\n${LEGACY_PRIMARY_BODY}`

/** The primary persona as it shipped with the acknowledge-first sentence and the Mac-only lead:
 * still recognised as built in, so existing homes update. */
export const ATUM_ASSISTANT_SOUL_PREVIOUS = `${nameLine('Atum', PRIMARY_ASSISTANT_KEEPS_NAME)}\n\n${PREVIOUS_PRIMARY_BODY}`

/** The other D1 answer's persona, word for word: a home that still holds exactly this carries
 * nobody's edits, so the current persona replaces it (either way the switch is flipped). */
export const ATUM_ASSISTANT_SOUL_OTHER_ANSWER = primarySoul(nameLine('Atum', !PRIMARY_ASSISTANT_KEEPS_NAME))

function normalized(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim()
}

/** Whether a SOUL.md is Atum's built-in primary persona, untouched, for any name and either D1
 * answer: it carries nobody's edits. */
export function isBuiltInPrimarySoul(text: string): boolean {
  const value = normalized(text)
  const match = NAME_LINE.exec(value)

  if (match?.index !== 0) {
    return false
  }

  const body = value.slice(match[0].length)

  return (
    body === `\n\n${PRIMARY_BODY}` ||
    body === `\n\n${PREVIOUS_PRIMARY_BODY}` ||
    body === `\n\n${LEGACY_PRIMARY_BODY}`
  )
}

/**
 * A stored persona after the primary is renamed: its "# Name" heading and Atum's built-in
 * first line ("You are Name, …", which the card keeps above the person's own sections) follow
 * the new name. Every other byte stays.
 */
export function renamePrimarySoul(soul: string, name: string): string {
  const headed = renameSoulHeading(soul, name)

  return headed.replace(NAME_LINE, line => nameLine(name, !line.includes('If they give you another name')))
}

/**
 * The engine's own default persona, as Hermes seeds it when a home has no SOUL.md
 * (`DEFAULT_SOUL_MD` in hermes_cli/default_soul.py). A primary assistant whose home still
 * holds exactly this text never chose it: Hermes wrote it before Atum's persona arrived, so
 * it is replaced. If Hermes ever rewords its default, this stops matching and nothing is
 * replaced (the safe direction); keep the two in step.
 */
const HERMES_DEFAULT_SOUL =
  'You are Hermes Agent, an intelligent AI assistant created by Nous Research. ' +
  'You are helpful, knowledgeable, and direct. You assist users with a wide ' +
  'range of tasks including answering questions, writing and editing code, ' +
  'analyzing information, creative work, and executing actions via your tools. ' +
  'You communicate clearly, admit uncertainty when appropriate, and prioritize ' +
  'being genuinely useful over being verbose unless otherwise directed below. ' +
  'Be targeted and efficient in your exploration and investigations.'

/** Whether a SOUL.md is the engine's untouched default (line endings, a BOM and surrounding
 * space aside; `trim` drops the BOM): it carries nobody's intent, so the primary assistant's
 * persona may replace it. */
export function isHermesDefaultSoul(text: string): boolean {
  return normalized(text) === HERMES_DEFAULT_SOUL
}

/**
 * What the primary assistant's persona seeding falls back to (seedMatrixAgentSoul,
 * reconcileMatrixAgentSoul), for the name it goes by now. Hermes's untouched default, and Atum's
 * built-in persona for another name or the other D1 answer, carry nobody's intent: they are
 * replaced, so a rename reaches the persona of a primary that has none of its own.
 */
export function matrixPrimarySoulFallback(name?: string): { soul: string; replaces(existing: string): boolean } {
  const soul = matrixPrimarySoul(name)

  return {
    soul,
    replaces: text => isHermesDefaultSoul(text) || (isBuiltInPrimarySoul(text) && normalized(text) !== soul)
  }
}

/** The fallback for a primary still called Atum. */
export const MATRIX_PRIMARY_SOUL_FALLBACK = matrixPrimarySoulFallback('Atum')
