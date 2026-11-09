import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { stopVoicePlayback } from '@/lib/voice-playback-engine'
import { $voicePlayback } from '@/store/voice-playback'

import type { MatrixUiBridge } from '../../shared/matrix'
import type { MatrixVoiceBridge } from '../../shared/matrix-voice'

import { MatrixReadAloud, MatrixVoiceDictation } from './voice'

const recorder = vi.hoisted(() => ({
  start: vi.fn(async (): Promise<void> => undefined),
  stop: vi.fn(),
  cancel: vi.fn()
}))

const draft = vi.hoisted(() => ({ text: 'existing', setText: vi.fn() }))
vi.mock('@/app/chat/composer/hooks/use-mic-recorder', () => ({
  useMicRecorder: () => ({ handle: recorder, level: 0, recording: false })
}))
vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({ composer: () => ({ setText: draft.setText }) }),
  useComposerRuntime: () => ({ getState: () => ({ text: draft.text }) })
}))

const created: TestAudio[] = []

class TestAudio extends EventTarget {
  src: string
  paused = false
  constructor(src: string) {
    super()
    this.src = src
    created.push(this)
  }
  play() {
    return Promise.resolve()
  }
  pause() {
    this.paused = true
  }
  load() {}
}

function fixture(overrides: Partial<MatrixVoiceBridge> = {}) {
  const bridge = {
    settings: vi.fn(async () => ({
      sttEnabled: true,
      sttProvider: 'local',
      ttsProvider: 'edge',
      maxRecordingSeconds: 120
    })),
    microphone: vi.fn(async () => true),
    transcribe: vi.fn(async () => 'dictated text'),
    speak: vi.fn(async () => ({ data_url: 'data:audio/mpeg;base64,AQID', mime_type: 'audio/mpeg' })),
    ...overrides
  }

  const command = vi.fn()
  window.atumMatrix = { voice: bridge, command } as unknown as MatrixUiBridge
  const fail = vi.fn()

  const view = (disabled = false) => (
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixVoiceDictation disabled={disabled} fail={fail} roomId="!room:test" />
    </I18nProvider>
  )

  return { bridge, command, fail, view }
}

beforeEach(() => {
  recorder.start.mockReset().mockResolvedValue(undefined)
  recorder.stop
    .mockReset()
    .mockResolvedValue({
      audio: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }),
      durationMs: 1000,
      heardSpeech: true
    })
  recorder.cancel.mockClear()
  draft.text = 'existing'
  draft.setText.mockClear()
  created.length = 0
  vi.stubGlobal('Audio', TestAudio)
})

afterEach(() => {
  cleanup()
  stopVoicePlayback()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe('Matrix explicit dictation', () => {
  it('captures only on click, reuses audio conversion and appends to the latest draft without sending', async () => {
    let resolve: (text: string) => void = () => undefined

    const transcribe = vi.fn(
      () =>
        new Promise<string>(done => {
          resolve = done
        })
    )

    const f = fixture({ transcribe })
    render(f.view())
    expect(recorder.start).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Voice dictation' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop dictation' }))
    await waitFor(() =>
      expect(transcribe).toHaveBeenCalledExactlyOnceWith('!room:test', 'data:audio/webm;base64,AQID', 'audio/webm')
    )
    draft.text = 'typed while transcribing'
    await act(async () => resolve('  dictated text  '))
    expect(draft.setText).toHaveBeenCalledExactlyOnceWith('typed while transcribing dictated text')
    expect(f.command).not.toHaveBeenCalled()
    expect(f.fail).not.toHaveBeenCalled()
    expect(f.bridge.microphone).toHaveBeenCalledExactlyOnceWith('!room:test')
  })

  it('preserves the draft on silence and gives localized feedback', async () => {
    const f = fixture({ transcribe: vi.fn(async () => '') })
    render(f.view())
    fireEvent.click(screen.getByRole('button', { name: 'Voice dictation' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop dictation' }))
    expect(await screen.findByText('No speech detected')).toBeTruthy()
    expect(draft.setText).not.toHaveBeenCalled()
  })

  it('does not request microphone access when effective STT is disabled', async () => {
    const f = fixture({
      settings: vi.fn(async () => ({
        sttEnabled: false,
        sttProvider: 'local',
        ttsProvider: 'edge',
        maxRecordingSeconds: 120
      }))
    })

    render(f.view())
    fireEvent.click(screen.getByRole('button', { name: 'Voice dictation' }))
    expect(await screen.findByText('Configure speech-to-text to use voice mode.')).toBeTruthy()
    expect(f.bridge.microphone).not.toHaveBeenCalled()
    expect(recorder.start).not.toHaveBeenCalled()
  })

  it('keeps the composer usable after native permission denial or provider failure', async () => {
    const f = fixture({ microphone: vi.fn(async () => false) })
    render(f.view())
    fireEvent.click(screen.getByRole('button', { name: 'Voice dictation' }))
    expect(await screen.findByText('Microphone access denied.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Voice dictation' }).hasAttribute('disabled')).toBe(false)
    expect(recorder.start).not.toHaveBeenCalled()
  })

  it('drops a late transcript after account/room unmount, with no draft write or late error', async () => {
    let resolve: (text: string) => void = () => undefined

    const transcribe = vi.fn(
      () =>
        new Promise<string>(done => {
          resolve = done
        })
    )

    const f = fixture({ transcribe })
    const result = render(f.view())
    fireEvent.click(screen.getByRole('button', { name: 'Voice dictation' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop dictation' }))
    await waitFor(() => expect(transcribe).toHaveBeenCalledOnce())
    result.unmount()
    await act(async () => resolve('stale transcript'))
    expect(draft.setText).not.toHaveBeenCalled()
    expect(f.fail).not.toHaveBeenCalled()
  })

  it('cancels again if getUserMedia/recorder start resolves after unmount', async () => {
    let resolve: () => void = () => undefined
    recorder.start.mockImplementationOnce(
      () =>
        new Promise<void>(done => {
          resolve = done
        })
    )
    const f = fixture()
    const result = render(f.view())
    fireEvent.click(screen.getByRole('button', { name: 'Voice dictation' }))
    await waitFor(() => expect(recorder.start).toHaveBeenCalledOnce())
    result.unmount()
    const cleanupCalls = recorder.cancel.mock.calls.length
    await act(async () => resolve())
    expect(recorder.cancel.mock.calls.length).toBe(cleanupCalls + 1)
    expect(f.bridge.transcribe).not.toHaveBeenCalled()
  })

  it('cancels capture when the composer becomes disabled and bounds configured capture duration', async () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout')

    const f = fixture({
      settings: vi.fn(async () => ({
        sttEnabled: true,
        sttProvider: 'local',
        ttsProvider: 'edge',
        maxRecordingSeconds: 600
      }))
    })

    const result = render(f.view())
    fireEvent.click(screen.getByRole('button', { name: 'Voice dictation' }))
    await screen.findByRole('button', { name: 'Stop dictation' })
    expect(timeout.mock.calls.some(([, milliseconds]) => milliseconds === 120_000)).toBe(true)
    result.rerender(f.view(true))
    expect(recorder.cancel).toHaveBeenCalled()
    expect(f.bridge.transcribe).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Voice dictation' }).hasAttribute('disabled')).toBe(true)
  })
})

describe('Matrix explicit read-aloud', () => {
  function read(overrides: Partial<MatrixVoiceBridge> = {}) {
    const f = fixture(overrides)

    const result = render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixReadAloud
          fail={f.fail}
          messageId="$message"
          roomId="!room:test"
          text="**Read** [this](https://example.test)"
        />
      </I18nProvider>
    )

    return { ...f, ...result }
  }

  it('uses sanitized text on the selected room route and permits immediate stop', async () => {
    const f = read()
    expect(f.bridge.speak).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
    await waitFor(() => expect(created).toHaveLength(1))
    expect(f.bridge.speak).toHaveBeenCalledExactlyOnceWith('!room:test', 'Read this')
    fireEvent.click(screen.getByRole('button', { name: 'Stop reading' }))
    expect(created[0]!.paused).toBe(true)
    expect(created[0]!.src).toBe('')
    expect($voicePlayback.get().status).toBe('idle')
  })

  it('cancels preparing audio without playing a late native result', async () => {
    let resolve: (value: { data_url: string; mime_type: string }) => void = () => undefined
    read({
      speak: vi.fn(
        () =>
          new Promise<{ data_url: string; mime_type: string }>(done => {
            resolve = done
          })
      )
    })
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stop reading' }))
    await act(async () => resolve({ data_url: 'data:audio/mpeg;base64,AQID', mime_type: 'audio/mpeg' }))
    expect(created).toHaveLength(0)
    expect($voicePlayback.get().status).toBe('idle')
  })

  it('stops and drops pending audio after owner/room unmount', async () => {
    let resolve: (value: { data_url: string; mime_type: string }) => void = () => undefined

    const f = read({
      speak: vi.fn(
        () =>
          new Promise<{ data_url: string; mime_type: string }>(done => {
            resolve = done
          })
      )
    })

    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
    f.unmount()
    await act(async () => resolve({ data_url: 'data:audio/mpeg;base64,AQID', mime_type: 'audio/mpeg' }))
    expect(created).toHaveLength(0)
    expect(f.fail).not.toHaveBeenCalled()
  })

  it('shows a localized failure without trying a legacy or alternate provider route', async () => {
    const f = read({
      speak: vi.fn(async () => {
        throw new Error('matrix_voice_failed')
      })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
    expect(await screen.findByText('Read aloud failed')).toBeTruthy()
    expect(created).toHaveLength(0)
    expect(f.fail).toHaveBeenCalledOnce()
    expect($voicePlayback.get().status).toBe('idle')
  })
})
