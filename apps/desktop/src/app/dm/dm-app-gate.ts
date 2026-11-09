/**
 * The pure decisions behind the two per-app surfaces, kept out of the
 * components so they can be tested without a DOM and read without React.
 */

import { allowsIntakeModal } from '@/lib/atum-app-surfaces'
import type { IntakeFieldSpec } from '@/lib/atum-app-surfaces'

import { parseDmMetadata } from './dm-metadata'

/** The dispatch error code a gated app turn fails with. */
export const INTAKE_REQUIRED_CODE = 'intake_required'

interface DispatchCarrier {
  metadata?: null | Record<string, unknown>
}

/**
 * True when the most recent turn in this thread failed because the app is
 * still waiting on intake.
 *
 * Only the LAST failure counts. A thread that hit the gate, was filled in, and
 * carried on still contains the old failed message forever — reopening the form
 * on top of a working conversation because of week-old history would be a bug,
 * not a reminder.
 */
export function intakeRequiredByLastTurn(messages: readonly DispatchCarrier[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const carrier = messages[index]
    const dispatch = parseDmMetadata(carrier ? (carrier.metadata ?? null) : null)?.specialistDispatch

    if (!dispatch) {
      continue
    }

    // Anything other than a failure supersedes an older gate: a turn that
    // succeeded, or one still in flight, both mean the app is not blocked on
    // intake right now.
    if (dispatch.state !== 'failed') {
      return false
    }

    return dispatch.errorCode === INTAKE_REQUIRED_CODE
  }

  return false
}

/**
 * Whether Atum may put an intake modal in front of the user for this
 * conversation.
 *
 * Three independent gates, all of which must pass:
 *   1. it is an app conversation at all (a person cannot declare intake),
 *   2. the app advertises `intake.modal` — or declares no capabilities, in
 *      which case the server's intake status is the authority,
 *   3. the server says something is actually missing.
 *
 * Gate 2 is why an app that declares nothing never sees a form even if a
 * mis-deployed server answered with fields.
 */
export function mayShowIntake(input: {
  isApp: boolean
  payload: null | Record<string, unknown> | undefined
  fields: readonly IntakeFieldSpec[]
}): boolean {
  return input.isApp && allowsIntakeModal(input.payload) && input.fields.length > 0
}

export type IntakeValues = Record<string, string>

/** Blank required fields, in declaration order. Every declared field is required. */
export function missingIntakeValues(fields: readonly IntakeFieldSpec[], values: IntakeValues): string[] {
  return fields.filter(field => !(values[field.name] ?? '').trim()).map(field => field.name)
}

/** Trim on the way out; the app owns everything else about its own values. */
export function normalizeIntakeValues(fields: readonly IntakeFieldSpec[], values: IntakeValues): IntakeValues {
  const payload: IntakeValues = {}

  for (const field of fields) {
    payload[field.name] = (values[field.name] ?? '').trim()
  }

  return payload
}

/**
 * The label for a control the server did not name: `birth_city` → `Birth city`.
 * A last resort — a server-sent label always wins — but far better than
 * printing a snake_case identifier at a user, and it costs nothing per app.
 */
export function humanizeFieldName(name: string): string {
  const words = name.split('_').filter(Boolean)

  if (words.length === 0) {
    return name
  }

  return [words[0]!.charAt(0).toLocaleUpperCase() + words[0]!.slice(1), ...words.slice(1)].join(' ')
}

export function intakeFieldLabel(field: IntakeFieldSpec): string {
  return field.label ?? humanizeFieldName(field.name)
}
