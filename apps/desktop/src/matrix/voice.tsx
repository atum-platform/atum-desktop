import { useAui, useComposerRuntime } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { useMicRecorder } from '@/app/chat/composer/hooks/use-mic-recorder'
import { VoiceActivity } from '@/app/chat/composer/voice-activity'
import { blobToDataUrl } from '@/app/session/hooks/use-prompt-actions/utils'
import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { AudioLines, Loader2, Mic, Square, VolumeX } from '@/lib/icons'
import { playSpeechText, stopVoicePlayback } from '@/lib/voice-playback-engine'
import { $voicePlayback } from '@/store/voice-playback'

import { MATRIX_VOICE_MAX_RECORDING_SECONDS, MATRIX_VOICE_MAX_UPLOAD_BYTES } from '../../shared/matrix-voice'

type Phase = 'idle' | 'starting' | 'recording' | 'transcribing'

export interface MatrixVoiceDictationProps {
  roomId: string
  disabled: boolean
  fail(): void
}

/** Explicit capture only. Transcription appends to the current draft and never
 * sends a Matrix event or starts an agent turn. The parent keys by owner/room. */
export function MatrixVoiceDictation({ roomId, disabled, fail }: MatrixVoiceDictationProps) {
  const { t } = useI18n()
  const copy = t.notifications.voice
  const aui = useAui()
  const composer = useComposerRuntime()
  const { handle, level } = useMicRecorder(copy)
  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [notice, setNotice] = useState('')
  const phaseRef = useRef<Phase>('idle')
  const epoch = useRef(0)
  const mounted = useRef(true)
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const interval = useRef<ReturnType<typeof setInterval> | null>(null)
  const stopRef = useRef<() => Promise<void>>(async () => undefined)

  const clearTimers = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
    }

    if (interval.current !== null) {
      clearInterval(interval.current)
    }

    timer.current = null
    interval.current = null
  }

  const transition = (next: Phase) => {
    phaseRef.current = next
    setPhase(next)
  }

  const phaseIs = (expected: Phase) => phaseRef.current === expected

  const invalidate = () => {
    ++epoch.current
  }

  const current = (ownEpoch: number) => mounted.current && epoch.current === ownEpoch && !disabledRef.current

  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
      invalidate()
      clearTimers()
      handle.cancel()
    }
    // The recorder's handle is a view over stable refs, not lifecycle identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId])

  useEffect(() => {
    if (disabled) {
      ++epoch.current
      clearTimers()
      handle.cancel()
      transition('idle')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled])

  const stop = async () => {
    if (!phaseIs('recording')) {
      return
    }

    const ownEpoch = epoch.current
    clearTimers()
    transition('transcribing')

    try {
      const recording = await handle.stop()

      if (!current(ownEpoch) || !recording) {
        return
      }

      if (recording.audio.size > MATRIX_VOICE_MAX_UPLOAD_BYTES) {
        throw new Error('matrix_voice_invalid')
      }

      const dataUrl = await blobToDataUrl(recording.audio)

      if (!current(ownEpoch)) {
        return
      }

      const transcript = (await window.atumMatrix.voice!.transcribe(roomId, dataUrl, recording.audio.type)).trim()

      if (!current(ownEpoch)) {
        return
      }

      if (transcript) {
        // Read at delivery: typing during STT must not be overwritten by the
        // draft that existed when capture started.
        const draft = composer.getState().text
        aui.composer().setText(`${draft}${draft && !/\s$/.test(draft) ? ' ' : ''}${transcript}`)
      } else {
        setNotice(copy.noSpeechDetected)
      }
    } catch {
      if (current(ownEpoch)) {
        setNotice(copy.transcriptionFailed)
        fail()
      }
    } finally {
      if (current(ownEpoch)) {
        transition('idle')
      }
    }
  }

  stopRef.current = stop

  const start = async () => {
    if (disabledRef.current || !phaseIs('idle') || !window.atumMatrix.voice) {
      return
    }

    const ownEpoch = ++epoch.current
    const bridge = window.atumMatrix.voice
    setNotice('')
    transition('starting')

    try {
      const settings = await bridge.settings(roomId)

      if (!current(ownEpoch)) {
        return
      }

      if (!settings.sttEnabled) {
        setNotice(copy.configureSpeechToText)

        return
      }

      const permitted = await bridge.microphone(roomId)

      if (!current(ownEpoch)) {
        return
      }

      if (!permitted) {
        setNotice(copy.microphoneAccessDenied)

        return
      }

      stopVoicePlayback()
      await handle.start({
        onError: () => {
          if (current(ownEpoch)) {
            ++epoch.current
            clearTimers()
            setNotice(copy.recordingFailed)
            transition('idle')
            fail()
          }
        }
      })

      // getUserMedia can finish after unmount/permission/context retirement.
      // The reused recorder does not own Matrix identity, so cancel again here.
      if (!current(ownEpoch)) {
        handle.cancel()

        return
      }

      transition('recording')
      setElapsedSeconds(0)
      const started = Date.now()
      interval.current = setInterval(() => setElapsedSeconds((Date.now() - started) / 1000), 250)
      const seconds = Math.max(1, Math.min(MATRIX_VOICE_MAX_RECORDING_SECONDS, settings.maxRecordingSeconds))
      timer.current = setTimeout(() => void stopRef.current(), seconds * 1000)
    } catch {
      if (current(ownEpoch)) {
        clearTimers()
        handle.cancel()
        setNotice(copy.recordingFailed)
        fail()
      }
    } finally {
      if (current(ownEpoch) && phaseIs('starting')) {
        transition('idle')
      }
    }
  }

  const recording = phase === 'recording'
  const pending = phase === 'starting' || phase === 'transcribing'

  const label = recording
    ? t.composer.stopDictation
    : pending
      ? t.composer.transcribingDictation
      : t.composer.voiceDictation

  const Icon = recording ? Square : pending ? Loader2 : Mic

  return (
    <div className="flex min-w-0 flex-col gap-1" data-matrix-voice-dictation>
      <Tip label={label}>
        <Button
          aria-label={label}
          disabled={disabled || pending}
          onClick={() => void (recording ? stop() : start())}
          size="icon"
          type="button"
          variant="ghost"
        >
          <Icon aria-hidden className={pending ? 'animate-spin' : undefined} />
        </Button>
      </Tip>
      {(recording || phase === 'transcribing') && (
        <VoiceActivity state={{ elapsedSeconds, level, status: recording ? 'recording' : 'transcribing' }} />
      )}
      {notice && (
        <NoticeBand role="status" tone="notice">
          {notice}
        </NoticeBand>
      )}
    </div>
  )
}

export interface MatrixReadAloudProps {
  roomId: string
  messageId: string
  text: string
  fail(): void
}

/** Reuses the one global playback owner but injects the exact native-owned
 * agent synthesis route, so no legacy active-profile lookup can run. This is the state and the
 * action; the button below and a message's "…" menu are two faces of it. Whoever uses it must
 * stay mounted while the audio plays (a closed menu does not): unmounting stops the audio. */
export function useMatrixReadAloud({ roomId, messageId, text, fail }: MatrixReadAloudProps) {
  const { t } = useI18n()
  const copy = t.assistant.thread
  const playback = useStore($voicePlayback)
  const [failed, setFailed] = useState(false)
  const mounted = useRef(true)
  const playbackId = `${roomId}:${messageId}`
  const owned = playback.source === 'read-aloud' && playback.messageId === playbackId && playback.status !== 'idle'
  const preparing = owned && playback.status === 'preparing'
  const label = owned ? copy.stopReading : copy.readAloud
  const Icon = preparing ? Loader2 : owned ? VolumeX : AudioLines

  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false

      if ($voicePlayback.get().messageId === playbackId) {
        stopVoicePlayback()
      }
    }
  }, [playbackId])

  const read = async () => {
    if (owned) {
      stopVoicePlayback()

      return
    }

    const bridge = window.atumMatrix.voice

    if (!bridge || $voicePlayback.get().status !== 'idle') {
      return
    }

    setFailed(false)

    try {
      await playSpeechText(
        text,
        { messageId: playbackId, source: 'read-aloud' },
        {
          synthesize: speech => bridge.speak(roomId, speech)
        }
      )
    } catch {
      if (mounted.current) {
        setFailed(true)
        fail()
      }
    }
  }

  return {
    Icon,
    available: Boolean(window.atumMatrix.voice),
    busy: !owned && playback.status !== 'idle',
    failed,
    failedLabel: copy.readAloudFailed,
    label,
    owned,
    preparing,
    preparingLabel: copy.preparingAudio,
    read: () => void read()
  }
}

export function MatrixReadAloud(props: MatrixReadAloudProps) {
  const reading = useMatrixReadAloud(props)
  const { Icon } = reading

  if (!reading.available) {
    return null
  }

  return (
    <div className="flex items-center gap-2" data-matrix-read-aloud data-reading={reading.owned || undefined}>
      <Tip label={reading.preparing ? reading.preparingLabel : reading.label}>
        <Button
          aria-label={reading.label}
          disabled={reading.busy}
          onClick={reading.read}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <Icon aria-hidden className={reading.preparing ? 'animate-spin' : undefined} />
        </Button>
      </Tip>
      {reading.failed && (
        <NoticeBand role="status" tone="failure">
          {reading.failedLabel}
        </NoticeBand>
      )}
    </div>
  )
}
