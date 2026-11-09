import { DEFAULT_DESKTOP_LOCALE, isDesktopLocale } from '../../shared/desktop-locale'
import type { MatrixReadiness } from '../../shared/matrix'
import { type AppBotFailure, appBotFailure, appBotFailureCopy } from '../../shared/matrix-app-bot-failure'
import { matrixDeviceIsolationCopy } from '../../shared/matrix-device-isolation-copy'
import { matrixTeamSpaceCopy } from '../../shared/matrix-team-space-copy'

import type { MatrixChatCopy } from './chat-copy'
import { founderCopy } from './founder/founder-copy'
import { messageLinkCopy } from './team-space/message-link-copy'

/** What a failed action says, by what the person can do about it. */
export type MatrixChatFailure =
  | 'identity_review'
  | 'busy'
  | 'generic'
  | 'agent_unavailable'
  | 'cloud_only'
  | 'not_ready'
  | 'offline'
  | 'too_long'
  | 'attachment_limit'
  | 'company_file_preparing'
  | 'company_file_denied'
  | 'company_file_unsupported'
  | 'company_file_changed'
  | 'company_file_unavailable'
  | 'message_link_membership'
  | 'message_link_unavailable'
  /** A post to a channel the platform has archived: nothing went out, whatever Matrix says about this person's power. */
  | 'channel_archived'
  /** A message to the founder that would reach no device of theirs: nothing went out. */
  | 'founder_unready'
  /** The founder's reply to someone whose devices it cannot reach: nothing went out. */
  | 'founder_recipient_unready'
  /** A message to an assistant whose own setup on this Mac is failing (it is not just starting): nothing went out. */
  | 'assistant_cant_start'
  /** A message to an assistant that answers in the cloud and cannot be reached: nothing went out. */
  | 'assistant_unreachable'
  /** An official bot (Moon, Andy) whose chat did not open or whose message did not go, for a
   * reason the person can act on (shared/matrix-app-bot-failure.ts). */
  | `app_bot_${AppBotFailure}`

/** The renderer's own refusal: a send reached the message box while the assistant is not
 * ready (starting, stopped or paused). Nothing went out; words from the box went back in it. */
export const MATRIX_ASSISTANT_NOT_READY = 'matrix_assistant_not_ready'

/** The renderer's own refusal: a post reached the box of a channel the platform has archived. Nothing went out. */
export const MATRIX_CHANNEL_ARCHIVED = 'matrix_channel_archived'

/**
 * Main refuses with a closed code inside the error message (`Error invoking remote method
 * 'matrix:ui': Error: matrix_not_ready`). Only a few codes tell the person something they
 * can act on; everything else is "that didn't work", never a code or the server's words.
 */
export function matrixChatFailure(cause: unknown, online = true): MatrixChatFailure {
  if (!online) {
    return 'offline'
  }

  // A send already read against its chat (`matrixSendFailure`) says what it was read as.
  if (cause instanceof MatrixSendFailure) {
    return cause.failure
  }

  const text = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  const code = failureCode(cause)

  if (code === 'matrix_offline' || /\b(?:Failed to fetch|NetworkError|ERR_INTERNET_DISCONNECTED)\b/.test(text)) {
    return 'offline'
  }

  if (code === 'matrix_identity_review_required') {
    return 'identity_review'
  }

  if (code === 'matrix_agent_unavailable') {
    return 'agent_unavailable'
  }

  if (code === 'matrix_cloud_agent_unsupported') {
    return 'cloud_only'
  }

  if (code === 'matrix_message_too_long') {
    return 'too_long'
  }

  if (code === 'matrix_attachment_limit') {
    return 'attachment_limit'
  }

  if (code === 'matrix_company_file_preparing') {
    return 'company_file_preparing'
  }

  if (code === 'matrix_company_file_denied' || code === 'matrix_company_file_missing') {
    return 'company_file_denied'
  }

  if (code === 'matrix_company_file_unsupported') {
    return 'company_file_unsupported'
  }

  if (code === 'matrix_company_file_conflict' || code === 'matrix_company_file_version_conflict') {
    return 'company_file_changed'
  }

  if (code?.startsWith('matrix_company_file_')) {
    return 'company_file_unavailable'
  }

  if (code === 'matrix_message_link_membership') {
    return 'message_link_membership'
  }

  if (code === 'matrix_message_link_unavailable') {
    return 'message_link_unavailable'
  }

  if (code === MATRIX_CHANNEL_ARCHIVED) {
    return 'channel_archived'
  }

  // The Founder chat's two refusals (founder/sdk-founder-chat.ts).
  if (code === 'matrix_founder_unready') {
    return 'founder_unready'
  }

  if (code === 'matrix_founder_recipient_unready') {
    return 'founder_recipient_unready'
  }

  const bot = appBotFailure(code)

  if (bot) {
    return `app_bot_${bot}`
  }

  return code === 'matrix_not_ready' ? 'busy' : code === MATRIX_ASSISTANT_NOT_READY ? 'not_ready' : 'generic'
}

/** One of the Founder chat's refusals: it comes before any message is made, so nothing went
 * out and the chat has nothing to retry. */
export function isMatrixFounderRefusal(failure: MatrixChatFailure): boolean {
  return failure === 'founder_unready' || failure === 'founder_recipient_unready'
}

/** The sentence for a failure, in the window's language (`copy` is that language's chat copy).
 * `subject` names the official bot an `app_bot_*` failure is about (`aboutAppBot`). */
export function matrixChatFailureCopy(
  failure: MatrixChatFailure,
  copy: MatrixChatCopy,
  locale: string,
  subject?: string
): string {
  if (failure.startsWith('app_bot_')) {
    return appBotFailureCopy(failure.slice('app_bot_'.length) as AppBotFailure, locale, subject)
  }

  if (failure === 'assistant_cant_start' || failure === 'assistant_unreachable') {
    const name = subject?.trim()

    // Without its name, the plain "this assistant isn't available" line.
    if (!name) {
      return copy.errorAgentUnavailable
    }

    return failure === 'assistant_cant_start' ? copy.errorAssistantCantStart(name) : copy.errorAssistantUnreachable(name)
  }

  if (failure === 'identity_review') {
    return matrixDeviceIsolationCopy[isDesktopLocale(locale) ? locale : DEFAULT_DESKTOP_LOCALE].sendBlocked
  }

  if (failure === 'founder_unready' || failure === 'founder_recipient_unready') {
    const founder = founderCopy(locale)

    return failure === 'founder_unready' ? founder.unready : founder.recipientUnready
  }

  if (failure === 'channel_archived') {
    return matrixTeamSpaceCopy(locale).archivedBanner
  }

  if (failure === 'message_link_membership' || failure === 'message_link_unavailable') {
    const link = messageLinkCopy(locale)

    return failure === 'message_link_membership' ? link.notMember : link.unavailable
  }

  return {
    busy: copy.errorBusy,
    generic: copy.errorGeneric,
    agent_unavailable: copy.errorAgentUnavailable,
    cloud_only: copy.errorCloudOnly,
    not_ready: copy.errorNotReady,
    offline: copy.errorOffline,
    too_long: copy.errorTooLong,
    attachment_limit: copy.errorAttachmentLimit,
    company_file_preparing: copy.companyFilePreparing,
    company_file_denied: copy.companyFileDenied,
    company_file_unsupported: copy.companyFileUnsupported,
    company_file_changed: copy.companyFileChanged,
    company_file_unavailable: copy.companyFileUnavailable
  }[failure as 'busy' | 'generic' | 'agent_unavailable' | 'cloud_only' | 'not_ready' | 'offline' | 'too_long' | 'attachment_limit' | 'company_file_preparing'
    | 'company_file_denied' | 'company_file_unsupported' | 'company_file_changed' | 'company_file_unavailable']
}

/** A failure that names the official bot it was about, so its sentence can ("Moon is paused
 * for now"), and the way to try again: the same action, from the window's failure band. Its
 * message is the original's, so `matrixChatFailure` reads the same code. */
export class MatrixAppBotFailure extends Error {
  constructor(
    cause: unknown,
    readonly subject: string,
    readonly retry?: () => void
  ) {
    super(cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '', { cause })
    this.name = 'MatrixAppBotFailure'
  }
}

/** Names the official bot a failure was about and how to try again; any failure can be wrapped,
 * and only an `app_bot_*` failure uses the name. */
export function aboutAppBot(cause: unknown, subject: string | undefined, retry?: () => void): unknown {
  return subject?.trim() || retry ? new MatrixAppBotFailure(cause, subject?.trim() ?? '', retry) : cause
}

/** The bot or assistant a failure names (`aboutAppBot`, `MatrixSendFailure`), if any. */
export function matrixFailureSubject(cause: unknown): string | undefined {
  return (cause instanceof MatrixAppBotFailure || cause instanceof MatrixSendFailure) && cause.subject
    ? cause.subject
    : undefined
}

/** What the person can press to try the failed action again (`aboutAppBot`, `MatrixSendFailure`), if it can be. */
export function matrixFailureRetry(cause: unknown): (() => void) | undefined {
  return cause instanceof MatrixAppBotFailure || cause instanceof MatrixSendFailure ? cause.retry : undefined
}

function failureCode(cause: unknown): string | undefined {
  const text = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''

  return /\bmatrix_[a-z_]+/.exec(text)?.[0]
}

/** Main's refusals that mean the assistant really is in the middle of something else. */
const BUSY_CODES = new Set([
  'matrix_agent_busy',
  'matrix_agent_task_busy',
  'matrix_conversation_busy',
  'matrix_hermes_busy'
])

/** Refusals that only say "not now" (main's catch-all `matrix_not_ready`, the renderer's own
 * not-ready refusal, an assistant main could not reach): the chat itself says why. */
const NOT_NOW_CODES = new Set([
  'matrix_not_ready',
  MATRIX_ASSISTANT_NOT_READY,
  'matrix_agent_unavailable',
  'matrix_runtime_unavailable'
])

/** Failures where pressing Send again can work without the person changing anything first. */
const RETRYABLE_SEND = new Set<MatrixChatFailure>([
  'offline',
  'busy',
  'not_ready',
  'agent_unavailable',
  'assistant_cant_start',
  'assistant_unreachable',
  'generic'
])

/** The chat a send failed in, as far as its words go. */
export interface MatrixSendFailureContext {
  online?: boolean
  /** This is an assistant's chat: its readiness (the room's own agent) and where it answers. */
  assistant?: { readiness?: MatrixReadiness; cloud: boolean }
}

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export function matrixSendFailure(cause: unknown, { online = true, assistant }: MatrixSendFailureContext = {}): MatrixChatFailure {
  const failure = matrixChatFailure(cause, online)

  if (failure === 'offline') {
    return failure
  }

  const code = failureCode(cause)

  if (code && BUSY_CODES.has(code)) {
    return 'busy'
  }

  if (!code || !NOT_NOW_CODES.has(code)) {
    return failure
  }

  if (assistant && assistantCannotRun(assistant.readiness)) {
    return assistant.cloud ? 'assistant_unreachable' : 'assistant_cant_start'
  }

  return code === 'matrix_agent_unavailable' ? 'agent_unavailable' : 'not_ready'
}

/** Readiness codes that mean the assistant itself cannot run (its setup or its runtime on this
 * Mac failed), not a cause the chat's own readiness line already names (offline, Protons,
 * sign-in, a setup cooldown). */
const CANNOT_RUN_CODES = new Set(['setup_failed', 'hermes_unavailable', 'runtime_invalid', 'runtime_unavailable'])

/** Its setup or runtime is failing, while the gate keeps retrying (a retry shows as `starting`
 * with the failure's code still on it). */
function assistantCannotRun(readiness: MatrixReadiness | undefined): boolean {
  return Boolean(readiness && readiness.phase !== 'ready' && readiness.code && CANNOT_RUN_CODES.has(readiness.code))
}

/** Pressing Try again can help this failed send. */
export function matrixSendFailureRetryable(failure: MatrixChatFailure): boolean {
  return RETRYABLE_SEND.has(failure)
}

/**
 * A failed send, already read against its chat (`matrixSendFailure`): what it says, the
 * assistant it names, and Try again (sends what the box holds). Its message is the original's,
 * so the window's diagnostic line keeps main's own code.
 */
export class MatrixSendFailure extends Error {
  constructor(
    cause: unknown,
    readonly failure: MatrixChatFailure,
    readonly subject?: string,
    readonly retry?: () => void
  ) {
    super(cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '', { cause })
    this.name = 'MatrixSendFailure'
  }
}
