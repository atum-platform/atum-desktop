import { useCallback, useState } from 'react'

import type { MatrixMessage } from '../../shared/matrix'

/**
 * When the conversation asks for the one-time video consent: only when the agent's working line
 * carries `video_consent_required` (the host refused the video step for want of consent; see
 * docs/video-generation-consent.md). The ask outlives the line (the line goes when the turn ends)
 * until the person allows video or puts the card away. A put-away ask stays away for that line; the
 * next refused video step asks again. Nothing here reads chat text or posts any.
 */
export function useVideoConsentAsk(
  roomKey: string | undefined,
  line: Pick<MatrixMessage, 'id' | 'presentation'> | undefined
): { asking: boolean; close(): void } {
  const [asked, setAsked] = useState<string | null>(null)
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())

  const signal =
    roomKey && line?.presentation?.code === 'video_consent_required' ? `${roomKey}\n${line.id}` : null

  // A new signal opens the card at once (state adjusted while rendering, not after paint).
  if (signal && signal !== asked && !closed.has(signal)) {
    setAsked(signal)
  }

  const close = useCallback(() => {
    if (asked) {
      setClosed(previous => new Set(previous).add(asked))
      setAsked(null)
    }
  }, [asked])

  return { asking: Boolean(roomKey && asked?.startsWith(`${roomKey}\n`)), close }
}
