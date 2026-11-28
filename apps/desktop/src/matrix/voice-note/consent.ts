import { type MatrixClient, MatrixError, Method } from 'matrix-js-sdk'

import {
  MATRIX_VOICE_TRANSCRIPTION_CONSENT_PREFIX,
  MATRIX_VOICE_TRANSCRIPTION_PROFILE,
  matrixVoiceTranscriptionProvider,
  type MatrixVoiceTranscriptionProvider
} from '../../../shared/matrix-rich-content'
import { matrixTargetAccountDataType } from '../../../shared/matrix-target-account-data'

type VoiceConsent =
  | { kind: 'transcriptionUnavailable' }
  | { kind: 'transcriptionRequired' | 'transcriptionAllowed'; provider: MatrixVoiceTranscriptionProvider }

export async function matrixVoiceConsent(
  client: MatrixClient,
  assistant: string,
  confirmed?: MatrixVoiceTranscriptionProvider
): Promise<VoiceConsent> {
  if (!await client.doesServerSupportExtendedProfiles()) {
    return { kind: 'transcriptionUnavailable' }
  }

  const profile = await client.getExtendedProfile(assistant)
  const provider = matrixVoiceTranscriptionProvider(profile[MATRIX_VOICE_TRANSCRIPTION_PROFILE])

  if (!provider) {
    return { kind: 'transcriptionUnavailable' }
  }

  if (confirmed && confirmed !== provider) {
    return { kind: 'transcriptionRequired', provider }
  }

  const type = await matrixTargetAccountDataType(
    MATRIX_VOICE_TRANSCRIPTION_CONSENT_PREFIX, JSON.stringify([assistant, provider])
  )

  const path = `/user/${encodeURIComponent(client.getSafeUserId())}/account_data/${type}`

  if (confirmed) {
    await client.http.authedRequest(Method.Put, path, undefined, { allowed: true })
  } else {
    // Read current account data even before another device's write arrives in sync.
    try {
      const current = await client.http.authedRequest<{ allowed?: unknown }>(Method.Get, path)

      if (current?.allowed !== true) {
        return { kind: 'transcriptionRequired', provider }
      }
    } catch (error) {
      if (error instanceof MatrixError && error.errcode === 'M_NOT_FOUND') {
        return { kind: 'transcriptionRequired', provider }
      }

      throw error
    }
  }

  return { kind: 'transcriptionAllowed', provider }
}
