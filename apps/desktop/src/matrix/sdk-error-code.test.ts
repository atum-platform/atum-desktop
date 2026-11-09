import { describe, expect, it } from 'vitest'

import { ConversationUnavailableError, EarlierConversationError } from '../../shared/agent-conversation'

import { MATRIX_SDK_FAILED, matrixSdkCommandError, matrixSdkErrorCode, matrixSdkErrorPayload, privateCosJoinFailure } from './sdk-error-code'

describe('what crosses the SDK seam when a command fails', () => {
  it('keeps Atum’s own closed codes, with their protocol detail', () => {
    expect(matrixSdkErrorCode(new Error('matrix_recovery_key_invalid'))).toBe('matrix_recovery_key_invalid')
    expect(matrixSdkErrorCode(new Error('matrix_agent_verification_cancelled:m.key_mismatch:owner'))).toBe(
      'matrix_agent_verification_cancelled:m.key_mismatch:owner'
    )
    expect(matrixSdkErrorCode('matrix_agent_device_replaced')).toBe('matrix_agent_device_replaced')
  })

  it('keeps the refusals that tell a platform-named bot chat apart: encrypted, not the bot’s chat, a retry', () => {
    // electron/matrix/app-bots/platform-room.ts reads these to choose between the local rule and a retry.
    // `matrix_app_bot_syncing` is the chat whose room sync has not brought here in time: the window
    // says so (and offers Retry) instead of "that didn’t work".
    for (const code of [
      'matrix_app_bot_dm_encrypted',
      'matrix_app_bot_dm_invalid',
      'matrix_app_bot_resting',
      'matrix_app_bot_syncing'
    ]) {
      expect(matrixSdkErrorCode(new Error(code))).toBe(code)
      expect(matrixSdkCommandError(matrixSdkErrorPayload(new Error(code))).message).toBe(code)
    }
  })

  it.each(['stale', 'create_unconfirmed', 'uncertain', 'quarantined', 'readonly', 'offline',
    'company_invalid', 'unavailable'])('preserves notes-self %s through process IPC for main diagnostics', reason => {
    const code = `matrix_notes_self_${reason}`
    const payload = JSON.parse(JSON.stringify(matrixSdkErrorPayload(new Error(code))))
    expect(matrixSdkCommandError(payload).message).toBe(code)
  })

  it('turns anything raw into the one generic code', () => {
    for (const raw of [
      new Error('M_FORBIDDEN: You are not allowed to do that'),
      new Error('matrix_recovery_key_invalid because of syt_secret_token'),
      new Error('Matrix_Recovery_Key_Invalid'),
      new Error(`matrix_${'x'.repeat(65)}`),
      new Error('matrix_code:one:two:three'),
      new Error('matrix_code:has space'),
      new Error('matrix_unknown_secret'),
      new Error('matrix_recovery_key_invalid:syt_secret_token'),
      new Error('matrix_agent_verification_cancelled:syt_secret_token:owner'),
      new TypeError('fetch failed'),
      { message: 'matrix_recovery_key_invalid' },
      undefined,
      null,
      42
    ]) {
      expect(matrixSdkErrorCode(raw)).toBe(MATRIX_SDK_FAILED)
    }
  })
})

describe('conversation refusal payload', () => {
  it.each(['!main:test', undefined])('preserves declared identifiers through both serializers (%s)', main => {
    const error = new EarlierConversationError('!earlier:test', main)
    Object.assign(error, { raw: 'private text', token: 'fixture-token' })
    const payload = matrixSdkErrorPayload(error)
    const wire = JSON.parse(JSON.stringify(payload))
    const cloned = structuredClone(matrixSdkErrorPayload(wire))
    const restored = matrixSdkCommandError(cloned)

    expect(payload).toEqual({ code: 'matrix_earlier_conversation', roomId: '!earlier:test', ...(main ? { main } : {}) })
    expect(restored).toBeInstanceOf(EarlierConversationError)
    expect(restored).toMatchObject({ code: 'matrix_earlier_conversation', roomId: '!earlier:test', main })
    expect(restored).not.toHaveProperty('raw')
    expect(restored).not.toHaveProperty('token')
  })

  it('keeps unavailable distinct from an Earlier refusal', () => {
    expect(matrixSdkCommandError(matrixSdkErrorPayload(new ConversationUnavailableError())))
      .toBeInstanceOf(ConversationUnavailableError)
  })

  it.each([
    { code: 'matrix_earlier_conversation', roomId: 'private text' },
    { code: 'matrix_earlier_conversation', roomId: '!earlier:test', main: 'secret value' },
    { code: 'matrix_earlier_conversation', roomId: `!${'x'.repeat(256)}:test` },
    { code: 'matrix_unknown', roomId: '!earlier:test' },
    { code: 'matrix_earlier_conversation', roomId: '!earlier:test', main: null }
  ])('refuses malformed failure payload %j', value => {
    expect(matrixSdkErrorPayload(value)).toBe(MATRIX_SDK_FAILED)
    expect(matrixSdkCommandError(value).message).toBe(MATRIX_SDK_FAILED)
  })
})

it('roundtrips bounded private join diagnostics and drops arbitrary response text',()=>{
  const error=privateCosJoinFailure({httpStatus:404,errcode:'M_UNKNOWN',message:'secret'})
  expect(matrixSdkCommandError(structuredClone(matrixSdkErrorPayload(error))).message).toBe(error.message)
  expect(privateCosJoinFailure({httpStatus:403,errcode:'secret\nresponse'}).message)
    .toBe('matrix_private_cos_join_request_failed:http=403:errcode=unknown')
  expect(matrixSdkErrorCode(error.message+':secret')).toBe(MATRIX_SDK_FAILED)
})
