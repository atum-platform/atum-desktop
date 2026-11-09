import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useI18n } from '@/i18n'
import { useAppViewOverlayHold } from '@/store/use-app-view-overlay'

import type { MatrixPetBridge } from '../../../shared/matrix-pet'
import type { PetInfo } from '../../../shared/pet'
import { petChatAnswered, petChatUnsaved } from '../../../shared/pet-chat-thread'
import {
  type AtumPetChatAction,
  type AtumPetChatRef,
  atumPetChatRefKey,
  type AtumPetChatTurn
} from '../../../shared/pet-chat/atum-pet-chat'
import { focusMatrixComposer } from '../composer-focus'

import { PetChatBox, type PetChatPending } from './chat-box'
import { petStageRoot } from './dom-world'
import type { PetPresentation } from './store'

export interface PetGlassChatProps {
  anchor: HTMLDivElement | null
  name: string
  sprite?: PetInfo
  chatRef?: AtumPetChatRef
  chat?: MatrixPetBridge['chat']
  history?: MatrixPetBridge['chatHistory']
  onAction?: (action: AtumPetChatAction) => void
  position?: PetPresentation['position']
  close(): void
}

const WIDTH = 320
const HEIGHT = 380

/** One message in flight or failed, with the id it keeps when tried again (the platform
 * treats a repeated id as the same turn, never a second charge). */
interface Outgoing extends PetChatPending {
  id: string
}

export function PetGlassChat({
  anchor,
  name,
  sprite,
  chatRef,
  chat,
  history,
  onAction,
  position,
  close
}: PetGlassChatProps) {
  useAppViewOverlayHold()
  const { locale } = useI18n()
  const [host, setHost] = useState<Element | null>(null)
  const [draft, setDraft] = useState('')
  const [recent, setRecent] = useState<AtumPetChatTurn[]>([])
  // Every turn answered while this box is open; what the history lacks of it is shown after it.
  const [session, setSession] = useState<AtumPetChatTurn[]>([])
  const [loading, setLoading] = useState(false)
  const [outgoing, setOutgoing] = useState<Outgoing>()
  const inFlight = useRef(false)
  const alive = useRef(true)
  const panel = useRef<HTMLElement>(null)
  const closeRef = useRef(close)
  closeRef.current = close
  const chatRefKey = chatRef ? atumPetChatRefKey(chatRef) : ''
  const refBox = useRef(chatRef)
  refBox.current = chatRef

  useLayoutEffect(() => {
    if (anchor) {
      setHost(petStageRoot(anchor))
    }
  }, [anchor])
  useEffect(() => {
    alive.current = true

    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    setRecent([])
    setSession([])
    setOutgoing(undefined)

    const ref = refBox.current

    if (!history || !chatRefKey || !ref) {
      return
    }

    let current = true
    setLoading(true)
    void history(ref)
      .then(result => {
        if (current && result.ok) {
          setRecent(result.history.recent)
        }
      })
      // History is a convenience: without it the box still sends and shows the answer.
      .catch(() => undefined)
      .finally(() => {
        if (current) {
          setLoading(false)
        }
      })

    return () => {
      current = false
    }
  }, [chatRefKey, history])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        event.target instanceof Node &&
        panel.current?.contains(event.target)
      ) {
        event.preventDefault()
        closeRef.current()
        focusMatrixComposer()
      }
    }

    window.document.addEventListener('keydown', escape)

    return () => {
      window.document.removeEventListener('keydown', escape)
    }
  }, [anchor])

  async function send(message: Outgoing) {
    const ref = refBox.current

    if (!chat || !ref || inFlight.current) {
      return
    }

    inFlight.current = true
    setOutgoing({ ...message, state: 'sending', code: undefined })

    try {
      const result = await chat({ ref, message_id: message.id, message: message.text, locale })

      if (!alive.current) {
        return
      }

      if (result.ok) {
        // `reply` is the answer; `recent` is only what the pet's history holds, and may not
        // hold this exchange yet (a first chat, or the platform's fallback).
        const answered = new Date().toISOString()
        setRecent(result.reply.recent)
        setSession(turns =>
          petChatAnswered(turns, { text: message.text, at: message.at }, { text: result.reply.reply, at: answered })
        )
        setOutgoing(undefined)

        if (result.reply.action) {
          onAction?.(result.reply.action)
        }
      } else {
        setOutgoing({ ...message, state: 'failed', code: result.code })
      }
    } catch {
      if (alive.current) {
        setOutgoing({ ...message, state: 'failed', code: 'temporarily_unavailable' })
      }
    } finally {
      inFlight.current = false
    }
  }

  if (!host) {
    return null
  }

  const box = host.getBoundingClientRect()
  const left = Math.max(8, Math.min(position?.x ?? box.width - WIDTH - 8, Math.max(8, box.width - WIDTH - 8)))

  const top = Math.max(
    8,
    Math.min((position?.y ?? box.height - 32) - HEIGHT - 10, Math.max(8, box.height - HEIGHT - 8))
  )

  const topUp = window.atumMatrix?.openTopUp

  return createPortal(
    <PetChatBox
      autoFocus
      available={Boolean(chat && chatRef)}
      className="pointer-events-auto absolute z-40 max-h-[calc(100%-1rem)] max-w-[calc(100%-1rem)]"
      data-pet-glass
      draft={draft}
      loading={loading}
      locale={locale}
      name={name}
      onClose={() => {
        close()
        focusMatrixComposer()
      }}
      onDraft={setDraft}
      onRetry={() => outgoing && void send(outgoing)}
      onSend={() => {
        const text = draft.trim()

        if (!text || inFlight.current) {
          return
        }

        setDraft('')
        void send({ id: crypto.randomUUID(), text, at: new Date().toISOString(), state: 'sending' })
      }}
      onTopUp={topUp ? () => void topUp().catch(() => undefined) : undefined}
      pending={outgoing}
      ref={panel}
      sprite={sprite}
      style={{ left, top, width: WIDTH, height: HEIGHT }}
      turns={[...recent, ...petChatUnsaved(recent, session)]}
    />,
    host
  )
}
