import { useCallback, useEffect, useRef, useState } from 'react'

import { ArrowUp, AudioLines, Square, Trash2 } from '@/lib/icons'

import { MATRIX_VOICE_MIME } from '../../../shared/matrix-rich-content'
import { runMatrixCommand } from '../text-document-actions'

import { MatrixVoicePlayer, voiceTime, VoiceWaveform } from './player'
import { type MatrixVoiceRecording, startMatrixVoiceRecording } from './recording'

type RecordingResult = NonNullable<Awaited<MatrixVoiceRecording['result']>>

type State =
  | { kind: 'idle' | 'starting' | 'recording' | 'finishing' }
  | { kind: 'error'; message: string }
  | { kind: 'review' | 'sending'; recording: RecordingResult; error?: string }

export function useMatrixVoiceNote(roomId: string, onSent?: () => void) {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const current = useRef<MatrixVoiceRecording | null>(null)
  const generation = useRef(0)

  const discardRecording = useCallback(() => {
    generation.current++
    current.current?.cancel()
    current.current = null
  }, [])

  useEffect(() => discardRecording, [discardRecording])

  const cancel = () => {
    discardRecording()
    setState({ kind: 'idle' })
  }

  const start = async () => {
    const id = ++generation.current
    setState({ kind: 'starting' })

    try {
      if (!await window.atumMatrix.voice?.microphone(roomId, 'voiceNote')) {
        if (id === generation.current) {
          setState({ kind: 'error', message: 'Allow microphone access in System Settings, then try again.' })
        }

        return
      }

      if (id !== generation.current) {
        return
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })

      if (id !== generation.current) {
        stream.getTracks().forEach(track => track.stop())

        return
      }

      let recording: MatrixVoiceRecording

      try {
        recording = startMatrixVoiceRecording(stream)
      } catch (error) {
        stream.getTracks().forEach(track => track.stop())
        throw error
      }

      current.current = recording
      setState({ kind: 'recording' })
      const result = await recording.result

      if (id === generation.current) {
        current.current = null
        setState(result
          ? { kind: 'review', recording: result }
          : { kind: 'error', message: 'Record for at least half a second.' })
      }
    } catch (error) {
      if (id === generation.current) {
        current.current = null
        setState({
          kind: 'error',
          message: error instanceof DOMException && error.name === 'NotAllowedError'
            ? 'Allow microphone access in System Settings, then try again.'
            : 'Could not record. Try again.'
        })
      }
    }
  }

  const stop = () => {
    setState({ kind: 'finishing' })
    current.current?.stop()
  }

  const send = async () => {
    if (state.kind !== 'review') {
      return
    }

    const id = generation.current
    const { bytes, duration, waveform } = state.recording
    setState({ kind: 'sending', recording: state.recording })

    try {
      await runMatrixCommand({
        kind: 'attach',
        roomId,
        name: 'Voice note.ogg',
        bytes,
        voiceNote: { duration, waveform }
      })

      if (id === generation.current) {
        setState({ kind: 'idle' })
        onSent?.()
      }
    } catch {
      if (id === generation.current) {
        setState({ kind: 'review', recording: state.recording, error: 'Could not send. Try again.' })
      }
    }
  }

  const peaks = useCallback(() => current.current?.peaks() ?? [], [])

  return { state, start, stop, cancel, send, peaks }
}

export function MatrixVoiceStart({ start }: { start(): void }) {
  return (
    <button aria-label="Record voice note" className="atum-composer-send" onClick={start} type="button">
      <AudioLines aria-hidden className="size-4" />
    </button>
  )
}

export function MatrixVoiceLedge({ voice, disabled }: { voice: ReturnType<typeof useMatrixVoiceNote>; disabled: boolean }) {
  const { state, start, stop, cancel, send, peaks } = voice
  const [meter, setMeter] = useState<{ elapsed: number; waveform: number[] }>({ elapsed: 0, waveform: [] })

  useEffect(() => {
    if (state.kind !== 'recording') {
      return
    }

    const began = performance.now()
    const timer = setInterval(() => setMeter({ elapsed: performance.now() - began, waveform: peaks() }), 120)

    return () => clearInterval(timer)
  }, [peaks, state.kind])

  const review = state.kind === 'review' || state.kind === 'sending' ? state : undefined
  const error = state.kind === 'error' ? state.message : review?.error

  return (
    <div className="flex items-center gap-2" data-matrix-voice-ledge>
      <button
        aria-label="Discard voice note"
        className="atum-icon-btn grid size-8 shrink-0 place-items-center"
        disabled={state.kind === 'sending'}
        onClick={cancel}
        type="button"
      >
        <Trash2 aria-hidden className="size-4" />
      </button>
      {review ? (
        <MatrixVoicePlayer
          duration={review.recording.duration}
          load={async () => new Blob([review.recording.bytes], { type: MATRIX_VOICE_MIME })}
          waveform={review.recording.waveform}
        />
      ) : state.kind === 'recording' ? (
        <>
          <span aria-hidden className="size-2 rounded-full bg-red-500" />
          <span className="text-xs tabular-nums">{voiceTime(meter.elapsed)}</span>
          <VoiceWaveform waveform={meter.waveform} />
        </>
      ) : (
        <span className="flex-1 text-sm" role="status">{error ?? (state.kind === 'starting' ? 'Starting microphone…' : 'Preparing voice note…')}</span>
      )}
      {review && error && <span className="text-xs" role="status">{error}</span>}
      {state.kind === 'error' && !disabled && <MatrixVoiceStart start={() => void start()} />}
      {state.kind === 'recording' && (
        <button aria-label="Stop recording" className="atum-composer-send" onClick={stop} type="button">
          <Square aria-hidden className="size-4" />
        </button>
      )}
      {review && (
        <button
          aria-label="Send voice note"
          className="atum-composer-send"
          disabled={disabled || state.kind === 'sending'}
          onClick={() => void send()}
          type="button"
        >
          <ArrowUp aria-hidden className="size-4" />
        </button>
      )}
    </div>
  )
}
