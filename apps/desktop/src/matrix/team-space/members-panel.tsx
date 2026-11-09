import { useStore } from '@nanostores/react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { MoreHorizontal } from '@/lib/icons'

import type { CompanyRole13 } from '../../../shared/matrix-company-team-space'
import { MatrixTeammateAvatar } from '../member-avatar'
import { PersonHandleLine } from '../person-handle-line'
import { $matrixHandles } from '../person-handles'
import { $matrixPresence, resolveMatrixTeammatePresence } from '../presence-store'
import { MatrixPresenceLine } from '../presence-view'

import { memberAbilities, type TeamSpaceProfile } from './abilities'
import { useTeamSpaceCopy } from './copy'
import { type InvitationAction, PendingInvitationList } from './pending-invitations'
import { RoleBadge } from './role-badge'
import { type InvitationRow, type RosterMember, rosterName } from './views'

export type MemberAction = 'cancel-invited' | 'leave' | 'make-admin' | 'make-member' | 'make-owner' | 'remove'
export type { InvitationAction } from './pending-invitations'

export interface MembersPanelProps {
  rows: readonly RosterMember[]
  invitations: readonly InvitationRow[]
  profile: TeamSpaceProfile
  viewer: CompanyRole13 | undefined
  canInvite: boolean
  /** A change is running or waiting to be retried: nothing else may start. */
  blocked: boolean
  nowSeconds: number
  onInvite(): void
  onMemberAction(action: MemberAction, member: RosterMember): void
  onInvitationAction(action: InvitationAction, invitation: InvitationRow): void
  /** The right-side channel panel supplies its own heading and edge. */
  panel?: boolean
}

/**
 * The company roster. Before C1 it is the 1.1 list with its text buttons; with C1 each person carries
 * a role and one menu of only what the viewer may do to them, pending invitations sit beneath, and
 * a person being removed reads "Removing…" until the platform has witnessed it.
 */
export function MembersPanel({
  blocked,
  canInvite,
  invitations,
  nowSeconds,
  onInvitationAction,
  onInvite,
  onMemberAction,
  panel = false,
  profile,
  rows,
  viewer
}: MembersPanelProps) {
  const { company, team } = useTeamSpaceCopy()
  const active = rows.filter(row => row.state === 'active').length
  const presenceState = useStore($matrixPresence)
  const handleState = useStore($matrixHandles)

  return (
    <div className={panel ? 'grid gap-2' : 'grid gap-2 border-t border-(--atum-line) pt-5'} data-matrix-company-members>
      {(!panel || canInvite) && <div className="flex items-center justify-between gap-3">
        {!panel && <h3 className="text-(length:--atum-t-title) font-semibold text-(--atum-ink)">{company.membersTitle}</h3>}
        {canInvite && (
          <Button onClick={onInvite} size="sm" variant="secondary">
            {company.inviteAction}
          </Button>
        )}
      </div>}
      <ul aria-label={company.membersTitle} className="grid gap-2">
        {rows.map(member => {
          const name = rosterName(member, company.someone)

          const presence = resolveMatrixTeammatePresence(
            member,
            presenceState.users,
            handleState.owner === presenceState.owner ? handleState.byUser : {}
          )

          const state =
            member.state === 'invited'
              ? company.memberStateInvited
              : member.state === 'revoking'
                ? profile.admin
                  ? team.removing
                  : company.memberStateRevoking
                : ''

          const can = memberAbilities(profile, viewer, member, active)

          return (
            <li
              className="flex flex-wrap items-center gap-3 text-sm text-(--atum-ink)"
              data-member-role={profile.admin ? member.role : undefined}
              data-member-state={member.state}
              key={member.memberRef}
            >
              <MatrixTeammateAvatar className="size-8 shrink-0 text-xs" name={name} person={member} />
              <span className="grid min-w-0">
                <span className="truncate font-medium">
                  {name}
                  {member.self && profile.admin && <span className="ms-1.5 text-xs font-normal text-(--atum-ink-muted)">· {team.you}</span>}
                </span>
                <PersonHandleLine handle={member.handle} name={name} />
                <MatrixPresenceLine presence={presence} />
                {can.leaveBlockedByOwnership && (
                  <span className="text-xs text-(--atum-ink-muted)" data-owner-leave-hint>
                    {team.ownerLeaveHint}
                  </span>
                )}
              </span>
              <RoleBadge role={member.role} />
              {state && (
                <span aria-live="polite" className="text-xs text-(--atum-ink-muted)" role="status">
                  {state}
                </span>
              )}
              <span className="ms-auto flex gap-1">
                {profile.admin ? (
                  <MemberMenu
                    abilities={can}
                    blocked={blocked}
                    name={name}
                    onAction={action => onMemberAction(action, member)}
                  />
                ) : (
                  <>
                    {can.leave && (
                      <Button onClick={() => onMemberAction('leave', member)} size="sm" variant="text">
                        {company.leaveAction}
                      </Button>
                    )}
                    {can.remove && member.state === 'active' && (
                      <Button onClick={() => onMemberAction('remove', member)} size="sm" variant="text">
                        {company.removeAction}
                      </Button>
                    )}
                    {!member.self && viewer === 'admin' && member.state === 'invited' && (
                      <Button disabled={blocked} onClick={() => onMemberAction('cancel-invited', member)} size="sm" variant="text">
                        {company.cancelInviteAction}
                      </Button>
                    )}
                  </>
                )}
              </span>
            </li>
          )
        })}
      </ul>

      <div className="mt-4">
        <PendingInvitationList
          blocked={blocked}
          invitations={invitations}
          nowSeconds={nowSeconds}
          onInvitationAction={onInvitationAction}
          profile={profile}
          viewer={viewer}
        />
      </div>
    </div>
  )
}

function MemberMenu({
  abilities,
  blocked,
  name,
  onAction
}: {
  abilities: ReturnType<typeof memberAbilities>
  blocked: boolean
  name: string
  onAction(action: MemberAction): void
}) {
  const { team } = useTeamSpaceCopy()

  // One table, in the order the menu reads: promote, hand over, then the ways out.
  const items: ReadonlyArray<{ id: MemberAction; label: string; allowed: boolean; destructive?: boolean }> = [
    { id: 'make-admin', label: team.makeAdmin, allowed: abilities.makeAdmin },
    { id: 'make-member', label: team.makeMember, allowed: abilities.makeMember },
    { id: 'make-owner', label: team.makeOwner, allowed: abilities.makeOwner },
    { id: 'remove', label: team.removeFromCompany, allowed: abilities.remove, destructive: true },
    { id: 'leave', label: team.leaveCompany, allowed: abilities.leave, destructive: true }
  ]

  const allowed = items.filter(item => item.allowed)

  if (allowed.length === 0) {
    return null
  }

  const roleItems = allowed.filter(item => !item.destructive)
  const exitItems = allowed.filter(item => item.destructive)

  return (
    <DropdownMenu>
      <Tip label={team.memberActions(name)}>
        <DropdownMenuTrigger asChild>
          <button
            aria-label={team.memberActions(name)}
            className="atum-icon-btn size-7 shrink-0"
            data-member-menu
            disabled={blocked}
            type="button"
          >
            <MoreHorizontal aria-hidden className="size-4" />
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="min-w-52">
        {roleItems.map(item => (
          <DropdownMenuItem key={item.id} onSelect={() => onAction(item.id)}>
            {item.label}
          </DropdownMenuItem>
        ))}
        {roleItems.length > 0 && exitItems.length > 0 && <DropdownMenuSeparator />}
        {exitItems.map(item => (
          <DropdownMenuItem key={item.id} onSelect={() => onAction(item.id)} variant="destructive">
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
