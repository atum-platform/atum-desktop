import { MATRIX_VOICE_MAX_MS, MATRIX_VOICE_MIN_MS, MATRIX_VOICE_WAVEFORM_MAX } from '../../../shared/matrix-rich-content'

import { MATRIX_VOICE_RECORDER_TYPES, matrixOggVoice } from './format'

export interface MatrixVoiceRecording {
  stop(): void
  cancel(): void
  peaks(): number[]
  result: Promise<{ bytes: Uint8Array<ArrayBuffer>; duration: number; waveform: number[] } | null>
}

export function startMatrixVoiceRecording(stream: MediaStream): MatrixVoiceRecording {
  const type = MATRIX_VOICE_RECORDER_TYPES.find(mime => MediaRecorder.isTypeSupported(mime))
  const recorder = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 48_000 })
  const context = new AudioContext()
  const analyser = context.createAnalyser()
  const samples = new Uint8Array(analyser.fftSize)
  const levels: number[] = []
  const chunks: Blob[] = []
  const startedAt = performance.now()
  let duration = 0
  let cancelled = false

  const stop = () => {
    if (recorder.state !== 'inactive') {
      duration = Math.min(Math.round(performance.now() - startedAt), MATRIX_VOICE_MAX_MS)
      recorder.stop()
      stream.getTracks().forEach(track => track.stop())
    }
  }

  const source = context.createMediaStreamSource(stream)
  source.connect(analyser)
  void context.resume().catch(() => {})

  const sample = setInterval(() => {
    analyser.getByteTimeDomainData(samples)
    let peak = 0

    for (const value of samples) {
      peak = Math.max(peak, Math.abs(value - 128))
    }

    levels.push(peak * 8)
  }, 80)

  const deadline = setTimeout(stop, MATRIX_VOICE_MAX_MS)

  const release = () => {
    clearInterval(sample)
    clearTimeout(deadline)
    stream.getTracks().forEach(track => track.stop())
    source.disconnect()
    void context.close().catch(() => {})
  }

  try {
    recorder.start()
  } catch (error) {
    release()
    throw error
  }

  const result = new Promise<Awaited<MatrixVoiceRecording['result']>>((resolve, reject) => {
    recorder.ondataavailable = event => chunks.push(event.data)

    recorder.onerror = () => {
      cancelled = true
      release()
      reject(new Error('matrix_voice_invalid'))
    }

    recorder.onstop = () => {
      stream.getTracks().forEach(track => track.stop())
      clearInterval(sample)
      clearTimeout(deadline)

      if (cancelled || duration < MATRIX_VOICE_MIN_MS) {
        release()
        resolve(null)

        return
      }

      const count = Math.min(levels.length, MATRIX_VOICE_WAVEFORM_MAX)

      const waveform = Array.from({ length: count }, (_, index) =>
        Math.max(...levels.slice(Math.floor(index * levels.length / count), Math.floor((index + 1) * levels.length / count)))
      )

      void matrixOggVoice(new Blob(chunks, { type: recorder.mimeType }), context).then(
        bytes => resolve(cancelled ? null : { bytes, duration, waveform }),
        reject
      ).finally(release)
    }
  })

  return {
    result,
    stop,
    peaks: () => levels.slice(-30),
    cancel: () => {
      cancelled = true
      stop()
    }
  }
}
