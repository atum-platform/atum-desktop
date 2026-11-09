import { afterEach, describe, expect, it, vi } from 'vitest'

import { MATRIX_VOICE_MAX_AUDIO_BYTES, MATRIX_VOICE_MAX_UPLOAD_BYTES } from '../../shared/matrix-voice'

import { createHermesPagesTransport } from './hermes-pages-transport'
import type { MatrixPagesForwardRequest } from './pages-bridge'
import { matrixVoiceAudioPermission, MatrixVoiceScope, parseMatrixVoiceRequest } from './voice'

const config = {
  stt: { enabled: true, provider: 'local', secret: 'must-not-cross' },
  tts: { provider: 'edge', edge: { voice: 'en-US-AriaNeural' } },
  voice: { max_recording_seconds: 120 },
  model: { api_key: 'must-not-cross' }
}

const clip = 'data:audio/webm;base64,AQID'
const synthesized = { ok: true, data_url: 'data:audio/mpeg;base64,AQID', mime_type: 'audio/mpeg', provider: 'private' }

function fixture() {
  let current = true

  const forward = vi.fn(async (request: MatrixPagesForwardRequest): Promise<unknown> => {
    if (request.path.startsWith('/api/config?')) {
      return config
    }

    if (request.path.startsWith('/api/audio/transcribe?')) {
      return { ok: true, transcript: '  dictated text  ', provider: 'private' }
    }

    return synthesized
  })

  const scope = new MatrixVoiceScope({ isCurrent: () => current, forward })

  return {
    scope,
    forward,
    retire: () => {
      current = false
    }
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('owned Matrix voice', () => {
  it('reuses only exact Hermes routes and returns only presentation data', async () => {
    const f = fixture()
    expect(await f.scope.settings()).toEqual({
      sttEnabled: true,
      sttProvider: 'local',
      ttsProvider: 'edge',
      maxRecordingSeconds: 120
    })
    expect(await f.scope.transcribe(clip, 'audio/webm')).toBe('dictated text')
    expect(await f.scope.speak('read this')).toEqual({
      data_url: synthesized.data_url,
      mime_type: synthesized.mime_type
    })
    expect(f.forward.mock.calls.map(([request]) => request)).toEqual([
      { path: '/api/config?profile=default', method: 'GET' },
      { path: '/api/config?profile=default', method: 'GET' },
      {
        path: '/api/audio/transcribe?profile=default',
        method: 'POST',
        body: { data_url: clip, mime_type: 'audio/webm' }
      },
      { path: '/api/audio/speak?profile=default', method: 'POST', body: { text: 'read this' } }
    ])
  })

  it('exercises the actual launched-home transport, never a caller-selected profile', async () => {
    const calls: Array<{ url: string; body?: string; authorization: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({
          url,
          body: init.body as string | undefined,
          authorization: (init.headers as Record<string, string>).Authorization!
        })

        return new Response(
          JSON.stringify(
            url.endsWith('/api/profiles')
              ? {
                  profiles: [
                    { name: 'default', path: '/tmp/other-agent' },
                    { name: 'agent-owned', path: '/tmp/matrix-voice-owned' }
                  ]
                }
              : url.includes('/api/config?')
                ? config
                : synthesized
          )
        )
      })
    )

    const scope = new MatrixVoiceScope({
      isCurrent: () => true,
      forward: createHermesPagesTransport(
        7890,
        'fixture-token',
        '/tmp/matrix-voice-owned',
        new AbortController().signal
      )
    })

    await scope.settings()
    await scope.speak('hello')
    expect(calls.map(call => call.url)).toEqual([
      'http://127.0.0.1:7890/api/profiles',
      'http://127.0.0.1:7890/api/config?profile=agent-owned',
      'http://127.0.0.1:7890/api/audio/speak?profile=agent-owned'
    ])
    expect(calls.every(call => call.authorization === 'Bearer fixture-token')).toBe(true)
    expect(calls[2]!.body).toBe(JSON.stringify({ text: 'hello' }))
  })

  it('rejects extra authority, wrong MIME, noncanonical/empty/oversized data and text before forward', async () => {
    const f = fixture()

    for (const value of [
      { roomId: '!room:test', kind: 'settings', profile: 'other' },
      { roomId: '!room:test', kind: 'settings', endpoint: 'https://evil.test' },
      { roomId: '@not-room:test', kind: 'settings' },
      { roomId: '!room:test', kind: 'transcribe', dataUrl: clip, mimeType: 'video/webm' },
      { roomId: '!room:test', kind: 'transcribe', dataUrl: 'data:audio/webm;base64,AB==', mimeType: 'audio/webm' },
      { roomId: '!room:test', kind: 'transcribe', dataUrl: 'data:audio/webm;base64,', mimeType: 'audio/webm' },
      {
        roomId: '!room:test',
        kind: 'transcribe',
        dataUrl: `data:audio/webm;base64,${Buffer.alloc(MATRIX_VOICE_MAX_UPLOAD_BYTES + 1).toString('base64')}`,
        mimeType: 'audio/webm'
      },
      { roomId: '!room:test', kind: 'speak', text: ' ' },
      { roomId: '!room:test', kind: 'speak', text: 'x'.repeat(4001) },
      { roomId: '!room:test', kind: 'speak', text: 'read\u0000this' }
    ]) {
      expect(() => parseMatrixVoiceRequest(value)).toThrow('matrix_voice_invalid')
    }

    await expect(f.scope.speak('x'.repeat(4001))).rejects.toThrow('matrix_voice_invalid')
    expect(f.forward).not.toHaveBeenCalled()
    expect(parseMatrixVoiceRequest({ roomId: '!room:test', kind: 'speak', text: '  read\nthis  ' })).toEqual({
      roomId: '!room:test',
      kind: 'speak',
      text: 'read\nthis'
    })
  })

  it('preserves silence, honors disabled STT and clamps capture to the native payload budget', async () => {
    const f = fixture()
    f.forward.mockResolvedValueOnce({ ...config, voice: { max_recording_seconds: 600 } })
    expect((await f.scope.settings()).maxRecordingSeconds).toBe(120)
    f.forward.mockResolvedValueOnce(config).mockResolvedValueOnce({ ok: true, transcript: '  ' })
    expect(await f.scope.transcribe(clip, 'audio/webm')).toBe('')
    f.forward.mockResolvedValueOnce({ ...config, stt: { ...config.stt, enabled: false } })
    await expect(f.scope.transcribe(clip, 'audio/webm')).rejects.toThrow('matrix_voice_disabled')
    expect(f.forward.mock.calls.filter(([request]) => request.path.startsWith('/api/audio/transcribe?'))).toHaveLength(
      1
    )
  })

  it('drops a result after account/agent/executor retirement instead of retargeting', async () => {
    const f = fixture()
    let resolve: (value: unknown) => void = () => undefined
    f.forward.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    const request = f.scope.speak('hello')
    f.retire()
    resolve(synthesized)
    await expect(request).rejects.toThrow('matrix_voice_unavailable')
    await expect(f.scope.settings()).rejects.toThrow('matrix_voice_unavailable')
    expect(f.forward).toHaveBeenCalledOnce()
  })

  it('hides provider errors and rejects unbounded/non-audio synthesis responses', async () => {
    const f = fixture()
    f.forward.mockRejectedValueOnce(new Error('key=secret command=/private/config'))
    await expect(f.scope.speak('hello')).rejects.toThrow(/^matrix_voice_failed$/)

    for (const response of [
      { ...synthesized, data_url: 'https://example.test/audio.mp3' },
      { ...synthesized, mime_type: 'audio/wav' },
      {
        ...synthesized,
        data_url: `data:audio/mpeg;base64,${Buffer.alloc(MATRIX_VOICE_MAX_AUDIO_BYTES + 1).toString('base64')}`
      },
      { ...synthesized, ok: false }
    ]) {
      f.forward.mockResolvedValueOnce(response)
      await expect(f.scope.speak('hello')).rejects.toThrow('matrix_voice_response_invalid')
    }
  })
})

describe('Matrix UI audio permission only', () => {
  it('allows explicitly identified audio only, never unknown metadata, video or unrelated permission', () => {
    expect(matrixVoiceAudioPermission('media', { mediaTypes: ['audio'] })).toBe(true)
    expect(matrixVoiceAudioPermission('audioCapture')).toBe(false)
    expect(matrixVoiceAudioPermission('audioCapture', { mediaType: 'audio' })).toBe(true)
    expect(matrixVoiceAudioPermission('media', { mediaTypes: [] })).toBe(false)
    expect(matrixVoiceAudioPermission('media')).toBe(false)
    expect(matrixVoiceAudioPermission('media', { mediaType: 'audio' })).toBe(true)
    expect(matrixVoiceAudioPermission('media', { mediaTypes: ['audio', 'video'] })).toBe(false)
    expect(matrixVoiceAudioPermission('audioCapture', { mediaType: 'video' })).toBe(false)
    expect(matrixVoiceAudioPermission('media', { mediaType: 'unknown' })).toBe(false)
    expect(matrixVoiceAudioPermission('display-capture')).toBe(false)
  })
})
