import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Loader } from '@/components/ui/loader'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Lock, X } from '@/lib/icons'

import type { MatrixCompanyBridge } from '../../../shared/matrix-company'
import { matrixCompanyBoardCopy } from '../../../shared/matrix-company-board-copy'
import type { CompanyChannelAdmission14 } from '../../../shared/matrix-company-team-space'
import {
  companyAIAvailability,
  companyAIAvailabilityLine,
  CompanyAIAvatar,
  useCompanyAIStatus
} from '../company-ai-status'
import { focusDialogField, MatrixDialogHeader } from '../dialog-header'
import { MatrixTeammateAvatar } from '../member-avatar'
import { useMatrixHandleContacts } from '../person-handle-contacts'
import { PersonHandleLine } from '../person-handle-line'
import { $matrixHandles } from '../person-handles'

import type { ChannelAbilities } from './abilities'
import { channelPeopleCandidates } from './channel-people-picker'
import { runChannelCommand } from './commands'
import { useTeamSpaceCopy } from './copy'
import { outcomeText, type TeamSpaceMutate } from './outcome'
import { PrivateCosMemberRow } from './private-cos-member-row'
import { requestTeamSpace } from './request'
import { type CompanyChannelView, type RosterMember, rosterName } from './views'

export interface ChannelMembersDialogProps {
  accountKey: string
  open: boolean
  onClose(): void
  bridge: MatrixCompanyBridge
  companyId: string
  channel: CompanyChannelView | undefined
  abilities: ChannelAbilities
  /** The company's people: names for the admissions, and who can still be added. */
  roster: readonly RosterMember[]
  mutate: TeamSpaceMutate
  /** The channel's people changed: the workspace looks at its directory again. */
  onChanged(): void
  /** The workspace's one private-CoS opener; the member row never provisions or selects a room itself. */
  onOpenPrivateCos?: () => Promise<void>
  /** Runs the workspace's private-CoS admission again (the row's Retry). */
  onRetryPrivateCos?: () => Promise<void>
  /** Header member stacks use the persistent right panel; add-people flows retain the form dialog. */
  presentation?: 'dialog' | 'panel'
}

type Members = { admissions: readonly CompanyChannelAdmission14[]; channelGeneration: number } | 'hidden'

/**
 * Who is in a channel and, for the people who may, adding and removing them. The platform sends the
 * list to the channel's owner and the company's owner and admins only; anyone else sees the count and
 * the reason. Removing someone from a public channel is not a ban, and `#general` cannot lose anyone
 * this way. Added people are invited: they are in once they accept.
 */
export function ChannelMembersDialog({ accountKey, abilities, bridge, channel, companyId, mutate, onChanged, onClose, open,
  onOpenPrivateCos, onRetryPrivateCos, presentation = 'dialog', roster }: ChannelMembersDialogProps) {
  const { company, team } = useTeamSpaceCopy()
  const { locale } = useI18n()
  const { view: companyAI } = useCompanyAIStatus(accountKey, companyId)
  const handleState = useStore($matrixHandles)
  useMatrixHandleContacts(handleState.owner, open ? [companyAI?.agent.userId] : [])
  // The Chief of Staff is a member only once the platform says it is ready (in the rooms, answering).
  // Before that it is one quiet line with its real state, never a member who never replies.
  const companyAIState = companyAI ? companyAIAvailability(companyAI) : undefined

  const companyAILine = companyAIState
    ? companyAIAvailabilityLine(companyAIState, matrixCompanyBoardCopy(locale))
    : undefined

  const [members, setMembers] = useState<Members>()
  const [failed, setFailed] = useState(false)
  const [status, setStatus] = useState<string>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const attempt = useRef(0)
  const channelId = channel?.id

  const load = useCallback(async () => {
    if (!channelId) {
      return
    }

    const mine = ++attempt.current

    if (!abilities.seeMembers) {
      setMembers('hidden')

      return
    }

    const result = await requestTeamSpace(bridge, { action: 'channel-members', companyId, channelId })

    if (attempt.current !== mine) {
      return
    }

    if (result.ok) {
      setMembers({ admissions: result.value.members, channelGeneration: result.value.channelGeneration })
      setFailed(false)
    } else if (result.error === 'denied' || result.error === 'missing') {
      setMembers('hidden')
    } else {
      setFailed(true)
    }
  }, [abilities.seeMembers, bridge, channelId, companyId])

  useEffect(() => {
    if (!open) {
      return
    }

    setMembers(undefined)
    setFailed(false)
    setStatus(undefined)
    setError(undefined)
    setQuery('')
    void load()

    return () => {
      attempt.current += 1
    }
  }, [load, open])

  const nameOf = (memberRef: string) => {
    const person = roster.find(member => member.memberRef === memberRef)

    return person ? rosterName(person, company.someone) : company.someone
  }

  const act = async (build: Parameters<typeof runChannelCommand>[3], done: string) => {
    if (!channel || busy) {
      return
    }

    setBusy(true)
    setError(undefined)
    setStatus(undefined)

    const outcome = await runChannelCommand(bridge, mutate, { companyId, channelId: channel.id }, build)

    setBusy(false)

    if (!outcome) {
      return
    }

    if (outcome.ok) {
      setStatus(done)
      onChanged()
      void load()

      return
    }

    if (outcome.uncertain) {
      onClose()

      return
    }

    setError(outcomeText(outcome, team, company))
    void load()
  }

  const admissions = members && members !== 'hidden' ? members.admissions : []
  const taken = new Set(admissions.filter(entry => ['active', 'invited', 'revoking'].includes(entry.state)).map(entry => entry.memberRef))
  // By name or @handle, accents ignored, as Create a channel's picker matches.
  const candidates = channelPeopleCandidates(roster, query).filter(person => !taken.has(person.memberRef))

  const body = (
    <div className="grid gap-4">
          {members === undefined && !failed && <Loader className="size-5" label={team.working} size="sm" />}
          {failed && <p className="text-sm text-destructive" role="alert">{team.membersLoadFailed}</p>}
          {members === 'hidden' && <p className="text-sm text-(--atum-ink-muted)">{team.memberListHidden}</p>}

          {members && members !== 'hidden' && (
            <div className="grid gap-2">
            <ul aria-label={team.channelMembersTitle} className="grid max-h-64 gap-1.5 overflow-y-auto">
              {companyAI && companyAIState === 'ready' && (
                <PrivateCosMemberRow
                  accountKey={accountKey}
                  companyId={companyId}
                  name={companyAI.agent.displayName}
                  onOpen={onOpenPrivateCos}
                  onOpened={onClose}
                  onOpenFailed={() => setError(team.conversationOpenFailed)}
                  onRetry={onRetryPrivateCos}
                  openLabel={team.openConversation(companyAI.agent.displayName)}
                  principal={companyAI.agent.principal}
                />
              )}
              {admissions
                .filter(entry => ['active', 'invited', 'revoking'].includes(entry.state))
                .map(entry => {
                  const person = roster.find(member => member.memberRef === entry.memberRef)
                  const mine = Boolean(person?.self)
                  const owner = entry.memberRef === channel?.ownerMemberRef

                  return (
                    <li className="flex flex-wrap items-center gap-2 text-sm text-(--atum-ink)" data-admission-state={entry.state} key={entry.memberRef}>
                      {person && <MatrixTeammateAvatar className="size-6 text-[0.5625rem] leading-none"
                        name={nameOf(entry.memberRef)} person={person} />}
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{nameOf(entry.memberRef)}</span>
                        <PersonHandleLine handle={person?.handle} name={nameOf(entry.memberRef)} />
                      </span>
                      {mine && <span className="text-xs text-(--atum-ink-muted)">· {team.you}</span>}
                      {owner && <span className="rounded-full border border-(--atum-line) px-2 py-0.5 text-xs text-(--atum-ink-muted)">{team.channelOwnerTag}</span>}
                      {entry.state === 'invited' && <span className="text-xs text-(--atum-ink-muted)">{team.memberPending}</span>}
                      {entry.state === 'revoking' && <span className="text-xs text-(--atum-ink-muted)" role="status">{team.removing}</span>}
                      {abilities.removeMembers && !mine && !owner && entry.state !== 'revoking' && (
                        <Button
                          className="ms-auto"
                          disabled={busy}
                          onClick={() =>
                            void act(
                              generations => ({
                                requestId: globalThis.crypto.randomUUID(),
                                operation: 'remove',
                                memberRef: entry.memberRef,
                                expectedChannelGeneration: generations.channel,
                                expectedAdmissionGeneration: entry.admissionGeneration
                              }),
                              team.personRemoved(nameOf(entry.memberRef))
                            )
                          }
                          size="sm"
                          variant="text"
                        >
                          {entry.state === 'invited' ? team.cancelChannelInvite : team.removeFromChannel}
                        </Button>
                      )}
                    </li>
                  )
                })}
            </ul>
            {companyAI && companyAILine && (
              <p className="flex items-center gap-2 text-sm text-(--atum-ink-muted)" data-company-ai-member-state={companyAIState}>
                <CompanyAIAvatar
                  className="size-6 shrink-0 text-[0.5625rem] leading-none opacity-60"
                  name={companyAI.agent.displayName}
                  principal={companyAI.agent.principal}
                />
                <span className="min-w-0"><span className="block truncate">{companyAI.agent.displayName} · {companyAILine}</span>
                  <PersonHandleLine handle={handleState.byUser[companyAI.agent.userId]} name={companyAI.agent.displayName} /></span>
              </p>
            )}
            </div>
          )}

          {abilities.addPeople && (
            <div className="grid gap-2 border-t border-(--atum-line) pt-3" data-matrix-company-add-people>
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-(--atum-ink)">
                <Lock aria-hidden className="size-3.5 text-(--atum-ink-muted)" />
                {team.addPeopleTitle}
              </h3>
              <Input aria-label={team.addPeopleSearch} onChange={event => setQuery(event.target.value)} placeholder={team.addPeopleSearch} value={query} />
              {candidates.length === 0 ? (
                <p className="text-sm text-(--atum-ink-muted)">{team.addPeopleEmpty}</p>
              ) : (
                <ul aria-label={team.addPeopleTitle} className="grid max-h-40 gap-1 overflow-y-auto">
                  {candidates.map(person => (
                    <li className="flex items-center justify-between gap-2 text-sm text-(--atum-ink)" key={person.memberRef}>
                      <span className="flex min-w-0 items-center gap-2">
                        <MatrixTeammateAvatar className="size-6 text-[0.5625rem] leading-none"
                          name={rosterName(person, company.someone)} person={person} />
                        <span className="min-w-0">
                          <span className="block truncate">{rosterName(person, company.someone)}</span>
                          <PersonHandleLine handle={person.handle} name={rosterName(person, company.someone)} />
                        </span>
                      </span>
                      <Button
                        aria-label={`${team.addPersonAction}: ${rosterName(person, company.someone)}`}
                        disabled={busy}
                        onClick={() =>
                          void act(
                            generations => ({
                              requestId: globalThis.crypto.randomUUID(),
                              operation: 'invite',
                              memberRef: person.memberRef,
                              expectedChannelGeneration: generations.channel
                            }),
                            team.personInvited(rosterName(person, company.someone))
                          )
                        }
                        size="sm"
                        variant="secondary"
                      >
                        {team.addPersonAction}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <p aria-live="polite" className="min-h-4 text-xs text-(--atum-ink-muted)" role="status">{status}</p>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    </div>
  )

  if (presentation === 'panel') {
    return open && channel ? (
      <aside
        aria-label={team.channelMembersTitle}
        className="absolute inset-y-0 end-0 z-30 flex w-[min(26rem,100%)] flex-col border-s border-(--atum-panel-line) bg-(--atum-main-bg) shadow-nous"
        data-matrix-company-channel-members-panel
      >
        <header className="flex h-(--atum-l-header) shrink-0 items-center gap-3 border-b border-(--atum-panel-line) px-5">
          <span className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-(--atum-ink)">{team.channelMembersTitle}</h2>
            <p className="truncate text-xs text-(--atum-ink-muted)">{team.channelMemberCount(channel.memberCount)}</p>
          </span>
          <Tip label={company.close}>
            <Button aria-label={company.close} onClick={onClose} size="icon-sm" variant="ghost">
              <X aria-hidden />
            </Button>
          </Tip>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{body}</div>
      </aside>
    ) : null
  }

  return (
    <Dialog onOpenChange={next => !next && onClose()} open={open && Boolean(channel)}>
      <DialogContent
        aria-describedby={undefined}
        className="atum-sheet max-w-md"
        data-matrix-company-channel-members
        onOpenAutoFocus={focusDialogField}
        showCloseButton={false}
      >
        <MatrixDialogHeader
          description={channel ? team.channelMemberCount(channel.memberCount) : undefined}
          title={team.channelMembersTitle}
        />
        {body}
      </DialogContent>
    </Dialog>
  )
}
