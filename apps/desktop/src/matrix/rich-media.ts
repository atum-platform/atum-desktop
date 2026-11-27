import { EventType, type IContent, MsgType } from 'matrix-js-sdk'
import { M_LOCATION, type MLocationContent } from 'matrix-js-sdk/lib/@types/location'

import { matrixGeoPoint, type MatrixRichMessage } from '../../shared/matrix-rich-content'

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])
const AUDIO_TYPES = new Set(['audio/ogg', 'audio/opus', 'audio/mp4', 'audio/mpeg', 'audio/webm', 'audio/wav', 'audio/aac'])

export function matrixRichMedia(type: string, content: IContent): Exclude<MatrixRichMessage, { kind: 'poll' }> | undefined {
  const info = content.info as { mimetype?: unknown; duration?: unknown } | undefined
  const mime = typeof info?.mimetype === 'string' ? info.mimetype.split(';', 1)[0]! : ''

  if (type === EventType.Sticker) {
    return { kind: 'sticker', mimeType: IMAGE_TYPES.has(mime) ? mime : 'image/png' }
  }

  if (content.msgtype === MsgType.Location) {
    const location = M_LOCATION.findIn<MLocationContent>(content as Record<string, MLocationContent>)
    const geoUri = matrixGeoPoint(location?.uri ?? content.geo_uri)

    return geoUri ? { kind: 'location', geoUri } : undefined
  }

  const marker = content['org.matrix.msc3245.voice']

  if (content.msgtype !== MsgType.Audio || !marker || typeof marker !== 'object' || Array.isArray(marker)) {
    return undefined
  }

  const audio = content['org.matrix.msc1767.audio'] as { duration?: unknown; waveform?: unknown } | undefined
  const milliseconds = audio?.duration ?? info?.duration

  const duration = typeof milliseconds === 'number' && Number.isFinite(milliseconds) && milliseconds >= 0
    ? milliseconds
    : undefined

  const samples = Array.isArray(audio?.waveform) ? audio.waveform : []

  const waveform = samples.slice(0, 100).map(peak =>
    typeof peak === 'number' && Number.isFinite(peak) ? Math.round(Math.max(0, Math.min(1024, peak))) : 0
  )

  return { kind: 'voice', mimeType: AUDIO_TYPES.has(mime) ? mime : 'audio/ogg', duration, waveform }
}
