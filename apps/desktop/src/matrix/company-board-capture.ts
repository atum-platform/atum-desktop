import { useCallback, useRef, useState } from 'react'

import type { MatrixRoom } from '../../shared/matrix'
import { type MatrixMessageLinkTarget, parseMatrixMessageLink } from '../../shared/matrix-message-link'

import { type CompanyBoardCommand, companyDesktopAdapter } from './company-desktop-adapter'
import { companySpaceScope, patchCompanySpacePreferences } from './company-space-store'
import { $companyChannels, channelViewForRoom } from './team-space/channels-store'
import { teamSpaceKey } from './team-space/keys'
import { useCompanyChannelFacts } from './team-space/use-channel-facts'
import type { CompanyChannelView } from './team-space/views'

/** atum.company-board/1.1 `title` and `description` limits (protocol `COMPANY_BOARD_LIMITS`, UTF-16 units). */
export const COMPANY_BOARD_CAPTURE_TITLE = 160
export const COMPANY_BOARD_CAPTURE_DESCRIPTION = 2_000

export interface CompanyBoardCaptureDraft {
  title: string
  description: string
}

/** Cut to at most `limit` UTF-16 units on a code point boundary, marking the cut. */
function clip(value: string, limit: number): string {
  if (value.length <= limit) {
    return value
  }

  let out = ''

  for (const point of value) {
    if (out.length + point.length > limit - 1) {
      break
    }

    out += point
  }

  return `${out.trimEnd()}…`
}

/**
 * A message becomes a task the way Slack's "save to list" does: its first line is the title, the
 * description keeps the whole message (when there is more than the title) and ends with the message's
 * own link, so the card always leads back to where it was said.
 */
export function companyBoardCaptureDraft(body: string, link: string): CompanyBoardCaptureDraft | null {
  const text = body.trim()
  const firstLine = text.split('\n').find(line => line.trim())?.replace(/\s+/gu, ' ').trim()

  if (!firstLine || link.length + 2 >= COMPANY_BOARD_CAPTURE_DESCRIPTION) {
    return null
  }

  const title = clip(firstLine, COMPANY_BOARD_CAPTURE_TITLE)
  const quoted = text === title ? '' : clip(text, COMPANY_BOARD_CAPTURE_DESCRIPTION - link.length - 2)

  return { title, description: quoted ? `${quoted}\n\n${link}` : link }
}

/** A captured card's source: its description's last line, when that is a Team space message link. */
export function companyBoardCardSource(
  description: string | null
): { text: string | null; target: MatrixMessageLinkTarget } | null {
  if (!description) {
    return null
  }

  const lines = description.trimEnd().split('\n')
  const target = parseMatrixMessageLink(lines.at(-1)?.trim())

  if (!target) {
    return null
  }

  const text = lines.slice(0, -1).join('\n').trim()

  return { text: text || null, target }
}

export interface CompanyBoardCapture {
  busy: boolean
  /**
   * Creates the task and resolves its card id; the person stays in the conversation. Resolves nothing
   * when another capture was already running. Rejects when the platform did not add it.
   */
  capture(body: string, link: string): Promise<string | undefined>
  /** Shows that card on the board, on the person's word ("Open task"). */
  open(cardId: string): void
}

/** A channel whose messages may become a company-wide card: active and public. */
function captureAllowed(channel: CompanyChannelView | undefined): channel is CompanyChannelView {
  return Boolean(channel && channel.visibility === 'public' && channel.state === 'active')
}

/**
 * A stable UUID for one person turning one message (as it reads now) into a task. Board 1.1 replays a
 * create with the same actor, request and input (`0351_company_board_v11_platform.sql`), so a second
 * click, a retry or a menu opened twice gets the same card back instead of a second one; another
 * person, or an edited message, is a different request.
 */
async function captureId(purpose: 'card' | 'request', parts: readonly string[]): Promise<string> {
  const bytes = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([purpose, ...parts])))
  ).slice(0, 16)

  bytes[6] = (bytes[6]! & 0x0f) | 0x80 // RFC 9562 version 8: application-defined
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // RFC 9562 variant
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * "Turn into task" for one open room. A person's card is company-wide: the board contract lets only the
 * platform set a card's audience (`publicationScope`, `citations` are forbidden native fields), so a
 * message is turned into a card only where the whole company may already read it: an active public
 * channel, by the same platform directory facts the channel header uses. Private channels and
 * conversations get no action.
 *
 * The check is made again when the action runs, against the stores as they are then: a menu opened
 * before the channel was archived, made private or rebound must not still publish its words.
 */
export function useCompanyBoardCapture(accountKey: string, room: MatrixRoom | null | undefined): CompanyBoardCapture | undefined {
  const companyId = room?.companyChannel?.companyId
  const { channel } = useCompanyChannelFacts(accountKey, room)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const latest = useRef({ channel, room })
  latest.current = { channel, room }

  const capture = useCallback(
    async (body: string, link: string) => {
      // One capture at a time: a second activation while one runs adds nothing.
      if (inFlight.current) {
        return undefined
      }

      inFlight.current = true

      try {
        const adapter = companyDesktopAdapter()
        const draft = companyBoardCaptureDraft(body, link)
        const target = parseMatrixMessageLink(link)
        const live = latest.current
        const liveBinding = live.room?.companyChannel

        const stored = liveBinding
          ? channelViewForRoom($companyChannels.get()[teamSpaceKey(accountKey, liveBinding.companyId)], live.room)
          : undefined

        // Fail closed: the room, its binding, the link and both readings of the directory must still agree.
        if (!adapter || !companyId || !draft || !target || !liveBinding || liveBinding.companyId !== companyId ||
          target.companyId !== companyId || target.roomId !== live.room?.id || !captureAllowed(live.channel) ||
          !captureAllowed(stored) || stored.id !== live.channel.id || stored.id !== liveBinding.channelId) {
          throw new Error('company_board_capture_unavailable')
        }

        setBusy(true)

        const parts = [accountKey, companyId, target.roomId, target.eventId, draft.title, draft.description]

        const command: CompanyBoardCommand = {
          schemaVersion: 1,
          operation: 'create',
          requestId: await captureId('request', parts),
          cardId: await captureId('card', parts),
          title: draft.title,
          description: draft.description
        }

        const result = await adapter.commandBoard(companyId, command, '1.1')

        return ('currentCard' in result ? result.currentCard : result.card).cardId
      } finally {
        inFlight.current = false
        setBusy(false)
      }
    },
    [accountKey, companyId]
  )

  const open = useCallback(
    (cardId: string) => {
      if (!companyId) {
        return
      }

      // Where it can be seen: the whole board, no filter that could hide a new unowned task.
      patchCompanySpacePreferences(companySpaceScope(accountKey, companyId), {
        tab: 'board',
        boardView: 'board',
        projectId: null,
        ownerMemberRef: null,
        due: 'all',
        selectedCardId: cardId
      })
    },
    [accountKey, companyId]
  )

  const usable = Boolean(companyId && captureAllowed(channel) && companyDesktopAdapter())

  return usable ? { busy, capture, open } : undefined
}
