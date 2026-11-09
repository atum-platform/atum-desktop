import type { MatrixAliasErrorCode } from '../../shared/matrix-aliases'

/**
 * A public handle as a person types it, before and after the directory answers
 * (spec/public-handles/v1). The client checks only the grammar and the `_bot` rule, to save a
 * request; the platform decides availability, reserved names and the 30-day rule.
 */
export type MatrixHandleKind = 'person' | 'agent'

/** Why a handle cannot be had, in the copy's terms. */
export type MatrixHandleProblem = 'invalid' | 'botRequired' | 'botReserved' | 'reserved' | 'unavailable'

const HANDLE = /^[a-z][a-z0-9_]{2,31}$/
const BOT = '_bot'

const CHECK_CODES: Record<string, MatrixHandleProblem> = {
  alias_invalid: 'invalid',
  alias_bot_suffix_required: 'botRequired',
  alias_bot_suffix_reserved: 'botReserved',
  alias_reserved: 'reserved',
  alias_unavailable: 'unavailable'
}

/** What the directory will read: no leading @, no surrounding space, lower case. */
export function foldMatrixHandle(raw: string): string {
  return raw.trim().replace(/^@/, '').toLowerCase()
}

/** The grammar and the ending, as the directory applies them; null when it may ask. */
export function localMatrixHandleProblem(handle: string, kind: MatrixHandleKind): MatrixHandleProblem | null {
  if (!HANDLE.test(handle)) {
    return 'invalid'
  }

  if (kind === 'agent' && !handle.endsWith(BOT)) {
    return 'botRequired'
  }

  return kind === 'person' && handle.endsWith(BOT) ? 'botReserved' : null
}

/** A check's refusal code as a problem; an unknown code is just unavailable. */
export function matrixHandleCheckProblem(code: string | null): MatrixHandleProblem | null {
  return code === null ? null : (CHECK_CODES[code] ?? 'unavailable')
}

/** The part of an assistant's handle before `_bot`, from its name ("Tiếp thị" → "tiep_thi"):
 * diacritics stripped, đ read as d, anything else folded to `_`. '' when nothing usable is left. */
function agentHandleStem(name: string | null | undefined, room = 32 - BOT.length): string {
  const stem = (name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .slice(0, room)
    .replace(/_+$/, '')

  return stem && HANDLE.test(`${stem}${BOT}`) ? stem : ''
}

/** Room for an assistant's handle before its fixed `_bot` ending. */
export const MATRIX_AGENT_STEM_MAX = 32 - BOT.length

/**
 * The stem a person's typing in an assistant's handle field stands for. The field shows `@`
 * before it and a fixed `_bot` after it, and keeps the text exactly as typed (so spaces, a
 * trailing `_` and Telex composition survive keystroke by keystroke); this is read from it for
 * the check, the status line and the claim, and becomes the field's text once it loses focus.
 * Read the way a name is ("Bếp Trưởng" → "bep_truong"); a typed `@`, a final `_bot` and
 * trailing `_` are dropped, since `@` and `_bot` are shown. A `_bot` inside ("tro_ly_botanic")
 * is kept.
 */
export function typedMatrixAgentHandleStem(raw: string): string {
  return raw
    .trim()
    .replace(/^@+/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+$/, '')
    .replace(/_bot$/, '')
    .slice(0, MATRIX_AGENT_STEM_MAX)
    .replace(/_+$/, '')
}

/** The part of an assistant's handle the field shows ("tiep_thi_bot" → "tiep_thi"). */
export function matrixAgentHandleStem(handle: string): string {
  return handle.endsWith(BOT) ? handle.slice(0, -BOT.length) : handle
}

/** The whole handle for a stem the field holds, or '' for an empty field. */
export function matrixAgentHandleFromStem(stem: string): string {
  return stem ? `${stem}${BOT}` : ''
}

/** A first handle to offer an assistant, from its name ("Trợ lý Đức" → "tro_ly_duc_bot"), or ''. */
export function suggestMatrixAgentHandle(name: string | null | undefined): string {
  const stem = agentHandleStem(name)

  return stem ? `${stem}${BOT}` : ''
}

/**
 * The stem used when a name gives none, or when the directory reserves the name's own
 * ("小助手", "Hà Nội"): Vietnamese for "helper". Never "tro_ly": the platform reserves "troly"
 * (atum-platform 0208), and it reads a stem with up to four digits after it as the stem itself.
 */
export const FALLBACK_AGENT_STEM = 'tro_thu'

function agentHandleGroup(stem: string, random: () => number): string[] {
  const numbered = (value: number) => {
    const digits = String(value)
    // One character is kept for the `_` that separates a stem ending in a digit.
    const cut = stem.slice(0, 32 - BOT.length - digits.length - 1).replace(/_+$/, '')

    return `${cut}${/\d$/.test(cut) ? '_' : ''}${digits}${BOT}`
  }

  const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1))
  const candidates = new Set([`${stem}${BOT}`])

  for (const [low, high] of [
    [10, 99],
    [10, 99],
    [100, 999],
    [1000, 9999]
  ] as const) {
    candidates.add(numbered(between(low, high)))
  }

  return [...candidates].filter(handle => localMatrixHandleProblem(handle, 'agent') === null)
}

/**
 * The handles a new assistant tries, best first, in groups that share a stem: the one from its
 * name, then the same with a short number ("tiep_thi_bot", "tiep_thi42_bot", …), then the same
 * from {@link FALLBACK_AGENT_STEM}. A handle the person chose (`chosen`, the part before `_bot`)
 * goes first, with its own numbers. A reserved stem stays reserved with any short number, so the
 * claim moves to the next group rather than the next number. Every handle is well formed and
 * ends in `_bot`; the directory still decides which is free.
 */
export function matrixAgentHandleCandidates(
  name: string | null | undefined,
  random: () => number = Math.random,
  chosen?: string
): string[][] {
  const usable = (stem: string | undefined) => Boolean(stem && HANDLE.test(`${stem}${BOT}`))
  const stems = [chosen, agentHandleStem(name), FALLBACK_AGENT_STEM].filter(usable) as string[]

  return [...new Set(stems)].map(each => agentHandleGroup(each, random))
}

/** The same handle with a short number, to offer when the plain one is taken ("tiep_thi42_bot"). */
export function numberedMatrixAgentHandle(stem: string, random: () => number = Math.random): string | undefined {
  return agentHandleGroup(stem, random).find(handle => handle !== `${stem}${BOT}`)
}

/** When a rename refused with its 30-day wait may be tried again. */
export function matrixHandleNextChange(retryAfterSeconds: number, now = Date.now()): Date {
  return new Date(now + retryAfterSeconds * 1000)
}

/** Copy keys for a failed request, as the copy names them. */
export type MatrixHandleFailure = Exclude<MatrixAliasErrorCode, 'unavailable'> | 'failed'

export function matrixHandleFailure(error: MatrixAliasErrorCode): MatrixHandleFailure {
  return error === 'unavailable' ? 'failed' : error
}
