import { isMatrixOggOpus, MATRIX_VOICE_MIME } from '../../../shared/matrix-rich-content'

export async function matrixOggVoice(audio: Blob, context: AudioContext): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new Uint8Array(await audio.arrayBuffer())

  if (isMatrixOggOpus(bytes)) {
    return bytes
  }

  // Chromium can capture Opus in WebM but cannot mux Ogg via MediaRecorder.
  const decoded = await context.decodeAudioData(bytes.buffer)
  const { default: opus } = await import('@audio/encode-opus')
  const encoder = await opus({ sampleRate: decoded.sampleRate, channels: 1, bitrate: 48, application: 'voip' })

  try {
    const first = encoder.encode([decoded.getChannelData(0)])
    const last = encoder.flush()
    const output = new Uint8Array(first.length + last.length)
    output.set(first)
    output.set(last, first.length)

    if (!isMatrixOggOpus(output)) {
      throw new Error('matrix_voice_invalid')
    }

    return output
  } finally {
    encoder.free()
  }
}

export const MATRIX_VOICE_RECORDER_TYPES = [`${MATRIX_VOICE_MIME};codecs=opus`, 'audio/webm;codecs=opus']
