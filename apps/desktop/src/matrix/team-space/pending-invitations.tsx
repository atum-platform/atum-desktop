import { AtumAssistantAvatar } from '@/app/atum/assistant-avatar'
import { Button } from '@/components/ui/button'

import type { CompanyEmailMailStatus, CompanyRole13 } from '../../../shared/matrix-company-team-space'

import { invitationAbilities, type TeamSpaceProfile } from './abilities'
import { useTeamSpaceCopy } from './copy'
import { RoleBadge } from './role-badge'
import { invitationDaysLeft, type InvitationRow } from './views'

export type InvitationAction = 'cancel' | 'resend'

/** An email invitation made in this sheet. The platform lists it nowhere, so only this opening knows it. */
export interface EmailInvitationRow {
  invitationId: string
  email: string
  expiresAt: number
  /** The mail state, once the server can tell it (invites 2). Without it the row says only that it went by email. */
  mailStatus?: CompanyEmailMailStatus
}

export interface PendingInvitationListProps {
  invitations: readonly InvitationRow[]
  emailInvitations?: readonly EmailInvitationRow[]
  profile: TeamSpaceProfile
  viewer: CompanyRole13 | undefined
  blocked: boolean
  nowSeconds: number
  onInvitationAction(action: InvitationAction, invitation: InvitationRow): void
  /** A narrow sheet: Member is the default and goes unsaid; only an admin invitation shows its role. */
  compact?: boolean
}

/**
 * Pending invitations, newest first: who (a circle and the @handle), when it runs out, who asked, and only
 * the actions this viewer holds (the owner every invitation, an admin the member ones). Shared by the members
 * panel and the Add people sheet, so an invitation reads and behaves the same in both.
 */
export function PendingInvitationList({
  blocked,
  compact = false,
  emailInvitations = [],
  invitations,
  nowSeconds,
  onInvitationAction,
  profile,
  viewer
}: PendingInvitationListProps) {
  const { company, team } = useTeamSpaceCopy()

  if (!profile.admin || (invitations.length === 0 && emailInvitations.length === 0)) {
    return null
  }

  const mailLabel: Record<CompanyEmailMailStatus, string> = {
    queued: team.inviteSheet.mailQueued,
    sent: team.inviteSheet.mailSent,
    failed: team.inviteSheet.mailFailed,
    cancelled: team.inviteSheet.mailCancelled
  }

  const expiryText = (expiresAt: number, expired: boolean) => {
    const days = invitationDaysLeft(expiresAt, nowSeconds)

    return expired ? team.invitationExpired : days === 0 ? team.invitationExpiresToday : team.invitationExpiresIn(days)
  }

  return (
    <div className="grid gap-2" data-matrix-company-invitations>
      <h3 className="text-(length:--atum-t-title) font-semibold text-(--atum-ink)">{team.pendingInvitations}</h3>
      <ul aria-label={team.pendingInvitations} className="grid gap-2">
        {emailInvitations.map(invitation => (
          <li className="flex items-center gap-3 text-sm text-(--atum-ink)" data-invitation-mail={invitation.mailStatus} data-invitation-state="email" key={invitation.invitationId}>
            <AtumAssistantAvatar className="size-7 shrink-0 rounded-full text-[0.625rem] leading-none" id={invitation.invitationId} name={invitation.email} />
            <span className="grid min-w-0">
              <span className="truncate font-medium">{invitation.email}</span>
              <span className="truncate text-xs text-(--atum-ink-muted)">
                {invitation.mailStatus ? mailLabel[invitation.mailStatus] : team.inviteSheet.byEmail} · {expiryText(invitation.expiresAt, invitation.expiresAt <= nowSeconds)}
              </span>
            </span>
          </li>
        ))}
        {invitations.map(invitation => {
          const can = invitationAbilities(profile, viewer, invitation.role)
          const inviter = invitation.inviter.displayName ?? (invitation.inviter.handle ? `@${invitation.inviter.handle}` : '')

          return (
            <li
              className={compact ? 'flex items-center gap-3 text-sm text-(--atum-ink)' : 'flex flex-wrap items-center gap-3 text-sm text-(--atum-ink)'}
              data-invitation-state={invitation.expired ? 'expired' : 'pending'}
              key={invitation.id}
            >
              <AtumAssistantAvatar className="size-7 shrink-0 rounded-full text-[0.625rem] leading-none" id={invitation.id} name={invitation.targetHandle} />
              <span className="grid min-w-0">
                <span className="truncate font-medium">@{invitation.targetHandle}</span>
                <span className="truncate text-xs text-(--atum-ink-muted)">
                  {expiryText(invitation.expiresAt, invitation.expired)}
                  {inviter ? ` · ${team.invitedBy(inviter)}` : ''}
                </span>
              </span>
              {(!compact || invitation.role === 'admin') && <RoleBadge role={invitation.role} />}
              <span className="ms-auto flex gap-1">
                {can.resend && (
                  <Button disabled={blocked} onClick={() => onInvitationAction('resend', invitation)} size="sm" variant="text">
                    {team.resendInvitation}
                  </Button>
                )}
                {can.cancel && (
                  <Button
                    aria-label={`${company.cancelInviteAction}: @${invitation.targetHandle}`}
                    disabled={blocked}
                    onClick={() => onInvitationAction('cancel', invitation)}
                    size="sm"
                    variant="text"
                  >
                    {team.cancelInvitation}
                  </Button>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
