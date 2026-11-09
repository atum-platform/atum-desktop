import { z } from 'zod'

/**
 * Team Space C1 (ownership, roles, invitations, invite links), C2 (public and private channels) and
 * C3 (company DMs and group DMs), plus company identity: the closed wire shapes of
 * `atum.company-workspace` 1.2 to 1.7 and 1.10 (directory invitations), and the
 * closed native request vocabulary that carries them.
 *
 * The schemas mirror `packages/protocol/src/company-workspace.ts` in atum-platform (version
 * 0.7.75) key for key; the frozen packs are vendored under
 * `electron/matrix/__fixtures__/team-space/` and `company-team-space.test.ts` runs every
 * public fixture through them. Every object is strict: an unknown key, a wrong
 * `schemaVersion`, or a principal / actor / email / room id on the wire rejects the whole
 * message ("a later wire selection never widens an earlier closed shape").
 *
 * This file is shared by main (runtime) and the renderer (types only).
 */

export const TEAM_SPACE_ADMIN_WIRE = '1.3' as const
export const TEAM_SPACE_CHANNEL_WIRE = '1.4' as const
export const TEAM_SPACE_JOINABLE_BROWSE_WIRE = '1.6' as const
export const TEAM_SPACE_CONVERSATION_WIRE = '1.5' as const
export const TEAM_SPACE_LINK_WIRE = '1.2' as const
export const TEAM_SPACE_AVATAR_WIRE = '1.7' as const
export const TEAM_SPACE_DIRECTORY_INVITE_WIRE = '1.10' as const

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const epochSeconds = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const companyName = z.string().min(1).max(120)
const channelName = z.string().min(1).max(80)
const profileName = z.string().min(1).max(120)

/** A stored handle: lowercase ASCII, a letter first, 3 to 32 characters. */
export const CompanyHandleSchema = z.string().regex(/^[a-z][a-z0-9_]{2,31}$/u)

/** What a person typed: at most 33 bytes, a leading @ allowed, folded by the server. */
export const CompanyHandleInputSchema = z
  .string()
  .regex(/^@?[A-Za-z][A-Za-z0-9_]{2,31}$/u)
  .refine(value => new TextEncoder().encode(value).length <= 33, 'a handle input is at most 33 bytes')

/** 32 random bytes, base64url: opaque, company scoped, stable across readmission. */
export const CompanyMemberRefSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u)

const CompanyInviterSchema = z.strictObject({
  handle: CompanyHandleSchema.nullable(),
  displayName: profileName.nullable()
})

const CompanyRoomSchema = z.union([
  z.strictObject({
    state: z.enum(['not_provisioned', 'provisioning', 'reconciling', 'failed']),
    roomId: z.literal(null)
  }),
  z.strictObject({ state: z.literal('ready'), roomId: z.string().regex(/^![!-9;-~]{1,255}:[!-~]{1,255}$/u) })
])

/* ------------------------------------------------------------------ 1.2: invite links */

export const COMPANY_INVITE_LINK_SCHEMA_VERSION = 3 as const

/** 32 random bytes or more, base64url: 43 to 128 characters. */
export const CompanyInviteLinkTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/u)

/** The one canonical projection of a token: `https://atum.app/j/<token>`. */
export const CompanyInviteLinkUrlSchema = z.string().regex(/^https:\/\/[a-z0-9][a-z0-9.-]{0,252}\/j\/[A-Za-z0-9_-]{43,128}$/u)
export const CompanyInviteLinkStateSchema = z.enum(['active', 'exhausted', 'expired', 'revoked'])
const CompanyInviteLinkRoleSchema = z.literal('member')
const maxUses = z.number().int().min(1).max(100)
const uses = z.number().int().min(0).max(100)
const usesRemaining = z.number().int().min(0).max(100)

export const CompanyInviteLinkSummarySchema = z
  .strictObject({
    id: uuid,
    role: CompanyInviteLinkRoleSchema,
    state: CompanyInviteLinkStateSchema,
    createdAt: epochSeconds,
    expiresAt: epochSeconds,
    maxUses,
    uses
  })
  .superRefine((link, context) => {
    if (link.uses > link.maxUses) {
      context.addIssue({ code: 'custom', path: ['uses'], message: 'uses is at most maxUses' })
    }

    if (link.createdAt > link.expiresAt) {
      context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'expiresAt is not before createdAt' })
    }
  })

/** The first create answer: the only wire shape that carries the bearer url. */
export const CompanyInviteLinkSchema = z
  .strictObject({
    id: uuid,
    companyId: uuid,
    role: CompanyInviteLinkRoleSchema,
    state: CompanyInviteLinkStateSchema,
    createdAt: epochSeconds,
    expiresAt: epochSeconds,
    maxUses,
    uses,
    url: CompanyInviteLinkUrlSchema
  })
  .superRefine((link, context) => {
    if (link.uses > link.maxUses) {
      context.addIssue({ code: 'custom', path: ['uses'], message: 'uses is at most maxUses' })
    }

    if (link.createdAt > link.expiresAt) {
      context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'expiresAt is not before createdAt' })
    }
  })

export const CompanyInviteLinkCreateRequestSchema = z.strictObject({
  requestId: uuid,
  role: CompanyInviteLinkRoleSchema,
  expiresInSeconds: z.number().int().min(3_600).max(2_592_000).optional(),
  maxUses: maxUses.optional()
})

export const CompanyInviteLinkCreateResponseSchema = z.discriminatedUnion('replayed', [
  z.strictObject({
    schemaVersion: z.literal(COMPANY_INVITE_LINK_SCHEMA_VERSION),
    replayed: z.literal(false),
    link: CompanyInviteLinkSchema
  }),
  z.strictObject({
    schemaVersion: z.literal(COMPANY_INVITE_LINK_SCHEMA_VERSION),
    replayed: z.literal(true),
    link: CompanyInviteLinkSummarySchema
  })
])

export const CompanyInviteLinkListResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(COMPANY_INVITE_LINK_SCHEMA_VERSION),
    links: z.array(CompanyInviteLinkSummarySchema).max(100)
  })
  .refine(list => new Set(list.links.map(link => link.id)).size === list.links.length, 'link ids are unique')

export const CompanyInviteLinkRevokeRequestSchema = z.strictObject({ requestId: uuid })
export const CompanyInviteLinkRevokeResponseSchema = z.strictObject({
  schemaVersion: z.literal(COMPANY_INVITE_LINK_SCHEMA_VERSION),
  linkId: uuid,
  state: z.literal('revoked'),
  revokedAt: epochSeconds,
  replayed: z.boolean()
})

export const CompanyInviteLinkPreviewRequestSchema = z.strictObject({ token: CompanyInviteLinkTokenSchema })
export const CompanyInviteLinkPreviewResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(COMPANY_INVITE_LINK_SCHEMA_VERSION),
    company: z.strictObject({ id: uuid, displayName: companyName }),
    role: CompanyInviteLinkRoleSchema,
    inviter: CompanyInviterSchema,
    expiresAt: epochSeconds,
    maxUses,
    usesRemaining
  })
  .refine(preview => preview.usesRemaining <= preview.maxUses, 'usesRemaining is at most maxUses')

export const CompanyInviteLinkRedeemRequestSchema = z.strictObject({
  requestId: uuid,
  token: CompanyInviteLinkTokenSchema
})
export const CompanyInviteLinkRedeemResponseSchema = z.strictObject({
  schemaVersion: z.literal(COMPANY_INVITE_LINK_SCHEMA_VERSION),
  companyId: uuid,
  memberRef: CompanyMemberRefSchema,
  role: CompanyInviteLinkRoleSchema,
  state: z.literal('active'),
  link: z
    .strictObject({
      id: uuid,
      maxUses,
      usesRemaining,
      consumedNow: z.boolean(),
      replayed: z.boolean()
    })
    .superRefine((link, context) => {
      if (link.usesRemaining > link.maxUses) {
        context.addIssue({ code: 'custom', path: ['usesRemaining'], message: 'usesRemaining is at most maxUses' })
      }

      if (link.replayed && link.consumedNow) {
        context.addIssue({ code: 'custom', path: ['consumedNow'], message: 'a replay never consumes a use' })
      }
    })
})

/* ------------------------------------------------------------------ 1.3: administration */

export const COMPANY_WORKSPACE_13_SCHEMA_VERSION = 4 as const

export const CompanyRole13Schema = z.enum(['owner', 'admin', 'member'])
export const CompanyAssignableRole13Schema = z.enum(['admin', 'member'])

export const CompanyInvitationState13Schema = z.enum([
  'pending',
  'accepted',
  'declined',
  'cancelled',
  'expired',
  'superseded'
])

export const CompanyChannelCreationPolicy13Schema = z.enum(['members', 'admins_only'])
export const CompanyPolicy13Schema = z.strictObject({ channelCreation: CompanyChannelCreationPolicy13Schema })

export const CompanyCapabilities13ResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(COMPANY_WORKSPACE_13_SCHEMA_VERSION),
    wireVersion: z.literal('1.3'),
    supportedWireVersions: z.array(z.enum(['1', '1.1', '1.2', '1.3', '1.4', '1.5'])).min(4).max(6),
    features: z.strictObject({
      ownership: z.literal(true),
      invitationLifecycle: z.literal(true),
      capabilityDiscovery: z.literal(true),
      channelAdmission: z.boolean(),
      companyConversations: z.boolean()
    }),
    activation: z.strictObject({
      teamAdmin: z.enum(['inactive', 'active']),
      channelAdmission: z.enum(['inactive', 'active']),
      companyConversations: z.enum(['inactive', 'active'])
    }),
    controller: z.strictObject({ roomReconciliation: z.enum(['not_ready', 'ready']) })
  })
  .superRefine((response, context) => {
    const order = ['1', '1.1', '1.2', '1.3', '1.4', '1.5']

    if (response.supportedWireVersions.some((version, index) => version !== order[index])) {
      context.addIssue({
        code: 'custom',
        path: ['supportedWireVersions'],
        message: 'wire versions are one ordered supported prefix'
      })
    }
  })

export const CompanyMember13Schema = z.strictObject({
  memberRef: CompanyMemberRefSchema,
  role: CompanyRole13Schema,
  state: z.enum(['active', 'revoking', 'removed']),
  admissionEpoch: generation
})

export const CompanyInvitation13Schema = z
  .strictObject({
    id: uuid,
    companyId: uuid,
    targetHandle: CompanyHandleSchema,
    role: CompanyAssignableRole13Schema,
    state: CompanyInvitationState13Schema,
    createdAt: epochSeconds,
    expiresAt: epochSeconds,
    inviter: CompanyInviterSchema,
    supersededByInvitationId: uuid.optional()
  })
  .superRefine((invitation, context) => {
    if (invitation.createdAt >= invitation.expiresAt) {
      context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'expiresAt is after createdAt' })
    }

    if ((invitation.state === 'superseded') !== (invitation.supersededByInvitationId !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['supersededByInvitationId'],
        message: 'only superseded invitations name a replacement'
      })
    }

    if (invitation.supersededByInvitationId === invitation.id) {
      context.addIssue({ code: 'custom', path: ['supersededByInvitationId'], message: 'replacement id differs' })
    }
  })

export const CompanyAdminSnapshot13ResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(COMPANY_WORKSPACE_13_SCHEMA_VERSION),
    company: z.strictObject({
      id: uuid,
      displayName: companyName,
      role: CompanyRole13Schema,
      ownerMemberRef: CompanyMemberRefSchema,
      authorityGeneration: generation,
      policy: CompanyPolicy13Schema
    }),
    members: z.array(CompanyMember13Schema).min(1).max(100),
    invitations: z.array(CompanyInvitation13Schema).max(100)
  })
  .superRefine((snapshot, context) => {
    const owners = snapshot.members.filter(member => member.role === 'owner' && member.state === 'active')

    if (owners.length !== 1 || owners[0]?.memberRef !== snapshot.company.ownerMemberRef) {
      context.addIssue({ code: 'custom', path: ['members'], message: 'one active owner matches ownerMemberRef' })
    }

    if (new Set(snapshot.members.map(member => member.memberRef)).size !== snapshot.members.length) {
      context.addIssue({ code: 'custom', path: ['members'], message: 'member refs are unique' })
    }

    if (new Set(snapshot.invitations.map(invitation => invitation.id)).size !== snapshot.invitations.length) {
      context.addIssue({ code: 'custom', path: ['invitations'], message: 'invitation ids are unique' })
    }
  })

export const CompanyRoleChange13RequestSchema = z.strictObject({
  requestId: uuid,
  memberRef: CompanyMemberRefSchema,
  role: CompanyAssignableRole13Schema,
  expectedAuthorityGeneration: generation
})

export const CompanyRoleChange13ResponseSchema = z.strictObject({
  schemaVersion: z.literal(COMPANY_WORKSPACE_13_SCHEMA_VERSION),
  companyId: uuid,
  memberRef: CompanyMemberRefSchema,
  role: CompanyAssignableRole13Schema,
  ownerMemberRef: CompanyMemberRefSchema,
  authorityGeneration: generation,
  replayed: z.boolean()
})

export const CompanyOwnershipTransfer13RequestSchema = z.strictObject({
  requestId: uuid,
  targetMemberRef: CompanyMemberRefSchema,
  expectedAuthorityGeneration: generation
})

export const CompanyOwnershipTransfer13ResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(COMPANY_WORKSPACE_13_SCHEMA_VERSION),
    companyId: uuid,
    previousOwnerMemberRef: CompanyMemberRefSchema,
    ownerMemberRef: CompanyMemberRefSchema,
    previousOwnerRole: z.literal('admin'),
    authorityGeneration: generation,
    replayed: z.boolean()
  })
  .refine(
    result => result.previousOwnerMemberRef !== result.ownerMemberRef,
    'ownership moves to a different active human member'
  )

export const CompanyPolicyUpdate13RequestSchema = z.strictObject({
  requestId: uuid,
  policy: CompanyPolicy13Schema,
  expectedAuthorityGeneration: generation
})

export const CompanyPolicyUpdate13ResponseSchema = z.strictObject({
  schemaVersion: z.literal(COMPANY_WORKSPACE_13_SCHEMA_VERSION),
  companyId: uuid,
  policy: CompanyPolicy13Schema,
  authorityGeneration: generation,
  replayed: z.boolean()
})

export const CompanyInvitationCreate13RequestSchema = z.strictObject({
  requestId: uuid,
  memberHandle: CompanyHandleInputSchema,
  role: CompanyAssignableRole13Schema
})

export const CompanyInvitationCreate13ResponseSchema = z.strictObject({
  schemaVersion: z.literal(COMPANY_WORKSPACE_13_SCHEMA_VERSION),
  invitation: CompanyInvitation13Schema,
  authorityGeneration: generation,
  replayed: z.boolean()
})

export const CompanyInvitationSelfAction13RequestSchema = z.strictObject({
  requestId: uuid,
  action: z.enum(['accept', 'decline'])
})

export const CompanyInvitationAdminAction13RequestSchema = z.strictObject({
  requestId: uuid,
  action: z.literal('cancel')
})

export const CompanyInvitationMutation13ResponseSchema = z.strictObject({
  schemaVersion: z.literal(COMPANY_WORKSPACE_13_SCHEMA_VERSION),
  invitation: CompanyInvitation13Schema,
  replayed: z.boolean()
})

export const CompanyInvitationResend13RequestSchema = z.strictObject({ requestId: uuid })

export const CompanyInvitationResend13ResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(COMPANY_WORKSPACE_13_SCHEMA_VERSION),
    superseded: CompanyInvitation13Schema,
    replacement: CompanyInvitation13Schema,
    authorityGeneration: generation,
    replayed: z.boolean()
  })
  .superRefine((result, context) => {
    if (
      result.superseded.state !== 'superseded' ||
      result.superseded.supersededByInvitationId !== result.replacement.id ||
      result.replacement.state !== 'pending' ||
      result.superseded.id === result.replacement.id
    ) {
      context.addIssue({
        code: 'custom',
        path: ['replacement'],
        message: 'resend supersedes with one fresh pending attempt'
      })
    }
  })

/* ------------------------------------------------------------------ 1.4: channels */

export const COMPANY_WORKSPACE_14_SCHEMA_VERSION = 5 as const

export const CompanyChannelVisibility14Schema = z.enum(['public', 'private'])
export const CompanyChannelState14Schema = z.enum(['provisioning', 'active', 'archived'])
export const CompanyChannelAdmissionState14Schema = z.enum(['invited', 'active', 'revoking', 'left', 'removed'])

export const CompanyChannelAction14Schema = z.enum([
  'join',
  'leave',
  'invite',
  'accept',
  'decline',
  'cancel',
  'remove',
  'update_metadata',
  'archive',
  'restore'
])

const channelTopic14 = z.string().max(250)
const channelPurpose14 = z.string().max(500)

export const CompanyChannelPublicSummary14Schema = z.strictObject({
  id: uuid,
  companyId: uuid,
  displayName: channelName,
  visibility: z.literal('public'),
  topic: channelTopic14,
  purpose: channelPurpose14,
  state: CompanyChannelState14Schema,
  memberCount: z.number().int().min(1).max(100),
  joined: z.boolean(),
  systemKey: z.literal('default').optional()
})

export const CompanyChannelBrowse14ResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(COMPANY_WORKSPACE_14_SCHEMA_VERSION),
    channels: z.array(CompanyChannelPublicSummary14Schema).max(100)
  })
  .refine(
    response => new Set(response.channels.map(channel => channel.id)).size === response.channels.length,
    'public browse ids are unique'
  )

/* ------------------------------------------------------------------ 1.6: joinable public-channel browse */

export const COMPANY_WORKSPACE_16_SCHEMA_VERSION = 7 as const

export const CompanyChannelPublicSummary16Schema = z.strictObject({
  id: uuid,
  companyId: uuid,
  displayName: channelName,
  visibility: z.literal('public'),
  topic: channelTopic14,
  purpose: channelPurpose14,
  state: CompanyChannelState14Schema,
  memberCount: z.number().int().min(0).max(100),
  joined: z.boolean(),
  channelGeneration: generation,
  systemKey: z.literal('default').optional()
})

export const CompanyChannelBrowse16ResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(COMPANY_WORKSPACE_16_SCHEMA_VERSION),
    channels: z.array(CompanyChannelPublicSummary16Schema).max(100)
  })
  .refine(
    response => new Set(response.channels.map(channel => channel.id)).size === response.channels.length,
    'public browse ids are unique'
  )

export const CompanyChannelAdmission14Schema = z.strictObject({
  memberRef: CompanyMemberRefSchema,
  state: CompanyChannelAdmissionState14Schema,
  admissionEpoch: generation,
  admissionGeneration: generation
})

export const CompanyChannel14Schema = z.strictObject({
  id: uuid,
  companyId: uuid,
  displayName: channelName,
  visibility: CompanyChannelVisibility14Schema,
  topic: channelTopic14,
  purpose: channelPurpose14,
  state: CompanyChannelState14Schema,
  ownerMemberRef: CompanyMemberRefSchema,
  systemKey: z.literal('default').optional(),
  authorityGeneration: generation,
  channelGeneration: generation,
  metadataRevision: generation
})

export const CompanyChannelAdmittedSnapshot14Schema = z
  .strictObject({
    schemaVersion: z.literal(COMPANY_WORKSPACE_14_SCHEMA_VERSION),
    channel: CompanyChannel14Schema,
    selfAdmission: CompanyChannelAdmission14Schema,
    memberCount: z.number().int().min(1).max(100),
    room: CompanyRoomSchema,
    actions: z.array(CompanyChannelAction14Schema).max(10)
  })
  .superRefine((snapshot, context) => {
    if (snapshot.selfAdmission.state !== 'active' && snapshot.room.state === 'ready') {
      context.addIssue({
        code: 'custom',
        path: ['room'],
        message: 'only an active admission receives a ready room binding'
      })
    }

    if (new Set(snapshot.actions).size !== snapshot.actions.length) {
      context.addIssue({ code: 'custom', path: ['actions'], message: 'actions are unique' })
    }

    if (snapshot.channel.systemKey === 'default' && snapshot.channel.visibility !== 'public') {
      context.addIssue({ code: 'custom', path: ['channel', 'visibility'], message: 'the default channel is public' })
    }
  })

export const CompanyChannelAdmittedDirectory14ResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(COMPANY_WORKSPACE_14_SCHEMA_VERSION),
    channels: z.array(CompanyChannelAdmittedSnapshot14Schema).max(100)
  })
  .refine(
    response => new Set(response.channels.map(item => item.channel.id)).size === response.channels.length,
    'admitted channel ids are unique'
  )

export const CompanyChannelMembers14ResponseSchema = z.strictObject({
  schemaVersion: z.literal(COMPANY_WORKSPACE_14_SCHEMA_VERSION),
  channelId: uuid,
  channelGeneration: generation,
  members: z.array(CompanyChannelAdmission14Schema).max(100)
})

const CompanyChannelInvitation14Schema = z
  .strictObject({
    id: uuid,
    channelId: uuid,
    memberRef: CompanyMemberRefSchema,
    state: z.enum(['pending', 'accepted', 'declined', 'cancelled', 'expired']),
    createdAt: epochSeconds,
    expiresAt: epochSeconds
  })
  .refine(invitation => invitation.createdAt < invitation.expiresAt, 'channel invitation expires after creation')

export const CompanyChannelInvitation14ResponseSchema = z.strictObject({
  schemaVersion: z.literal(COMPANY_WORKSPACE_14_SCHEMA_VERSION),
  invitation: CompanyChannelInvitation14Schema,
  channelGeneration: generation,
  replayed: z.boolean()
})

const channelCommandBase14 = { requestId: uuid }

export const CompanyChannelCreate14RequestSchema = z.strictObject({
  ...channelCommandBase14,
  operation: z.literal('create'),
  displayName: channelName,
  visibility: CompanyChannelVisibility14Schema,
  topic: channelTopic14.optional(),
  purpose: channelPurpose14.optional()
})

export const CompanyChannelJoin14RequestSchema = z.strictObject({
  ...channelCommandBase14,
  operation: z.literal('join'),
  expectedChannelGeneration: generation
})

export const CompanyChannelLeave14RequestSchema = z.strictObject({
  ...channelCommandBase14,
  operation: z.literal('leave'),
  expectedChannelGeneration: generation,
  expectedAdmissionGeneration: generation
})

export const CompanyChannelInvite14RequestSchema = z.strictObject({
  ...channelCommandBase14,
  operation: z.literal('invite'),
  memberRef: CompanyMemberRefSchema,
  expectedChannelGeneration: generation
})

export const CompanyChannelAccept14RequestSchema = z.strictObject({
  ...channelCommandBase14,
  operation: z.literal('accept'),
  expectedChannelGeneration: generation,
  expectedAdmissionGeneration: generation
})

export const CompanyChannelDecline14RequestSchema = z.strictObject({
  ...channelCommandBase14,
  operation: z.literal('decline'),
  invitationId: uuid,
  expectedChannelGeneration: generation
})

export const CompanyChannelCancel14RequestSchema = z.strictObject({
  ...channelCommandBase14,
  operation: z.literal('cancel'),
  invitationId: uuid,
  expectedChannelGeneration: generation
})

export const CompanyChannelRemove14RequestSchema = z.strictObject({
  ...channelCommandBase14,
  operation: z.literal('remove'),
  memberRef: CompanyMemberRefSchema,
  expectedChannelGeneration: generation,
  expectedAdmissionGeneration: generation
})

export const CompanyChannelMetadata14RequestSchema = z
  .strictObject({
    ...channelCommandBase14,
    operation: z.literal('update_metadata'),
    expectedChannelGeneration: generation,
    displayName: channelName.optional(),
    topic: channelTopic14.optional(),
    purpose: channelPurpose14.optional(),
    visibility: CompanyChannelVisibility14Schema.optional()
  })
  .refine(
    request =>
      request.displayName !== undefined ||
      request.topic !== undefined ||
      request.purpose !== undefined ||
      request.visibility !== undefined,
    'a metadata update changes at least one field'
  )

export const CompanyChannelLifecycle14RequestSchema = z.strictObject({
  ...channelCommandBase14,
  operation: z.enum(['archive', 'restore']),
  expectedChannelGeneration: generation
})

export const CompanyChannelCommand14RequestSchema = z.union([
  CompanyChannelCreate14RequestSchema,
  CompanyChannelJoin14RequestSchema,
  CompanyChannelLeave14RequestSchema,
  CompanyChannelInvite14RequestSchema,
  CompanyChannelAccept14RequestSchema,
  CompanyChannelDecline14RequestSchema,
  CompanyChannelCancel14RequestSchema,
  CompanyChannelRemove14RequestSchema,
  CompanyChannelMetadata14RequestSchema,
  CompanyChannelLifecycle14RequestSchema
])

export const CompanyChannelCommand14ResponseSchema = z.strictObject({
  schemaVersion: z.literal(COMPANY_WORKSPACE_14_SCHEMA_VERSION),
  operation: z.enum([
    'create',
    'join',
    'leave',
    'invite',
    'accept',
    'decline',
    'cancel',
    'remove',
    'update_metadata',
    'archive',
    'restore'
  ]),
  channelId: uuid,
  authorityGeneration: generation,
  channelGeneration: generation,
  admission: CompanyChannelAdmission14Schema.nullable(),
  replayed: z.boolean()
})

/*
 * Company channel command 1.1 (atum-platform spec/company-channel-command/v1.1, @atum/protocol 0.7.80): an
 * additive profile over channel wire 1.4, selected by `Atum-Company-Channel-Command: 1.1`. Create carries the
 * people who start in the channel (`initialMemberRefs`, public or private), and `add` admits one person directly.
 * Both answer with every admission, all active at once. The `15` suffix is the protocol's own name for this
 * successor command (its RPC is `company_channel_command_v15`); it has nothing to do with conversation wire 1.5.
 * A create without `initialMemberRefs` is still the frozen 1.4 create (a request journaled by an older build
 * replays on the ledger it was first sent to), so the two are told apart by shape alone.
 */
export const COMPANY_CHANNEL_COMMAND_PROFILE_HEADER = 'Atum-Company-Channel-Command' as const
export const COMPANY_CHANNEL_COMMAND_PROFILE = '1.1' as const

export const CompanyChannelCreate15RequestSchema = CompanyChannelCreate14RequestSchema.extend({
  initialMemberRefs: z
    .array(CompanyMemberRefSchema)
    .max(100)
    .refine(refs => new Set(refs).size === refs.length, 'member references are unique')
})

export const CompanyChannelAdd15RequestSchema = z.strictObject({
  ...channelCommandBase14,
  operation: z.literal('add'),
  memberRef: CompanyMemberRefSchema,
  expectedChannelGeneration: generation
})

export const CompanyChannelCommand15RequestSchema = z.union([CompanyChannelCreate15RequestSchema, CompanyChannelAdd15RequestSchema])

export const CompanyChannelCommand15ResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(6),
    operation: z.enum(['create', 'add']),
    channelId: uuid,
    authorityGeneration: generation,
    channelGeneration: generation,
    admissions: z.array(CompanyChannelAdmission14Schema.extend({ state: z.literal('active') })).max(101),
    replayed: z.boolean()
  })
  .refine(
    response => new Set(response.admissions.map(item => item.memberRef)).size === response.admissions.length,
    'admission references are unique'
  )

/** Whether a channel command is one of the 1.1 profile's (create with its people, or a direct add). */
export function isChannelCommand15(command: { operation: string }): command is z.infer<typeof CompanyChannelCommand15RequestSchema> {
  return command.operation === 'add' || (command.operation === 'create' && 'initialMemberRefs' in command)
}

/* ------------------------------------------------------------------ 1.5: company DMs and group DMs */

export const COMPANY_WORKSPACE_15_SCHEMA_VERSION = 6 as const

export const CompanyConversationKind15Schema = z.enum(['dm', 'group_dm'])
export const CompanyConversationState15Schema = z.enum(['provisioning', 'active', 'read_only'])

export const CompanyConversationParticipant15Schema = z.strictObject({
  memberRef: CompanyMemberRefSchema,
  admissionEpoch: generation,
  handle: CompanyHandleSchema.nullable(),
  displayName: profileName.nullable()
})

export const CompanyConversation15Schema = z
  .strictObject({
    id: uuid,
    companyId: uuid,
    kind: CompanyConversationKind15Schema,
    state: CompanyConversationState15Schema,
    participants: z.array(CompanyConversationParticipant15Schema).min(2).max(9),
    participantSetDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    authorityGeneration: generation,
    conversationGeneration: generation,
    room: CompanyRoomSchema,
    hidden: z.boolean()
  })
  .superRefine((conversation, context) => {
    const refs = conversation.participants.map(participant => participant.memberRef)

    if (new Set(refs).size !== refs.length) {
      context.addIssue({ code: 'custom', path: ['participants'], message: 'participant refs are unique' })
    }

    // Canonical order: ascending memberRef (ASCII, so the byte order is the string order).
    if (refs.some((ref, index) => index > 0 && refs[index - 1]! > ref)) {
      context.addIssue({ code: 'custom', path: ['participants'], message: 'participants use canonical memberRef order' })
    }

    const size = conversation.participants.length

    if ((conversation.kind === 'dm' && size !== 2) || (conversation.kind === 'group_dm' && (size < 3 || size > 9))) {
      context.addIssue({ code: 'custom', path: ['participants'], message: 'a DM has two and a group DM three to nine' })
    }
  })

export const CompanyConversationDirectory15ResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(COMPANY_WORKSPACE_15_SCHEMA_VERSION),
    conversations: z.array(CompanyConversation15Schema).max(100)
  })
  .refine(
    response => new Set(response.conversations.map(conversation => conversation.id)).size === response.conversations.length,
    'conversation ids are unique'
  )

const participantRefs15 = z
  .array(CompanyMemberRefSchema)
  .min(2)
  .max(9)
  .refine(refs => new Set(refs).size === refs.length, 'participant refs are unique')

export const CompanyConversationOpen15RequestSchema = z.strictObject({
  requestId: uuid,
  participantMemberRefs: participantRefs15
})

export const CompanyConversationExpand15RequestSchema = z.strictObject({
  requestId: uuid,
  sourceConversationId: uuid,
  participantMemberRefs: participantRefs15.refine(refs => refs.length >= 3, 'an expanded conversation has at least three participants')
})

export const CompanyConversationOpen15ResponseSchema = z.strictObject({
  schemaVersion: z.literal(COMPANY_WORKSPACE_15_SCHEMA_VERSION),
  conversation: CompanyConversation15Schema,
  replayed: z.boolean()
})

export const CompanyConversationHidden15RequestSchema = z.strictObject({ requestId: uuid, hidden: z.boolean() })

export const CompanyConversationHidden15ResponseSchema = z.strictObject({
  schemaVersion: z.literal(COMPANY_WORKSPACE_15_SCHEMA_VERSION),
  conversationId: uuid,
  hidden: z.boolean(),
  replayed: z.boolean()
})

/* ------------------------------------------------------------------ typed refusals */

const PLAIN_ERRORS = ['matrix_400', 'matrix_401', 'matrix_403', 'matrix_404', 'matrix_409', 'matrix_429', 'matrix_503'] as const

/**
 * The typed refusal reasons each message family may carry, by status. A reason that belongs to
 * another family or another status is not one this client understands: the plain status stands.
 */
export const MATRIX_COMPANY_REFUSAL_REASONS = {
  /** 1.1 routes (and the 1.3 rule that the owner leaving or being removed answers `last_admin` there). */
  legacy: {
    matrix_404: ['invite_target_unavailable'],
    matrix_403: ['company_creation_closed'],
    matrix_409: ['last_admin'],
    matrix_429: ['invite_lookup_limited']
  },
  /** 1.11 reselects only leave, adding the funded-wallet refusal without widening any other 1.1 route. */
  leave: {
    matrix_409: ['last_admin', 'company_wallet_not_empty']
  },
  link: {
    matrix_404: ['invite_link_unavailable'],
    // 1.9: an email-bound link never redeems as a share link; it is claimed by the invited address.
    matrix_409: ['invite_link_limit_reached', 'email_invite_claim_required'],
    matrix_429: ['invite_link_rate_limited']
  },
  admin: {
    matrix_404: ['owner_target_unavailable', 'invitation_unavailable'],
    matrix_409: [
      'owner_transfer_required',
      'owner_generation_conflict',
      'role_change_forbidden',
      'invitation_terminal',
      'invitation_expired',
      'invitation_changed_input'
    ]
  },
  channel: {
    matrix_404: ['channel_unavailable', 'channel_invitation_unavailable'],
    matrix_403: ['channel_not_admitted', 'channel_creation_restricted'],
    matrix_409: [
      'channel_visibility_immutable',
      'default_channel_protected',
      'channel_archived',
      'channel_name_conflict',
      'admission_generation_conflict'
    ]
  },
  /**
   * 1.12 direct add. Every completed answer is an outcome (HTTP 200); what refuses is the per-actor budget (429), a
   * request ID reused with other input (409), and the email path's own refusals for an address target.
   */
  'member-add': {
    matrix_403: ['email_invite_denied'],
    matrix_409: ['invitation_changed_input', 'email_invite_capacity'],
    matrix_429: ['member_add_limited', 'email_invite_limited'],
    matrix_503: ['email_invite_identity_unavailable', 'email_invite_verification_unavailable']
  },
  /** 1.9 email invitations. Their bodies also say whether a retry can help (`details.retryable`). */
  email: {
    matrix_403: ['email_invite_denied'],
    matrix_409: ['email_invite_claim_required', 'email_invite_capacity'],
    matrix_429: ['email_invite_limited'],
    matrix_503: ['email_invite_identity_unavailable', 'email_invite_verification_unavailable']
  },
  conversation: {
    matrix_404: ['conversation_unavailable', 'participant_unavailable'],
    matrix_409: ['participant_limit', 'participant_set_conflict', 'admission_epoch_conflict', 'conversation_read_only']
  }
} as const satisfies Record<string, Partial<Record<(typeof PLAIN_ERRORS)[number], readonly string[]>>>

export type MatrixCompanyRefusalFamily = keyof typeof MATRIX_COMPANY_REFUSAL_REASONS

// Distributive on purpose: each family's status table is a union of readonly arrays, and every
// member of every array is a reason.
type ReasonsIn<T> = T extends readonly (infer R)[] ? R : never

export type MatrixCompanyRefusalReason = {
  [F in MatrixCompanyRefusalFamily]: ReasonsIn<(typeof MATRIX_COMPANY_REFUSAL_REASONS)[F][keyof (typeof MATRIX_COMPANY_REFUSAL_REASONS)[F]]>
}[MatrixCompanyRefusalFamily]

const CompanyErrorBodySchema = z.strictObject({
  error: z.enum(PLAIN_ERRORS),
  details: z.strictObject({ reason: z.string(), retryable: z.boolean().optional() }).optional()
})

export interface MatrixCompanyRefusal {
  error: (typeof PLAIN_ERRORS)[number]
  reason?: MatrixCompanyRefusalReason
}

/**
 * A closed error body for one message family: the plain status alone, or the status with one
 * typed reason that family defines for it. A body that names another family's reason, a reason
 * for a different status, a second detail key (a private channel's display name) or any other
 * key is not a refusal this client understands (null); the plain status code stands alone.
 */
export function parseMatrixCompanyRefusal(value: unknown, family: MatrixCompanyRefusalFamily): MatrixCompanyRefusal | null {
  const parsed = CompanyErrorBodySchema.safeParse(value)

  if (!parsed.success) {
    return null
  }

  const { details, error } = parsed.data

  if (!details) {
    return { error }
  }

  // Only 1.9 bodies carry `retryable` (email invitations, and a share link that is email-bound); elsewhere it is unknown.
  if (details.retryable !== undefined && family !== 'email' && family !== 'link' && family !== 'member-add') {
    return null
  }

  const byStatus: Partial<Record<string, readonly string[]>> = MATRIX_COMPANY_REFUSAL_REASONS[family]
  const allowed = byStatus[error] ?? []

  return allowed.includes(details.reason) ? { error, reason: details.reason as MatrixCompanyRefusalReason } : null
}

/**
 * Typed refusals the platform answers before it records anything: the 1.12 add budget and the 1.9 email invitation limit
 * write no receipt (SQL rolls the call back). The client forgets such a request on both sides, the renderer's Retry and
 * main's durable journal, so the next press is a fresh request with a new ID. Every other 429, and every network or 5xx
 * failure, keeps the request journalled for an exact replay.
 */
const RECORDLESS_REFUSALS: Partial<Record<string, readonly string[]>> = {
  'member-add': ['member_add_limited', 'email_invite_limited'],
  'email-invitation-create': ['email_invite_limited']
}

export function isRecordlessCompanyRefusal(action: string, code: string, reason: string | undefined): boolean {
  return code === 'limit' && reason !== undefined && (RECORDLESS_REFUSALS[action]?.includes(reason) ?? false)
}

/** The status codes that settle a company mutation: the platform's answer is final and nothing is waiting to replay. */
const DEFINITIVE_COMPANY_ERRORS: ReadonlySet<string> = new Set(['invalid', 'denied', 'missing', 'conflict'])

/**
 * One classification for main's journal and the renderer's Retry: a definitive refusal releases the pending request on
 * both sides; anything else (a lost answer, a 5xx, an untyped 429) keeps it for an exact replay.
 */
export function isDefinitiveCompanyRefusal(action: string, code: string, reason: string | undefined): boolean {
  return DEFINITIVE_COMPANY_ERRORS.has(code) || isRecordlessCompanyRefusal(action, code, reason)
}

/** Which family's refusals an action may carry. */
export function matrixCompanyRefusalFamily(action: string): MatrixCompanyRefusalFamily {
  if (action === 'leave') {
    return 'leave'
  }

  if (action.startsWith('invite-link')) {
    return 'link'
  }

  if (action === 'email-invitation-create' || action === 'email-invitation-status') {
    return 'email'
  }

  if (action === 'member-add' || action === 'member-add-readiness') {
    return 'member-add'
  }

  if (action === 'invite-links') {
    return 'link'
  }

  if (action.startsWith('invitation-') || ['administration', 'administration-policy', 'role-change', 'ownership-transfer', 'policy-update'].includes(action)) {
    return 'admin'
  }

  if (
    ['browse-channels', 'browse-joinable-channels', 'admitted-channels', 'read-admitted-channel', 'channel-members', 'channel-command'].includes(action)
  ) {
    return 'channel'
  }

  if (action.startsWith('conversation')) {
    return 'conversation'
  }

  return 'legacy'
}

/* ------------------------------------------------------------------ inferred wire types */

export type CompanyInviteLink = z.infer<typeof CompanyInviteLinkSchema>
export type CompanyInviteLinkSummary = z.infer<typeof CompanyInviteLinkSummarySchema>
export type CompanyInviteLinkCreateResponse = z.infer<typeof CompanyInviteLinkCreateResponseSchema>
export type CompanyInviteLinkListResponse = z.infer<typeof CompanyInviteLinkListResponseSchema>
export type CompanyInviteLinkRevokeResponse = z.infer<typeof CompanyInviteLinkRevokeResponseSchema>
export type CompanyInviteLinkPreviewResponse = z.infer<typeof CompanyInviteLinkPreviewResponseSchema>
export type CompanyInviteLinkRedeemResponse = z.infer<typeof CompanyInviteLinkRedeemResponseSchema>

export type CompanyRole13 = z.infer<typeof CompanyRole13Schema>
export type CompanyAssignableRole13 = z.infer<typeof CompanyAssignableRole13Schema>
export type CompanyPolicy13 = z.infer<typeof CompanyPolicy13Schema>
export type CompanyCapabilities13Response = z.infer<typeof CompanyCapabilities13ResponseSchema>
export type CompanyMember13 = z.infer<typeof CompanyMember13Schema>
export type CompanyInvitation13 = z.infer<typeof CompanyInvitation13Schema>
export type CompanyAdminSnapshot13Response = z.infer<typeof CompanyAdminSnapshot13ResponseSchema>
export type CompanyRoleChange13Response = z.infer<typeof CompanyRoleChange13ResponseSchema>
export type CompanyOwnershipTransfer13Response = z.infer<typeof CompanyOwnershipTransfer13ResponseSchema>
export type CompanyPolicyUpdate13Response = z.infer<typeof CompanyPolicyUpdate13ResponseSchema>
export type CompanyInvitationCreate13Response = z.infer<typeof CompanyInvitationCreate13ResponseSchema>
export type CompanyInvitationMutation13Response = z.infer<typeof CompanyInvitationMutation13ResponseSchema>
export type CompanyInvitationResend13Response = z.infer<typeof CompanyInvitationResend13ResponseSchema>

export type CompanyChannelVisibility14 = z.infer<typeof CompanyChannelVisibility14Schema>
export type CompanyChannelState14 = z.infer<typeof CompanyChannelState14Schema>
export type CompanyChannelAdmissionState14 = z.infer<typeof CompanyChannelAdmissionState14Schema>
export type CompanyChannelAction14 = z.infer<typeof CompanyChannelAction14Schema>
export type CompanyChannelPublicSummary14 = z.infer<typeof CompanyChannelPublicSummary14Schema>
export type CompanyChannelBrowse14Response = z.infer<typeof CompanyChannelBrowse14ResponseSchema>
export type CompanyChannelPublicSummary16 = z.infer<typeof CompanyChannelPublicSummary16Schema>
export type CompanyChannelBrowse16Response = z.infer<typeof CompanyChannelBrowse16ResponseSchema>
export type CompanyChannelAdmission14 = z.infer<typeof CompanyChannelAdmission14Schema>
export type CompanyChannel14 = z.infer<typeof CompanyChannel14Schema>
export type CompanyChannelAdmittedSnapshot14 = z.infer<typeof CompanyChannelAdmittedSnapshot14Schema>
export type CompanyChannelAdmittedDirectory14Response = z.infer<typeof CompanyChannelAdmittedDirectory14ResponseSchema>
export type CompanyChannelMembers14Response = z.infer<typeof CompanyChannelMembers14ResponseSchema>
export type CompanyChannelInvitation14Response = z.infer<typeof CompanyChannelInvitation14ResponseSchema>
export type CompanyChannelCommand14Request = z.infer<typeof CompanyChannelCommand14RequestSchema>
export type CompanyChannelCommand14Response = z.infer<typeof CompanyChannelCommand14ResponseSchema>
export type CompanyChannelCommand15Request = z.infer<typeof CompanyChannelCommand15RequestSchema>
export type CompanyChannelCommand15Response = z.infer<typeof CompanyChannelCommand15ResponseSchema>

export type CompanyConversationKind15 = z.infer<typeof CompanyConversationKind15Schema>
export type CompanyConversationState15 = z.infer<typeof CompanyConversationState15Schema>
export type CompanyConversationParticipant15 = z.infer<typeof CompanyConversationParticipant15Schema>
export type CompanyConversation15 = z.infer<typeof CompanyConversation15Schema>
export type CompanyConversationDirectory15Response = z.infer<typeof CompanyConversationDirectory15ResponseSchema>
export type CompanyConversationOpen15Response = z.infer<typeof CompanyConversationOpen15ResponseSchema>
export type CompanyConversationHidden15Response = z.infer<typeof CompanyConversationHidden15ResponseSchema>

/* ------------------------------------------------------------------ 1.7: company avatar */

export const COMPANY_WORKSPACE_17_SCHEMA_VERSION = 8 as const

/** The native Matrix session uploads the bytes; the company wire carries only the resulting MXC URI. */
export const CompanyAvatarSet17RequestSchema = z.strictObject({
  requestId: uuid,
  operation: z.literal('set_avatar'),
  avatarUri: z.string().regex(/^mxc:\/\/[A-Za-z0-9._-]{1,255}\/[A-Za-z0-9_-]{1,255}$/u)
})

export const CompanyAvatarSet17ResponseSchema = z.strictObject({
  schemaVersion: z.literal(COMPANY_WORKSPACE_17_SCHEMA_VERSION),
  operation: z.literal('set_avatar'),
  companyId: uuid,
  avatarUri: CompanyAvatarSet17RequestSchema.shape.avatarUri,
  avatarRevision: generation,
  replayed: z.boolean()
})

export type CompanyAvatarSet17Response = z.infer<typeof CompanyAvatarSet17ResponseSchema>

/* ------------------------------------------------------------------ 1.10 directory invitations */

/**
 * `atum.company-workspace/1.10` (platform protocol 0.7.75, SQL 0389): invite a person the people
 * directory found, by the Matrix user ID it answered with. The platform resolves the person itself;
 * a person need not have a handle, so a 1.10 invitation's `targetHandle` may be null.
 */
export const COMPANY_WORKSPACE_110_SCHEMA_VERSION = 11 as const

export const CompanyMatrixUser110Schema = z
  .string()
  .max(520)
  .regex(/^@[a-z0-9._=/-]{1,255}:[A-Za-z0-9.-]{1,253}(?::[0-9]{1,5})?$/u)

export const CompanyInvitationCreate110RequestSchema = z.strictObject({
  requestId: uuid,
  memberMatrixUser: CompanyMatrixUser110Schema,
  role: CompanyAssignableRole13Schema
})

export const CompanyInvitation110Schema = z
  .strictObject({
    id: uuid,
    companyId: uuid,
    targetHandle: CompanyHandleSchema.nullable(),
    role: CompanyAssignableRole13Schema,
    state: CompanyInvitationState13Schema,
    createdAt: epochSeconds,
    expiresAt: epochSeconds,
    inviter: CompanyInviterSchema,
    supersededByInvitationId: uuid.optional()
  })
  .superRefine((invitation, context) => {
    if (invitation.createdAt >= invitation.expiresAt) {
      context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'expiresAt is after createdAt' })
    }

    if ((invitation.state === 'superseded') !== (invitation.supersededByInvitationId !== undefined)) {
      context.addIssue({ code: 'custom', path: ['supersededByInvitationId'], message: 'only superseded invitations name a replacement' })
    }

    if (invitation.supersededByInvitationId === invitation.id) {
      context.addIssue({ code: 'custom', path: ['supersededByInvitationId'], message: 'replacement id differs' })
    }
  })

export const CompanyInvitationCreate110ResponseSchema = z.strictObject({
  schemaVersion: z.literal(COMPANY_WORKSPACE_110_SCHEMA_VERSION),
  invitation: CompanyInvitation110Schema,
  authorityGeneration: generation,
  replayed: z.boolean()
})

export const CompanyInvitationMutation110ResponseSchema = z.strictObject({
  schemaVersion: z.literal(COMPANY_WORKSPACE_110_SCHEMA_VERSION),
  invitation: CompanyInvitation110Schema,
  replayed: z.boolean()
})

export const CompanyInvitationResend110ResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(COMPANY_WORKSPACE_110_SCHEMA_VERSION),
    superseded: CompanyInvitation110Schema,
    replacement: CompanyInvitation110Schema,
    authorityGeneration: generation,
    replayed: z.boolean()
  })
  .refine(response => response.superseded.supersededByInvitationId === response.replacement.id,
    'the superseded invitation names its replacement')

export const CompanyAdminSnapshot110ResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(COMPANY_WORKSPACE_110_SCHEMA_VERSION),
    company: z.strictObject({
      id: uuid,
      displayName: companyName,
      role: CompanyRole13Schema,
      ownerMemberRef: CompanyMemberRefSchema,
      authorityGeneration: generation,
      policy: CompanyPolicy13Schema
    }),
    members: z.array(CompanyMember13Schema).min(1).max(100),
    invitations: z.array(CompanyInvitation110Schema).max(100)
  })
  .superRefine((snapshot, context) => {
    const owners = snapshot.members.filter(member => member.role === 'owner' && member.state === 'active')

    if (owners.length !== 1 || owners[0]?.memberRef !== snapshot.company.ownerMemberRef) {
      context.addIssue({ code: 'custom', path: ['members'], message: 'one active owner matches ownerMemberRef' })
    }

    if (new Set(snapshot.members.map(member => member.memberRef)).size !== snapshot.members.length) {
      context.addIssue({ code: 'custom', path: ['members'], message: 'member refs are unique' })
    }

    if (new Set(snapshot.invitations.map(invitation => invitation.id)).size !== snapshot.invitations.length) {
      context.addIssue({ code: 'custom', path: ['invitations'], message: 'invitation ids are unique' })
    }
  })

export const CompanyCapabilities110ResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(COMPANY_WORKSPACE_110_SCHEMA_VERSION),
    wireVersion: z.literal(TEAM_SPACE_DIRECTORY_INVITE_WIRE),
    supportedWireVersions: z.array(z.string().min(1).max(8)).min(1).max(16),
    features: z.strictObject({ directoryInvitations: z.literal(true) })
  })
  .refine(response => response.supportedWireVersions.includes(TEAM_SPACE_DIRECTORY_INVITE_WIRE), 'a 1.10 platform lists 1.10')

export type CompanyInvitationCreate110Request = z.infer<typeof CompanyInvitationCreate110RequestSchema>
export type CompanyInvitationCreate110Response = z.infer<typeof CompanyInvitationCreate110ResponseSchema>

/* ------------------------------------------------------------------ 1.9 email invitations, invite readiness, policy 1.2 */

/**
 * `atum.company-workspace/1.9` (create only), `atum.company-invites/1` and `atum.company-policy/1.2`
 * (platform #794, SQL 0406). Vendored under `electron/matrix/__fixtures__/team-space/`.
 *
 * - Email create answers the same `accepted` envelope whether or not an account owns the address.
 *   `accepted` is durable acceptance: never delivered mail, never membership.
 * - Invite readiness is one more answer on the existing capabilities read, selected by its own
 *   profile header. It says what the server is configured for; company policy and the viewer's
 *   role still decide each request.
 * - Policy 1.2 adds `companyInvitations` (who may invite: `members` by default, or `admins`) to the
 *   administration read. The 1.3 policy update keeps it unchanged, so this client only reads it.
 */
export const TEAM_SPACE_EMAIL_INVITE_WIRE = '1.9' as const
export const COMPANY_WORKSPACE_19_SCHEMA_VERSION = 10 as const
export const COMPANY_INVITES_PROFILE_HEADER = 'Atum-Company-Invites' as const
export const COMPANY_INVITES_PROFILE = '1' as const
export const COMPANY_POLICY_PROFILE_HEADER = 'Atum-Company-Policy' as const
export const COMPANY_POLICY_INVITES_PROFILE = '1.2' as const

/** What the platform accepts as one complete address: trimmed, one @, a dot in the domain. */
export const CompanyInviteEmailSchema = z
  .string()
  .min(3)
  .max(254)
  .refine(value => value === value.trim(), 'email must be trimmed')
  .refine(value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value), 'complete email required')

export const CompanyEmailInvitationLocale19Schema = z.enum(['vi', 'en'])

export const CompanyEmailInvitationCreate19RequestSchema = z.strictObject({
  requestId: uuid,
  email: CompanyInviteEmailSchema,
  locale: CompanyEmailInvitationLocale19Schema
})

/** One acknowledgement for existing and not-yet-existing accounts alike: no email, token or existence bit. */
export const CompanyEmailInvitationCreate19ResponseSchema = z.strictObject({
  schemaVersion: z.literal(COMPANY_WORKSPACE_19_SCHEMA_VERSION),
  invitationId: uuid,
  state: z.literal('accepted'),
  mailStatus: z.literal('accepted'),
  expiresAt: epochSeconds,
  replayed: z.boolean()
})

export const CompanyInviteCapabilitiesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  directoryInvite: z.enum(['ready', 'inactive']),
  emailInvite: z.enum(['delivery_unavailable', 'inactive', 'not_configured']),
  emailCreation: z.enum(['ready', 'inactive', 'not_configured']),
  emailDelivery: z.literal('not_implemented'),
  inviteLink: z.enum(['ready', 'inactive', 'not_configured']),
  emailAutoClaim: z.enum(['active', 'verification_required'])
})

export const CompanyMembershipPolicy12Schema = z.enum(['members', 'admins'])

export const CompanyPolicy12Schema = CompanyPolicy13Schema.extend({
  publicChannelMembership: CompanyMembershipPolicy12Schema,
  privateChannelMembership: CompanyMembershipPolicy12Schema,
  companyInvitations: CompanyMembershipPolicy12Schema
})

export const CompanyPolicyUpdate12RequestSchema = CompanyPolicyUpdate13RequestSchema.extend({ policy: CompanyPolicy12Schema })
export const CompanyPolicyUpdate12ResponseSchema = CompanyPolicyUpdate13ResponseSchema.extend({ policy: CompanyPolicy12Schema })

/** The 1.3 administration snapshot whose policy also names who may invite. */
export const CompanyAdminSnapshotPolicy12ResponseSchema = CompanyAdminSnapshot13ResponseSchema.safeExtend({
  company: CompanyAdminSnapshot13ResponseSchema.shape.company.extend({ policy: CompanyPolicy12Schema })
})

export type CompanyEmailInvitationCreate19Request = z.infer<typeof CompanyEmailInvitationCreate19RequestSchema>
export type CompanyEmailInvitationCreate19Response = z.infer<typeof CompanyEmailInvitationCreate19ResponseSchema>
export type CompanyInviteCapabilities = z.infer<typeof CompanyInviteCapabilitiesSchema>
export type CompanyMembershipPolicy12 = z.infer<typeof CompanyMembershipPolicy12Schema>
export type CompanyPolicy12 = z.infer<typeof CompanyPolicy12Schema>
export type CompanyAdminSnapshotPolicy12Response = z.infer<typeof CompanyAdminSnapshotPolicy12ResponseSchema>

/** Who may invite in a company, when the snapshot was read with policy 1.2; undefined on an older read. */
export function companyInvitationPolicy(snapshot: CompanyAdminSnapshot13Response | undefined): CompanyMembershipPolicy12 | undefined {
  const policy = snapshot?.company.policy as Partial<CompanyPolicy12> | undefined

  return policy?.companyInvitations === 'members' || policy?.companyInvitations === 'admins' ? policy.companyInvitations : undefined
}

/* ------------------------------------------------------------------ invites 2/3, mail status, direct add 1.12, policy 1.3 */

/**
 * `atum.company-invites/2` (platform #799): real delivery state on the readiness read, and the mail state of one
 * email invitation (GET, wire 1.9 + `Atum-Company-Invites: 2`). `atum.company-invites/3` (platform #801) is profile 2
 * plus the install-level `directAdd` signal. `atum.company-workspace/1.12` adds a person directly (no accept step);
 * `atum.company-policy/1.3` adds `directMemberAdd` (who may add directly) to the administration read and the policy
 * update. Each is opt-in by its own header; an older server refuses the header (400) or ignores it.
 *
 * Privacy: an email target never adds and always answers `invited`; `invited` is never proof that an account owns the
 * address. `unknown_user` is one answer for every reason a person cannot be added.
 */
export const TEAM_SPACE_DIRECT_ADD_WIRE = '1.12' as const
export const COMPANY_WORKSPACE_112_SCHEMA_VERSION = 12 as const
export const COMPANY_INVITES_PROFILE_2 = '2' as const
export const COMPANY_INVITES_PROFILE_3 = '3' as const
export const COMPANY_POLICY_DIRECT_ADD_PROFILE = '1.3' as const

export const CompanyInviteCapabilities2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  directoryInvite: z.enum(['ready', 'inactive']),
  emailInvite: z.enum(['ready', 'delivery_unavailable', 'verification_required', 'inactive', 'not_configured']),
  emailCreation: z.enum(['ready', 'inactive', 'not_configured']),
  emailDelivery: z.enum(['ready', 'not_configured']),
  inviteLink: z.enum(['ready', 'inactive', 'not_configured']),
  emailAutoClaim: z.enum(['active', 'verification_required'])
})

export const CompanyInviteCapabilities3Schema = z.strictObject({
  ...CompanyInviteCapabilities2Schema.shape,
  schemaVersion: z.literal(3),
  directAdd: z.enum(['ready', 'inactive'])
})

/** The mail state of one email invitation. It names no address, token or fingerprint. */
export const CompanyEmailInvitationStatus19ResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(COMPANY_WORKSPACE_19_SCHEMA_VERSION),
    invitationId: uuid,
    mailStatus: z.enum(['queued', 'sent', 'failed', 'cancelled']),
    sentAt: epochSeconds.nullable(),
    failure: z.enum(['rejected', 'exhausted', 'unconfirmed']).nullable()
  })
  .superRefine((value, context) => {
    if ((value.mailStatus === 'failed') !== (value.failure !== null)) {
      context.addIssue({ code: 'custom', path: ['failure'], message: 'failure is present exactly when mailStatus is failed' })
    }

    if (value.mailStatus === 'sent' && value.sentAt === null) {
      context.addIssue({ code: 'custom', path: ['sentAt'], message: 'sent requires sentAt' })
    }
  })

export const CompanyDirectAddPolicySchema = z.enum(['admins', 'members'])

/** A person from directory results by Matrix ID (member or admin), or one address (member only: never admin). */
export const CompanyMemberAdd112RequestSchema = z.union([
  z.strictObject({
    requestId: uuid,
    target: z.strictObject({ kind: z.literal('matrixUser'), memberMatrixUser: CompanyMatrixUser110Schema }),
    role: CompanyAssignableRole13Schema
  }),
  z.strictObject({
    requestId: uuid,
    target: z.strictObject({ kind: z.literal('email'), email: CompanyInviteEmailSchema, locale: CompanyEmailInvitationLocale19Schema }),
    role: z.literal('member')
  })
])

export const COMPANY_MEMBER_ADD_ROSTER_LIMIT = 100 as const

const memberAdd = { schemaVersion: z.literal(COMPANY_WORKSPACE_112_SCHEMA_VERSION), replayed: z.boolean() }

/** Every completed add is HTTP 200 with one outcome, so one client path renders all of them. */
export const CompanyMemberAdd112ResponseSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    ...memberAdd,
    outcome: z.literal('added'),
    companyId: uuid,
    memberRef: CompanyMemberRefSchema,
    role: CompanyAssignableRole13Schema,
    invitationId: uuid,
    authorityGeneration: generation
  }),
  z.strictObject({ ...memberAdd, outcome: z.literal('already_member'), companyId: uuid, memberRef: CompanyMemberRefSchema }),
  z.strictObject({ ...memberAdd, outcome: z.literal('invited'), invitationId: uuid, expiresAt: epochSeconds }),
  z.strictObject({ ...memberAdd, outcome: z.literal('not_allowed'), reason: z.enum(['admins_only', 'owner_only_role']) }),
  z.strictObject({ ...memberAdd, outcome: z.literal('roster_full'), limit: z.literal(COMPANY_MEMBER_ADD_ROSTER_LIMIT) }),
  z.strictObject({ ...memberAdd, outcome: z.literal('unknown_user') })
])

/** What the viewer may do in one company: add, invite only, or neither; and the roles an add may grant. */
export const CompanyMemberAddReadiness112ResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(COMPANY_WORKSPACE_112_SCHEMA_VERSION),
    companyId: uuid,
    directAdd: z.enum(['allowed', 'invite_only', 'not_allowed']),
    policy: CompanyDirectAddPolicySchema,
    assignableRoles: z.array(CompanyAssignableRole13Schema).max(2),
    rosterRemaining: z.number().int().min(0).max(COMPANY_MEMBER_ADD_ROSTER_LIMIT)
  })
  .superRefine((value, context) => {
    if ((value.directAdd === 'not_allowed') !== (value.assignableRoles.length === 0)) {
      context.addIssue({ code: 'custom', path: ['assignableRoles'], message: 'roles are empty exactly when nothing is allowed' })
    }

    if (new Set(value.assignableRoles).size !== value.assignableRoles.length) {
      context.addIssue({ code: 'custom', path: ['assignableRoles'], message: 'roles are unique' })
    }
  })

/** Company policy 1.3: policy 1.2 plus who may add directly. An update under this profile sends all five fields. */
export const CompanyPolicy3Schema = CompanyPolicy12Schema.extend({ directMemberAdd: CompanyDirectAddPolicySchema })
export const CompanyPolicyUpdate3RequestSchema = CompanyPolicyUpdate13RequestSchema.extend({ policy: CompanyPolicy3Schema })
export const CompanyPolicyUpdate3ResponseSchema = CompanyPolicyUpdate13ResponseSchema.extend({ policy: CompanyPolicy3Schema })
export const CompanyAdminSnapshotPolicy3ResponseSchema = CompanyAdminSnapshot13ResponseSchema.safeExtend({
  company: CompanyAdminSnapshot13ResponseSchema.shape.company.extend({ policy: CompanyPolicy3Schema })
})

export type CompanyInviteCapabilities2 = z.infer<typeof CompanyInviteCapabilities2Schema>
export type CompanyInviteCapabilities3 = z.infer<typeof CompanyInviteCapabilities3Schema>
/** Any invite readiness profile this client reads. */
export type CompanyInviteReadiness = CompanyInviteCapabilities | CompanyInviteCapabilities2 | CompanyInviteCapabilities3
export type CompanyEmailInvitationStatus19Response = z.infer<typeof CompanyEmailInvitationStatus19ResponseSchema>
export type CompanyEmailMailStatus = CompanyEmailInvitationStatus19Response['mailStatus']
export type CompanyDirectAddPolicy = z.infer<typeof CompanyDirectAddPolicySchema>
export type CompanyMemberAdd112Request = z.infer<typeof CompanyMemberAdd112RequestSchema>
export type CompanyMemberAdd112Response = z.infer<typeof CompanyMemberAdd112ResponseSchema>
export type CompanyMemberAddReadiness112Response = z.infer<typeof CompanyMemberAddReadiness112ResponseSchema>
export type CompanyPolicy3 = z.infer<typeof CompanyPolicy3Schema>
export type CompanyPolicyUpdate3Response = z.infer<typeof CompanyPolicyUpdate3ResponseSchema>
export type CompanyAdminSnapshotPolicy3Response = z.infer<typeof CompanyAdminSnapshotPolicy3ResponseSchema>

/** The whole 1.3 policy when the snapshot was read with policy 1.3; undefined on an older read. */
export function companyPolicy3(snapshot: CompanyAdminSnapshot13Response | undefined): CompanyPolicy3 | undefined {
  const parsed = CompanyPolicy3Schema.safeParse(snapshot?.company.policy)

  return parsed.success ? parsed.data : undefined
}

/* ------------------------------------------------------------------ native request vocabulary */

const companyId = { companyId: uuid }

/**
 * The closed renderer-to-main vocabulary for Team Space C1/C2. Each member is the frozen wire
 * body (spread from its request schema) plus the action and the path parameters; the renderer
 * never names a URL, a header, a wire version, a principal or an owner. Main splits path from
 * body and parses the body against the frozen request schema again before it is sent.
 */
export const TeamSpaceRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('capabilities') }),
  // company-invites/1 on the same capabilities read: which invite methods the server is configured for. Profile 2 adds
  // real mail delivery state, profile 3 the install-level direct-add signal; without `profile` it is profile 1.
  z.strictObject({ action: z.literal('invite-readiness'), profile: z.enum([COMPANY_INVITES_PROFILE_2, COMPANY_INVITES_PROFILE_3]).optional() }),
  z.strictObject({ action: z.literal('administration'), ...companyId }),
  // company-policy/1.2 on the same administration read: the snapshot plus who may invite (1.3: and who may add).
  z.strictObject({ action: z.literal('administration-policy'), ...companyId, profile: z.literal(COMPANY_POLICY_DIRECT_ADD_PROFILE).optional() }),
  z.strictObject({ action: z.literal('role-change'), ...companyId, ...CompanyRoleChange13RequestSchema.shape }),
  z.strictObject({
    action: z.literal('ownership-transfer'),
    ...companyId,
    ...CompanyOwnershipTransfer13RequestSchema.shape
  }),
  // The 1.3 update names channel creation only and keeps the rest; under policy 1.3 it names all five fields.
  z.strictObject({
    action: z.literal('policy-update'),
    ...companyId,
    ...CompanyPolicyUpdate13RequestSchema.shape,
    policy: z.union([CompanyPolicy3Schema, CompanyPolicy13Schema])
  }),
  // 1.12: what the viewer may do here (add, invite only, neither), and adding one person directly.
  z.strictObject({ action: z.literal('member-add-readiness'), ...companyId }),
  z.strictObject({ action: z.literal('member-add'), ...companyId, requestId: uuid, target: z.union([
    CompanyMemberAdd112RequestSchema.options[0].shape.target,
    CompanyMemberAdd112RequestSchema.options[1].shape.target
  ]), role: CompanyAssignableRole13Schema }),
  // Invites 2: the mail state of one email invitation this viewer created.
  z.strictObject({ action: z.literal('email-invitation-status'), ...companyId, invitationId: uuid }),
  z.strictObject({
    action: z.literal('invitation-create'),
    ...companyId,
    ...CompanyInvitationCreate13RequestSchema.shape
  }),
  // A directory pick (name, exact handle or exact email) by the Matrix user ID it answered with.
  z.strictObject({
    action: z.literal('invitation-create-directory'),
    ...companyId,
    ...CompanyInvitationCreate110RequestSchema.shape
  }),
  // 1.9: an invitation to one complete email address, in the language the invitee should read.
  z.strictObject({
    action: z.literal('email-invitation-create'),
    ...companyId,
    ...CompanyEmailInvitationCreate19RequestSchema.shape
  }),
  z.strictObject({ action: z.literal('invitation-accept'), ...companyId, invitationId: uuid, requestId: uuid }),
  z.strictObject({ action: z.literal('invitation-decline'), ...companyId, invitationId: uuid, requestId: uuid }),
  z.strictObject({ action: z.literal('invitation-cancel'), ...companyId, invitationId: uuid, requestId: uuid }),
  z.strictObject({ action: z.literal('invitation-resend'), ...companyId, invitationId: uuid, requestId: uuid }),
  z.strictObject({ action: z.literal('invite-links'), ...companyId }),
  z.strictObject({
    action: z.literal('invite-link-create'),
    ...companyId,
    ...CompanyInviteLinkCreateRequestSchema.shape
  }),
  z.strictObject({ action: z.literal('invite-link-revoke'), ...companyId, linkId: uuid, requestId: uuid }),
  z.strictObject({ action: z.literal('invite-link-preview'), ...CompanyInviteLinkPreviewRequestSchema.shape }),
  z.strictObject({ action: z.literal('invite-link-redeem'), ...CompanyInviteLinkRedeemRequestSchema.shape }),
  z.strictObject({ action: z.literal('browse-channels'), ...companyId }),
  z.strictObject({ action: z.literal('browse-joinable-channels'), ...companyId }),
  z.strictObject({ action: z.literal('admitted-channels'), ...companyId }),
  z.strictObject({ action: z.literal('read-admitted-channel'), ...companyId, channelId: uuid }),
  z.strictObject({ action: z.literal('channel-members'), ...companyId, channelId: uuid }),
  z.strictObject({
    action: z.literal('channel-command'),
    ...companyId,
    channelId: uuid.optional(),
    command: z.union([CompanyChannelCommand14RequestSchema, CompanyChannelCommand15RequestSchema])
  }),
  z.strictObject({ action: z.literal('conversations'), ...companyId }),
  z.strictObject({ action: z.literal('read-conversation'), ...companyId, conversationId: uuid }),
  z.strictObject({ action: z.literal('conversation-open'), ...companyId, ...CompanyConversationOpen15RequestSchema.shape }),
  z.strictObject({
    action: z.literal('conversation-expand'),
    ...companyId,
    ...CompanyConversationExpand15RequestSchema.shape
  }),
  z.strictObject({
    action: z.literal('conversation-hidden'),
    ...companyId,
    conversationId: uuid,
    ...CompanyConversationHidden15RequestSchema.shape
  }),
  z.strictObject({
    action: z.literal('set-avatar'),
    ...companyId,
    requestId: CompanyAvatarSet17RequestSchema.shape.requestId,
    avatarUri: CompanyAvatarSet17RequestSchema.shape.avatarUri
  })
])

export type TeamSpaceRequest = z.infer<typeof TeamSpaceRequestSchema>
export type TeamSpaceAction = TeamSpaceRequest['action']

/** What each action's validated answer is. Main parses by action, so the renderer may rely on it. */
export interface TeamSpaceValueMap {
  capabilities: CompanyCapabilities13Response
  /** An older server that ignores the invites profile answers the plain 1.3 capabilities (schema 4). */
  'invite-readiness': CompanyInviteReadiness | CompanyCapabilities13Response
  administration: CompanyAdminSnapshot13Response
  /** An older server that ignores the policy profile answers the plain 1.3 snapshot. */
  'administration-policy': CompanyAdminSnapshotPolicy3Response | CompanyAdminSnapshotPolicy12Response | CompanyAdminSnapshot13Response
  'role-change': CompanyRoleChange13Response
  'ownership-transfer': CompanyOwnershipTransfer13Response
  'policy-update': CompanyPolicyUpdate13Response | CompanyPolicyUpdate3Response
  'member-add-readiness': CompanyMemberAddReadiness112Response
  'member-add': CompanyMemberAdd112Response
  'email-invitation-status': CompanyEmailInvitationStatus19Response
  'invitation-create': CompanyInvitationCreate13Response
  'invitation-create-directory': CompanyInvitationCreate110Response
  'email-invitation-create': CompanyEmailInvitationCreate19Response
  'invitation-accept': CompanyInvitationMutation13Response
  'invitation-decline': CompanyInvitationMutation13Response
  'invitation-cancel': CompanyInvitationMutation13Response
  'invitation-resend': CompanyInvitationResend13Response
  'invite-links': CompanyInviteLinkListResponse
  'invite-link-create': CompanyInviteLinkCreateResponse
  'invite-link-revoke': CompanyInviteLinkRevokeResponse
  'invite-link-preview': CompanyInviteLinkPreviewResponse
  'invite-link-redeem': CompanyInviteLinkRedeemResponse
  'browse-channels': CompanyChannelBrowse14Response
  'browse-joinable-channels': CompanyChannelBrowse16Response
  'admitted-channels': CompanyChannelAdmittedDirectory14Response
  'read-admitted-channel': CompanyChannelAdmittedSnapshot14
  'channel-members': CompanyChannelMembers14Response
  // The answer to a channel command depends on its operation: invite, decline and cancel
  // answer with the invitation, a 1.1 create or add with every admission, every other
  // operation with the admission receipt.
  'channel-command': CompanyChannelCommand14Response | CompanyChannelInvitation14Response | CompanyChannelCommand15Response
  conversations: CompanyConversationDirectory15Response
  'read-conversation': CompanyConversationOpen15Response
  'conversation-open': CompanyConversationOpen15Response
  'conversation-expand': CompanyConversationOpen15Response
  'conversation-hidden': CompanyConversationHidden15Response
  'set-avatar': CompanyAvatarSet17Response
}

export type TeamSpaceValue = TeamSpaceValueMap[TeamSpaceAction]

/** Ordinary reads: no pending-mutation journal and freely retried. */
export const TEAM_SPACE_READ_ACTIONS = [
  'capabilities',
  'invite-readiness',
  'administration',
  'administration-policy',
  'member-add-readiness',
  'email-invitation-status',
  'invite-links',
  'browse-channels',
  'browse-joinable-channels',
  'admitted-channels',
  'read-admitted-channel',
  'channel-members',
  'conversations',
  'read-conversation'
] as const

export type TeamSpaceReadAction = (typeof TEAM_SPACE_READ_ACTIONS)[number]

/** Bearer-token actions are POSTs but never enter the persistent company journal. Preview is
 * retryable; redeem gets its stable replay id from the process-memory join flow. */
export const TEAM_SPACE_EPHEMERAL_ACTIONS = ['invite-link-preview', 'invite-link-redeem'] as const
export type TeamSpaceEphemeralAction = (typeof TEAM_SPACE_EPHEMERAL_ACTIONS)[number]

const TEAM_SPACE_ACTIONS: Record<TeamSpaceAction, true> = {
  capabilities: true,
  'invite-readiness': true,
  administration: true,
  'administration-policy': true,
  'role-change': true,
  'ownership-transfer': true,
  'policy-update': true,
  'member-add-readiness': true,
  'member-add': true,
  'email-invitation-status': true,
  'invitation-create': true,
  'invitation-create-directory': true,
  'email-invitation-create': true,
  'invitation-accept': true,
  'invitation-decline': true,
  'invitation-cancel': true,
  'invitation-resend': true,
  'invite-links': true,
  'invite-link-create': true,
  'invite-link-revoke': true,
  'invite-link-preview': true,
  'invite-link-redeem': true,
  'browse-channels': true,
  'browse-joinable-channels': true,
  'admitted-channels': true,
  'read-admitted-channel': true,
  'channel-members': true,
  'channel-command': true,
  conversations: true,
  'read-conversation': true,
  'conversation-open': true,
  'conversation-expand': true,
  'conversation-hidden': true,
  'set-avatar': true
}

const teamSpaceReadSet: ReadonlySet<string> = new Set(TEAM_SPACE_READ_ACTIONS)
const teamSpaceEphemeralSet: ReadonlySet<string> = new Set(TEAM_SPACE_EPHEMERAL_ACTIONS)

export function isTeamSpaceAction(action: unknown): action is TeamSpaceAction {
  return typeof action === 'string' && Object.hasOwn(TEAM_SPACE_ACTIONS, action)
}

export function isTeamSpaceRead(action: string): boolean {
  return teamSpaceReadSet.has(action)
}

export function isTeamSpaceEphemeral(action: string): boolean {
  return teamSpaceEphemeralSet.has(action)
}
