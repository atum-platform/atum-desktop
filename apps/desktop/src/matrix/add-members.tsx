import { useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'

import type { MatrixMember, MatrixRoom, MatrixSnapshot } from '../../shared/matrix'

import { GroupPicker, type GroupPickerAdornments, useGroupPickerDraft } from './group-picker'
import { useGroupPickerCopy } from './group-picker-copy'
import { type GroupCandidate, groupCandidates } from './group-picker-model'
import { useRosterCreateCopy } from './roster-create-copy'
import { runMatrixCommand } from './text-document-actions'

export interface MatrixAddMembersProps {
  open: boolean
  onOpenChange(open: boolean): void
  room: MatrixRoom
  /** The room's members as Matrix reports them: they show ticked, as already in. */
  members: readonly MatrixMember[]
  snapshot: MatrixSnapshot
  adornments?(candidate: GroupCandidate): GroupPickerAdornments | undefined
}

/**
 * Adding members to a conversation with the same picker that makes a group. Each pick is an
 * ordinary invitation, sent one at a time; the ones that went through leave the picks, so a
 * failure keeps only who still needs inviting and Add tries just them again. One of your own
 * assistants is invited the same way: main recognises it, checks the group has room for it
 * (five at most) and has it join (assistant-policy.ts).
 */
export function MatrixAddMembers({ adornments, members, onOpenChange, open, room, snapshot }: MatrixAddMembersProps) {
  const copy = useGroupPickerCopy()
  const roster = useRosterCreateCopy()
  const { locale, t } = useI18n()
  const draft = useGroupPickerDraft()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const busy = useRef(false)
  const ready = snapshot.state === 'ready'

  const candidates = groupCandidates({
    snapshot,
    mode: 'add',
    locale,
    assistantName: t.matrixShell.assistantName,
    members
  })

  // People and your own assistants: each is one invitation; main has an assistant join itself.
  const picks = draft.selected.filter(each => each.kind === 'person' || each.kind === 'assistant')
  const canAdd = ready && !pending && picks.length > 0

  const add = async () => {
    if (!canAdd || busy.current) {
      return
    }

    busy.current = true
    setPending(true)
    setFailed(false)
    const added: string[] = []
    let missed = false

    for (const pick of picks) {
      try {
        await runMatrixCommand({ kind: 'invite', roomId: room.id, userId: pick.id })
        added.push(pick.key)
      } catch {
        missed = true
      }
    }

    draft.drop(added)
    busy.current = false
    setPending(false)

    if (missed) {
      setFailed(true)
    } else {
      draft.reset()
      onOpenChange(false)
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="top-[8vh] flex max-h-[calc(92dvh-1rem)] max-w-md translate-y-0 flex-col gap-3"
        data-matrix-add-members
      >
        <DialogHeader>
          <DialogTitle>{copy.addTitle}</DialogTitle>
        </DialogHeader>
        <GroupPicker
          adornments={adornments}
          candidates={candidates}
          disabled={pending}
          filter={draft.filter}
          found={draft.found}
          members={members}
          onFilterChange={draft.setFilter}
          onFound={draft.addFound}
          onQueryChange={draft.setQuery}
          onToggle={draft.toggle}
          query={draft.query}
          selected={draft.selected}
          snapshot={snapshot}
        />
        <DialogDescription className="border-t border-(--atum-line) pt-2.5 !text-(length:--atum-t-caption) !leading-(--atum-lh-caption)">
          {room.encrypted ? roster.historyRule : roster.historyShared}
        </DialogDescription>
        {failed && (
          <NoticeBand role="alert" tone="failure">
            {copy.addFailed}
          </NoticeBand>
        )}
        <DialogFooter>
          <Button disabled={pending} onClick={() => onOpenChange(false)} type="button" variant="ghost">
            {t.common.cancel}
          </Button>
          <Button disabled={!canAdd} onClick={() => void add()} type="button">
            {pending ? copy.adding : copy.add(picks.length)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
