import type { z } from 'zod'

import {
  COMPANY_CHANNEL_COMMAND_PROFILE,
  COMPANY_CHANNEL_COMMAND_PROFILE_HEADER,
  COMPANY_INVITES_PROFILE,
  COMPANY_INVITES_PROFILE_2,
  COMPANY_INVITES_PROFILE_3,
  COMPANY_INVITES_PROFILE_HEADER,
  COMPANY_POLICY_DIRECT_ADD_PROFILE,
  COMPANY_POLICY_INVITES_PROFILE,
  COMPANY_POLICY_PROFILE_HEADER,
  type CompanyAdminSnapshot13Response,
  CompanyAdminSnapshot13ResponseSchema,
  CompanyAdminSnapshotPolicy3ResponseSchema,
  CompanyAdminSnapshotPolicy12ResponseSchema,
  CompanyAvatarSet17RequestSchema,
  CompanyAvatarSet17ResponseSchema,
  CompanyCapabilities13ResponseSchema,
  CompanyChannelAdmittedDirectory14ResponseSchema,
  CompanyChannelAdmittedSnapshot14Schema,
  CompanyChannelBrowse14ResponseSchema,
  CompanyChannelBrowse16ResponseSchema,
  CompanyChannelCommand14RequestSchema,
  CompanyChannelCommand14ResponseSchema,
  CompanyChannelCommand15RequestSchema,
  CompanyChannelCommand15ResponseSchema,
  CompanyChannelInvitation14ResponseSchema,
  CompanyChannelMembers14ResponseSchema,
  CompanyConversationDirectory15ResponseSchema,
  CompanyConversationExpand15RequestSchema,
  CompanyConversationHidden15RequestSchema,
  CompanyConversationHidden15ResponseSchema,
  CompanyConversationOpen15RequestSchema,
  CompanyConversationOpen15ResponseSchema,
  CompanyEmailInvitationCreate19RequestSchema,
  CompanyEmailInvitationCreate19ResponseSchema,
  CompanyEmailInvitationStatus19ResponseSchema,
  CompanyInvitationAdminAction13RequestSchema,
  CompanyInvitationCreate13RequestSchema,
  CompanyInvitationCreate13ResponseSchema,
  CompanyInvitationCreate110RequestSchema,
  CompanyInvitationCreate110ResponseSchema,
  CompanyInvitationMutation13ResponseSchema,
  CompanyInvitationResend13RequestSchema,
  CompanyInvitationResend13ResponseSchema,
  CompanyInvitationSelfAction13RequestSchema,
  CompanyInviteCapabilities2Schema,
  CompanyInviteCapabilities3Schema,
  CompanyInviteCapabilitiesSchema,
  CompanyInviteLinkCreateRequestSchema,
  CompanyInviteLinkCreateResponseSchema,
  CompanyInviteLinkListResponseSchema,
  CompanyInviteLinkPreviewRequestSchema,
  CompanyInviteLinkPreviewResponseSchema,
  CompanyInviteLinkRedeemRequestSchema,
  CompanyInviteLinkRedeemResponseSchema,
  CompanyInviteLinkRevokeRequestSchema,
  CompanyInviteLinkRevokeResponseSchema,
  CompanyMemberAdd112RequestSchema,
  CompanyMemberAdd112ResponseSchema,
  CompanyMemberAddReadiness112ResponseSchema,
  CompanyOwnershipTransfer13RequestSchema,
  CompanyOwnershipTransfer13ResponseSchema,
  CompanyPolicy3Schema,
  CompanyPolicyUpdate3RequestSchema,
  CompanyPolicyUpdate3ResponseSchema,
  CompanyPolicyUpdate13RequestSchema,
  CompanyPolicyUpdate13ResponseSchema,
  CompanyRoleChange13RequestSchema,
  CompanyRoleChange13ResponseSchema,
  isChannelCommand15,
  TEAM_SPACE_ADMIN_WIRE,
  TEAM_SPACE_AVATAR_WIRE,
  TEAM_SPACE_CHANNEL_WIRE,
  TEAM_SPACE_CONVERSATION_WIRE,
  TEAM_SPACE_DIRECT_ADD_WIRE,
  TEAM_SPACE_DIRECTORY_INVITE_WIRE,
  TEAM_SPACE_EMAIL_INVITE_WIRE,
  TEAM_SPACE_JOINABLE_BROWSE_WIRE,
  TEAM_SPACE_LINK_WIRE,
  type TeamSpaceRequest,
  TeamSpaceRequestSchema,
  type TeamSpaceValue
} from '../../shared/matrix-company-team-space'

import { companyConversationDigest } from './company-conversation-digest'

/**
 * Team Space C1/C2 and company-identity transport: the closed native request, the route and
 * `Atum-Company-Wire` value the frozen contract names for it, and the strict answer.
 *
 * The wire value follows the message family, never the renderer: administration is 1.3,
 * channels are 1.4, company conversations are 1.5, company avatars are 1.7, email invitations are 1.9, directory invitations are 1.10 and invite links are 1.2. A client that cannot use a family (discovery
 * said it is inactive, or the server is older and answered 400/404) keeps the earlier 1.1
 * actions; it never repeats a mutation on another wire after an unclear result.
 */
export interface TeamSpaceRoute {
  method: 'GET' | 'POST'
  path: string
  wire:
    | typeof TEAM_SPACE_ADMIN_WIRE
    | typeof TEAM_SPACE_AVATAR_WIRE
    | typeof TEAM_SPACE_CHANNEL_WIRE
    | typeof TEAM_SPACE_CONVERSATION_WIRE
    | typeof TEAM_SPACE_DIRECT_ADD_WIRE
    | typeof TEAM_SPACE_DIRECTORY_INVITE_WIRE
    | typeof TEAM_SPACE_EMAIL_INVITE_WIRE
    | typeof TEAM_SPACE_JOINABLE_BROWSE_WIRE
    | typeof TEAM_SPACE_LINK_WIRE
  /**
   * An additive profile on top of the wire, sent as its own header: company channel command 1.1, invite
   * readiness 1 on the capabilities read, company policy 1.2 on the administration read.
   */
  profile?:
    | { header: typeof COMPANY_CHANNEL_COMMAND_PROFILE_HEADER; value: typeof COMPANY_CHANNEL_COMMAND_PROFILE }
    | {
        header: typeof COMPANY_INVITES_PROFILE_HEADER
        value: typeof COMPANY_INVITES_PROFILE | typeof COMPANY_INVITES_PROFILE_2 | typeof COMPANY_INVITES_PROFILE_3
      }
    | { header: typeof COMPANY_POLICY_PROFILE_HEADER; value: typeof COMPANY_POLICY_INVITES_PROFILE | typeof COMPANY_POLICY_DIRECT_ADD_PROFILE }
  body?: Record<string, unknown>
}

/** A native request, or null when it is not in the closed vocabulary. */
export function parseTeamSpaceRequest(value: unknown): TeamSpaceRequest | null {
  const parsed = TeamSpaceRequestSchema.safeParse(value)

  if (!parsed.success) {
    return null
  }

  const request = parsed.data

  if (request.action === 'channel-command') {
    const { channelId, command } = request

    // Create names no channel yet; every other operation names exactly one.
    if ((command.operation === 'create') !== (channelId === undefined)) {
      return null
    }

    // Visibility is chosen once, at creation. The wire carries a visibility on update only so the
    // server can refuse a change; this client never offers one.
    if (command.operation === 'update_metadata' && command.visibility !== undefined) {
      return null
    }
  }

  // An address is only ever invited as a member: admin is a directory person's role, granted by the owner.
  if (request.action === 'member-add' && request.target.kind === 'email' && request.role !== 'member') {
    return null
  }

  return request
}

function body<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value)

  if (!parsed.success) {
    throw new Error('matrix_company_team_space_body')
  }

  return parsed.data
}

const CHANNEL_COMMAND_PATH: Record<string, string> = {
  add: 'members',
  join: 'join',
  leave: 'leave',
  invite: 'invite',
  accept: 'accept',
  decline: 'decline',
  cancel: 'cancel',
  remove: 'remove',
  update_metadata: 'update-metadata',
  archive: 'archive',
  restore: 'restore'
}

export function teamSpaceRoute(request: TeamSpaceRequest): TeamSpaceRoute {
  const admin = TEAM_SPACE_ADMIN_WIRE
  const avatar = TEAM_SPACE_AVATAR_WIRE
  const channels = TEAM_SPACE_CHANNEL_WIRE
  const links = TEAM_SPACE_LINK_WIRE
  const conversations = TEAM_SPACE_CONVERSATION_WIRE
  const joinableBrowse = TEAM_SPACE_JOINABLE_BROWSE_WIRE
  const company = 'companyId' in request ? `/companies/${request.companyId}` : ''

  switch (request.action) {
    case 'capabilities':
      return { method: 'GET', path: '/company-capabilities', wire: admin }

    case 'invite-readiness':
      return {
        method: 'GET',
        path: '/company-capabilities',
        wire: admin,
        profile: { header: COMPANY_INVITES_PROFILE_HEADER, value: request.profile ?? COMPANY_INVITES_PROFILE }
      }

    case 'administration':
      return { method: 'GET', path: `${company}/administration`, wire: admin }

    case 'administration-policy':
      return {
        method: 'GET',
        path: `${company}/administration`,
        wire: admin,
        profile: { header: COMPANY_POLICY_PROFILE_HEADER, value: request.profile ?? COMPANY_POLICY_INVITES_PROFILE }
      }

    case 'role-change': {
      const { memberRef, expectedAuthorityGeneration, requestId, role } = request

      return {
        method: 'POST',
        path: `${company}/role-change`,
        wire: admin,
        body: body(CompanyRoleChange13RequestSchema, { requestId, memberRef, role, expectedAuthorityGeneration })
      }
    }

    case 'ownership-transfer': {
      const { expectedAuthorityGeneration, requestId, targetMemberRef } = request

      return {
        method: 'POST',
        path: `${company}/ownership/transfer`,
        wire: admin,
        body: body(CompanyOwnershipTransfer13RequestSchema, { requestId, targetMemberRef, expectedAuthorityGeneration })
      }
    }

    case 'policy-update': {
      const { expectedAuthorityGeneration, policy, requestId } = request
      // All five fields are policy 1.3, sent under its profile; channel creation alone is the plain 1.3 update.
      const direct = CompanyPolicy3Schema.safeParse(policy).success

      return {
        method: 'POST',
        path: `${company}/policy`,
        wire: admin,
        ...(direct ? { profile: { header: COMPANY_POLICY_PROFILE_HEADER, value: COMPANY_POLICY_DIRECT_ADD_PROFILE } } : {}),
        body: body(direct ? CompanyPolicyUpdate3RequestSchema : CompanyPolicyUpdate13RequestSchema,
          { requestId, policy, expectedAuthorityGeneration })
      }
    }

    case 'member-add-readiness':
      return { method: 'GET', path: `${company}/member-add`, wire: TEAM_SPACE_DIRECT_ADD_WIRE }

    case 'member-add': {
      const { requestId, role, target } = request

      // The platform derives the adder; the client never names a principal.
      return {
        method: 'POST',
        path: `${company}/member-add`,
        wire: TEAM_SPACE_DIRECT_ADD_WIRE,
        body: body(CompanyMemberAdd112RequestSchema, { requestId, target, role })
      }
    }

    case 'email-invitation-status':
      return {
        method: 'GET',
        path: `${company}/email-invitations/${request.invitationId}`,
        wire: TEAM_SPACE_EMAIL_INVITE_WIRE,
        profile: { header: COMPANY_INVITES_PROFILE_HEADER, value: COMPANY_INVITES_PROFILE_2 }
      }

    case 'invitation-create': {
      const { memberHandle, requestId, role } = request

      return {
        method: 'POST',
        path: `${company}/invitations`,
        wire: admin,
        body: body(CompanyInvitationCreate13RequestSchema, { requestId, memberHandle, role })
      }
    }

    case 'invitation-create-directory': {
      const { memberMatrixUser, requestId, role } = request

      // The platform resolves the person from the Matrix user ID; an older platform answers 404 before any change.
      return {
        method: 'POST',
        path: `${company}/invitations`,
        wire: TEAM_SPACE_DIRECTORY_INVITE_WIRE,
        body: body(CompanyInvitationCreate110RequestSchema, { requestId, memberMatrixUser, role })
      }
    }

    case 'email-invitation-create': {
      const { email, locale, requestId } = request

      // The platform derives the inviter and answers alike for known and unknown addresses; an older one 404s.
      return {
        method: 'POST',
        path: `${company}/email-invitations`,
        wire: TEAM_SPACE_EMAIL_INVITE_WIRE,
        body: body(CompanyEmailInvitationCreate19RequestSchema, { requestId, email, locale })
      }
    }

    case 'invitation-accept':
    case 'invitation-decline': {
      const response = request.action === 'invitation-accept' ? 'accept' : 'decline'

      return {
        method: 'POST',
        path: `${company}/invitations/${request.invitationId}/${response}`,
        wire: admin,
        body: body(CompanyInvitationSelfAction13RequestSchema, { requestId: request.requestId, action: response })
      }
    }

    case 'invitation-cancel':
      return {
        method: 'POST',
        path: `${company}/invitations/${request.invitationId}/cancel`,
        wire: admin,
        body: body(CompanyInvitationAdminAction13RequestSchema, { requestId: request.requestId, action: 'cancel' })
      }

    case 'invitation-resend':
      return {
        method: 'POST',
        path: `${company}/invitations/${request.invitationId}/resend`,
        wire: admin,
        body: body(CompanyInvitationResend13RequestSchema, { requestId: request.requestId })
      }

    case 'invite-links':
      return { method: 'GET', path: `${company}/invite-links`, wire: links }

    case 'invite-link-create': {
      const { expiresInSeconds, maxUses, requestId, role } = request

      return {
        method: 'POST',
        path: `${company}/invite-links`,
        wire: links,
        body: body(CompanyInviteLinkCreateRequestSchema, {
          requestId,
          role,
          ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
          ...(maxUses === undefined ? {} : { maxUses })
        })
      }
    }

    case 'invite-link-revoke':
      return {
        method: 'POST',
        path: `${company}/invite-links/${request.linkId}/revoke`,
        wire: links,
        body: body(CompanyInviteLinkRevokeRequestSchema, { requestId: request.requestId })
      }

    case 'invite-link-preview':
      return {
        method: 'POST',
        path: '/invite-links/preview',
        wire: links,
        body: body(CompanyInviteLinkPreviewRequestSchema, { token: request.token })
      }

    case 'invite-link-redeem':
      return {
        method: 'POST',
        path: '/invite-links/redeem',
        wire: links,
        body: body(CompanyInviteLinkRedeemRequestSchema, { requestId: request.requestId, token: request.token })
      }

    case 'browse-channels':
      return { method: 'GET', path: `${company}/channels/browse`, wire: channels }

    case 'browse-joinable-channels':
      return { method: 'GET', path: `${company}/channels/browse`, wire: joinableBrowse }

    case 'admitted-channels':
      return { method: 'GET', path: `${company}/channels`, wire: channels }

    case 'read-admitted-channel':
      return { method: 'GET', path: `${company}/channels/${request.channelId}`, wire: channels }

    case 'channel-members':
      return { method: 'GET', path: `${company}/channels/${request.channelId}/members`, wire: channels }

    case 'channel-command': {
      // A create with its people and a direct add are company channel command 1.1: the same channel wire, plus the
      // profile header. Everything else (a create journaled without people included) stays the frozen 1.4 command.
      const profiled = isChannelCommand15(request.command)
      const command = body(profiled ? CompanyChannelCommand15RequestSchema : CompanyChannelCommand14RequestSchema, request.command)

      return {
        method: 'POST',
        path:
          command.operation === 'create'
            ? `${company}/channels`
            : `${company}/channels/${request.channelId}/${CHANNEL_COMMAND_PATH[command.operation]}`,
        wire: channels,
        ...(profiled ? { profile: { header: COMPANY_CHANNEL_COMMAND_PROFILE_HEADER, value: COMPANY_CHANNEL_COMMAND_PROFILE } } : {}),
        body: command
      }
    }

    case 'conversations':
      return { method: 'GET', path: `${company}/conversations`, wire: conversations }

    case 'read-conversation':
      return { method: 'GET', path: `${company}/conversations/${request.conversationId}`, wire: conversations }

    case 'conversation-open': {
      const { participantMemberRefs, requestId } = request

      return {
        method: 'POST',
        path: `${company}/conversations`,
        wire: conversations,
        body: body(CompanyConversationOpen15RequestSchema, { requestId, participantMemberRefs })
      }
    }

    case 'conversation-expand': {
      const { participantMemberRefs, requestId, sourceConversationId } = request

      return {
        method: 'POST',
        path: `${company}/conversations/${sourceConversationId}/expand`,
        wire: conversations,
        body: body(CompanyConversationExpand15RequestSchema, { requestId, sourceConversationId, participantMemberRefs })
      }
    }

    case 'conversation-hidden': {
      const { hidden, requestId } = request

      return {
        method: 'POST',
        path: `${company}/conversations/${request.conversationId}/hidden`,
        wire: conversations,
        body: body(CompanyConversationHidden15RequestSchema, { requestId, hidden })
      }
    }

    case 'set-avatar': {
      const { avatarUri, requestId } = request

      return {
        method: 'POST',
        path: `${company}/set-avatar`,
        wire: avatar,
        body: body(CompanyAvatarSet17RequestSchema, { requestId, operation: 'set_avatar', avatarUri })
      }
    }
  }
}


type Conversation = z.output<typeof CompanyConversationOpen15ResponseSchema>['conversation']

/** The answer's own participant-set digest is the normative one for its participants (conversation_open.digest). */
function digestHolds(conversation: Conversation): boolean {
  return (
    conversation.participantSetDigest ===
    companyConversationDigest(conversation.companyId, conversation.kind, conversation.participants)
  )
}

const sameMembers = (participants: Conversation['participants'], refs: readonly string[]) =>
  participants.length === refs.length && refs.every(ref => participants.some(participant => participant.memberRef === ref))

function accept<S extends z.ZodType>(
  schema: S,
  json: unknown,
  related: (value: z.output<S>) => boolean = () => true
): z.output<S> | null {
  const parsed = schema.safeParse(json)

  return parsed.success && related(parsed.data) ? parsed.data : null
}

/**
 * The strict answer for one request. Beyond the closed shape, every id the answer names must be
 * the one the request named: a channel list for another company, or a receipt for another member,
 * is a refusal, not data.
 */
export function parseTeamSpaceResponse(request: TeamSpaceRequest, json: unknown): TeamSpaceValue | null {
  switch (request.action) {
    case 'capabilities':
      return accept(CompanyCapabilities13ResponseSchema, json)

    // An older server ignores the profile header and answers the plain 1.3 capabilities: that is a valid answer
    // meaning "no invite readiness here", which the renderer reads as unsupported (today's invite methods).
    // Each profile answers only its own message: profile 3 never accepts a profile 2 body (no direct-add signal).
    case 'invite-readiness': {
      const readiness = request.profile === COMPANY_INVITES_PROFILE_3
        ? CompanyInviteCapabilities3Schema
        : request.profile === COMPANY_INVITES_PROFILE_2 ? CompanyInviteCapabilities2Schema : CompanyInviteCapabilitiesSchema

      return accept(readiness, json) ?? accept(CompanyCapabilities13ResponseSchema, json)
    }

    case 'administration':
      return accept(
        CompanyAdminSnapshot13ResponseSchema,
        json,
        value =>
          value.company.id === request.companyId &&
          value.invitations.every(invitation => invitation.companyId === request.companyId)
      )

    // An older server ignores the policy header and answers the plain 1.3 snapshot. That snapshot is still the
    // authority (owner, roles, pending invitations); it only says nothing about who may invite, so owners and admins
    // invite, as before. A 1.2 answer is tried first: the strict 1.3 policy refuses the 1.2 keys.
    case 'administration-policy': {
      const sameCompany = (value: CompanyAdminSnapshot13Response) =>
        value.company.id === request.companyId &&
        value.invitations.every(invitation => invitation.companyId === request.companyId)

      // Policy 1.3 answers its own snapshot (who may add as well); a server that ignores the header answers 1.3 plain.
      if (request.profile === COMPANY_POLICY_DIRECT_ADD_PROFILE) {
        return accept(CompanyAdminSnapshotPolicy3ResponseSchema, json, sameCompany) ??
          accept(CompanyAdminSnapshot13ResponseSchema, json, sameCompany)
      }

      return accept(CompanyAdminSnapshotPolicy12ResponseSchema, json, sameCompany) ??
        accept(CompanyAdminSnapshot13ResponseSchema, json, sameCompany)
    }

    case 'role-change':
      return accept(
        CompanyRoleChange13ResponseSchema,
        json,
        value =>
          value.companyId === request.companyId && value.memberRef === request.memberRef && value.role === request.role
      )

    case 'ownership-transfer':
      return accept(
        CompanyOwnershipTransfer13ResponseSchema,
        json,
        value => value.companyId === request.companyId && value.ownerMemberRef === request.targetMemberRef
      )

    case 'policy-update': {
      const sent = request.policy

      if (CompanyPolicy3Schema.safeParse(sent).success) {
        // Under policy 1.3 the answer carries all five fields, and they are the ones sent.
        return accept(CompanyPolicyUpdate3ResponseSchema, json, value => value.companyId === request.companyId &&
          JSON.stringify(CompanyPolicy3Schema.parse(sent)) === JSON.stringify(value.policy))
      }

      return accept(
        CompanyPolicyUpdate13ResponseSchema,
        json,
        value => value.companyId === request.companyId && value.policy.channelCreation === sent.channelCreation
      )
    }

    case 'member-add-readiness':
      return accept(CompanyMemberAddReadiness112ResponseSchema, json, value => value.companyId === request.companyId)

    // An answer that names a company names this one; an `invited` answer is for an address target only, and an
    // `added` one grants the role asked for (never more).
    case 'member-add':
      return accept(CompanyMemberAdd112ResponseSchema, json, value => {
        if (value.outcome === 'invited') {
          return request.target.kind === 'email'
        }

        if (value.outcome === 'added') {
          return request.target.kind === 'matrixUser' && value.companyId === request.companyId && value.role === request.role
        }

        return value.outcome !== 'already_member' || (request.target.kind === 'matrixUser' && value.companyId === request.companyId)
      })

    case 'email-invitation-status':
      return accept(CompanyEmailInvitationStatus19ResponseSchema, json, value => value.invitationId === request.invitationId)

    case 'invitation-create':
      return accept(
        CompanyInvitationCreate13ResponseSchema,
        json,
        value =>
          value.invitation.companyId === request.companyId &&
          value.invitation.role === request.role &&
          value.invitation.targetHandle === request.memberHandle.replace(/^@/u, '').toLowerCase()
      )

    case 'invitation-create-directory':
      return accept(
        CompanyInvitationCreate110ResponseSchema,
        json,
        value => value.invitation.companyId === request.companyId && value.invitation.role === request.role
      )

    // The acknowledgement names nothing to compare: no company, address or person, by design.
    case 'email-invitation-create':
      return accept(CompanyEmailInvitationCreate19ResponseSchema, json)

    case 'invitation-accept':
    case 'invitation-decline':
    case 'invitation-cancel': {
      const state = { 'invitation-accept': 'accepted', 'invitation-decline': 'declined', 'invitation-cancel': 'cancelled' }[
        request.action
      ]

      return accept(
        CompanyInvitationMutation13ResponseSchema,
        json,
        value =>
          value.invitation.id === request.invitationId &&
          value.invitation.companyId === request.companyId &&
          value.invitation.state === state
      )
    }

    case 'invitation-resend':
      return accept(
        CompanyInvitationResend13ResponseSchema,
        json,
        value =>
          value.superseded.id === request.invitationId &&
          value.superseded.companyId === request.companyId &&
          value.replacement.companyId === request.companyId
      )

    case 'invite-links':
      return accept(CompanyInviteLinkListResponseSchema, json)

    case 'invite-link-create':
      return accept(
        CompanyInviteLinkCreateResponseSchema,
        json,
        // Only the first answer names the company (and carries the url); a replay is a summary.
        value => !('companyId' in value.link) || value.link.companyId === request.companyId
      )

    case 'invite-link-revoke':
      return accept(CompanyInviteLinkRevokeResponseSchema, json, value => value.linkId === request.linkId)

    case 'invite-link-preview':
      return accept(CompanyInviteLinkPreviewResponseSchema, json)

    case 'invite-link-redeem':
      return accept(CompanyInviteLinkRedeemResponseSchema, json)

    case 'browse-channels':
      return accept(
        CompanyChannelBrowse14ResponseSchema,
        json,
        value => value.channels.every(channel => channel.companyId === request.companyId)
      )

    case 'browse-joinable-channels':
      return accept(
        CompanyChannelBrowse16ResponseSchema,
        json,
        value => value.channels.every(channel => channel.companyId === request.companyId)
      )

    case 'admitted-channels':
      return accept(
        CompanyChannelAdmittedDirectory14ResponseSchema,
        json,
        value => value.channels.every(item => item.channel.companyId === request.companyId)
      )

    case 'read-admitted-channel':
      return accept(
        CompanyChannelAdmittedSnapshot14Schema,
        json,
        value => value.channel.companyId === request.companyId && value.channel.id === request.channelId
      )

    case 'channel-members':
      return accept(CompanyChannelMembers14ResponseSchema, json, value => value.channelId === request.channelId)

    case 'channel-command': {
      const { command } = request

      // Invite, decline and cancel answer with the invitation; every other operation with the receipt. The
      // invitation must be this request's: an invite names the person it asked for, a decline or cancel the
      // invitation it acted on. An answer about another person or another invitation is a refusal, not data.
      if (command.operation === 'invite') {
        return accept(
          CompanyChannelInvitation14ResponseSchema,
          json,
          value => value.invitation.channelId === request.channelId && value.invitation.memberRef === command.memberRef
        )
      }

      // A 1.1 create answers with the creator's admission and every pick's; an add with the person it named. An answer
      // listing anyone else is not this command's.
      if (isChannelCommand15(command)) {
        const named = new Set(command.operation === 'add' ? [command.memberRef] : command.initialMemberRefs)

        return accept(
          CompanyChannelCommand15ResponseSchema,
          json,
          value =>
            value.operation === command.operation &&
            (command.operation === 'create'
              ? value.admissions.filter(admission => !named.has(admission.memberRef)).length <= 1
              : value.channelId === request.channelId &&
                value.admissions.length === 1 &&
                value.admissions.every(admission => named.has(admission.memberRef)))
        )
      }

      if (command.operation === 'decline' || command.operation === 'cancel') {
        return accept(
          CompanyChannelInvitation14ResponseSchema,
          json,
          value => value.invitation.channelId === request.channelId && value.invitation.id === command.invitationId
        )
      }

      return accept(
        CompanyChannelCommand14ResponseSchema,
        json,
        value =>
          value.operation === command.operation && (command.operation === 'create' || value.channelId === request.channelId)
      )
    }

    case 'conversations':
      return accept(
        CompanyConversationDirectory15ResponseSchema,
        json,
        value => value.conversations.every(conversation => conversation.companyId === request.companyId && digestHolds(conversation))
      )

    case 'read-conversation':
      return accept(
        CompanyConversationOpen15ResponseSchema,
        json,
        value =>
          value.conversation.companyId === request.companyId &&
          value.conversation.id === request.conversationId &&
          digestHolds(value.conversation)
      )

    // An open (or an expand) is the same atomic get-or-create: the answer must be for exactly the set asked
    // for, this caller included. A conversation of another company, another set or a broken digest is a
    // refusal, not data.
    case 'conversation-open':
    case 'conversation-expand':
      return accept(
        CompanyConversationOpen15ResponseSchema,
        json,
        value =>
          value.conversation.companyId === request.companyId &&
          digestHolds(value.conversation) &&
          sameMembers(value.conversation.participants, request.participantMemberRefs) &&
          (request.action === 'conversation-open' || value.conversation.id !== request.sourceConversationId)
      )

    case 'conversation-hidden':
      return accept(
        CompanyConversationHidden15ResponseSchema,
        json,
        value => value.conversationId === request.conversationId && value.hidden === request.hidden
      )

    case 'set-avatar':
      return accept(
        CompanyAvatarSet17ResponseSchema,
        json,
        value => value.companyId === request.companyId && value.avatarUri === request.avatarUri
      )
  }
}
