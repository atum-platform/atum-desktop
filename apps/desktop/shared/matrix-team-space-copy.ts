import type { MatrixCompanyRefusalReason } from './matrix-company-team-space'

/**
 * Words for Team Space C1 (roles, ownership, invitations, invite links) and C2 (public and
 * private channels). One table per desktop locale; the completeness test holds every locale to
 * English's keys, and the brand-copy scan keeps internal names out of every value.
 */
export interface MatrixTeamSpaceCopy {
  /* roles */
  owner: string
  admin: string
  member: string

  /* roster and ownership */
  memberActions: (name: string) => string
  makeAdmin: string
  makeMember: string
  makeOwner: string
  removeFromCompany: string
  leaveCompany: string
  you: string
  personalNotes: string
  removing: string
  ownerLeaveHint: string
  roleChanged: (name: string, role: string) => string
  transferTitle: (name: string) => string
  transferBody: (name: string, company: string) => string
  transferConfirm: string
  transferDone: (name: string) => string

  /* invitations */
  pendingInvitations: string
  invitationExpiresIn: (days: number) => string
  invitationExpiresToday: string
  invitationExpired: string
  invitedBy: (name: string) => string
  resendInvitation: string
  cancelInvitation: string
  declineInvitation: string
  invitationResent: string
  invitationCancelled: string
  invitationDeclined: string
  inviteRoleLabel: string
  inviteRoleHint: string

  /* invite link */
  inviteLinkSection: string
  copyInviteLink: string
  inviteLinkCreating: string
  inviteLinkCopied: string
  inviteLinkAudience: string
  inviteLinkDuration: (days: number) => string
  inviteLinkCapacity: (uses: number) => string
  inviteLinkCopyFailed: string
  inviteLinkReplayed: string
  inviteLinksActive: string
  inviteLinkUsage: (used: number, max: number) => string
  inviteLinkExpires: (days: number) => string
  inviteLinkRevoke: string
  inviteLinkRevoked: string
  /**
   * What anyone who opens a link that does not work reads: one message for an invalid, expired, revoked or
   * used-up link alike, so a link never tells a stranger which of them it was.
   */
  inviteLinkInvalid: string

  /* channel-creation policy */
  policyTitle: string
  policyEveryone: string
  policyAdmins: string
  policyHint: string

  /* sidebar */
  favorites: string
  sidebarSearch: (company: string) => string
  archivedSection: string
  addChannels: string
  createChannelItem: string
  browseChannelsItem: string
  privateChannel: string
  publicChannel: string
  archivedTag: string
  channelInvitations: string
  channelInvitationRow: (name: string) => string
  joinChannel: string
  favoriteChannel: string
  unfavoriteChannel: string

  /* create */
  createChannelTitle: string
  createChannelBody: string
  channelNameLabel: string
  channelPurposeLabel: string
  channelTopicLabel: string
  channelVisibilityLabel: string
  visibilityPublic: string
  visibilityPublicHint: string
  visibilityPrivate: string
  visibilityPrivateHint: string
  createChannelSubmit: string
  creatingChannel: string
  channelNamePlaceholder: string
  channelNameRequired: string
  channelNameTooLong: string
  channelPurposeOptional: string
  channelPurposeTooLong: string
  /** Picking people while creating a private channel (Mattermost's "Add members", at creation). */
  channelPeopleSearch: string
  removePerson: (name: string) => string
  addingPeople: string
  channelCreatedTitle: (name: string) => string
  channelAddsFailed: string
  channelPersonAdded: string
  /** Beside a person the new channel could not take because they left the company. */
  channelPersonLeftCompany: string
  channelInviteRetry: string
  channelInvitesDone: string

  /* browse */
  browseTitle: string
  browseSearchLabel: string
  browseFilterPublic: string
  browseFilterArchived: string
  browseEmpty: string
  browseNone: string
  channelMemberCount: (count: number) => string
  joinedBadge: string
  openChannelAction: string
  browseJoinUnavailable: string
  browseCreateRestricted: string
  browseRoomsNotReady: string
  browseLoadFailed: string

  /* open channel */
  archivedBanner: string
  channelStartTitle: (channel: string) => string
  /** The channel intro's line under the description: who made the channel and when. */
  channelCreatedBy: (name: string, date: string) => string
  /** The same line when the maker's name is not known here. */
  channelCreatedOn: (date: string) => string
  addDescription: string
  /** An example in the description field: encouraged at creation, never required. */
  channelPurposePlaceholder: string
  /** The default channel's description until an admin writes one (its name is localized too). */
  defaultChannelPurpose: string
  inviteTeammates: string
  /** The empty channel's Chief of Staff button: it fills the box with `welcomePrompt`, nothing is sent. */
  askAssistant: string
  /** Something the Chief of Staff can do today (it answers in a thread and cannot pin): draft a welcome. */
  welcomePrompt: (assistant: string) => string
  mentionPeople: string
  mentionCompanyAI: string
  mentionChannelHint: string
  mentionChannelConfirmTitle: (count: number) => string
  mentionChannelConfirmBody: string
  mentionChannelConfirm: string
  privateAttachments: string
  channelAttachments: string
  /** The quiet transcript lines for a person coming into, or no longer in, a channel (`you`: the viewer). */
  membershipJoined: (name: string, you: boolean) => string
  membershipDeparted: (name: string, you: boolean) => string
  restoreChannel: string
  channelMembersMenu: string
  addPeople: string
  leaveChannel: string
  archiveChannel: string
  editChannel: string

  /* confirmations */
  leaveChannelTitle: (name: string) => string
  leaveChannelPublic: string
  leaveChannelPrivate: string
  leaveChannelConfirm: string
  archiveChannelTitle: (name: string) => string
  archiveChannelBody: string
  archiveChannelConfirm: string
  /* details and members */
  detailsPublicLine: string
  detailsPrivateLine: string
  detailsVisibilityFixed: string
  saveChanges: string
  savingChanges: string
  channelMembersTitle: string
  channelOwnerTag: string
  memberPending: string
  removeFromChannel: string
  cancelChannelInvite: string
  memberListHidden: string
  membersLoadFailed: string
  addPeopleTitle: string
  addPeopleSearch: string
  addPeopleEmpty: string
  addPersonAction: string
  personInvited: (name: string) => string
  personRemoved: (name: string) => string
  working: string

  /* the company menu and leaving a company */
  invitePeople: string
  companySettings: string
  leaveCompanyTitle: (company: string) => string
  leaveCompanyBody: string
  leaveCompanyLastMemberBody: string
  leaveCompanyWalletNotEmptyTooltip: string
  leaveCompanyConfirm: string
  /** A dialog was open when the person's role changed: the action is no longer theirs to take. */
  noLongerAllowed: string

  /* company conversations: direct messages and group messages inside a company */
  directMessages: string
  newMessage: string
  newMessageHint: string
  newMessageNobody: string
  peopleNoMatch: string
  newMessageStart: string
  newMessageLimit: string
  peopleSelected: (count: number) => string
  conversationGroup: (count: number) => string
  conversationReadOnlyBanner: string
  conversationReadOnlyTag: string
  conversationSettingUp: string
  conversationHide: string
  hiddenConversations: string
  conversationAddConfirm: string
  conversationsLoading: string
  conversationsFailed: string
  conversationAttachments: string
  conversationNotReady: string
  conversationOpenFailed: string
  openConversation: (name: string) => string
  conversationMenu: string
  conversationNone: string
  conversationsDisabled: string

  /* typed refusals, by the platform's reason */
  /** The Add people sheet: one search field, a row per person with one action, and what became of each. */
  inviteSheet: {
    title: (company: string) => string
    search: string
    add: string
    alreadyMember: string
    alreadyInvited: string
    invited: (name: string) => string
    emailRow: (email: string) => string
    emailInvited: (email: string) => string
    emailNotSent: string
    emailOff: string
    notAllowed: string
    notFound: string
    cantInvite: string
    emailNotSentNoLink: string
    byEmail: string
    /** The rail's Team space badge when invitations wait: "Team space · Invitations: 2". */
    railInvitations: string
    /** Direct add (1.12): the button when this viewer may only invite, and what became of an add. */
    invite: string
    added: (name: string) => string
    addedRow: string
    alreadyMemberLine: (name: string) => string
    cantAdd: string
    adminsOnly: string
    ownerOnlyRole: string
    rosterFull: string
    roomFor: (count: number) => string
    /** The mail state of an email invitation (invites 2). Queued can last: it is never said as sent. */
    mailQueued: string
    mailSent: string
    mailFailed: string
    mailCancelled: string
    emailFailedNote: string
    /** Company settings: who may add people directly (policy 1.3). */
    directAddTitle: string
    directAddMembers: string
    directAddAdmins: string
    directAddHint: string
    /** The one action on a join link made for another email address. */
    ok: string
  }
  refusal: Record<MatrixCompanyRefusalReason, string>
}

const copy: Record<string, MatrixTeamSpaceCopy> = {
  en: {
    owner: 'Owner',
    admin: 'Admin',
    member: 'Member',
    memberActions: name => `Actions for ${name}`,
    makeAdmin: 'Make admin',
    makeMember: 'Make member',
    makeOwner: 'Make owner…',
    removeFromCompany: 'Remove from company',
    leaveCompany: 'Leave company',
    you: 'You',
    personalNotes: 'Your personal notes',
    removing: 'Removing…',
    ownerLeaveHint: 'Make someone else the owner before you leave.',
    roleChanged: (name, role) => `${name} is now ${role}.`,
    transferTitle: name => `Make ${name} the owner?`,
    transferBody: (name, company) => `${name} owns ${company}; you become an admin.`,
    transferConfirm: 'Make owner',
    transferDone: name => `${name} is now the owner.`,
    pendingInvitations: 'Pending invitations',
    invitationExpiresIn: days => (days === 1 ? 'Expires in 1 day' : `Expires in ${days} days`),
    invitationExpiresToday: 'Expires today',
    invitationExpired: 'Expired',
    invitedBy: name => `Invited by ${name}`,
    resendInvitation: 'Resend',
    cancelInvitation: 'Cancel',
    declineInvitation: 'Decline',
    invitationResent: 'Invitation sent again',
    invitationCancelled: 'Invitation cancelled',
    invitationDeclined: 'Invitation declined',
    inviteRoleLabel: 'Role',
    inviteRoleHint: 'Admins can invite and remove members.',
    inviteLinkSection: 'Or share a link',
    copyInviteLink: 'Copy invite link',
    inviteLinkCreating: 'Creating link…',
    inviteLinkCopied: 'Link copied',
    inviteLinkAudience: 'Anyone with this link can join as a member.',
    inviteLinkDuration: days => `Works for ${days === 1 ? '1 day' : `${days} days`}.`,
    inviteLinkCapacity: uses => (uses === 1 ? 'One person can use it.' : `Up to ${uses} people can use it.`),
    inviteLinkCopyFailed: 'Couldn’t copy it automatically. Select the link and copy it yourself.',
    inviteLinkReplayed: 'This link was created, but it can only be shown once. Revoke it and create a new one.',
    inviteLinksActive: 'Links you can still use',
    inviteLinkUsage: (used, max) => `${used} of ${max} used`,
    inviteLinkExpires: days =>
      days === 0 ? 'expires today' : days === 1 ? 'expires in 1 day' : `expires in ${days} days`,
    inviteLinkRevoke: 'Revoke',
    inviteLinkRevoked: 'Link revoked',
    inviteLinkInvalid: 'This invite link is invalid. Ask a company admin for a new invitation.',
    policyTitle: 'Who can create channels',
    policyEveryone: 'Everyone',
    policyAdmins: 'Owner and admins',
    policyHint: 'Only new channels use this setting.',
    favorites: 'Favorites',
    sidebarSearch: company => `Search ${company}`,
    archivedSection: 'Archived',
    addChannels: 'Add channels',
    createChannelItem: 'Create a channel',
    browseChannelsItem: 'Browse channels',
    privateChannel: 'Private channel',
    publicChannel: 'Public channel',
    archivedTag: 'Archived',
    channelInvitations: 'Invitations',
    channelInvitationRow: name => `Invited to ${name}`,
    joinChannel: 'Join',
    favoriteChannel: 'Add to favorites',
    unfavoriteChannel: 'Remove from favorites',
    createChannelTitle: 'Create a channel',
    createChannelBody: 'A channel keeps one topic’s conversation in one place.',
    channelNameLabel: 'Name',
    channelPurposeLabel: 'Description',
    channelTopicLabel: 'Topic',
    channelVisibilityLabel: 'Visibility',
    visibilityPublic: 'Public',
    visibilityPublicHint: 'Everyone in the company can find it and join.',
    visibilityPrivate: 'Private',
    visibilityPrivateHint: 'Only the people you add can find it.',
    createChannelSubmit: 'Create channel',
    creatingChannel: 'Creating…',
    channelNamePlaceholder: 'e.g. Launch plans',
    channelNameRequired: 'Give the channel a name.',
    channelNameTooLong: 'Use 80 characters or fewer.',
    channelPurposeOptional: 'Optional',
    channelPurposeTooLong: 'Use 500 characters or fewer.',
    channelPeopleSearch: 'Search by name or @username',
    removePerson: name => `Remove ${name}`,
    addingPeople: 'Adding people…',
    channelCreatedTitle: name => `#${name} is ready`,
    channelAddsFailed: 'Some people couldn’t be added.',
    channelPersonAdded: 'Added',
    channelPersonLeftCompany: 'No longer in the company.',
    channelInviteRetry: 'Try again',
    channelInvitesDone: 'Done',
    browseTitle: 'Browse channels',
    browseSearchLabel: 'Search channels',
    browseFilterPublic: 'Public',
    browseFilterArchived: 'Archived',
    browseEmpty: 'No channels match your search.',
    browseNone: 'There are no public channels yet.',
    channelMemberCount: count => (count === 1 ? '1 member' : `${count} members`),
    joinedBadge: 'Joined',
    openChannelAction: 'View',
    browseJoinUnavailable: 'Joining a channel from here isn’t available yet.',
    browseCreateRestricted: 'Only the owner and admins can create channels.',
    browseRoomsNotReady: 'New channels can’t be created right now. Try again soon.',
    browseLoadFailed: 'Couldn’t load the channels. Check your connection and try again.',
    archivedBanner: 'Archived: read-only until an admin restores it.',
    channelStartTitle: channel => `This is the start of #${channel}`,
    channelCreatedBy: (name, date) => `${name} created this channel on ${date}.`,
    channelCreatedOn: date => `Created on ${date}.`,
    addDescription: 'Add a description',
    channelPurposePlaceholder: 'What’s it for? E.g. weekly plans and launch news',
    defaultChannelPurpose: 'Everyone in the company is here: news and anything all of us should see.',
    inviteTeammates: 'Invite teammates',
    askAssistant: 'Ask Chief of Staff',
    welcomePrompt: assistant => `@${assistant} draft a short welcome message for this channel`,
    mentionPeople: 'Mention someone',
    mentionCompanyAI: 'AI',
    mentionChannelHint: 'Notify everyone in this channel',
    mentionChannelConfirmTitle: count => `Notify ${count} people?`,
    mentionChannelConfirmBody: 'Everyone in this channel will get a mention notification.',
    mentionChannelConfirm: 'Notify channel',
    privateAttachments: 'Files can’t be attached in private channels yet.',
    channelAttachments: 'Files aren’t available in this channel yet.',
    membershipJoined: (name, you) => (you ? 'You joined the channel' : `${name} joined the channel`),
    membershipDeparted: (name, you) =>
      you ? 'You are no longer in this channel' : `${name} is no longer in this channel`,
    restoreChannel: 'Restore channel',
    channelMembersMenu: 'Members',
    addPeople: 'Add people',
    leaveChannel: 'Leave channel',
    archiveChannel: 'Archive channel',
    editChannel: 'Edit channel',
    leaveChannelTitle: name => `Leave ${name}?`,
    leaveChannelPublic: 'Leave now; rejoin later from Browse channels.',
    leaveChannelPrivate: 'Leave now; returning needs a new invitation.',
    leaveChannelConfirm: 'Leave channel',
    archiveChannelTitle: name => `Archive ${name}?`,
    archiveChannelBody: 'Archived channels stay readable but become read-only.',
    archiveChannelConfirm: 'Archive channel',
    detailsPublicLine: 'Public · everyone in the company can find it',
    detailsPrivateLine: 'Private · only people who were added can find it',
    detailsVisibilityFixed: 'Visibility can’t be changed after a channel is created.',
    saveChanges: 'Save changes',
    savingChanges: 'Saving…',
    channelMembersTitle: 'Channel members',
    channelOwnerTag: 'Channel owner',
    memberPending: 'Invited',
    removeFromChannel: 'Remove',
    cancelChannelInvite: 'Cancel invitation',
    memberListHidden: 'Only owners and admins can view this member list.',
    membersLoadFailed: 'Couldn’t load members. Try again.',
    addPeopleTitle: 'Add people',
    addPeopleSearch: 'Search people',
    addPeopleEmpty: 'Everyone in the company is already here.',
    addPersonAction: 'Add',
    personInvited: name => `${name} was invited.`,
    personRemoved: name => `${name} was removed.`,
    working: 'Working…',
    invitePeople: 'Invite teammates',
    companySettings: 'Company settings',
    leaveCompanyTitle: company => `Leave ${company}?`,
    leaveCompanyBody: 'Leave now; returning needs a new invitation.',
    leaveCompanyLastMemberBody: 'The company closes when its last member leaves. Returning needs a new invitation.',
    leaveCompanyWalletNotEmptyTooltip: 'Use or move the Protons first, or ask another member to stay as owner.',
    leaveCompanyConfirm: 'Leave',
    noLongerAllowed: 'Your role changed, so you can’t do this any more.',
    directMessages: 'Direct messages',
    newMessage: 'New message',
    newMessageHint: 'Choose one person or make a group.',
    newMessageNobody: 'No one else is in this company yet.',
    peopleNoMatch: 'No one matches that.',
    newMessageStart: 'Start conversation',
    newMessageLimit: 'A group can have up to 8 other people.',
    peopleSelected: count => `Selected: ${count}`,
    conversationGroup: count => `Group of ${count}`,
    conversationReadOnlyBanner: 'Read-only because someone left the company.',
    conversationReadOnlyTag: 'Read-only',
    conversationSettingUp: 'Setting up…',
    conversationHide: 'Hide conversation',
    hiddenConversations: 'Hidden',
    conversationAddConfirm: 'Start new conversation',
    conversationsLoading: 'Loading conversations…',
    conversationsFailed: 'Conversations couldn’t be loaded.',
    conversationAttachments: 'Files can’t be attached in direct messages yet.',
    conversationNotReady: 'This conversation is still being set up.',
    conversationOpenFailed: 'Couldn’t open this conversation yet.',
    openConversation: name => `Open conversation with ${name}`,
    conversationMenu: 'Conversation options',
    conversationNone: 'No direct messages yet.',
    conversationsDisabled: 'Direct messages aren’t available right now.',
    inviteSheet: {
      title: company => `Add people to ${company}`,
      search: 'Name, @username or email',
      add: 'Add',
      alreadyMember: 'Already a member',
      alreadyInvited: 'Invited',
      invited: name => `Invited ${name}. They’ll see it in Atum.`,
      emailRow: email => `Invite ${email} by email`,
      emailInvited: email => `Invited ${email} by email.`,
      emailNotSent: 'No email goes out yet, so send them the invite link.',
      emailOff: 'Email invites aren’t on yet. Send the invite link instead.',
      notAllowed: 'Only owners and admins can invite people here.',
      notFound: 'No one matches. Try their email.',
      cantInvite: 'Can’t invite them. They may already be invited.',
      emailNotSentNoLink: 'No email goes out yet.',
      byEmail: 'By email',
      railInvitations: 'Invitations',
      invite: 'Invite',
      added: name => `Added ${name}.`,
      addedRow: 'Added',
      alreadyMemberLine: name => `${name} is already a member.`,
      cantAdd: 'Can’t add them.',
      adminsOnly: 'Only owners and admins can add people here. You can invite them.',
      ownerOnlyRole: 'Only the owner can add an admin.',
      rosterFull: 'This company is full (100 people).',
      roomFor: count => count === 1 ? 'Room for 1 more person.' : `Room for ${count} more people.`,
      mailQueued: 'Email waiting to send',
      mailSent: 'Email sent',
      mailFailed: 'Email not sent',
      mailCancelled: 'Email cancelled',
      emailFailedNote: 'Send them the invite link.',
      directAddTitle: 'Who can add people directly',
      directAddMembers: 'Members',
      directAddAdmins: 'Admins only',
      directAddHint: 'Everyone else sends an invite.',
      ok: 'OK'
    },
    refusal: {
      invite_target_unavailable: 'No user was found for that username. Check it and try again.',
      invite_lookup_limited: 'Too many attempts. Try again in a few minutes.',
      company_creation_closed: 'Creating companies is not open yet.',
      last_admin: 'A company needs an admin. Make someone else an admin first.',
      company_wallet_not_empty: "The company wallet still holds Protons, so you can't leave the company yet.",
      invite_link_unavailable: 'This invite link is invalid. Ask a company admin for a new invitation.',
      invite_link_limit_reached: 'This company has too many active links. Revoke one first.',
      invite_link_rate_limited: 'Too many links were created. Try again in a few minutes.',
      owner_transfer_required: 'Make someone else the owner before you leave.',
      owner_generation_conflict: 'The company changed while you were deciding. Check the list and try again.',
      role_change_forbidden: 'You can’t change this person’s role.',
      owner_target_unavailable: 'That person is no longer an active member.',
      invitation_unavailable: 'That invitation is no longer available.',
      invitation_terminal: 'That invitation has already ended.',
      invitation_expired: 'That invitation expired. Send a new one.',
      invitation_changed_input: 'That invitation was already used for something else. Try again.',
      channel_unavailable: 'This channel isn’t available anymore.',
      channel_invitation_unavailable: 'That invitation isn’t available anymore.',
      channel_not_admitted: 'You’re not in this channel.',
      channel_creation_restricted: 'Only the owner and admins can create channels in this company.',
      channel_visibility_immutable: 'A channel’s visibility can’t be changed.',
      default_channel_protected: 'The default channel can’t be left or archived.',
      channel_archived: 'This channel is archived.',
      channel_name_conflict: 'A public channel with that name already exists.',
      admission_generation_conflict: 'This channel changed while you were looking. Try again.',
      conversation_unavailable: 'This conversation isn’t available anymore.',
      participant_unavailable: 'One of the people you picked isn’t available. Check the list and try again.',
      participant_limit: 'A group can have at most 9 people, including you.',
      participant_set_conflict: 'This group changed while you were choosing. Try again.',
      admission_epoch_conflict: 'Someone’s membership changed while you were choosing. Try again.',
      conversation_read_only: 'This conversation is read-only, so no one can be added.',
      email_invite_denied: 'You can’t invite people to this company.',
      email_invite_claim_required: 'This invite was sent to an email address. Sign in with the invited address to join.',
      email_invite_capacity: 'This company can’t take more invitations right now. Try again later.',
      email_invite_limited: 'Too many invitations. Try again in a few minutes.',
      email_invite_identity_unavailable: 'Couldn’t check that address right now. Try again.',
      email_invite_verification_unavailable: 'Couldn’t check that address right now. Try again.',
      member_add_limited: 'You’ve added a lot of people. Try again in a while.'
    }
  },
  vi: {
    owner: 'Chủ sở hữu',
    admin: 'Quản trị viên',
    member: 'Thành viên',
    memberActions: name => `Thao tác với ${name}`,
    makeAdmin: 'Đặt làm quản trị viên',
    makeMember: 'Đặt làm thành viên',
    makeOwner: 'Chuyển quyền sở hữu…',
    removeFromCompany: 'Gỡ khỏi công ty',
    leaveCompany: 'Rời công ty',
    you: 'Bạn',
    personalNotes: 'Ghi chú cá nhân của bạn',
    removing: 'Đang gỡ…',
    ownerLeaveHint: 'Hãy chuyển quyền sở hữu cho người khác trước khi rời.',
    roleChanged: (name, role) => `${name} giờ là ${role}.`,
    transferTitle: name => `Chuyển quyền sở hữu cho ${name}?`,
    transferBody: (name, company) => `${name} sở hữu ${company}; bạn thành quản trị viên.`,
    transferConfirm: 'Chuyển quyền sở hữu',
    transferDone: name => `${name} giờ là chủ sở hữu.`,
    pendingInvitations: 'Lời mời đang chờ',
    invitationExpiresIn: days => `Hết hạn sau ${days} ngày`,
    invitationExpiresToday: 'Hết hạn hôm nay',
    invitationExpired: 'Đã hết hạn',
    invitedBy: name => `${name} đã mời`,
    resendInvitation: 'Gửi lại',
    cancelInvitation: 'Hủy',
    declineInvitation: 'Từ chối',
    invitationResent: 'Đã gửi lại lời mời',
    invitationCancelled: 'Đã hủy lời mời',
    invitationDeclined: 'Đã từ chối lời mời',
    inviteRoleLabel: 'Vai trò',
    inviteRoleHint: 'Quản trị viên có thể mời và gỡ thành viên.',
    inviteLinkSection: 'Hoặc chia sẻ một liên kết',
    copyInviteLink: 'Sao chép liên kết mời',
    inviteLinkCreating: 'Đang tạo liên kết…',
    inviteLinkCopied: 'Đã sao chép liên kết',
    inviteLinkAudience: 'Ai có liên kết này đều tham gia được với vai trò thành viên.',
    inviteLinkDuration: days => `Dùng được trong ${days} ngày.`,
    inviteLinkCapacity: uses => `Tối đa ${uses} người dùng được.`,
    inviteLinkCopyFailed: 'Chưa sao chép tự động được. Hãy chọn liên kết và tự sao chép.',
    inviteLinkReplayed: 'Liên kết này đã được tạo nhưng chỉ hiện một lần. Hãy thu hồi và tạo liên kết mới.',
    inviteLinksActive: 'Liên kết còn dùng được',
    inviteLinkUsage: (used, max) => `Đã dùng ${used}/${max}`,
    inviteLinkExpires: days => (days === 0 ? 'hết hạn hôm nay' : `hết hạn sau ${days} ngày`),
    inviteLinkRevoke: 'Thu hồi',
    inviteLinkRevoked: 'Đã thu hồi liên kết',
    inviteLinkInvalid: 'Liên kết mời này không hợp lệ. Hãy nhờ quản trị viên công ty gửi lời mời mới.',
    policyTitle: 'Ai được tạo kênh',
    policyEveryone: 'Mọi người',
    policyAdmins: 'Chủ sở hữu và quản trị viên',
    policyHint: 'Chỉ kênh mới dùng cài đặt này.',
    favorites: 'Yêu thích',
    sidebarSearch: company => `Tìm trong ${company}`,
    archivedSection: 'Đã lưu trữ',
    addChannels: 'Thêm kênh',
    createChannelItem: 'Tạo kênh',
    browseChannelsItem: 'Duyệt kênh',
    privateChannel: 'Kênh riêng tư',
    publicChannel: 'Kênh công khai',
    archivedTag: 'Đã lưu trữ',
    channelInvitations: 'Lời mời',
    channelInvitationRow: name => `Được mời vào ${name}`,
    joinChannel: 'Tham gia',
    favoriteChannel: 'Thêm vào yêu thích',
    unfavoriteChannel: 'Bỏ khỏi yêu thích',
    createChannelTitle: 'Tạo kênh',
    createChannelBody: 'Mỗi kênh gom cuộc trò chuyện của một chủ đề vào một chỗ.',
    channelNameLabel: 'Tên',
    channelPurposeLabel: 'Mô tả',
    channelTopicLabel: 'Chủ đề',
    channelVisibilityLabel: 'Chế độ hiển thị',
    visibilityPublic: 'Công khai',
    visibilityPublicHint: 'Mọi người trong công ty đều tìm thấy và tham gia được.',
    visibilityPrivate: 'Riêng tư',
    visibilityPrivateHint: 'Chỉ những người bạn thêm mới thấy kênh này.',
    createChannelSubmit: 'Tạo kênh',
    creatingChannel: 'Đang tạo…',
    channelNamePlaceholder: 'VD: Kế hoạch ra mắt',
    channelNameRequired: 'Hãy đặt tên cho kênh.',
    channelNameTooLong: 'Tên tối đa 80 ký tự.',
    channelPurposeOptional: 'Không bắt buộc',
    channelPurposeTooLong: 'Mô tả tối đa 500 ký tự.',
    channelPeopleSearch: 'Tìm theo tên hoặc @tên người dùng',
    removePerson: name => `Bỏ ${name}`,
    addingPeople: 'Đang thêm…',
    channelCreatedTitle: name => `#${name} đã sẵn sàng`,
    channelAddsFailed: 'Chưa thêm được một vài người.',
    channelPersonAdded: 'Đã thêm',
    channelPersonLeftCompany: 'Không còn trong công ty.',
    channelInviteRetry: 'Thử lại',
    channelInvitesDone: 'Xong',
    browseTitle: 'Duyệt kênh',
    browseSearchLabel: 'Tìm kênh',
    browseFilterPublic: 'Công khai',
    browseFilterArchived: 'Đã lưu trữ',
    browseEmpty: 'Không có kênh nào khớp.',
    browseNone: 'Chưa có kênh công khai nào.',
    channelMemberCount: count => `${count} thành viên`,
    joinedBadge: 'Đã tham gia',
    openChannelAction: 'Xem',
    browseJoinUnavailable: 'Chưa tham gia kênh từ đây được.',
    browseCreateRestricted: 'Chỉ chủ sở hữu và quản trị viên được tạo kênh.',
    browseRoomsNotReady: 'Hiện chưa tạo được kênh mới. Hãy thử lại sau.',
    browseLoadFailed: 'Chưa tải được danh sách kênh. Hãy kiểm tra kết nối rồi thử lại.',
    archivedBanner: 'Đã lưu trữ: chỉ đọc đến khi quản trị viên khôi phục.',
    channelStartTitle: channel => `Đây là phần đầu của #${channel}`,
    channelCreatedBy: (name, date) => `${name} đã tạo kênh này vào ${date}.`,
    channelCreatedOn: date => `Được tạo vào ${date}.`,
    addDescription: 'Thêm mô tả',
    channelPurposePlaceholder: 'Kênh này để làm gì? Ví dụ: kế hoạch tuần, tin ra mắt',
    defaultChannelPurpose: 'Cả công ty đều ở đây: tin chung và mọi điều ai cũng cần biết.',
    inviteTeammates: 'Mời đồng nghiệp',
    askAssistant: 'Hỏi Chief of Staff',
    welcomePrompt: assistant => `@${assistant} soạn giúp một lời chào ngắn cho kênh này`,
    mentionPeople: 'Nhắc đến ai đó',
    mentionCompanyAI: 'AI',
    mentionChannelHint: 'Thông báo cho mọi người trong kênh này',
    mentionChannelConfirmTitle: count => `Thông báo cho ${count} người?`,
    mentionChannelConfirmBody: 'Mọi người trong kênh này sẽ nhận được thông báo nhắc đến.',
    mentionChannelConfirm: 'Thông báo cho kênh',
    privateAttachments: 'Chưa đính kèm tệp được trong kênh riêng tư.',
    channelAttachments: 'Kênh này chưa gửi được tệp.',
    membershipJoined: (name, you) => (you ? 'Bạn đã tham gia kênh' : `${name} đã tham gia kênh`),
    membershipDeparted: (name, you) => (you ? 'Bạn không còn trong kênh này' : `${name} không còn trong kênh này`),
    restoreChannel: 'Khôi phục kênh',
    channelMembersMenu: 'Thành viên',
    addPeople: 'Thêm người',
    leaveChannel: 'Rời kênh',
    archiveChannel: 'Lưu trữ kênh',
    editChannel: 'Sửa kênh',
    leaveChannelTitle: name => `Rời ${name}?`,
    leaveChannelPublic: 'Rời bây giờ; tham gia lại từ Duyệt kênh.',
    leaveChannelPrivate: 'Rời bây giờ; quay lại cần lời mời mới.',
    leaveChannelConfirm: 'Rời kênh',
    archiveChannelTitle: name => `Lưu trữ ${name}?`,
    archiveChannelBody: 'Kênh lưu trữ vẫn đọc được nhưng không đăng được.',
    archiveChannelConfirm: 'Lưu trữ kênh',
    detailsPublicLine: 'Công khai · mọi người trong công ty đều tìm thấy',
    detailsPrivateLine: 'Riêng tư · chỉ những người được thêm mới tìm thấy',
    detailsVisibilityFixed: 'Không đổi được chế độ hiển thị sau khi tạo kênh.',
    saveChanges: 'Lưu thay đổi',
    savingChanges: 'Đang lưu…',
    channelMembersTitle: 'Thành viên kênh',
    channelOwnerTag: 'Chủ kênh',
    memberPending: 'Đã mời',
    removeFromChannel: 'Gỡ',
    cancelChannelInvite: 'Hủy lời mời',
    memberListHidden: 'Chỉ chủ sở hữu và quản trị viên xem được danh sách.',
    membersLoadFailed: 'Chưa tải được thành viên. Hãy thử lại.',
    addPeopleTitle: 'Thêm người',
    addPeopleSearch: 'Tìm người',
    addPeopleEmpty: 'Mọi người trong công ty đều đã ở đây.',
    addPersonAction: 'Thêm',
    personInvited: name => `Đã mời ${name}.`,
    personRemoved: name => `Đã gỡ ${name}.`,
    working: 'Đang xử lý…',
    invitePeople: 'Mời đồng nghiệp',
    companySettings: 'Cài đặt công ty',
    leaveCompanyTitle: company => `Rời ${company}?`,
    leaveCompanyBody: 'Rời bây giờ; quay lại cần lời mời mới.',
    leaveCompanyLastMemberBody: 'Công ty sẽ đóng khi thành viên cuối cùng rời đi. Muốn quay lại cần lời mời mới.',
    leaveCompanyWalletNotEmptyTooltip: 'Hãy dùng hoặc chuyển Protons trước, hoặc nhờ một thành viên khác ở lại làm chủ sở hữu.',
    leaveCompanyConfirm: 'Rời',
    noLongerAllowed: 'Vai trò của bạn đã thay đổi nên bạn không thể làm việc này nữa.',
    directMessages: 'Tin nhắn trực tiếp',
    newMessage: 'Tin nhắn mới',
    newMessageHint: 'Chọn một người hoặc tạo nhóm.',
    newMessageNobody: 'Chưa có ai khác trong công ty.',
    peopleNoMatch: 'Không có ai khớp.',
    newMessageStart: 'Bắt đầu trò chuyện',
    newMessageLimit: 'Một nhóm có tối đa 8 người khác.',
    peopleSelected: count => `Đã chọn: ${count}`,
    conversationGroup: count => `Nhóm ${count} người`,
    conversationReadOnlyBanner: 'Chỉ đọc vì có người đã rời công ty.',
    conversationReadOnlyTag: 'Chỉ đọc',
    conversationSettingUp: 'Đang thiết lập…',
    conversationHide: 'Ẩn cuộc trò chuyện',
    hiddenConversations: 'Đã ẩn',
    conversationAddConfirm: 'Tạo cuộc trò chuyện mới',
    conversationsLoading: 'Đang tải cuộc trò chuyện…',
    conversationsFailed: 'Không tải được các cuộc trò chuyện.',
    conversationAttachments: 'Chưa đính kèm tệp được trong tin nhắn trực tiếp.',
    conversationNotReady: 'Cuộc trò chuyện vẫn đang được thiết lập.',
    conversationOpenFailed: 'Chưa mở được cuộc trò chuyện này.',
    openConversation: name => `Mở cuộc trò chuyện với ${name}`,
    conversationMenu: 'Tùy chọn cuộc trò chuyện',
    conversationNone: 'Chưa có tin nhắn trực tiếp nào.',
    conversationsDisabled: 'Hiện chưa dùng được tin nhắn trực tiếp.',
    inviteSheet: {
      title: company => `Thêm người vào ${company}`,
      search: 'Tên, @tên người dùng hoặc email',
      add: 'Thêm',
      alreadyMember: 'Đã là thành viên',
      alreadyInvited: 'Đã mời',
      invited: name => `Đã mời ${name}. Họ sẽ thấy lời mời trong Atum.`,
      emailRow: email => `Mời ${email} qua email`,
      emailInvited: email => `Đã mời ${email} qua email.`,
      emailNotSent: 'Atum chưa gửi email, hãy gửi họ liên kết mời.',
      emailOff: 'Lời mời qua email chưa được bật. Hãy gửi liên kết mời.',
      notAllowed: 'Ở đây chỉ chủ sở hữu và quản trị viên mới mời được người.',
      notFound: 'Không có ai khớp. Hãy thử email của họ.',
      cantInvite: 'Không mời được người này. Có thể họ đã được mời.',
      emailNotSentNoLink: 'Atum chưa gửi email.',
      byEmail: 'Qua email',
      railInvitations: 'Lời mời',
      invite: 'Mời',
      added: name => `Đã thêm ${name}.`,
      addedRow: 'Đã thêm',
      alreadyMemberLine: name => `${name} đã là thành viên.`,
      cantAdd: 'Không thêm được người này.',
      adminsOnly: 'Ở đây chỉ chủ sở hữu và quản trị viên mới thêm được người. Bạn có thể mời họ.',
      ownerOnlyRole: 'Chỉ chủ sở hữu mới thêm được quản trị viên.',
      rosterFull: 'Công ty đã đủ 100 người.',
      roomFor: count => `Còn chỗ cho ${count} người.`,
      mailQueued: 'Email đang chờ gửi',
      mailSent: 'Đã gửi email',
      mailFailed: 'Chưa gửi được email',
      mailCancelled: 'Đã huỷ email',
      emailFailedNote: 'Hãy gửi họ liên kết mời.',
      directAddTitle: 'Ai được thêm người trực tiếp',
      directAddMembers: 'Thành viên',
      directAddAdmins: 'Chỉ quản trị viên',
      directAddHint: 'Những người khác sẽ gửi lời mời.',
      ok: 'OK'
    },
    refusal: {
      invite_target_unavailable: 'Không tìm thấy người dùng này. Hãy kiểm tra lại tên người dùng.',
      invite_lookup_limited: 'Bạn đã thử quá nhiều lần. Hãy thử lại sau ít phút.',
      company_creation_closed: 'Hiện chưa mở tạo công ty.',
      last_admin: 'Công ty cần có quản trị viên. Hãy đặt người khác làm quản trị viên trước.',
      company_wallet_not_empty: 'Ví công ty vẫn còn Protons, nên chưa thể rời công ty.',
      invite_link_unavailable: 'Liên kết mời này không hợp lệ. Hãy nhờ quản trị viên công ty gửi lời mời mới.',
      invite_link_limit_reached: 'Công ty đang có quá nhiều liên kết còn hiệu lực. Hãy thu hồi bớt một liên kết.',
      invite_link_rate_limited: 'Đã tạo quá nhiều liên kết. Hãy thử lại sau ít phút.',
      owner_transfer_required: 'Hãy chuyển quyền sở hữu cho người khác trước khi rời.',
      owner_generation_conflict: 'Công ty đã thay đổi trong lúc bạn cân nhắc. Hãy xem lại danh sách rồi thử lại.',
      role_change_forbidden: 'Bạn không đổi được vai trò của người này.',
      owner_target_unavailable: 'Người này không còn là thành viên đang hoạt động.',
      invitation_unavailable: 'Lời mời này không còn nữa.',
      invitation_terminal: 'Lời mời này đã kết thúc.',
      invitation_expired: 'Lời mời đã hết hạn. Hãy gửi lời mời mới.',
      invitation_changed_input: 'Lời mời này đã được dùng cho việc khác. Hãy thử lại.',
      channel_unavailable: 'Kênh này không còn nữa.',
      channel_invitation_unavailable: 'Lời mời này không còn nữa.',
      channel_not_admitted: 'Bạn không ở trong kênh này.',
      channel_creation_restricted: 'Chỉ chủ sở hữu và quản trị viên được tạo kênh trong công ty này.',
      channel_visibility_immutable: 'Không đổi được chế độ hiển thị của kênh.',
      default_channel_protected: 'Kênh mặc định không rời hay lưu trữ được.',
      channel_archived: 'Kênh này đã lưu trữ.',
      channel_name_conflict: 'Đã có một kênh công khai trùng tên này.',
      admission_generation_conflict: 'Kênh đã thay đổi trong lúc bạn xem. Hãy thử lại.',
      conversation_unavailable: 'Cuộc trò chuyện này không còn nữa.',
      participant_unavailable: 'Một trong những người bạn chọn hiện không khả dụng. Hãy kiểm tra danh sách và thử lại.',
      participant_limit: 'Một nhóm có tối đa 9 người, tính cả bạn.',
      participant_set_conflict: 'Nhóm đã thay đổi trong lúc bạn chọn. Hãy thử lại.',
      admission_epoch_conflict: 'Tư cách thành viên của ai đó đã thay đổi trong lúc bạn chọn. Hãy thử lại.',
      conversation_read_only: 'Cuộc trò chuyện này chỉ để đọc nên không thể thêm người.',
      email_invite_denied: 'Bạn không thể mời người vào công ty này.',
      email_invite_claim_required: 'Lời mời này được gửi tới một địa chỉ email. Hãy đăng nhập bằng địa chỉ được mời để tham gia.',
      email_invite_capacity: 'Công ty này tạm thời không nhận thêm lời mời. Hãy thử lại sau.',
      email_invite_limited: 'Bạn đã mời quá nhiều lần. Hãy thử lại sau ít phút.',
      email_invite_identity_unavailable: 'Chưa kiểm tra được địa chỉ này. Hãy thử lại.',
      email_invite_verification_unavailable: 'Chưa kiểm tra được địa chỉ này. Hãy thử lại.',
      member_add_limited: 'Bạn đã thêm khá nhiều người. Hãy thử lại sau.'
    }
  },
  ja: {
    owner: 'オーナー',
    admin: '管理者',
    member: 'メンバー',
    memberActions: name => `${name} の操作`,
    makeAdmin: '管理者にする',
    makeMember: 'メンバーにする',
    makeOwner: 'オーナーにする…',
    removeFromCompany: '会社から削除',
    leaveCompany: '会社を退出',
    you: 'あなた',
    personalNotes: '自分用のメモ',
    removing: '削除中…',
    ownerLeaveHint: '退出する前に、ほかの人をオーナーにしてください。',
    roleChanged: (name, role) => `${name} さんは${role}になりました。`,
    transferTitle: name => `${name} さんをオーナーにしますか？`,
    transferBody: (name, company) => `${name} さんが ${company} のオーナーになり、あなたは管理者になります。`,
    transferConfirm: 'オーナーにする',
    transferDone: name => `${name} さんがオーナーになりました。`,
    pendingInvitations: '保留中の招待',
    invitationExpiresIn: days => `あと ${days} 日で期限切れ`,
    invitationExpiresToday: '今日期限切れ',
    invitationExpired: '期限切れ',
    invitedBy: name => `${name} さんが招待`,
    resendInvitation: '再送',
    cancelInvitation: '取り消す',
    declineInvitation: '辞退',
    invitationResent: '招待を再送しました',
    invitationCancelled: '招待を取り消しました',
    invitationDeclined: '招待を辞退しました',
    inviteRoleLabel: '役割',
    inviteRoleHint: '管理者はメンバーを招待・削除できます。',
    inviteLinkSection: 'またはリンクを共有',
    copyInviteLink: '招待リンクをコピー',
    inviteLinkCreating: 'リンクを作成しています…',
    inviteLinkCopied: 'リンクをコピーしました',
    inviteLinkAudience: 'このリンクを知っている人は、メンバーとして参加できます。',
    inviteLinkDuration: days => `${days} 日間使えます。`,
    inviteLinkCapacity: uses => `${uses} 人まで使えます。`,
    inviteLinkCopyFailed: '自動でコピーできませんでした。リンクを選択して手動でコピーしてください。',
    inviteLinkReplayed: 'このリンクは作成済みですが、表示できるのは一度だけです。無効にして新しく作成してください。',
    inviteLinksActive: '使用できるリンク',
    inviteLinkUsage: (used, max) => `${used}/${max} 回使用`,
    inviteLinkExpires: days => (days === 0 ? '今日期限切れ' : `あと ${days} 日で期限切れ`),
    inviteLinkRevoke: '無効にする',
    inviteLinkRevoked: 'リンクを無効にしました',
    inviteLinkInvalid: 'この招待リンクは無効です。会社の管理者に新しい招待を依頼してください。',
    policyTitle: 'チャンネルを作成できる人',
    policyEveryone: '全員',
    policyAdmins: 'オーナーと管理者',
    policyHint: '新しいチャンネルだけに適用されます。',
    favorites: 'お気に入り',
    sidebarSearch: company => `${company} を検索`,
    archivedSection: 'アーカイブ済み',
    addChannels: 'チャンネルを追加',
    createChannelItem: 'チャンネルを作成',
    browseChannelsItem: 'チャンネルを探す',
    privateChannel: 'プライベートチャンネル',
    publicChannel: '公開チャンネル',
    archivedTag: 'アーカイブ済み',
    channelInvitations: '招待',
    channelInvitationRow: name => `${name} に招待されています`,
    joinChannel: '参加',
    favoriteChannel: 'お気に入りに追加',
    unfavoriteChannel: 'お気に入りから外す',
    createChannelTitle: 'チャンネルを作成',
    createChannelBody: 'チャンネルは、一つの話題の会話をまとめておく場所です。',
    channelNameLabel: '名前',
    channelPurposeLabel: '説明',
    channelTopicLabel: 'トピック',
    channelVisibilityLabel: '公開範囲',
    visibilityPublic: '公開',
    visibilityPublicHint: '会社の全員が見つけて参加できます。',
    visibilityPrivate: 'プライベート',
    visibilityPrivateHint: '追加した人だけが見つけられます。',
    createChannelSubmit: 'チャンネルを作成',
    creatingChannel: '作成しています…',
    channelNamePlaceholder: '例：ローンチ計画',
    channelNameRequired: 'チャンネル名を入力してください。',
    channelNameTooLong: '80文字以内で入力してください。',
    channelPurposeOptional: '任意',
    channelPurposeTooLong: '500文字以内で入力してください。',
    channelPeopleSearch: '名前または @ユーザー名 で検索',
    removePerson: name => `${name}を外す`,
    addingPeople: '追加しています…',
    channelCreatedTitle: name => `#${name} を作成しました`,
    channelAddsFailed: '一部の人を追加できませんでした。',
    channelPersonAdded: '追加済み',
    channelPersonLeftCompany: 'すでに会社にいません。',
    channelInviteRetry: 'もう一度',
    channelInvitesDone: '完了',
    browseTitle: 'チャンネルを探す',
    browseSearchLabel: 'チャンネルを検索',
    browseFilterPublic: '公開',
    browseFilterArchived: 'アーカイブ済み',
    browseEmpty: '一致するチャンネルはありません。',
    browseNone: '公開チャンネルはまだありません。',
    channelMemberCount: count => `メンバー ${count} 人`,
    joinedBadge: '参加済み',
    openChannelAction: '表示',
    browseJoinUnavailable: 'ここからチャンネルに参加することはまだできません。',
    browseCreateRestricted: 'チャンネルを作成できるのはオーナーと管理者だけです。',
    browseRoomsNotReady: '現在は新しいチャンネルを作成できません。しばらくしてからお試しください。',
    browseLoadFailed: 'チャンネルを読み込めませんでした。接続を確認して再試行してください。',
    archivedBanner: 'アーカイブ済み：復元まで読み取り専用です。',
    channelStartTitle: channel => `#${channel} の最初です`,
    channelCreatedBy: (name, date) => `${name} が ${date} にこのチャンネルを作成しました。`,
    channelCreatedOn: date => `${date} に作成。`,
    addDescription: '説明を追加',
    channelPurposePlaceholder: '何のためのチャンネル？ 例：週の予定、リリース情報',
    defaultChannelPurpose: '会社の全員がいます。お知らせや、全員が知るべきことはここへ。',
    inviteTeammates: 'チームメイトを招待',
    askAssistant: 'Chief of Staff に聞く',
    welcomePrompt: assistant => `@${assistant} このチャンネル向けの短い歓迎メッセージを下書きして`,
    mentionPeople: 'メンバーをメンション',
    mentionCompanyAI: 'AI',
    mentionChannelHint: 'このチャンネルの全員に通知',
    mentionChannelConfirmTitle: count => `${count} 人に通知しますか？`,
    mentionChannelConfirmBody: 'このチャンネルの全員にメンション通知が届きます。',
    mentionChannelConfirm: 'チャンネルに通知',
    privateAttachments: 'プライベートチャンネルには、まだファイルを添付できません。',
    channelAttachments: 'このチャンネルではまだファイルを送れません。',
    membershipJoined: (name, you) =>
      you ? 'あなたがチャンネルに参加しました' : `${name} さんがチャンネルに参加しました`,
    membershipDeparted: (name, you) =>
      you
        ? 'あなたはこのチャンネルのメンバーではなくなりました'
        : `${name} さんはこのチャンネルのメンバーではなくなりました`,
    restoreChannel: 'チャンネルを復元',
    channelMembersMenu: 'メンバー',
    addPeople: 'メンバーを追加',
    leaveChannel: 'チャンネルを退出',
    archiveChannel: 'チャンネルをアーカイブ',
    editChannel: 'チャンネルを編集',
    leaveChannelTitle: name => `${name} を退出しますか？`,
    leaveChannelPublic: '退出後、「チャンネルを探す」から再参加できます。',
    leaveChannelPrivate: '退出後、戻るには新しい招待が必要です。',
    leaveChannelConfirm: 'チャンネルを退出',
    archiveChannelTitle: name => `${name} をアーカイブしますか？`,
    archiveChannelBody: 'アーカイブ後も読めますが、投稿はできません。',
    archiveChannelConfirm: 'アーカイブする',
    detailsPublicLine: '公開 · 会社の全員が見つけられます',
    detailsPrivateLine: 'プライベート · 追加された人だけが見つけられます',
    detailsVisibilityFixed: 'チャンネルの作成後に公開範囲は変更できません。',
    saveChanges: '変更を保存',
    savingChanges: '保存しています…',
    channelMembersTitle: 'チャンネルのメンバー',
    channelOwnerTag: 'チャンネルオーナー',
    memberPending: '招待中',
    removeFromChannel: '削除',
    cancelChannelInvite: '招待を取り消す',
    memberListHidden: 'オーナーと管理者だけがメンバーを見られます。',
    membersLoadFailed: 'メンバーを読み込めませんでした。もう一度お試しください。',
    addPeopleTitle: 'メンバーを追加',
    addPeopleSearch: 'メンバーを検索',
    addPeopleEmpty: '会社の全員がすでに参加しています。',
    addPersonAction: '追加',
    personInvited: name => `${name} さんを招待しました。`,
    personRemoved: name => `${name} さんを削除しました。`,
    working: '処理しています…',
    invitePeople: 'メンバーを招待',
    companySettings: '会社の設定',
    leaveCompanyTitle: company => `${company} を退出しますか？`,
    leaveCompanyBody: '退出後、戻るには新しい招待が必要です。',
    leaveCompanyLastMemberBody: '最後のメンバーが退出すると会社は閉鎖されます。戻るには新しい招待が必要です。',
    leaveCompanyWalletNotEmptyTooltip: '先に Protons を使用または移動するか、別のメンバーにオーナーとして残ってもらってください。',
    leaveCompanyConfirm: '退出',
    noLongerAllowed: '役割が変わったため、この操作はできなくなりました。',
    directMessages: 'ダイレクトメッセージ',
    newMessage: '新しいメッセージ',
    newMessageHint: '1人を選ぶか、グループを作ります。',
    newMessageNobody: '会社にほかのメンバーはまだいません。',
    peopleNoMatch: '一致する人がいません。',
    newMessageStart: '会話を始める',
    newMessageLimit: 'グループには自分以外に最大8人まで入れられます。',
    peopleSelected: count => `選択中: ${count}`,
    conversationGroup: count => `${count}人のグループ`,
    conversationReadOnlyBanner: '参加者が会社を離れたため読み取り専用です。',
    conversationReadOnlyTag: '読み取り専用',
    conversationSettingUp: '準備中…',
    conversationHide: '会話を非表示',
    hiddenConversations: '非表示',
    conversationAddConfirm: '新しい会話を始める',
    conversationsLoading: '会話を読み込んでいます…',
    conversationsFailed: '会話を読み込めませんでした。',
    conversationAttachments: 'ダイレクトメッセージには、まだファイルを添付できません。',
    conversationNotReady: 'この会話はまだ準備中です。',
    conversationOpenFailed: 'この会話はまだ開けません。',
    openConversation: name => `${name}との会話を開く`,
    conversationMenu: '会話のオプション',
    conversationNone: 'ダイレクトメッセージはまだありません。',
    conversationsDisabled: 'ダイレクトメッセージは現在利用できません。',
    inviteSheet: {
      title: company => `${company} にメンバーを追加`,
      search: '名前、@ユーザー名、またはメール',
      add: '追加',
      alreadyMember: 'メンバーです',
      alreadyInvited: '招待済み',
      invited: name => `${name} さんを招待しました。Atum に表示されます。`,
      emailRow: email => `${email} をメールで招待`,
      emailInvited: email => `${email} をメールで招待しました。`,
      emailNotSent: 'メールはまだ送信されません。招待リンクを送ってください。',
      emailOff: 'メール招待はまだ使えません。招待リンクを送ってください。',
      notAllowed: 'この会社では、オーナーと管理者だけが招待できます。',
      notFound: '一致する人がいません。メールアドレスで試してください。',
      cantInvite: '招待できません。すでに招待済みの可能性があります。',
      emailNotSentNoLink: 'メールはまだ送信されません。',
      byEmail: 'メール',
      railInvitations: '招待',
      invite: '招待',
      added: name => `${name} を追加しました。`,
      addedRow: '追加済み',
      alreadyMemberLine: name => `${name} はすでにメンバーです。`,
      cantAdd: 'この人を追加できません。',
      adminsOnly: 'ここで直接追加できるのはオーナーと管理者だけです。招待は送れます。',
      ownerOnlyRole: '管理者を追加できるのはオーナーだけです。',
      rosterFull: 'この会社は満員です（100人）。',
      roomFor: count => `あと${count}人追加できます。`,
      mailQueued: 'メール送信待ち',
      mailSent: 'メール送信済み',
      mailFailed: 'メールを送信できませんでした',
      mailCancelled: 'メールは取り消されました',
      emailFailedNote: '招待リンクを送ってください。',
      directAddTitle: '直接追加できる人',
      directAddMembers: 'メンバー',
      directAddAdmins: '管理者のみ',
      directAddHint: 'それ以外の人は招待を送ります。',
      ok: 'OK'
    },
    refusal: {
      invite_target_unavailable: 'このユーザー名のユーザーは見つかりませんでした。確認してもう一度お試しください。',
      invite_lookup_limited: '試行回数が多すぎます。数分後にもう一度お試しください。',
      company_creation_closed: '会社の作成はまだ利用できません。',
      last_admin: '会社には管理者が必要です。先にほかの人を管理者にしてください。',
      company_wallet_not_empty: '会社のウォレットにまだ Protons があるため、まだ会社を退出できません。',
      invite_link_unavailable: 'この招待リンクは無効です。会社の管理者に新しい招待を依頼してください。',
      invite_link_limit_reached: '有効なリンクが多すぎます。先にどれかを無効にしてください。',
      invite_link_rate_limited: 'リンクを作成しすぎです。数分後にもう一度お試しください。',
      owner_transfer_required: '退出する前に、ほかの人をオーナーにしてください。',
      owner_generation_conflict: '検討している間に会社の情報が変わりました。一覧を確認してもう一度お試しください。',
      role_change_forbidden: 'この人の役割は変更できません。',
      owner_target_unavailable: 'この人はもう有効なメンバーではありません。',
      invitation_unavailable: 'この招待はもう利用できません。',
      invitation_terminal: 'この招待はすでに終了しています。',
      invitation_expired: 'この招待は期限切れです。新しい招待を送ってください。',
      invitation_changed_input: 'この招待は別の内容ですでに使われています。もう一度お試しください。',
      channel_unavailable: 'このチャンネルはもう利用できません。',
      channel_invitation_unavailable: 'この招待はもう利用できません。',
      channel_not_admitted: 'あなたはこのチャンネルに参加していません。',
      channel_creation_restricted: 'この会社でチャンネルを作成できるのはオーナーと管理者だけです。',
      channel_visibility_immutable: 'チャンネルの公開範囲は変更できません。',
      default_channel_protected: '既定のチャンネルは退出もアーカイブもできません。',
      channel_archived: 'このチャンネルはアーカイブされています。',
      channel_name_conflict: '同じ名前の公開チャンネルがすでにあります。',
      admission_generation_conflict: '見ている間にチャンネルが変わりました。もう一度お試しください。',
      conversation_unavailable: 'この会話はもう利用できません。',
      participant_unavailable: '選んだ人のうち1人が利用できません。リストを確認してもう一度お試しください。',
      participant_limit: 'グループは自分を含めて最大9人までです。',
      participant_set_conflict: '選んでいる間にグループが変わりました。もう一度お試しください。',
      admission_epoch_conflict: '選んでいる間にメンバーの状態が変わりました。もう一度お試しください。',
      conversation_read_only: 'この会話は読み取り専用のため、人を追加できません。',
      email_invite_denied: 'この会社には招待できません。',
      email_invite_claim_required: 'この招待は特定のメールアドレス用です。そのアドレスでサインインして参加してください。',
      email_invite_capacity: 'この会社は現在これ以上招待できません。後でもう一度お試しください。',
      email_invite_limited: '招待が多すぎます。数分後にもう一度お試しください。',
      email_invite_identity_unavailable: 'このアドレスを確認できませんでした。もう一度お試しください。',
      email_invite_verification_unavailable: 'このアドレスを確認できませんでした。もう一度お試しください。',
      member_add_limited: '追加が多すぎます。しばらくしてからもう一度お試しください。'
    }
  },
  zh: {
    owner: '所有者',
    admin: '管理员',
    member: '成员',
    memberActions: name => `${name} 的操作`,
    makeAdmin: '设为管理员',
    makeMember: '设为成员',
    makeOwner: '转让所有权…',
    removeFromCompany: '从公司移除',
    leaveCompany: '离开公司',
    you: '你',
    personalNotes: '你的个人笔记',
    removing: '正在移除…',
    ownerLeaveHint: '离开前请先把所有权转让给其他人。',
    roleChanged: (name, role) => `${name} 现在是${role}。`,
    transferTitle: name => `把所有权转让给 ${name}？`,
    transferBody: (name, company) => `${name} 将拥有 ${company}；你成为管理员。`,
    transferConfirm: '转让所有权',
    transferDone: name => `${name} 现在是所有者。`,
    pendingInvitations: '待处理的邀请',
    invitationExpiresIn: days => `${days} 天后过期`,
    invitationExpiresToday: '今天过期',
    invitationExpired: '已过期',
    invitedBy: name => `由 ${name} 邀请`,
    resendInvitation: '重新发送',
    cancelInvitation: '取消',
    declineInvitation: '拒绝',
    invitationResent: '已重新发送邀请',
    invitationCancelled: '已取消邀请',
    invitationDeclined: '已拒绝邀请',
    inviteRoleLabel: '角色',
    inviteRoleHint: '管理员可以邀请和移除成员。',
    inviteLinkSection: '或分享链接',
    copyInviteLink: '复制邀请链接',
    inviteLinkCreating: '正在创建链接…',
    inviteLinkCopied: '链接已复制',
    inviteLinkAudience: '任何拿到此链接的人都能以成员身份加入。',
    inviteLinkDuration: days => `有效 ${days} 天。`,
    inviteLinkCapacity: uses => `最多 ${uses} 人使用。`,
    inviteLinkCopyFailed: '无法自动复制。请选中链接后手动复制。',
    inviteLinkReplayed: '此链接已创建，但只能显示一次。请撤销后重新创建。',
    inviteLinksActive: '仍可使用的链接',
    inviteLinkUsage: (used, max) => `已使用 ${used}/${max}`,
    inviteLinkExpires: days => (days === 0 ? '今天过期' : `${days} 天后过期`),
    inviteLinkRevoke: '撤销',
    inviteLinkRevoked: '链接已撤销',
    inviteLinkInvalid: '此邀请链接无效。请联系公司管理员获取新的邀请。',
    policyTitle: '谁可以创建频道',
    policyEveryone: '所有人',
    policyAdmins: '所有者和管理员',
    policyHint: '仅适用于新建频道。',
    favorites: '收藏',
    sidebarSearch: company => `搜索 ${company}`,
    archivedSection: '已归档',
    addChannels: '添加频道',
    createChannelItem: '创建频道',
    browseChannelsItem: '浏览频道',
    privateChannel: '私有频道',
    publicChannel: '公开频道',
    archivedTag: '已归档',
    channelInvitations: '邀请',
    channelInvitationRow: name => `受邀加入 ${name}`,
    joinChannel: '加入',
    favoriteChannel: '加入收藏',
    unfavoriteChannel: '取消收藏',
    createChannelTitle: '创建频道',
    createChannelBody: '频道把一个主题的对话集中在一处。',
    channelNameLabel: '名称',
    channelPurposeLabel: '描述',
    channelTopicLabel: '主题',
    channelVisibilityLabel: '可见性',
    visibilityPublic: '公开',
    visibilityPublicHint: '公司里的每个人都能找到并加入。',
    visibilityPrivate: '私有',
    visibilityPrivateHint: '只有你添加的人可以找到它。',
    createChannelSubmit: '创建频道',
    creatingChannel: '正在创建…',
    channelNamePlaceholder: '例如：发布计划',
    channelNameRequired: '请为频道命名。',
    channelNameTooLong: '请不超过 80 个字符。',
    channelPurposeOptional: '可选',
    channelPurposeTooLong: '请不超过 500 个字符。',
    channelPeopleSearch: '按姓名或 @用户名 搜索',
    removePerson: name => `移除 ${name}`,
    addingPeople: '正在添加…',
    channelCreatedTitle: name => `#${name} 已创建`,
    channelAddsFailed: '有些人未能添加。',
    channelPersonAdded: '已添加',
    channelPersonLeftCompany: '已不在公司。',
    channelInviteRetry: '重试',
    channelInvitesDone: '完成',
    browseTitle: '浏览频道',
    browseSearchLabel: '搜索频道',
    browseFilterPublic: '公开',
    browseFilterArchived: '已归档',
    browseEmpty: '没有符合搜索的频道。',
    browseNone: '还没有公开频道。',
    channelMemberCount: count => `${count} 名成员`,
    joinedBadge: '已加入',
    openChannelAction: '查看',
    browseJoinUnavailable: '暂时还不能从这里加入频道。',
    browseCreateRestricted: '只有所有者和管理员可以创建频道。',
    browseRoomsNotReady: '暂时无法创建新频道，请稍后再试。',
    browseLoadFailed: '无法加载频道。请检查连接后重试。',
    archivedBanner: '已归档：恢复前为只读。',
    channelStartTitle: channel => `这是 #${channel} 的开头`,
    channelCreatedBy: (name, date) => `${name} 于 ${date} 创建了此频道。`,
    channelCreatedOn: date => `创建于 ${date}。`,
    addDescription: '添加描述',
    channelPurposePlaceholder: '这个频道用来做什么？例如：每周计划、发布消息',
    defaultChannelPurpose: '公司所有人都在这里：公告和大家都该知道的事。',
    inviteTeammates: '邀请团队成员',
    askAssistant: '询问 Chief of Staff',
    welcomePrompt: assistant => `@${assistant} 帮我为这个频道起草一条简短的欢迎消息`,
    mentionPeople: '提及成员',
    mentionCompanyAI: 'AI',
    mentionChannelHint: '通知此频道中的所有人',
    mentionChannelConfirmTitle: count => `通知 ${count} 人？`,
    mentionChannelConfirmBody: '此频道中的所有人都会收到提及通知。',
    mentionChannelConfirm: '通知频道',
    privateAttachments: '私有频道暂时还不能附加文件。',
    channelAttachments: '此频道暂时不能发送文件。',
    membershipJoined: (name, you) => (you ? '你加入了频道' : `${name} 加入了频道`),
    membershipDeparted: (name, you) => (you ? '你已不在此频道中' : `${name} 已不在此频道中`),
    restoreChannel: '恢复频道',
    channelMembersMenu: '成员',
    addPeople: '添加成员',
    leaveChannel: '离开频道',
    archiveChannel: '归档频道',
    editChannel: '编辑频道',
    leaveChannelTitle: name => `离开 ${name}？`,
    leaveChannelPublic: '离开后可从“浏览频道”重新加入。',
    leaveChannelPrivate: '离开后需要新邀请才能回来。',
    leaveChannelConfirm: '离开频道',
    archiveChannelTitle: name => `归档 ${name}？`,
    archiveChannelBody: '归档后仍可阅读，但无法发言。',
    archiveChannelConfirm: '归档频道',
    detailsPublicLine: '公开 · 公司里的每个人都能找到',
    detailsPrivateLine: '私有 · 只有被添加的人才能找到',
    detailsVisibilityFixed: '频道创建后无法更改可见性。',
    saveChanges: '保存更改',
    savingChanges: '正在保存…',
    channelMembersTitle: '频道成员',
    channelOwnerTag: '频道所有者',
    memberPending: '已邀请',
    removeFromChannel: '移除',
    cancelChannelInvite: '取消邀请',
    memberListHidden: '只有所有者和管理员能查看成员。',
    membersLoadFailed: '无法加载成员，请重试。',
    addPeopleTitle: '添加成员',
    addPeopleSearch: '搜索成员',
    addPeopleEmpty: '公司里的每个人都已在这里。',
    addPersonAction: '添加',
    personInvited: name => `已邀请 ${name}。`,
    personRemoved: name => `已移除 ${name}。`,
    working: '正在处理…',
    invitePeople: '邀请成员',
    companySettings: '公司设置',
    leaveCompanyTitle: company => `离开 ${company}？`,
    leaveCompanyBody: '离开后需要新邀请才能回来。',
    leaveCompanyLastMemberBody: '最后一位成员离开时，公司将关闭。回来需要新的邀请。',
    leaveCompanyWalletNotEmptyTooltip: '请先使用或转出 Protons，或请其他成员留下来担任所有者。',
    leaveCompanyConfirm: '离开',
    noLongerAllowed: '你的角色已变更，无法再执行此操作。',
    directMessages: '私信',
    newMessage: '新消息',
    newMessageHint: '选择一个人，或创建群聊。',
    newMessageNobody: '公司里还没有其他成员。',
    peopleNoMatch: '没有匹配的人。',
    newMessageStart: '开始对话',
    newMessageLimit: '群聊最多可包含 8 位其他成员。',
    peopleSelected: count => `已选择：${count}`,
    conversationGroup: count => `${count} 人群聊`,
    conversationReadOnlyBanner: '有人离开公司，因此此对话只读。',
    conversationReadOnlyTag: '只读',
    conversationSettingUp: '正在设置…',
    conversationHide: '隐藏对话',
    hiddenConversations: '已隐藏',
    conversationAddConfirm: '开始新对话',
    conversationsLoading: '正在加载对话…',
    conversationsFailed: '无法加载对话。',
    conversationAttachments: '私信暂时还不能附加文件。',
    conversationNotReady: '对话正在设置，稍后即可打开。',
    conversationOpenFailed: '暂时无法打开此对话。',
    openConversation: name => `打开与 ${name} 的对话`,
    conversationMenu: '对话选项',
    conversationNone: '还没有私信。',
    conversationsDisabled: '私信目前不可用。',
    inviteSheet: {
      title: company => `添加成员到 ${company}`,
      search: '姓名、@用户名或邮箱',
      add: '添加',
      alreadyMember: '已是成员',
      alreadyInvited: '已邀请',
      invited: name => `已邀请 ${name}。对方会在 Atum 中看到邀请。`,
      emailRow: email => `通过邮件邀请 ${email}`,
      emailInvited: email => `已通过邮件邀请 ${email}。`,
      emailNotSent: '目前还不会发送邮件，请把邀请链接发给对方。',
      emailOff: '邮件邀请尚未开启。请改为发送邀请链接。',
      notAllowed: '在此公司中，只有拥有者和管理员可以邀请成员。',
      notFound: '没有匹配的人。试试对方的邮箱。',
      cantInvite: '无法邀请此人。对方可能已被邀请。',
      emailNotSentNoLink: '目前还不会发送邮件。',
      byEmail: '邮件',
      railInvitations: '邀请',
      invite: '邀请',
      added: name => `已添加 ${name}。`,
      addedRow: '已添加',
      alreadyMemberLine: name => `${name} 已是成员。`,
      cantAdd: '无法添加此人。',
      adminsOnly: '这里只有所有者和管理员可以直接添加成员。你可以发送邀请。',
      ownerOnlyRole: '只有所有者可以添加管理员。',
      rosterFull: '此公司已满（100 人）。',
      roomFor: count => `还可以添加 ${count} 人。`,
      mailQueued: '邮件等待发送',
      mailSent: '邮件已发送',
      mailFailed: '邮件未发送',
      mailCancelled: '邮件已取消',
      emailFailedNote: '请把邀请链接发给对方。',
      directAddTitle: '谁可以直接添加成员',
      directAddMembers: '成员',
      directAddAdmins: '仅管理员',
      directAddHint: '其他人会发送邀请。',
      ok: '好'
    },
    refusal: {
      invite_target_unavailable: '未找到该用户名的用户。请检查后重试。',
      invite_lookup_limited: '尝试次数过多。请稍后再试。',
      company_creation_closed: '暂未开放创建公司。',
      last_admin: '公司需要一名管理员。请先把另一位成员设为管理员。',
      company_wallet_not_empty: '公司钱包中仍有 Protons，因此暂时无法离开公司。',
      invite_link_unavailable: '此邀请链接无效。请联系公司管理员获取新的邀请。',
      invite_link_limit_reached: '公司有效链接过多。请先撤销一个。',
      invite_link_rate_limited: '创建的链接过多。请稍后再试。',
      owner_transfer_required: '离开前请先把所有权转让给其他人。',
      owner_generation_conflict: '你考虑期间公司发生了变化。请查看列表后重试。',
      role_change_forbidden: '你无法更改此人的角色。',
      owner_target_unavailable: '此人已不是活跃成员。',
      invitation_unavailable: '此邀请已不可用。',
      invitation_terminal: '此邀请已结束。',
      invitation_expired: '此邀请已过期。请发送新的邀请。',
      invitation_changed_input: '此邀请已用于其他内容。请重试。',
      channel_unavailable: '此频道已不可用。',
      channel_invitation_unavailable: '此邀请已不可用。',
      channel_not_admitted: '你不在此频道中。',
      channel_creation_restricted: '在此公司中，只有所有者和管理员可以创建频道。',
      channel_visibility_immutable: '频道的可见性无法更改。',
      default_channel_protected: '默认频道无法离开或归档。',
      channel_archived: '此频道已归档。',
      channel_name_conflict: '已存在同名的公开频道。',
      admission_generation_conflict: '你查看期间频道发生了变化。请重试。',
      conversation_unavailable: '此对话已不可用。',
      participant_unavailable: '你选择的其中一位成员目前不可用。请检查列表后重试。',
      participant_limit: '群聊最多 9 人（包括你）。',
      participant_set_conflict: '你选择期间群组发生了变化。请重试。',
      admission_epoch_conflict: '你选择期间有人的成员状态发生了变化。请重试。',
      conversation_read_only: '此对话为只读，无法添加成员。',
      email_invite_denied: '你无法邀请成员加入此公司。',
      email_invite_claim_required: '此邀请对应一个邮箱地址。请用该地址登录后加入。',
      email_invite_capacity: '此公司暂时无法接受更多邀请。请稍后再试。',
      email_invite_limited: '邀请次数过多。请稍后再试。',
      email_invite_identity_unavailable: '暂时无法核对该地址。请重试。',
      email_invite_verification_unavailable: '暂时无法核对该地址。请重试。',
      member_add_limited: '添加次数过多。请稍后再试。'
    }
  },
  'zh-hant': {
    owner: '擁有者',
    admin: '管理員',
    member: '成員',
    memberActions: name => `${name} 的操作`,
    makeAdmin: '設為管理員',
    makeMember: '設為成員',
    makeOwner: '轉讓擁有權…',
    removeFromCompany: '從公司移除',
    leaveCompany: '離開公司',
    you: '你',
    personalNotes: '你的個人筆記',
    removing: '正在移除…',
    ownerLeaveHint: '離開前請先把擁有權轉讓給其他人。',
    roleChanged: (name, role) => `${name} 現在是${role}。`,
    transferTitle: name => `把擁有權轉讓給 ${name}？`,
    transferBody: (name, company) => `${name} 將擁有 ${company}；你成為管理員。`,
    transferConfirm: '轉讓擁有權',
    transferDone: name => `${name} 現在是擁有者。`,
    pendingInvitations: '待處理的邀請',
    invitationExpiresIn: days => `${days} 天後到期`,
    invitationExpiresToday: '今天到期',
    invitationExpired: '已到期',
    invitedBy: name => `由 ${name} 邀請`,
    resendInvitation: '重新傳送',
    cancelInvitation: '取消',
    declineInvitation: '拒絕',
    invitationResent: '已重新傳送邀請',
    invitationCancelled: '已取消邀請',
    invitationDeclined: '已拒絕邀請',
    inviteRoleLabel: '角色',
    inviteRoleHint: '管理員可以邀請和移除成員。',
    inviteLinkSection: '或分享連結',
    copyInviteLink: '複製邀請連結',
    inviteLinkCreating: '正在建立連結…',
    inviteLinkCopied: '連結已複製',
    inviteLinkAudience: '任何拿到此連結的人都能以成員身分加入。',
    inviteLinkDuration: days => `有效 ${days} 天。`,
    inviteLinkCapacity: uses => `最多 ${uses} 人使用。`,
    inviteLinkCopyFailed: '無法自動複製。請選取連結後手動複製。',
    inviteLinkReplayed: '此連結已建立，但只能顯示一次。請撤銷後重新建立。',
    inviteLinksActive: '仍可使用的連結',
    inviteLinkUsage: (used, max) => `已使用 ${used}/${max}`,
    inviteLinkExpires: days => (days === 0 ? '今天到期' : `${days} 天後到期`),
    inviteLinkRevoke: '撤銷',
    inviteLinkRevoked: '連結已撤銷',
    inviteLinkInvalid: '此邀請連結無效。請聯絡公司管理員取得新的邀請。',
    policyTitle: '誰可以建立頻道',
    policyEveryone: '所有人',
    policyAdmins: '擁有者和管理員',
    policyHint: '僅適用於新建頻道。',
    favorites: '我的最愛',
    sidebarSearch: company => `搜尋 ${company}`,
    archivedSection: '已封存',
    addChannels: '新增頻道',
    createChannelItem: '建立頻道',
    browseChannelsItem: '瀏覽頻道',
    privateChannel: '私人頻道',
    publicChannel: '公開頻道',
    archivedTag: '已封存',
    channelInvitations: '邀請',
    channelInvitationRow: name => `受邀加入 ${name}`,
    joinChannel: '加入',
    favoriteChannel: '加入我的最愛',
    unfavoriteChannel: '移出我的最愛',
    createChannelTitle: '建立頻道',
    createChannelBody: '頻道把一個主題的對話集中在一處。',
    channelNameLabel: '名稱',
    channelPurposeLabel: '描述',
    channelTopicLabel: '主題',
    channelVisibilityLabel: '可見性',
    visibilityPublic: '公開',
    visibilityPublicHint: '公司裡的每個人都能找到並加入。',
    visibilityPrivate: '私人',
    visibilityPrivateHint: '只有你新增的人可以找到它。',
    createChannelSubmit: '建立頻道',
    creatingChannel: '正在建立…',
    channelNamePlaceholder: '例如：發布計畫',
    channelNameRequired: '請為頻道命名。',
    channelNameTooLong: '請不超過 80 個字元。',
    channelPurposeOptional: '選填',
    channelPurposeTooLong: '請不超過 500 個字元。',
    channelPeopleSearch: '依名稱或 @使用者名稱 搜尋',
    removePerson: name => `移除 ${name}`,
    addingPeople: '正在新增…',
    channelCreatedTitle: name => `#${name} 已建立`,
    channelAddsFailed: '有些人未能新增。',
    channelPersonAdded: '已新增',
    channelPersonLeftCompany: '已不在公司。',
    channelInviteRetry: '重試',
    channelInvitesDone: '完成',
    browseTitle: '瀏覽頻道',
    browseSearchLabel: '搜尋頻道',
    browseFilterPublic: '公開',
    browseFilterArchived: '已封存',
    browseEmpty: '沒有符合搜尋的頻道。',
    browseNone: '還沒有公開頻道。',
    channelMemberCount: count => `${count} 位成員`,
    joinedBadge: '已加入',
    openChannelAction: '檢視',
    browseJoinUnavailable: '暫時還不能從這裡加入頻道。',
    browseCreateRestricted: '只有擁有者和管理員可以建立頻道。',
    browseRoomsNotReady: '暫時無法建立新頻道，請稍後再試。',
    browseLoadFailed: '無法載入頻道。請檢查連線後再試。',
    archivedBanner: '已封存：還原前為唯讀。',
    channelStartTitle: channel => `這是 #${channel} 的開頭`,
    channelCreatedBy: (name, date) => `${name} 於 ${date} 建立了此頻道。`,
    channelCreatedOn: date => `建立於 ${date}。`,
    addDescription: '新增描述',
    channelPurposePlaceholder: '這個頻道用來做什麼？例如：每週計畫、發布消息',
    defaultChannelPurpose: '公司所有人都在這裡：公告和大家都該知道的事。',
    inviteTeammates: '邀請團隊成員',
    askAssistant: '詢問 Chief of Staff',
    welcomePrompt: assistant => `@${assistant} 幫我為這個頻道草擬一則簡短的歡迎訊息`,
    mentionPeople: '提及成員',
    mentionCompanyAI: 'AI',
    mentionChannelHint: '通知此頻道中的所有人',
    mentionChannelConfirmTitle: count => `通知 ${count} 人？`,
    mentionChannelConfirmBody: '此頻道中的所有人都會收到提及通知。',
    mentionChannelConfirm: '通知頻道',
    privateAttachments: '私人頻道暫時還不能附加檔案。',
    channelAttachments: '此頻道暫時不能傳送檔案。',
    membershipJoined: (name, you) => (you ? '你加入了頻道' : `${name} 加入了頻道`),
    membershipDeparted: (name, you) => (you ? '你已不在此頻道中' : `${name} 已不在此頻道中`),
    restoreChannel: '還原頻道',
    channelMembersMenu: '成員',
    addPeople: '新增成員',
    leaveChannel: '離開頻道',
    archiveChannel: '封存頻道',
    editChannel: '編輯頻道',
    leaveChannelTitle: name => `離開 ${name}？`,
    leaveChannelPublic: '離開後可從「瀏覽頻道」重新加入。',
    leaveChannelPrivate: '離開後需要新邀請才能回來。',
    leaveChannelConfirm: '離開頻道',
    archiveChannelTitle: name => `封存 ${name}？`,
    archiveChannelBody: '封存後仍可閱讀，但無法發言。',
    archiveChannelConfirm: '封存頻道',
    detailsPublicLine: '公開 · 公司裡的每個人都能找到',
    detailsPrivateLine: '私人 · 只有被新增的人才能找到',
    detailsVisibilityFixed: '頻道建立後無法變更可見性。',
    saveChanges: '儲存變更',
    savingChanges: '正在儲存…',
    channelMembersTitle: '頻道成員',
    channelOwnerTag: '頻道擁有者',
    memberPending: '已邀請',
    removeFromChannel: '移除',
    cancelChannelInvite: '取消邀請',
    memberListHidden: '只有擁有者和管理員能查看成員。',
    membersLoadFailed: '無法載入成員，請再試一次。',
    addPeopleTitle: '新增成員',
    addPeopleSearch: '搜尋成員',
    addPeopleEmpty: '公司裡的每個人都已在這裡。',
    addPersonAction: '新增',
    personInvited: name => `已邀請 ${name}。`,
    personRemoved: name => `已移除 ${name}。`,
    working: '正在處理…',
    invitePeople: '邀請成員',
    companySettings: '公司設定',
    leaveCompanyTitle: company => `離開 ${company}？`,
    leaveCompanyBody: '離開後需要新邀請才能回來。',
    leaveCompanyLastMemberBody: '最後一位成員離開時，公司將關閉。回來需要新的邀請。',
    leaveCompanyWalletNotEmptyTooltip: '請先使用或轉出 Protons，或請其他成員留下來擔任擁有者。',
    leaveCompanyConfirm: '離開',
    noLongerAllowed: '你的角色已變更，無法再執行此操作。',
    directMessages: '私訊',
    newMessage: '新訊息',
    newMessageHint: '選擇一個人，或建立群組。',
    newMessageNobody: '公司裡還沒有其他成員。',
    peopleNoMatch: '沒有相符的人。',
    newMessageStart: '開始對話',
    newMessageLimit: '群組最多可包含 8 位其他成員。',
    peopleSelected: count => `已選擇：${count}`,
    conversationGroup: count => `${count} 人群組`,
    conversationReadOnlyBanner: '有人離開公司，因此此對話唯讀。',
    conversationReadOnlyTag: '唯讀',
    conversationSettingUp: '正在設定…',
    conversationHide: '隱藏對話',
    hiddenConversations: '已隱藏',
    conversationAddConfirm: '開始新對話',
    conversationsLoading: '正在載入對話…',
    conversationsFailed: '無法載入對話。',
    conversationAttachments: '私訊暫時還不能附加檔案。',
    conversationNotReady: '對話正在設定，稍後即可開啟。',
    conversationOpenFailed: '暫時無法開啟此對話。',
    openConversation: name => `開啟與 ${name} 的對話`,
    conversationMenu: '對話選項',
    conversationNone: '還沒有私訊。',
    conversationsDisabled: '私訊目前無法使用。',
    inviteSheet: {
      title: company => `新增成員到 ${company}`,
      search: '姓名、@使用者名稱或電子郵件',
      add: '新增',
      alreadyMember: '已是成員',
      alreadyInvited: '已邀請',
      invited: name => `已邀請 ${name}。對方會在 Atum 中看到邀請。`,
      emailRow: email => `透過電子郵件邀請 ${email}`,
      emailInvited: email => `已透過電子郵件邀請 ${email}。`,
      emailNotSent: '目前還不會寄出電子郵件，請把邀請連結傳給對方。',
      emailOff: '電子郵件邀請尚未開啟。請改為傳送邀請連結。',
      notAllowed: '在此公司中，只有擁有者和管理員可以邀請成員。',
      notFound: '沒有相符的人。試試對方的電子郵件。',
      cantInvite: '無法邀請此人。對方可能已被邀請。',
      emailNotSentNoLink: '目前還不會寄出電子郵件。',
      byEmail: '電子郵件',
      railInvitations: '邀請',
      invite: '邀請',
      added: name => `已新增 ${name}。`,
      addedRow: '已新增',
      alreadyMemberLine: name => `${name} 已是成員。`,
      cantAdd: '無法新增此人。',
      adminsOnly: '這裡只有擁有者和管理員可以直接新增成員。你可以傳送邀請。',
      ownerOnlyRole: '只有擁有者可以新增管理員。',
      rosterFull: '此公司已滿（100 人）。',
      roomFor: count => `還可以新增 ${count} 人。`,
      mailQueued: '郵件等待傳送',
      mailSent: '郵件已傳送',
      mailFailed: '郵件未傳送',
      mailCancelled: '郵件已取消',
      emailFailedNote: '請把邀請連結傳給對方。',
      directAddTitle: '誰可以直接新增成員',
      directAddMembers: '成員',
      directAddAdmins: '僅管理員',
      directAddHint: '其他人會傳送邀請。',
      ok: '好'
    },
    refusal: {
      invite_target_unavailable: '找不到此使用者名稱的使用者。請檢查後再試。',
      invite_lookup_limited: '嘗試次數過多。請稍後再試。',
      company_creation_closed: '暫未開放建立公司。',
      last_admin: '公司需要一位管理員。請先把另一位成員設為管理員。',
      company_wallet_not_empty: '公司錢包中仍有 Protons，因此暫時無法離開公司。',
      invite_link_unavailable: '此邀請連結無效。請聯絡公司管理員取得新的邀請。',
      invite_link_limit_reached: '公司有效連結過多。請先撤銷一個。',
      invite_link_rate_limited: '建立的連結過多。請稍後再試。',
      owner_transfer_required: '離開前請先把擁有權轉讓給其他人。',
      owner_generation_conflict: '你考慮期間公司發生了變化。請查看清單後再試。',
      role_change_forbidden: '你無法變更此人的角色。',
      owner_target_unavailable: '此人已不是活躍成員。',
      invitation_unavailable: '此邀請已無法使用。',
      invitation_terminal: '此邀請已結束。',
      invitation_expired: '此邀請已到期。請傳送新的邀請。',
      invitation_changed_input: '此邀請已用於其他內容。請再試一次。',
      channel_unavailable: '此頻道已無法使用。',
      channel_invitation_unavailable: '此邀請已無法使用。',
      channel_not_admitted: '你不在此頻道中。',
      channel_creation_restricted: '在此公司中，只有擁有者和管理員可以建立頻道。',
      channel_visibility_immutable: '頻道的可見性無法變更。',
      default_channel_protected: '預設頻道無法離開或封存。',
      channel_archived: '此頻道已封存。',
      channel_name_conflict: '已存在同名的公開頻道。',
      admission_generation_conflict: '你檢視期間頻道發生了變化。請再試一次。',
      conversation_unavailable: '此對話已無法使用。',
      participant_unavailable: '你選擇的其中一位成員目前無法使用。請檢查清單後再試一次。',
      participant_limit: '群組最多 9 人（包括你）。',
      participant_set_conflict: '你選擇期間群組發生了變化。請再試一次。',
      admission_epoch_conflict: '你選擇期間有人的成員狀態發生了變化。請再試一次。',
      conversation_read_only: '此對話為唯讀，無法新增成員。',
      email_invite_denied: '你無法邀請成員加入此公司。',
      email_invite_claim_required: '此邀請對應一個電子郵件地址。請用該地址登入後加入。',
      email_invite_capacity: '此公司暫時無法接受更多邀請。請稍後再試。',
      email_invite_limited: '邀請次數過多。請稍後再試。',
      email_invite_identity_unavailable: '暫時無法核對該地址。請重試。',
      email_invite_verification_unavailable: '暫時無法核對該地址。請重試。',
      member_add_limited: '新增次數過多。請稍後再試。'
    }
  }
}

export function matrixTeamSpaceCopy(locale: string): MatrixTeamSpaceCopy {
  return Object.hasOwn(copy, locale) ? copy[locale]! : copy.en!
}
