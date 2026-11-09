import './overlay-root.css'

import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { PetSpriteCanvas, roamWalkRow } from '@/components/pet/pet-sprite-canvas'

import type {
  MatrixPetOverlayAction,
  MatrixPetOverlayBridge,
  MatrixPetOverlaySnapshot
} from '../../../shared/matrix-pet-overlay'
import { petCopy } from '../pet-copy'

import { PetChatBox, type PetChatPending } from './chat-box'
import { petHitBox } from './hit-box'
import type { PetAction } from './menu'
import { petOverlayCopy } from './overlay-copy'

declare global {
  interface Window {
    atumMatrixPetOverlay?: MatrixPetOverlayBridge
  }
}

/** The typed refusals main lets cross this window, each with its own short line. */
const PET_CHAT_FAILURES = ['insufficient_protons', 'rate_limited', 'temporarily_unavailable', 'not_found'] as const

/** A snapshot renderer. Motion, native bounds and target identity live in main. */
export interface MatrixPetOverlayRootProps {
  bridge?: MatrixPetOverlayBridge
}

export function MatrixPetOverlayRoot({ bridge = window.atumMatrixPetOverlay }: MatrixPetOverlayRootProps) {
  const [snapshot, setSnapshot] = useState<MatrixPetOverlaySnapshot>()
  const [text, setText] = useState('')
  const [pending, setPending] = useState<PetChatPending>()
  const [failed, setFailed] = useState<string>()
  const input = useRef<HTMLTextAreaElement>(null)
  const sending = useRef(false)
  const dragging = useRef(false)
  const moved = useRef(false)
  const origin = useRef({ x: 0, y: 0 })

  useEffect(() => bridge?.onSnapshot(setSnapshot), [bridge])
  useEffect(() => {
    if (snapshot?.chatOpen) {
      input.current?.focus()
    } else {
      setText('')
      setPending(undefined)
      setFailed(undefined)
    }
  }, [snapshot?.chatOpen])

  if (!snapshot || !bridge) {
    return null
  }

  const copy = petCopy[snapshot.locale]
  const overlay = petOverlayCopy[snapshot.locale]
  const { sprite, intent, size, bubble, recent, unsaved = [] } = snapshot
  const name = sprite.displayName ?? copy.title
  const hit = petHitBox(sprite, intent.pose, size.zoom, intent.mirror)
  const walk = roamWalkRow(intent.direction, sprite.stateRows)
  const run = (action: MatrixPetOverlayAction) => void bridge.menu(action).catch(() => setFailed('send'))

  const actions: PetAction[] = [
    ...(
      [
        ['wave', copy.wave],
        ['sit', copy.sit],
        ['lounge', copy.lounge],
        ['change', copy.change],
        ['size', copy.size],
        ['hide', copy.hide],
        ['store', copy.store],
        ['settings', copy.settings]
      ] as const
    ).map(([action, label]) => ({ id: action, label, run: () => run(action) })),
    { id: 'pop-in', label: overlay.popIn, run: () => void bridge.popIn().catch(() => setFailed('send')) }
  ]

  const send = async (message: string) => {
    if (!message.trim() || sending.current) {
      return
    }

    sending.current = true
    const outgoing: PetChatPending = { text: message.trim(), at: new Date().toISOString(), state: 'sending' }
    setPending(outgoing)
    setFailed(undefined)

    try {
      // Main shows the answer through the next snapshot: the reply's own words, even when the
      // pet's history does not hold them yet.
      await bridge.submit(outgoing.text)
      setPending(undefined)
    } catch (error) {
      const reason = error instanceof Error ? error.message : ''
      const code = PET_CHAT_FAILURES.find(value => reason.includes(value)) ?? 'send'
      setPending({ ...outgoing, state: 'failed', code })
    } finally {
      sending.current = false
    }
  }

  return (
    <div className={snapshot.dark ? 'dark' : undefined} lang={snapshot.locale}>
      <main className="atum-pet-surface matrix-pet-overlay">
        <div className="matrix-pet-overlay-panel">
          {snapshot.chatOpen ? (
            <PetChatBox
              actions={actions}
              available
              className="matrix-pet-overlay-chat"
              draft={text}
              inputRef={input}
              locale={snapshot.locale}
              name={name}
              notice={failed ? overlay.failed : undefined}
              onClose={() => run('chat')}
              onDraft={setText}
              onKeyDown={event => {
                if (event.key === 'Escape' && !event.defaultPrevented) {
                  event.preventDefault()
                  run('chat')
                }
              }}
              onRetry={() => pending && void send(pending.text)}
              onSend={() => {
                const message = text
                setText('')
                void send(message)
              }}
              pending={pending}
              sprite={sprite}
              turns={[...recent, ...unsaved]}
            />
          ) : bubble ? (
            <p className="atum-pet-glass matrix-pet-overlay-status" role="status">
              {bubble.kind === 'excerpt' ? bubble.text : overlay[bubble.kind]}
            </p>
          ) : null}
        </div>
        <div
          aria-hidden="true"
          className="matrix-pet-overlay-sprite"
          style={{ width: size.width, height: size.height }}
        >
          <div
            className="matrix-pet-overlay-canvas"
            style={{ transform: `scaleX(${intent.pose === 'run' ? (walk.mirror ? -1 : 1) : intent.mirror ? -1 : 1})` }}
          >
            <PetSpriteCanvas
              info={sprite}
              paused={intent.paused}
              rowOverride={intent.pose === 'run' ? walk.row : undefined}
              stateOverride={intent.pose}
              zoom={size.zoom}
            />
          </div>
          <div
            className="matrix-pet-overlay-hit"
            onContextMenu={event => {
              event.preventDefault()
              run('chat')
            }}
            onPointerCancel={() => {
              dragging.current = false
              void bridge.drag('end').catch(() => setFailed('send'))
            }}
            onPointerDown={event => {
              if (event.button !== 0 || snapshot.chatOpen) {
                return
              }

              origin.current = { x: event.screenX, y: event.screenY }
              moved.current = false
              dragging.current = true
              event.currentTarget.setPointerCapture(event.pointerId)
              void bridge.drag('start').catch(() => {
                dragging.current = false
              })
            }}
            onPointerEnter={() => void bridge.setInteractive(true).catch(() => undefined)}
            onPointerLeave={() => void bridge.setInteractive(false).catch(() => undefined)}
            onPointerMove={event => {
              if (
                dragging.current &&
                Math.hypot(event.screenX - origin.current.x, event.screenY - origin.current.y) > 4
              ) {
                moved.current = true
              }
            }}
            onPointerUp={event => {
              if (!dragging.current) {
                return
              }

              dragging.current = false
              const wasMoved = moved.current
              event.currentTarget.releasePointerCapture(event.pointerId)
              void bridge
                .drag('end')
                .then(() => {
                  if (!wasMoved) {
                    return bridge.click()
                  }
                })
                .catch(() => setFailed('send'))
            }}
            style={hit}
          />
        </div>
      </main>
    </div>
  )
}

const root = document.getElementById('matrix-pet-root')

if (root) {
  createRoot(root).render(<MatrixPetOverlayRoot />)
}
