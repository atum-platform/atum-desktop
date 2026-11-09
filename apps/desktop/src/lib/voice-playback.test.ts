import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $voicePlayback } from '@/store/voice-playback'

import { playSpeechText as playLegacySpeechText } from './voice-playback'
import { playSpeechText, stopVoicePlayback } from './voice-playback-engine'

const legacySpeak = vi.hoisted(() => vi.fn(async () => ({ data_url: 'data:audio/mpeg;base64,AQID' })))
vi.mock('@/hermes', () => ({ speakText: legacySpeak }))

const created: TestAudio[] = []

class TestAudio extends EventTarget {
  src: string
  paused = false
  constructor(src: string) {
    super()
    this.src = src
    created.push(this)
  }
  pause() {
    this.paused = true
  }
  load() {}
  play() {
    queueMicrotask(() => this.dispatchEvent(new Event('ended')))

    return Promise.resolve()
  }
}

beforeEach(() => {
  created.length = 0
  legacySpeak.mockClear()
  vi.stubGlobal('Audio', TestAudio)
  Reflect.deleteProperty(window, 'hermesDesktop')
})

afterEach(() => {
  stopVoicePlayback()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'hermesDesktop')
})

describe('owned synthesis through the existing playback engine', () => {
  it('uses only the injected native route, never legacy REST/auth/stream URL resolution', async () => {
    const getConnection = vi.fn()
    window.hermesDesktop = { getConnection } as unknown as typeof window.hermesDesktop
    const synthesize = vi.fn(async () => ({ data_url: 'data:audio/wav;base64,AQID' }))

    expect(
      await playSpeechText(
        '**Read** [this](https://example.test)',
        { source: 'read-aloud', messageId: 'owned' },
        { synthesize }
      )
    ).toBe(true)
    expect(synthesize).toHaveBeenCalledExactlyOnceWith('Read this')
    expect(getConnection).not.toHaveBeenCalled()
    expect(legacySpeak).not.toHaveBeenCalled()
    expect(created.map(audio => audio.src)).toEqual(['data:audio/wav;base64,AQID'])
    expect($voicePlayback.get().status).toBe('idle')
  })

  it('preserves the default legacy synthesis path when no adapter is supplied', async () => {
    expect(await playLegacySpeechText('**Legacy** reply', { source: 'read-aloud', messageId: 'legacy' })).toBe(true)
    expect(legacySpeak).toHaveBeenCalledExactlyOnceWith('Legacy reply')
    expect(created).toHaveLength(1)
  })

  it('never starts late synthesized audio after synchronous cancellation or retirement', async () => {
    let resolve: (value: { data_url: string }) => void = () => undefined

    const synthesize = vi.fn(
      () =>
        new Promise<{ data_url: string }>(done => {
          resolve = done
        })
    )

    const pending = playSpeechText('owned reply', { source: 'read-aloud', messageId: 'old' }, { synthesize })
    expect($voicePlayback.get().status).toBe('preparing')
    stopVoicePlayback()
    resolve({ data_url: 'data:audio/mpeg;base64,AQID' })
    expect(await pending).toBe(false)
    expect(created).toHaveLength(0)
    expect($voicePlayback.get().status).toBe('idle')
  })

  it('leaves newer playback untouched when an older native request finishes late', async () => {
    let resolve: (value: { data_url: string }) => void = () => undefined

    const pending = playSpeechText(
      'old',
      { source: 'read-aloud', messageId: 'old' },
      {
        synthesize: () =>
          new Promise(done => {
            resolve = done
          })
      }
    )

    const newer = playSpeechText(
      'new',
      { source: 'read-aloud', messageId: 'new' },
      {
        synthesize: async () => ({ data_url: 'data:audio/mpeg;base64,AQID' })
      }
    )

    await newer
    resolve({ data_url: 'data:audio/mpeg;base64,BAUG' })
    expect(await pending).toBe(false)
    expect(created).toHaveLength(1)
    expect(legacySpeak).not.toHaveBeenCalled()
  })

  it('does not fall back to a different agent after a native synthesis failure', async () => {
    await expect(
      playSpeechText(
        'read',
        { source: 'read-aloud', messageId: 'owned' },
        {
          synthesize: async () => {
            throw new Error('matrix_voice_failed')
          }
        }
      )
    ).rejects.toThrow('matrix_voice_failed')
    expect(legacySpeak).not.toHaveBeenCalled()
    expect(created).toHaveLength(0)
    expect($voicePlayback.get().status).toBe('idle')
  })
})
