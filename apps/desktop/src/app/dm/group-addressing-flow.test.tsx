import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import type {
  AtumMentionTargetsResponse,
  AtumMessagingClient,
  AtumMessagingMessage
} from '@/lib/atum-messaging-client'
import { $atumGroupQuote } from '@/store/atum-group-quote'
import {
  $atumAccountStatus,
  $atumMessages,
  $atumRemovedGroups,
  $atumRoster,
  $atumStatus,
  configureAtumMessagingComposition,
  resetAtumMessagingState
} from '@/store/atum-messaging'

import { $groupCapabilities } from './group-state'

import { AtumDmView } from './index'

const ROOM_ID = 'room-1'

const room = (membershipEpoch = 1, revision = membershipEpoch) => ({
  conversationId: ROOM_ID,
  title: 'Planning',
  revision,
  retiredAt: null,
  membershipEpoch,
  members: [
    { userId: 'account-a', displayName: 'Minh', handle: 'minh', role: 'owner' as const, membershipEpoch },
    { userId: 'lan', displayName: 'Lan', handle: 'lan', role: 'member' as const, membershipEpoch }
  ],
  specialists: [
    {
      specialist: 'moon',
      displayName: 'Moon',
      avatar: '☾',
      membershipEpoch,
      availability: 'available' as const
    }
  ],
  updatedAt: '2026-09-06T00:00:00.000Z'
})

const conversation = (membershipEpoch = 1, revision = membershipEpoch) => ({
  id: ROOM_ID,
  title: 'Planning',
  kind: 'group',
  participantIds: ['account-a', 'lan'],
  updatedAt: '2026-09-06T00:00:00.000Z',
  lastMessageAt: null,
  unreadCount: 0,
  payload: {},
  group: room(membershipEpoch, revision)
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void

  const promise = new Promise<T>(nextResolve => {
    resolve = nextResolve
  })

  return { promise, resolve }
}

function message(overrides: Partial<AtumMessagingMessage>): AtumMessagingMessage {
  return {
    attachments: [],
    clientMessageId: null,
    content: '',
    conversationId: ROOM_ID,
    createdAt: '2026-09-06T00:00:00.000Z',
    delivery: 'sent',
    editedAt: null,
    forwardedFrom: null,
    id: 'message',
    kind: 'text',
    localId: 'local-message',
    metadata: null,
    optimistic: false,
    reactions: [],
    recalledAt: null,
    replyToMessageId: null,
    sender: { type: 'user', id: 'lan' },
    version: 1,
    ...overrides
  }
}

const capabilities = {
  available: true,
  creationEnabled: true,
  humanMemberLimit: 32,
  addressing: {
    enabled: true,
    mentionCardinality: 8,
    quoteLimit: 4000,
    specialistMemberLimit: 4,
    specialistCatalog: [{ specialist: 'moon', displayName: 'Moon', avatar: '☾', roomSupported: true }]
  }
}

function renderRoom(): void {
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MemoryRouter initialEntries={[`/dm/${ROOM_ID}`]}>
        <Routes>
          <Route element={<AtumDmView />} path="/dm/:conversationId" />
        </Routes>
      </MemoryRouter>
    </I18nProvider>
  )
}

describe('group addressing composition', () => {
  const send = vi.fn().mockResolvedValue({})

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    resetAtumMessagingState()
    $atumGroupQuote.set(null)
    $atumRoster.set([conversation()])
    $atumMessages.set({
      [ROOM_ID]: [
        message({
          id: 'specialist-message',
          localId: 'local-specialist',
          content: 'The moon is bright.',
          createdAt: '2026-09-06T00:00:00.000Z',
          sender: { type: 'specialist', id: 'moon' },
          version: 2
        }),
        message({
          id: 'quote-source',
          localId: 'local-quote-source',
          content: 'Share this deliberately.',
          createdAt: '2026-09-06T00:01:00.000Z',
          version: 3
        })
      ]
    })
    $atumAccountStatus.set({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-a', displayName: 'Minh', handle: 'minh' },
      errorCode: null,
      providers: { google: false, password: true }
    })
    $atumStatus.set({
      accountId: 'account-a',
      connectivity: 'online',
      synchronized: true,
      cursor: null,
      lastSuccessfulSyncAt: null,
      nextRetryAt: null,
      errorCode: null
    })
    $groupCapabilities.set(capabilities)
    send.mockClear()

    configureAtumMessagingComposition({
      account: () => ({
        status: vi.fn().mockResolvedValue($atumAccountStatus.get()),
        signIn: vi.fn(),
        signInWithPassword: vi.fn(),
        retryRestore: vi.fn(),
        cancel: vi.fn(),
        signOut: vi.fn()
      }),
      clearDependentState: vi.fn(),
      clearPreviewState: vi.fn(),
      ensureSpecialistConversation: vi.fn(),
      presentArtifactIntents: vi.fn(),
      setDependentAccount: vi.fn()
    })

    Object.assign(window, {
      hermesDesktop: {
        messaging: {
          status: vi.fn().mockResolvedValue($atumStatus.get()),
          roster: vi.fn().mockResolvedValue([conversation()]),
          messages: vi.fn().mockResolvedValue($atumMessages.get()[ROOM_ID]),
          draft: vi.fn().mockResolvedValue(null),
          transportStatus: vi.fn().mockResolvedValue({ accountId: 'account-a', healthy: true, state: 'healthy' }),
          socialSync: vi.fn().mockResolvedValue([]),
          groupCapabilities: vi.fn().mockResolvedValue(capabilities),
          groupDetail: vi.fn().mockResolvedValue({ room: room(), events: [], nextCursor: null, hasMore: false }),
          groupOperations: vi.fn().mockResolvedValue([]),
          mentionTargets: vi.fn().mockResolvedValue({
            contract: 'atum.addressed-mentions/1',
            mentionCardinality: 8,
            targets: [
              {
                target: { type: 'specialist', id: 'moon' },
                revision: 1,
                displayName: 'Moon',
                avatar: '☾',
                availability: 'available'
              },
              {
                target: { type: 'assistant', id: 'mai' },
                revision: 4,
                displayName: 'Mai',
                avatar: '🌿',
                availability: 'available'
              }
            ]
          }),
          saveDraft: vi.fn().mockResolvedValue({}),
          send,
          drainMentionJobs: vi.fn().mockResolvedValue({ claimed: 0, completed: 0 }),
          markRead: vi.fn().mockResolvedValue(true)
        } as unknown as AtumMessagingClient
      }
    })
  })

  afterEach(() => {
    cleanup()
    resetAtumMessagingState()
    $atumGroupQuote.set(null)
    vi.clearAllMocks()
  })

  it('keeps a specialist reply separate from explicit consent, then sends a mixed addressed quote and clears it across room/account boundaries', async () => {
    renderRoom()

    // The real account-bound group store invalidates capabilities as its
    // initialization read establishes the account scope. Re-publish the
    // already-negotiated native projection after that boundary, as the shell
    // does on its next capability read.
    await new Promise(resolve => setTimeout(resolve, 0))
    await act(async () => {
      $groupCapabilities.set(capabilities)
    })
    await waitFor(() => {
      expect($atumAccountStatus.get().state).toBe('signed_in')
      expect($atumStatus.get()?.connectivity).toBe('online')
      expect($groupCapabilities.get()).toEqual(capabilities)
      expect($atumRemovedGroups.get()[ROOM_ID]).not.toBe(true)
      expect(screen.getByRole('textbox', { name: 'Type a message...' })).toBeTruthy()
    })
    const replies = screen.getAllByRole('button', { name: 'Reply' })
    fireEvent.click(replies[0]!)

    expect(document.querySelector('[data-dm-specialist-reply]')?.textContent).toContain('Replying with your Moon.')
    expect($atumGroupQuote.get()).toBeNull()

    let composer = screen.getByRole('textbox', { name: 'Type a message...' }) as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: 'Tell me more', selectionStart: 12 } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(composer.value).toBe(''))
    expect(send.mock.calls[0]?.[0]).toMatchObject({ conversationId: ROOM_ID, replyToMessageId: 'specialist-message' })
    expect(send.mock.calls[0]?.[0].mentions).toBeNull()
    expect(send.mock.calls[0]?.[0].quotedMessage).toBeUndefined()

    composer = screen.getByRole('textbox', { name: 'Type a message...' }) as HTMLTextAreaElement
    const source = document.getElementById('dm-message-quote-source')!
    fireEvent.click(within(source).getByRole('button', { name: 'Quote for apps' }))
    expect($atumGroupQuote.get()).toMatchObject({ messageId: 'quote-source', sourceVersion: 3, membershipEpoch: 1 })

    fireEvent.change(composer, { target: { value: '@', selectionStart: 1 } })
    fireEvent.mouseDown(screen.getByRole('option', { name: /Moon/ }))
    expect(document.querySelectorAll('mark')).toHaveLength(1)
    composer = screen.getByRole('textbox', { name: 'Type a message...' }) as HTMLTextAreaElement
    const secondMentionStart = `${composer.value}@`
    fireEvent.change(composer, { target: { value: secondMentionStart, selectionStart: secondMentionStart.length } })
    fireEvent.mouseDown(screen.getByRole('option', { name: /Mai/ }))
    composer = screen.getByRole('textbox', { name: 'Type a message...' }) as HTMLTextAreaElement
    const addressedMessage = `${composer.value}help`
    fireEvent.change(composer, { target: { value: addressedMessage, selectionStart: addressedMessage.length } })
    expect(document.querySelectorAll('mark')).toHaveLength(2)
    const sendButton = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
    expect(sendButton.disabled).toBe(false)
    fireEvent.click(sendButton)
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))

    expect(send.mock.calls[1]?.[0]).toMatchObject({
      conversationId: ROOM_ID,
      replyToMessageId: null,
      quotedMessage: { messageId: 'quote-source', sourceVersion: 3 },
      mentions: {
        contract: 'atum.addressed-mentions/1',
        targets: [
          { target: { type: 'specialist', id: 'moon' }, revision: 1, startOffset: 0, endOffset: 5 },
          { target: { type: 'assistant', id: 'mai' }, revision: 4, startOffset: 6, endOffset: 10 }
        ]
      }
    })

    fireEvent.click(
      within(document.getElementById('dm-message-quote-source')!).getByRole('button', { name: 'Quote for apps' })
    )
    expect($atumGroupQuote.get()).not.toBeNull()
    await act(async () => {
      $atumRoster.set([conversation(2)])
    })
    await waitFor(() => expect($atumGroupQuote.get()).toBeNull())

    fireEvent.click(
      within(document.getElementById('dm-message-quote-source')!).getByRole('button', { name: 'Quote for apps' })
    )
    expect($atumGroupQuote.get()).not.toBeNull()
    await act(async () => {
      $atumStatus.set({ ...$atumStatus.get()!, accountId: 'account-b' })
    })
    await waitFor(() => expect($atumGroupQuote.get()).toBeNull())
  })

  it('keeps an open mention picker usable through a no-op capability refresh', async () => {
    renderRoom()

    // The account-bound group store clears its projection while initialization
    // establishes the account scope. Restore the negotiated projection once
    // that boundary has settled, as the shell does on its next read.
    await new Promise(resolve => setTimeout(resolve, 0))
    await act(async () => {
      $groupCapabilities.set(capabilities)
    })

    const composer = await screen.findByRole('textbox', { name: 'Type a message...' })
    fireEvent.change(composer, { target: { value: '@', selectionStart: 1 } })
    await waitFor(() => expect(screen.getByRole('option', { name: /Moon/ })).toBeTruthy())

    // Let the initial negotiated projection finish publishing before the
    // refresh below, so this is a true equivalent refresh while the picker is
    // already usable rather than an initialization race.
    await new Promise(resolve => setTimeout(resolve, 0))

    const discoveryCalls = vi.mocked(window.hermesDesktop.messaging.mentionTargets!).mock.calls.length

    const refreshedCapabilities = {
      ...capabilities,
      addressing: {
        ...capabilities.addressing,
        specialistCatalog: capabilities.addressing.specialistCatalog.map(specialist => ({ ...specialist }))
      }
    }

    await act(async () => {
      $groupCapabilities.set(refreshedCapabilities)
    })

    expect(screen.getByRole('option', { name: /Moon/ })).toBeTruthy()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(vi.mocked(window.hermesDesktop.messaging.mentionTargets!).mock.calls).toHaveLength(discoveryCalls)
  })

  it('refreshes the open mention picker on a newer room revision without accepting the older response', async () => {
    const staleResponse = deferred<AtumMentionTargetsResponse>()
    const refreshedResponse = deferred<AtumMentionTargetsResponse>()
    const discoverTargets = vi.mocked(window.hermesDesktop.messaging.mentionTargets!)
    discoverTargets.mockReset()
    discoverTargets.mockReturnValueOnce(staleResponse.promise).mockReturnValueOnce(refreshedResponse.promise)

    renderRoom()
    await new Promise(resolve => setTimeout(resolve, 0))
    await act(async () => {
      $groupCapabilities.set(capabilities)
    })

    const composer = await screen.findByRole('textbox', { name: 'Type a message...' })
    fireEvent.change(composer, { target: { value: '@', selectionStart: 1 } })
    await waitFor(() => expect(discoverTargets).toHaveBeenCalledTimes(1))

    const updatedRoom = {
      ...room(1, 2),
      members: [
        ...room().members,
        { userId: 'andy', displayName: 'Andy', handle: 'andy', role: 'member' as const, membershipEpoch: 1 }
      ]
    }

    await act(async () => {
      $atumRoster.set([
        {
          ...conversation(1, 2),
          participantIds: ['account-a', 'lan', 'andy'],
          group: updatedRoom
        }
      ])
    })

    expect($atumRoster.get()[0]?.group?.membershipEpoch).toBe(1)
    expect($atumRoster.get()[0]?.group?.revision).toBe(2)
    await waitFor(() => expect(discoverTargets).toHaveBeenCalledTimes(2))

    await act(async () => {
      refreshedResponse.resolve({
        contract: 'atum.addressed-mentions/1',
        mentionCardinality: 8,
        targets: [
          {
            target: { type: 'assistant', id: 'andy' },
            revision: 1,
            displayName: 'Andy',
            avatar: '🤖',
            availability: 'available'
          }
        ]
      })
      await refreshedResponse.promise
    })

    await waitFor(() => expect(screen.getByRole('option', { name: /Andy/ })).toBeTruthy())

    await act(async () => {
      staleResponse.resolve({
        contract: 'atum.addressed-mentions/1',
        mentionCardinality: 8,
        targets: [
          {
            target: { type: 'specialist', id: 'moon' },
            revision: 1,
            displayName: 'Moon',
            avatar: '☾',
            availability: 'available'
          }
        ]
      })
      await staleResponse.promise
    })

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Andy/ })).toBeTruthy()
      expect(screen.queryByRole('option', { name: /Moon/ })).toBeNull()
    })
  })
})
