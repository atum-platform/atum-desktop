import { type FormEvent, useEffect, useId, useState } from 'react'

import { AtumSegmented } from '@/components/ui/atum-segmented'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Hash, Lock } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { MatrixCompanyBridge } from '../../../shared/matrix-company'
import type { CompanyChannelVisibility14 } from '../../../shared/matrix-company-team-space'
import { focusDialogField, MatrixDialogHeader } from '../dialog-header'
import { MatrixTeammateAvatar } from '../member-avatar'

import type { CompanyAbilities } from './abilities'
import { ChannelPeoplePicker } from './channel-people-picker'
import { addToChannel, type ChannelAddResult } from './commands'
import { useTeamSpaceCopy } from './copy'
import { outcomeText, type TeamSpaceMutate } from './outcome'
import { type CompanyChannelView, type RosterMember, rosterName } from './views'

export interface ChannelCreateDialogProps {
  open: boolean
  onClose(): void
  bridge: MatrixCompanyBridge
  companyId: string
  abilities: Pick<CompanyAbilities, 'createChannel' | 'createPrivateChannel' | 'creationBlocked'>
  /** The company's people, to pick who starts in the new channel. */
  roster: readonly RosterMember[]
  /** The channels already in the directory, so a taken public name is said before it is sent. */
  channels: readonly Pick<CompanyChannelView, 'displayName' | 'visibility'>[]
  mutate: TeamSpaceMutate
  /** The platform admitted the new channel; the workspace opens it once its room is ready. */
  onCreated(channelId: string): void
  /** People were added to the new channel after it was made: the workspace reads the directory again. */
  onChanged(): void
}

const NAME_MAX = 80
const PURPOSE_MAX = 500
const length = (value: string) => [...value].length

/** A pick the platform no longer finds in the company: a retry cannot bring them back. */
const leftCompany = (result: ChannelAddResult) => result.state === 'failed' && result.outcome.reason === 'channel_unavailable'

/** Who a Try again could still add: refused for any reason but having left the company. */
const retryable = (results: readonly ChannelAddResult[]) =>
  results.filter(result => result.state === 'failed' && !leftCompany(result)).map(result => result.memberRef)

type Phase =
  | { kind: 'form' }
  | { kind: 'adding'; channelId: string }
  | { kind: 'result'; channelId: string; results: ChannelAddResult[] }

/** The name's inline problem, if any: empty once touched, too long, or a public name already taken. */
export function channelNameProblem(
  name: string,
  visibility: CompanyChannelVisibility14,
  channels: readonly Pick<CompanyChannelView, 'displayName' | 'visibility'>[]
): 'required' | 'too-long' | 'taken' | undefined {
  const trimmed = name.trim()

  if (length(trimmed) === 0) {
    return 'required'
  }

  if (length(trimmed) > NAME_MAX) {
    return 'too-long'
  }

  // The platform keeps public names unique per company, exactly as typed (private ones may repeat).
  if (visibility === 'public' && channels.some(channel => channel.visibility === 'public' && channel.displayName === trimmed)) {
    return 'taken'
  }

  return undefined
}

/**
 * "Create a channel", after Mattermost's new-channel modal: a name (with the channel's mark, `#` or a
 * lock, in the field), an optional description, Public or Private, and the people who start in it
 * (Mattermost's "Add members", asked at creation as Slack's create flow does), public or private.
 * Problems are said under the field they belong to as the person types.
 *
 * The picks travel in the create command itself (company channel command 1.1 `initialMemberRefs`): the
 * platform makes the channel and admits everyone in one step, with no invitation to accept. The room is
 * made by the hosted manager, never here; once the platform admits the channel the workspace opens it.
 * The create is all-or-nothing, so when a pick is no longer in the company the channel is made without
 * the picks and each is added on its own; whoever still could not be added is listed with a Try again,
 * and the channel is never lost to one person.
 */
export function ChannelCreateDialog({ abilities, bridge, channels, companyId, mutate, onChanged, onClose, onCreated, open,
  roster }: ChannelCreateDialogProps) {
  const { company, team } = useTeamSpaceCopy()
  const nameId = useId()
  const purposeId = useId()
  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)
  const [purpose, setPurpose] = useState('')
  const [visibility, setVisibility] = useState<CompanyChannelVisibility14>('public')
  const [picked, setPicked] = useState<string[]>([])
  const [phase, setPhase] = useState<Phase>({ kind: 'form' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [nameTaken, setNameTaken] = useState<string>()

  useEffect(() => {
    if (open) {
      setName('')
      setTouched(false)
      setPurpose('')
      setVisibility('public')
      setPicked([])
      setPhase({ kind: 'form' })
      setBusy(false)
      setError(undefined)
      setNameTaken(undefined)
    }
  }, [open])

  const trimmed = name.trim()
  // A company without private channels creates the public channel it always did.
  const chosenVisibility: CompanyChannelVisibility14 = abilities.createPrivateChannel ? visibility : 'public'
  const localProblem = channelNameProblem(name, chosenVisibility, channels)
  const problem = localProblem ?? (nameTaken !== undefined && nameTaken === trimmed ? 'taken' : undefined)
  const purposeTooLong = length(purpose.trim()) > PURPOSE_MAX
  const valid = !problem && !purposeTooLong

  const nameMessage =
    problem === 'too-long'
      ? team.channelNameTooLong
      : problem === 'taken'
        ? team.refusal.channel_name_conflict
        : problem === 'required' && touched
          ? team.channelNameRequired
          : undefined

  // The dialog can outlive the standing it was opened under (a demotion, a policy set to admins only, the controller
  // going down): then it says so and offers nothing. The send is checked again as it leaves.
  const allowed = abilities.createChannel

  const blockedReason =
    abilities.creationBlocked === 'rooms'
      ? team.browseRoomsNotReady
      : abilities.creationBlocked === 'restricted'
        ? team.browseCreateRestricted
        : team.noLongerAllowed

  const add = async (channelId: string, memberRefs: readonly string[], earlier: readonly ChannelAddResult[] = []) => {
    setPhase({ kind: 'adding', channelId })

    const results = await addToChannel(bridge, mutate, { companyId, channelId }, memberRefs)

    onChanged()
    // A retry answers in place: each person keeps their row.
    const merged = earlier.length === 0 ? results : earlier.map(result => results.find(next => next.memberRef === result.memberRef) ?? result)

    if (merged.some(result => result.state === 'failed')) {
      setPhase({ kind: 'result', channelId, results: merged })

      return
    }

    onClose()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)

    if (!valid || busy || !allowed) {
      return
    }

    setBusy(true)
    setError(undefined)

    const create = (initialMemberRefs: readonly string[]) =>
      mutate({
        action: 'channel-command',
        companyId,
        command: {
          requestId: globalThis.crypto.randomUUID(),
          operation: 'create',
          displayName: trimmed,
          visibility: chosenVisibility,
          ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
          initialMemberRefs: [...initialMemberRefs]
        }
      })

    let outcome = await create(picked)

    // The create and its picks commit together, so one pick who left the company refuses the whole command and
    // nothing was made. Make the channel without the picks, then add each one: only that person is left out.
    if (outcome && !outcome.ok && !outcome.uncertain && outcome.reason === 'channel_unavailable' && picked.length > 0) {
      outcome = await create([])
    }

    if (!outcome) {
      setBusy(false)

      return
    }

    if (outcome.ok) {
      const { value } = outcome
      const channelId = 'channelId' in value ? value.channelId : undefined

      if (channelId) {
        onCreated(channelId)
      }

      // Anyone the answer does not list as admitted (after the fallback, every pick) is added on their own.
      const listed = new Set('admissions' in value ? value.admissions.map(admission => admission.memberRef) : [])
      const left = picked.filter(memberRef => !listed.has(memberRef))

      if (channelId && left.length > 0) {
        await add(channelId, left)
        setBusy(false)

        return
      }

      setBusy(false)
      onClose()

      return
    }

    setBusy(false)

    if (outcome.uncertain) {
      // The answer was lost: the workspace keeps the request and offers Retry.
      onClose()

      return
    }

    if (outcome.reason === 'channel_name_conflict') {
      setNameTaken(trimmed)

      return
    }

    setError(outcomeText(outcome, team, company))
  }

  const retry = async () => {
    if (phase.kind !== 'result' || busy) {
      return
    }

    setBusy(true)
    await add(phase.channelId, retryable(phase.results), phase.results)
    setBusy(false)
  }

  const failure = (result: Extract<ChannelAddResult, { state: 'failed' }>) =>
    leftCompany(result) ? team.channelPersonLeftCompany : outcomeText(result.outcome, team, company)

  const personName = (memberRef: string) => {
    const person = roster.find(member => member.memberRef === memberRef)

    return person ? rosterName(person, company.someone) : company.someone
  }

  const ChannelMark = chosenVisibility === 'private' ? Lock : Hash

  return (
    <Dialog onOpenChange={next => !next && !busy && onClose()} open={open}>
      <DialogContent
        aria-describedby={undefined}
        className="atum-sheet max-w-md"
        data-matrix-company-create-channel
        onOpenAutoFocus={focusDialogField}
        showCloseButton={false}
      >
        {phase.kind === 'result' ? (
          <>
            <MatrixDialogHeader description={team.channelAddsFailed} title={team.channelCreatedTitle(trimmed)} />
            <ul aria-label={team.addPeopleTitle} className="grid max-h-64 gap-1 overflow-y-auto" data-matrix-channel-add-results>
              {phase.results.map(result => {
                const label = personName(result.memberRef)
                const person = roster.find(member => member.memberRef === result.memberRef)

                return (
                  <li className="flex items-center gap-2.5 px-1 py-1 text-sm text-(--ak-ink)" data-matrix-channel-add-result={result.state}
                    key={result.memberRef}>
                    <MatrixTeammateAvatar className="size-6 text-[0.5625rem] leading-none" name={label}
                      person={person ?? { memberRef: result.memberRef, displayName: label }} />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    {result.state === 'failed' ? (
                      <span className="max-w-[60%] truncate text-xs text-destructive" title={failure(result)}>
                        {failure(result)}
                      </span>
                    ) : (
                      <span className="shrink-0 text-xs text-(--ak-ink-3)">
                        {result.state === 'added' ? team.channelPersonAdded : team.working}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
            <DialogFooter>
              <Button disabled={busy} onClick={onClose} type="button" variant="ghost">{team.channelInvitesDone}</Button>
              {retryable(phase.results).length > 0 && (
                <Button disabled={busy} onClick={() => void retry()} type="button">
                  {busy ? team.working : team.channelInviteRetry}
                </Button>
              )}
            </DialogFooter>
          </>
        ) : (
          <>
            <MatrixDialogHeader description={team.createChannelBody} title={team.createChannelTitle} />
            <form className="grid gap-4" noValidate onSubmit={event => void submit(event)}>
              <div>
                <label className="ak-field-label" htmlFor={nameId}>{team.channelNameLabel}</label>
                <div className={cn('ak-field', nameMessage && 'ak-field--error')}>
                  <ChannelMark aria-hidden className="ak-icon ak-icon--sm shrink-0 text-(--ak-ink-3)" />
                  <input
                    aria-describedby={nameMessage ? `${nameId}-help` : undefined}
                    aria-invalid={nameMessage ? true : undefined}
                    disabled={busy}
                    id={nameId}
                    maxLength={NAME_MAX * 2}
                    onBlur={() => trimmed === '' && name !== '' && setTouched(true)}
                    onChange={event => {
                      setName(event.target.value)
                      setTouched(true)
                    }}
                    placeholder={team.channelNamePlaceholder}
                    value={name}
                  />
                </div>
                {nameMessage && (
                  <p className="ak-field-help ak-field-help--error" data-matrix-channel-name-problem={problem} id={`${nameId}-help`}>
                    {nameMessage}
                  </p>
                )}
              </div>

              <div>
                <div className="flex items-baseline justify-between gap-2">
                  <label className="ak-field-label" htmlFor={purposeId}>{team.channelPurposeLabel}</label>
                  <span className="text-xs text-(--ak-ink-3)">{team.channelPurposeOptional}</span>
                </div>
                <div className={cn('ak-field', purposeTooLong && 'ak-field--error')}>
                  <input
                    aria-invalid={purposeTooLong || undefined}
                    data-matrix-channel-purpose
                    disabled={busy}
                    id={purposeId}
                    maxLength={PURPOSE_MAX + 100}
                    onChange={event => setPurpose(event.target.value)}
                    placeholder={team.channelPurposePlaceholder}
                    value={purpose}
                  />
                </div>
                {purposeTooLong && <p className="ak-field-help ak-field-help--error">{team.channelPurposeTooLong}</p>}
              </div>

              {abilities.createPrivateChannel && (
                <div>
                  <span className="ak-field-label">{team.channelVisibilityLabel}</span>
                  <AtumSegmented<CompanyChannelVisibility14>
                    disabled={busy}
                    label={team.channelVisibilityLabel}
                    onChange={setVisibility}
                    options={[
                      { id: 'public', label: team.visibilityPublic },
                      { id: 'private', label: team.visibilityPrivate }
                    ]}
                    value={visibility}
                  />
                  <p className="ak-field-help">
                    {visibility === 'private' ? team.visibilityPrivateHint : team.visibilityPublicHint}
                  </p>
                </div>
              )}

              <div data-matrix-channel-create-people>
                <span className="ak-field-label">{team.addPeopleTitle}</span>
                <ChannelPeoplePicker disabled={busy} onChange={setPicked} picked={picked} roster={roster} />
              </div>

              {!allowed && <p className="text-sm text-destructive" data-matrix-company-not-allowed role="alert">{blockedReason}</p>}
              {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
              <DialogFooter>
                <Button disabled={busy} onClick={onClose} type="button" variant="ghost">{company.cancel}</Button>
                <Button disabled={!valid || busy || !allowed} type="submit">
                  {phase.kind === 'adding'
                    ? team.addingPeople
                    : busy
                      ? team.creatingChannel
                      : team.createChannelSubmit}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
