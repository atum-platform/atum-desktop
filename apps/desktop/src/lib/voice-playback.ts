/** Legacy gateway adapter around the one transport-free playback owner. */
import { resolveGatewayWsUrl } from '@hermes/shared'

import { speakText } from '@/hermes'

import {
  playSpeechText as play,
  startSpeechStream as stream,
  type VoicePlaybackOptions,
  type VoicePlaybackTransport
} from './voice-playback-engine'

export {
  isVoicePlaybackActive,
  markVoicePlaybackInterrupted,
  type SpeechStreamSession,
  stopVoicePlayback,
  takeVoicePlaybackInterrupted,
  type VoicePlaybackOptions,
  type VoicePlaybackTransport
} from './voice-playback-engine'

async function resolveSpeakStreamUrl(): Promise<null | string> {
  const desktop = window.hermesDesktop

  if (!desktop?.getConnection) {
    return null
  }

  try {
    // Mint fresh gateway auth, including a single-use ticket in OAuth mode.
    const wsUrl = await resolveGatewayWsUrl(desktop, await desktop.getConnection())
    const url = new URL(wsUrl)

    if (!url.pathname.endsWith('/api/ws')) {
      return null
    }

    url.pathname = url.pathname.replace(/\/api\/ws$/, '/api/audio/speak-stream')

    return url.toString()
  } catch {
    return null
  }
}

export function startSpeechStream(options: VoicePlaybackOptions) {
  return stream(options, resolveSpeakStreamUrl)
}

export function playSpeechText(text: string, options: VoicePlaybackOptions, transport?: VoicePlaybackTransport) {
  return play(text, options, transport ?? { synthesize: speakText, streamUrl: resolveSpeakStreamUrl })
}
