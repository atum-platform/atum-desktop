import { MATRIX_VOICE_MAX_RECORDING_SECONDS } from './matrix-voice'

/** Existing Hermes speech scalars only. No credentials, endpoints, commands,
 * files, automatic speech or CLI-only controls. Missing schema fields stay absent. */
export const MATRIX_VOICE_SETTING_RULES = {
  'stt.enabled': { type: 'boolean' },
  'stt.provider': { type: 'provider' },
  'tts.provider': { type: 'provider' },
  'voice.max_recording_seconds': { type: 'number', min: 1, max: MATRIX_VOICE_MAX_RECORDING_SECONDS, integer: true },
  'stt.local.model': { type: 'string' },
  'stt.local.language': { type: 'string' },
  'stt.openai.model': { type: 'string' },
  'stt.mistral.model': { type: 'string' },
  'stt.elevenlabs.model_id': { type: 'string' },
  'stt.elevenlabs.language_code': { type: 'string' },
  'stt.elevenlabs.tag_audio_events': { type: 'boolean' },
  'stt.elevenlabs.diarize': { type: 'boolean' },
  'stt.deepinfra.model': { type: 'string' },
  'tts.edge.voice': { type: 'string' },
  'tts.openai.model': { type: 'string' },
  'tts.openai.voice': { type: 'string' },
  'tts.elevenlabs.voice_id': { type: 'string' },
  'tts.elevenlabs.model_id': { type: 'string' },
  'tts.xai.voice_id': { type: 'string' },
  'tts.xai.language': { type: 'string' },
  'tts.xai.speed': { type: 'number', min: 0.7, max: 1.5 },
  'tts.xai.auto_speech_tags': { type: 'boolean' },
  'tts.xai.optimize_streaming_latency': { type: 'number', min: 0, max: 2, integer: true },
  'tts.xai.sample_rate': { type: 'number', integer: true, options: [22050, 24000, 44100, 48000] },
  'tts.xai.bit_rate': { type: 'number', min: 1, integer: true },
  'tts.minimax.model': { type: 'string' },
  'tts.minimax.voice_id': { type: 'string' },
  'tts.mistral.model': { type: 'string' },
  'tts.mistral.voice_id': { type: 'string' },
  'tts.gemini.model': { type: 'string' },
  'tts.gemini.voice': { type: 'string' },
  'tts.gemini.audio_tags': { type: 'boolean' },
  'tts.neutts.model': { type: 'string' },
  'tts.neutts.device': { type: 'string' },
  'tts.kittentts.model': { type: 'string' },
  'tts.kittentts.voice': { type: 'string' },
  'tts.piper.voice': { type: 'string' },
  'tts.deepinfra.model': { type: 'string' },
  'tts.deepinfra.voice': { type: 'string' }
} as const

export type MatrixVoiceSettingKey = keyof typeof MATRIX_VOICE_SETTING_RULES
export type MatrixVoiceSettingValue = string | number | boolean
export interface MatrixVoiceSettingField {
  key: MatrixVoiceSettingKey
  type: 'boolean' | 'number' | 'string' | 'select'
  value: MatrixVoiceSettingValue | null
  options?: (string | number)[]
  min?: number
  max?: number
  integer?: boolean
}
export interface MatrixVoiceSettingsSnapshot {
  fields: MatrixVoiceSettingField[]
}
export type MatrixVoiceSettingsWriteResult =
  | { status: 'applied'; field: MatrixVoiceSettingKey; value: MatrixVoiceSettingValue }
  | { status: 'cancelled' }
export interface MatrixVoiceSettingsClient {
  snapshot(): Promise<MatrixVoiceSettingsSnapshot>
  set(field: MatrixVoiceSettingKey, value: MatrixVoiceSettingValue): Promise<MatrixVoiceSettingsWriteResult>
}
export interface MatrixVoiceSettingsConfirmation {
  field: MatrixVoiceSettingKey
  value: MatrixVoiceSettingValue
}
