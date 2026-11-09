import type { MatrixCompanyMutation } from '../../../shared/matrix-company'
import type { CompanyRole13 } from '../../../shared/matrix-company-team-space'

import {
  channelAbilities,
  type CompanyAbilities,
  invitationAbilities,
  memberAbilities,
  type TeamSpaceProfile
} from './abilities'
import { channelFactsOf, type CompanyChannelView, type InvitationRow, type RosterMember } from './views'

/** What the workspace holds about the viewer's standing in the selected company, as of this moment. */
export interface SendingStanding {
  companyId: string | undefined
  profile: TeamSpaceProfile
  viewerRole: CompanyRole13 | undefined
  abilities: CompanyAbilities
  roster: readonly RosterMember[]
  invitations: readonly InvitationRow[]
  channels: readonly CompanyChannelView[] | undefined
  /** Whether discovery has answered for this account: before it, the 1.5 probe is not known, which is not "off". */
  discovered?: boolean
  /**
   * Whether the conversation directory can authorize now: undefined before it is read, false once it is stale or was
   * refused. A change that rests on it is not sent on a directory that cannot authorize.
   */
  conversationsUsable?: boolean
}

type ChannelCommandMutation = Extract<MatrixCompanyMutation, { action: 'channel-command' }>

/** What the standing held now says about a change: still the viewer's, no longer the viewer's, or not known well enough to say. */
export type SendVerdict = 'allowed' | 'changed' | 'unknown'

type Check = boolean | 'unknown'

const DESTRUCTIVE_CHANNEL_OPERATIONS: ReadonlySet<string> = new Set(['leave', 'archive', 'remove'])

/**
 * The changes that cannot be taken back: handing the company over, removing a person, archiving a channel, leaving a
 * channel or the company. These are never sent on a guess: when the authority or the target is not known they wait.
 */
function isDestructive(mutation: MatrixCompanyMutation): boolean {
  switch (mutation.action) {
    case 'ownership-transfer':
    case 'remove-member':
    case 'leave':
      return true

    case 'channel-command':
      return DESTRUCTIVE_CHANNEL_OPERATIONS.has(mutation.command.operation)

    default:
      return false
  }
}

function mayStillCommand(mutation: ChannelCommandMutation, standing: SendingStanding): Check {
  const { abilities, channels, profile, viewerRole } = standing
  const { command } = mutation

  if (command.operation === 'create') {
    return abilities.createChannel && (command.visibility !== 'private' || abilities.createPrivateChannel)
  }

  const view = channels?.find(channel => channel.id === mutation.channelId)

  if (!view) {
    return isDestructive(mutation) ? 'unknown' : true
  }

  const can = channelAbilities(profile, viewerRole, channelFactsOf(view))

  switch (command.operation) {
    case 'leave':
      return can.leave

    case 'archive':
      return can.archive

    case 'restore':
      return can.restore

    case 'update_metadata':
      return can.edit

    case 'invite':
      return can.addPeople

    case 'remove':
      return can.removeMembers

    // Joining and answering one's own invitation are the person's own; the platform refuses what is not allowed.
    default:
      return true
  }
}

/**
 * Whether the viewer may still send this change, by the standing the workspace holds *now*. A dialog opened under one role
 * can outlive it (a demotion, a hand-over, a policy change), and the control that opened it would send on its old
 * closure. Every change passes here at the moment it is sent, so the screen's answer, not the dialog's, decides.
 *
 * What this module does not know it does not deny for an ordinary or self-service change: the platform stays decisive,
 * and a missing answer is not a reason to refuse. A destructive change (see `isDestructive`) is the exception: with the
 * viewer's authority or the target unknown it is `unknown`, and waits until the screen has read them.
 */
export function sendVerdict(mutation: MatrixCompanyMutation, standing: SendingStanding): SendVerdict {
  const verdict = checkStanding(mutation, standing)

  return verdict === 'unknown' ? 'unknown' : verdict ? 'allowed' : 'changed'
}

/** `sendVerdict` as a yes/no: only an `allowed` change goes out. */
export function mayStillSend(mutation: MatrixCompanyMutation, standing: SendingStanding): boolean {
  return sendVerdict(mutation, standing) === 'allowed'
}

const isConversationChange = (mutation: MatrixCompanyMutation) => mutation.action.startsWith('conversation-')

function checkStanding(mutation: MatrixCompanyMutation, standing: SendingStanding): Check {
  const { abilities, invitations, profile, roster, viewerRole } = standing

  // Company DMs and group DMs ask nothing of the viewer's role: they ask whether the family is on (the 1.5 probe) and
  // whether the directory they rest on can authorize. This holds for a retry too. Before discovery has answered the
  // probe is not known, so it is not decided either way.
  if (isConversationChange(mutation)) {
    if (standing.discovered === false) {
      return 'unknown'
    }

    return profile.conversations && standing.conversationsUsable !== false
  }

  if (!viewerRole || !('companyId' in mutation) || mutation.companyId !== standing.companyId) {
    return isDestructive(mutation) ? 'unknown' : true
  }

  const active = roster.filter(member => member.state === 'active').length

  switch (mutation.action) {
    case 'invite':
      return abilities.invite

    // A direct add is never wider than an invitation (1.12): the same standing decides it, and the platform decides the rest.
    case 'invitation-create':
    case 'invitation-create-directory':
    case 'member-add':
      return abilities.invite && (mutation.role !== 'admin' || abilities.inviteAdmin)

    // Email invitations are always as a member.
    case 'email-invitation-create':
      return abilities.invite

    case 'invite-link-create':
      return abilities.inviteLink

    case 'invite-link-revoke':
      return abilities.revokeInviteLink

    case 'role-change':
      return abilities.changeRoles

    case 'ownership-transfer':
      return abilities.transferOwnership

    case 'policy-update':
    case 'set-avatar':
      return abilities.editPolicy

    case 'invitation-resend':
    case 'invitation-cancel': {
      const invitation = invitations.find(row => row.id === mutation.invitationId)

      if (!invitation) {
        return true
      }

      const can = invitationAbilities(profile, viewerRole, invitation.role)

      return mutation.action === 'invitation-resend' ? can.resend : can.cancel
    }

    case 'remove-member': {
      const target = roster.find(member => member.memberRef === mutation.memberRef)

      if (!target) {
        return 'unknown'
      }

      // Cancelling a pending 1.1 invitation is a removal of someone who has not joined: the inviting role's to do.
      return target.state === 'invited' ? abilities.invite : memberAbilities(profile, viewerRole, target, active).remove
    }

    case 'leave': {
      const self = roster.find(member => member.self)

      return self ? memberAbilities(profile, viewerRole, self, active).leave : 'unknown'
    }

    case 'channel-command':
      return mayStillCommand(mutation, standing)

    default:
      return true
  }
}
