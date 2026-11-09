import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AtumAccountClient } from '@/lib/atum-account-client'
import { parseAtumArtifactRefs } from '@/lib/atum-artifacts'
import { authFailureKind } from '@/lib/atum-auth'
import type { AtumMessagingClient, AtumMessagingMessage } from '@/lib/atum-messaging-client'

import {
  $atumDmArtifactByConversation,
  $atumDmPreviewByConversation,
  clearAtumDmWorkspace,
  presentAtumDmArtifactIntent,
  setAtumDmConversationPreviewTarget,
  setAtumDmForegroundConversation,
  setAtumDmWorkspaceAccount
} from './atum-dm-workspace'
import {
  $atumAccountScopeId,
  $atumAccountStatus,
  $atumActiveConversationId,
  $atumDrafts,
  $atumMessages,
  $atumOlderHistory,
  $atumRoster,
  $atumSocialRelationships,
  $atumStatus,
  atumPollDelay,
  cancelAtumSignIn,
  configureAtumMessagingComposition,
  ensureAtumSpecialistConversation,
  initializeAtumMessaging,
  loadAtumMessages,
  loadOlderAtumMessages,
  lookupAtumSocial,
  mutateAtumSocial,
  persistAtumDraft,
  pollAtumSync,
  refreshAtumAccountStatus,
  refreshAtumRoster,
  resetAtumMessagingState,
  retryAtumAccountRestore,
  retryAtumMessage,
  sendAtumMessage,
  setAtumActiveConversation,
  setAtumDraft,
  shouldPollAtumSync,
  signInToAtum,
  signInToAtumWithPassword,
  signOutOfAtum
} from './atum-messaging'
import { $workspaceOpen, setWorkspaceOpen } from './atum-shell'
import { $sessionPreviewRegistry, clearSessionPreviewRegistry } from './preview'
import { $dirtyPreviewUrls } from './preview-edit'
import { resetWorkbenchTabs } from './workbench-tabs'

const status = {
  accountId: 'account-a',
  connectivity: 'online' as const,
  synchronized: true,
  cursor: 'cursor',
  lastSuccessfulSyncAt: '2026-08-12T00:00:00.000Z',
  nextRetryAt: null,
  errorCode: null
}

it('saved-session retry applies restored account state without starting OAuth', async () => {
  const { account } = installClients()
  const restored = await account.status()
  vi.mocked(account.retryRestore).mockResolvedValue(restored)
  $atumAccountStatus.set({ ...restored, state: 'error', account: null, errorCode: 'hosted_session_unavailable' })
  await retryAtumAccountRestore()
  expect($atumAccountStatus.get().state).toBe('signed_in')
  expect(account.retryRestore).toHaveBeenCalledOnce()
  expect(account.signIn).not.toHaveBeenCalled()
})

it('a failed retry IPC preserves the connection notice and existing drafts', async () => {
  const { account } = installClients()
  const failed = { ...(await account.status()), state: 'error' as const, account: null, errorCode: 'hosted_session_unavailable' }
  $atumAccountStatus.set(failed)
  vi.mocked(account.retryRestore).mockRejectedValue(new Error('transport closed'))
  $atumDrafts.set({ 'conversation-a': 'keep this draft' })
  await retryAtumAccountRestore()
  expect($atumAccountStatus.get()).toEqual(failed)
  expect($atumDrafts.get()['conversation-a']).toBe('keep this draft')
})

function message(overrides: Partial<AtumMessagingMessage> = {}): AtumMessagingMessage {
  return {
    localId: 'local-1',
    id: 'server-1',
    clientMessageId: 'client-1',
    conversationId: 'conversation-1',
    sender: { type: 'account', id: 'account-a' },
    content: 'hello',
    kind: 'text',
    attachments: [],
    metadata: null,
    replyToMessageId: null,
    forwardedFrom: null,
    reactions: [],
    version: 1,
    createdAt: '2026-08-12T00:00:00.000Z',
    editedAt: null,
    recalledAt: null,
    delivery: 'sent',
    optimistic: false,
    ...overrides
  }
}

function installClients(
  overrides: Partial<AtumMessagingClient> = {},
  accountOverrides: Partial<AtumAccountClient> = {}
) {
  const messaging: AtumMessagingClient = {
    groupCapabilities: vi.fn().mockResolvedValue({ available: false, creationEnabled: false, humanMemberLimit: 32 }),
    groupDetail: vi.fn(),
    groupOperate: vi.fn(),
    groupOperations: vi.fn().mockResolvedValue([]),
    status: vi.fn().mockResolvedValue(status),
    roster: vi.fn().mockResolvedValue([]),
    messages: vi.fn().mockResolvedValue([]),
    loadOlderMessages: vi.fn().mockResolvedValue({ messages: [], nextCursor: null, hasMore: false }),
    transportStatus: vi.fn().mockResolvedValue({ accountId: 'account-a', healthy: false, state: 'degraded' }),
    artifact: vi.fn().mockResolvedValue({ state: 'missing', artifact: null }),
    ensureSpecialistConversation: vi.fn().mockResolvedValue({ conversationId: 'conversation-moon' }),
    ensureContactConversation: vi.fn().mockResolvedValue({ conversationId: 'conversation-contact' }),
    handleAvailability: vi.fn().mockResolvedValue({ available: true, reason: null, retryAfterSeconds: null }),
    renameHandle: vi.fn().mockResolvedValue({ id: 'account-a', displayName: 'A', handle: 'new-name' }),
    updateProfile: vi.fn().mockResolvedValue({ id: 'account-a', displayName: 'A', handle: 'new-name' }),
    createAvatarUpload: vi
      .fn()
      .mockResolvedValue({ uploadId: 'u', uploadUrl: 'https://x', uploadHeaders: {}, expiresAt: '' }),
    completeAvatarUpload: vi.fn().mockResolvedValue({ id: 'account-a', displayName: 'A', handle: 'new-name' }),
    clearAvatar: vi.fn().mockResolvedValue({ id: 'account-a', displayName: 'A', handle: 'new-name' }),
    registerAssistant: vi.fn(),
    retireAssistant: vi.fn(),
    listAssistants: vi.fn(),
    createAssistantAvatarUpload: vi
      .fn()
      .mockResolvedValue({ uploadId: 'u', uploadUrl: 'https://x', uploadHeaders: {}, expiresAt: '' }),
    completeAssistantAvatarUpload: vi.fn(),
    clearAssistantAvatar: vi.fn(),
    socialLookup: vi.fn().mockResolvedValue({
      availability: 'unavailable',
      profile: null,
      state: 'unavailable',
      version: 0,
      canMessage: false,
      directThreadId: null
    }),
    socialMutate: vi.fn().mockRejectedValue(new Error('not_configured')),
    socialRelationships: vi.fn().mockResolvedValue([]),
    socialSync: vi.fn().mockResolvedValue([]),
    linkedApps: vi.fn().mockResolvedValue([]),
    disconnectApp: vi.fn().mockResolvedValue(undefined),
    draft: vi.fn().mockResolvedValue(null),
    saveDraft: vi
      .fn()
      .mockResolvedValue({ text: '', replyToMessageId: null, attachmentIds: [], revision: 1, updatedAt: '' }),
    send: vi.fn().mockResolvedValue({}),
    retry: vi.fn().mockResolvedValue({}),
    markRead: vi.fn().mockResolvedValue(true),
    toggleReaction: vi.fn().mockResolvedValue(undefined),
    editMessage: vi.fn().mockResolvedValue(undefined),
    recallMessage: vi.fn().mockResolvedValue(undefined),
    searchMessages: vi.fn().mockResolvedValue([]),
    createMediaUpload: vi
      .fn()
      .mockResolvedValue({ attachmentId: 'attachment-a', uploadUrl: 'https://upload.test', headers: {} }),
    completeMediaUpload: vi.fn().mockResolvedValue(undefined),
    downloadMedia: vi.fn().mockResolvedValue({ url: 'https://media.test' }),
    sendTyping: vi.fn().mockResolvedValue(true),
    drainMentionJobs: vi.fn().mockResolvedValue({ claimed: 0, completed: 0 }),
    sync: vi.fn().mockResolvedValue(status),
    ...overrides
  }

  const account: AtumAccountClient = {
    status: vi.fn().mockResolvedValue({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-a' },
      errorCode: null,
      providers: { google: true, password: true }
    }),
    signIn: vi.fn(),
    signInWithPassword: vi.fn(),
    retryRestore: vi.fn(),
    cancel: vi.fn(),
    signOut: vi.fn().mockResolvedValue({
      state: 'signed_out',
      configured: true,
      account: null,
      errorCode: null,
      providers: { google: true, password: true }
    }),
    ...accountOverrides
  }

  Object.assign(window, { hermesDesktop: { messaging, account } })
  configureAtumMessagingComposition({
    account: () => account,
    clearDependentState: clearAtumDmWorkspace,
    clearPreviewState: clearSessionPreviewRegistry,
    ensureSpecialistConversation: specialist => messaging.ensureSpecialistConversation(specialist),
    presentArtifactIntents: (conversationId, resourceRefs) => {
      for (const ref of parseAtumArtifactRefs(resourceRefs)) {
        if (ref.presentation?.intent === 'open') {
          presentAtumDmArtifactIntent(conversationId, ref)
        }
      }
    },
    setDependentAccount: setAtumDmWorkspaceAccount
  })

  return { account, messaging }
}

beforeEach(() => {
  resetAtumMessagingState()
  vi.restoreAllMocks()
})

describe('Atum messaging renderer store', () => {
  it('uses one reactive account scope authority across auth and sync state', () => {
    expect($atumAccountScopeId.get()).toBeNull()

    $atumAccountStatus.set({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-from-auth' },
      errorCode: null,
      providers: { google: true, password: true }
    })
    expect($atumAccountScopeId.get()).toBe('account-from-auth')

    $atumStatus.set({ ...status, accountId: 'account-from-sync' })
    expect($atumAccountScopeId.get()).toBe('account-from-sync')
  })

  it('restores the 5s poll on socket loss and slows it while realtime is healthy', () => {
    expect(atumPollDelay({ accountId: 'account-a', healthy: true, state: 'healthy' }, false)).toBe(90_000)
    expect(atumPollDelay({ accountId: 'account-a', healthy: false, state: 'degraded' }, false)).toBe(5_000)
  })

  it('prepends older pages without duplicates and keeps chronological ordering stable', async () => {
    const latest = message({ localId: 'local-3', id: 'server-3', createdAt: '2026-08-12T03:00:00.000Z' })
    const middle = message({ localId: 'local-2', id: 'server-2', createdAt: '2026-08-12T02:00:00.000Z' })
    const oldest = message({ localId: 'local-1', id: 'server-1', createdAt: '2026-08-12T01:00:00.000Z' })
    installClients({
      loadOlderMessages: vi.fn().mockResolvedValue({
        messages: [middle, oldest, latest],
        nextCursor: null,
        hasMore: false
      })
    })
    $atumMessages.set({ 'conversation-1': [latest] })

    await loadOlderAtumMessages('conversation-1')

    expect($atumMessages.get()['conversation-1'].map(item => item.id)).toEqual(['server-1', 'server-2', 'server-3'])
    expect($atumOlderHistory.get()['conversation-1']).toBe('exhausted')
  })

  it('shows an optimistic send immediately and reconciles with canonical messages', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-11e594f48195')
    let resolveSend!: () => void

    const send = new Promise<void>(resolve => {
      resolveSend = resolve
    })

    const canonical = message({ clientMessageId: '00000000-0000-4000-8000-11e594f48195' })

    const { messaging } = installClients({
      send: vi.fn().mockReturnValue(send),
      messages: vi.fn().mockResolvedValue([canonical])
    })

    $atumAccountStatus.set({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-a' },
      errorCode: null,
      providers: { google: true, password: true }
    })

    const pending = sendAtumMessage('conversation-1', ' hello ', 'vi')
    expect($atumMessages.get()['conversation-1']).toMatchObject([
      { content: 'hello', delivery: 'sending', optimistic: true }
    ])
    expect($atumDrafts.get()['conversation-1']).toBe('')

    resolveSend()
    await pending
    expect(messaging.send).toHaveBeenCalledWith(expect.objectContaining({ content: 'hello', locale: 'vi' }))
    expect($atumMessages.get()['conversation-1']).toEqual([canonical])
  })

  it('opens the exact typed artifact returned by a new foreground specialist message', async () => {
    const conversationId = 'conversation-specialist'

    const baseline = message({
      conversationId,
      id: 'user-1',
      localId: 'user-1',
      sender: { type: 'account', id: 'account-a' }
    })

    const response = message({
      conversationId,
      id: 'specialist-1',
      localId: 'specialist-1',
      sender: { type: 'specialist', id: 'provider-a' },
      metadata: {
        resource_refs: [
          {
            kind: 'artifact',
            presentation: { intent: 'open' },
            resource_id: 'reading:exact-42',
            status: 'ready',
            title: 'Exact reading',
            type: 'reading'
          }
        ]
      }
    })

    const { messaging } = installClients({
      artifact: vi.fn().mockResolvedValue({
        state: 'ready',
        artifact: {
          artifactId: 'reading:exact-42',
          type: 'reading',
          title: 'Exact reading',
          status: 'ready',
          url: 'https://provider.test/readings/exact-42',
          embed: {
            url: 'https://provider.test/embed/signed-exact-42',
            kind: 'interactive_view',
            expiresAt: '2099-01-01T00:00:00.000Z'
          }
        }
      }),
      messages: vi.fn().mockResolvedValueOnce([baseline]).mockResolvedValueOnce([baseline, response])
    })

    resetWorkbenchTabs()
    setAtumDmWorkspaceAccount('account-a')
    setAtumDmForegroundConversation(conversationId)
    $atumActiveConversationId.set(conversationId)
    $atumRoster.set([
      {
        id: conversationId,
        title: 'Provider',
        kind: 'specialist',
        participantIds: ['provider-a'],
        updatedAt: baseline.createdAt,
        lastMessageAt: response.createdAt,
        unreadCount: 0,
        payload: { specialist: 'provider-a' }
      }
    ])
    setWorkspaceOpen(false)

    await loadAtumMessages(conversationId, { markRead: false })
    expect($workspaceOpen.get()).toBe(false)

    await loadAtumMessages(conversationId, { markRead: false })
    await vi.waitFor(() =>
      expect($atumDmArtifactByConversation.get()[conversationId]?.activeResourceId).toBe('reading:exact-42')
    )

    expect($workspaceOpen.get()).toBe(true)
    expect(messaging.artifact).toHaveBeenCalledWith(conversationId, 'reading:exact-42')
    expect($atumDmPreviewByConversation.get()[conversationId]?.url).toBe('https://provider.test/embed/signed-exact-42')
  })

  it('does not replay an already reconciled presentation intent', async () => {
    const conversationId = 'conversation-replay'
    const baseline = message({ conversationId, id: 'user-replay', localId: 'user-replay' })

    const response = message({
      conversationId,
      id: 'specialist-replay',
      localId: 'specialist-replay',
      sender: { type: 'specialist', id: 'provider-a' },
      metadata: {
        resource_refs: [
          {
            kind: 'artifact',
            presentation: { intent: 'open' },
            resource_id: 'report:singleton',
            status: 'ready',
            title: 'Singleton report',
            type: 'report'
          }
        ]
      }
    })

    const { messaging } = installClients({
      artifact: vi.fn().mockResolvedValue({ state: 'missing', artifact: null }),
      messages: vi
        .fn()
        .mockResolvedValueOnce([baseline])
        .mockResolvedValueOnce([baseline, response])
        .mockResolvedValueOnce([baseline, response])
    })

    resetWorkbenchTabs()
    setAtumDmWorkspaceAccount('account-a')
    setAtumDmForegroundConversation(conversationId)
    $atumActiveConversationId.set(conversationId)
    $atumRoster.set([
      {
        id: conversationId,
        title: 'Provider',
        kind: 'specialist',
        participantIds: ['provider-a'],
        updatedAt: baseline.createdAt,
        lastMessageAt: response.createdAt,
        unreadCount: 0,
        payload: {}
      }
    ])

    await loadAtumMessages(conversationId, { markRead: false })
    await loadAtumMessages(conversationId, { markRead: false })
    await vi.waitFor(() => expect(messaging.artifact).toHaveBeenCalledOnce())
    setWorkspaceOpen(false)

    await loadAtumMessages(conversationId, { markRead: false })

    expect($workspaceOpen.get()).toBe(false)
    expect(messaging.artifact).toHaveBeenCalledOnce()
    expect($atumDmArtifactByConversation.get()[conversationId]?.tabs).toHaveLength(1)
  })

  it('consumes a presentation intent once across concurrent message loads', async () => {
    const conversationId = 'conversation-concurrent'
    const baseline = message({ conversationId, id: 'user-concurrent', localId: 'user-concurrent' })

    const response = message({
      conversationId,
      id: 'specialist-concurrent',
      localId: 'specialist-concurrent',
      sender: { type: 'specialist', id: 'provider-a' },
      metadata: {
        resource_refs: [
          {
            kind: 'artifact',
            presentation: { intent: 'open' },
            resource_id: 'reading:concurrent',
            status: 'ready',
            title: 'Concurrent reading',
            type: 'reading'
          }
        ]
      }
    })

    let resolveFirst!: (messages: AtumMessagingMessage[]) => void
    let resolveSecond!: (messages: AtumMessagingMessage[]) => void

    const first = new Promise<AtumMessagingMessage[]>(resolve => {
      resolveFirst = resolve
    })

    const second = new Promise<AtumMessagingMessage[]>(resolve => {
      resolveSecond = resolve
    })

    const { messaging } = installClients({
      artifact: vi.fn().mockResolvedValue({ state: 'missing', artifact: null }),
      messages: vi.fn().mockResolvedValueOnce([baseline]).mockReturnValueOnce(first).mockReturnValueOnce(second)
    })

    resetWorkbenchTabs()
    setAtumDmWorkspaceAccount('account-a')
    setAtumDmForegroundConversation(conversationId)
    $atumActiveConversationId.set(conversationId)
    $atumRoster.set([
      {
        id: conversationId,
        title: 'Provider',
        kind: 'specialist',
        participantIds: ['provider-a'],
        updatedAt: baseline.createdAt,
        lastMessageAt: response.createdAt,
        unreadCount: 0,
        payload: {}
      }
    ])

    await loadAtumMessages(conversationId, { markRead: false })
    const firstLoad = loadAtumMessages(conversationId, { markRead: false })
    const secondLoad = loadAtumMessages(conversationId, { markRead: false })
    resolveFirst([baseline, response])
    resolveSecond([baseline, response])
    await Promise.all([firstLoad, secondLoad])

    await vi.waitFor(() => expect(messaging.artifact).toHaveBeenCalledOnce())
    expect($atumDmArtifactByConversation.get()[conversationId]?.tabs).toHaveLength(1)
  })

  it('records a newly loaded background specialist message without taking panel focus', async () => {
    const conversationId = 'conversation-background'
    const baseline = message({ conversationId, id: 'background-user', localId: 'background-user' })

    const response = message({
      conversationId,
      id: 'background-specialist',
      localId: 'background-specialist',
      sender: { type: 'specialist', id: 'provider-a' },
      metadata: {
        resource_refs: [
          {
            kind: 'artifact',
            presentation: { intent: 'open' },
            resource_id: 'box:background',
            status: 'ready',
            title: 'Background box',
            type: 'box'
          }
        ]
      }
    })

    const { messaging } = installClients({
      messages: vi.fn().mockResolvedValueOnce([baseline]).mockResolvedValueOnce([baseline, response])
    })

    resetWorkbenchTabs()
    setAtumDmWorkspaceAccount('account-a')
    setAtumDmForegroundConversation('conversation-foreground')
    $atumActiveConversationId.set('conversation-foreground')
    $atumRoster.set([
      {
        id: conversationId,
        title: 'Provider',
        kind: 'specialist',
        participantIds: ['provider-a'],
        updatedAt: baseline.createdAt,
        lastMessageAt: response.createdAt,
        unreadCount: 1,
        payload: {}
      }
    ])
    setWorkspaceOpen(false)

    await loadAtumMessages(conversationId, { markRead: false })
    await loadAtumMessages(conversationId, { markRead: false })

    expect($workspaceOpen.get()).toBe(false)
    expect(messaging.artifact).not.toHaveBeenCalled()
    expect($atumDmArtifactByConversation.get()[conversationId]).toBeUndefined()
  })

  it('converts the mention span to code points, which is how the hosted validator measures it', async () => {
    const { messaging } = installClients()
    $atumAccountStatus.set({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-a' },
      errorCode: null,
      providers: { google: true, password: true }
    })

    // '🙂 @Atum hi' — the emoji is two UTF-16 units but one code point, so the
    // composer's [3,8) is the server's [2,7).
    await sendAtumMessage('conversation-1', '🙂 @Atum hi', 'vi', [], {
      agent: 'binh-minh',
      revision: 0,
      startOffset: 3,
      endOffset: 8
    })

    expect(messaging.send).toHaveBeenCalledWith(
      expect.objectContaining({ mention: { agent: 'binh-minh', revision: 0, startOffset: 2, endOffset: 7 } })
    )
  })

  it('converts every addressed target span after an emoji before the durable send boundary', async () => {
    const { messaging } = installClients()
    $atumAccountStatus.set({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-a' },
      errorCode: null,
      providers: { google: true, password: true }
    })

    await sendAtumMessage('conversation-1', '🙂 @Mai và @Mai', 'vi', [], null, {
      contract: 'atum.addressed-mentions/1',
      targets: [
        {
          target: { type: 'assistant', id: '00000000-0000-4000-8000-bd7662a5eeb4' },
          revision: 1,
          startOffset: 3,
          endOffset: 7
        },
        {
          target: { type: 'assistant', id: '00000000-0000-4000-8000-b454f82c5857' },
          revision: 1,
          startOffset: 11,
          endOffset: 15
        }
      ]
    })

    expect(messaging.send).toHaveBeenCalledWith(
      expect.objectContaining({
        mentions: {
          contract: 'atum.addressed-mentions/1',
          targets: [
            expect.objectContaining({ startOffset: 2, endOffset: 6 }),
            expect.objectContaining({ startOffset: 10, endOffset: 14 })
          ]
        }
      })
    )
  })

  it('keeps addressed assistant targets out of group sends until the group-addressing contract exists', async () => {
    const { messaging } = installClients()
    $atumRoster.set([
      {
        id: 'group-1',
        title: 'Planning',
        kind: 'group',
        participantIds: ['account-a', 'account-b'],
        updatedAt: '2026-09-06T00:00:00.000Z',
        lastMessageAt: null,
        unreadCount: 0,
        payload: {},
        group: {
          conversationId: 'group-1',
          title: 'Planning',
          revision: 1,
          retiredAt: null,
          membershipEpoch: 1,
          members: [],
          updatedAt: '2026-09-06T00:00:00.000Z'
        }
      }
    ])

    await expect(
      sendAtumMessage('group-1', '@Mai', 'vi', [], null, {
        contract: 'atum.addressed-mentions/1',
        targets: [
          {
            target: { type: 'assistant', id: '00000000-0000-4000-8000-bd7662a5eeb4' },
            revision: 1,
            startOffset: 0,
            endOffset: 4
          }
        ]
      })
    ).rejects.toThrow('group_compose_denied')
    expect(messaging.send).not.toHaveBeenCalled()
  })

  it('allows a negotiated group address and forwards only the explicit quote reference', async () => {
    const { messaging } = installClients({
      groupCapabilities: vi.fn().mockResolvedValue({
        available: true,
        creationEnabled: false,
        humanMemberLimit: 32,
        addressing: { enabled: true, mentionCardinality: 8, quoteLimit: 4_000, specialistMemberLimit: 4 }
      })
    })

    $atumRoster.set([
      {
        id: 'group-1',
        title: 'Planning',
        kind: 'group',
        participantIds: ['account-a'],
        updatedAt: '2026-09-06T00:00:00.000Z',
        lastMessageAt: null,
        unreadCount: 0,
        payload: {},
        group: {
          conversationId: 'group-1',
          title: 'Planning',
          revision: 1,
          retiredAt: null,
          membershipEpoch: 1,
          members: [],
          updatedAt: '2026-09-06T00:00:00.000Z'
        }
      }
    ])

    await sendAtumMessage(
      'group-1',
      '@Moon help',
      'en',
      [],
      null,
      {
        contract: 'atum.addressed-mentions/1',
        targets: [{ target: { type: 'specialist', id: 'moon' }, revision: 1, startOffset: 0, endOffset: 5 }]
      },
      { messageId: '00000000-0000-4000-8000-fbfe405ca65f', sourceVersion: 1 }
    )

    expect(messaging.send).toHaveBeenCalledWith(
      expect.objectContaining({
        mentions: expect.objectContaining({
          targets: [expect.objectContaining({ target: { type: 'specialist', id: 'moon' } })]
        }),
        quotedMessage: { messageId: '00000000-0000-4000-8000-fbfe405ca65f', sourceVersion: 1 }
      })
    )
  })

  it('uses the shared-agent capability for shared-group agent mentions and quotes', async () => {
    const { messaging } = installClients({
      groupCapabilities: vi.fn().mockResolvedValue({
        available: true,
        creationEnabled: false,
        humanMemberLimit: 32,
        sharedAgents: { enabled: true, assistantMemberLimit: 4, ownAssistantOnly: true, assistantCatalog: [] }
      })
    })

    $atumRoster.set([
      {
        id: 'group-1',
        title: 'Shared planning',
        kind: 'group',
        participantIds: ['account-a', 'account-b'],
        updatedAt: '2026-09-06T00:00:00.000Z',
        lastMessageAt: null,
        unreadCount: 0,
        payload: {},
        group: {
          conversationId: 'group-1',
          title: 'Shared planning',
          revision: 1,
          retiredAt: null,
          membershipEpoch: 1,
          members: [],
          contextMode: 'shared_group',
          updatedAt: '2026-09-06T00:00:00.000Z'
        }
      }
    ])

    await sendAtumMessage(
      'group-1',
      '@Owner agent help',
      'en',
      [],
      null,
      {
        contract: 'atum.addressed-mentions/1',
        targets: [{ target: { type: 'assistant', id: 'owner-agent' }, revision: 1, startOffset: 0, endOffset: 12 }]
      },
      { messageId: '00000000-0000-4000-8000-fbfe405ca65f', sourceVersion: 1 }
    )

    expect(messaging.send).toHaveBeenCalledWith(
      expect.objectContaining({
        mentions: expect.objectContaining({
          targets: [expect.objectContaining({ target: { type: 'assistant', id: 'owner-agent' } })]
        }),
        quotedMessage: { messageId: '00000000-0000-4000-8000-fbfe405ca65f', sourceVersion: 1 }
      })
    )
  })

  it.each([true, false])('uses the private advisory gate for a targeted send (enabled=%s)', async enabled => {
    const { messaging } = installClients({
      groupCapabilities: vi.fn().mockResolvedValue({
        available: true,
        creationEnabled: false,
        humanMemberLimit: 32,
        addressing: { enabled: !enabled },
        advisory: { enabled }
      })
    })

    $atumRoster.set([
      {
        id: 'group-1',
        title: 'Advisory QA',
        kind: 'group',
        participantIds: ['account-a'],
        updatedAt: '2026-09-06T00:00:00.000Z',
        lastMessageAt: null,
        unreadCount: 0,
        payload: {},
        group: {
          conversationId: 'group-1',
          title: 'Advisory QA',
          revision: 1,
          retiredAt: null,
          membershipEpoch: 1,
          members: [],
          updatedAt: '2026-09-06T00:00:00.000Z',
          contextMode: 'private_advisory'
        }
      }
    ])

    const sent = sendAtumMessage('group-1', '@Moon help', 'en', [], null, {
      contract: 'atum.addressed-mentions/1',
      targets: [{ target: { type: 'specialist', id: 'moon' }, revision: 1, startOffset: 0, endOffset: 5 }]
    })

    if (enabled) {
      await sent
      expect(messaging.send).toHaveBeenCalledOnce()
    } else {
      await expect(sent).rejects.toThrow('group_compose_denied')
      expect(messaging.send).not.toHaveBeenCalled()
    }
  })

  it("runs this account's mention jobs right after sending a mention, and only then", async () => {
    const { messaging } = installClients()
    $atumAccountStatus.set({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-a' },
      errorCode: null,
      providers: { google: true, password: true }
    })

    await sendAtumMessage('conversation-1', 'hello', 'vi')
    expect(messaging.drainMentionJobs).not.toHaveBeenCalled()

    await sendAtumMessage('conversation-1', '@Atum hello', 'vi', [], {
      agent: 'binh-minh',
      revision: 0,
      startOffset: 0,
      endOffset: 5
    })
    expect(messaging.drainMentionJobs).toHaveBeenCalledOnce()
  })

  it('does not hold the sent message behind a long-running mention turn', async () => {
    let finishDrain!: (value: { claimed: number; completed: number }) => void

    const drain = new Promise<{ claimed: number; completed: number }>(resolve => {
      finishDrain = resolve
    })

    const { messaging } = installClients({
      drainMentionJobs: vi.fn().mockReturnValue(drain)
    })

    $atumAccountStatus.set({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-a' },
      errorCode: null,
      providers: { google: true, password: true }
    })

    await expect(
      sendAtumMessage('conversation-1', '@Atum hello', 'vi', [], {
        agent: 'binh-minh',
        revision: 0,
        startOffset: 0,
        endOffset: 5
      })
    ).resolves.toBeUndefined()

    expect(messaging.drainMentionJobs).toHaveBeenCalledOnce()
    finishDrain({ claimed: 1, completed: 1 })
  })

  it('keeps an accepted optimistic message when the immediate refresh fails', async () => {
    installClients({ messages: vi.fn().mockRejectedValue(new Error('refresh_unavailable')) })
    $atumAccountStatus.set({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-a' },
      errorCode: null,
      providers: { google: true, password: true }
    })

    await sendAtumMessage('conversation-1', 'hello', 'vi')

    expect($atumMessages.get()['conversation-1']).toEqual([
      expect.objectContaining({ content: 'hello', delivery: 'sent', optimistic: true })
    ])
  })

  it('reconciles the canonical echo by client id without duplicating the optimistic row', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-11e594f48195')
    installClients({
      messages: vi.fn().mockResolvedValue([
        message({
          id: 'server-accepted',
          localId: 'server-accepted',
          clientMessageId: '00000000-0000-4000-8000-11e594f48195',
          content: 'hello'
        })
      ])
    })
    $atumAccountStatus.set({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-a' },
      errorCode: null,
      providers: { google: true, password: true }
    })

    await sendAtumMessage('conversation-1', 'hello', 'vi')

    expect($atumMessages.get()['conversation-1']).toEqual([
      expect.objectContaining({ id: 'server-accepted', optimistic: false })
    ])
  })

  it('treats a failed mention drain as delivered, since the message itself was sent', async () => {
    const { messaging } = installClients({
      drainMentionJobs: vi.fn().mockRejectedValue(new Error('temporarily_unavailable'))
    })

    $atumAccountStatus.set({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-a' },
      errorCode: null,
      providers: { google: true, password: true }
    })

    await expect(
      sendAtumMessage('conversation-1', '@Atum hello', 'vi', [], {
        agent: 'binh-minh',
        revision: 0,
        startOffset: 0,
        endOffset: 5
      })
    ).resolves.toBeUndefined()
    expect(messaging.drainMentionJobs).toHaveBeenCalledOnce()
    expect(messaging.send).toHaveBeenCalledOnce()
  })

  it('marks a failed optimistic send retryable and retries the same client id', async () => {
    const { messaging } = installClients({ send: vi.fn().mockRejectedValue(new Error('offline')) })
    $atumAccountStatus.set({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-a' },
      errorCode: null,
      providers: { google: true, password: true }
    })

    await sendAtumMessage('conversation-1', 'hello', 'vi')
    const failed = $atumMessages.get()['conversation-1'][0]
    expect(failed.delivery).toBe('failed_retryable')

    await retryAtumMessage(failed.clientMessageId!)
    expect(messaging.retry).toHaveBeenCalledWith(failed.clientMessageId)
  })

  it('drops an in-flight prior-account roster and clears drafts/messages on sign out', async () => {
    let resolveRoster!: (value: never[]) => void

    const roster = new Promise<never[]>(resolve => {
      resolveRoster = resolve
    })

    installClients({ roster: vi.fn().mockReturnValue(roster) })
    $atumAccountStatus.set({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-a' },
      errorCode: null,
      providers: { google: true, password: true }
    })
    setAtumDraft('conversation-1', 'private A draft')
    setAtumDmConversationPreviewTarget('conversation-1', {
      kind: 'url',
      label: 'Account A artifact',
      source: 'https://files.atum.app/account-a',
      url: 'https://files.atum.app/account-a'
    })
    $atumMessages.set({ 'conversation-1': [message()] })

    const pending = refreshAtumRoster()
    await signOutOfAtum()
    resolveRoster([])
    await pending

    expect($atumRoster.get()).toEqual([])
    expect($atumMessages.get()).toEqual({})
    expect($atumDrafts.get()).toEqual({})
    expect($atumDmPreviewByConversation.get()).toEqual({})
    expect($atumAccountStatus.get().state).toBe('signed_out')
  })

  it('keeps the account and document authority while an editor has unacknowledged changes', async () => {
    const { account } = installClients()
    $dirtyPreviewUrls.set({ 'workspace-file:pending-document': true })

    try {
      await signOutOfAtum()
      expect(account.signOut).not.toHaveBeenCalled()
    } finally {
      $dirtyPreviewUrls.set({})
    }

    await signOutOfAtum()
    expect(account.signOut).toHaveBeenCalledOnce()
  })

  it('opens a specialist conversation without waiting for the roster to refresh', async () => {
    let settleRoster!: () => void

    const rosterGate = new Promise<void>(resolve => {
      settleRoster = resolve
    })

    const { messaging } = installClients({
      ensureSpecialistConversation: vi.fn().mockResolvedValue({ conversationId: 'conversation-moon' }),
      // The roster is a second round trip. Opening must not be held behind it.
      roster: vi.fn().mockImplementation(async () => {
        await rosterGate

        return []
      })
    })

    expect(await ensureAtumSpecialistConversation('moon')).toBe('conversation-moon')
    expect(messaging.ensureSpecialistConversation).toHaveBeenCalledWith('moon')
    settleRoster()
  })

  it('rejects an in-flight specialist ensure when the Atum account changes', async () => {
    let resolveEnsure!: (value: { conversationId: string }) => void

    const ensure = new Promise<{ conversationId: string }>(resolve => {
      resolveEnsure = resolve
    })

    const { messaging } = installClients(
      { ensureSpecialistConversation: vi.fn().mockReturnValue(ensure) },
      {
        status: vi.fn().mockResolvedValue({
          state: 'signed_in',
          configured: true,
          account: { id: 'account-b' },
          errorCode: null,
          providers: { google: true, password: true }
        })
      }
    )

    $atumAccountStatus.set({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-a' },
      errorCode: null,
      providers: { google: true, password: true }
    })

    const pending = ensureAtumSpecialistConversation('moon')
    await refreshAtumAccountStatus()
    resolveEnsure({ conversationId: 'account-a-moon' })

    await expect(pending).rejects.toThrow('atum_account_changed')
    expect(messaging.roster).not.toHaveBeenCalled()
    expect($atumAccountStatus.get().account?.id).toBe('account-b')
  })

  it('keeps a signed-in session when a status refresh throws', async () => {
    // A poll runs on a timer. Letting a dropped request set state:'error' gates
    // the whole shell behind the sign-in wall, so one bad minute of network
    // read as being logged out at random — with a red sign-in failure the user
    // never provoked.
    installClients({}, { status: vi.fn().mockRejectedValue(new Error('fetch failed')) })
    $atumAccountStatus.set({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-a' },
      errorCode: null,
      providers: { google: true, password: true }
    })

    const result = await refreshAtumAccountStatus()

    expect(result.state).toBe('signed_in')
    expect($atumAccountStatus.get().state).toBe('signed_in')
    expect($atumAccountStatus.get().errorCode).toBeNull()
  })

  it('reports an unreachable host as connectivity, not as a device fault', async () => {
    // Unclassifiable codes fall through to "restart Atum", which blames the
    // machine for an unreachable host.
    installClients({}, { status: vi.fn().mockRejectedValue(new Error('fetch failed')) })
    $atumAccountStatus.set({
      state: 'signed_out',
      configured: true,
      account: null,
      errorCode: null,
      providers: { google: true, password: true }
    })

    const result = await refreshAtumAccountStatus()

    expect(result.state).toBe('error')
    expect(authFailureKind(result.errorCode)).toBe('network')
  })

  it('clears account-scoped state when native status changes identity', async () => {
    installClients(
      {},
      {
        status: vi.fn().mockResolvedValue({
          state: 'signed_in',
          configured: true,
          account: { id: 'account-b' },
          errorCode: null,
          providers: { google: true, password: true }
        })
      }
    )
    $atumAccountStatus.set({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-a' },
      errorCode: null,
      providers: { google: true, password: true }
    })
    setAtumDraft('conversation-1', 'account A only')
    setAtumDmConversationPreviewTarget('conversation-1', {
      kind: 'url',
      label: 'Account A artifact',
      source: 'https://files.atum.app/account-a',
      url: 'https://files.atum.app/account-a'
    })
    // This is the old unscoped registry shape: a local main-owned token must
    // never survive into account B's workbench.
    $sessionPreviewRegistry.set({
      'assistant-session': [
        {
          autoOpen: true,
          createdAt: Date.now(),
          id: 'assistant-session:atum-file:account-a',
          normalized: {
            kind: 'file',
            label: 'account-a.pdf',
            previewKind: 'pdf',
            source: 'account-a.pdf',
            url: 'atum-file:account-a'
          },
          sessionId: 'assistant-session',
          source: 'file-browser',
          target: 'account-a.pdf'
        }
      ]
    })

    await refreshAtumAccountStatus()
    expect($atumAccountStatus.get().account?.id).toBe('account-b')
    expect($atumDrafts.get()).toEqual({})
    expect($atumDmPreviewByConversation.get()).toEqual({})
    expect($sessionPreviewRegistry.get()).toEqual({})
  })

  it('preserves the same account cache and drafts when native auth expires', async () => {
    installClients(
      {},
      {
        status: vi.fn().mockResolvedValue({
          state: 'expired',
          configured: true,
          account: { id: 'account-a' },
          errorCode: 'account_session_expired',
          providers: { google: true, password: true }
        })
      }
    )
    $atumAccountStatus.set({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-a' },
      errorCode: null,
      providers: { google: true, password: true }
    })
    $atumStatus.set(status)
    $atumRoster.set([
      {
        id: 'conversation-1',
        title: 'Moon',
        kind: 'direct',
        participantIds: ['moon'],
        updatedAt: '2026-08-12T00:00:00.000Z',
        lastMessageAt: null,
        unreadCount: 0,
        payload: {}
      }
    ])
    $atumMessages.set({ 'conversation-1': [message()] })
    setAtumDraft('conversation-1', 'same-account draft')

    await refreshAtumAccountStatus()

    expect($atumAccountStatus.get().state).toBe('expired')
    expect($atumRoster.get()).toHaveLength(1)
    expect($atumMessages.get()['conversation-1']).toHaveLength(1)
    expect($atumDrafts.get()['conversation-1']).toBe('same-account draft')
  })

  it('publishes password sign-in pending/error state without storing credentials', async () => {
    let rejectSignIn!: (error: Error) => void

    const signIn = new Promise<never>((_, reject) => {
      rejectSignIn = reject
    })

    const { account } = installClients({}, { signInWithPassword: vi.fn().mockReturnValue(signIn) })
    const credentials = { identifier: '@minh', password: 'one-shot-secret' }

    const pending = signInToAtumWithPassword(credentials)
    expect($atumAccountStatus.get().state).toBe('signing_in')
    expect(account.signInWithPassword).toHaveBeenCalledWith(credentials)
    expect(JSON.stringify([$atumAccountStatus.get(), $atumDrafts.get(), $atumMessages.get()])).not.toContain(
      credentials.password
    )

    rejectSignIn(new Error('invalid_credentials'))
    await pending
    expect($atumAccountStatus.get()).toMatchObject({ state: 'error', errorCode: 'invalid_credentials' })
  })

  it('keeps prior valid cache and drafts after a failed reauthentication', async () => {
    installClients({}, { signInWithPassword: vi.fn().mockRejectedValue(new Error('invalid_credentials')) })
    $atumAccountStatus.set({
      state: 'expired',
      configured: true,
      account: { id: 'account-a' },
      errorCode: 'account_session_expired',
      providers: { google: true, password: true }
    })
    $atumStatus.set(status)
    $atumMessages.set({ 'conversation-1': [message()] })
    setAtumDraft('conversation-1', 'do not erase me')

    await signInToAtumWithPassword({ identifier: '@minh', password: 'one-shot-secret' })

    expect($atumAccountStatus.get()).toMatchObject({
      state: 'error',
      account: { id: 'account-a' },
      errorCode: 'invalid_credentials'
    })
    expect($atumMessages.get()['conversation-1']).toHaveLength(1)
    expect($atumDrafts.get()['conversation-1']).toBe('do not erase me')
  })

  it('keeps prior valid cache when an in-flight account switch is cancelled', async () => {
    installClients(
      {},
      {
        cancel: vi.fn().mockResolvedValue({
          state: 'signed_out',
          configured: true,
          account: null,
          errorCode: null,
          providers: { google: true, password: true }
        })
      }
    )
    $atumAccountStatus.set({
      state: 'signing_in',
      configured: true,
      account: { id: 'account-a' },
      errorCode: null,
      providers: { google: true, password: true }
    })
    $atumStatus.set(status)
    $atumMessages.set({ 'conversation-1': [message()] })
    setAtumDraft('conversation-1', 'preserved through cancel')

    await cancelAtumSignIn()

    expect($atumAccountStatus.get().state).toBe('signed_out')
    expect($atumMessages.get()['conversation-1']).toHaveLength(1)
    expect($atumDrafts.get()['conversation-1']).toBe('preserved through cancel')
  })

  it('recovers from a rejected Google IPC call instead of remaining stuck pending', async () => {
    installClients({}, { signIn: vi.fn().mockRejectedValue(new Error('provider_not_configured')) })

    await signInToAtum()

    expect($atumAccountStatus.get()).toMatchObject({ state: 'error', errorCode: 'provider_not_configured' })
  })

  it.each(['zh', 'zh-hant', 'ja'] as const)('projects %s sends to the hosted en locale contract', async locale => {
    const { messaging } = installClients({ messages: vi.fn().mockResolvedValue([]) })
    $atumAccountStatus.set({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-a' },
      errorCode: null,
      providers: { google: true, password: true }
    })
    $atumStatus.set(status)

    await sendAtumMessage('conversation-1', `hello from ${locale}`, locale)

    expect(messaging.send).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en' }))
  })

  it('retains a local draft and reports persistence failure without rejecting', async () => {
    installClients({ saveDraft: vi.fn().mockRejectedValue(new Error('disk_unavailable')) })
    $atumStatus.set(status)
    setAtumDraft('conversation-1', 'offline draft')

    await expect(persistAtumDraft('conversation-1')).resolves.toBe(false)
    expect($atumDrafts.get()['conversation-1']).toBe('offline draft')
    expect($atumStatus.get()).toMatchObject({ connectivity: 'error', errorCode: 'disk_unavailable' })
  })

  it('keeps an in-progress draft when an active conversation refresh returns an older persisted draft', async () => {
    const { messaging } = installClients({
      draft: vi.fn().mockResolvedValue({
        text: 'older persisted draft',
        replyToMessageId: null,
        attachmentIds: [],
        revision: 3,
        updatedAt: '2026-09-06T12:00:00.000Z'
      }),
      messages: vi.fn().mockResolvedValue([message()])
    })

    $atumStatus.set(status)
    setAtumDraft('conversation-1', 'still typing the current prompt')

    await loadAtumMessages('conversation-1', { markRead: false })

    expect(messaging.draft).toHaveBeenCalledWith('conversation-1')
    expect($atumDrafts.get()['conversation-1']).toBe('still typing the current prompt')
  })

  it('accepts a refreshed persisted draft after the local draft has been saved', async () => {
    const { messaging } = installClients({
      draft: vi.fn().mockResolvedValue({ text: 'newer persisted draft' }),
      saveDraft: vi.fn().mockResolvedValue(undefined),
      messages: vi.fn().mockResolvedValue([message()])
    })

    $atumStatus.set(status)
    setAtumDraft('conversation-1', 'local draft')
    await expect(persistAtumDraft('conversation-1')).resolves.toBe(true)
    expect(messaging.saveDraft).toHaveBeenCalledWith('conversation-1', { text: 'local draft' })

    await loadAtumMessages('conversation-1', { markRead: false })

    expect($atumDrafts.get()['conversation-1']).toBe('newer persisted draft')
  })

  it('keeps loaded messages when mark-read persistence fails', async () => {
    installClients({
      messages: vi.fn().mockResolvedValue([message()]),
      markRead: vi.fn().mockRejectedValue(new Error('offline'))
    })
    $atumStatus.set(status)

    await expect(loadAtumMessages('conversation-1')).resolves.toEqual([message()])
    expect($atumMessages.get()['conversation-1']).toHaveLength(1)
    expect($atumStatus.get()).toMatchObject({ connectivity: 'error', errorCode: 'offline' })
  })

  it('marks the newest canonical message from the newest-first projection', async () => {
    const newest = message({ id: 'server-3', createdAt: '2026-08-12T00:03:00.000Z' })
    const oldest = message({ id: 'server-1', createdAt: '2026-08-12T00:01:00.000Z' })
    const { messaging } = installClients({ messages: vi.fn().mockResolvedValue([newest, oldest]) })

    await loadAtumMessages('conversation-1')

    expect(messaging.markRead).toHaveBeenCalledWith('conversation-1', 'server-3')
  })

  it('opens a conversation, clears it, and republishes the corrected roster', async () => {
    const { messaging } = installClients({ messages: vi.fn().mockResolvedValue([message()]) })

    setAtumActiveConversation('conversation-1')
    await vi.waitFor(() => expect(messaging.markRead).toHaveBeenCalled())

    expect(messaging.roster).toHaveBeenCalled()
  })

  it('refreshes and clears the active conversation when focus returns', async () => {
    const { messaging } = installClients({ messages: vi.fn().mockResolvedValue([message()]) })
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
    await initializeAtumMessaging()
    setAtumActiveConversation('conversation-1')
    await vi.waitFor(() => expect(messaging.markRead).toHaveBeenCalled())
    vi.mocked(messaging.markRead).mockClear()

    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(messaging.markRead).toHaveBeenCalledWith('conversation-1', 'server-1'))
  })

  it('marks a newly arrived message read while its active window is focused', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const conversation = {
      id: 'conversation-1',
      title: 'Andy',
      kind: 'direct',
      participantIds: ['andy'],
      updatedAt: '2026-08-12T00:01:00.000Z',
      lastMessageAt: '2026-08-12T00:01:00.000Z',
      unreadCount: 1,
      payload: {}
    }

    const { messaging } = installClients({
      roster: vi.fn().mockResolvedValue([conversation]),
      messages: vi.fn().mockResolvedValue([message({ id: 'server-new' })])
    })

    $atumStatus.set(status)
    $atumAccountStatus.set({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-a' },
      errorCode: null,
      providers: { google: true, password: true }
    })
    $atumActiveConversationId.set('conversation-1')

    await pollAtumSync()

    expect(messaging.markRead).toHaveBeenCalledWith('conversation-1', 'server-new')
  })

  it('retries startup mention recovery after a transient drain failure', async () => {
    const drainMentionJobs = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporarily_unavailable'))
      .mockResolvedValue({ claimed: 1, completed: 1 })

    installClients({ drainMentionJobs })

    await pollAtumSync()
    await pollAtumSync()
    await pollAtumSync()

    // The first failure must not consume the once-per-start recovery gate; the
    // successful second attempt does, so the third poll does not spend again.
    expect(drainMentionJobs).toHaveBeenCalledTimes(2)
  })

  it.each([
    { active: 'conversation-1', focused: true, expected: 0 },
    { active: 'another-conversation', focused: true, expected: 1 },
    { active: 'conversation-1', focused: false, expected: 1 }
  ])(
    'notifies for hosted arrivals according to active/focus state: $active/$focused',
    async ({ active, focused, expected }) => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false })
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused })
      const notify = vi.fn().mockResolvedValue(true)
      const conversationId = `conversation-${active}-${focused}`

      const conversation = {
        id: conversationId,
        title: 'Andy',
        kind: 'direct',
        participantIds: ['andy'],
        updatedAt: '2026-08-12T00:01:00.000Z',
        lastMessageAt: '2026-08-12T00:01:00.000Z',
        unreadCount: 1,
        payload: {}
      }

      installClients({
        roster: vi.fn().mockResolvedValue([conversation]),
        messages: vi
          .fn()
          .mockResolvedValue([
            message({ conversationId, id: `server-${active}-${focused}`, sender: { type: 'account', id: 'andy' } })
          ])
      })
      Object.assign(window.hermesDesktop!, { notify })
      $atumStatus.set(status)
      $atumAccountStatus.set({
        state: 'signed_in',
        configured: true,
        account: { id: 'account-a' },
        errorCode: null,
        providers: { google: true, password: true }
      })
      $atumActiveConversationId.set(active === 'conversation-1' ? conversationId : active)

      await pollAtumSync()

      expect(notify).toHaveBeenCalledTimes(expected)
    }
  )

  it('does not mark read after the account epoch changes during message loading', async () => {
    let resolveMessages!: (messages: AtumMessagingMessage[]) => void

    const pendingMessages = new Promise<AtumMessagingMessage[]>(resolve => {
      resolveMessages = resolve
    })

    const { messaging } = installClients({ messages: vi.fn().mockReturnValue(pendingMessages) })

    const pending = loadAtumMessages('conversation-1')
    await signOutOfAtum()
    resolveMessages([message()])
    await pending

    expect(messaging.markRead).not.toHaveBeenCalled()
  })

  it('does not publish a stale social lookup after an account boundary change', async () => {
    let resolveLookup!: (value: Awaited<ReturnType<AtumMessagingClient['socialLookup']>>) => void

    const lookup = new Promise<Awaited<ReturnType<AtumMessagingClient['socialLookup']>>>(resolve => {
      resolveLookup = resolve
    })

    installClients({ socialLookup: vi.fn().mockReturnValue(lookup) })
    const pending = lookupAtumSocial('social-bob')
    await signOutOfAtum()
    resolveLookup({
      availability: 'available',
      profile: { profileId: 'profile-b', displayName: 'Bob', handle: 'social-bob', verified: false, avatar: null },
      state: 'none',
      version: 0,
      canMessage: false,
      directThreadId: null
    })
    expect(await pending).toBeNull()
    expect($atumSocialRelationships.get()).toEqual([])
  })

  it('publishes acknowledged block before resolving and cancels draft and optimistic send', async () => {
    const threadId = 'thread-direct'

    const blocked = {
      availability: 'available' as const,
      profile: { profileId: 'profile-b', displayName: 'Bob', handle: 'social-bob', verified: false, avatar: null },
      state: 'blocked_by_me' as const,
      version: 3,
      canMessage: false,
      directThreadId: threadId
    }

    installClients({ socialMutate: vi.fn().mockResolvedValue(blocked) })
    $atumDrafts.set({ [threadId]: 'draft' })
    $atumMessages.set({ [threadId]: [message({ conversationId: threadId, optimistic: true, id: null })] })
    await mutateAtumSocial('block', 'profile-b')
    expect($atumDrafts.get()[threadId]).toBe('')
    expect($atumMessages.get()[threadId]).toEqual([])
    expect($atumSocialRelationships.get()).toEqual([blocked])
    await expect(sendAtumMessage(threadId, 'denied', 'en')).rejects.toThrow('direct_compose_denied')
  })

  it('refreshes native auth during polling and surfaces expiry without erasing cache or syncing', async () => {
    const { messaging, account } = installClients(
      {},
      {
        status: vi.fn().mockResolvedValue({
          state: 'expired',
          configured: true,
          account: { id: 'account-a' },
          errorCode: 'account_session_expired',
          providers: { google: true, password: true }
        })
      }
    )

    $atumAccountStatus.set({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-a' },
      errorCode: null,
      providers: { google: true, password: true }
    })
    $atumStatus.set(status)
    $atumMessages.set({ 'conversation-1': [message()] })

    await pollAtumSync()

    expect(account.status).toHaveBeenCalledOnce()
    expect(messaging.sync).not.toHaveBeenCalled()
    expect($atumAccountStatus.get().state).toBe('expired')
    expect($atumStatus.get()?.connectivity).toBe('auth_expired')
    expect($atumMessages.get()['conversation-1']).toHaveLength(1)
  })

  it('does not hot-loop terminal poison or retry before nextRetryAt', async () => {
    const terminal = { ...status, connectivity: 'error' as const, nextRetryAt: null, errorCode: 'invalid_response' }
    const future = { ...status, connectivity: 'offline_cached' as const, nextRetryAt: '2026-08-12T00:01:00.000Z' }
    const { messaging } = installClients({ status: vi.fn().mockResolvedValue(terminal) })
    $atumAccountStatus.set({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-a' },
      errorCode: null,
      providers: { google: true, password: true }
    })

    await pollAtumSync()
    expect(messaging.sync).not.toHaveBeenCalled()
    expect(shouldPollAtumSync(terminal, Date.parse('2026-08-12T00:00:00.000Z'))).toBe(false)
    expect(shouldPollAtumSync(future, Date.parse('2026-08-12T00:00:00.000Z'))).toBe(false)
    expect(shouldPollAtumSync({ ...future, nextRetryAt: 'not-a-date' }, Date.now())).toBe(false)
  })
})
