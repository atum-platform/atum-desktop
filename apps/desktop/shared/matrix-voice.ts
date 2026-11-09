/** Voice stays on the selected agent's existing owned Hermes backend. Neither
 * backend addresses, credentials, profile selectors nor raw config cross IPC. */
export const MATRIX_VOICE_IPC = {
  request: 'matrix:voice:request',
  microphone: 'matrix:voice:microphone'
} as const

export const MATRIX_VOICE_MAX_UPLOAD_BYTES = 4 * 1024 * 1024
export const MATRIX_VOICE_MAX_AUDIO_BYTES = 5 * 1024 * 1024
export const MATRIX_VOICE_MAX_TEXT = 4000
export const MATRIX_VOICE_MAX_RECORDING_SECONDS = 120

export interface MatrixVoiceSettings {
  sttEnabled: boolean
  sttProvider: string
  ttsProvider: string
  maxRecordingSeconds: number
}

export interface MatrixVoiceAudio {
  data_url: string
  mime_type: string
}

export type MatrixVoiceOperation =
  | { kind: 'settings' }
  | { kind: 'transcribe'; dataUrl: string; mimeType: string }
  | { kind: 'speak'; text: string }

export type MatrixVoiceRequest = MatrixVoiceOperation & { roomId: string }

export interface MatrixVoiceBridge {
  microphone(roomId: string): Promise<boolean>
  settings(roomId: string): Promise<MatrixVoiceSettings>
  transcribe(roomId: string, dataUrl: string, mimeType: string): Promise<string>
  speak(roomId: string, text: string): Promise<MatrixVoiceAudio>
}
