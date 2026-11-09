import type { MatrixFounderContactResult } from '../../../shared/matrix-founder'

/**
 * The draft's one act: the person's first message makes the chat (Element's local room, made
 * on the first send) and then sends. Opening the draft never gets here.
 *
 * A second tap while the chat is being made joins the same request, so a rapid double send
 * makes exactly one room. Both messages then go into that one room.
 */
export interface MatrixFounderDraftPorts {
  /** Main's Founder bridge: the chat this account has, else the one another device made,
   * else a new one. It selects the room. */
  contact(): Promise<MatrixFounderContactResult>
  send(roomId: string, body: string): Promise<unknown>
}

export interface MatrixFounderDraft {
  /** `sent`: the words went into the chat. `unavailable` with a `roomId`: the chat exists, but
   * the send failed (the caller keeps the words for that chat's own box); without one, nothing
   * was made and the draft can keep the words for another try. */
  send(body: string): Promise<{ outcome: 'sent' } | { outcome: 'unavailable'; roomId?: string }>
}

export function createFounderDraft(ports: MatrixFounderDraftPorts): MatrixFounderDraft {
  let opening: Promise<string | null> | undefined

  async function room(): Promise<string | null> {
    opening ??= ports
      .contact()
      .then(result => ('roomId' in result ? result.roomId : null))
      .catch(() => null)
      .finally(() => {
        opening = undefined
      })

    return opening
  }

  return {
    async send(body: string): Promise<{ outcome: 'sent' } | { outcome: 'unavailable'; roomId?: string }> {
      const text = body.trim()

      if (!text) {
        return { outcome: 'unavailable' }
      }

      const roomId = await room()

      if (!roomId) {
        return { outcome: 'unavailable' }
      }

      try {
        await ports.send(roomId, text)

        return { outcome: 'sent' }
      } catch {
        return { outcome: 'unavailable', roomId }
      }
    }
  }
}
