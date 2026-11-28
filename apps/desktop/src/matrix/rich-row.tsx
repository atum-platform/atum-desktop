import { useEffect, useState } from 'react'

import { ArrowUpRight, Pin } from '@/lib/icons'

import type { MatrixMessage, MatrixRoom } from '../../shared/matrix'
import { isTeamSpaceRoom } from '../../shared/matrix-company-channel-room'

import { MatrixFileSave } from './message-actions'
import { MatrixPollRow } from './poll/row'
import { runMatrixCommand } from './text-document-actions'
import { MatrixVoicePlayer } from './voice-note/player'

async function loadMedia(roomId: string, eventId: string, mime: string) {
  const bytes = await runMatrixCommand({ kind: 'download', roomId, eventId, inline: true })

  if (!(bytes instanceof Uint8Array)) {
    throw new Error('matrix_file_unavailable')
  }

  return new Blob([new Uint8Array(bytes)], { type: mime })
}

function MatrixSticker({ body, eventId, roomId, mime }: {
  body: string
  eventId: string
  roomId: string
  mime: string
}) {
  const [src, setSrc] = useState<string>()

  useEffect(() => {
    const reader = new FileReader()
    let active = true

    reader.onload = () => {
      if (active && typeof reader.result === 'string') {
        setSrc(reader.result)
      }
    }

    void loadMedia(roomId, eventId, mime).then(blob => {
      if (active) {
        reader.readAsDataURL(blob)
      }
    }).catch(() => {})

    return () => {
      active = false
      reader.abort()
    }
  }, [eventId, mime, roomId])

  return src
    ? <img alt={body} className="max-h-40 max-w-40 object-contain" onError={() => setSrc(undefined)} src={src} />
    : <span>{body}</span>
}

export function MatrixRichRow({ message, room, save }: { message: MatrixMessage; room: MatrixRoom; save?: () => void }) {
  const roomId = room.id
  const [mapError, setMapError] = useState(false)
  const { rich } = message

  switch (rich?.kind) {
    case 'poll':
      return <MatrixPollRow eventId={message.id} poll={rich.poll} readOnly={isTeamSpaceRoom(room)} roomId={roomId} />

    case 'voice':
      return (
        <div className={`flex w-72 max-w-full items-center gap-1 ${message.own ? 'composer-human-message' : 'matrix-chat-bubble'}`}>
          <MatrixVoicePlayer
            duration={rich.duration}
            load={() => loadMedia(roomId, message.id, rich.mimeType)}
            waveform={rich.waveform}
          />
          {save && <MatrixFileSave name={message.body} onSave={save} />}
        </div>
      )

    case 'sticker':
      return <MatrixSticker body={message.body} eventId={message.id} mime={rich.mimeType} roomId={roomId} />

    case 'location':
      return (
        <div className="matrix-chat-bubble max-w-full">
          <button
            className="flex w-full items-center gap-2 text-start"
            onClick={() => void window.atumMatrix.openLink(rich.geoUri).catch(() => setMapError(true))}
            type="button"
          >
            <Pin aria-hidden className="size-4 shrink-0" />
            <span className="min-w-0 break-words">{message.body || 'Open location'}</span>
            <ArrowUpRight aria-hidden className="size-4 shrink-0" />
          </button>
          {mapError && <span role="status">Could not open the map.</span>}
        </div>
      )

    default:
      return null
  }
}
