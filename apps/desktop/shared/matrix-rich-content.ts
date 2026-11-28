import type { MatrixRoom } from './matrix'

export const MATRIX_VOICE_MIME = 'audio/ogg'
export const MATRIX_VOICE_MAX_MS = 120_000
export const MATRIX_VOICE_MIN_MS = 500
export const MATRIX_VOICE_WAVEFORM_MAX = 100

export const MATRIX_VOICE_TRANSCRIPTION_PROFILE = 'io.atum.voice_transcription_provider'
export const MATRIX_VOICE_TRANSCRIPTION_CONSENT_PREFIX = 'io.atum.voice_transcription_consent.'

export const MATRIX_VOICE_TRANSCRIPTION_NAMES = {
  deepinfra: 'DeepInfra',
  elevenlabs: 'ElevenLabs',
  groq: 'Groq',
  local: 'Local speech model',
  mistral: 'Mistral',
  nous: 'External speech provider',
  openai: 'OpenAI',
  xai: 'xAI'
} as const

export type MatrixVoiceTranscriptionProvider = keyof typeof MATRIX_VOICE_TRANSCRIPTION_NAMES

export function matrixVoiceTranscriptionProvider(value: unknown): MatrixVoiceTranscriptionProvider | undefined {
  return typeof value === 'string' && Object.hasOwn(MATRIX_VOICE_TRANSCRIPTION_NAMES, value)
    ? value as MatrixVoiceTranscriptionProvider
    : undefined
}

export interface MatrixVoiceNote {
  duration: number
  waveform: number[]
}

export interface MatrixPoll {
  question: string
  answers: { id: string; text: string; votes?: number }[]
  selected: string[]
  maxSelections: number
  ended: boolean
  undisclosed: boolean
  ready?: true
  canVote?: true
  canEnd?: true
}

export type MatrixRichMessage =
  | { kind: 'voice'; duration?: number; waveform: number[]; mimeType: string }
  | { kind: 'poll'; poll: MatrixPoll }
  | { kind: 'location'; geoUri: string }
  | { kind: 'sticker'; mimeType: string }

/** People chats can send voice notes without selecting a transcription provider. */
export function matrixHumanVoiceRoom(room: MatrixRoom | undefined, assistants: readonly (string | undefined)[]): boolean {
  return Boolean(room?.membership === 'join' && !room.assistant && !room.plainAgent && !room.appBot && !room.appGroup &&
    room.participants && !room.participants.some(participant =>
      ['join', 'invite'].includes(participant.membership) && assistants.includes(participant.userId)
    ))
}

export function matrixVoiceNote(value: unknown): MatrixVoiceNote | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const { duration, waveform } = value as Partial<MatrixVoiceNote>

  if (typeof duration !== 'number' || !Number.isInteger(duration) ||
    duration < MATRIX_VOICE_MIN_MS || duration > MATRIX_VOICE_MAX_MS ||
    !Array.isArray(waveform) || waveform.length > MATRIX_VOICE_WAVEFORM_MAX ||
    !waveform.every(sample => Number.isInteger(sample) && sample >= 0 && sample <= 1024)) {
    return undefined
  }

  return { duration, waveform }
}

export function isMatrixOggOpus(bytes: Uint8Array): boolean {
  return bytes.length > 46 &&
    bytes[26] === 1 &&
    new TextDecoder().decode(bytes.subarray(0, 4)) === 'OggS' &&
    new TextDecoder().decode(bytes.subarray(28, 36)) === 'OpusHead'
}

/** Map links carry only coordinates. Altitude and uncertainty never become URL parameters. */
export function matrixGeoPoint(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 128) {
    return undefined
  }

  const match = /^(?:geo:)?(-?\d{1,3}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)(?:,-?\d+(?:\.\d+)?)?(?:;u=\d+(?:\.\d+)?)?$/iu.exec(value.trim())

  if (!match || Math.abs(Number(match[1])) > 90 || Math.abs(Number(match[2])) > 180) {
    return undefined
  }

  return `geo:${match[1]},${match[2]}`
}

export type MatrixPollCommand =
  | { kind: 'pollRead' | 'pollEnd'; roomId: string; eventId: string }
  | { kind: 'pollVote'; roomId: string; eventId: string; answers: string[] }
  | { kind: 'pollCreate'; roomId: string; question: string; options: string[]; undisclosed: boolean }
