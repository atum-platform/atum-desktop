/**
 * The codes beside an agent's outcome words (`atum.agent-turns/1.5` A14, A15), read so a viewer can
 * say them in its own language. Each reader is closed: an unknown key, code or version, or a detail out
 * of bounds, means "show the body" (the sender-language sentence every Matrix client can read). None of
 * them confers authority; the renderer still requires the room's agent as the sender.
 */
import { DESKTOP_LOCALES, type DesktopLocale } from './desktop-locale'
import {
  isMatrixAgentStatusCode,
  MATRIX_AGENT_ANSWER_WARNING_CODES,
  type MatrixAgentAnswerWarningCode,
  type MatrixAgentStatusCode,
  type MatrixAgentStatusDetails,
  matrixAgentStatusText
} from './matrix-agent-status-copy'
import type { MatrixProgressMarker, MatrixProgressPresentation } from './matrix-progress-marker'
import { matrixProgressLineText } from './matrix-status-line-copy'

export const MATRIX_RESULT_KEY = 'io.atum.result'
/** Top-level siblings of the closed `io.atum.result` (agent-turns/1.5 A14): the old object is unchanged. */
export const MATRIX_RESULT_DETAILS_KEY = 'io.atum.result_details'
export const MATRIX_RESULT_WARNING_KEY = 'io.atum.result_warning'
export const MATRIX_STATUS_LINE_KEY = 'io.atum.status'

const DEVICES_MAX = 8
const DEVICE_NAME_MAX = 80
const ROUTINE_TITLE_MAX = 60
const WARNING_FROM_MAX = 65_536

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

const scalars = (value: string) => [...value].length

function boundedLine(value: unknown, max: number): value is string {
  // One line: no control, separator or C1 characters (the publisher strips them).
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length > 0 && scalars(value) <= max && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
}

/** `details` exactly as the contract bounds it; `null` when present but not that shape. */
export function matrixAgentStatusDetails(value: unknown): MatrixAgentStatusDetails | null | undefined {
  if (value === undefined) {
    return undefined
  }

  const raw = plainObject(value)

  if (!raw || Object.keys(raw).some(key => !['devices', 'routine_title', 'attachment', 'resume'].includes(key))) {
    return null
  }

  const { devices, routine_title: routine, attachment, resume } = raw

  if (
    (devices !== undefined &&
      (!Array.isArray(devices) || devices.length < 1 || devices.length > DEVICES_MAX ||
        !devices.every(name => boundedLine(name, DEVICE_NAME_MAX)))) ||
    (routine !== undefined && (!boundedLine(routine, ROUTINE_TITLE_MAX) || /["“”]/u.test(routine))) ||
    (attachment !== undefined && attachment !== 'unsupported' && attachment !== 'unreadable') ||
    (resume !== undefined && typeof resume !== 'boolean')
  ) {
    return null
  }

  return {
    ...(devices !== undefined ? { devices: [...(devices as string[])] } : {}),
    ...(routine !== undefined ? { routine_title: routine as string } : {}),
    ...(attachment !== undefined ? { attachment: attachment as 'unsupported' | 'unreadable' } : {}),
    ...(resume !== undefined ? { resume: resume as boolean } : {})
  }
}

export interface MatrixAgentStatusNotice {
  code: MatrixAgentStatusCode
  details?: MatrixAgentStatusDetails
}

/**
 * The status of an outcome notice (`io.atum.result` on an `m.notice`, without `io.atum.progress`): its
 * code and its bounded `io.atum.result_details`, or nothing when the marker has a key outside its
 * published shape or the details are malformed (the body then stands).
 */
export function matrixResultStatusNotice(content: Record<string, unknown>): MatrixAgentStatusNotice | undefined {
  const raw = plainObject(content[MATRIX_RESULT_KEY])

  if (
    content.msgtype !== 'm.notice' ||
    !raw ||
    content['io.atum.progress'] !== undefined ||
    !isMatrixAgentStatusCode(raw.status) ||
    Object.keys(raw).some(key => !['status', 'invocation', 'transaction', 'stopEvent'].includes(key))
  ) {
    return undefined
  }

  const details = matrixAgentStatusDetails(content[MATRIX_RESULT_DETAILS_KEY])

  return details === null ? undefined : { code: raw.status, ...(details ? { details } : {}) }
}

/**
 * A scheduled or standing line (`io.atum.status` `{version:1, code, details?}`, A15): never beside
 * `io.atum.result`, which every older reader takes for an answer marker.
 */
export function matrixStatusLine(content: Record<string, unknown>): MatrixAgentStatusNotice | undefined {
  const raw = plainObject(content[MATRIX_STATUS_LINE_KEY])

  if (
    !raw ||
    (content.msgtype !== 'm.text' && content.msgtype !== 'm.notice') ||
    content[MATRIX_RESULT_KEY] !== undefined ||
    content['io.atum.progress'] !== undefined ||
    content['io.atum.interim'] !== undefined ||
    raw.version !== 1 ||
    !isMatrixAgentStatusCode(raw.code) ||
    Object.keys(raw).some(key => !['version', 'code', 'details'].includes(key))
  ) {
    return undefined
  }

  const details = matrixAgentStatusDetails(raw.details)

  return details === null ? undefined : { code: raw.code, ...(details ? { details } : {}) }
}

/**
 * Where the warning after an answer starts, in Unicode scalar values: the answer is everything before
 * it, kept byte for byte. Nothing unless the offset sits exactly on a `\n\n` that is followed by text.
 */
export function matrixWarningSplit(body: string, warningFrom: unknown): { answer: string; warning: string } | undefined {
  if (!Number.isInteger(warningFrom) || (warningFrom as number) < 1 || (warningFrom as number) > WARNING_FROM_MAX) {
    return undefined
  }

  const chars = [...body]
  const at = warningFrom as number

  if (chars[at] !== '\n' || chars[at + 1] !== '\n') {
    return undefined
  }

  const warning = chars.slice(at + 2).join('')

  return warning.trim() ? { answer: chars.slice(0, at).join(''), warning } : undefined
}

export interface MatrixAnswerWarning {
  code: MatrixAgentAnswerWarningCode
  /** The answer's own text, exactly as sent. */
  answer: string
}

/**
 * An answer (`m.text`) that ends with an appended warning: its warning code and its answer text, or
 * nothing unless `io.atum.result_warning` is exactly `{version:1, from}` and `from` sits on the
 * separator.
 */
export function matrixAnswerWarning(content: Record<string, unknown>): MatrixAnswerWarning | undefined {
  const raw = plainObject(content[MATRIX_RESULT_KEY])
  const warning = plainObject(content[MATRIX_RESULT_WARNING_KEY])

  if (
    content.msgtype !== 'm.text' ||
    typeof content.body !== 'string' ||
    !raw ||
    !warning ||
    warning.version !== 1 ||
    Object.keys(warning).some(key => key !== 'version' && key !== 'from') ||
    content['io.atum.progress'] !== undefined ||
    !(MATRIX_AGENT_ANSWER_WARNING_CODES as readonly unknown[]).includes(raw.status)
  ) {
    return undefined
  }

  const split = matrixWarningSplit(content.body, warning.from)

  return split ? { code: raw.status as MatrixAgentAnswerWarningCode, answer: split.answer } : undefined
}

/** Codes whose sentence interpolates `details`. */
const DETAIL_CODES: ReadonlySet<MatrixAgentStatusCode> = new Set([
  'failed', 'couldnt_confirm', 'resuming_on_device', 'attachment_unsupported', 'device_unreachable'
])

/**
 * What an agent's message says to this reader, in its current language, when its code allows it: the
 * working line, an outcome notice, a scheduled line, or an answer with its warning reworded after the
 * answer's own text. Nothing when the message has no usable code (the caller shows `body`). Call it
 * only for a message from the room's agent: a person carrying a marker is never a status.
 */
export function matrixAgentLocalizedText(
  message: {
    body: string
    progress?: MatrixProgressMarker
    presentation?: MatrixProgressPresentation
    cloudStatus?: MatrixAgentStatusNotice
    statusLine?: MatrixAgentStatusNotice
    answerWarning?: MatrixAnswerWarning
  },
  locale: DesktopLocale
): string | undefined {
  if (message.progress && message.presentation) {
    return matrixProgressLineText(message.body, message.progress, message.presentation, locale)
  }

  const status = message.cloudStatus ?? message.statusLine

  if (status) {
    // A sentence that names a Mac, a routine or an attachment kind is reworded only from its details.
    // An event without them (every sender before 1.5) keeps its body unless that body is exactly the
    // plain sentence, so a name it carries is never dropped.
    if (
      !status.details &&
      DETAIL_CODES.has(status.code) &&
      !DESKTOP_LOCALES.some(other => matrixAgentStatusText(status.code, other) === message.body.trim())
    ) {
      return undefined
    }

    return matrixAgentStatusText(status.code, locale, status.details)
  }

  return message.answerWarning
    ? `${message.answerWarning.answer}\n\n${matrixAgentStatusText(message.answerWarning.code, locale)}`
    : undefined
}
