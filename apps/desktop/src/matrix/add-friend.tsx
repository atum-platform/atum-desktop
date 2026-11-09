import { useEffect, useRef, useState } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'

import type { MatrixAgentView, MatrixSnapshot } from '../../shared/matrix'

import { useCreationAction } from './creation-action'
import { type FoundPerson, type PersonOffer, PersonSearch } from './person-search'
import { useRosterCreateCopy } from './roster-create-copy'
import { runMatrixCommand } from './text-document-actions'

export interface MatrixAddFriendProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** What the start menu's search held, looked up as soon as the dialog opens. */
  initialQuery?: string
  snapshot: MatrixSnapshot
  /** An existing conversation: the shell selects it and closes its drawer. */
  onOpenRoom(roomId: string): void
  /** One of the owner's own assistants, found by its @name. */
  onOpenAssistant(agent: MatrixAgentView): void
  /** A new direct conversation was made (and selected by Matrix). */
  onCreated(): void
}

/**
 * Adding a friend is finding them by their @name and saying hello: Matrix has no friend
 * list, so "Message" opens the conversation you already have with them or starts one.
 */
export function MatrixAddFriend({
  initialQuery,
  onCreated,
  onOpenAssistant,
  onOpenChange,
  onOpenRoom,
  open,
  snapshot
}: MatrixAddFriendProps) {
  const copy = useRosterCreateCopy()
  const action = useCreationAction()
  const openRef = useRef(open)
  const ready = snapshot.state === 'ready'

  useEffect(() => {
    openRef.current = open
  }, [open])

  const close = () => onOpenChange(false)

  const message = (person: FoundPerson) => {
    if (person.roomId) {
      close()
      onOpenRoom(person.roomId)

      return
    }

    // The founder, found by @founder with no chat yet: the Founder chat, made at the person's
    // own request (it may replace one they left), never a second plain chat.
    const founder = window.atumMatrix.founder

    if (founder && snapshot.founder && person.userId === snapshot.founder.userId) {
      action.run(
        async () => {
          const result = await founder.contact()

          if (!('roomId' in result)) {
            throw new Error('matrix_founder_unavailable')
          }

          return true
        },
        () => {
          if (openRef.current) {
            close()
            onCreated()
          }
        }
      )

      return
    }

    action.run(
      () => runMatrixCommand({ kind: 'create', name: '', invite: [person.userId], direct: true }).then(() => true),
      () => {
        // Matrix selects the new conversation either way; only a dialog still open hands
        // over to it (a dismissed one must not close the roster under the person).
        if (openRef.current) {
          close()
          onCreated()
        }
      }
    )
  }

  const offer = (person: FoundPerson): PersonOffer =>
    person.ownAgent
      ? {
          label: copy.open,
          disabled: !ready,
          onSelect: () => {
            close()
            onOpenAssistant(person.ownAgent!)
          }
        }
      : { label: copy.message, disabled: !ready || action.pending, onSelect: () => message(person) }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md" data-matrix-add-friend>
        <DialogHeader>
          <DialogTitle>{copy.addFriendTitle}</DialogTitle>
          <DialogDescription>{copy.addFriendBody}</DialogDescription>
        </DialogHeader>
        <AddFriendSearch
          initialQuery={initialQuery ?? ''}
          offer={offer}
          onQueryChange={action.clearFailure}
          snapshot={snapshot}
        />
        {action.failed && (
          <NoticeBand role="alert" tone="failure">
            {copy.startFailed}
          </NoticeBand>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Mounted per opening: a query handed over by the start menu is searched once. */
function AddFriendSearch({
  initialQuery,
  offer,
  onQueryChange,
  snapshot
}: {
  initialQuery: string
  offer(person: FoundPerson): PersonOffer
  onQueryChange(): void
  snapshot: MatrixSnapshot
}) {
  const copy = useRosterCreateCopy()
  const [query, setQuery] = useState(initialQuery)
  const [seed] = useState(initialQuery.trim() ? 1 : undefined)

  return (
    <PersonSearch
      autoFocus
      label={copy.handleLabel}
      offer={offer}
      onQueryChange={value => {
        onQueryChange()
        setQuery(value)
      }}
      placeholder={copy.handlePlaceholder}
      query={query}
      seed={seed}
      snapshot={snapshot}
    />
  )
}
