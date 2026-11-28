import { useEffect, useRef, useState } from 'react'

import { Pause, Play } from '@/lib/icons'

export function voiceTime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000)

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function VoiceWaveform({ waveform, progress = 0 }: { waveform: number[]; progress?: number }) {
  const bars = Array.from({ length: 30 }, (_, index) =>
    waveform[Math.floor(index * waveform.length / 30)] ?? 0
  )

  return (
    <span aria-hidden className="flex h-7 flex-1 items-center gap-0.5">
      {bars.map((peak, index) => (
        <span
          className="min-w-0 flex-1 rounded-full bg-current"
          key={index}
          style={{ height: `${Math.max(2, peak / 45)}px`, opacity: index / bars.length < progress ? 0.9 : 0.32 }}
        />
      ))}
    </span>
  )
}

export function MatrixVoicePlayer({ load, duration, waveform }: {
  load(): Promise<Blob>
  duration?: number
  waveform: number[]
}) {
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [position, setPosition] = useState(0)
  const [length, setLength] = useState(duration === undefined ? 0 : duration / 1000)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const element = audio.current

    return () => {
      if (element?.src) {
        element.pause()
        URL.revokeObjectURL(element.src)
        element.removeAttribute('src')
      }
    }
  }, [])

  const toggle = async () => {
    const element = audio.current

    if (!element || busy) {
      return
    }

    if (!element.paused) {
      element.pause()

      return
    }

    setBusy(true)
    setFailed(false)

    try {
      if (!element.src) {
        const blob = await load()

        if (audio.current !== element) {
          return
        }

        element.src = URL.createObjectURL(blob)
      }

      await element.play()
    } catch {
      if (element.src) {
        URL.revokeObjectURL(element.src)
        element.removeAttribute('src')
      }

      setLoaded(false)
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const Icon = playing ? Pause : Play

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <button
        aria-label={playing ? 'Pause voice note' : 'Play voice note'}
        className="atum-icon-btn grid size-8 shrink-0 place-items-center"
        disabled={busy}
        onClick={() => void toggle()}
        type="button"
      >
        <Icon aria-hidden className="size-4" />
      </button>
      <div className="relative flex min-w-20 flex-1 focus-within:ring-1">
        <VoiceWaveform progress={length ? position / length : 0} waveform={waveform} />
        <input
          aria-label="Voice note playback position"
          className="absolute inset-0 m-0 w-full cursor-pointer opacity-0"
          disabled={!loaded || !length}
          max={length}
          min={0}
          onChange={event => {
            const element = audio.current

            if (element) {
              element.currentTime = Number(event.currentTarget.value)
              setPosition(element.currentTime)
            }
          }}
          step="0.1"
          type="range"
          value={position}
        />
      </div>
      <span className="shrink-0 text-xs tabular-nums" role={failed ? 'status' : undefined}>
        {failed ? 'Could not play. Try again.' : voiceTime((playing ? position : length) * 1000)}
      </span>
      <audio
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={event => {
          setLoaded(true)

          if (Number.isFinite(event.currentTarget.duration)) {
            setLength(event.currentTarget.duration)
          }
        }}
        onPause={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
        onTimeUpdate={event => setPosition(event.currentTarget.currentTime)}
        ref={audio}
      />
    </div>
  )
}
