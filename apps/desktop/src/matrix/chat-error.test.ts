import { describe, expect, it } from 'vitest'

import { LOCALE_OPTIONS } from '@/i18n'

import { matrixTeamSpaceCopy } from '../../shared/matrix-team-space-copy'

import { matrixChatCopy } from './chat-copy'
import {
  aboutAppBot,
  isMatrixFounderRefusal,
  MATRIX_ASSISTANT_NOT_READY,
  MATRIX_CHANNEL_ARCHIVED,
  MatrixAppBotFailure,
  matrixChatFailure,
  matrixChatFailureCopy,
  matrixFailureRetry,
  matrixFailureSubject,
  MatrixSendFailure,
  matrixSendFailure,
  matrixSendFailureRetryable
} from './chat-error'
import { founderCopy } from './founder/founder-copy'

describe('what a failed action says', () => {
  it('reads the closed code inside a refusal from main, and says "try again" for anything else', () => {
    expect(matrixChatFailure(new Error("Error invoking remote method 'matrix:ui': Error: matrix_not_ready"))).toBe('busy')
    expect(matrixChatFailure(new Error("Error invoking remote method 'matrix:ui': Error: matrix_offline"))).toBe('offline')
    expect(matrixChatFailure(new TypeError('Failed to fetch'))).toBe('offline')
    expect(matrixChatFailure(new Error('matrix_report_target_changed'))).toBe('generic')
    expect(matrixChatFailure(undefined)).toBe('generic')
    expect(matrixChatFailure('something odd')).toBe('generic')
  })

  it('names agent availability refusals instead of falling back to generic copy', () => {
    expect(matrixChatFailure(new Error('matrix_agent_unavailable'))).toBe('agent_unavailable')
    expect(matrixChatFailure(new Error('matrix_cloud_agent_unsupported'))).toBe('cloud_only')

    for (const { id } of LOCALE_OPTIONS) {
      const copy = matrixChatCopy(id)
      expect(matrixChatFailureCopy('agent_unavailable', copy, id)).not.toBe(copy.errorGeneric)
      expect(matrixChatFailureCopy('cloud_only', copy, id)).not.toBe(copy.errorGeneric)
    }
  })

  it("says the assistant isn't ready when the message box refused a send for that reason", () => {
    expect(matrixChatFailure(new Error(MATRIX_ASSISTANT_NOT_READY))).toBe('not_ready')

    // Its own sentence in every language, not "busy" or "that didn't work".
    for (const { id } of LOCALE_OPTIONS) {
      const copy = matrixChatCopy(id)
      const notReady = matrixChatFailureCopy('not_ready', copy, id)
      expect(notReady).not.toBe(matrixChatFailureCopy('busy', copy, id))
      expect(notReady).not.toBe(matrixChatFailureCopy('generic', copy, id))
    }
  })

  it('says an archived channel takes no posts, in the window\'s language and not as a generic failure', () => {
    expect(matrixChatFailure(new Error(MATRIX_CHANNEL_ARCHIVED))).toBe('channel_archived')

    for (const { id } of LOCALE_OPTIONS) {
      const copy = matrixChatCopy(id)

      expect(matrixChatFailureCopy('channel_archived', copy, id)).toBe(matrixTeamSpaceCopy(id).archivedBanner)
      expect(matrixChatFailureCopy('channel_archived', copy, id)).not.toBe(matrixChatFailureCopy('generic', copy, id))
    }
  })

  it('keeps linked-message membership and event failures honest in every locale', () => {
    expect(matrixChatFailure(new Error('matrix_message_link_membership'))).toBe('message_link_membership')
    expect(matrixChatFailure(new Error('matrix_message_link_unavailable'))).toBe('message_link_unavailable')

    for (const { id } of LOCALE_OPTIONS) {
      const copy = matrixChatCopy(id)
      const membership = matrixChatFailureCopy('message_link_membership', copy, id)
      const unavailable = matrixChatFailureCopy('message_link_unavailable', copy, id)

      expect(membership).toBeTruthy()
      expect(unavailable).toBeTruthy()
      expect(membership).not.toBe(unavailable)
    }
  })

  it('says plainly when a message is too long to send (FR20)', () => {
    expect(matrixChatFailure(new Error("Error invoking remote method 'matrix:ui': Error: matrix_message_too_long"))).toBe(
      'too_long'
    )
  })

  it('keeps company-file preparation, removal, version drift and outages distinct', () => {
    expect(matrixChatFailure(new Error('matrix_company_file_preparing'))).toBe('company_file_preparing')
    expect(matrixChatFailure(new Error('matrix_company_file_denied'))).toBe('company_file_denied')
    expect(matrixChatFailure(new Error('matrix_company_file_unsupported'))).toBe('company_file_unsupported')
    expect(matrixChatFailure(new Error('matrix_company_file_version_conflict'))).toBe('company_file_changed')
    expect(matrixChatFailure(new Error('matrix_company_file_unavailable'))).toBe('company_file_unavailable')
  })

  it("says why a message to or from the founder didn't go, in the window's language", () => {
    expect(matrixChatFailure(new Error("Error invoking remote method 'matrix:ui': Error: matrix_founder_unready"))).toBe(
      'founder_unready'
    )
    expect(matrixChatFailure(new Error('matrix_founder_recipient_unready'))).toBe('founder_recipient_unready')

    for (const { id } of LOCALE_OPTIONS) {
      const copy = matrixChatCopy(id)
      expect(matrixChatFailureCopy('founder_unready', copy, id)).toBe(founderCopy(id).unready)
      expect(matrixChatFailureCopy('founder_recipient_unready', copy, id)).toBe(founderCopy(id).recipientUnready)
      expect(matrixChatFailureCopy('founder_unready', copy, id)).not.toBe(matrixChatFailureCopy('generic', copy, id))
    }
  })

  it('treats only the two Founder refusals as "nothing went out, nothing to retry"', () => {
    expect(isMatrixFounderRefusal('founder_unready')).toBe(true)
    expect(isMatrixFounderRefusal('founder_recipient_unready')).toBe(true)

    for (const failure of ['busy', 'generic', 'not_ready', 'offline', 'too_long'] as const) {
      expect(isMatrixFounderRefusal(failure)).toBe(false)
    }
  })

  it('says offline whenever the window is offline, whatever the action said', () => {
    expect(matrixChatFailure(new Error('matrix_not_ready'), false)).toBe('offline')
  })

  it.each(LOCALE_OPTIONS.map(({ id }) => id))('has a plain sentence for each cause in %s, never a code', locale => {
    const copy = matrixChatCopy(locale)

    for (const failure of [
      'busy',
      'generic',
      'not_ready',
      'offline',
      'too_long',
      'company_file_preparing',
      'company_file_denied',
      'company_file_unsupported',
      'company_file_changed',
      'company_file_unavailable',
      'message_link_membership',
      'message_link_unavailable',
      'founder_unready',
      'founder_recipient_unready'
    ] as const) {
      const sentence = matrixChatFailureCopy(failure, copy, locale)
      expect(sentence.trim()).not.toBe('')
      expect(sentence).not.toMatch(/matrix_|Hermes|Matrix/)
    }
  })
})


it('maps only the closed SDK trust refusal to identity review, with copy in every locale', () => {
  expect(matrixChatFailure(new Error('matrix_identity_review_required'))).toBe('identity_review')
  expect(matrixChatFailure(new Error('identity changed on network'))).toBe('generic')
  expect(matrixChatFailure(new TypeError('Failed to fetch'))).toBe('offline')
  for (const { id } of LOCALE_OPTIONS) {
    expect(matrixChatFailureCopy('identity_review', matrixChatCopy(id), id)).toBeTruthy()
  }
})

describe("an official bot's chat that did not open or take a message", () => {
  const refusal = (code: string) => new Error(`Error invoking remote method 'matrix:ui': Error: ${code}`)

  it('says why, by name, instead of "that didn\'t work"', () => {
    const failure = matrixChatFailure(aboutAppBot(refusal('matrix_app_bot_starting'), 'Moon'))
    expect(failure).toBe('app_bot_starting')
    expect(matrixChatFailureCopy(failure, matrixChatCopy('vi'), 'vi', 'Moon')).toBe(
      'Moon đang khởi động. Bạn thử lại sau ít phút nhé.'
    )
    expect(matrixChatFailureCopy('app_bot_paused', matrixChatCopy('en'), 'en', 'Andy')).toBe(
      'Andy is paused for now. Try again later.'
    )
    expect(matrixFailureSubject(aboutAppBot(refusal('matrix_app_bot_paused'), ' Andy '))).toBe('Andy')
    // A refusal with no name to give is still the reason, about "this app".
    expect(matrixChatFailureCopy('app_bot_resting', matrixChatCopy('en'), 'en')).toBe(
      'This app is temporarily unavailable. Try again in a few minutes.'
    )
  })

  it('reads every bot code main sends, and leaves an unknown one as "try again"', () => {
    expect(matrixChatFailure(refusal('matrix_app_bot_paused'))).toBe('app_bot_paused')
    expect(matrixChatFailure(refusal('matrix_app_bot_resting'))).toBe('app_bot_resting')
    expect(matrixChatFailure(refusal('matrix_app_bot_untrusted'))).toBe('app_bot_untrusted')
    expect(matrixChatFailure(refusal('matrix_app_bot_changed'))).toBe('app_bot_changed')
    expect(matrixChatFailure(refusal('matrix_app_bot_unavailable'))).toBe('app_bot_unavailable')
    // The chat's room was made but sync has not brought it here yet (src/matrix/app-bot-room-wait.ts).
    expect(matrixChatFailure(refusal('matrix_app_bot_syncing'))).toBe('app_bot_syncing')
    expect(matrixChatFailure(refusal('matrix_app_bot_unheard_of'))).toBe('generic')
    // Offline still wins: it is the one thing to fix first.
    expect(matrixChatFailure(refusal('matrix_app_bot_paused'), false)).toBe('offline')
    // A wrapped refusal keeps its own cause.
    expect(matrixChatFailure(aboutAppBot(refusal('matrix_not_ready'), 'Moon'))).toBe('busy')
    expect(matrixFailureSubject(refusal('matrix_app_bot_paused'))).toBeUndefined()
  })

  it.each(LOCALE_OPTIONS.map(({ id }) => id))('has a distinct sentence naming the bot for each reason in %s', locale => {
    const copy = matrixChatCopy(locale)
    const reasons = ['starting', 'paused', 'resting', 'untrusted', 'changed', 'syncing', 'unavailable'] as const
    const sentences = reasons.map(reason => matrixChatFailureCopy(`app_bot_${reason}`, copy, locale, 'Moon'))

    expect(new Set(sentences).size).toBe(reasons.length)

    for (const sentence of sentences) {
      expect(sentence).toContain('Moon')
      expect(sentence).not.toBe(matrixChatFailureCopy('generic', copy, locale))
      expect(sentence).not.toMatch(/matrix_|Hermes|Matrix/)
    }
  })

  it('carries the way to try again, with or without a name to give', () => {
    const retry = () => {}
    const named = aboutAppBot(refusal('matrix_app_bot_syncing'), 'Exa', retry)

    expect(named).toBeInstanceOf(MatrixAppBotFailure)
    expect(matrixFailureRetry(named)).toBe(retry)
    expect(matrixFailureSubject(named)).toBe('Exa')
    // The code is the cause's, so the sentence is about the room still coming.
    expect(matrixChatFailure(named)).toBe('app_bot_syncing')

    // A catalog with no name for the bot still gets its Retry, and the sentence says "this app".
    const unnamed = aboutAppBot(refusal('matrix_app_bot_syncing'), undefined, retry)
    expect(matrixFailureRetry(unnamed)).toBe(retry)
    expect(matrixFailureSubject(unnamed)).toBeUndefined()
    expect(
      matrixChatFailureCopy(matrixChatFailure(unnamed), matrixChatCopy('en'), 'en', matrixFailureSubject(unnamed))
    ).toBe('The chat with This app is taking longer than usual to open. Try again.')

    // Nothing to retry and nothing to name: the failure is left as it was.
    const plain = refusal('matrix_app_bot_syncing')
    expect(aboutAppBot(plain, undefined)).toBe(plain)
    expect(matrixFailureRetry(plain)).toBeUndefined()
  })
})

// Preserve user-visible identity, state and recovery behavior across connection changes.
describe('what a failed send says', () => {
  const main = (code: string) => new Error(`Error invoking remote method 'matrix:ui': Error: ${code}`)
  const setupFailed = { phase: 'degraded' as const, step: 'assistant' as const, code: 'setup_failed', since: 1 }
  // The gate retrying after the failure: starting again, the failure's code still on it.
  const retrying = { phase: 'starting' as const, step: 'signed_in' as const, code: 'setup_failed', since: 1 }
  const starting = { phase: 'starting' as const, step: 'hermes' as const, since: 1 }
  const ready = { phase: 'ready' as const, since: 1 }

  it('names an assistant whose setup or runtime is failing, by where it answers', () => {
    for (const code of ['matrix_not_ready', MATRIX_ASSISTANT_NOT_READY, 'matrix_agent_unavailable', 'matrix_runtime_unavailable']) {
      for (const readiness of [setupFailed, retrying]) {
        expect(matrixSendFailure(main(code), { assistant: { readiness, cloud: false } })).toBe('assistant_cant_start')
        expect(matrixSendFailure(main(code), { assistant: { readiness, cloud: true } })).toBe('assistant_unreachable')
      }
    }

    for (const code of ['hermes_unavailable', 'runtime_invalid', 'runtime_unavailable']) {
      expect(
        matrixSendFailure(main('matrix_not_ready'), { assistant: { readiness: { ...setupFailed, code }, cloud: false } })
      ).toBe('assistant_cant_start')
    }
  })

  it('says "not ready" while it is only starting, ready, or paused for a cause its chat already names', () => {
    for (const readiness of [starting, ready, undefined, { phase: 'degraded' as const, step: 'ai' as const, code: 'offline', since: 1 }]) {
      expect(matrixSendFailure(main('matrix_not_ready'), { assistant: { readiness, cloud: false } })).toBe('not_ready')
    }

    expect(matrixSendFailure(main('matrix_not_ready'))).toBe('not_ready')
    expect(matrixSendFailure(main('matrix_agent_unavailable'), { assistant: { readiness: ready, cloud: false } })).toBe(
      'agent_unavailable'
    )
  })

  it('says busy only when main says the assistant really is busy', () => {
    for (const code of ['matrix_agent_busy', 'matrix_agent_task_busy', 'matrix_conversation_busy', 'matrix_hermes_busy']) {
      expect(matrixSendFailure(main(code), { assistant: { readiness: setupFailed, cloud: false } })).toBe('busy')
    }
  })

  it('keeps offline first and every other refusal as the chat reads it', () => {
    expect(matrixSendFailure(main('matrix_not_ready'), { online: false, assistant: { readiness: setupFailed, cloud: false } })).toBe(
      'offline'
    )
    expect(matrixSendFailure(main('matrix_message_too_long'))).toBe('too_long')
    expect(matrixSendFailure(new Error(MATRIX_CHANNEL_ARCHIVED))).toBe('channel_archived')
    expect(matrixSendFailure(main('matrix_identity_review_required'))).toBe('identity_review')
    expect(matrixSendFailure(main('matrix_something_new'))).toBe('generic')
  })

  it('offers Try again only where pressing Send again can help', () => {
    for (const failure of ['offline', 'busy', 'not_ready', 'agent_unavailable', 'assistant_cant_start', 'assistant_unreachable', 'generic'] as const) {
      expect(matrixSendFailureRetryable(failure)).toBe(true)
    }

    for (const failure of ['too_long', 'attachment_limit', 'channel_archived', 'identity_review', 'cloud_only', 'founder_unready'] as const) {
      expect(matrixSendFailureRetryable(failure)).toBe(false)
    }
  })

  it('carries its reading, the assistant it names and Try again, and keeps main\'s code in its message', () => {
    const retry = () => {}
    const failure = new MatrixSendFailure(main('matrix_not_ready'), 'assistant_cant_start', 'Raymond', retry)

    expect(matrixChatFailure(failure)).toBe('assistant_cant_start')
    expect(matrixChatFailure(failure, false)).toBe('offline')
    expect(failure.message).toContain('matrix_not_ready')
    expect(matrixFailureSubject(failure)).toBe('Raymond')
    expect(matrixFailureRetry(failure)).toBe(retry)
  })

  it('says it in one line in every language, by name, never as "finishing another step"', () => {
    for (const { id: locale } of LOCALE_OPTIONS) {
      const copy = matrixChatCopy(locale)

      for (const failure of ['assistant_cant_start', 'assistant_unreachable'] as const) {
        const line = matrixChatFailureCopy(failure, copy, locale, 'Raymond')

        expect(line).toContain('Raymond')
        expect(line).not.toContain('\n')
        expect(line).not.toBe(copy.errorBusy)
        // Without a name: the plain "this assistant isn't available" line, never an empty name.
        expect(matrixChatFailureCopy(failure, copy, locale)).toBe(copy.errorAgentUnavailable)
      }
    }
  })
})
