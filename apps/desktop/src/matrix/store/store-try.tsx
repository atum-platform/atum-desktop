import { useAssistantRuntime } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useEffect } from 'react'

import type { MatrixSnapshot } from '../../../shared/matrix'
import type { MatrixStoreItem } from '../../../shared/matrix-store'
import { $matrixPetHatchRequest } from '../pet/hatch-request'
import { matrixPetRoom } from '../pet/room'
import { projectMatrixRoster } from '../roster-model'
import { runMatrixCommand } from '../text-document-actions'

import { localizedStoreText } from './store-card'

/** A draft left for one chat's composer: the Store's "Try it now", or what was typed in a chat
 * that gave way to its agent's main conversation (app.tsx). The composer takes it once. */
export const $matrixStoreDraft = atom<{ roomId: string; text: string } | null>(null)

/**
 * The chat an item is tried in: the newest chat with the assistant that has it — the
 * chosen assistant for a skill or a hire, the default assistant for a pet. Null when that
 * assistant has no chat yet; the Store then offers no "Try it now" rather than a dead end.
 */
export function matrixStoreTryRoom(
  snapshot: MatrixSnapshot,
  item: Pick<MatrixStoreItem, 'kind'>,
  assistantId?: string
): string | null {
  const { groups } = projectMatrixRoster(snapshot)

  const group =
    item.kind === 'pet' || !assistantId
      ? groups.find(value => value.agent.isDefault)
      : groups.find(value => value.agent.assistantId === assistantId)

  return group?.rooms[0]?.id ?? null
}

/** Opens that chat with the item's example prompt in the composer, unsent; null when there is no chat. */
export function matrixStoreTryAction(
  snapshot: MatrixSnapshot,
  item: MatrixStoreItem,
  assistantId: string | undefined,
  locale: string
): (() => void) | null {
  const roomId = matrixStoreTryRoom(snapshot, item, assistantId)

  if (!roomId) {
    return null
  }

  const text = localizedStoreText(item.tryPrompt, locale).trim()

  return () => {
    $matrixStoreDraft.set(text ? { roomId, text } : null)
    void runMatrixCommand({ kind: 'select', roomId }).catch(() => $matrixStoreDraft.set(null))
  }
}

/**
 * The Hatch card's way in: the chat a pet is tried in, with its companion's hatch panel open
 * on the description and photo. The panel quotes the hatch and charges it only when the
 * person hatches the draft they pick (or uses a hatch credit they hold), so the Store buys
 * nothing here. Null when that chat would show no companion; the card then sells the credit.
 */
export function matrixStoreHatchAction(
  snapshot: MatrixSnapshot,
  mode: 'describe' | 'photo' = 'describe'
): (() => void) | null {
  const roomId = matrixStoreTryRoom(snapshot, { kind: 'pet' })

  if (!roomId || !matrixPetRoom(snapshot, roomId)) {
    return null
  }

  return () => {
    $matrixPetHatchRequest.set({ roomId, ...(mode === 'photo' ? { choosePhoto: true as const } : {}) })
    void runMatrixCommand({ kind: 'select', roomId }).catch(() => $matrixPetHatchRequest.set(null))
  }
}

/** Mounted inside a chat's composer: puts the draft left for that chat in the box and focuses it. */
export function MatrixStoreDraftSeed({ roomId }: { roomId: string }) {
  const runtime = useAssistantRuntime()
  const draft = useStore($matrixStoreDraft)

  useEffect(() => {
    if (!draft || draft.roomId !== roomId) {
      return
    }

    runtime.thread.composer.setText(draft.text)
    // Taking the draft re-renders this seed; the focus waits a frame for the box to hold the text.
    $matrixStoreDraft.set(null)
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>('[data-slot="composer-rich-input"]')?.focus()
    )
  }, [draft, roomId, runtime])

  return null
}
