import {
  MATRIX_VOICE_MAX_AUDIO_BYTES,
  MATRIX_VOICE_MAX_RECORDING_SECONDS,
  MATRIX_VOICE_MAX_TEXT,
  MATRIX_VOICE_MAX_UPLOAD_BYTES,
  type MatrixVoiceAudio,
  type MatrixVoiceOperation,
  type MatrixVoiceRequest,
  type MatrixVoiceSettings
} from '../../shared/matrix-voice'

import type { MatrixPagesForwardRequest } from './pages-bridge'

const MIME_TYPES = new Set([
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/mp4',
  'audio/ogg',
  'audio/ogg;codecs=opus',
  'audio/wav',
  'audio/mpeg',
  'audio/flac'
])

function invalid(): never {
  throw new Error('matrix_voice_invalid')
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\p{Cc}]/u.test(value)
}

function audio(value: unknown, mime: unknown, maximum: number): value is string {
  if (typeof value !== 'string' || typeof mime !== 'string' || !MIME_TYPES.has(mime)) {
    return false
  }

  const prefix = `data:${mime};base64,`

  if (!value.startsWith(prefix) || value.length > prefix.length + 4 * Math.ceil(maximum / 3)) {
    return false
  }

  const encoded = value.slice(prefix.length)

  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    return false
  }

  const bytes = Buffer.from(encoded, 'base64')

  return bytes.length > 0 && bytes.length <= maximum && bytes.toString('base64') === encoded
}

function operation(value: unknown, includeRoom: boolean): MatrixVoiceOperation {
  if (!object(value) || (includeRoom && (!identifier(value.roomId) || !value.roomId.startsWith('!')))) {
    return invalid()
  }

  const scope = includeRoom ? ['roomId'] : []

  if (value.kind === 'settings' && exact(value, [...scope, 'kind'])) {
    return { kind: 'settings' }
  }

  if (
    value.kind === 'transcribe' &&
    exact(value, [...scope, 'kind', 'dataUrl', 'mimeType']) &&
    audio(value.dataUrl, value.mimeType, MATRIX_VOICE_MAX_UPLOAD_BYTES)
  ) {
    return { kind: 'transcribe', dataUrl: value.dataUrl, mimeType: value.mimeType as string }
  }

  if (
    value.kind === 'speak' &&
    exact(value, [...scope, 'kind', 'text']) &&
    typeof value.text === 'string' &&
    value.text.trim().length > 0 &&
    value.text.length <= MATRIX_VOICE_MAX_TEXT &&
    !/\p{Cc}/u.test(value.text.replace(/[\n\r\t]/g, ''))
  ) {
    return { kind: 'speak', text: value.text.trim() }
  }

  return invalid()
}

/** Root validates the wire before resolving custody or starting a backend. */
export function parseMatrixVoiceRequest(value: unknown): MatrixVoiceRequest {
  const parsed = operation(value, true)

  return { ...parsed, roomId: (value as { roomId: string }).roomId }
}

/** Apply only after the root verifies exact UI main-frame custody and a
 * current user-triggered microphone grant. This first slice requires explicit
 * audio metadata; unknown/empty metadata never grants a camera capability. */
export function matrixVoiceAudioPermission(
  permission: string,
  details?: { mediaTypes?: unknown; mediaType?: unknown }
): boolean {
  if (permission !== 'media' && permission !== 'audioCapture') {
    return false
  }

  if (details?.mediaType === 'video') {
    return false
  }

  const types = details?.mediaTypes

  if (Array.isArray(types) && types.length > 0) {
    return types.every(type => type === 'audio')
  }

  return details?.mediaType === 'audio'
}

export interface MatrixVoiceScopeDeps {
  /** Captured account generation, room/agent identity and exact executor. */
  isCurrent(): boolean
  /** The selected owned executor's existing native-only pages transport. */
  forward(request: MatrixPagesForwardRequest): Promise<unknown>
}

/** A narrow adapter, not a voice service: Hermes owns STT/TTS/config/provider
 * resolution. These routes are safe only on its separate per-agent process. */
export class MatrixVoiceScope {
  constructor(private readonly deps: MatrixVoiceScopeDeps) {}

  private current(): void {
    if (!this.deps.isCurrent()) {
      throw new Error('matrix_voice_unavailable')
    }
  }

  private async forward(request: MatrixPagesForwardRequest): Promise<unknown> {
    this.current()

    let result: unknown

    try {
      result = await this.deps.forward(request)
    } catch {
      this.current()
      // Provider messages can contain paths, keys or command configuration.
      throw new Error('matrix_voice_failed')
    }

    this.current()

    return result
  }

  async settings(): Promise<MatrixVoiceSettings> {
    const result = await this.forward({ path: '/api/config?profile=default', method: 'GET' })

    if (
      !object(result) ||
      !object(result.stt) ||
      !object(result.tts) ||
      typeof result.stt.enabled !== 'boolean' ||
      !identifier(result.stt.provider) ||
      !identifier(result.tts.provider)
    ) {
      throw new Error('matrix_voice_response_invalid')
    }

    const configured = object(result.voice) ? result.voice.max_recording_seconds : undefined

    const seconds =
      typeof configured === 'number' && Number.isFinite(configured) && configured > 0 ? Math.trunc(configured) : 120

    return {
      sttEnabled: result.stt.enabled,
      sttProvider: result.stt.provider,
      ttsProvider: result.tts.provider,
      maxRecordingSeconds: Math.max(1, Math.min(MATRIX_VOICE_MAX_RECORDING_SECONDS, seconds))
    }
  }

  async transcribe(dataUrl: string, mimeType: string): Promise<string> {
    const parsed = operation({ kind: 'transcribe', dataUrl, mimeType }, false)

    if (parsed.kind !== 'transcribe') {
      return invalid()
    }

    const settings = await this.settings()

    if (!settings.sttEnabled) {
      throw new Error('matrix_voice_disabled')
    }

    const result = await this.forward({
      path: '/api/audio/transcribe?profile=default',
      method: 'POST',
      body: { data_url: parsed.dataUrl, mime_type: parsed.mimeType }
    })

    if (
      !object(result) ||
      result.ok !== true ||
      typeof result.transcript !== 'string' ||
      result.transcript.length > 32_768
    ) {
      throw new Error('matrix_voice_response_invalid')
    }

    return result.transcript.trim()
  }

  async speak(text: string): Promise<MatrixVoiceAudio> {
    const parsed = operation({ kind: 'speak', text }, false)

    if (parsed.kind !== 'speak') {
      return invalid()
    }

    const result = await this.forward({
      path: '/api/audio/speak?profile=default',
      method: 'POST',
      body: { text: parsed.text }
    })

    if (
      !object(result) ||
      result.ok !== true ||
      !audio(result.data_url, result.mime_type, MATRIX_VOICE_MAX_AUDIO_BYTES)
    ) {
      throw new Error('matrix_voice_response_invalid')
    }

    return { data_url: result.data_url, mime_type: result.mime_type as string }
  }

  request(request: MatrixVoiceOperation): Promise<MatrixVoiceSettings | MatrixVoiceAudio | string> {
    const parsed = operation(request, false)

    if (parsed.kind === 'settings') {
      return this.settings()
    }

    return parsed.kind === 'transcribe' ? this.transcribe(parsed.dataUrl, parsed.mimeType) : this.speak(parsed.text)
  }
}
