import { type FormEvent, useEffect, useId, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

import { focusDialogField, MatrixDialogHeader } from '../dialog-header'
import { MatrixTeammateAvatar } from '../member-avatar'
import { PersonHandleLine, personHandleText } from '../person-handle-line'

import { useTeamSpaceCopy } from './copy'
import { outcomeText, type TeamSpaceMutate } from './outcome'
import { type CompanyConversationView, conversationViewFrom15 } from './views'

/** The most other people one conversation can take: nine in all, this person included (company-workspace/1.5). */
export const CONVERSATION_MAX_OTHERS = 8

export interface ConversationCandidate {
  memberRef: string
  name: string
  /** Their public @handle: shown under the name, and it finds them. */
  handle?: string | null
}

export type ConversationDialogMode =
  | { kind: 'new' }
  /** Adding people opens another conversation with the larger set; the source is untouched. */
  | { kind: 'add'; conversation: CompanyConversationView }

export interface ConversationDialogProps {
  open: boolean
  mode: ConversationDialogMode
  companyId: string
  /** The viewer's own member ref; without it no set can be built, so nothing is offered. */
  selfMemberRef: string | undefined
  /** Every active person in the company except the viewer. */
  people: readonly ConversationCandidate[]
  mutate: TeamSpaceMutate
  onClose(): void
  /**
   * The company on screen as of this call, as a fence: true only while it is still that company. Taken when Start is
   * pressed, before the request goes out, so an answer that comes back after the window moved on is told so.
   */
  begin(): () => boolean
  /** The platform opened (or found) the conversation; the workspace opens its room once it is ready, if `still`. */
  onOpened(conversation: CompanyConversationView, still: () => boolean): void
}

const fold = (value: string) =>
  value.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/gu, 'd').toLowerCase()

/**
 * "New message" (Mattermost's direct-message picker): choose one person for a direct message or several
 * for a group, then start. The set is atomic on the platform (the same people always open the same
 * conversation, however many times and in whatever order), so Start is safe to press twice. "Add
 * people" on an open conversation is the same picker with the current people kept and a plain
 * statement of what it does: a new conversation, with none of this one's history.
 */
export function ConversationDialog({ begin, companyId, mode, mutate, onClose, onOpened, open, people, selfMemberRef }: ConversationDialogProps) {
  const { company, team } = useTeamSpaceCopy()
  const [query, setQuery] = useState('')
  const ids = useId()
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (open) {
      setQuery('')
      setChosen(new Set())
      setBusy(false)
      setError(undefined)
    }
  }, [open, mode])

  const kept = useMemo(
    () => (mode.kind === 'add' ? mode.conversation.participants.map(participant => participant.memberRef) : []),
    [mode]
  )

  // Who may be picked: not the viewer, and (adding) not anyone already there.
  const candidates = people.filter(person => person.memberRef !== selfMemberRef && !kept.includes(person.memberRef))
  const needle = fold(query.trim().replace(/^@/u, ''))

  const visible = needle
    ? candidates.filter(person => fold(person.name).includes(needle) || fold(person.handle ?? '').includes(needle))
    : candidates

  // Others already in the set plus those picked now, this person on top: at most nine in all.
  const keptOthers = kept.filter(ref => ref !== selfMemberRef).length
  const total = keptOthers + chosen.size
  const full = total >= CONVERSATION_MAX_OTHERS
  const ready = Boolean(selfMemberRef) && chosen.size >= 1 && total <= CONVERSATION_MAX_OTHERS

  const toggle = (memberRef: string) =>
    setChosen(previous => {
      const next = new Set(previous)

      if (next.has(memberRef)) {
        next.delete(memberRef)
      } else if (keptOthers + next.size < CONVERSATION_MAX_OTHERS) {
        next.add(memberRef)
      }

      return next
    })

  const submit = async (event: FormEvent) => {
    event.preventDefault()

    if (!ready || busy || !selfMemberRef) {
      return
    }

    setBusy(true)
    setError(undefined)

    const still = begin()
    const requestId = globalThis.crypto.randomUUID()
    const participantMemberRefs = [...new Set([selfMemberRef, ...kept, ...chosen])]

    const outcome = await mutate(
      mode.kind === 'add'
        ? { action: 'conversation-expand', companyId, requestId, sourceConversationId: mode.conversation.id, participantMemberRefs }
        : { action: 'conversation-open', companyId, requestId, participantMemberRefs }
    )

    setBusy(false)

    if (!outcome) {
      return
    }

    if (outcome.ok) {
      onClose()

      if ('conversation' in outcome.value) {
        onOpened(conversationViewFrom15(outcome.value.conversation), still)
      }

      return
    }

    if (outcome.uncertain) {
      // The answer was lost: the workspace keeps the request and offers Retry, which replays the same one.
      onClose()

      return
    }

    setError(outcomeText(outcome, team, company))
  }

  const title = mode.kind === 'add' ? team.addPeople : team.newMessage

  return (
    <Dialog onOpenChange={next => !next && !busy && onClose()} open={open}>
      <DialogContent
        aria-describedby={undefined}
        className="atum-sheet max-w-md"
        data-matrix-company-conversation-dialog={mode.kind}
        onOpenAutoFocus={focusDialogField}
        showCloseButton={false}
      >
        <MatrixDialogHeader description={mode.kind === 'new' ? team.newMessageHint : undefined} title={title} />
        <form className="grid gap-3" onSubmit={event => void submit(event)}>
          <Input
            aria-label={team.addPeopleSearch}
            onChange={event => setQuery(event.target.value)}
            placeholder={team.addPeopleSearch}
            value={query}
          />
          {candidates.length === 0 ? (
            <p className="text-sm text-(--atum-ink-muted)">{team.newMessageNobody}</p>
          ) : visible.length === 0 ? (
            <p className="text-sm text-(--atum-ink-muted)">{team.peopleNoMatch}</p>
          ) : (
            <ul aria-label={team.addPeopleTitle} className="grid max-h-56 gap-0.5 overflow-y-auto">
              {visible.map(person => {
                const checked = chosen.has(person.memberRef)
                const handleId = personHandleText(person.handle) ? `${ids}-${person.memberRef}-handle` : undefined

                return (
                  <li key={person.memberRef}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-(--atum-r-control) px-2 py-1.5 text-sm text-(--atum-ink) hover:bg-(--atum-hover)">
                      <input
                        aria-describedby={handleId}
                        aria-label={person.name}
                        checked={checked}
                        className="size-4 accent-(--atum-accent)"
                        disabled={busy || (full && !checked)}
                        onChange={() => toggle(person.memberRef)}
                        type="checkbox"
                      />
                      <MatrixTeammateAvatar className="size-6 text-[0.5625rem] leading-none"
                        name={person.name} person={{ memberRef: person.memberRef, displayName: person.name }} />
                      <span className="min-w-0">
                        <span className="block truncate">{person.name}</span>
                        <PersonHandleLine handle={person.handle} id={handleId} name={person.name} />
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
          <p aria-live="polite" className="min-h-4 text-xs text-(--atum-ink-muted)" role="status">
            {full ? team.newMessageLimit : chosen.size > 0 ? team.peopleSelected(chosen.size) : ''}
          </p>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="text">{company.cancel}</Button>
            <Button disabled={!ready || busy} type="submit">
              {busy ? team.working : mode.kind === 'add' ? team.conversationAddConfirm : team.newMessageStart}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
