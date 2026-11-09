import { describe, expect, it, vi } from 'vitest'

import type { MatrixEnrollment } from '../../shared/matrix'

import { MatrixAgentRuntime } from './agent-runtime'
import type { MatrixHermesConnection, MatrixHermesRuntimeConfig } from './hermes-runtime'
import { bindMatrixVoice, matrixVoiceFramePermission, type MatrixVoiceSource } from './voice-binding'

const settings = { stt: { enabled: true, provider: 'local' }, tts: { provider: 'edge' } }
const audio = 'data:audio/wav;base64,UklGRg=='

function fixture() {
  let authority = 'human:device:generation'
  let room = '!assistant:test'

  let runtime: MatrixHermesRuntimeConfig = {
    python: '/fixture/python',
    source: '/fixture/source',
    profiles: '/fixture/profiles'
  }

  let agent = new MatrixAgentRuntime('agent:analyst', 'analyst')

  let enrollment: MatrixEnrollment = {
    state: 'ready',
    identity: {
      issuer: 'https://issuer.test',
      subject: 'owner',
      principal: 'owner',
      agentPrincipal: 'analyst',
      executorId: 'executor-one',
      userId: '@analyst:test',
      deviceId: 'A',
      expiresAt: 100
    }
  }

  const pages = vi.fn(
    async (request: { path: string }): Promise<unknown> =>
      request.path.startsWith('/api/config')
        ? settings
        : { ok: true, transcript: 'hello', data_url: audio, mime_type: 'audio/wav' }
  )

  let connection = { pages } as unknown as MatrixHermesConnection
  const verifyRoom = vi.fn(async () => {})
  const connect = vi.fn(async () => connection)

  const source: MatrixVoiceSource = {
    authority: () => authority,
    roomId: () => room,
    runtime: () => runtime,
    agent: () => agent,
    enrollment: () => enrollment,
    blocked: target => target.closed,
    verifyRoom,
    connect,
    connection: () => connection
  }

  return {
    source,
    pages,
    connect,
    verifyRoom,
    change(kind: string) {
      if (kind === 'account') {
        authority = 'different-generation'
      }

      if (kind === 'room') {
        room = '!other:test'
      }

      if (kind === 'runtime') {
        runtime = { ...runtime }
      }

      if (kind === 'agent') {
        agent = new MatrixAgentRuntime('agent:analyst', 'analyst')
      }

      if (kind === 'closed') {
        agent.closed = true
      }

      if (kind === 'withdrawal') {
        enrollment = { state: 'absent', identity: null }
      }

      if (kind === 'executor') {
        enrollment = { ...enrollment, identity: { ...enrollment.identity!, executorId: 'new' } }
      }

      if (kind === 'device') {
        enrollment = { ...enrollment, identity: { ...enrollment.identity!, deviceId: 'new' } }
      }

      if (kind === 'renewal') {
        enrollment = { ...enrollment, identity: { ...enrollment.identity!, expiresAt: 999 } }
      }

      if (kind === 'connection') {
        connection = { ...connection }
      }
    }
  }
}

describe('actual selected-agent voice binding', () => {
  it('verifies the room and uses its owned backend, keeping credentials/config native', async () => {
    const f = fixture()
    const bound = await bindMatrixVoice(f.source, '!assistant:test')
    expect(f.verifyRoom).toHaveBeenCalledOnce()
    expect(f.connect).not.toHaveBeenCalled()
    await expect(bound.scope.transcribe(audio, 'audio/wav')).resolves.toBe('hello')
    expect(f.connect).toHaveBeenCalledOnce()
    expect(f.pages.mock.calls.map(([r]) => r.path)).toEqual([
      '/api/config?profile=default',
      '/api/audio/transcribe?profile=default'
    ])
  })
  it('allows expiry-only renewal without rebinding identity', async () => {
    const f = fixture()
    const bound = await bindMatrixVoice(f.source, '!assistant:test')
    f.change('renewal')
    await expect(bound.scope.settings()).resolves.toMatchObject({ sttEnabled: true, ttsProvider: 'edge' })
  })
  it.each(['account', 'room', 'runtime', 'agent', 'closed', 'withdrawal', 'executor', 'device'])(
    'fences %s before calling a provider',
    async kind => {
      const f = fixture()
      const bound = await bindMatrixVoice(f.source, '!assistant:test')
      f.change(kind)
      expect(bound.isCurrent()).toBe(false)
      await expect(bound.scope.speak('hello')).rejects.toThrow('matrix_voice_unavailable')
      expect(f.pages).not.toHaveBeenCalled()
    }
  )
  it.each(['account', 'room', 'withdrawal'])('rejects %s while room verification awaits', async kind => {
    const f = fixture()
    f.verifyRoom.mockImplementation(async () => {
      f.change(kind)
    })
    await expect(bindMatrixVoice(f.source, '!assistant:test')).rejects.toThrow('matrix_voice_unavailable')
    expect(f.connect).not.toHaveBeenCalled()
  })
  it('rejects a different room and failed server membership before backend start', async () => {
    const f = fixture()
    await expect(bindMatrixVoice(f.source, '!other:test')).rejects.toThrow()
    f.verifyRoom.mockRejectedValue(new Error('membership_changed'))
    await expect(bindMatrixVoice(f.source, '!assistant:test')).rejects.toThrow('membership_changed')
    expect(f.connect).not.toHaveBeenCalled()
  })
  it('does not retarget a multi-request transcription after backend replacement', async () => {
    const f = fixture()
    const bound = await bindMatrixVoice(f.source, '!assistant:test')
    await bound.scope.settings()
    f.change('connection')
    await expect(bound.scope.transcribe(audio, 'audio/wav')).rejects.toThrow('matrix_voice_unavailable')
    expect(f.connect).toHaveBeenCalledOnce()
    expect(f.pages).toHaveBeenCalledOnce()
  })
  it.each(['connection', 'withdrawal', 'account'])('drops a late %s response', async kind => {
    const f = fixture()
    f.pages.mockImplementation(async () => {
      f.change(kind)

      return settings
    })
    const bound = await bindMatrixVoice(f.source, '!assistant:test')
    await expect(bound.scope.settings()).rejects.toThrow('matrix_voice_unavailable')
  })
})

describe('native audio permission boundary', () => {
  const base = {
    trustedContents: true,
    currentConsent: true,
    permission: 'media',
    uiUrl: 'atum-matrix://ui/index.html',
    details: { isMainFrame: true, requestingUrl: 'atum-matrix://ui/index.html', mediaTypes: ['audio'] }
  }

  it('allows only the currently consented UI main-frame microphone', () => {
    expect(matrixVoiceFramePermission(base)).toBe(true)
    expect(
      matrixVoiceFramePermission({ ...base, details: { ...base.details, mediaTypes: undefined, mediaType: 'audio' } })
    ).toBe(true)
  })
  it.each([
    { trustedContents: false },
    { currentConsent: false },
    { permission: 'notifications' },
    { details: { ...base.details, isMainFrame: false } },
    { details: { ...base.details, requestingUrl: 'atum-matrix://sdk/index.html' } },
    { details: { ...base.details, mediaTypes: ['video'] } },
    { details: { ...base.details, mediaTypes: ['audio', 'video'] } },
    { details: { ...base.details, mediaTypes: [] } }
  ])('denies non-consented, guest, SDK, iframe, video and unknown requests: %j', change => {
    expect(matrixVoiceFramePermission({ ...base, ...change })).toBe(false)
  })
})
