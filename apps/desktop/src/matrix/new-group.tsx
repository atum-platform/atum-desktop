import { useEffect, useRef, useState } from 'react'

import { AtumAssistantAvatar } from '@/app/atum/assistant-avatar'
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
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { Users } from '@/lib/icons'

import type { MatrixSnapshot } from '../../shared/matrix'

import { useCreationAction } from './creation-action'
import { GroupPicker, type GroupPickerAdornments, useGroupPickerDraft } from './group-picker'
import { useGroupPickerCopy } from './group-picker-copy'
import { type GroupCandidate, groupCandidates, groupCreationPlan } from './group-picker-model'
import { useRosterCreateCopy } from './roster-create-copy'
import { runMatrixCommand } from './text-document-actions'

export interface MatrixNewGroupProps {
  open: boolean
  onOpenChange(open: boolean): void
  snapshot: MatrixSnapshot
  /** The group exists (Matrix selects it); the shell closes its drawer. */
  onCreated(): void
  /** Marks and status dots for rows, from the lanes that own them. */
  adornments?(candidate: GroupCandidate): GroupPickerAdornments | undefined
}

/** Preserve user-visible identity, state and recovery behavior across connection changes. */
export function MatrixNewGroup({ adornments, onCreated, onOpenChange, open, snapshot }: MatrixNewGroupProps) {
  const copy = useGroupPickerCopy()
  const roster = useRosterCreateCopy()
  const { locale, t } = useI18n()
  const [name, setName] = useState('')
  const draft = useGroupPickerDraft()
  const action = useCreationAction()
  const openRef = useRef(open)
  const { pending, failed } = action
  const ready = snapshot.state === 'ready'
  const appsBridge = window.atumMatrix?.apps

  const candidates = groupCandidates({
    snapshot,
    mode: 'create',
    locale,
    assistantName: t.matrixShell.assistantName
  })

  const plan = groupCreationPlan(name, draft.selected)
  // The face shows the group's own name only: a default named after its members would wear
  // the first member's initial and read as that person's chat.
  const face = name.trim()
  const canCreate = ready && !pending && plan !== null && (plan.kind === 'room' || Boolean(appsBridge))

  useEffect(() => {
    openRef.current = open
  }, [open])

  const close = () => onOpenChange(false)

  const create = () => {
    if (!canCreate || !plan) {
      return
    }

    action.run(
      () =>
        plan.kind === 'room'
          ? runMatrixCommand({ kind: 'create', name: plan.name, invite: plan.invite, direct: false }).then(() => true)
          : // Main asks to confirm with the app's disclosure; declining there keeps this open.
            appsBridge!.group(plan.appId, plan.name, locale).then(roomId => Boolean(roomId)),
      () => {
        setName('')
        draft.reset()

        // Matrix selects the new group either way; only a dialog still open hands over to it.
        if (openRef.current) {
          close()
          onCreated()
        }
      }
    )
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        // Anchored near the top like the start menu: filtering shortens the list without the
        // dialog jumping, and in a short window only the list gives way.
        className="top-[8vh] flex max-h-[calc(92dvh-1rem)] max-w-md translate-y-0 flex-col gap-3"
        data-matrix-new-group
      >
        <DialogHeader>
          <DialogTitle>{copy.createTitle}</DialogTitle>
        </DialogHeader>
        <form
          // The dialog's own gap is zeroed in the shell (styles.css): the space to the search
          // box is this margin, so the name row and the picker read as two things.
          className="mb-4 flex min-w-0 items-center gap-3"
          id="matrix-new-group"
          onSubmit={event => {
            event.preventDefault()
            create()
          }}
        >
          {/* The group's face as it will look: its initial once it has a name. */}
          <span aria-hidden className="shrink-0" data-matrix-new-group-face>
            {face ? (
              <AtumAssistantAvatar
                className="size-11 rounded-full text-[1rem] leading-none"
                id={`new-group:${face}`}
                name={face}
              />
            ) : (
              <span className="grid size-11 place-items-center rounded-full border border-dashed border-(--atum-line-strong,var(--atum-line)) text-(--atum-ink-muted)">
                <Users className="size-5" strokeWidth={1.6} />
              </span>
            )}
          </span>
          <Input
            aria-label={copy.groupName}
            autoFocus
            className="atum-input h-10 min-w-0 flex-1"
            disabled={pending}
            id="matrix-new-group-name"
            maxLength={200}
            onChange={event => setName(event.target.value)}
            placeholder={copy.groupNamePlaceholder}
            value={name}
          />
        </form>
        <GroupPicker
          adornments={adornments}
          candidates={candidates}
          disabled={pending}
          filter={draft.filter}
          found={draft.found}
          onFilterChange={draft.setFilter}
          onFound={draft.addFound}
          onQueryChange={draft.setQuery}
          onToggle={draft.toggle}
          query={draft.query}
          selected={draft.selected}
          snapshot={snapshot}
        />
        {/* The history rule, said once and plainly; it is also what the dialog announces.
            Caption-sized: a footnote to creating. */}
        <DialogDescription
          className="border-t border-(--atum-line) pt-2.5 !text-(length:--atum-t-caption) !leading-(--atum-lh-caption)"
          data-matrix-history-rule
        >
          {roster.historyShared}
        </DialogDescription>
        {failed && (
          <NoticeBand role="alert" tone="failure">
            {roster.groupFailed}
          </NoticeBand>
        )}
        <DialogFooter>
          <Button disabled={pending} onClick={close} type="button" variant="ghost">
            {t.common.cancel}
          </Button>
          <Button disabled={!canCreate} form="matrix-new-group" type="submit">
            {pending ? roster.creating : roster.createGroup}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
