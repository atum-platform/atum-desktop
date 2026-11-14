import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createClient, EventType, MatrixEvent, Room } from 'matrix-js-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $appViewOverlayCount } from '@/store/app-view-overlay'
import { $bindings, resetAllBindings, setBinding } from '@/store/keybinds'

import { assistantRooms } from '../../electron/matrix/assistant-policy'
import type { AppDescriptor } from '../../shared/app-catalog'
import type { MatrixExecutionPolicyBridge } from '../../shared/execution-policy'
import {
  MATRIX_MAX_FILE_BYTES,
  type MatrixAgentHomeBridge,
  type MatrixAgentView,
  type MatrixAppMenu,
  type MatrixHermesPrompt,
  type MatrixRoom,
  type MatrixSnapshot,
  type MatrixUiBridge
} from '../../shared/matrix'
import { matrixActionCopy } from '../../shared/matrix-action-copy'
import type { MatrixAssistantCardsBridge } from '../../shared/matrix-assistant-card'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'
import { defaultMatrixCheckInSettings, emptyMatrixCheckInLedger } from '../../shared/matrix-check-ins'
import type { MatrixCompanyBridge } from '../../shared/matrix-company'
import { MATRIX_COMPANY_CHANNEL_TYPE, MATRIX_COMPANY_CONVERSATION_TYPE } from '../../shared/matrix-company-channel-room'
import type { MatrixCompanyAudience, MatrixCompanyPresentation } from '../../shared/matrix-company-presentation'
import {
  MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE,
  type MatrixCompanyPrivateCosCapabilityV13,
  type MatrixCompanyPrivateCosView
} from '../../shared/matrix-company-private-cos'
import type { MatrixDesktopServicesBridge, MatrixDesktopServicesStatus } from '../../shared/matrix-desktop-services'
import type { MatrixDriveBridge, MatrixDriveTaskResult, MatrixDriveView } from '../../shared/matrix-drive'
import type { MatrixGoogleConnectionBridge } from '../../shared/matrix-google-connections'
import { type MatrixModelCatalog, matrixModelRouteId } from '../../shared/matrix-models'
import { MATRIX_NOTES_SELF_ROOM_TYPE } from '../../shared/matrix-notes-self'
import type { MatrixPagesBridge } from '../../shared/matrix-pages'
import type { MatrixPermissionsSnapshot } from '../../shared/matrix-permissions'

import { MatrixApp } from './app'
import { $assistantCard, $assistantNameOverrides, openAssistantCard } from './assistant-card'
import { ATUM_LINKS } from './atum-links'
import { matrixChatCopy } from './chat-copy'
import { matrixCheckInsCopy } from './check-ins-copy'
import { companyPrivateCosRecipient } from './company-ai-sdk'
import { $companyChannelOrder } from './company-chrome'
import type { CompanyAIView } from './company-desktop-adapter'
import { $companyAIStatuses, $companySpacePreferences, companySpacePreferences } from './company-space-store'
import { companyTurnMemory } from './company-turn-memory'
import { resolveProjectedConversation } from './conversation-marker'
import { conversationRoom } from './conversations'
import { $matrixDesktopServices } from './desktop-services'
import { $matrixDriveTaskSelection, selectMatrixDriveFile, setMatrixDriveTaskScope } from './drive-selection'
import { requestFounderChat } from './founder/founder-store'
import { resetMatrixGoogleNudgeDismissals } from './google-connection-settings'
import { $outgoingEchoes } from './outgoing-echo'
import { matrixHandleAccount, rememberMatrixHandle, resetMatrixHandlesForTest } from './person-handles'
import { COMPANY_AI_ANSWER_FIXTURE, playgroundCompanyDesktopAdapter } from './playground/company-ai-fixtures'
import { normalizeMatrixSettingsPane, settingsPageOf } from './settings-revamp'
import { MATRIX_LAUNCH_HOLD_MS } from './startup-screen'
import { hubSkillRequest } from './store/hub-skill'
import { $matrixStoreDraft } from './store/store-try'
import { $matrixStoreHubRequest, $matrixStoreShelfRequest } from './store/top-up'
import { $teamSpaceIntent } from './team-space/intents'
import { clearCompanyPrivateCos } from './team-space/private-cos-store'
import { runMatrixCommand } from './text-document-actions'

/** A chat's composer is named for who you write to ("Message Atum"); a thread's keeps the plain prompt. */
const COMPOSER = /^Message /
const THREAD_COMPOSER = 'Reply'

/** New assistant is the New chat sheet's footer action (Atum Kit mockups), not a roster row. */
async function openNewAssistant() {
  fireEvent.click(await screen.findByRole('button', { name: 'New…' }))
  fireEvent.click(await screen.findByRole('button', { name: 'New assistant' }))
}

/** The way into Connections: the two-column picker's rail item, or the plain menu's subscription row. */
const CONNECTIONS = /Connections|Use your ChatGPT subscription/

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,ZmFrZQ==') } }))

const HUB_INSTALL = { source: 'hermes_hub' as const, id: 'official/creative/pixel-art' }

const signedOut: MatrixSnapshot = {
  state: 'signed_out',
  identity: null,
  rooms: [],
  roomId: null,
  messages: [],
  error: null
}

const assistantFields = {
  roomType: MATRIX_ASSISTANT_ROOM_TYPE,
  participants: [
    { userId: '@owner:test', membership: 'join' },
    { userId: '@atum:test', membership: 'join' }
  ]
}

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')

/** A shown launch holds its eclipse for its moment, then flies home (startup-screen.tsx). */
const LAUNCH_OPENS = { timeout: MATRIX_LAUNCH_HOLD_MS + 2_500 }

/**
 * Plays a shown launch to its end on fake timers (installed with `shouldAdvanceTime` before
 * the window renders): the eclipse's moment, then the flight home.
 */
async function passLaunch() {
  await act(async () => void (await vi.advanceTimersByTimeAsync(MATRIX_LAUNCH_HOLD_MS)))
  await act(async () => void (await vi.advanceTimersByTimeAsync(1_500)))
}

/** Assistant trouble never owns launch; wait for the launch component to hand off to the shell. */
async function waitForLaunchToOpen() {
  await waitFor(() => expect(window.document.querySelector('[data-slot="matrix-startup"]')).toBeNull())
}

/** Workplace's native pages, opened and closed harmlessly. */
function workplacePages(): MatrixPagesBridge {
  return {
    open: vi.fn(async () => ({ viewId: 'page' })),
    setBounds: vi.fn(async () => ({ ok: true as const })),
    setVisibility: vi.fn(async () => ({ ok: true as const })),
    focus: vi.fn(async () => ({ ok: true as const })),
    close: vi.fn(async () => ({ ok: true as const })),
    onState: vi.fn(() => vi.fn())
  }
}

/** A company workspace: the only Team Space surface the rail shows. */
function companyWorkspace(): MatrixCompanyBridge {
  return {
    pending: vi.fn(async () => ({ ok: true as const, request: null })),
    request: vi.fn(async () => ({
      ok: true as const,
      value: { schemaVersion: 1 as const, companies: [], invitations: [] }
    }))
  }
}

function companyWorkspaceWithChannel(
  roomId: string,
  channelState: () => 'active' | 'archived' = () => 'active',
  companyId = 'company-a',
  role: 'admin' | 'member' = 'admin'
): MatrixCompanyBridge {
  const company = { id: companyId, displayName: 'Alpha', role, authorityGeneration: 1 }

  return {
    pending: vi.fn(async () => ({ ok: true as const, request: null })),
    request: vi.fn(async input => {
      if (input.action === 'list') {
        return { ok: true as const, value: { schemaVersion: 1 as const, companies: [company], invitations: [] } }
      }

      if (input.action === 'read') {
        return { ok: true as const, value: { schemaVersion: 1 as const, company, members: [], projects: [] } }
      }

      if (input.action === 'list-channels') {
        return {
          ok: true as const,
          value: {
            schemaVersion: 1 as const,
            channels: [
              {
                schemaVersion: 1 as const,
                channel: {
                  id: '00000000-0000-4000-8000-676a3a34ff0f',
                  companyId: company.id,
                  displayName: 'launch',
                  visibility: 'company' as const,
                  state: channelState(),
                  projectId: null,
                  authorityGeneration: 1,
                  channelGeneration: 1
                },
                memberPrincipals: [],
                room: { state: 'ready' as const, roomId }
              }
            ]
          }
        }
      }

      return { ok: false as const, error: 'missing' as const }
    })
  }
}

/** `companyWorkspaceWithChannel`, whose channel directory is not answered until `gate` resolves: the platform's facts arrive late. */
function companyWorkspaceWithLateDirectory(
  roomId: string,
  gate: Promise<void>,
  channelState: () => 'active' | 'archived'
): MatrixCompanyBridge {
  const inner = companyWorkspaceWithChannel(roomId, channelState)

  return {
    ...inner,
    request: vi.fn(async input => {
      if (input.action === 'list-channels') {
        await gate
      }

      return inner.request(input)
    })
  }
}

/**
 * Alpha with company-workspace 1.5 on and one company conversation (a company DM) in `roomId`. `conversationState` is the
 * platform's word on it; `gate`, when given, holds the conversation directory back so its facts arrive late.
 */
function companyWorkspaceWithConversation(
  roomId: string,
  conversationState: () => 'active' | 'read_only',
  gate?: Promise<void>,
  kind: 'dm' | 'group_dm' = 'dm'
): MatrixCompanyBridge {
  const company = { id: 'company-a', displayName: 'Alpha', role: 'admin' as const, authorityGeneration: 1 }
  const bao = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI'
  const minh = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'

  return {
    pending: vi.fn(async () => ({ ok: true as const, request: null })),
    request: vi.fn(async input => {
      if (input.action === 'capabilities') {
        return {
          ok: true as const,
          value: {
            schemaVersion: 4 as const,
            wireVersion: '1.3' as const,
            supportedWireVersions: ['1', '1.1', '1.2', '1.3', '1.4', '1.5'] as ['1', '1.1', '1.2', '1.3', '1.4', '1.5'],
            features: {
              ownership: true as const,
              invitationLifecycle: true as const,
              capabilityDiscovery: true as const,
              channelAdmission: false,
              companyConversations: true
            },
            activation: {
              teamAdmin: 'inactive' as const,
              channelAdmission: 'inactive' as const,
              companyConversations: 'active' as const
            },
            controller: { roomReconciliation: 'ready' as const }
          }
        }
      }

      if (input.action === 'list') {
        return { ok: true as const, value: { schemaVersion: 1 as const, companies: [company], invitations: [] } }
      }

      if (input.action === 'read') {
        return { ok: true as const, value: { schemaVersion: 1 as const, company, members: [], projects: [] } }
      }

      if (input.action === 'list-channels') {
        return { ok: true as const, value: { schemaVersion: 1 as const, channels: [] } }
      }

      if (input.action === 'conversations') {
        await gate

        return {
          ok: true as const,
          value: {
            schemaVersion: 6 as const,
            conversations: [
              {
                id: '00000000-0000-4000-8000-f6c6b8bb709f',
                companyId: company.id,
                kind,
                state: conversationState(),
                participants: [
                  { memberRef: minh, admissionEpoch: 1, handle: 'minh', displayName: 'Minh' },
                  { memberRef: bao, admissionEpoch: 1, handle: 'bao', displayName: 'Bảo' },
                  ...(kind === 'group_dm'
                    ? [{ memberRef: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM', admissionEpoch: 1,
                        handle: 'linh', displayName: 'Linh' }]
                    : [])
                ],
                participantSetDigest: '0'.repeat(64),
                authorityGeneration: 1,
                conversationGeneration: 1,
                room: { state: 'ready' as const, roomId },
                hidden: false
              }
            ]
          }
        }
      }

      return { ok: false as const, error: 'missing' as const }
    })
  }
}

/** Two companies, Alpha (with the one channel room) and Beta (none): enough to move between them. */
function twoCompaniesWithChannel(roomId: string): MatrixCompanyBridge {
  const companies = [
    { id: 'company-a', displayName: 'Alpha', role: 'admin' as const, authorityGeneration: 1 },
    { id: 'company-b', displayName: 'Beta', role: 'admin' as const, authorityGeneration: 1 }
  ]

  return {
    pending: vi.fn(async () => ({ ok: true as const, request: null })),
    request: vi.fn(async input => {
      if (input.action === 'list') {
        return { ok: true as const, value: { schemaVersion: 1 as const, companies, invitations: [] } }
      }

      if (input.action === 'read') {
        const company = companies.find(value => value.id === input.companyId)!

        return { ok: true as const, value: { schemaVersion: 1 as const, company, members: [], projects: [] } }
      }

      if (input.action === 'list-channels') {
        return {
          ok: true as const,
          value: {
            schemaVersion: 1 as const,
            channels:
              input.companyId === 'company-a'
                ? [
                    {
                      schemaVersion: 1 as const,
                      channel: {
                        id: '00000000-0000-4000-8000-676a3a34ff0f',
                        companyId: 'company-a',
                        displayName: 'launch',
                        visibility: 'company' as const,
                        state: 'active' as const,
                        projectId: null,
                        authorityGeneration: 1,
                        channelGeneration: 1
                      },
                      memberPrincipals: [],
                      room: { state: 'ready' as const, roomId }
                    }
                  ]
                : []
          }
        }
      }

      return { ok: false as const, error: 'missing' as const }
    })
  }
}

function promotedMainSnapshot(): MatrixSnapshot {
  return {
    ...signedOut,
    state: 'ready',
    identity: { userId: '@owner:test', deviceId: 'OWNER' },
    assistant: { userId: '@main:test', deviceId: 'MAIN' },
    domainEnabled: true,
    hermes: 'ready',
    readiness: { phase: 'ready', since: 1 },
    atumModel: true,
    agents: [
      {
        principal: 'old-root',
        userId: '@atum:test',
        deviceId: 'OLD',
        name: 'Original assistant',
        isDefault: false,
        ready: true,
        hermes: 'unavailable',
        readiness: { phase: 'degraded', since: 2 },
        atumModel: false
      },
      {
        principal: 'main',
        userId: '@main:test',
        deviceId: 'MAIN',
        name: 'Atum Main',
        isDefault: true,
        ready: true,
        hermes: 'ready',
        readiness: { phase: 'ready', since: 1 },
        atumModel: true
      }
    ],
    roomId: '!human:test',
    rooms: [
      {
        ...assistantFields,
        id: '!old:test',
        name: 'Original retained chat',
        membership: 'join',
        encrypted: true,
        assistant: true,
        agentPrincipal: 'old-root',
        lastActiveAt: 100
      },
      {
        ...assistantFields,
        participants: [assistantFields.participants[0]!, { userId: '@main:test', membership: 'join' }],
        id: '!main:test',
        name: 'Main retained chat',
        membership: 'join',
        encrypted: true,
        assistant: true,
        agentPrincipal: 'main',
        lastActiveAt: 1
      },
      { id: '!human:test', name: 'Morgan', membership: 'join', encrypted: true }
    ]
  }
}

beforeEach(() => {
  resetAllBindings()
  resetMatrixGoogleNudgeDismissals()
  // The first launch's story has its own tests; everything else starts past it.
  window.localStorage.setItem('io.atum.welcome.played', '1')
  vi.stubGlobal('innerWidth', 1220)
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

describe('@handles stay out of chats', () => {
  it('keeps an unnamed Team Space sender "Atum user" after a handle is learned, and sign-out drops the account', async () => {
    const stranger = '@user-0123456789abcdef0123456789abcdef:test'

    const { emit, view } = fixture(
      undefined,
      'en',
      undefined,
      undefined,
      undefined,
      companyWorkspaceWithChannel('!launch:test')
    )

    try {
      await screen.findByRole('button', { name: 'Continue with Google' })

      emit({
        ...signedOut,
        state: 'ready',
        identity: { userId: '@owner:test', deviceId: 'OWNER' },
        companyWorkspaceEnabled: true,
        roomId: '!launch:test',
        rooms: [
          {
            id: '!launch:test',
            name: 'launch',
            membership: 'join',
            encrypted: false,
            roomType: MATRIX_COMPANY_CHANNEL_TYPE,
            companyChannel: { companyId: 'company-a', channelId: '00000000-0000-4000-8000-676a3a34ff0f' },
            participants: [
              { userId: '@owner:test', membership: 'join' },
              { userId: stranger, membership: 'join' }
            ]
          }
        ],
        members: [{ userId: '@owner:test', name: 'You', membership: 'join', canRemove: false }],
        messages: [
          {
            id: '$hello',
            sender: stranger,
            body: 'Hello team',
            timestamp: 10,
            own: false,
            encrypted: false,
            decryptionFailed: false,
            pending: false,
            failed: false,
            attachment: false
          }
        ]
      })
      await screen.findByRole('textbox', { name: COMPOSER })

      const sender = () => view.container.querySelector<HTMLElement>('[data-team-space-sender]')?.textContent ?? ''

      // The root bound the handle list to this account before the chat rendered.
      expect(matrixHandleAccount().owner).toBe('@owner:test')
      expect(sender()).toContain('Atum user')

      // What a contacts answer writes: the chat still names them as it did, never by @handle.
      act(() => rememberMatrixHandle(stranger, 'poon'))
      expect(sender()).toContain('Atum user')
      expect(view.container.querySelector('[data-team-space-layout]')?.textContent).not.toContain('@poon')

      // Signing out unbinds the list (a new generation), so nothing learned or queued survives it.
      const before = matrixHandleAccount().generation
      emit(signedOut)
      expect(matrixHandleAccount()).toEqual({ owner: '', generation: before + 1 })
    } finally {
      resetMatrixHandlesForTest()
    }
  })
})

describe('Team Space threads', () => {
  it('opens one thread panel, filters attention, follows, reads and sends to the standard root', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const command = vi.fn(async (input: { kind?: string }) => input.kind === 'draft' ? { status: 'pending' as const } : null)

    const { bridge, emit, view } = fixture(
      undefined,
      'en',
      undefined,
      command,
      undefined,
      companyWorkspaceWithChannel('!launch:test')
    )

    const attend = vi.fn(async () => {})
    bridge.attend = attend
    await screen.findByRole('button', { name: 'Continue with Google' })

    const root = {
      id: '$root',
      sender: '@linh:test',
      body: 'Launch plan?',
      timestamp: 10,
      own: false,
      encrypted: false,
      decryptionFailed: false,
      pending: false,
      failed: false,
      attachment: false
    }

    const secondRoot = { ...root, id: '$other-root', body: 'Office lunch?', timestamp: 5 }
    const multiline = { ...root, id: '$multi', body: 'First line\nSecond line', timestamp: 12 }

    const reply = {
      ...root,
      id: '$reply',
      sender: '@owner:test',
      body: 'Tuesday works.',
      timestamp: 20,
      own: true,
      thread: true as const,
      threadRootId: '$root',
      replyTo: '$root'
    }

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'OWNER' },
      companyWorkspaceEnabled: true,
      companyDriveFilesEnabled: true,
      roomId: '!launch:test',
      rooms: [
        {
          id: '!launch:test',
          name: 'launch',
          membership: 'join',
          encrypted: false,
          roomType: MATRIX_COMPANY_CHANNEL_TYPE,
          companyChannel: { companyId: 'company-a', channelId: '00000000-0000-4000-8000-676a3a34ff0f' },
          participants: [
            { userId: '@owner:test', membership: 'join' },
            { userId: '@linh:test', membership: 'join' }
          ]
        }
      ],
      members: [
        { userId: '@owner:test', name: 'You', membership: 'join', canRemove: false },
        { userId: '@linh:test', name: 'Linh', membership: 'join', canRemove: false }
      ],
      messages: [secondRoot, multiline, root],
      savedMessages: {
        records: [{ room_id: '!launch:test', event_id: '$root', saved_at: 30 }],
        writable: true
      },
      notificationPolicy: {
        version: 1,
        accountLevel: 'mentions',
        quietHours: { enabled: false, startMinute: 1_320, endMinute: 420, timeZone: 'UTC' },
        channelOverrides: {},
        threadOverrides: {},
        writable: true
      },
      threads: [
        {
          root,
          replies: [reply],
          participantIds: ['@linh:test', '@owner:test'],
          replyCount: 1,
          lastActivityAt: 20,
          unread: true,
          highlights: 1,
          followed: true
        },
        {
          root: secondRoot,
          replies: [],
          participantIds: ['@linh:test'],
          replyCount: 1,
          lastActivityAt: 5,
          unread: false,
          highlights: 0,
          followed: false
        }
      ]
    }

    emit(state)
    const roomComposer = await screen.findByRole('textbox', { name: COMPOSER })

    // Release B carries no default-state encryption notice over the company composer:
    // a plain company channel is an ordinary room, not a condition that needs a banner.
    const encryptionNotice = view.container.querySelector<HTMLElement>(
      '.notice-band[data-matrix-company-not-encrypted]'
    )

    expect(encryptionNotice).toBeNull()
    expect(view.container.querySelector('[data-matrix-company-not-encrypted]')).toBeNull()
    expect(view.container.textContent).not.toContain('Company channels are not end-to-end encrypted')

    // Team Space reads like Slack: flat runs opening on a face, a name and a time, no bubbles, and a
    // formatting row the box's "Aa" opens.
    const channel = view.container.querySelector<HTMLElement>('[data-team-space-layout]')!
    expect(channel.querySelector('.matrix-chat-bubble')).toBeNull()
    expect(channel.querySelector('[data-team-space-sender]')).toBeTruthy()
    // The bubble rule of 2026-11-05 leaves channels alone: the face opens the run beside the
    // name, and no row carries the bubble chats' face gutter.
    expect(channel.querySelector('[data-team-space-sender] [data-matrix-avatar]')).toBeTruthy()
    expect(channel.querySelector('[data-matrix-face-gutter]')).toBeNull()
    expect(channel.querySelector('[data-matrix-sender]')).toBeNull()
    // The formatting row waits behind the box's "Aa".
    expect(within(channel).queryByRole('toolbar', { name: 'Formatting' })).toBeNull()
    fireEvent.click(within(channel).getByRole('button', { name: 'Formatting' }))
    expect(await within(channel).findByRole('toolbar', { name: 'Formatting' })).toBeTruthy()
    // A message keeps the line breaks the person wrote, as Slack's flat rows do.
    const multilineRow = channel.querySelector<HTMLElement>('[data-matrix-message-id="$multi"] .matrix-flat-message')
    expect(multilineRow?.textContent).toContain('First line\nSecond line')
    expect(multilineRow?.className).toContain('whitespace-pre-wrap')
    expect(channel.querySelector('[data-matrix-message-id="$root"] [data-matrix-saved-message]')).toBeTruthy()

    const multilineMenu = channel.querySelector<HTMLElement>(
      '[data-matrix-message-id="$multi"] [data-matrix-report-message]'
    )!

    fireEvent.keyDown(multilineMenu, { key: 'Enter' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save message' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({
      kind: 'savedMessage', roomId: '!launch:test', eventId: '$multi', saved: true
    }))
    await waitFor(() => expect(
      channel.querySelector('[data-matrix-message-id="$multi"] [data-matrix-saved-message]')
    ).toBeTruthy())

    const conversationOptions = await screen.findByRole('button', { name: 'Conversation options' })
    roomComposer.focus()
    fireEvent.keyDown(conversationOptions, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open threads' }))
    const panel = view.container.querySelector<HTMLElement>('[data-matrix-thread-panel]')!
    expect(panel).toBeTruthy()
    expect(within(panel).getByText('Launch plan?')).toBeTruthy()
    expect(within(panel).getByText('Office lunch?')).toBeTruthy()

    fireEvent.click(within(panel).getByRole('button', { name: 'Following' }))
    expect(within(panel).getByText('Launch plan?')).toBeTruthy()
    expect(within(panel).queryByText('Office lunch?')).toBeNull()
    fireEvent.click(within(panel).getByRole('button', { name: 'Unread' }))
    fireEvent.click(within(panel).getByRole('button', { name: /Launch plan/ }))

    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({ kind: 'threadRead', roomId: '!launch:test', rootId: '$root' })
    )
    attend.mockClear()
    vi.stubGlobal('innerWidth', 390)
    fireEvent(window, new Event('resize'))
    await waitFor(() => expect(attend).toHaveBeenCalledWith(null))
    attend.mockClear()
    vi.stubGlobal('innerWidth', 1220)
    fireEvent(window, new Event('resize'))
    await waitFor(() => expect(attend).toHaveBeenCalledWith('!launch:test'))
    expect(within(panel).getByText('Tuesday works.')).toBeTruthy()
    expect(within(panel).getByText('Thread')).toBeTruthy()
    expect(within(panel).getByText('#launch')).toBeTruthy()
    expect(within(panel).getByRole('button', { name: 'Back to threads' })).toBeTruthy()
    // Slack's rule under the thread's first message: how many replies follow.
    expect(panel.querySelector('[data-team-space-replies-divider]')?.textContent).toBe('1 reply')
    expect(within(panel).queryByRole('button', { name: 'Reply' })).toBeNull()
    // Mattermost's header: the follow state is a visible capsule ("Following") that toggles.
    fireEvent.click(within(panel).getByRole('button', { name: 'Following' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({
        kind: 'threadFollow',
        roomId: '!launch:test',
        rootId: '$root',
        followed: false
      })
    )
    expect(await within(panel).findByRole('button', { name: 'Follow' })).toBeTruthy()
    fireEvent.keyDown(within(panel).getByRole('button', { name: 'Thread options' }), { key: 'Enter' })
    const notifications = await screen.findByRole('menuitem', { name: 'Notifications' })
    fireEvent.keyDown(notifications, { key: 'ArrowRight' })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Nothing' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({
      kind: 'notificationPolicy',
      identity: state.identity,
      scope: 'thread',
      roomId: '!launch:test',
      rootId: '$root',
      level: 'nothing'
    }))

    const composer = within(panel).getByRole('textbox', { name: THREAD_COMPOSER })
    fireEvent.change(composer, { target: { value: 'Keep this draft' } })
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({
        kind: 'draft',
        identity: { userId: '@owner:test', deviceId: 'OWNER' },
        roomId: '!launch:test',
        threadRootId: '$root',
        text: 'Keep this draft'
      })
    )
    expect(await within(panel).findByText('Saved on this Mac. Syncing when you’re back online.')).toBeTruthy()
    fireEvent.keyDown(composer, { key: 'Escape' })
    await waitFor(() => expect(panel.querySelector('[data-matrix-thread-list]')).toBeTruthy())
    await waitFor(() => expect(document.activeElement?.getAttribute('data-matrix-thread-row')).toBe('$root'))
    fireEvent.click(within(panel).getByRole('button', { name: /Launch plan/ }))
    const restoredComposer = await within(panel).findByRole('textbox', { name: THREAD_COMPOSER })
    expect((restoredComposer as HTMLTextAreaElement).value).toBe('Keep this draft')
    fireEvent.change(restoredComposer, { target: { value: '' } })
    const file = new File(['brief'], 'brief.txt', { type: 'text/plain' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('brief').buffer })
    fireEvent.change(within(panel).getByLabelText('Attach file (up to 20 MB)'), { target: { files: [file] } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'attach',
          roomId: '!launch:test',
          name: 'brief.txt',
          contentType: 'text/plain',
          threadRootId: '$root',
          replyTo: '$root'
        })
      )
    )
    fireEvent.change(restoredComposer, { target: { value: 'Ship the brief.' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({
        kind: 'send',
        roomId: '!launch:test',
        body: 'Ship the brief.',
        threadRootId: '$root'
      })
    )
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({
        kind: 'draft',
        identity: { userId: '@owner:test', deviceId: 'OWNER' },
        roomId: '!launch:test',
        threadRootId: '$root',
        text: ''
      })
    )
    fireEvent.click(within(panel).getByRole('button', { name: 'Close threads' }))
    await waitFor(() => expect(view.container.querySelector('[data-matrix-thread-panel]')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open threads' })))

    const rootRow = view.container.querySelector<HTMLElement>('[data-matrix-message-id="$root"]')!
    // Slack's line under the root: the replier's face (you replied; the root's author did not), the
    // count and the last reply. The reply itself is never a channel row.
    const threadLine = within(rootRow).getByRole('button', { name: /^1 reply, Unread, Last reply / })
    expect(threadLine.querySelector('[data-thread-summary-faces] [data-person-avatar="@owner:test"]')).toBeTruthy()
    expect(threadLine.querySelector('[data-thread-summary-faces] [data-person-avatar="@linh:test"]')).toBeNull()
    expect(channel.querySelector('[data-matrix-message-id="$reply"]')).toBeNull()
    fireEvent.click(threadLine)
    const directPanel = view.container.querySelector<HTMLElement>('[data-matrix-thread-panel]')!
    expect(within(directPanel).queryByRole('button', { name: 'Back to threads' })).toBeNull()
    const directComposer = within(directPanel).getByRole('textbox', { name: 'Reply' })
    fireEvent.keyDown(directComposer, { key: 'Escape' })
    await waitFor(() => expect(view.container.querySelector('[data-matrix-thread-panel]')).toBeNull())

    emit({ ...state, messages: [], threads: [] })
    // An empty channel opens on its intro, where the first message will land.
    const intro = await screen.findByRole('region', { name: 'This is the start of #launch' })
    expect(within(intro).getByRole('heading', { name: 'launch' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Ask Chief of Staff' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Invite teammates' }))
    expect($teamSpaceIntent.get()?.intent).toEqual({ kind: 'invite-members' })
  }, 30_000)
})

describe('Team Space shared pins', () => {
  it('gates the message action by live power, marks the message, and opens the header panel', async () => {
    const command = vi.fn(async () => null)

    const { emit, view } = fixture(undefined, 'en', undefined, command, undefined,
      companyWorkspaceWithChannel('!launch:test'))

    await screen.findByRole('button', { name: 'Continue with Google' })

    const message = {
      id: '$decision', sender: '@owner:test', body: 'Ship the smaller release first.', timestamp: 10,
      own: true, encrypted: false, decryptionFailed: false, pending: false, failed: false, attachment: false
    }

    const room: MatrixRoom = {
      id: '!launch:test', name: 'launch', membership: 'join', encrypted: false,
      roomType: MATRIX_COMPANY_CHANNEL_TYPE,
      companyChannel: { companyId: 'company-a', channelId: '00000000-0000-4000-8000-676a3a34ff0f' },
      participants: [{ userId: '@owner:test', membership: 'join' }]
    }

    const state: MatrixSnapshot = {
      ...signedOut, state: 'ready', identity: { userId: '@owner:test', deviceId: 'OWNER' },
      companyWorkspaceEnabled: true, roomId: room.id, rooms: [room], messages: [message],
      members: [{ userId: '@owner:test', name: 'You', membership: 'join', canRemove: false }],
      pinnedMessages: { canChange: true, entries: [{ eventId: message.id, message }] }
    }

    emit(state)
    expect(await screen.findByRole('button', { name: '1 pinned message' })).toBeTruthy()
    expect(view.container.querySelector('[data-matrix-pinned-marker]')).toBeTruthy()

    const actions = await waitFor(() => {
      const found = view.container.querySelector<HTMLButtonElement>('[data-matrix-message-actions]')
      expect(found).toBeTruthy()

      return found!
    })

    fireEvent.keyDown(actions, { key: 'Enter' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unpin message' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({
      kind: 'pinMessage', roomId: room.id, eventId: message.id, pinned: false
    }))

    emit({ ...state, pinnedMessages: { canChange: false, entries: [{ eventId: message.id, message }] } })
    fireEvent.keyDown(actions, { key: 'Enter' })
    expect(screen.queryByRole('menuitem', { name: 'Unpin message' })).toBeNull()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    fireEvent.click(screen.getByRole('button', { name: '1 pinned message' }))
    const panel = view.container.querySelector<HTMLElement>('[data-matrix-pinned-panel]')!
    expect(within(panel).getByText('Ship the smaller release first.')).toBeTruthy()
    fireEvent.click(within(panel).getByText('Jump to message'))
    await waitFor(() => expect(view.container.querySelector('[data-matrix-pinned-panel]')).toBeNull())
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled())
  })
})

describe('Team Space channel membership lines', () => {
  const hello = {
    id: '$hello',
    sender: '@linh:test',
    body: 'Welcome aboard',
    timestamp: 10,
    own: false,
    encrypted: false,
    decryptionFailed: false,
    pending: false,
    failed: false,
    attachment: false
  }

  /** The open room as main publishes it: a confirmed channel carries its binding, an unconfirmed claim does not. */
  const snapshotWith = (room: Partial<MatrixSnapshot['rooms'][number]>): MatrixSnapshot => ({
    ...signedOut,
    state: 'ready',
    identity: { userId: '@owner:test', deviceId: 'OWNER' },
    companyWorkspaceEnabled: true,
    companyDriveFilesEnabled: true,
    roomId: '!launch:test',
    rooms: [
      {
        id: '!launch:test',
        name: 'launch',
        membership: 'join',
        encrypted: false,
        participants: [
          { userId: '@owner:test', membership: 'join' },
          { userId: '@linh:test', membership: 'join' }
        ],
        ...room
      }
    ],
    members: [
      { userId: '@owner:test', name: 'You', membership: 'join', canRemove: false },
      { userId: '@linh:test', name: 'Linh', membership: 'join', canRemove: false }
    ],
    messages: [hello],
    membershipLines: [
      { id: '$you', timestamp: 5, kind: 'joined', userId: '@owner:test' },
      { id: '$linh', timestamp: 6, kind: 'joined', userId: '@linh:test', name: 'Linh (old profile)' },
      { id: '$bao', timestamp: 20, kind: 'departed', userId: '@bao:test', name: 'Bảo' }
    ]
  })

  const confirmed = {
    roomType: MATRIX_COMPANY_CHANNEL_TYPE,
    companyChannel: { companyId: 'company-a', channelId: '00000000-0000-4000-8000-676a3a34ff0f' }
  }

  const open = async (state: MatrixSnapshot) => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)

    const { emit, view } = fixture(
      undefined,
      'en',
      undefined,
      vi.fn(async () => null),
      undefined,
      companyWorkspaceWithChannel('!launch:test')
    )

    await screen.findByRole('button', { name: 'Continue with Google' })
    emit(state)
    await screen.findByRole('textbox', { name: COMPOSER })

    return view
  }

  it("draw who joined and who is no longer in between the channel's messages, named as the chat names people", async () => {
    const view = await open(snapshotWith(confirmed))
    const lines = [...view.container.querySelectorAll<HTMLElement>('[data-matrix-membership-line]')]

    expect(lines.map(value => value.textContent)).toEqual([
      'You joined the channel',
      // The room still knows Linh: the chat names them as it does everywhere else.
      'Linh joined the channel',
      // Bảo has left the member list; the name that event gave is what is left to say.
      'Bảo is no longer in this channel'
    ])

    // By time: the two joins before the message, the departure after it. They are lines, not messages.
    const message = view.container.querySelector('[data-matrix-message-id="$hello"]')!
    expect(lines[1]!.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(message.compareDocumentPosition(lines[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(view.container.querySelectorAll('[data-matrix-message-id]')).toHaveLength(1)
  })

  it('draw none in a room the platform did not confirm as a channel, however the room itself claims', async () => {
    // Main publishes a room's own unconfirmed claim as an ordinary room (no type, no binding).
    const view = await open(snapshotWith({}))

    expect(view.container.querySelector('[data-matrix-message-id="$hello"]')).toBeTruthy()
    expect(view.container.querySelectorAll('[data-matrix-membership-line]')).toHaveLength(0)
  })
})

afterEach(() => {
  cleanup()

  if (originalScrollIntoView) {
    Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView)
  } else {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  }

  resetAllBindings()
  $assistantNameOverrides.set({})
  setMatrixDriveTaskScope(null, null)
  $outgoingEchoes.set([])
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'atumMatrix')
  Reflect.deleteProperty(window, 'atumDesktopServices')
  $matrixDesktopServices.set(null)
})

function fixture(
  snapshot: () => Promise<MatrixSnapshot> = async () => signedOut,
  locale: 'en' | 'vi' | 'ja' | 'zh' | 'zh-hant' = 'en',
  pages?: MatrixPagesBridge,
  command: MatrixUiBridge['command'] = vi.fn(async () => null),
  drive?: MatrixDriveBridge,
  companies?: MatrixCompanyBridge,
  agentSources?: NonNullable<MatrixUiBridge['agentSources']>,
  bridgeOverrides: Partial<MatrixUiBridge> = {},
  cloudOnly = true
) {
  // MatrixApp owns its language scope. Fixtures must supply the same authority
  // as production: machine-local presentation while signed out, account-data
  // projection once signed in (never an overriding outer i18n provider).
  window.localStorage.setItem('io.atum.desktop.language', locale)

  const projectLocale = (state: MatrixSnapshot): MatrixSnapshot =>
    state.identity
      ? {
          ...state,
          // Current native hosts publish an authoritative roster with a ready session.
          // Individual startup tests override this when exercising loading or failure.
          agentRoster:
            state.agentRoster ??
            (state.state === 'ready' ? { state: 'ready', since: state.readiness?.since ?? 0 } : undefined),
          agents: state.agents?.map(agent =>
            agent.readiness || !agent.ready || agent.hermes !== 'ready'
              ? agent
              : { ...agent, readiness: { phase: 'ready', since: state.readiness?.since ?? 0 } }
          ),
          // The native SDK publishes one shortcut projection for every catalog app. An absent
          // account-data preference becomes the server-approved default only after the SDK is
          // ready; startup remains unknown/loading and therefore cannot guess a roster default.
          appShortcuts:
            state.appShortcuts ??
            (state.apps
              ? Object.fromEntries(
                  state.apps.apps.map(app => [
                    app.app_id,
                    state.state === 'ready'
                      ? { visibility: 'default' as const, status: 'ready' as const }
                      : { visibility: 'unknown' as const, status: 'loading' as const }
                  ])
                )
              : undefined),
          displayPreferences: {
            appearance: { value: 'system', writable: state.state === 'ready' },
            textSize: { value: 100, writable: state.state === 'ready' },
            ...state.displayPreferences,
            language: state.displayPreferences?.language ?? { value: locale, writable: state.state === 'ready' }
          }
        }
      : state

  let listener: ((state: MatrixSnapshot) => void) | undefined

  const unsubscribe = vi.fn(() => {
    listener = undefined
  })

  let firstRunSources = {
    macs: [],
    gates: { google: false, folders: false, messages: false, browser: false, location: false, team_spaces: false },
    sources: [
      { kind: 'google.mail', optOutGate: 'google', availability: 'unavailable' as const, status: 'ready' as const, grantable: true },
      { kind: 'mac.files', optOutGate: 'folders', availability: 'unavailable' as const, status: 'ready' as const, grantable: true },
      { kind: 'mac.message-metadata', optOutGate: 'messages', availability: 'unavailable' as const, status: 'ready' as const, grantable: true },
      { kind: 'mac.browser-history', optOutGate: 'browser', availability: 'unavailable' as const, status: 'ready' as const, grantable: true },
      { kind: 'mac.location', optOutGate: 'location', availability: 'unavailable' as const, status: 'unavailable' as const, grantable: false },
      { kind: 'matrix.owner-rooms', optOutGate: 'team_spaces', availability: 'unavailable' as const, status: 'ready' as const, grantable: true }
    ]
  }

  const defaultAgentSources = {
    read: vi.fn(async () => firstRunSources),
    set: vi.fn(async (gate: keyof typeof firstRunSources.gates, enabled: boolean) => {
      firstRunSources = { ...firstRunSources, gates: { ...firstRunSources.gates, [gate]: enabled } }

      return firstRunSources
    })
  }

  const bridge: MatrixUiBridge = {
    pages,
    drive,
    companies,
    agentSources: agentSources ?? defaultAgentSources,
    windowFacts: vi.fn(async () => ({
      platform: 'darwin',
      isFullscreen: false,
      windowButtonPosition: { x: 12, y: 13 },
      overlayWidth: 0
    })),
    subscribeWindow: vi.fn(() => vi.fn()),
    setWindowMode: vi.fn(async () => {}),
    setWindowAppearance: vi.fn(async () => {}),
    snapshot: async () => projectLocale(await snapshot()),
    signIn: vi.fn(async () => {}),
    repairOwnerDevice: vi.fn(async () => ({ state: 'repaired' as const })),
    cancelOwnerDeviceRepair: vi.fn(async () => {}),
    cancelSignIn: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    endDeviceSession: vi.fn(async () => {}),
    dismissNewSignIn: vi.fn(async () => {}),
    document: vi.fn(async () => {}),
    arrangeWord: vi.fn(async () => {}),
    previewDocument: vi.fn(async () => ({
      token: 'preview',
      name: 'notes.txt',
      kind: 'text' as const,
      text: 'saved preview bytes'
    })),
    closeDocumentPreview: vi.fn(async () => {}),
    pdf: { show: vi.fn(async () => ({ shown: true })), hide: vi.fn(async () => {}), close: vi.fn(async () => {}) },
    readDomain: vi.fn(async () => ({ issuer: 'https://id.test/', subject: 'alice', principal: 'principal' })),
    cancelDomain: vi.fn(async () => {}),
    enrollment: vi.fn(async () => ({ state: 'absent' as const, identity: null })),
    enrollHermes: vi.fn(async () => ({ state: 'ready' as const, identity: null })),
    setupAssistant: vi.fn(async () => {}),
    revokeHermes: vi.fn(async () => ({ state: 'absent' as const, identity: null })),
    connectHermes: vi.fn(async () => {}),
    invokeHermes: vi.fn(async () => ({ state: 'cancelled' as const })),
    sendAssistant: vi.fn(async () => ({ eventId: '$sent', result: { state: 'published' as const } })),
    recoverHermes: vi.fn(async () => ({ state: 'unknown' as const })),
    sendTurn: vi.fn(async () => ({ turnId: '00000000-0000-4000-8000-11e594f48195' })),
    retryTurn: vi.fn(async () => ({ turnId: '00000000-0000-4000-8000-e79acd97ac88' })),
    retryReadiness: vi.fn(async () => {}),
    openTopUp: vi.fn(async () => {}),
    openStorageSettings: vi.fn(async () => {}),
    cancelHermes: vi.fn(async () => {}),
    createAgent: vi.fn(async () => ({ principal: 'agent-principal', roomId: '!agent:test' })),
    importAgent: vi.fn(async () => ({ principal: 'imported-principal', roomId: '!imported:test' })),
    retireAgent: vi.fn(async () => ({ sessionCleanup: 'complete' as const })),
    listenHermes: vi.fn(async () => {}),
    setContinuousListening: vi.fn(async () => {}),
    stopListeningHermes: vi.fn(async () => {}),
    respondHermes: vi.fn(async () => {}),
    configureHermes: vi.fn(async () => ({ state: 'ready' as const })),
    command,
    openLink: vi.fn(async () => {}),
    subscribe: fn => {
      listener = fn

      return unsubscribe
    },
    ...bridgeOverrides
  }

  window.atumMatrix = bridge

  const view = render(<MatrixApp cloudOnly={cloudOnly} />)

  return { bridge, view, unsubscribe, emit: (state: MatrixSnapshot) => act(() => listener?.(projectLocale(state))) }
}

function legacyFixture(
  snapshot: () => Promise<MatrixSnapshot> = async () => signedOut,
  locale: 'en' | 'vi' | 'ja' | 'zh' | 'zh-hant' = 'en',
  pages?: MatrixPagesBridge,
  command: MatrixUiBridge['command'] = vi.fn(async () => null),
  drive?: MatrixDriveBridge,
  companies?: MatrixCompanyBridge,
  agentSources?: NonNullable<MatrixUiBridge['agentSources']>,
  bridgeOverrides: Partial<MatrixUiBridge> = {}
) {
  return fixture(snapshot, locale, pages, command, drive, companies, agentSources, bridgeOverrides, false)
}

describe('isolated Matrix composition', () => {
  // Acme is an app this client has no code for: the whole journey is the catalog's.
  it.each(['Moon', 'Andy', 'Acme'])('opens %s legacy setup from its default roster row before account linking', async name => {
    const f = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    const slug = name.toLowerCase()

    const app: AppDescriptor = {
      app: slug,
      app_id: '00000000-0000-4000-8000-11e594f48195',
      app_version_id: '00000000-0000-4000-8000-e79acd97ac88',
      name: { en: name },
      subtitle: null,
      description: null,
      icon: null,
      accent: null,
      affiliation: 'first_party',
      verified: true,
      verification: 'official',
      availability: 'available',
      roster_default: true,
      roster_order: 0,
      supported_modes: [],
      matrix_room_context: 'addressed_only',
      has_surface: true,
      has_history: name === 'Moon',
      link: { mode: 'external_account', state: 'never_linked' },
      bot: {
        v: 1,
        user_id: `@app-${slug}:atumplatform.com`,
        handle: `${slug}_bot`,
        display_name: name,
        avatar: { url: 'data:image/png;base64,cG9ydHJhaXQ=', sha256: 'a'.repeat(64) },
        device_generation: 1,
        device: { device_id: 'BOT_1', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
        state: 'active',
        groups: name === 'Moon',
        consent: 'required',
        disclosure_version: name === 'Moon' ? 2 : 1,
        open_route_id: 'chat',
        open_shared_memory: name === 'Moon',
        purchase_route_id: 'chat',
        transport_mode: 'legacy_turn'
      }
    }

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'OWNER' },
      domainEnabled: true,
      apps: { state: 'ready', apps: [app], connections: {} },
      rooms: [],
      roomId: null
    }

    let currentStatus = {
      profile: 'atum.app-bot-status/1',
      consent: { state: 'required', disclosure_version: name === 'Moon' ? 2 : 1 },
      link: { state: 'never_linked', ready: false, available: true }
    }

    const botStatus = vi.fn(async () => currentStatus)

    const consent = vi.fn(async () => {
        currentStatus = {
          profile: 'atum.app-bot-status/1',
          consent: { state: 'accepted', disclosure_version: name === 'Moon' ? 2 : 1 },
          link: { state: 'linked', ready: true, available: true }
        }

        return currentStatus
      }),
      connection = vi.fn(),
      botIntakeStatus = vi.fn(async () =>
        name === 'Moon'
          ? {
              complete: false,
              fields: [{ name: 'preferred_name', type: 'text', label: null, placeholder: null, options: [] }]
            }
          : { complete: true, fields: [] }
      ),
      botIntakeSubmit = vi.fn(async () => ({ complete: true, fields: [] })),
      send = vi.fn(async () => ({
        eventId: '$bot-request',
        result: { state: 'publication_pending' as const }
      }))

    let catalogApp = app

    const history = vi.fn(async () => ({
      profile: 'atum.app-history/1' as const,
      appId: app.app_id,
      appVersionId: app.app_version_id,
      entries: [
        {
          id: 'moon-web-1',
          revision: 1,
          occurredAt: Date.parse('2026-10-12T01:02:03Z'),
          role: 'owner' as const,
          source: { id: 'web', label: { en: 'Moon web', vi: 'Moon web' } },
          text: 'Earlier on Moon web'
        }
      ],
      nextCursor: null,
      hasMore: false,
      freshnessMs: 0
    }))

    const menu = vi.fn(async () => ({
      app: catalogApp,
      routes: [],
      actions:
        name === 'Moon'
          ? [
              {
                id: 'readings',
                label: { en: 'Readings', vi: 'Luận giải' },
                icon: 'book-2',
                session: 'required' as const
              }
            ]
          : []
    }))

    const appView = {
      open: vi.fn(async () => ({ viewId: 'app-view' })),
      setBounds: vi.fn(async () => ({ ok: true as const })),
      setVisibility: vi.fn(async () => ({ ok: true as const })),
      focus: vi.fn(async () => ({ ok: true as const })),
      reload: vi.fn(async () => ({ ok: true as const })),
      close: vi.fn(async () => ({ ok: true as const })),
      onState: vi.fn(() => vi.fn())
    }

    let finishOpening = () => {}

    const opening = new Promise<void>(resolve => {
      finishOpening = resolve
    })

    const chat = vi.fn(async () => {
      await opening
      f.emit({
        ...state,
        destination: { kind: 'room', roomId: '!bot:test' },
        roomId: '!bot:test',
        rooms: [
          {
            id: '!bot:test',
            name,
            membership: 'join',
            encrypted: true,
            direct: true,
            participants: [
              { userId: '@owner:test', membership: 'join' },
              { userId: app.bot!.user_id, membership: 'invite' }
            ]
          }
        ]
      })

      return '!bot:test'
    })

    let finishRefresh = () => {}

    const refresh = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finishRefresh = resolve
        })
    )

    f.bridge.apps = {
      chat,
      botStatus,
      botConsent: consent,
      botIntakeStatus,
      botIntakeSubmit,
      connection,
      refresh,
      send,
      history,
      menu,
      view: appView,
      onReturn: () => () => {}
    } as unknown as MatrixUiBridge['apps']
    f.emit(state)
    const row = await screen.findByRole('button', { name: new RegExp(`^${name}`) })
    expect(row.textContent).not.toContain('App')
    expect(row.querySelector('[data-app-catalog-avatar]')?.getAttribute('src')).toBe(app.bot!.avatar.url)
    fireEvent.click(row)
    await screen.findByText('Opening chat…')
    expect(row.getAttribute('aria-busy')).toBe('true')
    expect(row.hasAttribute('disabled')).toBe(true)
    fireEvent.click(row)
    expect(chat).toHaveBeenCalledOnce()
    await act(async () => {
      finishOpening()
    })
    await screen.findByText(`Chat with ${name} right here in Atum.`)
    await waitFor(() => expect(botStatus).toHaveBeenCalledWith(app.app_id))
    expect(chat).toHaveBeenCalledWith(app.app_id, 'en')
    expect(screen.queryByRole('group', { name: 'Send to' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Start chat' })).toBeTruthy()
    // One short line and one button, in the middle of the chat panel: no wall of text.
    const dialog = screen.getByRole('dialog', { name })
    expect(dialog.closest('[data-app-start-center]')?.parentElement?.hasAttribute('data-atum-chat')).toBe(true)
    expect(f.view.container.querySelectorAll('[data-app-bot-setup] li')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true)
    expect(consent).not.toHaveBeenCalled()
    expect(connection).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()

    // The full terms are one tap away, and reading them agrees to nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Learn more' }))
    const terms = await screen.findByRole('dialog')
    expect(terms.querySelectorAll('li')).toHaveLength(name === 'Moon' ? 7 : 6)
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).find(button => button.textContent === 'Close')!)
    await screen.findByRole('dialog', { name })
    expect(consent).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }))
    await waitFor(() => expect(consent).toHaveBeenCalledWith(app.app_id, name === 'Moon' ? 2 : 1, 'en'))
    await waitFor(() => expect(botIntakeStatus).toHaveBeenCalledWith(app.app_id))

    if (name === 'Moon') {
      fireEvent.change(await screen.findByLabelText('Preferred name'), { target: { value: 'Minh' } })
      fireEvent.click(screen.getByRole('button', { name: 'Start conversation' }))
      await waitFor(() => expect(botIntakeSubmit).toHaveBeenCalledWith(app.app_id, { preferred_name: 'Minh' }))
    } else {
      expect(screen.queryByRole('dialog', { name: /Finish setting up/ })).toBeNull()
      expect(botIntakeSubmit).not.toHaveBeenCalled()
    }

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true)
    await act(async () => {
      finishRefresh()
    })
    await waitFor(() => expect(f.view.container.querySelector('[data-app-bot-setup]')).toBeNull())
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true)
    catalogApp = {
      ...app,
      link: { ...app.link, state: 'linked' },
      bot: { ...app.bot!, consent: 'accepted' }
    }
    f.emit({
      ...state,
      destination: { kind: 'room', roomId: '!bot:test' },
      roomId: '!bot:test',
      apps: { state: 'ready', apps: [catalogApp], connections: {} },
      rooms: [
        {
          id: '!bot:test',
          name,
          membership: 'join',
          encrypted: true,
          direct: true,
          participants: [
            { userId: '@owner:test', membership: 'join' },
            { userId: app.bot!.user_id, membership: 'join' }
          ]
        }
      ]
    })

    if (name === 'Moon') {
      expect(await screen.findByText('Earlier on Moon web')).toBeTruthy()
      expect(screen.getByText(/Moon web ·/)).toBeTruthy()
      expect(history).toHaveBeenCalledWith(app.app_id, null)
      const plus = screen.getByRole('button', { name: 'App actions' })
      // jsdom delivers events to a disabled button; a browser does not. The attribute is the truth:
      // the bot is this chat's implicit recipient, and that must not grey out the "+" that opens its screens.
      expect(plus.hasAttribute('disabled')).toBe(false)
      fireEvent.pointerDown(plus, {
        button: 0,
        ctrlKey: false,
        pointerType: 'mouse'
      })
      expect(await screen.findByRole('menuitem', { name: 'Readings' })).toBeTruthy()
      // A message to an app is text only: no Attach in its menu.
      expect(screen.queryByRole('menuitem', { name: /attach/i })).toBeNull()
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Readings' }))
      await waitFor(() => expect(appView.open).toHaveBeenCalledWith({ app: 'moon', panelNavigation: true, route_id: 'readings' }))
      expect(f.view.container.querySelector('[data-atum-app-view-route="readings"]')).toBeTruthy()
    } else {
      expect(history).not.toHaveBeenCalled()
    }

    fireEvent.change(screen.getByRole('textbox', { name: COMPOSER }), { target: { value: `Hello ${name}` } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false))
    expect(connection).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith(app.app_id, '!bot:test', `Hello ${name}`, 'en'))
    fireEvent.click(screen.getByRole('button', { name: `Open ${name}` }))
    await waitFor(() => expect(f.view.container.querySelector(`[data-app-bot-panel="${slug}"]`)).toBeTruthy())
    expect(f.view.container.querySelectorAll('[data-app-bot-disclosure]')).toHaveLength(0)
  })

  // Quill is an app this client has no code for: the window opens its chat by the same steps as any app's.
  const quill = (): AppDescriptor => ({
    app: 'quill_desk',
    app_id: '00000000-0000-4000-8000-a499ea1345d3',
    app_version_id: '00000000-0000-4000-8000-b1428d1b7e2c',
    name: { en: 'Quill' },
    subtitle: null,
    description: null,
    icon: null,
    accent: null,
    affiliation: 'first_party',
    verified: true,
    verification: 'official',
    availability: 'available',
    roster_default: true,
    roster_order: 0,
    supported_modes: [],
    matrix_room_context: 'addressed_only',
    has_surface: false,
    link: { mode: 'external_account', state: 'never_linked' },
    bot: {
      v: 1,
      user_id: '@app-quill_desk:atumplatform.com',
      handle: 'quill_desk_bot',
      display_name: 'Quill',
      avatar: { url: 'data:image/png;base64,cG9ydHJhaXQ=', sha256: 'a'.repeat(64) },
      device_generation: 1,
      device: { device_id: 'BOT_1', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
      state: 'active',
      groups: false,
      consent: 'required',
      disclosure_version: 1,
      open_route_id: 'chat',
      open_shared_memory: false,
      purchase_route_id: 'chat'
    }
  })

  /** The bridge of a window whose only app is Quill; its first `chat` call fails as sync does not bring the room. */
  function quillWindow(f: ReturnType<typeof fixture>, app: AppDescriptor, state: MatrixSnapshot) {
    const chat = vi
      .fn<(appId: string, locale: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("Error invoking remote method 'matrix:ui': Error: matrix_app_bot_syncing"))
      .mockImplementationOnce(async () => {
        f.emit({
          ...state,
          destination: { kind: 'room', roomId: '!bot:test' },
          roomId: '!bot:test',
          rooms: [
            {
              id: '!bot:test',
              name: 'Quill',
              membership: 'join',
              encrypted: false,
              direct: true,
              participants: [
                { userId: '@owner:test', membership: 'join' },
                { userId: app.bot!.user_id, membership: 'join' }
              ]
            }
          ]
        })

        return '!bot:test'
      })

    f.bridge.apps = {
      chat,
      botStatus: vi.fn(async () => ({
        profile: 'atum.app-bot-status/1',
        consent: { state: 'required', disclosure_version: 1 },
        link: { state: 'never_linked', ready: false, available: true }
      })),
      history: vi.fn(async () => ({ entries: [], nextCursor: null, hasMore: false })),
      menu: vi.fn(async () => ({ app, routes: [], actions: [] })),
      onReturn: () => () => {}
    } as unknown as MatrixUiBridge['apps']

    return chat
  }

  const quillState = (app: AppDescriptor): MatrixSnapshot => ({
    ...signedOut,
    state: 'ready',
    identity: { userId: '@owner:test', deviceId: 'OWNER' },
    domainEnabled: true,
    apps: { state: 'ready', apps: [app], connections: {} },
    rooms: [],
    roomId: null
  })

  // The first click on an app's bot on a new account: its room can be made before sync has brought it, and
  // a chat that has not come must end in the failure band with a Retry, never in an empty window.
  it('says an app chat is taking long to open, offers Retry in the failure band, and opens it on Retry', async () => {
    const f = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const app = quill()
    const state = quillState(app)
    const chat = quillWindow(f, app, state)
    f.emit(state)

    const row = await screen.findByRole('button', { name: /^Quill/ })
    fireEvent.click(row)

    // The failure is said where failures are, by name, with its one action; the roster is usable again.
    const sentence = await screen.findByText('The chat with Quill is taking longer than usual to open. Try again.')
    const band = sentence.closest('[data-matrix-failure]')
    expect(band?.getAttribute('data-matrix-failure')).toBe('app_bot_syncing')
    expect(screen.queryByText('Opening chat…')).toBeNull()
    expect(row.hasAttribute('disabled')).toBe(false)
    // Nothing was selected, so the window is not left on a room it cannot draw.
    expect(screen.queryByText('Chat with Quill right here in Atum.')).toBeNull()

    const retry = within(band as HTMLElement).getByRole('button', { name: 'Retry' })
    fireEvent.click(retry)

    // Retry is the same pick: the row says the chat is opening again, and the failure is gone.
    expect(screen.queryByText('The chat with Quill is taking longer than usual to open. Try again.')).toBeNull()
    await screen.findByText('Chat with Quill right here in Atum.')
    expect(chat).toHaveBeenCalledTimes(2)
    expect(chat).toHaveBeenLastCalledWith(app.app_id, 'en')
    expect(f.view.container.querySelector('[data-matrix-failure]')).toBeNull()
  })

  // The Store card's Open is the same action. Its failure used to be a generic "Apps are unavailable" notice
  // that named no cause and had no way to try the same chat again.
  it('says the same, with the same Retry, when the chat is opened from its Store card', async () => {
    const f = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const app = quill()
    const state = { ...quillState(app), destination: { kind: 'discover' as const } }
    const chat = quillWindow(f, app, state)
    f.emit(state)

    const card = await waitFor(() => {
      const found = f.view.container.querySelector<HTMLElement>('[data-store-app]')
      expect(found).toBeTruthy()

      return found as HTMLElement
    })

    fireEvent.click(within(card).getByRole('button', { name: 'Open' }))

    const sentence = await screen.findByText('The chat with Quill is taking longer than usual to open. Try again.')
    const band = sentence.closest('[data-matrix-failure]')
    expect(band?.getAttribute('data-matrix-failure')).toBe('app_bot_syncing')
    // Not the page's catalog notice: this is a chat that was slow, not a catalog that is gone.
    expect(screen.queryByText('Apps are unavailable right now.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Refresh apps' })).toBeNull()
    expect(chat).toHaveBeenCalledTimes(1)

    // Retry opens the same app's chat again, from the failure band.
    fireEvent.click(within(band as HTMLElement).getByRole('button', { name: 'Retry' }))
    await screen.findByText('Chat with Quill right here in Atum.')
    expect(chat).toHaveBeenCalledTimes(2)
    expect(chat).toHaveBeenNthCalledWith(1, app.app_id, 'en')
    expect(chat).toHaveBeenNthCalledWith(2, app.app_id, 'en')
    expect(screen.queryByText('The chat with Quill is taking longer than usual to open. Try again.')).toBeNull()
    expect(f.view.container.querySelector('[data-matrix-failure]')).toBeNull()
  })

  it('talks to Moon in a group through ordinary @mentions and replies, without a bot recipient mode', async () => {
    const f = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const moon: AppDescriptor = {
      app: 'moon',
      app_id: '00000000-0000-4000-8000-11e594f48195',
      app_version_id: '00000000-0000-4000-8000-e79acd97ac88',
      name: { en: 'Moon' },
      subtitle: null,
      description: null,
      icon: null,
      accent: null,
      affiliation: 'first_party',
      verified: true,
      verification: 'official',
      availability: 'available',
      roster_default: true,
      roster_order: 0,
      supported_modes: [],
      matrix_room_context: 'addressed_only',
      has_surface: true,
      link: { mode: 'external_account', state: 'linked' },
      bot: {
        v: 1,
        user_id: '@app-moon:atumplatform.com',
        handle: 'moon_bot',
        display_name: 'Moon',
        avatar: { url: 'data:image/png;base64,cG9ydHJhaXQ=', sha256: 'a'.repeat(64) },
        device_generation: 1,
        device: { device_id: 'MOON_1', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
        state: 'active',
        groups: true,
        consent: 'accepted',
        disclosure_version: 1,
        open_route_id: 'chat',
        open_shared_memory: true,
        purchase_route_id: 'chat'
      }
    }

    const bot = moon.bot!

    const send = vi.fn(async () => ({
      eventId: '$moon-request',
      result: { state: 'publication_pending' as const }
    }))

    f.bridge.apps = { send, onReturn: () => () => {} } as unknown as MatrixUiBridge['apps']

    const room = {
      id: '!friends:test',
      name: 'Friends',
      membership: 'join' as const,
      encrypted: true,
      participants: [
        { userId: '@owner:test', membership: 'join' },
        { userId: bot.user_id, membership: 'join' },
        { userId: '@linh:test', membership: 'join' }
      ]
    }

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'OWNER' },
      apps: { state: 'ready', apps: [moon], connections: {} },
      rooms: [room],
      roomId: room.id,
      members: [
        { userId: '@owner:test', name: 'Owner', membership: 'join', canRemove: false },
        { userId: bot.user_id, name: 'Moon', membership: 'join', canRemove: false },
        { userId: '@linh:test', name: 'Linh', membership: 'join', canRemove: false }
      ],
      messages: []
    }

    f.emit(state)
    const composer = await screen.findByRole('textbox', { name: COMPOSER })
    expect(screen.queryByRole('group', { name: 'Send to' })).toBeNull()

    fireEvent.change(composer, { target: { value: 'Hello everyone' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(f.bridge.command).toHaveBeenCalledWith({ kind: 'send', roomId: room.id, body: 'Hello everyone' })
    )
    expect(send).not.toHaveBeenCalled()

    fireEvent.change(composer, { target: { value: '@Moon can you help?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith(moon.app_id, room.id, '@Moon can you help?', 'en'))

    const answer = {
      id: '$moon-answer',
      sender: bot.user_id,
      body: 'Of course.',
      timestamp: 2,
      own: false,
      encrypted: true,
      decryptionFailed: false,
      pending: false,
      failed: false,
      attachment: false,
      appBot: {
        appId: moon.app_id,
        kind: 'reply' as const,
        authenticated: true as const,
        turnId: '00000000-0000-4000-8000-993224b4fe85',
        part: 1,
        parts: 1
      }
    }

    f.emit({ ...state, messages: [answer] })
    await waitFor(() => expect(window.document.querySelector('[data-matrix-message-id="$moon-answer"]')).toBeTruthy())
    const message = window.document.querySelector<HTMLElement>('[data-matrix-message-id="$moon-answer"]')!
    fireEvent.click(within(message).getByRole('button', { name: 'Reply' }))
    await waitFor(() =>
      expect(window.document.querySelector('[data-matrix-composer-context="reply"]')?.textContent).toContain('Moon')
    )
    expect(await screen.findByText(/Moon will see this quoted message/)).toBeTruthy()
    fireEvent.change(composer, { target: { value: 'Tell me more' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(send).toHaveBeenLastCalledWith(moon.app_id, room.id, 'Tell me more', 'en', '$moon-answer', undefined)
    )

    const human = {
      ...answer,
      id: '$linh-question',
      sender: '@linh:test',
      body: 'Should I take the new role?',
      timestamp: 3,
      appBot: undefined
    }

    f.emit({ ...state, messages: [answer, human] })
    await waitFor(() => expect(window.document.querySelector('[data-matrix-message-id="$linh-question"]')).toBeTruthy())
    const humanMessage = window.document.querySelector<HTMLElement>('[data-matrix-message-id="$linh-question"]')!
    fireEvent.click(within(humanMessage).getByRole('button', { name: 'Reply' }))
    fireEvent.change(composer, { target: { value: '@Moon what do you think?' } })
    expect(await screen.findByText("Moon won't see the message you're replying to.")).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ask Moon about this' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(send).toHaveBeenLastCalledWith(
        moon.app_id,
        room.id,
        '@Moon what do you think?',
        'en',
        '$linh-question',
        undefined
      )
    )

    fireEvent.click(within(humanMessage).getByRole('button', { name: 'Reply' }))
    fireEvent.change(composer, { target: { value: '@Moon use this context' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Ask Moon about this' }))
    expect(await screen.findByText(/Moon will see this quoted message/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(send).toHaveBeenLastCalledWith(
        moon.app_id,
        room.id,
        '@Moon use this context',
        'en',
        '$linh-question',
        '$linh-question'
      )
    )

    const appSendCount = send.mock.calls.length
    const pausedMoon: AppDescriptor = { ...moon, bot: { ...bot, state: 'paused' } }
    f.emit({ ...state, apps: { state: 'ready', apps: [pausedMoon], connections: {} }, messages: [answer, human] })
    fireEvent.change(composer, { target: { value: '@Moon this stays a normal room message' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(f.bridge.command).toHaveBeenLastCalledWith({
        kind: 'send',
        roomId: room.id,
        body: '@Moon this stays a normal room message',
        mentions: [bot.user_id]
      })
    )
    expect(send).toHaveBeenCalledTimes(appSendCount)

    const andy: AppDescriptor = {
      ...moon,
      app: 'andy',
      app_id: '00000000-0000-4000-8000-85d027de6061',
      app_version_id: '00000000-0000-4000-8000-dd7df1164681',
      name: { en: 'Andy' },
      bot: {
        ...bot,
        user_id: '@app-andy:atumplatform.com',
        handle: 'andy_bot',
        display_name: 'Andy'
      }
    }

    const twoBotRoom = {
      ...room,
      participants: [...room.participants, { userId: andy.bot!.user_id, membership: 'join' as const }]
    }

    f.emit({
      ...state,
      apps: { state: 'ready', apps: [moon, andy], connections: {} },
      rooms: [twoBotRoom],
      members: [...state.members!, { userId: andy.bot!.user_id, name: 'Andy', membership: 'join', canRemove: false }],
      messages: [answer, human]
    })
    fireEvent.change(composer, { target: { value: '@Moon and @Andy compare notes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(f.bridge.command).toHaveBeenLastCalledWith({
        kind: 'send',
        roomId: room.id,
        body: '@Moon and @Andy compare notes',
        mentions: [bot.user_id, andy.bot!.user_id]
      })
    )
    expect(send).toHaveBeenCalledTimes(appSendCount)

    f.emit({ ...state, messages: [answer, human] })
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByLabelText('Attach file (up to 20 MB)'), { target: { files: [file] } })
    fireEvent.change(composer, { target: { value: '@Moon read the attached notes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(f.bridge.command).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'attach',
          roomId: room.id,
          name: 'notes.txt'
        })
      )
    )
    await waitFor(() =>
      expect(f.bridge.command).toHaveBeenLastCalledWith({
        kind: 'send',
        roomId: room.id,
        body: '@Moon read the attached notes',
        mentions: [bot.user_id]
      })
    )
    expect(send).toHaveBeenCalledTimes(appSendCount)

    const bea = {
      principal: 'bea-principal',
      userId: '@bea:test',
      name: 'Bea',
      isDefault: false,
      ready: true,
      hermes: 'ready' as const,
      atumModel: true
    }

    f.emit({
      ...state,
      agents: [bea],
      rooms: [
        {
          ...room,
          participants: [...room.participants, { userId: bea.userId, membership: 'join' as const }]
        }
      ],
      messages: [answer, human]
    })
    expect(screen.queryByRole('group', { name: 'Send to' })).toBeNull()
    fireEvent.change(composer, { target: { value: '@Bea help plan' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(f.bridge.command).toHaveBeenLastCalledWith({
        kind: 'send',
        roomId: room.id,
        body: '@Bea help plan',
        mentions: [bea.userId]
      })
    )
    expect(send).toHaveBeenCalledTimes(appSendCount)
  })

  // Preserve the recovery and user-visible behavior covered by this path.
  it('names Moon when a message to it is refused, and keeps the words in the box', async () => {
    const f = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const moon: AppDescriptor = {
      app: 'moon',
      app_id: '00000000-0000-4000-8000-11e594f48195',
      app_version_id: '00000000-0000-4000-8000-e79acd97ac88',
      name: { en: 'Moon' },
      subtitle: null,
      description: null,
      icon: null,
      accent: null,
      affiliation: 'first_party',
      verified: true,
      verification: 'official',
      availability: 'available',
      roster_default: true,
      roster_order: 0,
      supported_modes: [],
      matrix_room_context: 'addressed_only',
      has_surface: true,
      link: { mode: 'external_account', state: 'linked' },
      bot: {
        v: 1,
        user_id: '@app-moon:atumplatform.com',
        handle: 'moon_bot',
        display_name: 'Moon',
        avatar: { url: 'data:image/png;base64,cG9ydHJhaXQ=', sha256: 'a'.repeat(64) },
        device_generation: 1,
        device: { device_id: 'MOON_1', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
        state: 'active',
        groups: true,
        consent: 'accepted',
        disclosure_version: 1,
        open_route_id: 'chat',
        open_shared_memory: true,
        purchase_route_id: 'chat'
      }
    }

    const bot = moon.bot!

    const send = vi.fn(async () => {
      throw new Error("Error invoking remote method 'matrix:ui': Error: matrix_app_bot_starting")
    })

    f.bridge.apps = { send, onReturn: () => () => {} } as unknown as MatrixUiBridge['apps']

    const room = {
      id: '!friends:test',
      name: 'Friends',
      membership: 'join' as const,
      encrypted: true,
      participants: [
        { userId: '@owner:test', membership: 'join' },
        { userId: bot.user_id, membership: 'join' },
        { userId: '@linh:test', membership: 'join' }
      ]
    }

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'OWNER' },
      apps: { state: 'ready', apps: [moon], connections: {} },
      rooms: [room],
      roomId: room.id,
      members: [
        { userId: '@owner:test', name: 'Owner', membership: 'join', canRemove: false },
        { userId: bot.user_id, name: 'Moon', membership: 'join', canRemove: false },
        { userId: '@linh:test', name: 'Linh', membership: 'join', canRemove: false }
      ],
      messages: []
    }

    f.emit(state)
    const composer = await screen.findByRole('textbox', { name: COMPOSER })
    fireEvent.change(composer, { target: { value: '@Moon can you help?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith(moon.app_id, room.id, '@Moon can you help?', 'en'))
    await waitFor(() => expect(window.document.querySelector('[data-matrix-failure]')?.textContent).toContain('Moon is starting up'))
    expect(screen.queryByText('This assistant isn’t available right now. Try again in a moment.')).toBeNull()
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe('@Moon can you help?'))
  })

  it('uses signed Bot API mode before the first reply, then trusts reply metadata for rendering', async () => {
    const f = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const moon: AppDescriptor = {
      app: 'moon',
      app_id: '00000000-0000-4000-8000-11e594f48195',
      app_version_id: '00000000-0000-4000-8000-e79acd97ac88',
      name: { en: 'Moon' },
      subtitle: null,
      description: null,
      icon: null,
      accent: null,
      affiliation: 'first_party',
      verified: true,
      verification: 'official',
      availability: 'available',
      roster_default: true,
      roster_order: 0,
      supported_modes: [],
      matrix_room_context: 'addressed_only',
      has_surface: true,
      link: { mode: 'external_account', state: 'never_linked' },
      bot: {
        v: 1,
        user_id: '@app-moon:atumplatform.com',
        handle: 'moon_bot',
        display_name: 'Moon',
        avatar: { url: 'data:image/png;base64,cG9ydHJhaXQ=', sha256: 'a'.repeat(64) },
        device_generation: 1,
        device: { device_id: 'MOON_1', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
        state: 'active',
        groups: false,
        consent: 'required',
        disclosure_version: 1,
        open_route_id: 'chat',
        open_shared_memory: true,
        purchase_route_id: 'chat',
        transport_mode: 'bot_api'
      }
    }

    const room: MatrixRoom = {
      id: '!moon:test',
      name: 'Moon',
      membership: 'join',
      encrypted: false,
      direct: true,
      participants: [
        { userId: '@owner:test', membership: 'join' },
        { userId: moon.bot!.user_id, membership: 'join' }
      ]
    }

    const botMessage: MatrixSnapshot['messages'][number] = {
      id: '$moon-answer',
      sender: moon.bot!.user_id,
      body: 'Sign in to continue',
      timestamp: 1,
      own: false,
      encrypted: false,
      decryptionFailed: false,
      pending: false,
      failed: false,
      attachment: false,
      botApi: {
        version: 'io.atum.bot_api/1',
        botId: '00000000-0000-4000-8000-f6222a1106ee',
        publicMessageId: 43,
        fallbackText: 'Sign in to continue',
        formattedBody: 'Sign in to <strong>continue</strong>',
        keyboard: [[{ label: 'Sign in', kind: 'url', url: 'https://moon.example/sign-in#continue' }]]
      }
    }

    const legacySend = vi.fn(async () => ({
      eventId: '$legacy-turn',
      result: { state: 'publication_pending' as const }
    }))

    const appOpen = vi.fn(async () => ({ viewId: 'native-moon' }))

    const appMenu: MatrixAppMenu = {
      app: moon,
      routes: [
        { id: 'chat', label: { en: 'Chat', vi: 'Trò chuyện' }, icon: 'chat', session: 'required' },
        { id: 'readings', label: { en: 'Readings', vi: 'Luận giải' }, icon: 'sparkles', session: 'required' }
      ],
      actions: [{ id: 'readings', label: { en: 'Readings', vi: 'Luận giải' }, icon: 'sparkles', session: 'required' }]
    }

    f.bridge.apps = {
      menu: vi.fn(async () => appMenu),
      send: legacySend,
      onReturn: () => () => {},
      view: {
        open: appOpen,
        close: vi.fn(async () => ({ ok: true as const })),
        setVisibility: vi.fn(async () => ({ ok: true as const })),
        setBounds: vi.fn(async () => ({ ok: true as const })),
        focus: vi.fn(async () => ({ ok: true as const })),
        reload: vi.fn(async () => ({ ok: true as const })),
        onState: () => () => {}
      }
    } as unknown as MatrixUiBridge['apps']

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'OWNER' },
      apps: { state: 'ready', apps: [moon], connections: {} },
      rooms: [room],
      roomId: room.id,
      members: [
        { userId: '@owner:test', name: 'Owner', membership: 'join', canRemove: false },
        { userId: moon.bot!.user_id, name: moon.bot!.user_id, membership: 'join', canRemove: false }
      ],
      messages: [],
      typing: []
    }

    f.emit(state)

    expect(screen.queryByText('continue')).toBeNull()
    expect(f.view.container.querySelector('[data-app-bot-setup]')).toBeNull()

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'App actions' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse'
    })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Readings' }))
    await waitFor(() => expect(appOpen).toHaveBeenCalledWith({ app: 'moon', panelNavigation: true, route_id: 'readings' }))

    const composer = await screen.findByRole('textbox', { name: COMPOSER })
    fireEvent.change(composer, { target: { value: 'Hello Moon' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(f.bridge.command).toHaveBeenCalledWith({ kind: 'send', roomId: room.id, body: 'Hello Moon' })
    )
    expect(legacySend).not.toHaveBeenCalled()

    const encryptedRoom = { ...room, encrypted: true }
    const encryptedBotMessage = { ...botMessage, encrypted: true }

    f.emit({ ...state, rooms: [encryptedRoom], messages: [encryptedBotMessage], typing: [moon.bot!.user_id] })
    await waitFor(() => expect(f.view.container.querySelector('[data-matrix-bot-api-keyboard]')).toBeNull())

    f.emit({
      ...state,
      rooms: [encryptedRoom],
      messages: [
        {
          ...encryptedBotMessage,
          appBot: { appId: moon.app_id, kind: 'bot_api', authenticated: true }
        }
      ],
      typing: [moon.bot!.user_id]
    })
    expect(await screen.findByText('continue')).toBeTruthy()
    expect(screen.getByText('Moon is typing…')).toBeTruthy()
    expect(f.view.container.querySelectorAll('[data-matrix-bot-api-keyboard-row]')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(f.bridge.openLink).toHaveBeenCalledWith('https://moon.example/sign-in#continue')
  })

  describe("an official bot's row says why its chat did not open", () => {
    const moon = (bot: Partial<NonNullable<AppDescriptor['bot']>> = {}): AppDescriptor => ({
      app: 'moon',
      app_id: '00000000-0000-4000-8000-11e594f48195',
      app_version_id: '00000000-0000-4000-8000-e79acd97ac88',
      name: { en: 'Moon' },
      subtitle: null,
      description: null,
      icon: null,
      accent: null,
      affiliation: 'first_party',
      verified: true,
      verification: 'official',
      availability: 'available',
      roster_default: true,
      roster_order: 0,
      supported_modes: ['shared_group'],
      // Production's operator setting (`atum.turn-room/2`): no per-person room context.
      matrix_room_context: null,
      has_surface: true,
      link: { mode: 'external_account', state: 'never_linked' },
      bot: {
        v: 1,
        user_id: '@app-moon:atumplatform.com',
        handle: 'moon_bot',
        display_name: 'Moon',
        avatar: { url: 'data:image/png;base64,cG9ydHJhaXQ=', sha256: 'a'.repeat(64) },
        device_generation: 1,
        device: { device_id: 'BOT_1', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
        state: 'active',
        groups: true,
        consent: 'required',
        disclosure_version: 1,
        open_route_id: 'chat',
        open_shared_memory: true,
        purchase_route_id: 'chat',
        ...bot
      }
    })

    const ready = (app: AppDescriptor): MatrixSnapshot => ({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'OWNER' },
      domainEnabled: true,
      apps: { state: 'ready', apps: [app], connections: {} },
      rooms: [],
      roomId: null
    })

    it.each([
      ['matrix_app_bot_paused', 'Moon is paused for now. Try again later.'],
      ['matrix_app_bot_starting', 'Moon is starting up. Try again in a few minutes.'],
      ['matrix_app_bot_untrusted', "Moon can't be reached safely right now."],
      ['matrix_app_bot_changed', 'Moon was just updated. Try again.']
    ])('names Moon when main refuses with %s, never "that didn\'t work"', async (code, sentence) => {
      const f = fixture()
      await screen.findByRole('button', { name: 'Continue with Google' })

      const chat = vi.fn(async () => {
        throw new Error(`Error invoking remote method 'matrix:ui': Error: ${code}`)
      })

      f.bridge.apps = { chat, onReturn: () => () => {} } as unknown as MatrixUiBridge['apps']
      f.emit(ready(moon()))
      fireEvent.click(await screen.findByRole('button', { name: /^Moon/ }))
      await screen.findByText(sentence)
      expect(chat).toHaveBeenCalledWith('00000000-0000-4000-8000-11e594f48195', 'en')
      expect(screen.queryByText('That didn’t work. Try again.')).toBeNull()
    })

    it('shows a starting bot as starting, and does not offer to open it yet', async () => {
      const f = fixture()
      await screen.findByRole('button', { name: 'Continue with Google' })
      const chat = vi.fn()
      f.bridge.apps = { chat, onReturn: () => () => {} } as unknown as MatrixUiBridge['apps']
      f.emit(ready(moon({ state: 'starting', device: null })))
      // Like a chat row: the name is the bot's, and its state is the line it is described by.
      const row = await screen.findByRole('button', { name: 'Moon' })
      const described = row.getAttribute('aria-describedby')?.split(' ') ?? []
      expect(described.map(id => window.document.getElementById(id)?.textContent)).toContain('Starting up')
      expect(row.hasAttribute('disabled')).toBe(true)
      fireEvent.click(row)
      expect(chat).not.toHaveBeenCalled()
    })
  })

  it('opens the Matrix palette from shared shortcuts and hands focus to Settings', async () => {
    const { bridge } = fixture(async () => ({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' }
    }))

    const account = await screen.findByRole('button', { name: 'Account: owner' })
    act(() => account.focus())
    fireEvent.keyDown(account, { key: 'k', code: 'KeyK', metaKey: true })
    const palette = await screen.findByRole('dialog', { name: 'Command palette' })
    fireEvent.click(within(palette).getByRole('option', { name: /Settings/ }))
    const settings = await screen.findByRole('dialog', { name: 'Account' })
    await waitFor(() => expect(settings.contains(window.document.activeElement)).toBe(true))
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull()
    // The Account page lists your devices (Atum Kit Settings), so its one read is the device list.
    expect(vi.mocked(bridge.command).mock.calls).toEqual([[{ kind: 'devices', userId: '@owner:test' }]])
    expect(bridge.signIn).not.toHaveBeenCalled()
  })

  it('uses live shared bindings rather than keeping the old hardcoded Settings chord', async () => {
    setBinding('nav.settings', ['mod+shift+s'])
    fixture(async () => ({ ...signedOut, state: 'ready', identity: { userId: '@owner:test', deviceId: 'D' } }))
    await screen.findByRole('button', { name: 'Account: owner' })
    fireEvent.keyDown(window, { key: ',', code: 'Comma', metaKey: true })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.keyDown(window, { key: 'S', code: 'KeyS', metaKey: true, shiftKey: true })
    expect(await screen.findByRole('dialog', { name: 'Account' })).toBeTruthy()
    expect($bindings.get()['nav.settings']).toEqual(['mod+shift+s'])
  })

  it.each([false, true])('moves palette search focus into the real roster (compact=%s)', async compact => {
    vi.stubGlobal('innerWidth', compact ? 700 : 1220)
    fixture(async () => ({ ...signedOut, state: 'ready', identity: { userId: '@owner:test', deviceId: 'D' } }))
    await screen.findByRole('button', { name: 'Account: owner' })
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true })
    const palette = await screen.findByRole('dialog', { name: 'Command palette' })
    fireEvent.click(within(palette).getByRole('option', { name: /Search everything/ }))
    await waitFor(() =>
      expect(window.document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search everything' }))
    )
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull()
  })

  it('restores palette opener focus, but one Escape keeps the expanded workspace open', async () => {
    fixture(async () => ({ ...signedOut, state: 'ready', identity: { userId: '@owner:test', deviceId: 'D' } }))
    const account = await screen.findByRole('button', { name: 'Account: owner' })
    fireEvent.keyDown(window, { key: 'j', code: 'KeyJ', metaKey: true })
    await screen.findByRole('button', { name: 'Expand' })
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
    act(() => account.focus())
    fireEvent.keyDown(account, { key: 'k', code: 'KeyK', metaKey: true })
    const palette = await screen.findByRole('dialog', { name: 'Command palette' })
    fireEvent.keyDown(palette, { key: 'Escape', code: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull())
    expect(window.document.querySelector('[data-atum-workspace-over-frame]')).toBeTruthy()
    await waitFor(() => expect(window.document.activeElement).toBe(account))
  })

  it('returns focus to the account control when a keyboard-opened palette had no focused opener', async () => {
    fixture(async () => ({ ...signedOut, state: 'ready', identity: { userId: '@owner:test', deviceId: 'D' } }))
    const account = await screen.findByRole('button', { name: 'Account: owner' })
    expect(window.document.activeElement).toBe(window.document.body)
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true })
    fireEvent.keyDown(await screen.findByRole('dialog', { name: 'Command palette' }), { key: 'Escape', code: 'Escape' })
    await waitFor(() => expect(window.document.activeElement).toBe(account))
  })

  it('lets the roster toggle close its own compact drawer without admitting a palette behind it', async () => {
    vi.stubGlobal('innerWidth', 700)
    fixture(async () => ({ ...signedOut, state: 'ready', identity: { userId: '@owner:test', deviceId: 'D' } }))
    await screen.findByRole('button', { name: 'Account: owner' })
    fireEvent.keyDown(window, { key: 'b', code: 'KeyB', metaKey: true })
    const drawer = await screen.findByRole('dialog', { name: 'Chats' })
    fireEvent.keyDown(drawer, { key: 'k', code: 'KeyK', metaKey: true })
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull()
    fireEvent.keyDown(drawer, { key: 'b', code: 'KeyB', metaKey: true })
    expect(screen.queryByRole('dialog', { name: 'Chats' })).toBeNull()
  })

  it.each(['switch', 'sign-out'] as const)('retires an open palette on %s', async transition => {
    const ready: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@first:test', deviceId: 'FIRST' }
    }

    const { emit } = fixture(async () => ready)
    await screen.findByRole('button', { name: 'Account: first' })
    fireEvent.keyDown(window, { key: 'p', code: 'KeyP', metaKey: true })
    await screen.findByRole('dialog', { name: 'Command palette' })
    emit(transition === 'sign-out' ? signedOut : { ...ready, identity: { userId: '@second:test', deviceId: 'SECOND' } })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull())
    expect($appViewOverlayCount.get()).toBe(0)
  })

  it('does not open the palette behind startup, signed-out, or covering dialogs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { emit } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true })
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull()
    emit({ ...signedOut, state: 'connecting', identity: { userId: '@owner:test', deviceId: 'D' } })
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true })
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull()
    emit({ ...signedOut, state: 'ready', identity: { userId: '@owner:test', deviceId: 'D' } })
    await passLaunch()
    await waitFor(() =>
      expect(window.document.querySelector('[data-matrix-shell-layer]')?.hasAttribute('inert')).toBe(false)
    )
    fireEvent.keyDown(window, { key: ',', code: 'Comma', metaKey: true })
    await screen.findByRole('dialog', { name: 'Account' })
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true })
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull()
  })

  it('mounts voice only for the selected eligible assistant and routes dictation to that room', async () => {
    const { bridge, emit } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const settings = vi.fn(async () => ({
      sttEnabled: false,
      sttProvider: 'local',
      ttsProvider: 'edge',
      maxRecordingSeconds: 120
    }))

    const microphone = vi.fn(async () => true)
    bridge.voice = {
      settings,
      microphone,
      transcribe: vi.fn(async () => 'draft'),
      speak: vi.fn(async () => ({ data_url: 'data:audio/wav;base64,AQID', mime_type: 'audio/wav' }))
    }
    const state = promotedMainSnapshot()
    state.roomId = '!main:test'
    state.messages = [
      {
        id: '$reply',
        sender: '@main:test',
        body: 'A complete reply',
        timestamp: 1000,
        own: false,
        encrypted: true,
        decryptionFailed: false,
        pending: false,
        failed: false,
        attachment: false
      }
    ]
    emit(state)
    const voice = await screen.findByRole('button', { name: /dictation/i })
    // Read aloud is an item in the answer's "…" menu, not a button of its own.
    expect(screen.queryByRole('button', { name: /read aloud/i })).toBeNull()
    const answerMenu = window.document.querySelector<HTMLElement>('[data-matrix-answer-menu]')!
    fireEvent.keyDown(answerMenu, { key: 'Enter' })
    expect(screen.getByRole('menuitem', { name: /read aloud/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: /read aloud/i }))
    await waitFor(() => expect(bridge.voice!.speak).toHaveBeenCalledWith('!main:test', 'A complete reply'))
    fireEvent.click(voice)
    await waitFor(() => expect(settings).toHaveBeenCalledExactlyOnceWith('!main:test'))
    expect(microphone).not.toHaveBeenCalled()
    expect(bridge.sendTurn).not.toHaveBeenCalled()
    emit({ ...state, roomId: '!human:test', messages: [] })
    await waitFor(() => expect(screen.queryByRole('button', { name: /dictation/i })).toBeNull())
    expect(window.document.querySelector('[data-matrix-answer-menu]')).toBeNull()
  })

  it('uses the actual account language projection rather than the signed-out machine choice', async () => {
    const { emit, bridge } = fixture(undefined, 'en')
    await screen.findByRole('button', { name: 'Continue with Google' })
    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'D' },
      displayPreferences: {
        appearance: { value: 'system', writable: true },
        textSize: { value: 100, writable: true },
        language: { value: 'ja', writable: true }
      }
    })
    await waitFor(() => expect(window.document.documentElement.lang).toBe('ja'))
    expect(window.localStorage.getItem('io.atum.desktop.language')).toBe('en')
    expect(bridge.command).not.toHaveBeenCalled()
    emit(signedOut)
    await screen.findByRole('button', { name: 'Continue with Google' })
    expect(window.document.documentElement.lang).toBe('en')
  })
  it("hands the glass back to the OS when the account's appearance leaves with sign-out", async () => {
    const { emit, bridge } = fixture(undefined, 'en')
    await screen.findByRole('button', { name: 'Continue with Google' })
    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'D' },
      displayPreferences: {
        appearance: { value: 'dark', writable: true },
        textSize: { value: 100, writable: true }
      }
    })
    await waitFor(() => expect(bridge.setWindowAppearance).toHaveBeenLastCalledWith('dark'))
    emit(signedOut)
    await waitFor(() => expect(bridge.setWindowAppearance).toHaveBeenLastCalledWith('system'))
  })
  it('keeps reporting out of sign-in and available in Help, with staged updates on the persistent rail', async () => {
    const status: MatrixDesktopServicesStatus = {
      reporting: { configured: true, diagnosticId: 'assembly-diagnostic', enabled: true },
      update: {
        channel: 'latest',
        progress: null,
        notes: [],
        error: null,
        requiredBelow: null,
        armed: true,
        checkedAt: null,
        packaged: true,
        state: 'downloaded',
        version: '1.0.1'
      },
      version: '1.0.0',
      busy: false
    }

    const services = {
      ready: vi.fn(),
      active: vi.fn(),
      status: vi.fn(async () => status),
      onChanged: vi.fn(() => vi.fn()),
      setEnabled: vi.fn(async (enabled: boolean) => ({ ...status, reporting: { ...status.reporting, enabled } })),
      feedback: vi.fn(async () => ({ sent: true })),
      setUpdateChannel: vi.fn(async () => true),
      checkUpdates: vi.fn(async () => true),
      restart: vi.fn(async () => true),
      error: vi.fn()
    } satisfies MatrixDesktopServicesBridge

    window.atumDesktopServices = services
    $matrixDesktopServices.set(status)
    const { emit } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    // Before sign-in: only the approved ways in, legal copy and language. Reporting,
    // updates and feedback wait in Settings › Help.
    const auth = window.document.querySelector<HTMLElement>('[data-atum-auth]')!
    expect(auth.querySelector('details')).toBeNull()
    expect(within(auth).queryByRole('button', { name: 'Check for updates' })).toBeNull()
    expect(within(auth).queryByRole('textbox')).toBeNull()
    expect(within(auth).queryByRole('switch')).toBeNull()
    expect(services.ready).toHaveBeenCalledOnce()

    emit({ ...signedOut, state: 'ready', identity: { userId: '@owner:test', deviceId: 'D' } })
    await screen.findByRole('button', { name: 'Account: owner' })
    expect(services.ready).toHaveBeenCalledOnce()
    expect(window.document.querySelector('[data-matrix-account-settings]')).toBeNull()
    fireEvent.click(window.document.querySelector('[data-atum-roster] [data-atum-sidebar-toggle]')!)
    const update = screen.getByRole('button', { name: 'Update ready — restart to install' })
    expect(update.closest('[data-matrix-rail-foot]')).toBeTruthy()
    fireEvent.click(update)
    expect(await screen.findByText('Atum 1.0.1 is ready. Restart now?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
    await waitFor(() => expect(services.restart).toHaveBeenCalledOnce())
    fireEvent.keyDown(window.document.activeElement ?? window.document.body, { key: 'Escape' })

    openAccountSettings()
    showSettingsPane('help')
    const general = screen.getByRole('dialog', { name: 'Help' })
    fireEvent.click(within(general).getByRole('switch', { name: 'Share usage data' }))
    await waitFor(() => expect(services.setEnabled).toHaveBeenCalledWith(false))
    expect(within(general).getByRole('button', { name: 'Restart to update' })).toBeTruthy()

    // Feedback has a sheet of its own: Settings steps aside, and a closed draft is gone.
    fireEvent.click(within(general).getByRole('button', { name: 'Send feedback…' }))
    const sheet = await screen.findByRole('dialog', { name: 'Send feedback' })
    expect(screen.queryByRole('dialog', { name: 'Help' })).toBeNull()
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Send feedback' }), {
      target: { value: 'draft feedback' }
    })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Send feedback' })).toBeNull())
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Account: owner' }), { button: 0 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Send feedback…' }))
    const again = await screen.findByRole('dialog', { name: 'Send feedback' })
    expect((within(again).getByRole('textbox', { name: 'Send feedback' }) as HTMLTextAreaElement).value).toBe('')
  })

  it.each(['switch', 'sign-out'])(
    'opens the one phone sheet from the account menu and clears it on %s',
    async transition => {
      const ready: MatrixSnapshot = {
        ...signedOut,
        state: 'ready',
        homeserver: 'https://chat.example.test',
        identity: { userId: '@first:test', deviceId: 'FIRST' }
      }

      const { bridge, emit } = fixture(async () => ready)
      // One home: the account menu. No rail icon.
      await screen.findByRole('button', { name: 'Account: first' })
      expect(window.document.querySelector('[data-matrix-mobile-rail]')).toBeNull()
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Account: first' }), { button: 0 })
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Use on phone' }))
      const sheet = await screen.findByRole('dialog', { name: 'Use on phone' })
      expect(within(sheet).queryByText('@first:test')).toBeNull()
      expect($appViewOverlayCount.get()).toBeGreaterThan(0)
      fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Account: first' }), { button: 0 })
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Use on phone' }))
      expect(await screen.findByRole('dialog', { name: 'Use on phone' })).toBeTruthy()
      emit(transition === 'switch' ? { ...ready, identity: { userId: '@second:test', deviceId: 'SECOND' } } : signedOut)
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect($appViewOverlayCount.get()).toBe(0)
      expect(bridge.signIn).not.toHaveBeenCalled()
      expect(bridge.openLink).not.toHaveBeenCalled()
      expect(bridge.endDeviceSession).not.toHaveBeenCalled()

      if (transition === 'sign-out') {
        expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Use on phone' })).toBeNull()
      }
    }
  )

  // Preserve user-visible identity, state and recovery behavior across connection changes.
  // content and pushed the side panel down. It is the title bar's attention item now: nothing in
  // the page's status stack, nothing in the chat card's flow; its line opens from the bell.
  it('says a new sign-in in the title bar’s indicator, never in the page’s flow', async () => {
    const ready: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      newSignIn: { deviceId: 'PHONE', name: 'Atum for iPhone on Unknown device' }
    }

    const { bridge } = fixture(async () => ready)

    const pill = await screen.findByRole('button', { name: 'Needs you: New sign-in on an iPhone' })
    const stack = window.document.querySelector('[data-matrix-status-stack]')
    expect(stack?.childElementCount ?? 0).toBe(0)
    expect(window.document.querySelector('[data-matrix-new-sign-in]')).toBeNull()
    expect(screen.queryByText(/Unknown device/)).toBeNull()

    fireEvent.pointerDown(pill, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(pill)

    const line = await screen.findByText('Was this you?')
    expect(line.closest('[data-atum-chat]')).toBeNull()
    expect(line.closest('[data-matrix-attention-list]')).toBeTruthy()
    expect(stack?.childElementCount ?? 0).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'Sign it out' }))
    await waitFor(() => expect(bridge.endDeviceSession).toHaveBeenCalledExactlyOnceWith('PHONE'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'It was me' }).hasAttribute('disabled')).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'It was me' }))
    await waitFor(() => expect(bridge.dismissNewSignIn).toHaveBeenCalledWith('PHONE'))
  })

  it('keeps the new sign-in and says why in its popover when the sign-out page cannot open', async () => {
    const ready: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      newSignIn: { deviceId: 'LAPTOP', name: 'MacBook Air' }
    }

    const { bridge } = fixture(async () => ready)
    vi.mocked(bridge.endDeviceSession).mockRejectedValueOnce(new Error('matrix_offline'))

    const pill = await screen.findByRole('button', { name: 'Needs you: New sign-in on MacBook Air' })
    fireEvent.pointerDown(pill, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(pill)
    fireEvent.click(await screen.findByRole('button', { name: 'Sign it out' }))

    expect(await screen.findByText('Couldn’t open the sign-out page. Try again.')).toBeTruthy()
    expect(screen.getByText('New sign-in on MacBook Air')).toBeTruthy()
    expect(screen.getByText('Was this you?')).toBeTruthy()
  })

  it('never exposes phone setup in the signed-out shell', async () => {
    const { view } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    expect(view.container.querySelector('[data-matrix-mobile-rail]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Use on phone' })).toBeNull()
  })

  it.each([false, true])('restores keyboard focus after Account opens phone setup (compact=%s)', async compact => {
    vi.stubGlobal('innerWidth', compact ? 700 : 1220)
    fixture(async () => ({ ...signedOut, state: 'ready', identity: { userId: '@owner:test', deviceId: 'DEVICE' } }))
    await screen.findByRole('button', { name: compact ? 'Show sidebar' : 'Hide sidebar' })

    const account = screen.getByRole('button', { name: 'Account: owner' })
    fireEvent.pointerDown(account, { button: 0 })
    const accountOpener = await screen.findByRole('menuitem', { name: 'Use on phone' })
    fireEvent.click(accountOpener)
    const sheet = await screen.findByRole('dialog', { name: 'Use on phone' })
    await within(sheet).findByRole('img')
    fireEvent.keyDown(sheet, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // The menu item is gone by then: focus goes back to the account itself.
    await waitFor(() => expect(window.document.activeElement).toBe(account))
  })

  it.each(['done', 'cancelled'] as const)('unobstructs Workplace after verification is %s', async state => {
    const pages: MatrixPagesBridge = {
      open: vi.fn(async () => ({ viewId: 'verification-page' })),
      setBounds: vi.fn(async () => ({ ok: true as const })),
      setVisibility: vi.fn(async () => ({ ok: true as const })),
      focus: vi.fn(async () => ({ ok: true as const })),
      close: vi.fn(async () => ({ ok: true as const })),
      onState: vi.fn(() => vi.fn())
    }

    const ready: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      companyWorkspaceEnabled: true,
      agents: [
        {
          principal: 'agent-1',
          userId: '@agent:test',
          name: 'Assistant',
          isDefault: true,
          ready: true,
          hermes: 'ready',
          atumModel: true
        }
      ],
      security: {
        recovery: 'ready',
        verification: {
          id: 'verified-peer',
          userId: '@agent:test',
          deviceId: 'AGENT',
          incoming: false,
          state: 'compare'
        }
      }
    }

    const { emit } = fixture(
      async () => ({ ...ready, security: { recovery: 'ready' } }),
      'en',
      pages,
      undefined,
      undefined,
      companyWorkspace()
    )

    await screen.findByRole('button', { name: 'Account: owner' })
    openScheduledPage()
    emit(ready)
    await waitFor(() =>
      expect(pages.setVisibility).toHaveBeenLastCalledWith({
        viewId: 'verification-page',
        visible: false,
        overlayActive: true
      })
    )
    emit({ ...ready, security: { ...ready.security!, verification: { ...ready.security!.verification!, state } } })
    await waitFor(() =>
      expect(pages.setVisibility).toHaveBeenLastCalledWith({
        viewId: 'verification-page',
        visible: true,
        overlayActive: false
      })
    )
  })

  const controlsState: MatrixSnapshot = {
    ...signedOut,
    state: 'ready',
    identity: { userId: '@owner:test', deviceId: 'DEVICE' },
    assistant: { userId: '@atum:test', deviceId: 'ATUM' },
    domainEnabled: true,
    hermes: 'ready',
    roomId: '!assistant:test',
    rooms: [
      { ...assistantFields, id: '!assistant:test', name: 'Atum', membership: 'join', encrypted: true, assistant: true }
    ],
    messages: [
      {
        id: '$request',
        sender: '@owner:test',
        body: 'Existing request',
        timestamp: 1,
        own: true,
        encrypted: true,
        decryptionFailed: false,
        pending: false,
        failed: false,
        attachment: false
      }
    ]
  }

  const localRuntimeSettingsFixture = () =>
    fixture(undefined, 'en', undefined, undefined, undefined, undefined, undefined, {}, false)

  /** Settings is a sheet off the account at the rail's foot (or ⌘,); it stays mounted while closed. */
  function settingsSheet() {
    return window.document.querySelector<HTMLElement>('[data-matrix-settings]')!
  }

  function openAccountSettings() {
    fireEvent.keyDown(window, { key: ',', code: 'Comma', metaKey: true })
    expect(settingsSheet().hidden).toBe(false)
  }

  function closeAccountSettings() {
    fireEvent.keyDown(window.document, { key: 'Escape' })
    expect(settingsSheet().hidden).toBe(true)
  }

  function showSettingsPane(pane: 'account' | 'general' | 'privacy' | 'cloud' | 'assistant' | 'advanced' | 'help') {
    // Atum Kit Settings folds Privacy into Account and This Mac into What Atum knows: open the page.
    const destination = settingsPageOf(normalizeMatrixSettingsPane(pane))
    fireEvent.click(settingsSheet().querySelector(`[data-matrix-settings-pane="${destination}"]`)!)
  }

  function openAssistantSetup() {
    openAccountSettings()
    showSettingsPane('assistant')
  }

  function openScheduledPage() {
    openAccountSettings()
    showSettingsPane('advanced')
    const advanced = within(settingsSheet()).getByRole('dialog', { name: 'Advanced' })
    const expertTools = within(advanced).getByText('For developers')
    const details = expertTools.closest('details')

    if (details && !details.open) {
      fireEvent.click(expertTools)
      fireEvent(details, new Event('toggle'))
    }

    fireEvent.click(within(advanced).getByRole('button', { name: /^Scheduled tasks/ }))
  }

  it('keeps Mac access in source rows and your devices beside the recovery key', async () => {
    const { emit } = fixture()
    emit(controlsState)
    openAccountSettings()
    showSettingsPane('cloud')
    expect(within(settingsSheet()).queryByRole('heading', { name: 'This Mac', level: 3 })).toBeNull()
    expect(settingsSheet().querySelector('[data-matrix-cloud-device-settings]')).toBeNull()
    expect(within(settingsSheet()).queryByRole('heading', { name: 'Your devices', level: 3 })).toBeNull()
    showSettingsPane('privacy')
    expect(within(settingsSheet()).getByRole('heading', { name: 'Your devices', level: 3 })).toBeTruthy()
    expect(settingsSheet().querySelector('[data-matrix-cloud-device-settings]')).toBeNull()
  })

  it('offers no Stop for a cloud chat that is not answering, or for its notices', async () => {
    const { emit, bridge } = fixture()
    const cloudAgent = vi.fn(async () => ({ state: 'stop_requested' as const }))
    bridge.cloudAgent = cloudAgent as unknown as MatrixUiBridge['cloudAgent']
    const sentAt = Date.now()

    const notice = {
      ...controlsState.messages[0]!,
      id: '$resume',
      own: false,
      notice: true,
      sender: '@atum:test',
      body: 'Resuming',
      timestamp: sentAt + 1,
      cloudStatus: { code: 'resuming_on_device', stopEvent: '$atum-occurrence-00000000-0000-4000-8000-11e594f48195' }
    }

    const cloud: MatrixSnapshot = {
      ...controlsState,
      rooms: controlsState.rooms.map(each => ({ ...each, agentPrincipal: 'cloud-t' })),
      messages: controlsState.messages.map(message => ({ ...message, timestamp: sentAt })),
      agents: [
        {
          principal: 'cloud-t',
          userId: '@atum:test',
          ready: false,
          isDefault: false,
          atumModel: true,
          hermes: 'unavailable',
          answering: 'cloud'
        }
      ]
    }

    emit(cloud)
    expect(await screen.findByText(controlsState.messages[0]!.body)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    emit({ ...cloud, messages: [...cloud.messages, notice] })
    expect(await screen.findByText('Resuming')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    // The window reads the account's access fact; it never stops or resumes a turn by itself.
    expect(cloudAgent).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'stopTurn' }))
  })

  it('shows a failed cloud turn as Atum system status, and keeps other notices’ own words', async () => {
    const { emit } = fixture()
    const sentAt = Date.now()

    const notice = (id: string, body: string, code: string, offset: number) => ({
      ...controlsState.messages[0]!,
      id,
      own: false,
      notice: true,
      sender: '@atum:test',
      body,
      timestamp: sentAt + offset,
      cloudStatus: { code }
    })

    emit({
      ...controlsState,
      rooms: controlsState.rooms.map(each => ({ ...each, agentPrincipal: 'cloud-t' })),
      messages: [
        ...controlsState.messages.map(message => ({ ...message, timestamp: sentAt })),
        notice('$resume', 'Resuming on Studio', 'resuming_on_device', 1),
        notice('$failed', 'controller fallback', 'failed', 2)
      ],
      agents: [{ principal: 'cloud-t', userId: '@atum:test', ready: true, isDefault: false, atumModel: true, hermes: 'unavailable', answering: 'cloud' }]
    })

    expect(await screen.findByText('Atum couldn’t complete this request. Please try again.')).toBeTruthy()
    expect(screen.queryByText('controller fallback')).toBeNull()
    expect(screen.getByText('Resuming on Studio')).toBeTruthy()
  })

  it('renders an 80% heads-up already in a chat with its own words, as before', async () => {
    const { emit } = fixture()
    const sentAt = Date.now()
    const heads = 'I’m close to today’s usage limit. I’ll keep going as usual; this is just a heads-up.'

    emit({
      ...controlsState,
      rooms: controlsState.rooms.map(each => ({ ...each, agentPrincipal: 'cloud-t' })),
      messages: [
        ...controlsState.messages.map(message => ({ ...message, timestamp: sentAt })),
        {
          ...controlsState.messages[0]!,
          id: '$heads-up',
          own: false,
          notice: true,
          sender: '@atum:test',
          body: heads,
          timestamp: sentAt + 1,
          cloudStatus: { code: 'daily_cap_warning' as const }
        }
      ],
      agents: [{ principal: 'cloud-t', userId: '@atum:test', ready: true, isDefault: false, atumModel: true, hermes: 'unavailable', answering: 'cloud' }]
    })

    expect(await screen.findByText(heads)).toBeTruthy()
  })

  it.each([false, true])('uses the cloud Atum destination when a standby Mac has stale local ChatGPT auth (moved: %s)', async moved => {
    const planSignIn = {
      phase: 'blocked' as const,
      step: 'assistant' as const,
      code: 'plan_sign_in',
      since: 1
    }

    const cloud: MatrixSnapshot = {
      ...controlsState,
      readiness: planSignIn,
      rooms: controlsState.rooms.map(each => ({ ...each, agentPrincipal: 'cloud-t' })),
      agents: [
        {
          principal: 'cloud-t',
          userId: '@atum:test',
          ready: false,
          isDefault: true,
          atumModel: true,
          localModel: { provider: 'openai-codex', model: 'gpt-5.6-luna' },
          hermes: 'unavailable',
          answering: 'cloud',
          macRole: 'standby',
          readiness: planSignIn,
          ...(moved ? { home: { lives: { kind: 'cloud' as const }, move: null, targets: [], issue: null } } : {})
        }
      ]
    }

    const { bridge } = fixture(async () => cloud)

    await waitFor(() => expect(window.document.querySelector('[data-slot="matrix-startup"]')).toBeNull(), LAUNCH_OPENS)
    const composer = await screen.findByRole('textbox', { name: COMPOSER })
    fireEvent.change(composer, { target: { value: 'Answer in the cloud' } })
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(bridge.sendAssistant).toHaveBeenCalledWith('!assistant:test', 'Answer in the cloud', 'en'))
    expect(bridge.sendTurn).not.toHaveBeenCalled()
    expect(await screen.findByText('Answer in the cloud')).toBeTruthy()
    expect(window.document.querySelector('[data-matrix-launch-notice]')).toBeNull()
  })

  it('stops a running cloud reply with the owner event the turn answers', async () => {
    const { emit, bridge } = fixture()
    const cloudAgent = vi.fn(async () => ({ state: 'stop_requested' as const }))
    bridge.cloudAgent = cloudAgent as unknown as MatrixUiBridge['cloudAgent']

    const question = {
      ...controlsState.messages[0]!,
      id: '$cloud-ask',
      body: 'Plan the trip',
      timestamp: Date.now()
    }

    emit({
      ...controlsState,
      rooms: controlsState.rooms.map(each => ({ ...each, agentPrincipal: 'cloud-t' })),
      messages: [question],
      typing: ['@atum:test'],
      agents: [
        {
          principal: 'cloud-t',
          userId: '@atum:test',
          ready: false,
          isDefault: false,
          atumModel: true,
          hermes: 'unavailable',
          answering: 'cloud'
        }
      ]
    })

    expect(await screen.findByText('Plan the trip')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    await waitFor(() =>
      expect(cloudAgent).toHaveBeenCalledWith({ action: 'stopTurn', roomId: '!assistant:test', eventId: '$cloud-ask' })
    )
  })

  it('says plainly when a cloud Stop is refused, and leaves the chat usable', async () => {
    const { emit, bridge } = fixture()

    const cloudAgent = vi.fn(async () => {
      throw new Error('matrix_cloud_stop_unconfirmed')
    })

    bridge.cloudAgent = cloudAgent as unknown as MatrixUiBridge['cloudAgent']

    const question = {
      ...controlsState.messages[0]!,
      id: '$cloud-ask',
      body: 'Plan the trip',
      timestamp: Date.now()
    }

    emit({
      ...controlsState,
      rooms: controlsState.rooms.map(each => ({ ...each, agentPrincipal: 'cloud-t' })),
      messages: [question],
      typing: ['@atum:test'],
      agents: [
        {
          principal: 'cloud-t',
          userId: '@atum:test',
          ready: false,
          isDefault: false,
          atumModel: true,
          hermes: 'unavailable',
          answering: 'cloud'
        }
      ]
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    expect(await screen.findByText("Couldn't stop this reply. It may have already finished.")).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
  })

  it('keeps the cloud Stop through a long turn after the typing signal expires, and lets it go when the answer lands', async () => {
    const { emit, bridge } = fixture()
    const cloudAgent = vi.fn(async () => ({ state: 'stop_requested' as const }))
    bridge.cloudAgent = cloudAgent as unknown as MatrixUiBridge['cloudAgent']
    const sentAt = Date.now()

    const question = {
      ...controlsState.messages[0]!,
      id: '$cloud-ask',
      body: 'Plan the trip',
      timestamp: sentAt
    }

    const cloud: MatrixSnapshot = {
      ...controlsState,
      rooms: controlsState.rooms.map(each => ({ ...each, agentPrincipal: 'cloud-t' })),
      messages: [question],
      typing: ['@atum:test'],
      agents: [
        {
          principal: 'cloud-t',
          userId: '@atum:test',
          ready: false,
          isDefault: false,
          atumModel: true,
          hermes: 'unavailable',
          answering: 'cloud'
        }
      ]
    }

    emit(cloud)
    expect(await screen.findByText('Plan the trip')).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeTruthy()

    // The cloud is still working long after the typing signal timed out (it expires in ~30s).
    emit({ ...cloud, typing: [] })
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()

    emit({
      ...cloud,
      typing: [],
      messages: [
        question,
        {
          ...question,
          id: '$cloud-answer',
          sender: '@atum:test',
          own: false,
          body: 'Here is the plan.',
          timestamp: sentAt + 1
        }
      ]
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull())
  })

  it('holds the cloud Stop disabled past the request until its target clears, then re-enables for the next one', async () => {
    const { emit, bridge } = fixture()

    let settleStop: (value: { state: 'stop_requested' }) => void = () => {}

    const cloudAgent = vi.fn(
      () =>
        new Promise<{ state: 'stop_requested' }>(resolve => {
          settleStop = resolve
        })
    )

    bridge.cloudAgent = cloudAgent as unknown as MatrixUiBridge['cloudAgent']
    const sentAt = Date.now()

    const question = {
      ...controlsState.messages[0]!,
      id: '$cloud-ask',
      body: 'Plan the trip',
      timestamp: sentAt
    }

    const cloud: MatrixSnapshot = {
      ...controlsState,
      rooms: controlsState.rooms.map(each => ({ ...each, agentPrincipal: 'cloud-t' })),
      messages: [question],
      typing: ['@atum:test'],
      agents: [
        {
          principal: 'cloud-t',
          userId: '@atum:test',
          ready: false,
          isDefault: false,
          atumModel: true,
          hermes: 'unavailable',
          answering: 'cloud'
        }
      ]
    }

    emit(cloud)
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    await waitFor(() =>
      expect(cloudAgent).toHaveBeenCalledWith({ action: 'stopTurn', roomId: '!assistant:test', eventId: '$cloud-ask' })
    )

    // The request resolved, but the agent has not confirmed the turn stopped: it keeps saying
    // Stopping, never stopped, and waits out the snapshot.
    await act(async () => settleStop({ state: 'stop_requested' }))
    expect(screen.getByRole('button', { name: 'Stopping…' }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByText(/stopped/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Stopping…' }))

    // Only Stop requests count: the access band also reads cloud status through this bridge.
    const stopCalls = () =>
      (cloudAgent.mock.calls as unknown[][]).filter(
        ([arg]) => (arg as { action?: string } | undefined)?.action === 'stopTurn'
      )

    expect(stopCalls()).toHaveLength(1)

    const answer = {
      ...question,
      id: '$cloud-answer',
      sender: '@atum:test',
      own: false,
      body: 'Here is the plan.',
      timestamp: sentAt + 1
    }

    const next = {
      ...question,
      id: '$cloud-next',
      body: 'Now book it',
      timestamp: sentAt + 2
    }

    emit({ ...cloud, messages: [question, answer] })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull())
    expect(screen.queryByRole('button', { name: 'Stopping…' })).toBeNull()

    emit({ ...cloud, messages: [question, answer, next] })
    const again = await screen.findByRole('button', { name: 'Stop' })
    expect(again.hasAttribute('disabled')).toBe(false)
    fireEvent.click(again)
    await waitFor(() =>
      expect(stopCalls().at(-1)?.[0]).toEqual({ action: 'stopTurn', roomId: '!assistant:test', eventId: '$cloud-next' })
    )
  })

  it('shows the no-reply banner without depending on the service-status read, then hides it for typing or a reply', async () => {
    const { emit, bridge } = fixture()
    const principal = '00000000-0000-4000-8000-11e594f48195'
    const readStatus = vi.fn(async () => Promise.reject(new Error('shell unavailable')))
    bridge.cloudAgent = readStatus as unknown as MatrixUiBridge['cloudAgent']

    const cloud: MatrixSnapshot = {
      ...controlsState,
      rooms: controlsState.rooms.map(each => ({ ...each, agentPrincipal: principal })),
      messages: controlsState.messages.map(message => ({ ...message, timestamp: Date.now() - 3 * 60_000 - 1 })),
      agents: [
        {
          principal,
          userId: '@atum:test',
          name: 'Atum',
          ready: false,
          isDefault: true,
          atumModel: true,
          hermes: 'unavailable',
          answering: 'cloud'
        }
      ]
    }

    emit(cloud)
    expect(
      await screen.findByText("Atum hasn't been able to answer yet. Atum will answer as soon as it can.")
    ).toBeTruthy()
    expect(readStatus).toHaveBeenCalledWith({ action: 'serviceStatus', principal })

    emit({ ...cloud, typing: ['@atum:test'] })
    await waitFor(() => expect(window.document.querySelector('[data-matrix-no-reply]')).toBeNull())

    emit({
      ...cloud,
      messages: [
        ...cloud.messages,
        {
          ...cloud.messages[0]!,
          id: '$answer',
          sender: '@atum:test',
          body: 'I am here.',
          timestamp: Date.now(),
          own: false
        }
      ]
    })
    await waitFor(() => expect(window.document.querySelector('[data-matrix-no-reply]')).toBeNull())
  })

  it('never says where a cloud assistant answers and offers only its canonical photo action (vi)', async () => {
    const { emit, bridge } = fixture(undefined, 'vi')
    bridge.cloudAgent = vi.fn(async () => ({
      state: 'stop_requested' as const
    })) as unknown as MatrixUiBridge['cloudAgent']
    bridge.profiles = { open: vi.fn(), change: vi.fn() } as unknown as MatrixUiBridge['profiles']

    const read = vi.fn(async (principal: string) => ({
      ok: true as const,
      card: {
        principal,
        displayName: 'Mây',
        isDefault: false,
        soul: '# Mây\n\n## What you do\n\nLo lịch họp.',
        inherited: false,
        skills: [],
        definitionRevision: 1,
        identityRevision: 1
      }
    }))

    bridge.assistants = { read, save: vi.fn() } as unknown as MatrixUiBridge['assistants']

    const cloud: MatrixSnapshot = {
      ...controlsState,
      rooms: controlsState.rooms.map(each => ({ ...each, name: 'Mây', agentPrincipal: 'cloud-t' })),
      messages: [
        ...controlsState.messages,
        {
          ...controlsState.messages[0]!,
          id: '$cloud-question',
          body: 'Mai họp mấy giờ?',
          timestamp: 2,
          turn: '00000000-0000-4000-8000-31f949766961'
        }
      ],
      agents: [
        {
          principal: 'cloud-t',
          userId: '@atum:test',
          name: 'Mây',
          ready: false,
          isDefault: false,
          atumModel: true,
          hermes: 'unavailable',
          answering: 'cloud'
        }
      ],
      localTurns: [
        {
          turnId: '00000000-0000-4000-8000-31f949766961',
          roomId: '!assistant:test',
          text: 'Mai họp mấy giờ?',
          createdAt: 2,
          state: 'handed_off',
          route: 'cloud',
          synced: { question: true, answer: false }
        }
      ]
    }

    const LOCATION = /đám mây|Mac này|Trả lời trên/i
    emit(cloud)
    expect(await screen.findByText('Mai họp mấy giờ?')).toBeTruthy()
    const chat = window.document.querySelector<HTMLElement>('[data-atum-chat]')!
    expect(chat.textContent).not.toMatch(LOCATION)
    // While the cloud answers, Mây is typing, as in any messaging app, and Stop names its question.
    expect(within(chat).getByRole('status', { name: 'Mây đang soạn tin…' })).toBeTruthy()
    expect(within(chat).getByRole('button', { name: 'Dừng' })).toBeTruthy()

    act(() => openAssistantCard({ kind: 'agent', principal: 'cloud-t' }))
    await waitFor(() => expect(read).toHaveBeenCalledWith('cloud-t'))

    const card = await waitFor(() => {
      const found = window.document.querySelector<HTMLElement>('[data-assistant-card]')
      expect(found?.textContent).toContain('Lo lịch họp.')

      return found!
    })

    // U1: the one read-only "Lives on" row every card shows says it; nothing else on the card does.
    const outsidePlace = card.cloneNode(true) as HTMLElement
    outsidePlace.querySelectorAll('[data-assistant-card-place], [data-assistant-card-home]').forEach(row => row.remove())
    expect(outsidePlace.textContent).not.toMatch(LOCATION)
    expect(card.querySelector('[data-assistant-card-answer-where], [data-agent-move]')).toBeNull()
    // Canonical assistant photos are owner-authenticated platform state, so editing one does
    // not require the cloud agent to expose a live Matrix profile host on this Mac.
    expect(card.querySelector('[data-assistant-card-avatar]')).not.toBeNull()
    expect(card.querySelector('[data-assistant-card-setup]')).toBeNull()
    expect(card.querySelector('[data-agent-advanced]')).toBeNull()
    act(() => $assistantCard.set(null))

    openAccountSettings()
    showSettingsPane('cloud')
    expect(within(settingsSheet()).queryByRole('heading', { name: 'Máy Mac này', level: 3 })).toBeNull()
    expect(settingsSheet().querySelector('[data-matrix-cloud-device-settings]')).toBeNull()
    // The chat asked only the account's access fact; nothing was stopped, moved or enrolled
    // on the person's behalf from this screen.
    expect(bridge.cloudAgent).toHaveBeenCalledWith({ action: 'cloudAccess' })
    expect(bridge.cloudAgent).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'stopTurn' }))
  })

  function toggleDetails(label: string | RegExp) {
    const summary = screen.getByText(label, {
      selector: 'summary'
    })

    const details = summary.closest('details')!
    fireEvent.click(summary)
    fireEvent(details, new Event('toggle'))
  }

  function openAtumAccount() {
    openAssistantSetup()
    toggleDetails('Technical details')
  }

  /** Reply settings: the conversation menu's first item in an assistant's chat. */
  function openAssistantOptions(locale: 'en' | 'vi' | 'zh' | 'zh-hant' | 'ja' = 'en') {
    const chat = matrixChatCopy(locale)
    fireEvent.keyDown(screen.getByRole('button', { name: chat.conversationOptions }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('menuitem', { name: chat.replySettings }))
  }

  it('hides Reply settings from an assistant conversation under cloud-only', async () => {
    const { emit } = fixture(undefined, 'en', undefined, undefined, undefined, undefined, undefined, {}, true)
    emit(controlsState)

    fireEvent.keyDown(screen.getByRole('button', { name: 'Conversation options' }), { key: 'Enter' })
    expect(screen.queryByRole('menuitem', { name: 'Reply settings…' })).toBeNull()
  })

  /** Your own message's menu (Copy, Edit and resend, Retry, Find the answer). */
  function openMessageActions(index = 0) {
    const triggers = [...window.document.querySelectorAll<HTMLButtonElement>('[data-matrix-message-actions]')]
    expect(triggers[index]).toBeTruthy()

    if (triggers[index]!.getAttribute('aria-expanded') !== 'true') {
      fireEvent.keyDown(triggers[index]!, { key: 'Enter' })
    }
  }

  it('keeps every assistant page in Settings › Advanced, each a side trip that returns to Settings', async () => {
    const pages: MatrixPagesBridge = {
      open: vi.fn(async ({ page }) => ({ viewId: `${page}-page` })),
      setBounds: vi.fn(async () => ({ ok: true as const })),
      setVisibility: vi.fn(async () => ({ ok: true as const })),
      focus: vi.fn(async () => ({ ok: true as const })),
      close: vi.fn(async () => ({ ok: true as const })),
      onState: vi.fn(() => vi.fn())
    }

    const agents: MatrixAgentView[] = [
      {
        principal: 'default-agent',
        userId: '@atum:test',
        name: 'Atum',
        isDefault: true,
        ready: true,
        hermes: 'ready',
        atumModel: true
      },
      {
        principal: 'research-agent',
        userId: '@research:test',
        name: 'Research',
        isDefault: false,
        ready: true,
        hermes: 'ready',
        atumModel: true
      }
    ]

    const { emit } = fixture(undefined, 'en', pages)
    emit({ ...controlsState, agents })
    await screen.findByRole('button', { name: 'Account: owner' })
    openAccountSettings()

    // Advanced is the last destination in the one fixed Settings navigation: one row a page,
    // each with one line of help.
    const nav = within(settingsSheet()).getByRole('navigation', { name: 'Settings' })

    const panes = [...nav.querySelectorAll('[data-matrix-settings-pane]')].map(row =>
      row.getAttribute('data-matrix-settings-pane')
    )

    expect(panes.at(-1)).toBe('advanced')
    fireEvent.click(within(nav).getByRole('button', { name: 'Advanced' }))
    const advanced = within(settingsSheet()).getByRole('dialog', { name: 'Advanced' })
    fireEvent.click(within(advanced).getByText('For developers'))

    for (const name of [
      'Scheduled tasks',
      'Files your assistant made',
      'Skills',
      'Model & Memory',
      'Providers',
      'Command center',
      'Star map',
      'MCP servers'
    ]) {
      expect(within(advanced).getByRole('button', { name: new RegExp(`^${name}`) })).toBeTruthy()
    }

    // A page opens in the window for the assistant chosen here; Settings steps aside.
    fireEvent.click(within(advanced).getByRole('combobox', { name: 'Assistants' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Research' }))
    fireEvent.click(within(advanced).getByRole('button', { name: /^Skills/ }))
    expect(settingsSheet().hidden).toBe(true)
    await waitFor(() =>
      expect(pages.open).toHaveBeenCalledWith(
        expect.objectContaining({ page: 'skills', agentPrincipal: 'research-agent' })
      )
    )
    expect(window.document.querySelector('[data-matrix-workplace-page="skills"]')).toBeTruthy()
    const rail = screen.getByRole('navigation', { name: 'Main navigation' })
    expect(within(rail).queryByRole('button', { name: 'Team space' })).toBeNull()

    // Back is Settings, on Advanced, and the page closes.
    fireEvent.click(screen.getByRole('button', { name: 'Back to Settings' }))
    await waitFor(() => expect(pages.close).toHaveBeenCalledWith('skills-page'))
    expect(window.document.querySelector('[data-matrix-workplace]')).toBeNull()
    expect(settingsSheet().hidden).toBe(false)
    expect(within(settingsSheet()).getByRole('dialog', { name: 'Advanced' })).toBeTruthy()

    // Settings can open another page over one already open: the new one, not the old.
    fireEvent.click(within(settingsSheet()).getByRole('button', { name: /^Scheduled tasks/ }))
    await waitFor(() => expect(pages.open).toHaveBeenCalledWith(expect.objectContaining({ page: 'scheduled' })))
    openAccountSettings()
    fireEvent.click(within(settingsSheet()).getByRole('button', { name: /^Providers/ }))
    await waitFor(() => expect(pages.open).toHaveBeenCalledWith(expect.objectContaining({ page: 'providers' })))
    await waitFor(() => expect(pages.close).toHaveBeenCalledWith('scheduled-page'))
    expect(window.document.querySelector('[data-matrix-workplace-page="providers"]')).toBeTruthy()
  })

  it('offers no assistant pages in Advanced when this Mac cannot open them', async () => {
    const { emit } = fixture()
    emit({ ...controlsState })
    await screen.findByRole('button', { name: 'Account: owner' })
    openAccountSettings()
    showSettingsPane('assistant')
    expect(within(settingsSheet()).getByRole('heading', { name: 'Advanced' })).toBeTruthy()
    expect(settingsSheet().querySelector('[data-matrix-advanced-pages]')).toBeNull()
    expect(within(settingsSheet()).queryByText('Not available yet')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Scheduled tasks/u })).toBeNull()
  })

  it('draws no Team space until there is a company workspace', async () => {
    const agents: MatrixAgentView[] = [
      {
        principal: 'default-agent',
        userId: '@atum:test',
        name: 'Atum',
        isDefault: true,
        ready: true,
        hermes: 'ready',
        atumModel: true
      }
    ]

    const rail = () => screen.getByRole('navigation', { name: 'Main navigation' })
    const { emit } = fixture(undefined, 'en', workplacePages())
    // An agent with pages is not a workplace: Team space is not on the rail at all, never drawn as
    // a disabled "Coming soon" and never entered, and Home stays the current one.
    emit({ ...controlsState, agents })
    expect(within(rail()).queryByRole('button', { name: 'Team space' })).toBeNull()
    expect(within(rail()).queryByRole('button', { name: /Coming soon|Team space/ })).toBeNull()
    expect(window.document.querySelector('[data-atum-nav-workplace]')).toBeNull()
    expect(within(rail()).getByRole('button', { name: 'Chats' }).getAttribute('aria-current')).toBe('page')
    expect(window.document.querySelector('[data-matrix-workplace]')).toBeNull()
    cleanup()
    Reflect.deleteProperty(window, 'atumMatrix')

    // A company workspace is the Team space the rail shows.
    const company = fixture(undefined, 'en', workplacePages(), undefined, undefined, companyWorkspace())
    company.emit({ ...controlsState, agents, companyWorkspaceEnabled: true })
    const stableRoster = window.document.querySelector<HTMLElement>('[data-atum-roster]')!
    const rosterSearch = within(stableRoster).getByRole('textbox', { name: 'Search everything' }) as HTMLInputElement
    fireEvent.change(rosterSearch, { target: { value: 'Atum' } })
    fireEvent.click(within(rail()).getByRole('button', { name: 'Team space' }))
    expect(within(rail()).getByRole('button', { name: 'Team space' }).getAttribute('aria-current')).toBe('page')
    expect(window.document.querySelector('[data-matrix-company-workspace]')).toBeTruthy()
    expect(window.document.querySelector('[data-matrix-company-sidebar]')).toBeTruthy()
    expect(window.document.querySelector('[data-matrix-workplace]')).toBeNull()
    expect(window.document.querySelector('[data-atum-roster]')).toBe(stableRoster)
    expect(stableRoster.closest('[data-atum-roster-slot]')?.hasAttribute('inert')).toBe(true)
    expect(rosterSearch.value).toBe('Atum')

    const companyRail = rail()
    fireEvent.keyDown(window, { key: 'n', code: 'KeyN', metaKey: true })
    expect(await screen.findByRole('dialog', { name: 'Start a chat' })).toBeTruthy()
    expect(companyRail.querySelector('[data-atum-nav-home]')?.getAttribute('aria-current')).toBe('page')
    expect(rosterSearch.value).toBe('Atum')
  })

  it('never paints a bound company channel in Home and follows an external channel selection into Team Space', async () => {
    const command = vi.fn(async () => null)
    const companies = companyWorkspaceWithChannel('!launch:test')
    const { emit } = fixture(undefined, 'en', workplacePages(), command, undefined, companies)
    const assistant = controlsState.rooms[0]!

    const companyRoom: MatrixRoom = {
      id: '!launch:test',
      name: 'launch',
      membership: 'join',
      encrypted: false,
      roomType: MATRIX_COMPANY_CHANNEL_TYPE,
      companyChannel: { companyId: 'company-a', channelId: '00000000-0000-4000-8000-676a3a34ff0f' }
    }

    const companyState = {
      ...controlsState,
      companyWorkspaceEnabled: true,
      roomId: companyRoom.id,
      rooms: [assistant, companyRoom]
    }

    emit(companyState)
    await waitFor(() => expect(window.document.querySelector('[data-matrix-company-workspace]')).toBeTruthy())
    expect(await screen.findByRole('textbox', { name: COMPOSER })).toBeTruthy()

    const mainRail = screen.getByRole('navigation', { name: 'Main navigation' })
    fireEvent.click(within(mainRail).getByRole('button', { name: 'Chats' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: assistant.id }))
    expect(screen.queryByRole('textbox', { name: COMPOSER })).toBeNull()
    expect(window.document.querySelector('[data-matrix-company-workspace]')).toBeNull()
    expect(window.document.querySelector('[data-atum-roster]')).toBeTruthy()
    expect(window.document.querySelector('[data-matrix-header-identity]')?.textContent).not.toContain('launch')

    emit({ ...companyState, roomId: assistant.id })
    await waitFor(() =>
      expect(within(mainRail).getByRole('button', { name: 'Chats' }).getAttribute('aria-current')).toBe('page')
    )
    emit(companyState)
    await waitFor(() =>
      expect(within(mainRail).getByRole('button', { name: 'Team space' }).getAttribute('aria-current')).toBe('page')
    )
    expect(window.document.querySelector('[data-matrix-company-workspace]')).toBeTruthy()
  })

  it('puts company chrome in a channel: its own menu, the rail dot and mention count, and channels in the palette only inside Team space', async () => {
    const command = vi.fn(async () => null)
    const companies = companyWorkspaceWithChannel('!launch:test')
    const { emit } = fixture(undefined, 'en', workplacePages(), command, undefined, companies)
    const assistant = controlsState.rooms[0]!

    const companyRoom: MatrixRoom = {
      id: '!launch:test',
      name: 'launch',
      membership: 'join',
      encrypted: false,
      roomType: MATRIX_COMPANY_CHANNEL_TYPE,
      companyChannel: { companyId: 'company-a', channelId: '00000000-0000-4000-8000-676a3a34ff0f' },
      unreadNotifications: 2,
      highlights: 1
    }

    // Joined channels the selected company's directory does not list: another company's, and a
    // stale room of this company. ⌘K must offer neither.
    const foreignRoom: MatrixRoom = {
      ...companyRoom,
      id: '!beta-secret:test',
      name: 'beta-secret',
      companyChannel: { companyId: 'company-b', channelId: '00000000-0000-4000-8000-e7b998607ca3' },
      unreadNotifications: 0,
      highlights: 0
    }

    const staleRoom: MatrixRoom = {
      ...companyRoom,
      id: '!stale:test',
      name: 'stale-room',
      unreadNotifications: 0,
      highlights: 0
    }

    const companyState = {
      ...controlsState,
      companyWorkspaceEnabled: true,
      roomId: companyRoom.id,
      rooms: [assistant, companyRoom, foreignRoom, staleRoom]
    }

    emit(companyState)
    await waitFor(() => expect(window.document.querySelector('[data-matrix-company-workspace]')).toBeTruthy())
    const mainRail = screen.getByRole('navigation', { name: 'Main navigation' })

    // The rail's Team space carries the channel's mention count.
    expect(within(mainRail).getByRole('button', { name: 'Team space · Mentions you: 2' })).toBeTruthy()

    // A channel gets the company menu: no personal rename, pin, leave or delete, and no awareness line.
    const trigger = await screen.findByRole('button', { name: 'Conversation options' })
    expect(trigger.getAttribute('data-matrix-chat-menu')).toBe('company')
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Open threads',
      'Channel details',
      'Add to favorites',
      'Notifications'
    ])
    expect(window.document.querySelector('[data-matrix-chat-awareness]')).toBeNull()
    fireEvent.keyDown(window.document.activeElement ?? window, { key: 'Escape' })
    // The channel header keeps the # glyph, not an assistant avatar.
    expect(window.document.querySelector('[data-matrix-channel-glyph]')).toBeTruthy()

    // ⌘K lists the channel while Team space is on screen.
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true })
    const inWorkplace = await screen.findByRole('dialog', { name: 'Command palette' })
    expect(within(inWorkplace).getByText('Channels')).toBeTruthy()
    expect(within(inWorkplace).getByRole('option', { name: /launch/ })).toBeTruthy()
    expect(within(inWorkplace).queryByRole('option', { name: /beta-secret/ })).toBeNull()
    expect(within(inWorkplace).queryByRole('option', { name: /stale-room/ })).toBeNull()
    fireEvent.keyDown(inWorkplace, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull())

    // Home stays Home: the same palette has no channels once the person leaves Team space.
    fireEvent.click(within(mainRail).getByRole('button', { name: 'Chats' }))
    emit({ ...companyState, roomId: assistant.id })
    await waitFor(() => expect(window.document.querySelector('[data-matrix-company-workspace]')).toBeNull())
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true })
    const atHome = await screen.findByRole('dialog', { name: 'Command palette' })
    expect(within(atHome).queryByText('Channels')).toBeNull()
    expect(within(atHome).queryByRole('option', { name: /launch/ })).toBeNull()
  })

  it('moves between Workplace channels with Option+Arrow and to the next unread with Option+Shift+Arrow', async () => {
    const command = vi.fn(async () => null)
    const companies = companyWorkspaceWithChannel('!launch:test')
    const { emit } = fixture(undefined, 'en', workplacePages(), command, undefined, companies)
    const assistant = controlsState.rooms[0]!
    const binding = { companyId: 'company-a', channelId: '00000000-0000-4000-8000-676a3a34ff0f' }

    const rooms: MatrixRoom[] = [
      assistant,
      {
        id: '!launch:test',
        name: 'launch',
        membership: 'join',
        encrypted: false,
        roomType: MATRIX_COMPANY_CHANNEL_TYPE,
        companyChannel: binding
      },
      {
        id: '!mid:test',
        name: 'mid',
        membership: 'join',
        encrypted: false,
        roomType: MATRIX_COMPANY_CHANNEL_TYPE,
        companyChannel: binding
      },
      {
        id: '!ops:test',
        name: 'ops',
        membership: 'join',
        encrypted: false,
        roomType: MATRIX_COMPANY_CHANNEL_TYPE,
        companyChannel: binding,
        unreadNotifications: 1
      }
    ]

    emit({ ...controlsState, companyWorkspaceEnabled: true, roomId: '!launch:test', rooms })
    await waitFor(() => expect(window.document.querySelector('[data-matrix-company-workspace]')).toBeTruthy())
    // The sidebar publishes the order these chords walk (the fixture directory lists one channel).
    await screen.findByRole('button', { name: 'Open # launch' })
    await waitFor(() => expect($companyChannelOrder.get()).toEqual(['!launch:test']))
    act(() => $companyChannelOrder.set(['!launch:test', '!mid:test', '!ops:test']))
    command.mockClear()

    fireEvent.keyDown(window, { key: 'ArrowDown', code: 'ArrowDown', altKey: true })
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: '!mid:test' }))
    command.mockClear()
    fireEvent.keyDown(window, { key: 'ArrowDown', code: 'ArrowDown', altKey: true, shiftKey: true })
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: '!ops:test' }))
  })

  describe('moving between companies from the keyboard', () => {
    const launch: MatrixRoom = {
      id: '!launch:test',
      name: 'launch',
      membership: 'join',
      encrypted: false,
      roomType: MATRIX_COMPANY_CHANNEL_TYPE,
      companyChannel: { companyId: 'company-a', channelId: '00000000-0000-4000-8000-676a3a34ff0f' }
    }

    const title = () => window.document.querySelector('[data-matrix-company-title] h1')?.textContent

    const chord = (code: string, key: string) => fireEvent.keyDown(window, { key, code, metaKey: true, altKey: true })

    it('goes to the Nth company on ⌘⌥N and to the one before or after on ⌘⌥↑ and ⌘⌥↓, while Workplace is on screen', async () => {
      const command = vi.fn(async () => null)
      const companies = twoCompaniesWithChannel('!launch:test')
      const { emit } = fixture(undefined, 'en', workplacePages(), command, undefined, companies)

      emit({
        ...controlsState,
        companyWorkspaceEnabled: true,
        roomId: launch.id,
        rooms: [controlsState.rooms[0]!, launch]
      })
      await waitFor(() => expect(title()).toBe('Alpha'))

      chord('Digit2', '2')
      await waitFor(() => expect(title()).toBe('Beta'))

      // The chords wrap, and ⌘⌥1 returns to the first.
      chord('ArrowDown', 'ArrowDown')
      await waitFor(() => expect(title()).toBe('Alpha'))
      chord('ArrowUp', 'ArrowUp')
      await waitFor(() => expect(title()).toBe('Beta'))
      chord('Digit1', '1')
      await waitFor(() => expect(title()).toBe('Alpha'))

      // Option+Arrow alone still walks channels, not companies.
      command.mockClear()
      fireEvent.keyDown(window, { key: 'ArrowDown', code: 'ArrowDown', altKey: true })
      expect(title()).toBe('Alpha')
    })

    it('does nothing at Home, where there are no companies on screen to move between', async () => {
      const companies = twoCompaniesWithChannel('!launch:test')

      const { emit } = fixture(
        undefined,
        'en',
        workplacePages(),
        vi.fn(async () => null),
        undefined,
        companies
      )

      const assistant = controlsState.rooms[0]!

      emit({ ...controlsState, companyWorkspaceEnabled: true, roomId: assistant.id, rooms: [assistant, launch] })
      await screen.findByRole('textbox', { name: COMPOSER })
      expect(window.document.querySelector('[data-matrix-company-workspace]')).toBeNull()

      chord('Digit2', '2')
      expect(window.document.querySelector('[data-matrix-company-workspace]')).toBeNull()
    })

    it('leaves the window header to the company pages when the next company has no channel', async () => {
      const companies = twoCompaniesWithChannel('!launch:test')

      const { emit } = fixture(
        undefined,
        'en',
        workplacePages(),
        vi.fn(async () => null),
        undefined,
        companies
      )

      const header = () => window.document.querySelector<HTMLElement>('[data-matrix-header-identity]')!

      emit({
        ...controlsState,
        companyWorkspaceEnabled: true,
        roomId: launch.id,
        rooms: [controlsState.rooms[0]!, launch]
      })
      await waitFor(() => expect(header().textContent).toContain('launch'))
      expect(header().querySelector('[data-matrix-channel-glyph]')).toBeTruthy()

      chord('Digit2', '2')
      await waitFor(() => expect(title()).toBe('Beta'))
      await waitFor(() => expect(header().textContent).not.toContain('launch'))
      expect(header().textContent).not.toContain('Team space')
      expect(header().querySelector('[data-matrix-channel-glyph]')).toBeNull()
      expect(window.document.querySelector('[data-atum-main-header] [role="tablist"]')).toBeTruthy()
    })
  })

  describe('a channel the platform archived', () => {
    const launch = (): MatrixRoom => ({
      id: '!launch:test',
      name: 'launch',
      membership: 'join',
      encrypted: false,
      roomType: MATRIX_COMPANY_CHANNEL_TYPE,
      companyChannel: { companyId: 'company-a', channelId: '00000000-0000-4000-8000-676a3a34ff0f' }
    })

    it('has no box, whatever Matrix says about this person’s power to post', async () => {
      const command = vi.fn(async () => null)
      const companies = companyWorkspaceWithChannel('!launch:test', () => 'archived')
      const { emit } = fixture(undefined, 'en', workplacePages(), command, undefined, companies)

      // Matrix would let this person post (`canSend` is true); the platform says the channel is archived.
      emit({
        ...controlsState,
        canSend: true,
        companyWorkspaceEnabled: true,
        roomId: '!launch:test',
        rooms: [controlsState.rooms[0]!, launch()]
      })
      await waitFor(() => expect(window.document.querySelector('[data-matrix-company-workspace]')).toBeTruthy())

      expect(await screen.findByText(/Archived: read-only/)).toBeTruthy()
      expect(screen.queryByRole('textbox', { name: COMPOSER })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
      // One banner, in place of the box: not also the generic "you can't write here" band.
      expect(window.document.querySelectorAll('[data-matrix-channel-archived]')).toHaveLength(1)
      expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'send' }))
    })

    it('keeps the box closed, quietly, until the platform has said whether the channel is archived', async () => {
      let release!: () => void

      const gate = new Promise<void>(resolve => {
        release = resolve
      })

      const command = vi.fn(async () => null)
      const companies = companyWorkspaceWithLateDirectory('!launch:test', gate, () => 'archived')
      const { emit } = fixture(undefined, 'en', workplacePages(), command, undefined, companies)

      // Matrix would let this person post; the directory has not answered yet, so nothing says the channel is archived.
      emit({
        ...controlsState,
        canSend: true,
        companyWorkspaceEnabled: true,
        roomId: '!launch:test',
        rooms: [controlsState.rooms[0]!, launch()]
      })
      await waitFor(() => expect(window.document.querySelector('[data-matrix-company-workspace]')).toBeTruthy())
      await waitFor(() => expect(window.document.querySelector('[data-matrix-channel-loading]')).toBeTruthy())

      expect(screen.queryByRole('textbox', { name: COMPOSER })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
      // A quiet line, not an error and not the archived banner.
      expect(window.document.querySelector('[data-matrix-channel-loading]')?.textContent).toBe('Loading channels…')
      expect(window.document.querySelector('[data-matrix-channel-archived]')).toBeNull()
      expect(
        within(window.document.querySelector('[data-matrix-company-workspace]') as HTMLElement).queryByRole('alert')
      ).toBeNull()

      // The answer: archived, so the banner stands in the box's place and nothing was ever sent.
      release()
      expect(await screen.findByText(/Archived: read-only/)).toBeTruthy()
      expect(window.document.querySelector('[data-matrix-channel-loading]')).toBeNull()
      expect(screen.queryByRole('textbox', { name: COMPOSER })).toBeNull()
      expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'send' }))
    })

    it('opens the box once the platform says the channel is active', async () => {
      let release!: () => void

      const gate = new Promise<void>(resolve => {
        release = resolve
      })

      const companies = companyWorkspaceWithLateDirectory('!launch:test', gate, () => 'active')

      const { emit } = fixture(
        undefined,
        'en',
        workplacePages(),
        vi.fn(async () => null),
        undefined,
        companies
      )

      emit({
        ...controlsState,
        canSend: true,
        companyWorkspaceEnabled: true,
        roomId: '!launch:test',
        rooms: [controlsState.rooms[0]!, launch()]
      })
      await waitFor(() => expect(window.document.querySelector('[data-matrix-channel-loading]')).toBeTruthy())
      expect(screen.queryByRole('textbox', { name: COMPOSER })).toBeNull()

      release()
      expect(await screen.findByRole('textbox', { name: COMPOSER })).toBeTruthy()
      expect(window.document.querySelector('[data-matrix-channel-loading]')).toBeNull()
    })

    it('keeps a thread’s box closed too while the channel’s state is unknown, then follows the answer', async () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      let release!: () => void

      const gate = new Promise<void>(resolve => {
        release = resolve
      })

      const command = vi.fn(async () => null)
      const companies = companyWorkspaceWithLateDirectory('!launch:test', gate, () => 'archived')
      const { emit } = fixture(undefined, 'en', workplacePages(), command, undefined, companies)

      const root = {
        id: '$root',
        sender: '@linh:test',
        body: 'Launch plan?',
        timestamp: 10,
        own: false,
        encrypted: false,
        decryptionFailed: false,
        pending: false,
        failed: false,
        attachment: false
      }

      const reply = {
        ...root,
        id: '$reply',
        sender: '@owner:test',
        body: 'Tuesday works.',
        timestamp: 20,
        own: true,
        thread: true as const,
        threadRootId: '$root',
        replyTo: '$root'
      }

      emit({
        ...controlsState,
        canSend: true,
        companyWorkspaceEnabled: true,
        roomId: '!launch:test',
        rooms: [controlsState.rooms[0]!, launch()],
        messages: [root],
        threads: [
          {
            root,
            replies: [reply],
            participantIds: ['@linh:test', '@owner:test'],
            replyCount: 1,
            lastActivityAt: 20,
            unread: false,
            highlights: 0,
            followed: true
          }
        ]
      })

      fireEvent.keyDown(await screen.findByRole('button', { name: 'Conversation options' }), { key: 'Enter' })
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Open threads' }))
      const panel = window.document.querySelector<HTMLElement>('[data-matrix-thread-panel]')!
      fireEvent.click(await within(panel).findByRole('button', { name: /Launch plan/ }))

      await waitFor(() => expect(panel.querySelector('[data-matrix-channel-loading]')).toBeTruthy())
      expect(within(panel).queryByRole('textbox', { name: THREAD_COMPOSER })).toBeNull()
      expect(within(panel).queryByRole('button', { name: 'Send' })).toBeNull()
      expect(within(panel).queryByRole('alert')).toBeNull()

      release()
      await waitFor(() => expect(panel.querySelector('[data-matrix-channel-archived]')).toBeTruthy())
      expect(panel.querySelector('[data-matrix-channel-loading]')).toBeNull()
      expect(within(panel).queryByRole('textbox', { name: THREAD_COMPOSER })).toBeNull()
      expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'send' }))
    })

    it('takes the box away when the platform archives the channel under an open one, and gives it back on restore', async () => {
      let state: 'active' | 'archived' = 'active'
      const command = vi.fn(async () => null)
      const companies = companyWorkspaceWithChannel('!launch:test', () => state)
      const { emit } = fixture(undefined, 'en', workplacePages(), command, undefined, companies)

      emit({
        ...controlsState,
        canSend: true,
        companyWorkspaceEnabled: true,
        roomId: '!launch:test',
        rooms: [controlsState.rooms[0]!, launch()]
      })
      fireEvent.change(await screen.findByRole('textbox', { name: COMPOSER }), { target: { value: 'one more thing' } })
      expect(window.document.querySelector('[data-matrix-channel-archived]')).toBeNull()

      state = 'archived'
      act(() => void window.dispatchEvent(new Event('focus')))
      expect(await screen.findByText(/Archived: read-only/)).toBeTruthy()
      expect(screen.queryByRole('textbox', { name: COMPOSER })).toBeNull()
      expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'send' }))

      state = 'active'
      act(() => void window.dispatchEvent(new Event('focus')))
      expect(await screen.findByRole('textbox', { name: COMPOSER })).toBeTruthy()
      expect(window.document.querySelector('[data-matrix-channel-archived]')).toBeNull()
    })
  })

  describe('a company conversation (a company DM)', () => {
    const dm = (): MatrixRoom => ({
      id: '!dm:test',
      name: 'Bảo',
      membership: 'join',
      encrypted: false,
      roomType: MATRIX_COMPANY_CONVERSATION_TYPE,
      companyConversation: { companyId: 'company-a', conversationId: '00000000-0000-4000-8000-f6c6b8bb709f' }
    })

    it('has no box once the platform says it is read-only, whatever Matrix says about this person’s power to post', async () => {
      const command = vi.fn(async () => null)
      const companies = companyWorkspaceWithConversation('!dm:test', () => 'read_only')
      const { emit } = fixture(undefined, 'en', workplacePages(), command, undefined, companies)

      emit({
        ...controlsState,
        canSend: true,
        companyWorkspaceEnabled: true,
        roomId: '!dm:test',
        rooms: [controlsState.rooms[0]!, dm()]
      })
      await waitFor(() => expect(window.document.querySelector('[data-matrix-company-workspace]')).toBeTruthy())

      expect(await screen.findByText(/Read-only because someone left/)).toBeTruthy()
      expect(screen.queryByRole('textbox', { name: COMPOSER })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
      expect(window.document.querySelectorAll('[data-matrix-conversation-read-only]')).toHaveLength(1)
      expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'send' }))
    })

    it('keeps the box closed until the platform lists the conversation, then opens without default-state notices', async () => {
      let release!: () => void

      const gate = new Promise<void>(resolve => {
        release = resolve
      })

      const command = vi.fn(async () => null)
      const companies = companyWorkspaceWithConversation('!dm:test', () => 'active', gate)
      const { emit } = fixture(undefined, 'en', workplacePages(), command, undefined, companies)

      emit({
        ...controlsState,
        canSend: true,
        companyWorkspaceEnabled: true,
        roomId: '!dm:test',
        rooms: [controlsState.rooms[0]!, dm()]
      })
      await waitFor(() => expect(window.document.querySelector('[data-matrix-channel-loading]')).toBeTruthy())

      expect(screen.queryByRole('textbox', { name: COMPOSER })).toBeNull()
      expect(window.document.querySelector('[data-matrix-channel-loading]')?.textContent).toBe('Loading conversations…')
      expect(window.document.querySelector('[data-matrix-conversation-read-only]')).toBeNull()

      release()
      expect(await screen.findByRole('textbox', { name: COMPOSER })).toBeTruthy()
      expect(window.document.querySelector('[data-matrix-channel-loading]')).toBeNull()
      expect(window.document.querySelector('[data-matrix-company-conversation-note]')).toBeNull()
      expect(window.document.querySelector('[data-matrix-company-not-encrypted]')).toBeNull()
      expect(window.document.body.textContent).not.toMatch(/end-to-end encrypted/)
      // Its own menu (not the personal chat's). Without the protected-file capability there is no ordinary-media fallback.
      expect(screen.getByRole('button', { name: 'Conversation options' })).toBeTruthy()
      expect(window.document.querySelector('[data-attach-closed]')).toBeTruthy()
    })

    it.each(['dm', 'group_dm'] as const)('sends a staged protected file in an active company %s', async kind => {
      const command = vi.fn(async () => '$file')
      const companies = companyWorkspaceWithConversation('!dm:test', () => 'active', undefined, kind)
      const { emit } = fixture(undefined, 'en', workplacePages(), command, undefined, companies)
      emit({
        ...controlsState,
        canSend: true,
        companyWorkspaceEnabled: true,
        companyDriveFilesEnabled: true,
        roomId: '!dm:test',
        rooms: [controlsState.rooms[0]!, dm()]
      })
      const input = await screen.findByLabelText('Attach file (up to 20 MB)')
      await waitFor(() => expect(window.document.querySelector('[data-attach-closed]')).toBeNull())
      const notes = new File(['private'], 'private.txt')
      Object.defineProperty(notes, 'arrayBuffer', { value: async () => new TextEncoder().encode('private').buffer })
      fireEvent.change(input, { target: { files: [notes] } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'attach', roomId: '!dm:test', name: 'private.txt'
      })))
    })

    it('is named for the other person in the header, from the platform’s record', async () => {
      const companies = companyWorkspaceWithConversation('!dm:test', () => 'active')

      const { emit } = fixture(
        undefined,
        'en',
        workplacePages(),
        vi.fn(async () => null),
        undefined,
        companies
      )

      emit({
        ...controlsState,
        canSend: true,
        companyWorkspaceEnabled: true,
        roomId: '!dm:test',
        rooms: [controlsState.rooms[0]!, { ...dm(), name: 'room-name-from-matrix' }]
      })

      expect(await screen.findByRole('button', { name: 'Open conversation with Minh, Bảo' })).toBeTruthy()
      const face = window.document.querySelector('[data-matrix-conversation-glyph] .atum-avatar')
      expect(face).toBeTruthy()
      // The person's own squircle, not a person glyph (Slack shows the face in the header).
      expect(face?.textContent).toBe('M')
    })
  })

  // 0.20 (owner decision D1): agent chats are plain Matrix rooms.
  const plainAgentState: MatrixSnapshot = {
    ...controlsState,
    rooms: [{ ...controlsState.rooms[0]!, encrypted: false, plainAgent: true }],
    messages: [{ ...controlsState.messages[0]!, encrypted: false }]
  }

  it('offers Find the answer in a plain agent chat, with no notice about encryption', async () => {
    const { emit, bridge } = fixture()
    emit(plainAgentState)
    expect(screen.queryByText(/only sends messages in encrypted chats/)).toBeNull()
    openMessageActions()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Find the answer' }))
    await waitFor(() => expect(bridge.recoverHermes).toHaveBeenCalledOnce())
  })

  it('keeps the agent composer open in a plain agent chat', async () => {
    const { emit } = fixture()
    emit(plainAgentState)
    const composer = (await screen.findByRole('textbox', { name: COMPOSER })) as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: 'xin chào' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false))
  })

  it('opens an empty workspace from the titlebar and closes without linking a document', async () => {
    const { emit, bridge } = fixture()
    emit(controlsState)
    const opener = screen.getByRole('button', { name: 'Show side panel' })
    expect(opener.getAttribute('data-workspace-tab-count')).toBe('0')
    fireEvent.click(opener)
    await waitFor(() => expect(window.document.querySelector('[data-matrix-workbench-launcher]')).toBeTruthy())
    expect(bridge.previewDocument).not.toHaveBeenCalled()
    expect(bridge.document).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Close workspace' }))
    expect(screen.getByRole('button', { name: 'Show side panel' }).getAttribute('data-workspace-tab-count')).toBe('0')
    expect(window.document.activeElement).toBe(screen.getByRole('button', { name: 'Show side panel' }))
  })

  // Preserve user-visible identity, state and recovery behavior across connection changes.
  it('opens conversation info from the titlebar in a chat with a person, and the workbench in an assistant chat', async () => {
    const command = vi.fn(async (value: Parameters<MatrixUiBridge['command']>[0]) =>
      value.kind === 'roomShared' ? { section: value.section, items: [], source: 'device', unreadable: 0 } : null
    )

    const { emit } = fixture(undefined, 'en', undefined, command)

    const person: MatrixSnapshot = {
      ...controlsState,
      roomId: '!linh:test',
      rooms: [
        ...controlsState.rooms,
        {
          id: '!linh:test',
          name: 'Linh',
          membership: 'join',
          encrypted: true,
          direct: true,
          participants: [
            { userId: '@owner:test', membership: 'join' },
            { userId: '@linh:test', membership: 'join' }
          ]
        }
      ],
      members: [{ userId: '@linh:test', name: 'Linh', membership: 'join', canRemove: false }],
      messages: []
    }

    emit(person)
    fireEvent.click(await screen.findByRole('button', { name: 'Show conversation info' }))
    await waitFor(() => expect(window.document.querySelector('[data-matrix-person-info="person"]')).toBeTruthy())
    // The workbench stays mounted out of sight (its tabs keep their state), never shown beside it.
    expect(
      window.document.querySelector('[data-matrix-workbench-launcher]')?.closest<HTMLElement>('[data-atum-workspace]')?.hidden ?? true
    ).toBe(true)
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({ kind: 'roomShared', roomId: '!linh:test', section: 'files', limit: 3 })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close workspace' }))
    await waitFor(() => expect(window.document.querySelector('[data-matrix-person-info]')).toBeNull())

    emit(controlsState)
    fireEvent.click(await screen.findByRole('button', { name: 'Show side panel' }))
    await waitFor(() => expect(window.document.querySelector('[data-matrix-workbench-launcher]')).toBeTruthy())
    expect(window.document.querySelector('[data-matrix-person-info]')).toBeNull()
  })

  it('folds the roster away when the side panel would squeeze the chat, and brings it back on close', async () => {
    vi.stubGlobal('innerWidth', 1100)
    const { emit } = fixture()
    emit(controlsState)
    const slot = () => window.document.querySelector('[data-atum-roster-slot]')
    expect(slot()?.hasAttribute('inert')).toBe(false)
    // The header control wears the panel glyph, not a boxed plus that reads as "new chat".
    fireEvent.click(screen.getByRole('button', { name: 'Show side panel' }))
    await waitFor(() => expect(slot()?.hasAttribute('inert')).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Close workspace' }))
    await waitFor(() => expect(slot()?.hasAttribute('inert')).toBe(false))
  })

  it('leaves the roster where it is when the window has room for the side panel', async () => {
    const { emit } = fixture()
    emit(controlsState)
    fireEvent.click(screen.getByRole('button', { name: 'Show side panel' }))
    await waitFor(() => expect(window.document.querySelector('[data-matrix-workbench-launcher]')).toBeTruthy())
    expect(window.document.querySelector('[data-atum-roster-slot]')?.hasAttribute('inert')).toBe(false)
  })

  it('keeps the workspace open across document revisions and preserves its tab when hidden', async () => {
    const { emit, bridge } = fixture()

    const state: MatrixSnapshot = {
      ...controlsState,
      linkedDocument: { name: 'notes.txt', state: 'linked', revision: '1' }
    }

    emit(state)
    fireEvent.click(screen.getByRole('button', { name: 'Show side panel' }))
    await screen.findByText('saved preview bytes')
    emit({ ...state, linkedDocument: { ...state.linkedDocument!, revision: '2' } })
    expect(screen.queryByRole('button', { name: 'Show side panel' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close workspace' }))
    const opener = screen.getByRole('button', { name: 'Show side panel' })
    expect(opener.getAttribute('data-workspace-tab-count')).toBe('1')
    const closed = vi.mocked(bridge.closeDocumentPreview).mock.calls.length
    fireEvent.click(opener)
    await screen.findByText('saved preview bytes')
    expect(bridge.closeDocumentPreview).toHaveBeenCalledTimes(closed)
    emit({ ...controlsState, roomId: '!other:test' })
    expect(screen.getByRole('button', { name: 'Show side panel' }).getAttribute('data-workspace-tab-count')).toBe('0')
  })

  it.each([
    ['en', 'Advanced', 'Message actions'],
    ['vi', 'Nâng cao', 'Thao tác tin nhắn'],
    ['zh', '高级', '消息操作'],
    ['zh-hant', '進階', '訊息操作'],
    ['ja', '詳細', 'メッセージの操作']
  ] as const)(
    'keeps secondary controls behind localized dialogs and menus in %s without dispatching anything',
    async (locale, setup, actions) => {
      const { emit, bridge } = legacyFixture(undefined, locale)
      emit(controlsState)

      expect(settingsSheet().hidden).toBe(true)
      openAccountSettings()
      showSettingsPane('assistant')
      expect(within(settingsSheet()).getByRole('heading', { name: setup })).toBeTruthy()
      closeAccountSettings()

      openAssistantOptions(locale)
      expect(screen.getByRole('dialog')).toBeTruthy()
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

      const actionsTrigger = screen.getByRole('button', { name: new RegExp(`^${actions}`) })
      expect(actionsTrigger.getAttribute('aria-expanded')).toBe('false')
      fireEvent.keyDown(actionsTrigger, { key: 'Enter' })
      expect(actionsTrigger.getAttribute('aria-expanded')).toBe('true')

      expect(bridge.readDomain).not.toHaveBeenCalled()
      expect(bridge.enrollHermes).not.toHaveBeenCalled()
      expect(bridge.configureHermes).not.toHaveBeenCalled()
      expect(bridge.connectHermes).not.toHaveBeenCalled()
      expect(bridge.listenHermes).not.toHaveBeenCalled()
      expect(bridge.setContinuousListening).not.toHaveBeenCalled()
      expect(bridge.invokeHermes).not.toHaveBeenCalled()
      expect(bridge.recoverHermes).not.toHaveBeenCalled()
      // Atum Kit Settings shows your devices and recovery on the Account page: its device-list read
      // and the recovery panel's no-op cleanup on close are the only commands, both reads.
      expect(
        vi
          .mocked(bridge.command)
          .mock.calls.filter(([command]) => !['devices', 'recoveryDiscard'].includes((command as { kind?: string }).kind ?? ''))
      ).toEqual([])
      await act(async () => {})
    }
  )

  it("greets in an assistant's empty chat, and says a person's empty chat has no messages yet", async () => {
    const { emit } = fixture()
    emit({ ...controlsState, messages: [] })
    expect(await screen.findByText('What can I do for you today?')).toBeTruthy()
    expect(screen.queryByText('No messages yet.')).toBeNull()
    const person = { id: '!person:test', name: 'Linh', membership: 'join', encrypted: true, direct: true }
    emit({ ...controlsState, rooms: [...controlsState.rooms, person], roomId: person.id, messages: [] })
    expect(await screen.findByText('No messages yet.')).toBeTruthy()
    expect(screen.queryByText('What can I do for you today?')).toBeNull()
  })

  it('opens promoted Main from the single Atum primary row and reuses it from New message', async () => {
    const state = promotedMainSnapshot()
    const { bridge, view } = fixture(async () => state)
    // The degraded former root's assistant problem does not hold the launch.
    await waitFor(() => expect(window.document.querySelector('[data-slot="matrix-startup"]')).toBeNull())
    // The primary goes by its record's name (owner decision D1: it is renameable).
    const primary = await screen.findByRole('button', { name: /^Atum Main$/ })
    const roster = view.container.querySelector('[data-matrix-roster-conversations]')!
    expect(roster.querySelector('[data-matrix-agent]')?.getAttribute('data-matrix-agent')).toBe('main')
    expect(screen.getAllByRole('button', { name: /^Atum Main$/ })).toHaveLength(1)
    expect(bridge.command).not.toHaveBeenCalled()
    fireEvent.click(primary)
    await waitFor(() => expect(bridge.connectHermes).toHaveBeenCalledExactlyOnceWith('!main:test'))
    expect(bridge.command).toHaveBeenCalledExactlyOnceWith({ kind: 'select', roomId: '!main:test' })
    fireEvent.keyDown(window, { key: 'n', code: 'KeyN', metaKey: true })
    const start = await screen.findByRole('dialog', { name: 'Start a chat' })
    fireEvent.click(
      within(within(start).getByRole('group', { name: 'Assistants' })).getByRole('button', { name: /^Atum Main/ })
    )
    await waitFor(() => expect(bridge.connectHermes).toHaveBeenLastCalledWith('!main:test'))
    expect(bridge.command).toHaveBeenLastCalledWith({ kind: 'select', roomId: '!main:test' })
    expect(bridge.command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'create' }))
  })

  it('greets Main with the Atum mark and projects the former root’s independent history state', async () => {
    const state = promotedMainSnapshot()
    // With Workplace pages the model chip has Advanced options, so it shows the lineup.
    const { emit, bridge, view } = fixture(async () => ({ ...state, roomId: '!main:test' }), 'en', workplacePages())
    await screen.findByText('What can I do for you today?')
    expect(view.container.querySelector('[data-matrix-greeting] [data-atum-eclipse-face]')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Model: Nguyệt Thực 1.3' })).toBeTruthy()
    emit({ ...state, roomId: '!old:test' })
    // The header names the assistant the chat is with (its card's name), then the chat.
    expect(
      within(view.container.querySelector<HTMLElement>('[data-matrix-header-identity]')!).getByText(
        'Original assistant'
      )
    ).toBeTruthy()
    expect(view.container.querySelector('[data-matrix-greeting] [data-atum-eclipse-face]')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Model:/ })).toBeNull()
    const composer = screen.getByRole('textbox', { name: COMPOSER })
    fireEvent.change(composer, { target: { value: 'Retain this old-room draft' } })
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true)
    expect(bridge.command).not.toHaveBeenCalled()
    expect(bridge.sendTurn).not.toHaveBeenCalled()
    // The chip reads the room agent's own model, not the primary's (snapshotForRoom).
    emit({
      ...state,
      roomId: '!old:test',
      agents: state.agents!.map(agent => (agent.principal === 'old-root' ? { ...agent, atumModel: true } : agent)),
      rooms: state.rooms.map(each => (each.id === '!old:test' ? { ...each, model: 'nhat-thuc' as const } : each))
    })
    expect(screen.getByRole('button', { name: 'Model: Nhật Thực 1.1' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Model: Nguyệt Thực 1.3' })).toBeNull()
    // A background platform-role refresh does not replace the explicitly selected old chat.
    emit({ ...state, roomId: '!old:test', agents: state.agents!.map(agent => ({ ...agent })) })
    expect((screen.getByRole('textbox', { name: COMPOSER }) as HTMLTextAreaElement).value).toBe(
      'Retain this old-room draft'
    )
    expect(bridge.command).not.toHaveBeenCalled()
  })

  it('does not silently choose the former default when Main has no available default room/runtime', async () => {
    const state = promotedMainSnapshot()

    const { bridge } = fixture(async () => ({
      ...state,
      assistant: undefined,
      readiness: undefined,
      roomId: null,
      rooms: state.rooms.filter(room => room.id === '!old:test')
    }))

    fireEvent.click(await screen.findByRole('button', { name: /^Chats$/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Atum Main$/ }))
    await act(async () => {})
    expect(bridge.command).not.toHaveBeenCalled()
    expect(bridge.connectHermes).not.toHaveBeenCalled()
  })

  it("shows the conversation's model in the assistant composer only on Atum's own model", async () => {
    const { emit } = fixture(undefined, 'en', workplacePages())
    const room = { ...controlsState.rooms[0]!, agentPrincipal: 'agent-atum' }
    emit({ ...controlsState, rooms: [room] })
    expect(screen.queryByRole('button', { name: /^Model:/ })).toBeNull()
    emit({ ...controlsState, rooms: [room], atumModel: true })
    expect(screen.getByRole('button', { name: 'Model: Nguyệt Thực 1.3' })).toBeTruthy()
    emit({ ...controlsState, atumModel: true, rooms: [{ ...room, model: 'nhat-thuc' }] })
    expect(screen.getByRole('button', { name: 'Model: Nhật Thực 1.1' })).toBeTruthy()
    await act(async () => {})
  })

  it("always shows the composer's model choice without a display preference", async () => {
    const { emit } = fixture(undefined, 'en', workplacePages())
    const room = { ...controlsState.rooms[0]!, agentPrincipal: 'agent-atum' }

    const withChoice = (): MatrixSnapshot => ({
      ...controlsState,
      rooms: [room],
      atumModel: true,
      displayPreferences: {
        appearance: { value: 'system', writable: true },
        textSize: { value: 100, writable: true }
      }
    })

    // Never chosen (what every account starts with): the chip shows, and the box still writes.
    emit(withChoice())
    expect(screen.getByRole('button', { name: 'Model: Nguyệt Thực 1.3' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: COMPOSER })).toBeTruthy()
    emit({ ...withChoice(), hermes: 'running' })
    expect(screen.getByRole('textbox', { name: COMPOSER }).getAttribute('placeholder')).toBe('Add to your request…')
    await act(async () => {})
  })

  // The kit's plain model menu sends account subscriptions to Settings without switching the
  // destination rail to Workplace or replacing the chat underneath.
  it("keeps the composer's subscription setup a detour from the chat when Workplace is on the rail", async () => {
    const pages: MatrixPagesBridge = {
      open: vi.fn(async () => ({ viewId: 'runtime-page' })),
      setBounds: vi.fn(async () => ({ ok: true as const })),
      setVisibility: vi.fn(async () => ({ ok: true as const })),
      focus: vi.fn(async () => ({ ok: true as const })),
      close: vi.fn(async () => ({ ok: true as const })),
      onState: vi.fn(() => vi.fn())
    }

    const state: MatrixSnapshot = {
      ...controlsState,
      atumModel: true,
      companyWorkspaceEnabled: true,
      rooms: [{ ...controlsState.rooms[0]!, agentPrincipal: 'agent-atum' }],
      agents: [
        {
          principal: 'agent-atum',
          userId: '@atum:test',
          name: 'Atum',
          isDefault: true,
          ready: true,
          hermes: 'ready',
          atumModel: true
        }
      ]
    }

    fixture(async () => state, 'en', pages, undefined, undefined, companyWorkspace())
    // The chip opens the kit's plain model menu, whose subscription entry is a button.
    fireEvent.click(await screen.findByRole('button', { name: 'Model: Nguyệt Thực 1.3' }))
    const modelCard = within(await screen.findByRole('dialog', { name: 'Model' }))
    fireEvent.click(modelCard.getByRole('button', { name: CONNECTIONS }))
    await waitFor(() => expect(settingsSheet().hidden).toBe(false))
    expect(
      settingsSheet().querySelector('[data-matrix-settings-pane="connections"]')?.getAttribute('aria-current')
    ).toBe('page')
    expect(settingsSheet().querySelector('[data-matrix-settings-section="subscriptions"]')).toBeTruthy()
    expect(pages.open).not.toHaveBeenCalled()
    const rail = screen.getByRole('navigation', { name: 'Main navigation' })
    expect(within(rail).getByRole('button', { name: 'Chats' }).getAttribute('aria-current')).toBe('page')
    expect(within(rail).getByRole('button', { name: 'Team space' }).getAttribute('aria-current')).toBeNull()
    fireEvent.keyDown(window.document, { key: 'Escape' })
    expect(settingsSheet().hidden).toBe(true)
    expect(screen.getByRole('textbox', { name: COMPOSER })).toBeTruthy()
  })

  it.each([true, false])("opens the exact account-wide subscription section with managed model=%s", async managed => {
    const pages: MatrixPagesBridge = {
      open: vi.fn(async () => ({ viewId: 'runtime-page' })),
      setBounds: vi.fn(async () => ({ ok: true as const })),
      setVisibility: vi.fn(async () => ({ ok: true as const })),
      focus: vi.fn(async () => ({ ok: true as const })),
      close: vi.fn(async () => ({ ok: true as const })),
      onState: vi.fn(() => vi.fn())
    }

    const state: MatrixSnapshot = {
      ...controlsState,
      atumModel: managed,
      rooms: [{ ...controlsState.rooms[0]!, agentPrincipal: 'agent-atum' }],
      agents: [
        {
          principal: 'agent-atum',
          userId: '@atum:test',
          name: 'Atum',
          isDefault: true,
          ready: true,
          hermes: 'ready',
          atumModel: managed
        }
      ]
    }

    fixture(async () => state, 'en', pages)
    fireEvent.click(await screen.findByRole('button', { name: managed ? 'Model: Nguyệt Thực 1.3' : 'Model' }))
    const modelCard = within(await screen.findByRole('dialog', { name: 'Model' }))
    fireEvent.click(modelCard.getByRole('button', { name: CONNECTIONS }))
    await waitFor(() => expect(settingsSheet().hidden).toBe(false))
    expect(
      settingsSheet().querySelector('[data-matrix-settings-pane="connections"]')?.getAttribute('aria-current')
    ).toBe('page')
    expect(settingsSheet().querySelector('[data-matrix-settings-section="subscriptions"]')).toBeTruthy()
    expect(settingsSheet().querySelector('[data-matrix-settings-destination="account"]')).toBeNull()
    expect(pages.open).not.toHaveBeenCalled()
    // A detour from the chat, not a Workplace: the rail keeps Home, and back is the chat.
    const rail = screen.getByRole('navigation', { name: 'Main navigation' })
    expect(within(rail).queryByRole('button', { name: 'Team space' })).toBeNull()
    expect(within(rail).getByRole('button', { name: 'Chats' }).getAttribute('aria-current')).toBe('page')
    expect(screen.queryByRole('button', { name: 'Back to Team space' })).toBeNull()
    fireEvent.keyDown(window.document, { key: 'Escape' })
    expect(settingsSheet().hidden).toBe(true)
    expect(window.document.querySelector('[data-matrix-workplace]')).toBeNull()
    expect(screen.getByRole('textbox', { name: COMPOSER })).toBeTruthy()
  })

  // A cloud agent cannot open this Mac's agent-specific Connections page, but the account-wide
  // subscription entry remains useful and opens Settings instead.
  it('offers account subscriptions, not agent Connections, for an agent that answers in the cloud', async () => {
    const pages: MatrixPagesBridge = {
      open: vi.fn(async () => ({ viewId: 'runtime-page' })),
      setBounds: vi.fn(async () => ({ ok: true as const })),
      setVisibility: vi.fn(async () => ({ ok: true as const })),
      focus: vi.fn(async () => ({ ok: true as const })),
      close: vi.fn(async () => ({ ok: true as const })),
      onState: vi.fn(() => vi.fn())
    }

    const state: MatrixSnapshot = {
      ...controlsState,
      atumModel: true,
      rooms: [{ ...controlsState.rooms[0]!, agentPrincipal: 'agent-atum' }],
      agents: [
        {
          principal: 'agent-atum',
          userId: '@atum:test',
          name: 'Atum',
          isDefault: true,
          ready: true,
          hermes: 'ready',
          atumModel: true,
          answering: 'cloud'
        }
      ]
    }

    fixture(async () => state, 'en', pages)
    fireEvent.click(await screen.findByRole('button', { name: 'Model: Nguyệt Thực 1.3' }))
    const card = await screen.findByRole('dialog', { name: 'Model' })
    // The server runs Nguyệt Thực; Nhật Thực waits for R3 and Thái Cực is announced.
    const rows = Array.from(card.querySelectorAll<HTMLButtonElement>('[data-matrix-model-route]'))
    expect(rows.map(row => row.getAttribute('aria-current'))).toEqual(['true', null, null])
    // Announced rows are aria-disabled (focusable, never chosen).
    expect(rows[1].getAttribute('aria-disabled')).toBe('true')
    expect(rows[1].textContent).toMatch(/Coming soon/)
    expect(rows[2].getAttribute('aria-disabled')).toBe('true')
    const subscription = within(card).getByRole('button', { name: CONNECTIONS })
    fireEvent.click(subscription)
    await waitFor(() => expect(settingsSheet().hidden).toBe(false))
    expect(
      settingsSheet().querySelector('[data-matrix-settings-pane="connections"]')?.getAttribute('aria-current')
    ).toBe('page')
    expect(settingsSheet().querySelector('[data-matrix-settings-section="subscriptions"]')).toBeTruthy()
    expect(pages.open).not.toHaveBeenCalled()
  })

  // Reliability plan R5: the roster's `answering` stayed 'cloud' for an agent whose cloud is off and
  // Preserve user-visible identity, state and recovery behavior across connection changes.
  it.each(['answering', 'standby'] as const)(
    'offers Connections in the chat of a cloud-route agent the saved policy keeps on this Mac (%s)',
    async macRole => {
      const pages: MatrixPagesBridge = {
        open: vi.fn(async () => ({ viewId: 'runtime-page' })),
        setBounds: vi.fn(async () => ({ ok: true as const })),
        setVisibility: vi.fn(async () => ({ ok: true as const })),
        focus: vi.fn(async () => ({ ok: true as const })),
        close: vi.fn(async () => ({ ok: true as const })),
        onState: vi.fn(() => vi.fn())
      }

      const state: MatrixSnapshot = {
        ...controlsState,
        atumModel: true,
        rooms: [{ ...controlsState.rooms[0]!, agentPrincipal: 'agent-atum' }],
        agents: [
          {
            principal: 'agent-atum',
            userId: '@atum:test',
            name: 'Atum',
            isDefault: true,
            ready: true,
            hermes: 'ready',
            atumModel: true,
            answering: 'cloud',
            macRole
          }
        ]
      }

      fixture(async () => state, 'en', pages)
      fireEvent.click(await screen.findByRole('button', { name: 'Model: Nguyệt Thực 1.3' }))
      const card = await screen.findByRole('dialog', { name: 'Model' })
      expect(within(card).getByRole('button', { name: CONNECTIONS })).toBeTruthy()
    }
  )

  // 0.20.18 owner report: showing both the cloud and Mac choices made two rows look selected while
  // the composer named only the real answering home. The picker now shows that one home's catalog.
  it('shows and changes only the model a cloud agent uses while this Mac is its answering home', async () => {
    const chatgptRoute = matrixModelRouteId('openai-codex', 'gpt-5.6-luna')
    const gpt6Route = matrixModelRouteId('openai-codex', 'gpt-6-luna')

    const catalog: MatrixModelCatalog = {
      destination: 'this_mac',
      agentName: 'Alfred',
      current: chatgptRoute,
      unavailable: 0,
      routes: [
        {
          id: chatgptRoute,
          provider: 'openai-codex',
          model: 'gpt-5.6-luna',
          name: 'gpt-5.6-luna',
          providerLabel: 'ChatGPT',
          accountLabel: 'ChatGPT Plan',
          connection: 'plan',
          target: 'agent_default',
          destination: 'this_mac',
          efforts: [],
          current: true,
          ready: true
        },
        {
          id: gpt6Route,
          provider: 'openai-codex',
          model: 'gpt-6-luna',
          name: 'gpt-6-luna',
          providerLabel: 'ChatGPT',
          accountLabel: 'ChatGPT Plan',
          connection: 'plan',
          target: 'agent_default',
          destination: 'this_mac',
          efforts: [],
          current: false,
          ready: true
        }
      ],
      accounts: [
        {
          id: 'openai-codex',
          providerLabel: 'ChatGPT',
          accountLabel: 'ChatGPT Plan',
          connection: 'plan',
          ready: true,
          models: 2
        }
      ]
    }

    const modelCatalog = vi.fn(async () => catalog)

    const selectModelRoute = vi.fn(async (_roomId: string, routeId: string) => ({
      status: 'applied' as const,
      current: routeId
    }))

    const state: MatrixSnapshot = {
      ...controlsState,
      atumModel: true,
      localModel: { provider: 'openai-codex', model: 'gpt-5.6-luna' },
      rooms: [{ ...controlsState.rooms[0]!, agentPrincipal: 'alfred' }],
      agents: [
        {
          principal: 'alfred',
          userId: '@atum:test',
          name: 'Atum',
          isDefault: true,
          ready: true,
          hermes: 'ready',
          atumModel: true,
          answering: 'cloud',
          macRole: 'answering',
          localModel: { provider: 'openai-codex', model: 'gpt-5.6-luna' }
        }
      ]
    }

    const { bridge, emit } = fixture()
    bridge.modelCatalog = modelCatalog
    bridge.selectModelRoute = selectModelRoute
    emit(state)
    fireEvent.click(await screen.findByRole('button', { name: 'Model: ChatGPT · GPT-5.6 Luna' }))
    const card = await screen.findByRole('dialog', { name: 'Model' })

    // The picker follows the answering home. This Mac's two ChatGPT routes are the whole list;
    // the cloud's separate Atum choice is edited only in the agent card's per-machine rows.
    await waitFor(() => expect(card.querySelectorAll('[data-matrix-model-route]')).toHaveLength(2))
    expect(card.querySelector('[data-matrix-model-rail-item="openai-codex"]')?.getAttribute('aria-pressed')).toBe(
      'true'
    )
    expect(card.querySelector('[data-matrix-model-rail-item="atum"]')).toBeNull()
    expect(card.querySelectorAll('[data-matrix-model-route][aria-current="true"]')).toHaveLength(1)
    expect(card.querySelector('[data-matrix-model-section-header]')).toBeNull()
    expect(card.querySelector('[data-matrix-model-target]')).toBeNull()

    fireEvent.click(card.querySelector<HTMLButtonElement>(`[data-matrix-model-route="${gpt6Route}"]`)!)
    expect(selectModelRoute).toHaveBeenCalledExactlyOnceWith('!assistant:test', gpt6Route, 'agent_default')
    expect(bridge.command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'setModel' }))
    expect(await screen.findByRole('button', { name: 'Model: ChatGPT · GPT-6 Luna' })).toBeTruthy()
  })

  it("opens a Store listing's Skills Hub for its assistant and comes back to the Store's Skills shelf", async () => {
    const pages: MatrixPagesBridge = {
      open: vi.fn(async () => ({ viewId: 'skills-page' })),
      setBounds: vi.fn(async () => ({ ok: true as const })),
      setVisibility: vi.fn(async () => ({ ok: true as const })),
      focus: vi.fn(async () => ({ ok: true as const })),
      close: vi.fn(async () => ({ ok: true as const })),
      onState: vi.fn(() => vi.fn())
    }

    const state: MatrixSnapshot = {
      ...controlsState,
      agents: [
        {
          principal: 'agent-atum',
          userId: '@atum:test',
          name: 'Atum',
          isDefault: true,
          ready: true,
          hermes: 'ready',
          atumModel: true
        }
      ]
    }

    fixture(async () => state, 'en', pages)
    await screen.findByRole('textbox', { name: COMPOSER })
    act(() => $matrixStoreHubRequest.set(hubSkillRequest(HUB_INSTALL, 'agent-atum')))

    await waitFor(() =>
      expect(pages.open).toHaveBeenCalledWith({
        page: 'skills',
        agentPrincipal: 'agent-atum',
        locale: 'en',
        appearance: expect.any(String),
        hub: HUB_INSTALL.id
      })
    )
    expect($matrixStoreHubRequest.get()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back to the Store' }))
    await waitFor(() => expect(pages.close).toHaveBeenCalledWith('skills-page'))
    expect($matrixStoreShelfRequest.get()).toBe('skills')
    $matrixStoreShelfRequest.set(null)
  })

  it('keeps warnings in the conversation while healthy listening is one switch in reply settings', async () => {
    const { emit, bridge } = legacyFixture()
    emit({ ...controlsState, hermes: 'invalid' })
    expect(screen.getByText(/Your assistant couldn.t start on this Mac/).closest('details')).toBeNull()
    emit({
      ...controlsState,
      hermesListening: { state: 'listening', roomId: '!assistant:test', expiresAt: Date.now() + 60000, queued: 0 }
    })
    expect(screen.queryByRole('button', { name: 'Stop listening' })).toBeNull()
    expect(window.document.querySelector('[data-matrix-status-stack]')?.textContent).not.toContain(
      matrixActionCopy.en.listening
    )
    openAssistantOptions()
    const reply = within(screen.getByRole('dialog')).getByRole('switch', { name: 'Reply in this conversation' })
    expect(reply.getAttribute('aria-checked')).toBe('true')
    // Healthy listening is the switch itself: no status paragraph, no Stop button beside it.
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Stop listening' })).toBeNull()
    fireEvent.click(reply)
    await waitFor(() => expect(bridge.stopListeningHermes).toHaveBeenCalledExactlyOnceWith('!assistant:test'))
  })

  it('says nothing in the conversation about paused listening; its switch in reply settings stays on', async () => {
    const { emit, bridge } = legacyFixture()
    emit({
      ...controlsState,
      hermesListening: {
        state: 'paused',
        mode: 'continuous',
        roomId: '!assistant:test',
        expiresAt: Date.now() + 60000,
        queued: 0,
        reason: 'overflow'
      }
    })

    const stack = () => window.document.querySelector('[data-matrix-status-stack]')?.textContent ?? ''
    expect(stack()).not.toContain(matrixActionCopy.en.continuousListeningPaused)
    expect(screen.queryByRole('button', { name: 'Resume listening' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop listening' })).toBeNull()
    openAssistantOptions()
    const dialog = within(screen.getByRole('dialog'))
    // Paused but on: the switch stays on, with no recovery button beside it; the rare paths
    // wait under Advanced, and cannot start a second watch.
    const reply = dialog.getByRole('switch', { name: 'Reply in this conversation' })
    expect(reply.getAttribute('aria-checked')).toBe('true')
    expect(dialog.queryByRole('button', { name: 'Resume listening' })).toBeNull()
    expect(dialog.queryByText(matrixActionCopy.en.continuousListeningPaused)).toBeNull()
    fireEvent.click(dialog.getByRole('button', { name: 'Advanced' }))
    expect((dialog.getByRole('button', { name: 'Only for the next 15 minutes' }) as HTMLButtonElement).disabled).toBe(
      true
    )

    // The person's durable off is the switch.
    fireEvent.click(reply)
    await waitFor(() =>
      expect(bridge.setContinuousListening).toHaveBeenCalledExactlyOnceWith('!assistant:test', false, 'en')
    )
  })

  it('shows nothing for an interrupted automatic request: it recovers by itself', async () => {
    const { emit, bridge } = fixture()
    emit({
      ...controlsState,
      hermesListening: {
        state: 'listening',
        mode: 'continuous',
        roomId: '!assistant:test',
        expiresAt: Date.now() + 60000,
        queued: 0,
        interruptedEventId: '$do-not-display'
      }
    })
    const stack = window.document.querySelector('[data-matrix-status-stack]')?.textContent ?? ''
    expect(stack).not.toContain('interrupted')
    expect(stack).not.toContain('$do-not-display')
    expect(screen.queryByRole('button', { name: 'Resume listening' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop listening' })).toBeNull()
    expect(bridge.setContinuousListening).not.toHaveBeenCalled()
    expect(bridge.invokeHermes).not.toHaveBeenCalled()
    expect(bridge.recoverHermes).not.toHaveBeenCalled()
    await act(async () => {})
  })

  it('says a Stop this Mac could not save in reply settings, where the switch presses Stop again', async () => {
    const { emit, bridge } = legacyFixture()
    emit({
      ...controlsState,
      hermesListening: {
        state: 'paused',
        mode: 'continuous',
        roomId: '!assistant:test',
        expiresAt: 0,
        queued: 0,
        reason: 'storage'
      }
    })
    expect(window.document.querySelector('[data-matrix-status-stack]')?.textContent ?? '').not.toMatch(
      /couldn.t save that/
    )
    openAssistantOptions()
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText(matrixActionCopy.en.listeningPausedStorage)).toBeTruthy()
    fireEvent.click(dialog.getByRole('switch', { name: 'Reply in this conversation' }))
    await waitFor(() => expect(bridge.setContinuousListening).toHaveBeenCalledWith('!assistant:test', false, 'en'))
  })

  it.each(['vi', 'en', 'ja', 'zh', 'zh-hant'] as const)(
    'notes in %s reply settings, and only there, that this Mac keeps handing the assistant over',
    async locale => {
      const { emit } = legacyFixture(async () => signedOut, locale)

      const agent = {
        principal: 'default',
        userId: '@atum:test',
        isDefault: true,
        ready: true,
        hermes: 'ready' as const,
        atumModel: true
      }

      const note = matrixChatCopy(locale).replyHandover('Atum')

      emit({ ...controlsState, agents: [agent] })
      openAssistantOptions(locale)
      expect(within(screen.getByRole('dialog')).queryByText(note)).toBeNull()
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

      emit({ ...controlsState, agents: [{ ...agent, answeringTrouble: 'handover' }] })
      expect(screen.queryByText(note)).toBeNull()
      openAssistantOptions(locale)
      expect(within(screen.getByRole('dialog')).getByText(note)).toBeTruthy()
      // A note, never a button.
      expect(
        within(screen.getByRole('dialog'))
          .getAllByRole('button')
          .some(each => each.textContent === note)
      ).toBe(false)
    }
  )

  it.each(['default', 'named'] as const)('never says a %s agent listening outcome in any chat', async kind => {
    const { emit } = fixture()

    const listening = {
      state: 'stopped' as const,
      roomId: '!failed:test',
      expiresAt: 0,
      queued: 0,
      result: 'publication_pending' as const
    }

    for (const roomId of ['!assistant:test', '!failed:test']) {
      emit({
        ...controlsState,
        roomId,
        rooms: [...controlsState.rooms, { ...controlsState.rooms[0]!, id: '!failed:test', name: 'Failed agent room' }],
        hermesListening: kind === 'default' ? listening : undefined,
        agents:
          kind === 'named'
            ? [
                {
                  principal: 'other',
                  userId: '@other:test',
                  name: 'Other agent',
                  isDefault: false,
                  ready: true,
                  hermes: 'ready',
                  atumModel: true,
                  listening
                }
              ]
            : undefined
      })
      expect(screen.queryByText(matrixActionCopy.en.actionPending)).toBeNull()
      expect(screen.queryByText(new RegExp(`${matrixActionCopy.en.listeningStopped} · Failed agent room`))).toBeNull()
    }

    await act(async () => {})
  })

  it.each(['found', 'error'] as const)('retains recovery %s after its message menu closes', async outcome => {
    const { emit, bridge } = fixture()
    let finish!: () => void
    vi.mocked(bridge.recoverHermes).mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          finish = () => (outcome === 'found' ? resolve({ state: 'unknown' }) : reject(new Error('synthetic')))
        })
    )
    emit(controlsState)
    openMessageActions()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Find the answer' }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await act(async () => finish())

    const notice = await screen.findByText(
      outcome === 'found' ? /No earlier answer found/ : /Couldn.t look for the earlier answer/
    )

    expect(notice.closest('[data-slot="aui_user-message-root"]')).toBeTruthy()
    expect(bridge.recoverHermes).toHaveBeenCalledOnce()
    expect(bridge.invokeHermes).not.toHaveBeenCalled()
  })

  it('does not disguise a former member or a federated namesake as the agent', async () => {
    const { emit } = fixture()
    const message = controlsState.messages[0]!
    const group = { id: '!group:test', name: 'Team', membership: 'join' as const, encrypted: true }
    emit({
      ...controlsState,
      roomId: group.id,
      rooms: [...controlsState.rooms, group],
      messages: [
        { ...message, own: false, sender: '@former:test', body: 'Former member', id: '$former' },
        { ...message, own: false, sender: '@atum:foreign.test', body: 'Unrelated sender', id: '$foreign' }
      ]
    })
    expect(screen.getByText('former')).toBeTruthy()
    expect(screen.getByText('@atum:foreign.test')).toBeTruthy()
    await act(async () => {})
  })

  it('names people by the name the room knows them by, never by a raw address', async () => {
    const { emit } = fixture()
    const message = controlsState.messages[0]!
    const group = { id: '!group:test', name: 'Team', membership: 'join' as const, encrypted: true }
    emit({
      ...controlsState,
      roomId: group.id,
      rooms: [...controlsState.rooms, group],
      members: [
        { userId: '@owner:test', name: 'Owner', membership: 'join', canRemove: false },
        { userId: '@linh:test', name: 'Linh', membership: 'join', canRemove: false },
        { userId: '@sam:test', name: 'Sam', membership: 'join', canRemove: false },
        // A new person's ID is opaque; the SDK adds it to a name two members share.
        {
          userId: '@user-7b1e0c9d8a7f6e5d4c3b2a1f0e9d8c7b:test',
          name: 'Sam (@user-7b1e0c9d8a7f6e5d4c3b2a1f0e9d8c7b:test)',
          membership: 'join',
          canRemove: false
        },
        { userId: '@atum:foreign.test', name: 'Atum', membership: 'join', canRemove: false }
      ],
      messages: [
        { ...message, own: false, sender: '@linh:test', body: 'From Linh', id: '$linh' },
        {
          ...message,
          own: false,
          sender: '@user-7b1e0c9d8a7f6e5d4c3b2a1f0e9d8c7b:test',
          body: 'From the second Sam',
          id: '$sam'
        },
        { ...message, own: false, sender: '@atum:foreign.test', body: 'From elsewhere', id: '$foreign' }
      ]
    })
    expect(screen.getByText('Linh')).toBeTruthy()
    expect(screen.queryByText('@linh:test')).toBeNull()
    // Two people share a name: with no verified handle, a short mark tells them apart, never the ID.
    expect(screen.getByText('Sam (#7b1e)')).toBeTruthy()
    expect(screen.queryByText(/user-7b1e0c9d/)).toBeNull()
    // Another server's "Atum" keeps its address in view.
    expect(screen.getByText('Atum (@atum:foreign.test)')).toBeTruthy()
    expect(window.document.querySelector('[data-slot="aui_assistant-message-root"] [title^="@"]')).toBeNull()
    await act(async () => {})
  })

  it('keeps document pending state and failure until room controls can safely close', async () => {
    const { emit, bridge } = legacyFixture()
    let reject!: (error: Error) => void

    vi.mocked(bridge.document).mockImplementation(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail
        })
    )

    emit({ ...controlsState, linkedDocument: { name: 'notes.txt', state: 'linked' } })
    openAssistantOptions()
    const dialog = screen.getByRole('dialog')
    expect(screen.getAllByRole('button', { name: 'Remove document' })).toHaveLength(1)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove document' }))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    await act(async () => reject(new Error('synthetic')))
    expect(within(dialog).getByText(/Choose a file under 20 MB/)).toBeTruthy()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('clears hidden setup secrets without discarding pending setup or triggering another save', async () => {
    const { emit, bridge } = localRuntimeSettingsFixture()
    let finish!: (value: { state: 'ready' }) => void
    vi.mocked(bridge.configureHermes).mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    emit(controlsState)
    openAssistantSetup()
    toggleDetails('Use your own model')
    fireEvent.change(screen.getByLabelText('Service address'), {
      target: { value: 'https://model.test/v1' }
    })
    fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'test-model' } })
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'test-only-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    showSettingsPane('general')
    await waitFor(() => expect((screen.getByLabelText(/API key/) as HTMLInputElement).value).toBe(''))
    showSettingsPane('assistant')
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
    expect(bridge.configureHermes).toHaveBeenCalledOnce()
    await act(async () => finish({ state: 'ready' }))
    expect(screen.getByText(/^Saved\. Your assistant now answers/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'another-test-key' } })
    closeAccountSettings()
    await waitFor(() => expect((screen.getByLabelText(/API key/) as HTMLInputElement).value).toBe(''))
    openAccountSettings()
    emit({ ...controlsState, identity: { userId: '@bob:test', deviceId: 'B' } })
    expect(settingsSheet().hidden).toBe(true)
    expect((screen.getByLabelText('Model name') as HTMLInputElement).value).toBe('')
  })

  it('keeps Retry (run in place) and read-only recovery bound to the original unanswered message', async () => {
    const { emit, bridge } = fixture()
    emit(controlsState)
    openMessageActions()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Retry' }))
    await screen.findByText('Cancelled. Nothing was run.')
    expect(bridge.invokeHermes).toHaveBeenCalledWith('!assistant:test', '$request', 'en')
    openMessageActions()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Find the answer' }))
    await screen.findByText('No earlier answer found. Nothing was run again.')
    expect(bridge.recoverHermes).toHaveBeenCalledWith('!assistant:test', '$request')
    expect(bridge.invokeHermes).toHaveBeenCalledOnce()
    expect(bridge.sendAssistant).not.toHaveBeenCalled()
    expect(bridge.command).not.toHaveBeenCalled()
  })

  it("shows the assistant's notice about a held reply as a quiet line, and the reply still runs in place", async () => {
    const { emit, bridge } = fixture()

    const notice = {
      ...controlsState.messages[0]!,
      id: '$notice',
      sender: '@atum:test',
      own: false,
      body: matrixActionCopy.en.replyQuoteUnreadable,
      replyTo: '$request',
      notice: true,
      timestamp: 2
    }

    emit({ ...controlsState, messages: [...controlsState.messages, notice] })
    const line = await screen.findByText(matrixActionCopy.en.replyQuoteUnreadable)
    expect(line.closest('[data-matrix-notice]')).toBeTruthy()
    // Status, not an answer: no toolbar offers to ask the held reply again without its quote.
    expect(line.closest('[data-matrix-message-id]')!.querySelector('[data-matrix-message-toolbar]')).toBeNull()

    // The held reply is still unanswered: Retry runs it in place, where its quote is read again.
    openMessageActions()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Retry' }))
    await screen.findByText('Cancelled. Nothing was run.')
    expect(bridge.invokeHermes).toHaveBeenCalledWith('!assistant:test', '$request', 'en')
    expect(bridge.sendAssistant).not.toHaveBeenCalled()
    expect(bridge.command).not.toHaveBeenCalled()
  })

  it('reports one message from someone else after a short confirmation, without moderation side effects', async () => {
    const { emit, bridge, view } = fixture()

    const message = {
      ...controlsState.messages[0]!,
      id: '$report',
      sender: '@bob:test',
      body: 'Do not send this text as report detail',
      own: false
    }

    emit({ ...controlsState, messages: [message] })
    const trigger = view.container.querySelector<HTMLButtonElement>('[data-matrix-report-message]')
    expect(trigger).toBeTruthy()
    fireEvent.keyDown(trigger!, { key: 'Enter' })
    expect(bridge.command).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Report' }))
    const confirm = screen.getByRole('dialog', { name: 'Report this message?' })
    expect(within(confirm).getByText(/doesn’t include the message text/)).toBeTruthy()
    expect(bridge.command).not.toHaveBeenCalled()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Report' }))
    await waitFor(() =>
      expect(bridge.command).toHaveBeenCalledExactlyOnceWith({
        kind: 'reportEvent',
        roomId: '!assistant:test',
        eventId: '$report',
        userId: '@bob:test'
      })
    )
    expect(await screen.findByText('Report sent.')).toBeTruthy()
    expect(bridge.command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'ignore' }))
    expect(bridge.command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'ban' }))
    expect(bridge.command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'leave' }))
  })

  it("never offers Report on your own assistant's answers, which carry Copy instead", async () => {
    const { emit, view } = fixture()
    emit({
      ...controlsState,
      messages: [
        controlsState.messages[0]!,
        {
          ...controlsState.messages[0]!,
          id: '$answer',
          sender: '@atum:test',
          own: false,
          body: 'The answer',
          replyTo: '$request'
        }
      ]
    })

    expect(view.container.querySelector('[data-matrix-report-message]')).toBeNull()
    // R9 puts the four answer actions below the answer; read-aloud and message-specific actions stay in "…".
    const actions = view.container.querySelector<HTMLElement>('[data-matrix-answer-actions]')!
    expect(within(actions).getByRole('button', { name: 'Copy' })).toBeTruthy()
    expect(within(actions).getByRole('button', { name: 'Good answer' })).toBeTruthy()
    expect(within(actions).getByRole('button', { name: 'Bad answer' })).toBeTruthy()
    expect(within(actions).getByRole('button', { name: 'Retry' })).toBeTruthy()

    const toolbar = view.container.querySelector<HTMLElement>(
      '[data-matrix-message-id="$answer"] [data-matrix-message-toolbar]'
    )!

    expect(within(toolbar).queryByRole('button', { name: 'Copy' })).toBeNull()
    fireEvent.keyDown(toolbar.querySelector('[data-matrix-answer-menu]')!, { key: 'Enter' })
    expect(screen.getByRole('menuitem', { name: 'Copy' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Retry' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Report' })).toBeNull()
  })

  it('keeps a failed report in its confirmation, where it can be sent again', async () => {
    const command = vi
      .fn<MatrixUiBridge['command']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(null)

    const { emit, view } = fixture(undefined, 'en', undefined, command)
    emit({
      ...controlsState,
      messages: [{ ...controlsState.messages[0]!, id: '$retry-report', sender: '@bob:test', own: false }]
    })

    fireEvent.keyDown(view.container.querySelector<HTMLButtonElement>('[data-matrix-report-message]')!, {
      key: 'Enter'
    })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Report' }))
    const confirm = screen.getByRole('dialog', { name: 'Report this message?' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Report' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    expect(await within(confirm).findByText('That didn’t work. Try again.')).toBeTruthy()
    expect(screen.queryByText('Report sent.')).toBeNull()

    fireEvent.click(within(confirm).getByRole('button', { name: 'Report' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Report sent.')).toBeTruthy()
  })

  it.each([
    ['en', 'Report', 'Report this message?', 'Report sent.'],
    ['vi', 'Báo cáo', 'Báo cáo tin nhắn này?', 'Đã gửi báo cáo.'],
    ['ja', '報告', 'このメッセージを報告しますか？', '報告しました。'],
    ['zh', '举报', '举报这条消息？', '已举报。'],
    ['zh-hant', '檢舉', '檢舉這則訊息？', '已檢舉。']
  ] as const)('localizes the report confirmation in %s', async (locale, report, title, sent) => {
    const { emit, view } = fixture(undefined, locale)
    emit({
      ...controlsState,
      messages: [{ ...controlsState.messages[0]!, id: `$report-${locale}`, sender: '@bob:test', own: false }]
    })
    fireEvent.keyDown(view.container.querySelector<HTMLButtonElement>('[data-matrix-report-message]')!, {
      key: 'Enter'
    })
    fireEvent.click(screen.getByRole('menuitem', { name: report }))
    fireEvent.click(within(screen.getByRole('dialog', { name: title })).getByRole('button', { name: report }))
    expect(await screen.findByText(sent)).toBeTruthy()
  })

  it.each([false, true])(
    'preserves pending setup through closing Settings and layout changes (compact=%s)',
    async compact => {
      vi.stubGlobal('innerWidth', compact ? 700 : 1220)
      const { emit, bridge, view } = localRuntimeSettingsFixture()
      let finish!: (value: { state: 'ready' }) => void
      vi.mocked(bridge.configureHermes).mockImplementation(
        () =>
          new Promise(resolve => {
            finish = resolve
          })
      )
      emit(controlsState)
      openAccountSettings()
      showSettingsPane('privacy')
      // Leaving the security pane discards any recovery material it held.
      openAssistantSetup()
      expect(bridge.command).toHaveBeenCalledWith({ kind: 'recoveryDiscard' })
      toggleDetails('Use your own model')
      const model = screen.getByLabelText('Model name') as HTMLInputElement
      const key = screen.getByLabelText(/API key/) as HTMLInputElement
      fireEvent.change(screen.getByLabelText('Service address'), {
        target: { value: 'https://model.test/v1' }
      })
      fireEvent.change(model, { target: { value: 'retained-model' } })
      fireEvent.change(key, { target: { value: 'test-only-key' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      closeAccountSettings()
      expect(key.value).toBe('')
      vi.stubGlobal('innerWidth', compact ? 1220 : 700)
      fireEvent(window, new Event('resize'))
      openAccountSettings()
      expect(screen.getByLabelText('Model name')).toBe(model)
      expect(model.value).toBe('retained-model')
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
      expect(bridge.cancelHermes).toHaveBeenCalledOnce()
      closeAccountSettings()
      await act(async () => finish({ state: 'ready' }))
      openAccountSettings()
      expect(screen.getByText(/^Saved\. Your assistant now answers/)).toBeTruthy()
      expect(bridge.configureHermes).toHaveBeenCalledOnce()
      // The account's registration is read each time its pane is shown, not on each render.
      expect(bridge.enrollment).toHaveBeenCalledTimes(3)
      expect(view.container.querySelectorAll('[data-atum-roster]')).toHaveLength(1)
      emit({ ...controlsState, identity: { userId: '@bob:test', deviceId: 'B' } })
      expect((screen.getByLabelText('Model name') as HTMLInputElement).value).toBe('')
      expect(screen.queryByText(/^Saved\. Your assistant now answers/)).toBeNull()
    }
  )

  it('retains pending enrollment and domain cancellation across closing Settings without starting another operation', async () => {
    const { emit, bridge } = fixture()
    let finish!: (value: Awaited<ReturnType<MatrixUiBridge['enrollHermes']>>) => void
    vi.mocked(bridge.enrollHermes).mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    emit(controlsState)
    openAssistantSetup()
    toggleDetails('Technical details')
    await screen.findByText('Not connected')
    fireEvent.click(screen.getByRole('button', { name: 'Connect assistant' }))
    closeAccountSettings()
    openAccountSettings()
    expect((screen.getByRole('button', { name: 'Connect assistant' }) as HTMLButtonElement).disabled).toBe(true)
    expect(bridge.enrollment).toHaveBeenCalledOnce()
    closeAccountSettings()
    vi.mocked(bridge.enrollment).mockResolvedValue({ state: 'ready', identity: null })
    await act(async () => finish({ state: 'ready', identity: null }))
    openAccountSettings()
    expect(screen.getByText('Connected on this Mac')).toBeTruthy()
    expect(bridge.enrollHermes).toHaveBeenCalledOnce()
    expect(bridge.enrollment).toHaveBeenCalledTimes(2)
    let finishRead!: (value: Awaited<ReturnType<MatrixUiBridge['readDomain']>>) => void
    vi.mocked(bridge.readDomain).mockImplementation(
      () =>
        new Promise(resolve => {
          finishRead = resolve
        })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Check your Atum account' }))
    closeAccountSettings()
    openAccountSettings()
    fireEvent.click(within(settingsSheet()).getByRole('button', { name: 'Cancel' }))
    expect(bridge.cancelDomain).toHaveBeenCalledOnce()
    await act(async () => finishRead({ issuer: 'https://id.test/', subject: 'owner', principal: 'discarded' }))
    expect(screen.queryByText(/Account ID: discarded/)).toBeNull()
    expect(bridge.readDomain).toHaveBeenCalledOnce()
  })

  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)(
    'distinguishes identical same-second message actions by localized position in %s',
    async locale => {
      const { emit, bridge, view } = fixture(undefined, locale)
      const messages = [controlsState.messages[0], { ...controlsState.messages[0], id: '$second', timestamp: 999 }]
      emit({ ...controlsState, messages })
      const actions = [...view.container.querySelectorAll<HTMLButtonElement>('[data-matrix-message-actions]')]
      expect(actions).toHaveLength(2)
      const format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' })

      const positions = {
        en: ['Message 1', 'Message 2'],
        vi: ['Tin nhắn 1', 'Tin nhắn 2'],
        ja: ['メッセージ 1', 'メッセージ 2'],
        zh: ['第 1 条消息', '第 2 条消息'],
        'zh-hant': ['第 1 則訊息', '第 2 則訊息']
      }

      for (const [index, action] of actions.entries()) {
        expect(action.getAttribute('aria-label')).toBe(
          `${
            {
              en: 'Message actions',
              vi: 'Thao tác tin nhắn',
              ja: 'メッセージの操作',
              zh: '消息操作',
              'zh-hant': '訊息操作'
            }[locale]
          } · ${positions[locale][index]} · ${format.format(messages[index].timestamp)}`
        )
      }

      expect(actions[0].getAttribute('aria-label')).not.toBe(actions[1].getAttribute('aria-label'))
      expect(bridge.invokeHermes).not.toHaveBeenCalled()
      await act(async () => {})
    }
  )
  it('clears a previous rejected sign-in notice when the user retries', async () => {
    const { bridge, emit } = fixture()
    vi.mocked(bridge.signIn).mockRejectedValueOnce(new Error('matrix_operation_failed'))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }))
    await screen.findByRole('status')
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
    emit({ ...signedOut, state: 'signing_in' })
    await waitFor(() =>
      expect(screen.queryByText('Could not complete the operation. Check the connection and try again.')).toBeNull()
    )
    emit(signedOut)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('Home and background roster updates preserve the foreground human conversation', async () => {
    const { emit, bridge } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const rooms = [
      { ...assistantFields, id: '!assistant:test', name: 'Atum', assistant: true, membership: 'join', encrypted: true },
      { id: '!human:test', name: 'Morgan', membership: 'join', encrypted: true }
    ]

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      assistant: { userId: '@atum:test', deviceId: 'ATUM' },
      rooms,
      roomId: '!human:test'
    }

    emit(state)
    fireEvent.click(await screen.findByRole('button', { name: 'Chats' }))
    emit({ ...state, rooms: rooms.map(room => ({ ...room, favourite: true, lastActiveAt: 1000 })) })
    expect(bridge.command).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'searches the live roster without navigating or losing the draft (compact=%s)',
    async compact => {
      vi.stubGlobal('innerWidth', compact ? 700 : 1220)

      const state: MatrixSnapshot = {
        ...signedOut,
        state: 'ready',
        identity: { userId: '@owner:test', deviceId: 'DEVICE' },
        assistant: { userId: '@atum:test', deviceId: 'ATUM' },
        agents: [
          {
            principal: 'default',
            userId: '@atum:test',
            name: 'Điều phối',
            isDefault: true,
            ready: true,
            hermes: 'ready',
            atumModel: true
          }
        ],
        roomId: '!human:test',
        rooms: [
          { ...assistantFields, id: '!assistant:test', name: 'Budget', membership: 'join', encrypted: true },
          {
            id: '!human:test',
            name: 'Bản kê',
            membership: 'join',
            encrypted: true,
            favourite: true,
            unreadNotifications: 3
          },
          { id: '!other:test', name: 'Morgan', membership: 'join', encrypted: true }
        ]
      }

      const { bridge, emit, view } = fixture(async () => state)
      const composer = (await screen.findByRole('textbox', { name: COMPOSER })) as HTMLInputElement
      fireEvent.change(composer, { target: { value: 'Keep this draft' } })

      if (compact) {
        fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }))
      }

      const roster = within(view.container.querySelector<HTMLElement>('[data-atum-roster]')!)
      const query = roster.getByRole('textbox', { name: 'Search everything' }) as HTMLInputElement
      fireEvent.change(query, { target: { value: '  BAN KE ' } })

      expect(roster.getByText('Bản kê')).toBeTruthy()
      expect(roster.getByRole('button', { name: 'Bản kê' })).toBeTruthy()
      expect(roster.getByText('Pinned')).toBeTruthy()
      expect(roster.getByLabelText('Unread notifications: 3')).toBeTruthy()
      expect(roster.queryByRole('button', { name: /^Điều phối$/ })).toBeNull()
      expect(roster.queryByText('Morgan')).toBeNull()
      expect(
        view.container.querySelector('[data-matrix-room="!human:test"] [aria-current]')?.getAttribute('aria-current')
      ).toBe('page')
      expect(composer.value).toBe('Keep this draft')
      expect(bridge.command).not.toHaveBeenCalled()

      // The primary is found by the name it goes by (owner decision D1: it is renameable).
      fireEvent.change(query, { target: { value: 'dieu phoi' } })
      expect(roster.getByRole('button', { name: /^Điều phối$/ })).toBeTruthy()
      // One row for the assistant: its chat is never listed under it.
      expect(roster.queryByText('Budget')).toBeNull()
      expect(composer.value).toBe('Keep this draft')
      expect(bridge.command).not.toHaveBeenCalled()

      // A real subscribed name update participates in the same filter immediately.
      fireEvent.change(query, { target: { value: 'budget revised' } })
      expect(roster.queryByRole('button', { name: /^Điều phối$/ })).toBeNull()
      emit({
        ...state,
        rooms: state.rooms.map(room => (room.id === '!assistant:test' ? { ...room, name: 'Budget revised' } : room))
      })
      expect(roster.getByRole('button', { name: /^Điều phối$/ })).toBeTruthy()
      expect(roster.queryByText('Budget revised')).toBeNull()
      fireEvent.click(roster.getByRole('button', { name: 'Clear search' }))
      expect(query.value).toBe('')
      expect(roster.getByText('Morgan')).toBeTruthy()
      expect(composer.value).toBe('Keep this draft')
      expect(bridge.command).not.toHaveBeenCalled()
    }
  )

  it('groups a directory person from the roster search and starts a direct chat', async () => {
    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      rooms: [],
      roomId: null
    }

    const search = vi.fn(async () => ({
      ok: true as const,
      value: { limited: false, results: [{ userId: '@user-opaque:test', name: 'Poon Nguyen', handle: 'poon' }] }
    }))

    const command = vi.fn<MatrixUiBridge['command']>(async input => input.kind === 'create' ? '!poon:test' : null)

    const { view } = fixture(async () => state, 'en', undefined, command, undefined, undefined, undefined, {
      people: {
        search,
        privacy: vi.fn(async () => ({ ok: true as const, enabled: true })),
        setPrivacy: vi.fn(async enabled => ({ ok: true as const, enabled }))
      }
    })

    const query = await screen.findByRole('textbox', { name: 'Search everything' })
    const roster = within(query.closest<HTMLElement>('[data-atum-roster]')!)
    fireEvent.change(query, { target: { value: '@poon' } })

    const person = await roster.findByRole('button', { name: 'Poon Nguyen' })
    expect(roster.getByRole('heading', { name: 'People' })).toBeTruthy()
    expect(within(person).getByText('@poon')).toBeTruthy()
    expect(search).toHaveBeenCalledWith({ query: '@poon', limit: 20 })

    fireEvent.click(person)
    await waitFor(() => {
      expect(command).toHaveBeenCalledWith({ kind: 'create', name: '', invite: ['@user-opaque:test'], direct: true })
      expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: '!poon:test' })
    })
  })

  it('uses a global handle result to find and identify that person’s existing chat', async () => {
    const personId = '@user-opaque:test'

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      rooms: [{
        id: '!poon:test', name: 'Poon Nguyen', membership: 'join', encrypted: false, direct: true,
        participants: [
          { userId: '@owner:test', membership: 'join' },
          { userId: personId, membership: 'join' }
        ]
      }],
      roomId: null
    }

    const search = vi.fn(async () => ({
      ok: true as const,
      value: { limited: false, results: [{ userId: personId, name: 'Poon Nguyen', handle: 'poon' }] }
    }))

    const { view } = fixture(async () => state, 'en', undefined, undefined, undefined, undefined, undefined, {
      people: {
        search,
        privacy: vi.fn(async () => ({ ok: true as const, enabled: true })),
        setPrivacy: vi.fn(async enabled => ({ ok: true as const, enabled }))
      }
    })

    const query = await screen.findByRole('textbox', { name: 'Search everything' })
    const roster = within(query.closest<HTMLElement>('[data-atum-roster]')!)
    fireEvent.change(query, { target: { value: '@poon' } })

    const chat = await roster.findByRole('button', { name: 'Poon Nguyen' })
    expect(await within(chat).findByText('@poon')).toBeTruthy()
    expect(roster.queryByRole('heading', { name: 'People' })).toBeNull()
    expect(view.container.querySelector('[data-matrix-room="!poon:test"]')).toBeTruthy()
  })

  it('keeps a directory person visible while slower message and file sources finish empty', async () => {
    const room: MatrixRoom = {
      id: '!launch:test',
      name: 'launch',
      membership: 'join',
      encrypted: false,
      roomType: MATRIX_COMPANY_CHANNEL_TYPE,
      companyChannel: { companyId: 'company-a', channelId: '00000000-0000-4000-8000-676a3a34ff0f' }
    }

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      rooms: [room],
      roomId: null
    }

    const peopleSearch = vi.fn(async () => ({
      ok: true as const,
      value: { limited: false, results: [{ userId: '@user-opaque:test', name: 'Poon Nguyen' }] }
    }))

    let finishCompanySearch = () => {}

    const companyGate = new Promise<void>(resolve => {
      finishCompanySearch = resolve
    })

    const companySearch = vi.fn<NonNullable<MatrixCompanyBridge['search']>>(async input => {
      await companyGate

      return {
        ok: true as const,
        value: {
          schemaVersion: 1 as const,
          companyId: input.companyId,
          query: input.query,
          coverage: { eligibleRooms: 1, searchedRooms: 1, truncated: false },
          results: []
        }
      }
    })

    const companies = { ...companyWorkspaceWithChannel(room.id), search: companySearch }

    fixture(async () => state, 'en', undefined, undefined, undefined, companies, undefined, {
      people: {
        search: peopleSearch,
        privacy: vi.fn(async () => ({ ok: true as const, enabled: true })),
        setPrivacy: vi.fn(async enabled => ({ ok: true as const, enabled }))
      }
    })

    const query = await screen.findByRole('textbox', { name: 'Search everything' })
    const roster = within(query.closest<HTMLElement>('[data-atum-roster]')!)
    fireEvent.change(query, { target: { value: 'Poon' } })

    await waitFor(() => expect(peopleSearch).toHaveBeenCalledOnce())
    expect(await roster.findByRole('button', { name: 'Poon Nguyen' })).toBeTruthy()
    expect(roster.getByRole('status').textContent).toBe('Searching…')

    finishCompanySearch()
    await waitFor(() => expect(companySearch).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(roster.queryByRole('status')).toBeNull())
    expect(roster.getByRole('button', { name: 'Poon Nguyen' })).toBeTruthy()
  })

  it('drops an older people response after the query changes', async () => {
    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      rooms: [],
      roomId: null
    }

    const replies = new Map<string, (name: string) => void>()

    const search = vi.fn<NonNullable<MatrixUiBridge['people']>['search']>(input =>
      new Promise(resolve => {
        replies.set(input.query, name => resolve({
          ok: true as const,
          value: { limited: false, results: [{ userId: `@${name.toLowerCase()}:test`, name }] }
        }))
      }))

    fixture(async () => state, 'en', undefined, undefined, undefined, undefined, undefined, {
      people: {
        search,
        privacy: vi.fn(async () => ({ ok: true as const, enabled: true })),
        setPrivacy: vi.fn(async enabled => ({ ok: true as const, enabled }))
      }
    })

    const query = await screen.findByRole('textbox', { name: 'Search everything' })
    const roster = within(query.closest<HTMLElement>('[data-atum-roster]')!)

    fireEvent.change(query, { target: { value: 'Poon' } })
    await waitFor(() => expect(search).toHaveBeenCalledWith({ query: 'Poon', limit: 20 }))

    fireEvent.change(query, { target: { value: 'Linh' } })
    await waitFor(() => expect(search).toHaveBeenCalledWith({ query: 'Linh', limit: 20 }))

    replies.get('Linh')?.('Linh Tran')
    expect(await roster.findByRole('button', { name: 'Linh Tran' })).toBeTruthy()
    replies.get('Poon')?.('Poon Nguyen')
    await act(async () => {})

    expect(roster.queryByRole('button', { name: 'Poon Nguyen' })).toBeNull()
    expect(roster.getByRole('button', { name: 'Linh Tran' })).toBeTruthy()
  })

  it('does not re-request an unchanged people query on repeated sync ticks', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      rooms: [],
      roomId: null
    }

    const search = vi.fn(async () => ({ ok: true as const, value: { limited: false, results: [] } }))

    const { emit } = fixture(async () => state, 'en', undefined, undefined, undefined, undefined, undefined, {
      people: {
        search,
        privacy: vi.fn(async () => ({ ok: true as const, enabled: true })),
        setPrivacy: vi.fn(async enabled => ({ ok: true as const, enabled }))
      }
    })

    const query = await screen.findByRole('textbox', { name: 'Search everything' })

    fireEvent.change(query, { target: { value: 'Poon' } })
    await act(async () => void (await vi.advanceTimersByTimeAsync(251)))
    expect(search).toHaveBeenCalledOnce()

    for (let tick = 0; tick < 5; tick += 1) {
      emit({ ...state, rooms: [], messages: [] })
      await act(async () => void (await vi.advanceTimersByTimeAsync(251)))
    }

    expect(search).toHaveBeenCalledOnce()
  })

  it('resets roster search across account switches and sign-out without restoring another account query', async () => {
    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      rooms: [
        { id: '!human:test', name: 'Morgan', membership: 'join', encrypted: true },
        { id: '!other:test', name: 'Avery', membership: 'join', encrypted: true }
      ],
      roomId: '!human:test'
    }

    const { bridge, emit } = fixture(async () => state)
    const search = () => screen.getByRole('textbox', { name: 'Search everything' }) as HTMLInputElement
    await screen.findByRole('textbox', { name: 'Search everything' })
    fireEvent.change(search(), { target: { value: 'Morgan' } })
    expect(screen.queryByRole('button', { name: 'Avery' })).toBeNull()

    emit({ ...state, identity: { userId: '@other:test', deviceId: 'OTHER' } })
    expect(search().value).toBe('')
    expect(screen.getByRole('button', { name: 'Avery' })).toBeTruthy()
    fireEvent.change(search(), { target: { value: 'Avery' } })
    emit(state)
    expect(search().value).toBe('')
    expect(screen.getByRole('button', { name: 'Morgan' })).toBeTruthy()
    fireEvent.change(search(), { target: { value: 'Morgan' } })
    emit(signedOut)
    expect(screen.queryByRole('textbox', { name: 'Search everything' })).toBeNull()
    emit(state)
    expect(search().value).toBe('')
    expect(screen.getByRole('button', { name: 'Avery' })).toBeTruthy()
    expect(bridge.command).not.toHaveBeenCalled()
  })

  it('waits for SDK restoration readiness before choosing an assistant on a fresh foreground', async () => {
    const { emit, bridge } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'connecting',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      assistant: { userId: '@atum:test', deviceId: 'ATUM' },
      rooms: [
        {
          ...assistantFields,
          id: '!assistant:test',
          name: 'Atum',
          assistant: true,
          membership: 'join',
          encrypted: true
        }
      ]
    }

    emit(state)
    expect(bridge.command).not.toHaveBeenCalled()
    emit({ ...state, state: 'ready', roomId: '!restored:test' })
    expect(bridge.command).not.toHaveBeenCalled()
  })

  /** A chat row's context menu: Mark as unread, Rename, Pin, Mute, Leave (or Delete). */
  function openChatMenu(name: string) {
    fireEvent.contextMenu(screen.getByRole('button', { name }))
  }

  it("pins from a chat's menu without selecting it, rolls back on failure, and resets across accounts", async () => {
    const { emit, bridge } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      rooms: [{ id: '!human:test', name: 'Morgan', membership: 'join', encrypted: true }]
    }

    emit(state)
    let reject!: (error: Error) => void
    vi.mocked(bridge.command).mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )
    await screen.findByRole('button', { name: 'Morgan' })
    openChatMenu('Morgan')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin' }))
    expect(bridge.command).toHaveBeenCalledExactlyOnceWith({
      kind: 'favourite',
      roomId: '!human:test',
      favourite: true
    })
    openChatMenu('Morgan')
    // Shown at once, and not offered again until sync says so.
    expect(screen.getByRole('menuitem', { name: 'Unpin' }).getAttribute('aria-disabled')).toBe('true')
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await act(async () => reject(new Error('raw server data')))
    openChatMenu('Morgan')
    expect(screen.getByRole('menuitem', { name: 'Pin' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(await screen.findByText('That didn’t work. Try again.')).toBeTruthy()
    expect(screen.queryByText(/raw server data/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('That didn’t work. Try again.')).toBeNull()
    emit({ ...state, identity: { userId: '@bob:test', deviceId: 'BOB' }, rooms: [] })
    expect(screen.queryByText('Morgan')).toBeNull()
  })

  it.each([true, false])('keeps pin feedback until sync, with bounded recovery when echo=%s', async echo => {
    const { emit, bridge } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const room = { id: '!human:test', name: 'Morgan', membership: 'join', encrypted: true }

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      rooms: [room]
    }

    emit(state)
    await screen.findByRole('button', { name: 'Morgan' })
    vi.useFakeTimers()
    openChatMenu('Morgan')
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'Pin' })))
    openChatMenu('Morgan')
    expect(screen.getByRole('menuitem', { name: 'Unpin' }).getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unpin' }))
    expect(bridge.command).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    if (echo) {
      emit({ ...state, rooms: [{ ...room, favourite: true }] })
      openChatMenu('Morgan')
      expect(screen.getByRole('menuitem', { name: 'Unpin' }).getAttribute('aria-disabled')).toBeNull()
    } else {
      await act(async () => vi.advanceTimersByTime(5000))
      openChatMenu('Morgan')
      expect(screen.getByRole('menuitem', { name: 'Pin' }).getAttribute('aria-disabled')).toBeNull()
    }
  })

  it('Home fallback follows visible pin order when there is no assistant or selected conversation', async () => {
    const { emit, bridge } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      rooms: [
        { id: '!other:test', name: 'Other', membership: 'join', encrypted: true },
        { id: '!pin:test', name: 'Pinned', membership: 'join', encrypted: true, favourite: true }
      ]
    })
    fireEvent.click(screen.getByRole('button', { name: 'Chats' }))
    expect(bridge.command).toHaveBeenCalledExactlyOnceWith({ kind: 'select', roomId: '!pin:test' })
  })

  it('limits new pins without hiding existing cross-client favourites or disabling unpin', async () => {
    const { emit, view, bridge } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      rooms: [
        { id: '!loose:test', name: 'Loose', membership: 'join', encrypted: true },
        ...Array.from({ length: 6 }, (_, index) => ({
          id: `!pin${index}:test`,
          name: `Pinned ${index}`,
          favourite: true,
          membership: 'join',
          encrypted: true
        }))
      ]
    })
    await screen.findByRole('button', { name: 'Loose' })
    openChatMenu('Loose')
    const limited = screen.getByRole('menuitem', { name: 'Pin up to 5 chats' })
    expect(limited.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(limited)
    expect(bridge.command).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    openChatMenu('Pinned 0')
    expect(screen.getByRole('menuitem', { name: 'Unpin' }).getAttribute('aria-disabled')).toBeNull()
    expect(view.container.querySelector('[data-matrix-room]')?.getAttribute('data-matrix-room')).toBe('!pin0:test')
  })
  it('does not shrink a restored signed-in window before the first real snapshot', async () => {
    let resolve!: (value: MatrixSnapshot) => void

    const { bridge } = fixture(
      () =>
        new Promise(done => {
          resolve = done
        })
    )

    expect(bridge.setWindowMode).not.toHaveBeenCalled()
    await act(async () =>
      resolve({ ...signedOut, state: 'ready', identity: { userId: '@owner:test', deviceId: 'DEVICE' } })
    )
    await waitFor(() => expect(bridge.setWindowMode).toHaveBeenCalledWith('normal'))
    expect(bridge.setWindowMode).not.toHaveBeenCalledWith('auth')
  })
  it('keeps the account at the rail foot and its face unmarked in every state', async () => {
    const { emit, bridge } = fixture()
    const ready: MatrixSnapshot = { ...signedOut, state: 'ready', identity: { userId: '@owner:test', deviceId: 'D' } }
    emit(ready)
    const account = await screen.findByRole('button', { name: 'Account: owner' })
    expect(account.closest('[data-atum-destination-rail]')).toBeTruthy()
    expect(account.querySelector('[data-tone]')).toBeNull()
    expect(window.document.querySelector('[data-atum-roster] [data-matrix-rail-account]')).toBeNull()

    emit({ ...ready, state: 'offline' })
    expect(account.querySelector('[data-tone]')).toBeNull()
    fireEvent.pointerDown(account, { button: 0 })
    const menu = await screen.findByRole('menu')
    // The handle repeats the name here, so it is not shown twice.
    expect(within(menu).getByText('owner')).toBeTruthy()
    expect(within(menu).queryByText('@owner')).toBeNull()
    expect(within(menu).getByRole('status').textContent).toBe('Offline · reconnecting')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Reconnect' }))
    expect(bridge.retry).toHaveBeenCalledOnce()
  })

  it('opens Settings from the account menu and ⌘, and makes the window behind it inert', async () => {
    const { emit } = fixture()
    emit({ ...signedOut, state: 'ready', identity: { userId: '@owner:test', deviceId: 'D' } })
    const account = await screen.findByRole('button', { name: 'Account: owner' })
    const shell = window.document.querySelector('[data-matrix-shell-layer]')!
    expect(settingsSheet().hidden).toBe(true)
    expect(settingsSheet().hasAttribute('inert')).toBe(true)
    expect(shell.hasAttribute('inert')).toBe(false)

    fireEvent.pointerDown(account, { button: 0 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Settings/ }))
    const dialog = screen.getByRole('dialog', { name: 'Account' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(shell.hasAttribute('inert')).toBe(true)
    // Focus is on the sheet itself: no row draws a ring until the keyboard moves.
    expect(window.document.activeElement).toBe(dialog)

    fireEvent.keyDown(window.document, { key: 'Escape' })
    expect(settingsSheet().hidden).toBe(true)
    expect(shell.hasAttribute('inert')).toBe(false)
    await waitFor(() => expect(window.document.activeElement).toBe(account))

    openAccountSettings()
    showSettingsPane('general')
    expect(screen.getByRole('dialog', { name: 'General' })).toBeTruthy()
    fireEvent.click(within(settingsSheet()).getByRole('button', { name: 'Close' }))
    expect(settingsSheet().hidden).toBe(true)
  })

  it('keeps one fixed Settings navigation and a pane into named sections of rows', async () => {
    const sourceGates = {
      google: true,
      folders: true,
      messages: true,
      browser: true,
      location: true,
      team_spaces: true
    }

    const agentSources = {
      read: vi.fn(async () => ({
        macs: [],
        gates: sourceGates,
        sources: [
          ['google.mail', 'google'],
          ['google.calendar', 'google'],
          ['google.drive', 'google'],
          ['mac.files', 'folders'],
          ['mac.message-metadata', 'messages'],
          ['mac.browser-history', 'browser'],
          ['mac.location', 'location'],
          ['matrix.owner-rooms', 'team_spaces']
        ].map(([kind, optOutGate]) => ({
          kind,
          optOutGate,
          grantable: true,
          availability: 'available' as const,
          status: 'ready' as const
        }))
      })),
      set: vi.fn()
    }

    const { emit } = fixture(undefined, 'en', undefined, undefined, undefined, undefined, agentSources)

    const settingsState: MatrixSnapshot = {
      ...controlsState,
      displayPreferences: {
        appearance: { value: 'system', writable: true },
        textSize: { value: 100, writable: true },
        notifications: { value: true, writable: true },
        sound: { value: true, writable: true }
      }
    }

    emit(settingsState)
    await screen.findByRole('button', { name: 'Account: owner' })
    openAccountSettings()
    const nav = within(settingsSheet()).getByRole('navigation', { name: 'Settings' })

    const destinations = [...nav.querySelectorAll('[data-matrix-settings-pane]')].map(row =>
      row.getAttribute('data-matrix-settings-pane')
    )

    // Atum Kit Settings: six pages; Protons, Privacy and This Mac are sections of their pages.
    expect(destinations).toEqual(['account', 'assistants', 'connections', 'general', 'help', 'advanced'])
    expect(within(nav).getAllByRole('group')).toHaveLength(3)

    for (const name of ['Account', 'Assistants', 'Connections', 'General', 'Help', 'Advanced']) {
      expect(within(nav).getByRole('button', { name })).toBeTruthy()
    }

    // Main's source controls and account subscriptions share the one Connections page.
    showSettingsPane('cloud')
    const knowledge = screen.getByRole('dialog', { name: 'Connections' })
    const sourceControls = await within(knowledge).findByRole('region', { name: 'What Atum can read' })
    expect(
      within(sourceControls)
        .getAllByRole('switch')
        .map(row => row.getAttribute('aria-label'))
    ).toEqual(['Google', 'Mac folders', 'Messages', 'Browser', 'Location', 'Team spaces'])
    expect(within(knowledge).queryByText(/Forget what Atum learned/)).toBeNull()

    // Account-wide: opening another assistant's chat neither re-reads nor resets these switches.
    const reads = agentSources.read.mock.calls.length
    emit({
      ...settingsState,
      roomId: '!alfred:test',
      rooms: [
        ...settingsState.rooms,
        {
          ...assistantFields,
          id: '!alfred:test',
          name: 'Alfred',
          membership: 'join',
          encrypted: true,
          assistant: true,
          agentPrincipal: 'cloud-alfred'
        }
      ]
    })
    await waitFor(() => expect(within(sourceControls).getAllByRole('switch')).toHaveLength(6))
    // At most the composer's one-time Mac sources check (once per account in this window); the
    // switches themselves are not re-read.
    expect(agentSources.read.mock.calls.length - reads).toBeLessThanOrEqual(1)
    expect(within(knowledge).queryByText(/this assistant/i)).toBeNull()

    // Each setting is a row in the section it belongs to, never a loose paragraph.
    showSettingsPane('general')
    const general = screen.getByRole('dialog', { name: 'General' })
    const display = within(general).getByRole('region', { name: 'Look' })
    expect(within(display).getByRole('radiogroup', { name: 'Text size' })).toBeTruthy()
    const notifications = within(general).getByRole('region', { name: 'Notifications' })
    expect(within(notifications).getByRole('switch', { name: 'Notifications' })).toBeTruthy()
    expect(within(notifications).getByRole('switch', { name: 'Sounds' })).toBeTruthy()
    expect(within(display).queryByRole('switch')).toBeNull()
  })

  it('does not open Settings while signed out', async () => {
    fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    fireEvent.keyDown(window, { key: ',', code: 'Comma', metaKey: true })
    expect(window.document.querySelector('[data-matrix-settings]')).toBeNull()
  })

  it('opens the real human photo editor from Account and retires its scope on sign-out', async () => {
    const { emit, bridge } = fixture()
    bridge.profiles = {
      read: vi.fn(async () => ({ userId: '@owner:test', displayName: 'Owner', avatarMxc: null, avatarUrl: null })),
      open: vi.fn(async () => ({ scope: 'human-editor' })),
      change: vi.fn(),
      close: vi.fn(async () => {}),
      member: vi.fn(async userId => ({ userId, avatarUrl: null }))
    }
    emit({ ...signedOut, state: 'ready', identity: { userId: '@owner:test', deviceId: 'D' } })
    await screen.findByRole('button', { name: 'Account: owner' })
    openAccountSettings()
    fireEvent.click(within(settingsSheet()).getByRole('button', { name: 'Edit profile' }))
    const editor = await screen.findByRole('dialog', { name: 'Edit profile' })
    expect(editor.className).toContain('atum-sheet')
    expect(editor.className).toContain('max-w-[520px]')
    expect(settingsSheet().hidden).toBe(true)
    expect(window.document.querySelector('[data-matrix-shell-layer]')?.hasAttribute('inert')).toBe(true)
    await waitFor(() => expect(bridge.profiles!.read).toHaveBeenCalledWith({ kind: 'human' }))
    fireEvent.keyDown(editor, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit profile' })).toBeNull())
    await waitFor(() =>
      expect(window.document.activeElement).toBe(screen.getByRole('button', { name: 'Account: owner' }))
    )
    openAccountSettings()
    fireEvent.click(within(settingsSheet()).getByRole('button', { name: 'Edit profile' }))
    await screen.findByRole('dialog', { name: 'Edit profile' })
    await waitFor(() => expect(bridge.profiles!.open).toHaveBeenCalledTimes(2))
    emit(signedOut)
    await screen.findByRole('button', { name: 'Continue with Google' })
    await waitFor(() => expect(bridge.profiles!.close).toHaveBeenCalledWith('human-editor'))
    expect(screen.queryByRole('dialog', { name: 'Edit profile' })).toBeNull()
    expect(bridge.createAgent).not.toHaveBeenCalled()
  })

  it('opens the assistant card from the roster on any Mac, and closes it when the assistant leaves', async () => {
    const { emit, bridge } = fixture()
    const principal = '00000000-0000-4000-8000-bd7662a5eeb4'

    const assistants = {
      read: vi.fn(async () => ({
        ok: true as const,
        card: {
          principal,
          displayName: 'Lan',
          isDefault: false,
          soul: '# Lan\n\n## What you do\n\nMeetings.',
          inherited: false,
          skills: [],
          definitionRevision: 2,
          identityRevision: 1
        }
      })),
      save: vi.fn(),
      avatar: vi.fn()
    }

    bridge.assistants = assistants

    const lan: MatrixAgentView = {
      principal,
      userId: '@lan:test',
      name: 'Lan',
      isDefault: false,
      // Not set up yet: the card still opens (it edits the account's record).
      ready: false,
      hermes: 'unavailable',
      atumModel: false
    }

    const ready = { ...controlsState, agents: [lan] }
    emit(ready)
    fireEvent.contextMenu(await screen.findByRole('button', { name: 'Lan' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit assistant… Lan' }))
    await screen.findByRole('dialog', { name: 'Lan info' })
    await waitFor(() => expect(assistants.read).toHaveBeenCalledWith(principal))
    expect(await screen.findByRole('textbox', { name: 'What does Lan help you with?' })).toBeTruthy()
    expect(screen.getByText('Not ready yet')).toBeTruthy()

    emit({ ...ready, agents: [] })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Lan info' })).toBeNull())
    expect(bridge.createAgent).not.toHaveBeenCalled()
  })

  it('confirms signing out from Settings, offering the recovery key first when none is saved', async () => {
    const { bridge, emit } = fixture(async () => ({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      security: { recovery: 'idle', storage: 'absent' }
    }))

    await screen.findByRole('button', { name: 'Account: owner' })
    openAccountSettings()
    fireEvent.click(within(settingsSheet()).getByRole('button', { name: 'Sign out' }))
    const confirm = await screen.findByRole('dialog', { name: 'Sign out of Atum on this Mac?' })
    expect(settingsSheet().hidden).toBe(true)
    expect(bridge.signOut).not.toHaveBeenCalled()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Set up recovery key first' }))
    await waitFor(() => expect(settingsSheet().hidden).toBe(false))
    expect(within(settingsSheet()).getByRole('heading', { name: 'Privacy & security' })).toBeTruthy()
    expect(bridge.signOut).not.toHaveBeenCalled()

    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      security: { recovery: 'idle', storage: 'present' }
    })
    closeAccountSettings()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Account: owner' }), { button: 0 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }))
    const again = await screen.findByRole('dialog', { name: 'Sign out of Atum on this Mac?' })
    expect(within(again).getByText(/You’ll need your recovery key/)).toBeTruthy()
    fireEvent.click(within(again).getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(bridge.signOut).toHaveBeenCalledOnce())
  })

  it('asks to save a key only this Mac keeps before signing out, and shows it in Privacy & Security', async () => {
    const quiet = {
      ...signedOut,
      state: 'ready' as const,
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      security: { recovery: 'idle' as const, storage: 'present' as const, custody: 'device' as const }
    }

    const { bridge, emit } = fixture(async () => quiet)

    const recovery = {
      // A sample, never a real key.
      reveal: vi.fn(async () => 'EsTc Samp leKe yNot ReaL 0000 1111 2222 3333 4444 5555 6666'),
      written: vi.fn(async () => {})
    }

    bridge.recoveryKey = recovery

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Account: owner' }), { button: 0 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }))
    const confirm = await screen.findByRole('dialog', { name: 'Sign out of Atum on this Mac?' })
    expect(within(confirm).getByText(/saved only on this Mac/)).toBeTruthy()
    expect(within(confirm).getByRole('button', { name: 'Sign out anyway' })).toBeTruthy()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Save your recovery key first' }))

    // Privacy opens on the key itself, ready to write down.
    await waitFor(() => expect(settingsSheet().hidden).toBe(false))
    expect(within(settingsSheet()).getByRole('heading', { name: 'Privacy & security' })).toBeTruthy()
    const privacy = settingsSheet()
    await waitFor(() => expect(recovery.reveal).toHaveBeenCalledOnce())
    expect(within(privacy).getByText('Saved on this Mac')).toBeTruthy()
    const key = (await within(privacy).findByLabelText('Recovery key')) as HTMLTextAreaElement
    expect(key.value).toMatch(/^EsTc/)
    expect(bridge.signOut).not.toHaveBeenCalled()

    const done = within(privacy).getByRole('button', { name: 'Done' })
    expect(done).toHaveProperty('disabled', true)
    fireEvent.click(within(privacy).getByRole('checkbox', { name: 'I’ve written it down' }))
    fireEvent.click(done)
    await waitFor(() => expect(recovery.written).toHaveBeenCalledOnce())
    await waitFor(() => expect(within(privacy).queryByLabelText('Recovery key')).toBeNull())

    // Written down: signing out asks only the ordinary question.
    emit({ ...quiet, security: { recovery: 'idle', storage: 'present' } })
    closeAccountSettings()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Account: owner' }), { button: 0 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }))
    const again = await screen.findByRole('dialog', { name: 'Sign out of Atum on this Mac?' })
    expect(within(again).getByText(/You’ll need your recovery key/)).toBeTruthy()
    expect(within(again).queryByRole('button', { name: 'Save your recovery key first' })).toBeNull()
  })

  it('invents no wallet, balance or checkout in the account menu without a provider', async () => {
    const { emit, bridge } = fixture()
    emit({ ...signedOut, state: 'ready', identity: { userId: '@owner:test', deviceId: 'D' } })
    const account = await screen.findByRole('button', { name: 'Account: owner' })
    fireEvent.pointerDown(account, { button: 0 })
    const signOut = await screen.findByRole('menuitem', { name: 'Sign out' })
    expect(screen.queryByRole('menuitem', { name: /Proton/ })).toBeNull()
    expect(window.document.querySelector('[data-matrix-balance]')).toBeNull()
    fireEvent.click(signOut)
    // Signing out is confirmed first.
    expect(bridge.signOut).not.toHaveBeenCalled()
    const confirm = await screen.findByRole('dialog', { name: 'Sign out of Atum on this Mac?' })
    // No recovery key confirmed on this account yet: the warning's version of the button.
    fireEvent.click(within(confirm).getByRole('button', { name: 'Sign out anyway' }))
    await waitFor(() => expect(bridge.signOut).toHaveBeenCalledOnce())
    expect(bridge.openTopUp).not.toHaveBeenCalled()
  })

  it('keeps technical identity but no local provider controls when the assistant domain appears', async () => {
    const { emit } = fixture(undefined, 'en', undefined, undefined, undefined, undefined, undefined, {}, true)
    const ready: MatrixSnapshot = { ...signedOut, state: 'ready', identity: { userId: '@owner:test', deviceId: 'D' } }
    emit(ready)
    await screen.findByRole('button', { name: 'Account: owner' })
    openAccountSettings()
    showSettingsPane('assistant')

    const advanced = () => settingsSheet().querySelector<HTMLElement>('[data-matrix-settings-destination="advanced"]')!
    expect(advanced().textContent).not.toContain('Use your own model')
    emit({ ...ready, domainEnabled: true })
    await waitFor(() => expect(within(advanced()).getByText('Technical details')).toBeTruthy())
    expect(within(advanced()).queryByText('Model')).toBeNull()
    expect(advanced().textContent).not.toContain('Use your own model')
    // No assistant has pages to open here, so there is no dead "For developers" row.
    expect(within(advanced()).queryByRole('heading', { name: 'For developers' })).toBeNull()
    expect(advanced().textContent).not.toMatch(/runs on this Mac|answers with Atum’s AI/iu)
    emit({ ...ready, domainEnabled: true, ownModel: true })
    await waitFor(() => expect(advanced().textContent).not.toMatch(/runs on this Mac|answers with your own model/iu))
  })

  it('moves native pages aside while the account menu or Settings is over them', async () => {
    const pages: MatrixPagesBridge = {
      open: vi.fn(async () => ({ viewId: 'settings-page' })),
      setBounds: vi.fn(async () => ({ ok: true as const })),
      setVisibility: vi.fn(async () => ({ ok: true as const })),
      focus: vi.fn(async () => ({ ok: true as const })),
      close: vi.fn(async () => ({ ok: true as const })),
      onState: vi.fn(() => vi.fn())
    }

    const ready: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      agents: [
        {
          principal: 'agent-1',
          userId: '@agent:test',
          name: 'Assistant',
          isDefault: true,
          ready: true,
          hermes: 'ready',
          atumModel: true
        }
      ]
    }

    fixture(
      async () => ({ ...ready, companyWorkspaceEnabled: true }),
      'en',
      pages,
      undefined,
      undefined,
      companyWorkspace()
    )
    await screen.findByRole('button', { name: 'Account: owner' })
    openScheduledPage()
    const last = () => vi.mocked(pages.setVisibility).mock.lastCall?.[0]
    await waitFor(() => expect(last()).toEqual({ viewId: 'settings-page', visible: true, overlayActive: false }))

    openAccountSettings()
    await waitFor(() => expect(last()).toEqual({ viewId: 'settings-page', visible: false, overlayActive: true }))
    closeAccountSettings()
    await waitFor(() => expect(last()).toEqual({ viewId: 'settings-page', visible: true, overlayActive: false }))

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Account: owner' }), { button: 0 })
    await waitFor(() => expect(last()).toEqual({ viewId: 'settings-page', visible: false, overlayActive: true }))
  })

  it('keeps the account on the rail in a compact window, beside the roster drawer', async () => {
    vi.stubGlobal('innerWidth', 700)
    const { emit, view } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    emit({ ...signedOut, state: 'ready', identity: { userId: '@owner:test', deviceId: 'DEVICE' } })
    const account = await screen.findByRole('button', { name: 'Account: owner' })
    expect(account.closest('[data-atum-destination-rail]')).toBeTruthy()
    fireEvent.pointerDown(account, { button: 0 })
    fireEvent.click(await screen.findByRole('menuitem', { name: /Settings/ }))
    expect(settingsSheet().hidden).toBe(false)
    expect(within(settingsSheet()).getByRole('heading', { name: 'Account' })).toBeTruthy()
    expect(within(settingsSheet()).getByRole('button', { name: 'Sign out' })).toBeTruthy()
    closeAccountSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }))
    expect(view.container.querySelector('[data-atum-roster]')?.getAttribute('data-atum-drawer')).toBe('true')
    expect(view.container.querySelector('[data-atum-roster]')?.classList.contains('w-(--atum-l-roster)')).toBe(true)
  })

  it('makes a group from the compact roster’s “+” and closes the drawer after success', async () => {
    vi.stubGlobal('innerWidth', 700)
    const { emit, view, bridge } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      rooms: [
        {
          id: '!alice:test',
          name: 'Alice',
          membership: 'join',
          encrypted: true,
          direct: true,
          participants: [
            { userId: '@owner:test', membership: 'join' },
            { userId: '@alice:test', membership: 'join' }
          ]
        }
      ]
    })
    fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }))
    const trigger = screen.getByRole('button', { name: 'New…' })
    expect(trigger.closest('[data-matrix-settings]')).toBeNull()
    fireEvent.click(trigger)
    expect(bridge.command).not.toHaveBeenCalled()
    // The "+" is the start sheet: who you already talk to, then making something new.
    const start = screen.getByRole('dialog', { name: 'Start a chat' })
    expect(within(start).getByRole('group', { name: 'People' })).toBeTruthy()
    fireEvent.click(within(start).getByRole('button', { name: 'New group' }))
    const dialog = screen.getByRole('dialog', { name: 'New group' })
    fireEvent.change(within(dialog).getByLabelText('Group name'), { target: { value: 'Friends' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Alice' }))
    // Nobody is asked for a Matrix address, but a whole one still works for someone who knows it.
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Search names, or enter an @name' }), {
      target: { value: '@bob:test' }
    })
    // Found on purpose, so ticked straight away.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Find @bob:test on Atum' }))
    expect((within(dialog).getByRole('checkbox', { name: '@bob:test' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create group' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New group' })).toBeNull())
    expect(vi.mocked(bridge.command).mock.calls.filter(([command]) => command.kind === 'create')).toEqual([
      [{ kind: 'create', name: 'Friends', invite: ['@alice:test', '@bob:test'], direct: false }]
    ])
    expect(view.container.querySelector('[data-atum-roster-drawer]')?.hasAttribute('inert')).toBe(true)
  })

  it('makes a group of your assistants from the “+”, lists it with the chats and opens it again', async () => {
    const policy = {
      policy: { v: 1, agents: {} },
      usage: { v: 1, day: new Date().toISOString().slice(0, 10), turns: 0 }
    }

    const command = vi.fn<MatrixUiBridge['command']>(async input =>
      input.kind === 'create' ? '!planning:test' : input.kind === 'groupPolicy' ? policy : null
    )

    const { emit, view } = fixture(undefined, 'en', undefined, command)
    await screen.findByRole('button', { name: 'Continue with Google' })

    const agents: MatrixAgentView[] = [
      { principal: 'atum', userId: '@atum:test', isDefault: true, ready: true, hermes: 'ready', atumModel: true },
      ...['Bea', 'Cam'].map(name => ({
        principal: name.toLowerCase(),
        userId: `@${name.toLowerCase()}:test`,
        name,
        isDefault: false,
        ready: true,
        hermes: 'ready' as const,
        atumModel: true
      }))
    ]

    const linh = {
      id: '!linh:test',
      name: 'Linh',
      membership: 'join',
      encrypted: true,
      direct: true,
      participants: [
        { userId: '@owner:test', membership: 'join' },
        { userId: '@linh:test', membership: 'join' }
      ]
    }

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      assistant: { userId: '@atum:test', deviceId: 'ATUM' },
      agents,
      roomId: linh.id,
      rooms: [
        { ...assistantFields, id: '!atum:test', name: 'Atum', assistant: true, membership: 'join', encrypted: true },
        linh
      ]
    }

    emit(state)
    fireEvent.click(await screen.findByRole('button', { name: 'New…' }))
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Start a chat' })).getByRole('button', { name: 'New group' })
    )
    const dialog = screen.getByRole('dialog', { name: 'New group' })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Bea' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Cam' }))
    fireEvent.change(within(dialog).getByLabelText('Group name'), { target: { value: 'Planning' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create group' }))
    // One create: main tells your assistants apart from people and has each join.
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({
        kind: 'create',
        name: 'Planning',
        invite: ['@bea:test', '@cam:test'],
        direct: false
      })
    )
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New group' })).toBeNull())

    // Matrix selects the new group; the roster lists it with the other conversations.
    const planning = {
      id: '!planning:test',
      name: 'Planning',
      membership: 'join',
      encrypted: true,
      participants: [
        { userId: '@owner:test', membership: 'join' },
        { userId: '@bea:test', membership: 'join' },
        { userId: '@cam:test', membership: 'join' }
      ]
    }

    emit({ ...state, rooms: [...state.rooms, planning], roomId: planning.id, messages: [] })

    const row = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>('[data-matrix-room="!planning:test"]')
      expect(found).not.toBeNull()

      return found!
    })

    // Assistants are ordinary group participants: no separate Everyone / assistant routing tabs.
    expect(screen.queryByRole('group', { name: 'Send to' })).toBeNull()

    // Back to another chat, then the group's row opens it again.
    emit({ ...state, rooms: [...state.rooms, planning], roomId: linh.id })
    fireEvent.click(within(row).getByRole('button'))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: planning.id }))
  })

  it('unmounts member management when the selected room or account changes', async () => {
    const { emit, bridge, view } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      rooms: [{ id: '!a:test', name: 'Friends', encrypted: true, membership: 'join', canInvite: true }],
      roomId: '!a:test',
      members: []
    }

    emit(state)
    const trigger = screen.getByRole('button', { name: 'Members (0)' })
    expect(trigger.closest('[data-atum-main-header]')).toBeTruthy()
    fireEvent.click(trigger)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add members' }))
    fireEvent.change(
      within(screen.getByRole('dialog', { name: 'Add members' })).getByRole('textbox', {
        name: 'Search names, or enter an @name'
      }),
      { target: { value: '@draft:test' } }
    )
    expect(bridge.command).not.toHaveBeenCalled()
    emit({ ...state, roomId: null })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(view.container.querySelector('[data-matrix-membership]')).toBeNull()
    await waitFor(() => expect($appViewOverlayCount.get()).toBe(0))
    emit(state)
    fireEvent.click(screen.getByRole('button', { name: 'Members (0)' }))
    // The add picker's draft went with the room: it opens empty.
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add members' }))
    expect(
      (
        within(screen.getByRole('dialog', { name: 'Add members' })).getByRole('textbox', {
          name: 'Search names, or enter an @name'
        }) as HTMLInputElement
      ).value
    ).toBe('')
    emit({ ...state, identity: { userId: '@other:test', deviceId: 'DEVICE' } })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect($appViewOverlayCount.get()).toBe(0))
  })

  it('replaces inline invitation controls with header membership after native join sync', async () => {
    const { emit, bridge, view } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    const room = { id: '!invite:test', name: 'Friends', encrypted: true, membership: 'invite' }

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      rooms: [room],
      roomId: room.id
    }

    emit(state)
    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }))
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith({ kind: 'join', roomId: room.id }))
    expect(screen.queryByRole('button', { name: 'Members (0)' })).toBeNull()
    emit({ ...state, rooms: [{ ...room, membership: 'join' }] })
    expect(screen.getByRole('button', { name: 'Members (0)' }).closest('[data-atum-main-header]')).toBeTruthy()
    expect(view.container.querySelector('section[data-matrix-membership]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).toBeNull()
  })

  it('opens the start sheet from Cmd+N in a compact window, and a pick leaves the drawer shut', async () => {
    vi.stubGlobal('innerWidth', 700)
    const { emit, view, bridge } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      assistant: { userId: '@atum:test', deviceId: 'ATUM' },
      rooms: [
        { ...assistantFields, id: '!atum:test', name: 'Atum', assistant: true, membership: 'join', encrypted: true },
        {
          id: '!alice:test',
          name: 'Alice',
          membership: 'join',
          encrypted: true,
          direct: true,
          participants: [
            { userId: '@owner:test', membership: 'join' },
            { userId: '@alice:test', membership: 'join' }
          ]
        }
      ]
    })
    const drawer = () => view.container.querySelector<HTMLElement>('[data-atum-roster-drawer]')!
    await waitFor(() => expect(drawer().hasAttribute('inert')).toBe(true))
    fireEvent.keyDown(window, { key: 'n', code: 'KeyN', metaKey: true })
    // New message is the roster's own start sheet, the same as its "+", group creation included.
    const start = await screen.findByRole('dialog', { name: 'Start a chat' })
    expect(within(start).getByRole('button', { name: 'New group' })).toBeTruthy()
    fireEvent.click(within(within(start).getByRole('group', { name: 'People' })).getByRole('button', { name: 'Alice' }))
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith({ kind: 'select', roomId: '!alice:test' }))
    await act(async () => {})
    // Going to a chat shuts the drawer; it never opens it over the chat.
    expect(drawer().hasAttribute('inert')).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    // The same for your assistant, whose one conversation opens through its own path.
    fireEvent.keyDown(window, { key: 'n', code: 'KeyN', metaKey: true })
    const again = await screen.findByRole('dialog', { name: 'Start a chat' })
    fireEvent.click(
      within(within(again).getByRole('group', { name: 'Assistants' })).getByRole('button', { name: /^Atum/ })
    )
    await waitFor(() => expect(bridge.connectHermes).toHaveBeenCalledWith('!atum:test'))
    expect(bridge.command).toHaveBeenLastCalledWith({ kind: 'select', roomId: '!atum:test' })
    expect(drawer().hasAttribute('inert')).toBe(true)
  })

  it('assistant navigation closes the compact drawer', async () => {
    vi.stubGlobal('innerWidth', 700)
    const { emit, view, bridge } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      assistant: { userId: '@atum:test', deviceId: 'ATUM' },
      roomId: '!current:test',
      rooms: [
        { ...assistantFields, id: '!old:test', name: 'Old', assistant: true, membership: 'join', encrypted: true },
        {
          ...assistantFields,
          id: '!current:test',
          name: 'Current',
          assistant: true,
          membership: 'join',
          encrypted: true
        }
      ]
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Show sidebar' }))
    // The assistant is one row in the drawer; it opens its one conversation.
    await waitFor(() => expect(view.container.querySelector('[data-matrix-agent]')).toBeTruthy())
    expect(view.container.querySelector('[data-matrix-room="!old:test"]')).toBeNull()
    fireEvent.click(
      within(view.container.querySelector<HTMLElement>('[data-matrix-agent]')!).getAllByRole('button')[0]!
    )

    await waitFor(() =>
      expect(view.container.querySelector<HTMLElement>('[data-atum-roster-drawer]')?.style.display).toBe('none')
    )
    expect(view.container.querySelector('[data-atum-roster-drawer]')?.hasAttribute('inert')).toBe(true)
    expect(
      vi.mocked(bridge.command).mock.calls.filter(([command]) => ['create', 'select'].includes(command.kind))
    ).toEqual([[{ kind: 'select', roomId: '!current:test' }]])
  })

  it.each(['direct', 'group'])(
    'requires explicit app targeting in %s and retains publication-only retry without resending',
    async mode => {
      const { emit, bridge } = fixture()
      await screen.findByRole('button', { name: 'Continue with Google' })
      const send = vi.fn(async () => ({ eventId: '$app-request', result: { state: 'publication_pending' as const } }))
      const invoke = vi.fn(async () => ({ state: 'published' as const, eventId: '$app-reply' }))
      bridge.apps = { send, invoke, onReturn: () => () => {} } as unknown as MatrixUiBridge['apps']

      const app: AppDescriptor = {
        app: 'river',
        app_id: '00000000-0000-4000-8000-11e594f48195',
        app_version_id: '00000000-0000-4000-8000-e79acd97ac88',
        name: { en: 'River' },
        subtitle: null,
        description: null,
        icon: null,
        accent: null,
        affiliation: null,
        verified: true,
        availability: 'available',
        roster_default: false,
        roster_order: 0,
        supported_modes: ['direct'],
        has_surface: false,
        link: { mode: 'external_account', state: 'linked' }
      }

      const state: MatrixSnapshot = {
        ...signedOut,
        state: 'ready',
        identity: { userId: '@owner:test', deviceId: 'D' },
        apps: { state: 'ready', apps: [app], connections: {} },
        appParticipants: [{ appId: app.app_id, userId: '@river:test', ready: true }],
        roomId: '!app:test',
        rooms: [
          {
            id: '!app:test',
            name: 'App room',
            membership: 'join',
            encrypted: true,
            ...(mode === 'group'
              ? { roomType: 'io.atum.app_group.v1', appGroup: { owner: '@owner:test', app: '@river:test' } }
              : {}),
            participants: [
              { userId: '@owner:test', membership: 'join' },
              { userId: '@river:test', membership: 'join' },
              ...(mode === 'group' ? [{ userId: '@other:test', membership: 'join' }] : [])
            ]
          }
        ]
      }

      emit(state)
      const composer = await screen.findByRole('textbox', { name: COMPOSER })
      fireEvent.change(composer, { target: { value: 'Ambient hello' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await waitFor(() =>
        expect(bridge.command).toHaveBeenCalledWith({ kind: 'send', roomId: '!app:test', body: 'Ambient hello' })
      )
      expect(send).not.toHaveBeenCalled()
      fireEvent.click(within(screen.getByRole('group', { name: 'Send to' })).getByRole('button', { name: 'River' }))
      expect(screen.getByText('Saved personal context: off · Agent instructions remain on')).toBeTruthy()
      fireEvent.change(composer, { target: { value: 'Addressed hello' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await waitFor(() => expect(send).toHaveBeenCalledWith(app.app_id, '!app:test', 'Addressed hello', 'en'))
      fireEvent.click(await screen.findByRole('button', { name: 'Retry reply delivery' }))
      await waitFor(() => expect(invoke).toHaveBeenCalledWith(app.app_id, '!app:test', '$app-request'))
      expect(send).toHaveBeenCalledOnce()
      // Delivered: the app's reply shows it; the notice is for a screen reader only.
      await waitFor(() =>
        expect(window.document.querySelector('[data-matrix-app-notice="published"]')?.className).toBe('sr-only')
      )
      expect(bridge.sendAssistant).not.toHaveBeenCalled()

      if (mode === 'group') {
        emit({ ...state, identity: { userId: '@other:test', deviceId: 'OTHER' } })
        expect(screen.queryByRole('group', { name: 'Send to' })).toBeNull()
        emit(state)
        fireEvent.click(within(screen.getByRole('group', { name: 'Send to' })).getByRole('button', { name: 'River' }))
      }

      emit({ ...state, appParticipants: [] })
      fireEvent.change(composer, { target: { value: 'Must not silently become ambient' } })
      expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true)
      // A different room with the same app still requires a fresh recipient choice.
      emit({ ...state, roomId: '!other:test', rooms: [{ ...state.rooms[0], id: '!other:test' }] })
      expect(screen.queryByText('Saved personal context: off · Agent instructions remain on')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Retry reply delivery' })).toBeNull()
      fireEvent.change(screen.getByRole('textbox', { name: COMPOSER }), {
        target: { value: 'New room ambient' }
      })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await waitFor(() =>
        expect(bridge.command).toHaveBeenCalledWith({ kind: 'send', roomId: '!other:test', body: 'New room ambient' })
      )
      expect(send).toHaveBeenCalledOnce()
    }
  )

  it.each([
    ['meeting', 'joins'],
    ['shared', 'joins'],
    ['meeting', 'addressed'],
    // The room's policy can't be read (an older Mac's store, a failed read): nothing is promised.
    ['meeting', 'unreadable']
  ] as const)(
    'uses the policy-aware composer in %s / %s without changing server addressing',
    async (mode, participation) => {
      const roomId = `!meeting-${mode}-${participation}:test`

      const policy = {
        policy: { v: 1, agents: { '@mochi:test': { mode: participation } } },
        usage: { v: 1, day: new Date().toISOString().slice(0, 10), turns: 12 }
      }

      const command = vi.fn(async (input: { kind: string }) => {
        if (input.kind === 'groupPolicy' && participation === 'unreadable') {
          throw new Error('matrix_group_policy_unreadable')
        }

        return input.kind === 'groupPolicy' ? policy : null
      })

      const { emit } = fixture(undefined, 'en', undefined, command)
      await screen.findByRole('button', { name: 'Continue with Google' })

      const agents = ['Mochi', 'Bailey'].map(name => ({
        principal: name.toLowerCase(),
        userId: `@${name.toLowerCase()}:test`,
        name,
        isDefault: false,
        ready: true,
        hermes: 'ready' as const,
        atumModel: true
      }))

      const state: MatrixSnapshot = {
        ...signedOut,
        state: 'ready',
        identity: { userId: '@owner:test', deviceId: 'D' },
        agents,
        roomId,
        rooms: [
          {
            id: roomId,
            name: 'Meeting',
            membership: 'join',
            encrypted: true,
            participants: [
              { userId: '@owner:test', membership: 'join' },
              ...agents.map(agent => ({ userId: agent.userId, membership: 'join' as const })),
              ...(mode === 'shared' ? [{ userId: '@foreign:test', membership: 'join' as const }] : [])
            ]
          }
        ]
      }

      emit(state)
      const composer = await screen.findByRole('textbox', { name: COMPOSER })
      // Group delivery is standard chat behavior; assistants are addressed by @mention or reply.
      expect(screen.queryByRole('group', { name: 'Send to' })).toBeNull()

      if (participation === 'unreadable') {
        await waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({ kind: 'groupPolicy' })))
        expect(screen.queryByText(/up to 2 assistants answer each message/)).toBeNull()
        expect(window.document.querySelector('[data-matrix-group-usage]')).toBeNull()
      }

      fireEvent.change(composer, { target: { value: 'Hello all' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'send', roomId, body: 'Hello all' }))
      fireEvent.change(composer, { target: { value: '@Mochi and @Bailey please check' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await waitFor(() =>
        expect(command).toHaveBeenCalledWith({
          kind: 'send',
          roomId,
          body: '@Mochi and @Bailey please check',
          mentions: ['@mochi:test', '@bailey:test']
        })
      )
    }
  )

  it('asks your own assistant in a group through a standard mention, without routing tabs', async () => {
    const { emit, bridge } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const bea = {
      principal: 'bea-principal',
      userId: '@bea:test',
      name: 'Bea',
      isDefault: false,
      ready: true,
      hermes: 'ready' as const,
      atumModel: true
    }

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'D' },
      agents: [bea],
      roomId: '!trip:test',
      rooms: [
        {
          id: '!trip:test',
          name: 'Trip',
          membership: 'join',
          encrypted: true,
          participants: [
            { userId: '@owner:test', membership: 'join' },
            { userId: '@bea:test', membership: 'join' },
            { userId: '@linh:test', membership: 'join' }
          ]
        }
      ]
    }

    emit(state)
    const composer = await screen.findByRole('textbox', { name: COMPOSER })
    // An ordinary message to the group names nobody: the assistant isn't asked.
    fireEvent.change(composer, { target: { value: 'Hello all' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(bridge.command).toHaveBeenCalledWith({ kind: 'send', roomId: '!trip:test', body: 'Hello all' })
    )
    expect(screen.queryByRole('group', { name: 'Send to' })).toBeNull()
    fireEvent.change(composer, { target: { value: '@Bea Plan day two' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(bridge.command).toHaveBeenCalledWith({
        kind: 'send',
        roomId: '!trip:test',
        body: '@Bea Plan day two',
        mentions: ['@bea:test']
      })
    )
    expect(bridge.sendAssistant).not.toHaveBeenCalled()

    // A group of just you and your assistant keeps the same standard composer.
    emit({ ...state, rooms: [{ ...state.rooms[0]!, participants: state.rooms[0]!.participants!.slice(0, 2) }] })
    expect(screen.queryByRole('group', { name: 'Send to' })).toBeNull()
  })

  it('routes assistant composer sends through the idempotent assistant bridge', async () => {
    const { emit, bridge } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      assistant: { userId: '@atum:test', deviceId: 'ATUM' },
      hermes: 'ready',
      roomId: '!assistant:test',
      rooms: [
        {
          ...assistantFields,
          id: '!assistant:test',
          name: 'Atum',
          membership: 'join',
          encrypted: true,
          direct: true,
          assistant: true
        }
      ]
    })

    const composer = await screen.findByRole('textbox', { name: COMPOSER })
    fireEvent.change(composer, { target: { value: 'Plan the next task' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(bridge.sendAssistant).toHaveBeenCalledWith('!assistant:test', 'Plan the next task', 'en')
    )
    expect(bridge.command).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'send', roomId: '!assistant:test' })
    )

    // The reply posting is announced to a screen reader, never left as stray text under the box.
    const notice = await waitFor(() => {
      const element = window.document.querySelector('[data-matrix-invocation-notice="published"]')
      expect(element).not.toBeNull()

      return element as HTMLElement
    })

    expect(notice.textContent).toBe('Reply posted.')
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.className).toBe('sr-only')
  })

  it("puts the words back and says why when a message to the founder can't go yet", async () => {
    const { emit, bridge } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    const refused = vi.mocked(bridge.command)
    refused.mockImplementation(async command => {
      if ((command as { kind?: string }).kind === 'send') {
        throw new Error("Error invoking remote method 'matrix:ui': Error: matrix_founder_unready")
      }

      return null
    })

    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      roomId: '!human:test',
      rooms: [{ id: '!human:test', name: 'Morgan', membership: 'join', encrypted: true, direct: true }]
    })

    const composer = (await screen.findByRole('textbox', { name: COMPOSER })) as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: 'Is there a Windows app?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await screen.findByText("Founder can't receive messages yet. Nothing was sent; try again in a little while.")
    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: COMPOSER }) as HTMLTextAreaElement).value).toBe(
        'Is there a Windows app?'
      )
    )
    expect(screen.queryByText('That didn’t work. Try again.')).toBeNull()
  })

  it('brings the chat Contact us chose to the front, even from Workplace with the roster folded', async () => {
    // Workplace is on the rail only with a company workspace (fix/rail-no-workplace).
    const { emit } = fixture(undefined, 'en', workplacePages(), undefined, undefined, companyWorkspace())
    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      assistant: { userId: '@atum:test', deviceId: 'ATUM' },
      domainEnabled: true,
      companyWorkspaceEnabled: true,
      hermes: 'ready',
      roomId: '!founder:test',
      rooms: [
        {
          ...assistantFields,
          id: '!assistant:test',
          name: 'Atum',
          membership: 'join',
          encrypted: true,
          assistant: true
        },
        { id: '!founder:test', name: 'Founder', membership: 'join', encrypted: true, direct: true }
      ],
      agents: [
        {
          principal: 'agent-1',
          userId: '@atum:test',
          name: 'Atum',
          isDefault: true,
          ready: true,
          hermes: 'ready',
          atumModel: true
        }
      ]
    })

    await screen.findByRole('textbox', { name: COMPOSER })
    openScheduledPage()
    await waitFor(() => expect(window.document.querySelector('[data-matrix-workplace-page="scheduled"]')).toBeTruthy())
    expect(screen.queryByRole('textbox', { name: COMPOSER })).toBeNull()

    act(() => requestFounderChat())

    await screen.findByRole('textbox', { name: COMPOSER })
    expect(window.document.querySelector('[data-matrix-workplace-page="scheduled"]')).toBeNull()
  })

  // 0.20: new people chats and groups are plain. They send with no warning; an encrypted one too.
  it.each([false, true])('sends in a people chat (encrypted: %s) with no encryption notice', async encrypted => {
    const { emit, bridge } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'OWNER' },
      roomId: '!human:test',
      rooms: [{ id: '!human:test', name: 'Linh', membership: 'join', encrypted, direct: true }]
    })
    const composer = (await screen.findByRole('textbox', { name: COMPOSER })) as HTMLTextAreaElement
    expect(screen.queryByText(/only sends messages in encrypted chats/)).toBeNull()
    fireEvent.change(composer, { target: { value: 'Chào Linh' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(bridge.command).toHaveBeenCalledWith({ kind: 'send', roomId: '!human:test', body: 'Chào Linh' })
    )
  })

  it('sends personal notes as an ordinary DM without asking an agent to answer', async () => {
    const { emit, bridge } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'OWNER' },
      roomId: '!notes:test',
      rooms: [{
        id: '!notes:test',
        name: 'Spoofable room name',
        membership: 'join',
        encrypted: false,
        roomType: MATRIX_NOTES_SELF_ROOM_TYPE,
        participants: [{ userId: '@owner:test', membership: 'join' }]
      }],
      notesSelf: {
        state: 'ready',
        roomId: '!notes:test',
        duplicates: [],
        quarantinedRoomIds: [],
        retiredRoomIds: [],
        pointerWritable: true
      }
    })

    const composer = (await screen.findByRole('textbox', { name: 'Message You' })) as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: 'Remember the launch checklist' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith({
      kind: 'send',
      roomId: '!notes:test',
      body: 'Remember the launch checklist'
    }))
    expect(bridge.sendAssistant).not.toHaveBeenCalled()
    expect(bridge.sendTurn).not.toHaveBeenCalled()
  })

  it.each(['matrix_operation_failed', 'matrix_identity_review_required'])(
    'preserves the composer draft after strict-policy %s without resending',
    async refusal => {
      const { emit, bridge } = fixture()
      await screen.findByRole('button', { name: 'Continue with Google' })
      emit({
        ...signedOut,
        state: 'ready',
        identity: { userId: '@owner:test', deviceId: 'OWNER' },
        deviceIsolation: { value: 'signed', writable: true },
        roomId: '!human:test',
        rooms: [{ id: '!human:test', name: 'Friend', membership: 'join', encrypted: true, direct: true }]
      })
      const composer = await screen.findByRole('textbox', { name: COMPOSER })
      vi.mocked(bridge.command).mockImplementation(async command => {
        if (command.kind === 'send') {
          throw new Error(refusal)
        }

        return null
      })
      fireEvent.change(composer, { target: { value: 'Keep these words' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await waitFor(() =>
        expect(bridge.command).toHaveBeenCalledWith({ kind: 'send', roomId: '!human:test', body: 'Keep these words' })
      )
      await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe('Keep these words'))
      expect(vi.mocked(bridge.command).mock.calls.filter(([command]) => command.kind === 'send')).toHaveLength(1)
      expect(bridge.sendAssistant).not.toHaveBeenCalled()
    }
  )

  it('keeps human and listening assistant sends on Matrix regular-message delivery', async () => {
    const { emit, bridge } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const human = { id: '!human:test', name: 'Morgan', membership: 'join', encrypted: true, direct: true }

    const assistant = {
      ...assistantFields,
      id: '!assistant:test',
      name: 'Atum',
      membership: 'join',
      encrypted: true,
      direct: true,
      assistant: true
    }

    const base: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      assistant: { userId: '@atum:test', deviceId: 'ATUM' },
      rooms: [assistant, human],
      members: [
        { userId: '@owner:test', name: 'Owner', membership: 'join', canRemove: false },
        { userId: '@morgan:test', name: 'Morgan', membership: 'join', canRemove: true }
      ]
    }

    emit({ ...base, roomId: human.id })
    let composer = await screen.findByRole('textbox', { name: COMPOSER })
    fireEvent.change(composer, { target: { value: 'Hi Morgan' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(bridge.command).toHaveBeenCalledWith({ kind: 'send', roomId: human.id, body: 'Hi Morgan' })
    )
    expect(bridge.sendAssistant).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Connect your assistant here' })).toBeNull()
    expect(screen.queryByRole('button', { name: matrixActionCopy.en.listenHermes })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open a document…' })).toBeNull()
    // A chat with one person has its conversation menu, and no members list to open.
    expect(screen.getByRole('button', { name: 'Conversation options' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Members/ })).toBeNull()

    emit({
      ...base,
      roomId: assistant.id,
      hermesListening: { state: 'listening', roomId: assistant.id, expiresAt: Date.now() + 60_000, queued: 0 }
    })
    composer = await screen.findByRole('textbox', { name: COMPOSER })
    fireEvent.change(composer, { target: { value: 'Listen to this' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(bridge.command).toHaveBeenCalledWith({ kind: 'send', roomId: assistant.id, body: 'Listen to this' })
    )
    expect(bridge.sendAssistant).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /^Members/ })).toBeNull()
  })

  it('keeps a human selection through sync, and exposes only real assistant navigation', async () => {
    const { emit, bridge, view } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const assistant = {
      ...assistantFields,
      id: '!assistant:test',
      name: 'Atum',
      membership: 'join',
      encrypted: true,
      assistant: true
    }

    const human = { id: '!human:test', name: 'Morgan', membership: 'join', encrypted: true, direct: true }

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      assistant: { userId: '@atum:test', deviceId: 'ATUM' },
      rooms: [assistant, human],
      roomId: human.id
    }

    emit(state)
    await waitFor(() => expect(bridge.command).not.toHaveBeenCalled())
    expect(view.container.querySelector('[data-matrix-rail-account]')).toBeTruthy()

    // No app workspace: the Store is not on the rail at all (never a disabled placeholder), so
    // nothing in the rail can start a command.
    expect(view.container.querySelector('[data-atum-nav-discover]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'The store isn’t available right now' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Chats' }))
    expect(bridge.command).not.toHaveBeenCalled()

    emit({ ...state, roomId: null })
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith({ kind: 'select', roomId: assistant.id }))
  })

  it.each([{ kind: 'app', appId: 'saved-app' }, { kind: 'discover' }] as const)(
    'selects the Hermes room when a saved %s destination survives while the app workspace is gated off',
    async destination => {
      const { emit, bridge } = fixture()

      const assistant = {
        ...assistantFields,
        id: '!assistant:test',
        name: 'Atum',
        membership: 'join',
        encrypted: true,
        assistant: true
      }

      emit({
        ...signedOut,
        state: 'ready',
        identity: { userId: '@owner:test', deviceId: 'DEVICE' },
        assistant: { userId: '@atum:test', deviceId: 'ATUM' },
        rooms: [assistant],
        destination
      })

      await waitFor(() => expect(bridge.command).toHaveBeenCalledWith({ kind: 'select', roomId: assistant.id }))
    }
  )

  it('retains an app destination when the app workspace is live instead of selecting Hermes', async () => {
    const { emit, bridge } = fixture()

    const assistant = {
      ...assistantFields,
      id: '!assistant:test',
      name: 'Atum',
      membership: 'join',
      encrypted: true,
      assistant: true
    }

    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      assistant: { userId: '@atum:test', deviceId: 'ATUM' },
      rooms: [assistant],
      destination: { kind: 'app', appId: 'saved-app' },
      apps: { state: 'ready', apps: [], connections: {} }
    })

    await act(async () => {})
    expect(bridge.command).not.toHaveBeenCalled()
  })

  it('keeps the Store selected on the rail while an app from it is open, not Home', async () => {
    const { emit } = fixture()

    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      destination: { kind: 'app', appId: 'saved-app' },
      apps: { state: 'ready', apps: [], connections: {} }
    })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Store' }).getAttribute('aria-current')).toBe('page'))
    expect(screen.getByRole('button', { name: 'Chats' }).getAttribute('aria-current')).toBeNull()
  })

  it('retries a pending assistant room, then uses the one permitted first-contact route', async () => {
    const { emit, bridge } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    vi.mocked(bridge.command).mockResolvedValueOnce('!created:test')
    vi.mocked(bridge.connectHermes).mockRejectedValueOnce(new Error('sync is behind'))
    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      assistant: { userId: '@atum:test', deviceId: 'ATUM' }
    })

    const assistant = await screen.findByRole('button', { name: 'Atum' })
    fireEvent.click(assistant)
    await waitFor(() => expect(bridge.connectHermes).toHaveBeenCalledWith('!created:test'))
    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      assistant: { userId: '@atum:test', deviceId: 'ATUM' },
      roomId: '!created:test',
      // Partial sync has seen the new room but not the assistant's membership.
      rooms: [{ id: '!created:test', name: 'Pending', membership: 'join', encrypted: true }]
    })
    fireEvent.click(assistant)
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith({ kind: 'select', roomId: '!created:test' }))
    expect(bridge.command).toHaveBeenCalledTimes(2)

    fireEvent.keyDown(window, { key: 'n', code: 'KeyN', metaKey: true })
    const start = await screen.findByRole('dialog', { name: 'Start a chat' })
    fireEvent.click(
      within(within(start).getByRole('group', { name: 'Assistants' })).getByRole('button', { name: /^Atum/ })
    )
    await waitFor(() => expect(bridge.command).toHaveBeenCalledTimes(3))
    expect(bridge.command).toHaveBeenLastCalledWith({
      kind: 'create',
      name: '',
      invite: ['@atum:test'],
      direct: true
    })
  })

  it('retires the pre-sync assistant retry pointer so a left room cannot trap the shortcut', async () => {
    const { emit, bridge } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      assistant: { userId: '@atum:test', deviceId: 'ATUM' }
    }

    emit(state)
    vi.mocked(bridge.command).mockResolvedValueOnce('!created:test')
    vi.mocked(bridge.connectHermes).mockRejectedValueOnce(new Error('sync is behind'))
    fireEvent.click(await screen.findByRole('button', { name: 'Atum' }))
    await waitFor(() => expect(bridge.connectHermes).toHaveBeenCalledWith('!created:test'))
    emit({
      ...state,
      roomId: '!created:test',
      rooms: [
        {
          ...assistantFields,
          id: '!created:test',
          name: 'Previous',
          assistant: true,
          encrypted: true,
          membership: 'leave'
        }
      ]
    })
    vi.mocked(bridge.command).mockClear().mockResolvedValueOnce('!new:test')
    fireEvent.click(screen.getByRole('button', { name: 'Atum' }))
    await waitFor(() =>
      expect(bridge.command).toHaveBeenCalledWith({ kind: 'create', name: '', invite: ['@atum:test'], direct: true })
    )
    expect(bridge.command).not.toHaveBeenCalledWith({ kind: 'select', roomId: '!created:test' })
  })

  it('blocks direct assistant sending and explicit runs while setup is pending or listening', async () => {
    const { emit } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const room = {
      ...assistantFields,
      id: '!assistant:test',
      name: 'Atum',
      membership: 'join',
      encrypted: true,
      assistant: true
    }

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      roomId: room.id,
      rooms: [room],
      hermes: 'unconfigured',
      assistant: { userId: '@atum:test', deviceId: 'ATUM' },
      messages: [
        {
          id: '$request',
          sender: '@owner:test',
          body: 'Plan this',
          timestamp: 1,
          own: true,
          encrypted: true,
          decryptionFailed: false,
          pending: false,
          failed: false,
          attachment: false
        }
      ]
    }

    emit(state)
    expect(((await screen.findByRole('button', { name: 'Send' })) as HTMLButtonElement).disabled).toBe(true)
    openMessageActions()
    emit({
      ...state,
      hermes: 'ready',
      hermesListening: { state: 'listening', roomId: room.id, expiresAt: Date.now() + 60_000, queued: 0 }
    })
    // Retry runs an unanswered message in place: not while the room is being listened to.
    expect((await screen.findByRole('menuitem', { name: 'Retry' })).getAttribute('aria-disabled')).toBe('true')
  })

  it.each([undefined, { userId: '@replacement:test', deviceId: 'NEW' }])(
    'keeps former assistant history read-only with absent/replaced enrollment (%s)',
    async assistant => {
      const { emit, bridge } = fixture()
      await screen.findByRole('button', { name: 'Continue with Google' })

      const old = {
        ...assistantFields,
        id: '!old:test',
        name: 'Old assistant',
        membership: 'join',
        encrypted: true,
        assistant: true
      }

      const state: MatrixSnapshot = {
        ...signedOut,
        state: 'ready',
        identity: { userId: '@owner:test', deviceId: 'OWNER' },
        assistant,
        hermes: 'ready',
        rooms: [old],
        roomId: old.id,
        messages: [
          {
            id: '$old',
            sender: '@owner:test',
            body: 'Old request',
            timestamp: 1,
            own: true,
            encrypted: true,
            decryptionFailed: false,
            pending: false,
            failed: false,
            attachment: false
          }
        ]
      }

      emit(state)
      expect(await screen.findByText(/This chat is not connected to your current assistant/)).toBeTruthy()
      expect(screen.getByText('Old request')).toBeTruthy()
      expect(screen.queryByText(/Members \(/)).toBeNull()

      expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true)
      // History only: Copy, never Retry or Edit and resend.
      openMessageActions()
      expect(screen.getByRole('menuitem', { name: 'Copy' })).toBeTruthy()
      expect(screen.queryByRole('menuitem', { name: 'Retry' })).toBeNull()
      expect(screen.queryByRole('menuitem', { name: 'Edit and resend' })).toBeNull()
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
      // And no reply settings for an assistant it is no longer connected to.
      fireEvent.keyDown(screen.getByRole('button', { name: 'Conversation options' }), { key: 'Enter' })
      expect(screen.queryByRole('menuitem', { name: 'Reply settings…' })).toBeNull()
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

      expect(bridge.command).not.toHaveBeenCalled()
      expect(bridge.sendAssistant).not.toHaveBeenCalled()
      expect(bridge.invokeHermes).not.toHaveBeenCalled()
      expect(bridge.connectHermes).not.toHaveBeenCalled()
      expect(bridge.setContinuousListening).not.toHaveBeenCalled()

      if (assistant) {
        const current = {
          ...old,
          id: '!current:test',
          name: 'Current assistant',
          participants: [assistantFields.participants[0], { userId: assistant.userId, membership: 'invite' }]
        }

        emit({ ...state, rooms: [old, current], roomId: null })
        await waitFor(() =>
          expect(bridge.command).toHaveBeenCalledExactlyOnceWith({ kind: 'select', roomId: current.id })
        )
      }
    }
  )

  it.each([false, true])(
    'keeps accept and decline available on ordinary typed assistant invitations without the private marker (assistant hint: %s)',
    async assistant => {
      const { emit, bridge } = fixture()
      await screen.findByRole('button', { name: 'Continue with Google' })

      const room = {
        ...assistantFields,
        id: '!invite:test',
        name: 'Invited',
        membership: 'invite',
        encrypted: true,
        assistant
      }

      emit({
        ...signedOut,
        state: 'ready',
        identity: { userId: '@owner:test', deviceId: 'OWNER' },
        rooms: [room],
        roomId: room.id
      })
      expect(screen.queryByText(/This chat is not connected to your current assistant/)).toBeNull()
      const accept = await screen.findByRole('button', { name: 'Accept invitation' })
      expect(accept.hasAttribute('disabled')).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: 'Decline invitation' }))
      fireEvent.click(screen.getByRole('button', { name: 'Confirm decline' }))
      await waitFor(() => expect(bridge.command).toHaveBeenCalledExactlyOnceWith({ kind: 'leave', roomId: room.id }))
    }
  )

  it('lets the owner leave retired history without exposing invitation or member-management controls', async () => {
    const { emit, bridge } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const room = {
      ...assistantFields,
      id: '!old:test',
      name: 'Old',
      membership: 'join',
      encrypted: true,
      assistant: true,
      canInvite: true
    }

    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'OWNER' },
      rooms: [room],
      roomId: room.id
    })
    // Assistant conversations are managed by the assistant, not personal chat actions.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Conversation options' }), { key: 'Enter' })
    expect(screen.queryByRole('menuitem', { name: 'Members' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Leave group' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Delete chat' })).toBeNull()
    expect(bridge.command).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /^Members/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull()
  })

  it('does not reuse a pre-sync creation retry after the enrolled assistant changes', async () => {
    const { emit, bridge } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'OWNER' },
      assistant: { userId: '@old:test', deviceId: 'OLD' }
    }

    vi.mocked(bridge.command).mockResolvedValueOnce('!old:test').mockResolvedValueOnce('!new:test')
    vi.mocked(bridge.connectHermes).mockRejectedValueOnce(new Error('sync pending'))
    emit(state)
    fireEvent.click(await screen.findByRole('button', { name: 'Atum' }))
    await waitFor(() => expect(bridge.connectHermes).toHaveBeenCalledWith('!old:test'))
    emit({ ...state, assistant: { userId: '@new:test', deviceId: 'NEW' } })
    const current = screen.getByRole('button', { name: 'Atum' })
    await waitFor(() => expect(current.hasAttribute('disabled')).toBe(false))
    fireEvent.click(current)
    await waitFor(() => expect(bridge.command).toHaveBeenCalledTimes(2))
    expect(bridge.command).toHaveBeenLastCalledWith({ kind: 'create', name: '', direct: true, invite: ['@new:test'] })
    await waitFor(() => expect(bridge.connectHermes).toHaveBeenLastCalledWith('!new:test'))
  })

  it("renders the assistant's posted answers as markdown, hides adjacent reply quotes, and retains non-adjacent context", async () => {
    const { emit, view } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    const room = { id: '!assistant:test', name: 'Atum', membership: 'join', encrypted: true, assistant: true }

    const message = (id: string, sender: string, own: boolean, body: string) => ({
      id,
      sender,
      body,
      timestamp: 1,
      own,
      encrypted: true,
      decryptionFailed: false,
      pending: false,
      failed: false,
      attachment: false
    })

    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      assistant: { userId: '@atum:test', deviceId: 'ATUM' },
      roomId: room.id,
      rooms: [room],
      messages: [
        message('$question', '@owner:test', true, 'Is **this** bold?'),
        { ...message('$answer', '@atum:test', false, 'Here is **the answer**'), replyTo: '$question' },
        { ...message('$unloaded', '@atum:test', false, 'Reply to earlier history'), replyTo: '$not-loaded' }
      ]
    })

    expect((await screen.findByText('the answer')).closest('[data-streamdown="strong"]')).toBeTruthy()
    expect(view.container.textContent).toContain('Is **this** bold?')
    expect(view.container.textContent).not.toContain('@owner:test')
    expect(view.container.textContent).not.toContain('@atum:test')
    expect(view.container.querySelector('[data-slot="aui_user-message-root"]')).toBeTruthy()
    expect(view.container.querySelector('[data-slot="aui_user-bubble-actions"] > div')?.className).toContain(
      'composer-human-message'
    )
    expect(view.container.querySelector('[data-slot="aui_assistant-message-root"]')).toBeTruthy()
    expect(view.container.querySelector('[data-slot="aui_assistant-message-content"]')).toBeTruthy()
    const quotes = view.container.querySelectorAll('[data-matrix-reply-quote]')
    expect(quotes).toHaveLength(1)
    expect(quotes[0].textContent).toBe('Reply')
  })

  it('opens web links in answers through the main process, like the old app', async () => {
    const { bridge, emit } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    const room = { id: '!assistant:test', name: 'Atum', membership: 'join', encrypted: true, assistant: true }
    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      assistant: { userId: '@atum:test', deviceId: 'ATUM' },
      roomId: room.id,
      rooms: [room],
      messages: [
        {
          id: '$answer',
          sender: '@atum:test',
          body: 'See [the guide](https://example.com/guide).',
          timestamp: 1,
          own: false,
          encrypted: true,
          decryptionFailed: false,
          pending: false,
          failed: false,
          attachment: false
        }
      ]
    })

    fireEvent.click(await screen.findByRole('link', { name: /the guide/ }))
    expect(bridge.openLink).toHaveBeenCalledWith('https://example.com/guide')
  })

  it('keeps a link that is not a web address as inert words in a message', async () => {
    const { bridge, emit } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    const room = { id: '!assistant:test', name: 'Atum', membership: 'join', encrypted: true, assistant: true }
    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      assistant: { userId: '@atum:test', deviceId: 'ATUM' },
      roomId: room.id,
      rooms: [room],
      messages: [
        {
          id: '$answer',
          sender: '@atum:test',
          body: 'Run [this](javascript:alert(document.domain)) or open [that](file:///etc/passwd).',
          timestamp: 1,
          own: false,
          encrypted: true,
          decryptionFailed: false,
          pending: false,
          failed: false,
          attachment: false
        }
      ]
    })

    const words = await screen.findByText('this')
    expect(words.closest('a')).toBeNull()
    expect(screen.getByText('that').closest('a')).toBeNull()
    expect(window.document.querySelector('[data-slot="aui_assistant-message-content"] a')).toBeNull()
    fireEvent.click(words)
    expect(bridge.openLink).not.toHaveBeenCalled()
  })

  it('shows the Atum atom alone before a turn has progress text, then only its answer', async () => {
    const { emit, view } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    const room = { id: '!assistant:test', name: 'Atum', membership: 'join', encrypted: true, assistant: true }
    const typing = () => view.container.querySelector('[data-matrix-agent-typing]')

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      roomId: room.id,
      rooms: [room],
      hermesActivity: {
        roomId: room.id,
        eventId: '$request',
        invocationId: 'invoke-1',
        state: 'running',
        text: 'Preparing reply',
        tools: [{ name: 'Files', state: 'running' }]
      }
    }

    emit(state)
    await waitFor(() => expect(typing()).toBeTruthy())
    // It shares the transcript's scroll owner, where the answer will appear.
    const viewport = view.container.querySelector('[data-slot="aui_thread-viewport"]')!
    expect(viewport.contains(typing())).toBe(true)
    expect(typing()?.getAttribute('aria-label')).toBe('Atum is typing…')
    expect(typing()?.querySelector('[data-atum-atom]')).toBeTruthy()
    expect(typing()?.querySelector('.atum-avatar')).toBeNull()
    // The transcript stays quiet; only the roster row names the current step.
    expect(within(view.container.querySelector('[data-matrix-roster-conversations]')!).getByText('Preparing reply')).toBeTruthy()
    expect(view.container.querySelector('[data-slot="aui_thread-viewport"]')?.textContent).not.toContain('Preparing reply')
    expect(screen.queryByText('Files')).toBeNull()
    emit({
      ...state,
      hermesActivity: { ...state.hermesActivity!, state: 'complete', text: 'Done' },
      messages: [
        {
          id: '$result',
          sender: '@atum:test',
          body: 'Done',
          timestamp: 2,
          own: false,
          encrypted: true,
          decryptionFailed: false,
          pending: false,
          failed: false,
          attachment: false,
          resultFor: '$request'
        }
      ]
    })
    await waitFor(() => expect(typing()).toBeNull())
    expect(screen.getByText('Done')).toBeTruthy()
  })

  it('draws an interim remark as an ordinary agent bubble, never as the answer', async () => {
    const { emit, view } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const room = {
      ...assistantFields,
      id: '!assistant:test',
      name: 'Atum',
      membership: 'join',
      encrypted: true,
      direct: true,
      assistant: true
    }

    const turnMessage = (id: string, body: string, extra: Record<string, unknown> = {}) => ({
      id,
      sender: '@atum:test',
      body,
      timestamp: 2,
      own: false,
      encrypted: true,
      decryptionFailed: false,
      pending: false,
      failed: false,
      attachment: false,
      ...extra
    })

    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      assistant: { userId: '@atum:test', deviceId: 'ATUM' },
      agents: [
        {
          principal: 'agent-atum',
          userId: '@atum:test',
          deviceId: 'ATUM',
          name: 'Atum',
          isDefault: true,
          ready: true,
          hermes: 'ready',
          atumModel: true
        }
      ],
      roomId: room.id,
      rooms: [room],
      messages: [
        {
          ...turnMessage('$question', 'Find a quiet guesthouse.', { sender: '@owner:test', own: true, timestamp: 1 })
        },
        turnMessage('$interim', 'Để mình xem vài chỗ yên tĩnh quanh hồ nhé.', { interim: true })
      ]
    })

    const interim = await screen.findByText('Để mình xem vài chỗ yên tĩnh quanh hồ nhé.')
    const row = interim.closest<HTMLElement>('[data-matrix-message-id="$interim"]')!
    expect(row.querySelector('.matrix-chat-bubble')).toBeTruthy()
    // An interim remark is not the answer: no toolbar (reply, retry, read aloud) offers itself on it.
    expect(row.querySelector('[data-matrix-message-toolbar]')).toBeNull()
    expect(view.container.querySelector('[data-matrix-agent-typing]')).toBeNull()
  })

  it('puts the one live working line under the typing bubble and drops it when the answer lands', async () => {
    const { emit, view } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const room = {
      ...assistantFields,
      id: '!assistant:test',
      name: 'Atum',
      membership: 'join',
      encrypted: true,
      direct: true,
      assistant: true
    }

    const turnMessage = (id: string, body: string, extra: Record<string, unknown> = {}) => ({
      id,
      sender: '@atum:test',
      body,
      timestamp: 2,
      own: false,
      encrypted: true,
      decryptionFailed: false,
      pending: false,
      failed: false,
      attachment: false,
      ...extra
    })

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      assistant: { userId: '@atum:test', deviceId: 'ATUM' },
      agents: [
        {
          principal: 'agent-atum',
          userId: '@atum:test',
          deviceId: 'ATUM',
          name: 'Atum',
          isDefault: true,
          ready: true,
          hermes: 'ready',
          atumModel: true
        }
      ],
      roomId: room.id,
      rooms: [room],
      typing: ['@atum:test'],
      hermesActivity: {
        roomId: room.id,
        eventId: '$question',
        invocationId: 'invoke',
        state: 'running',
        text: '',
        tools: []
      },
      messages: [
        turnMessage('$question', 'Find a quiet guesthouse.', { sender: '@owner:test', own: true, timestamp: 1 }),
        turnMessage('$interim', 'Để mình xem vài chỗ yên tĩnh quanh hồ nhé.', { interim: true }),
        turnMessage('$working', 'Đang tìm guesthouse…\n✓ Tìm trên web\n• Kiểm tra phòng trống', {
          notice: true,
          progress: {
            profile: 'atum.agent-turns/1.3',
            scope: 'owner_private',
            phase: 'working',
            kind: 'todo',
            revision: 2
          }
        })
      ]
    }

    emit(state)

    const working = await waitFor(() => {
      const line = view.container.querySelector<HTMLElement>('[data-matrix-progress-line]')
      expect(line).toBeTruthy()

      return line!
    })

    const block = working.closest<HTMLElement>('[data-matrix-agent-working]')!
    const parts = [...block.children]
    // The atom owns the face slot; current text and its quiet step card follow it.
    expect(block.hasAttribute('data-matrix-agent-typing')).toBe(true)
    expect(parts[0]!.querySelector('[data-atum-atom]')).toBeTruthy()
    expect(block.querySelector('.atum-avatar')).toBeNull()
    expect(parts[1]).toBe(working)
    expect(working.textContent).toContain('Đang tìm guesthouse…')
    expect(working.textContent).toContain('Tìm trên web')
    expect(within(working).getByRole('list').children).toHaveLength(2)
    expect(working.querySelector('[data-matrix-steps-list]')).toBeTruthy()
    // The live line is not also a transcript notice of its own.
    expect(view.container.querySelectorAll('[data-matrix-progress-line]')).toHaveLength(1)
    expect(view.container.querySelector('[data-matrix-message-id="$working"]')).toBeNull()

    emit({
      ...state,
      typing: [],
      hermesActivity: undefined,
      messages: [
        ...state.messages,
        turnMessage('$answer', 'Ba chỗ còn phòng nhé.', { replyTo: '$question', resultFor: '$question', timestamp: 3 })
      ]
    })
    await waitFor(() => expect(view.container.querySelector('[data-matrix-progress-line]')).toBeNull())
    expect(view.container.querySelector('[data-matrix-agent-typing]')).toBeNull()
    expect(screen.getByText('Ba chỗ còn phòng nhé.')).toBeTruthy()
    // The interim remark is still an ordinary message of the turn.
    expect(screen.getByText('Để mình xem vài chỗ yên tĩnh quanh hồ nhé.')).toBeTruthy()
  })

  it('never shows an ended or legacy status line, but keeps a real outcome notice', async () => {
    const { emit, view } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const room = {
      ...assistantFields,
      id: '!assistant:test',
      name: 'Atum',
      membership: 'join',
      encrypted: true,
      direct: true,
      assistant: true
    }

    const turnMessage = (id: string, body: string, extra: Record<string, unknown> = {}) => ({
      id,
      sender: '@atum:test',
      body,
      timestamp: 2,
      own: false,
      encrypted: true,
      decryptionFailed: false,
      pending: false,
      failed: false,
      attachment: false,
      ...extra
    })

    const progress = (body: string, phase: 'working' | 'settled') =>
      turnMessage(`$${phase}-${body}`, body, {
        notice: true,
        progress: { profile: 'atum.agent-turns/1.3', scope: 'owner_private', phase, kind: 'todo', revision: 1 }
      })

    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      assistant: { userId: '@atum:test', deviceId: 'ATUM' },
      agents: [
        {
          principal: 'agent-atum',
          userId: '@atum:test',
          deviceId: 'ATUM',
          name: 'Atum',
          isDefault: true,
          ready: true,
          hermes: 'ready',
          atumModel: true
        }
      ],
      roomId: room.id,
      rooms: [room],
      messages: [
        turnMessage('$q1', 'Old question.', { sender: '@owner:test', own: true, timestamp: 1 }),
        progress('Đang đọc tài liệu…', 'settled'),
        turnMessage('$a1', 'Old answer.', { timestamp: 2, replyTo: '$q1', resultFor: '$q1' }),
        turnMessage('$q2', 'Another question.', { sender: '@owner:test', own: true, timestamp: 3 }),
        turnMessage('$legacy', 'Đã chờ máy Mac của bạn.', { notice: true }),
        turnMessage('$a2', 'Current answer.', { timestamp: 4, replyTo: '$q2', resultFor: '$q2' }),
        turnMessage('$away', 'MacBook mẫu đang tắt hoặc đã khoá.', { notice: true })
      ]
    })

    await screen.findByText('Current answer.')
    expect(screen.queryByText('Đang đọc tài liệu…')).toBeNull()
    expect(screen.queryByText('Đã chờ máy Mac của bạn.')).toBeNull()
    expect(screen.getByText('MacBook mẫu đang tắt hoặc đã khoá.')).toBeTruthy()
    expect(view.container.querySelector('[data-matrix-progress-line]')).toBeNull()
  })

  it('never shows the assistant typing for a run that is not in this chat (launch check, a group)', async () => {
    const { emit, view } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    const room = { id: '!assistant:test', name: 'Atum', membership: 'join', encrypted: true, assistant: true }
    const typing = () => view.container.querySelector('[data-matrix-agent-typing]')

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      roomId: room.id,
      rooms: [room],
      hermes: 'running'
    }

    emit(state)
    await screen.findByRole('textbox', { name: COMPOSER })
    expect(typing()).toBeNull()

    // A run in this chat does show it (the control for the two cases around it).
    emit({
      ...state,
      hermesActivity: { roomId: room.id, eventId: '$r', invocationId: 'r', state: 'running', text: '', tools: [] }
    })
    await waitFor(() => expect(typing()).toBeTruthy())

    emit({
      ...state,
      hermesActivity: { roomId: '!group:test', eventId: '$g', invocationId: 'g', state: 'running', text: '', tools: [] }
    })
    await waitFor(() => expect(typing()).toBeNull())
  })

  it.each(['published', 'unverified'] as const)(
    'finds a %s old result without a configured executor and never calls invoke',
    async state => {
      const { emit, bridge } = fixture()
      await screen.findByRole('button', { name: 'Continue with Google' })
      vi.mocked(bridge.recoverHermes).mockResolvedValue({
        state,
        eventId: '$reply',
        body: 'Already completed result'
      })
      emit({
        ...signedOut,
        state: 'ready',
        domainEnabled: true,
        hermes: 'unconfigured',
        identity: { userId: '@alice:test', deviceId: 'NEW' },
        roomId: '!a:test',
        rooms: [{ id: '!a:test', name: 'A', membership: 'join', encrypted: true, assistant: true }],
        messages: [
          {
            id: '$old',
            sender: '@alice:test',
            body: 'Old task',
            timestamp: 1,
            own: true,
            encrypted: true,
            decryptionFailed: false,
            pending: false,
            failed: false,
            attachment: false
          }
        ]
      })
      openMessageActions()
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Find the answer' }))
      expect(await screen.findByText('Already completed result')).toBeTruthy()

      if (state === 'unverified') {
        expect(screen.getByText('Saved answer (not verified on this Mac).')).toBeTruthy()
        expect(screen.queryByText(/Found the earlier answer/)).toBeNull()
      }

      expect(bridge.recoverHermes).toHaveBeenCalledWith('!a:test', '$old')
      expect(bridge.invokeHermes).not.toHaveBeenCalled()
      expect(bridge.enrollHermes).not.toHaveBeenCalled()
      emit({ ...signedOut })
      await waitFor(() => expect(screen.queryByText('Already completed result')).toBeNull())
    }
  )

  it('offers an explicit saved-document link, disables listening, and keeps late failures in their original room', async () => {
    const { emit, bridge } = legacyFixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      domainEnabled: true,
      hermes: 'ready',
      identity: { userId: '@alice:test', deviceId: 'A' },
      roomId: '!a:test',
      assistant: { userId: '@atum:test', deviceId: 'ATUM' },
      rooms: [
        {
          ...assistantFields,
          participants: [{ userId: '@alice:test', membership: 'join' }, assistantFields.participants[1]],
          id: '!a:test',
          name: 'A',
          membership: 'join',
          encrypted: true,
          assistant: true
        },
        { id: '!b:test', name: 'B', membership: 'join', encrypted: true }
      ]
    }

    emit(state)
    openAssistantOptions()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Open a document…' }))
    await waitFor(() => expect(bridge.document).toHaveBeenCalledWith('!a:test', 'choose'))
    emit({ ...state, linkedDocument: { name: 'notes.txt', state: 'linked' } })
    expect(screen.getAllByText(/notes.txt/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/reads the saved file each time you ask/).length).toBeGreaterThan(0)
    // A linked document keeps replies on its own confirmed path: no listening while it is linked.
    const reply = () => within(screen.getByRole('dialog')).getByRole('switch', { name: 'Reply in this conversation' })

    const briefly = () =>
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Only for the next 15 minutes' })

    expect(reply().hasAttribute('disabled')).toBe(true)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Advanced' }))
    expect(briefly().hasAttribute('disabled')).toBe(true)
    let reject!: (error: Error) => void
    vi.mocked(bridge.document).mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Choose another document…' }))
    emit({ ...state, roomId: '!b:test', linkedDocument: null })
    await act(async () => reject(new Error('old room')))
    expect(screen.queryByText(/notes.txt/)).toBeNull()
    expect(screen.queryByText(/Choose a file under 20 MB/)).toBeNull()
    emit({ ...state, linkedDocument: { name: 'notes.txt', state: 'reconnect_required' } })
    expect(screen.getByText('Choose this document again to keep using it.')).toBeTruthy()
    openAssistantOptions()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove document' }))
    await waitFor(() => expect(bridge.document).toHaveBeenCalledWith('!a:test', 'remove'))
    emit({ ...state, linkedDocument: null })
    expect(reply().hasAttribute('disabled')).toBe(false)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Advanced' }))
    expect(briefly().hasAttribute('disabled')).toBe(false)
  })

  it('isolates a pending document failure across users in the same room and hides an unreadable name', async () => {
    const { emit, bridge } = legacyFixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      domainEnabled: true,
      hermes: 'ready',
      identity: { userId: '@alice:test', deviceId: 'SAME' },
      assistant: { userId: '@atum:test', deviceId: 'ATUM' },
      roomId: '!shared:test',
      rooms: [
        {
          ...assistantFields,
          participants: [{ userId: '@alice:test', membership: 'join' }, assistantFields.participants[1]],
          id: '!shared:test',
          name: 'Shared',
          membership: 'join',
          encrypted: true,
          assistant: true
        }
      ],
      linkedDocument: { name: 'alice.txt', state: 'linked' }
    }

    emit(state)
    let reject!: (error: Error) => void
    vi.mocked(bridge.document).mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )
    openAssistantOptions()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Choose another document…' }))
    emit({
      ...state,
      identity: { userId: '@bob:test', deviceId: 'SAME' },
      linkedDocument: { name: '', state: 'unavailable' }
    })
    await act(async () => reject(new Error('old account')))
    expect(screen.queryByText(/alice.txt|Choose a file under 20 MB|· Saved file/)).toBeNull()
    expect(screen.getByText('This document can’t be opened. Choose it again or remove it.')).toBeTruthy()
  })

  it('says Atum can’t be reached when the first snapshot fails, with Try again and a quiet sign-out, never the ways in', async () => {
    const { emit, bridge } = fixture(async () => {
      throw new Error('snapshot unavailable')
    })

    await screen.findByRole('heading', { name: 'Can’t reach Atum right now' })
    expect(screen.getByText('Check your connection, then try again.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
    // Nothing is known about an account here, so there is nothing to sign out of.
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(bridge.retry).toHaveBeenCalledOnce()
    emit(signedOut)
    expect(screen.queryByRole('heading', { name: 'Can’t reach Atum right now' })).toBeNull()
    expect(await screen.findByRole('button', { name: 'Continue with Google' })).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('does not let a late startup failure replace a subscribed account snapshot', async () => {
    let reject!: (error: Error) => void

    const { emit } = fixture(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )

    emit({ ...signedOut, state: 'ready', identity: { userId: '@bob:test', deviceId: 'DEVICE' } })
    await act(async () => reject(new Error('old startup read')))
    expect(screen.getByRole('button', { name: 'Account: bob' })).toBeTruthy()
    expect(screen.queryByText('Could not complete the operation. Check the connection and try again.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
  })

  it('account handoff drops drafts, identity panels and late operation failures even with equal device IDs', async () => {
    const { emit, bridge } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      domainEnabled: true,
      identity: { userId: '@alice:test', deviceId: 'DEVICE' },
      roomId: '!alice:test',
      rooms: [{ id: '!alice:test', name: 'Alice room', encrypted: true, membership: 'join' }]
    }

    emit(state)
    fireEvent.change(screen.getByRole('textbox', { name: COMPOSER }), {
      target: { value: '@draft:test' }
    })
    openAssistantSetup()
    toggleDetails('Technical details')
    fireEvent.click(screen.getByRole('button', { name: 'Check your Atum account' }))
    await screen.findByText('Account ID: principal')
    closeAccountSettings()
    let reject!: (error: Error) => void
    vi.mocked(bridge.command).mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Alice room' }))
    emit({ ...state, identity: { userId: '@bob:test', deviceId: 'DEVICE' }, rooms: [] })
    expect(screen.queryByText('Account ID: principal')).toBeNull()
    await waitFor(() => expect(screen.queryByDisplayValue('@draft:test')).toBeNull())
    await act(async () => reject(new Error('old account stopped')))
    expect(screen.queryByText('That didn’t work. Try again.')).toBeNull()
    // A current-account failure must still be shown, then disappear on logout.
    // Use a root action, rather than relying on a child's error presentation.
    vi.mocked(bridge.signOut).mockRejectedValueOnce(new Error('offline'))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Account: bob' }), { button: 0 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }))
    const confirm = await screen.findByRole('dialog', { name: 'Sign out of Atum on this Mac?' })
    // Bob's recovery key is not confirmed yet: the warning's version of the button.
    fireEvent.click(within(confirm).getByRole('button', { name: 'Sign out anyway' }))
    await screen.findByText('Couldn’t sign out. Check your connection and try again.')
    emit(signedOut)
    await waitFor(() =>
      expect(screen.queryByText('Couldn’t sign out. Check your connection and try again.')).toBeNull()
    )
  })

  it('acknowledges only the conversation on screen in a focused window, with no manual read control', async () => {
    const { emit, bridge } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    let focused = true
    vi.spyOn(window.document, 'hasFocus').mockImplementation(() => focused)
    const attend = vi.fn<NonNullable<MatrixUiBridge['attend']>>(async () => null)
    bridge.attend = attend

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@alice:test', deviceId: 'A' },
      rooms: [{ id: '!read:test', name: 'Read room', encrypted: true, membership: 'join', unreadNotifications: 3 }],
      roomId: '!read:test',
      messages: [
        {
          id: '$first',
          sender: '@alice:test',
          body: 'Hello',
          timestamp: 1,
          own: true,
          encrypted: true,
          decryptionFailed: false,
          pending: false,
          failed: false,
          attachment: false,
          readBy: ['@bob:test']
        }
      ]
    }

    emit(state)
    await waitFor(() => expect(attend).toHaveBeenLastCalledWith('!read:test'))
    // The badge is the server's count: it clears when sync says so, never optimistically.
    expect(screen.getByLabelText('Unread notifications: 3')).toBeTruthy()
    // Seen by, as the reader's face, named for screen readers — never a native title or a raw ID.
    const seen = window.document.querySelector('[data-matrix-seen]')!
    expect(seen.getAttribute('aria-label')).toBe('Seen by 1')
    expect(seen.getAttribute('title')).toBeNull()
    expect(seen.textContent).not.toContain('@bob:test')
    // The conversation menu has no manual read control either.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Conversation options' }), { key: 'Enter' })
    const menu = screen.getByRole('menu')
    expect(within(menu).queryByRole('menuitem', { name: /Mark.*read/i })).toBeNull()
    expect(within(menu).queryByText(/read receipt visible to everyone/)).toBeNull()
    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    // Another app in front: nothing is being read here.
    focused = false
    act(() => void window.dispatchEvent(new Event('blur')))
    await waitFor(() => expect(attend).toHaveBeenLastCalledWith(null))
    focused = true
    act(() => void window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(attend).toHaveBeenLastCalledWith('!read:test'))

    // Settings covers the transcript.
    openAccountSettings()
    await waitFor(() => expect(attend).toHaveBeenLastCalledWith(null))
    closeAccountSettings()
    await waitFor(() => expect(attend).toHaveBeenLastCalledWith('!read:test'))

    emit({ ...state, roomId: null })
    await waitFor(() => expect(attend).toHaveBeenLastCalledWith(null))
    expect(bridge.command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'markRead' }))
  })

  it.each(['approval', 'clarify'] as const)(
    'stays quiet about time, says the last minute is short, and blocks late %s responses without answering automatically',
    async kind => {
      const { emit, bridge } = fixture()
      await screen.findByRole('button', { name: 'Continue with Google' })
      vi.useFakeTimers()

      const prompt: MatrixHermesPrompt =
        kind === 'approval'
          ? { id: 'a', deadlineAt: Date.now() + 90_000, kind, command: 'fixture', description: '', allowOnce: true }
          : { id: 'q', deadlineAt: Date.now() + 90_000, kind, question: 'Where?', choices: ['Here'] }

      const state: MatrixSnapshot = {
        ...signedOut,
        state: 'ready',
        identity: { userId: '@owner:test', deviceId: 'D' },
        hermes: 'running',
        rooms: [{ id: '!room:test', name: 'Input room', membership: 'join', encrypted: true }],
        roomId: '!room:test',
        hermesPrompts: { roomId: '!room:test', prompts: [prompt] }
      }

      emit(state)
      // With a minute and a half to go nothing about time is on the card: no stopwatch.
      expect(screen.queryByRole('timer')).toBeNull()
      act(() => vi.advanceTimersByTime(40_000))
      // The last minute says it is short, without counting.
      expect(screen.getByRole('timer').textContent).toBe(matrixActionCopy.en.promptDeadlineSoon)
      expect(screen.getByRole('timer').getAttribute('aria-live')).toBe('off')
      emit(state) // ordinary snapshots must not restart the timer
      expect(screen.getByRole('timer').textContent).toBe(matrixActionCopy.en.promptDeadlineSoon)
      // Clock crosses the deadline before the next renderer tick: the enabled
      // control must catch the synchronous guard and send no native response.
      vi.setSystemTime(Date.now() + 60_000)
      const action = screen.getByRole('button', { name: kind === 'approval' ? 'Allow' : /Skip/ })
      expect(action.closest('fieldset')?.disabled).toBe(false)
      await act(async () => {
        fireEvent.click(action)
      })
      expect(screen.getByRole('timer').textContent).toBe(matrixActionCopy.en.promptDeadlineEnded)
      expect(action.closest('fieldset')?.disabled).toBe(true)
      await act(async () => {
        fireEvent.click(action)
      })
      expect(bridge.respondHermes).not.toHaveBeenCalled()
      expect(bridge.invokeHermes).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
      expect(bridge.cancelHermes).toHaveBeenCalledOnce()
      emit({ ...state, hermesPrompts: undefined })
      expect(screen.queryByRole('timer')).toBeNull()
    }
  )

  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)(
    'retains and dismisses room-scoped expiry feedback in %s after input disappears',
    async locale => {
      const { emit, bridge } = fixture(undefined, locale)
      const copy = matrixActionCopy[locale]

      const state: MatrixSnapshot = {
        ...signedOut,
        state: 'ready',
        identity: { userId: '@owner:test', deviceId: 'D' },
        hermes: 'ready',
        rooms: [{ id: '!room:test', name: 'Input room', membership: 'join', encrypted: true }],
        roomId: '!other:test',
        hermesPromptNotice: { id: 'n1', roomId: '!room:test', reason: 'clarification_expired' }
      }

      emit(state)
      expect(screen.getByText(`Input room · ${copy.clarificationExpired}`)).toBeTruthy()
      expect(screen.queryByRole('region', { name: copy.hermesNeedsInput })).toBeNull()
      expect(bridge.command).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: copy.dismissPromptNotice }))
      emit(state)
      expect(screen.queryByText(`Input room · ${copy.clarificationExpired}`)).toBeNull()
      emit({ ...state, hermesPromptNotice: { id: 'n2', roomId: '!room:test', reason: 'deadline_expired' } })
      expect(screen.getByText(`Input room · ${copy.promptTurnExpired}`)).toBeTruthy()
      emit(signedOut)
      expect(screen.queryByText(`Input room · ${copy.promptTurnExpired}`)).toBeNull()
      expect(bridge.respondHermes).not.toHaveBeenCalled()
      expect(bridge.invokeHermes).not.toHaveBeenCalled()
    }
  )

  it("explicitly listens in one room, stops it from that room's switch, and never says it in a chat", async () => {
    const { emit, bridge } = legacyFixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const room = {
      ...assistantFields,
      id: '!room:test',
      name: 'Agent room',
      membership: 'join',
      encrypted: true,
      assistant: true
    }

    const other = { ...room, id: '!other:test', name: 'Other room' }

    const state: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'DEVICE' },
      domainEnabled: true,
      hermes: 'ready',
      rooms: [room, other],
      assistant: { userId: '@atum:test', deviceId: 'ATUM' },
      roomId: room.id
    }

    emit(state)
    openAssistantOptions()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Advanced' }))
    fireEvent.click(
      await within(screen.getByRole('dialog')).findByRole('button', { name: 'Only for the next 15 minutes' })
    )
    await waitFor(() => expect(bridge.listenHermes).toHaveBeenCalledExactlyOnceWith(room.id, 'en'))
    expect(bridge.setContinuousListening).not.toHaveBeenCalled()
    emit({
      ...state,
      roomId: other.id,
      hermesListening: { state: 'listening', roomId: room.id, expiresAt: Date.now() + 60000, queued: 0 }
    })
    // Another chat's reply settings say nothing of it; that chat's own switch stops it.
    openAssistantOptions()
    expect(within(screen.getByRole('dialog')).queryByText(matrixActionCopy.en.listening)).toBeNull()
    expect(within(screen.getByRole('dialog')).queryByText(matrixActionCopy.en.continuousListening)).toBeNull()
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Stop listening' })).toBeNull()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    emit({
      ...state,
      hermesListening: { state: 'listening', roomId: room.id, expiresAt: Date.now() + 60000, queued: 0 }
    })
    openAssistantOptions()
    const reply = within(screen.getByRole('dialog')).getByRole('switch', { name: 'Reply in this conversation' })
    expect(reply.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(reply)
    await waitFor(() => expect(bridge.stopListeningHermes).toHaveBeenCalledExactlyOnceWith(room.id))
    // An outcome nobody knows is never said in the chat.
    emit({
      ...state,
      hermesListening: {
        state: 'stopped',
        roomId: room.id,
        expiresAt: Date.now(),
        queued: 0,
        reason: 'unavailable',
        result: 'unknown'
      }
    })
    expect(screen.queryByText(/couldn.t confirm how this finished/)).toBeNull()
    emit(state)
    expect(bridge.listenHermes).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['the default agent', '!default:test', undefined],
    ['another agent', '!other-agent:test', 'other-agent']
  ] as const)('enables continuous listening only for %s selected room', async (_name, roomId, agentPrincipal) => {
    const { emit, bridge } = legacyFixture()
    const assistantUserId = agentPrincipal ? '@other-agent:test' : '@atum:test'

    const room = {
      id: roomId,
      name: 'Agent room',
      membership: 'join' as const,
      encrypted: true,
      assistant: true,
      roomType: MATRIX_ASSISTANT_ROOM_TYPE,
      participants: [
        { userId: '@owner:test', membership: 'join' as const },
        { userId: assistantUserId, membership: 'join' as const }
      ],
      ...(agentPrincipal ? { agentPrincipal } : {})
    }

    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'OWNER' },
      assistant: { userId: '@atum:test', deviceId: 'ATUM' },
      hermes: 'ready',
      roomId,
      rooms: [room],
      agents: agentPrincipal
        ? [
            {
              principal: 'default',
              userId: '@atum:test',
              isDefault: true,
              ready: true,
              hermes: 'ready',
              atumModel: true
            },
            {
              principal: agentPrincipal,
              userId: assistantUserId,
              isDefault: false,
              ready: true,
              hermes: 'ready',
              atumModel: true
            }
          ]
        : undefined
    })

    openAssistantOptions()
    fireEvent.click(
      await within(screen.getByRole('dialog')).findByRole('switch', { name: 'Reply in this conversation' })
    )
    await waitFor(() => expect(bridge.setContinuousListening).toHaveBeenCalledExactlyOnceWith(roomId, true, 'en'))
    expect(bridge.listenHermes).not.toHaveBeenCalled()
  })

  it('reuses the approval UI without stealing focus, broad grants or global shortcuts', async () => {
    const { emit, bridge } = fixture()
    const room = { id: '!room:test', name: 'Test room', membership: 'join', encrypted: true }

    const snapshot: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@alice:test', deviceId: 'device' },
      rooms: [room],
      roomId: room.id,
      hermes: 'running',
      hermesPrompts: {
        roomId: room.id,
        prompts: [
          {
            id: 'approval-1',
            deadlineAt: Date.now() + 60000,
            kind: 'approval',
            command: 'fixture command',
            description: 'Permission required',
            allowOnce: true
          }
        ]
      }
    }

    emit({ ...snapshot, hermesPrompts: undefined })
    const composer = screen.getByRole('textbox', { name: /message/i })
    composer.focus()
    emit(snapshot)
    expect(globalThis.document.activeElement).toBe(composer)
    // The card asks plainly; the exact command and the reason wait behind Details.
    expect(screen.getByText('Allow this on your Mac?')).toBeTruthy()
    expect(screen.queryByText('fixture command')).toBeNull()
    expect(screen.queryByText('Permission required')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('fixture command')).toBeTruthy()
    expect(screen.getByText('Permission required')).toBeTruthy()
    expect(
      within(screen.getByRole('region', { name: /Your assistant needs your answer/i })).queryByRole('button', {
        name: /always|session/i
      })
    ).toBeNull()
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true })
    expect(bridge.respondHermes).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await waitFor(() =>
      expect(bridge.respondHermes).toHaveBeenCalledWith({ id: 'approval-1', kind: 'approval', choice: 'once' })
    )
    emit({
      ...snapshot,
      hermesPrompts: { roomId: room.id, prompts: [{ ...snapshot.hermesPrompts!.prompts[0], id: 'approval-2' }] }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await waitFor(() =>
      expect(bridge.respondHermes).toHaveBeenCalledWith({ id: 'approval-2', kind: 'approval', choice: 'deny' })
    )
    emit({ ...snapshot, hermesPrompts: undefined })
    expect(screen.queryByText('fixture command')).toBeNull()
  })

  it('retains background input, scopes clarify answers to the card, and drops it on sign-out', async () => {
    const { emit, bridge } = fixture()
    const room = { id: '!room:test', name: 'Needs input room', membership: 'join', encrypted: true }

    const snapshot: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@alice:test', deviceId: 'device' },
      rooms: [room],
      roomId: '!other:test',
      hermes: 'running',
      hermesPrompts: {
        roomId: room.id,
        prompts: [
          {
            id: 'question-1',
            deadlineAt: Date.now() + 60000,
            kind: 'clarify',
            question: 'Where shall we work?',
            choices: ['Here', 'There']
          }
        ]
      }
    }

    emit(snapshot)
    expect(screen.getByText(/Your assistant needs your answer/)).toBeTruthy()
    expect(screen.queryByText('Where shall we work?')).toBeNull()
    expect(bridge.command).not.toHaveBeenCalled()
    const pending = screen.getByRole('region', { name: 'Your assistant needs your answer' })
    fireEvent.click(within(pending).getByRole('button', { name: room.name }))
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith({ kind: 'select', roomId: room.id }))
    emit({ ...snapshot, roomId: room.id })
    fireEvent.click(screen.getByRole('button', { name: /Here/ }))
    expect(bridge.respondHermes).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
    await waitFor(() =>
      expect(bridge.respondHermes).toHaveBeenCalledWith({ id: 'question-1', kind: 'clarify', answer: 'Here' })
    )
    emit({
      ...snapshot,
      roomId: room.id,
      hermesPrompts: {
        roomId: room.id,
        prompts: [
          { id: 'question-2', deadlineAt: Date.now() + 60000, kind: 'clarify', question: 'Anything else?', choices: [] }
        ]
      }
    })
    fireEvent.click(screen.getByRole('button', { name: /Skip/ }))
    await waitFor(() =>
      expect(bridge.respondHermes).toHaveBeenCalledWith({ id: 'question-2', kind: 'clarify', answer: '' })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(bridge.cancelHermes).toHaveBeenCalledOnce()
    emit(signedOut)
    expect(screen.queryByText('Anything else?')).toBeNull()
  })

  it.each(['approval', 'clarify'] as const)(
    'recovers from a failed %s response without losing the card',
    async kind => {
      const { emit, bridge } = fixture()
      const room = { id: '!room:test', name: 'Test room', membership: 'join', encrypted: true }

      const prompt: MatrixHermesPrompt =
        kind === 'approval'
          ? {
              id: 'retry',
              deadlineAt: Date.now() + 60000,
              kind,
              command: 'fixture',
              description: 'Permission required',
              allowOnce: true
            }
          : { id: 'retry', deadlineAt: Date.now() + 60000, kind, question: 'Continue?', choices: [] }

      vi.mocked(bridge.respondHermes).mockRejectedValueOnce(new Error('fixture transport failure'))
      emit({
        ...signedOut,
        state: 'ready',
        identity: { userId: '@alice:test', deviceId: 'device' },
        rooms: [room],
        roomId: room.id,
        hermes: 'running',
        hermesPrompts: { roomId: room.id, prompts: [prompt] }
      })
      const action = kind === 'approval' ? 'Allow' : /Skip/
      const failure = `Could not send ${kind} response`
      fireEvent.click(screen.getByRole('button', { name: action }))
      await screen.findByText(failure)
      expect((screen.getByRole('button', { name: action }) as HTMLButtonElement).disabled).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: action }))
      await waitFor(() => expect(bridge.respondHermes).toHaveBeenCalledTimes(2))
      expect(screen.queryByText(failure)).toBeNull()
    }
  )

  it.each([false, true])(
    'runs only an explicit own-message action (file=%s), reports cancellation, and exposes stop while running',
    async attachment => {
      const { emit, bridge } = legacyFixture()

      const state: MatrixSnapshot = {
        ...signedOut,
        state: 'ready',
        identity: { userId: '@alice:test', deviceId: 'A' },
        domainEnabled: true,
        hermes: 'ready',
        roomId: '!room:test',
        assistant: { userId: '@atum:test', deviceId: 'ATUM' },
        rooms: [
          {
            ...assistantFields,
            participants: [{ userId: '@alice:test', membership: 'join' }, assistantFields.participants[1]],
            id: '!room:test',
            name: 'Test room',
            membership: 'join',
            encrypted: true,
            assistant: true
          }
        ],
        messages: [
          {
            id: '$message',
            sender: '@alice:test',
            body: 'Run pwd',
            timestamp: 1,
            own: true,
            encrypted: true,
            decryptionFailed: false,
            pending: false,
            failed: false,
            attachment
          }
        ]
      }

      emit(state)
      openMessageActions()
      const run = await screen.findByRole('menuitem', { name: 'Retry' })
      expect(bridge.invokeHermes).not.toHaveBeenCalled()
      fireEvent.click(run)
      await screen.findByText('Cancelled. Nothing was run.')
      expect(bridge.invokeHermes).toHaveBeenCalledWith('!room:test', '$message', 'en')
      openAssistantOptions()
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Advanced' }))
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect your assistant' }))
      await waitFor(() => expect(bridge.connectHermes).toHaveBeenCalledWith('!room:test'))
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
      const retry = () => screen.getByRole('menuitem', { name: 'Retry' }).getAttribute('aria-disabled')
      emit({ ...state, hermes: 'running' })
      openMessageActions()
      expect(retry()).toBe('true')
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
      await waitFor(() => expect(bridge.cancelHermes).toHaveBeenCalledTimes(1))
      emit({ ...state, hermes: 'unconfigured' })
      await screen.findByText('Your assistant isn’t set up on this Mac yet.')
      openMessageActions()
      expect(retry()).toBe('true')
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
      emit({ ...state, hermes: 'invalid' })
      await screen.findByText(
        'Your assistant couldn’t start on this Mac. Reinstall Atum to fix it; your chats are safe.'
      )
      openMessageActions()
      expect(retry()).toBe('true')
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
      expect(screen.getByText('Run pwd')).toBeTruthy()
      emit({ ...state, messages: [{ ...state.messages[0], decryptionFailed: true }] })
      await waitFor(() => expect(window.document.querySelector('[data-matrix-message-actions]')).toBeNull())
      emit({ ...state, messages: [{ ...state.messages[0], own: false, sender: '@other:test' }] })
      await waitFor(() => expect(window.document.querySelector('[data-matrix-message-actions]')).toBeNull())
    }
  )
  it('keeps a failed sign-in on the sign-in screen, saying which way failed, and never turns it into an account error', async () => {
    const { emit, bridge } = fixture()
    vi.mocked(bridge.signIn).mockImplementationOnce(async () => {
      // Main publishes the failure, then the bridge call rejects (main.ts signIn).
      emit({ ...signedOut, state: 'error', error: 'matrix_connection_failed' })
      throw new Error('matrix_operation_failed')
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Google' }))
    expect(await screen.findByText('Couldn’t sign in with Google. Check your connection, then try again.')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Can’t reach Atum right now' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
    await waitFor(() => expect(bridge.signIn).toHaveBeenCalledTimes(2))
  })
  it('opens without a startup error and requests browser sign-in only on click', async () => {
    const { bridge } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    expect(screen.queryByRole('status')).toBeNull()
    expect(bridge.signIn).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
    await waitFor(() => expect(bridge.signIn).toHaveBeenCalledTimes(1))
  })
  it('a late initial snapshot cannot replace a newer sign-in event', async () => {
    let resolve!: (value: MatrixSnapshot) => void

    const { emit, bridge, view, unsubscribe } = fixture(
      () =>
        new Promise(done => {
          resolve = done
        })
    )

    emit({ ...signedOut, state: 'signing_in' })
    await act(async () => resolve(signedOut))
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(bridge.cancelSignIn).toHaveBeenCalledTimes(1))
    view.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)(
    'offers a localized restart after browser timeout, without collecting credentials in %s',
    async locale => {
      const { emit, bridge } = fixture(undefined, locale)
      emit({ ...signedOut, error: 'matrix_login_timed_out' })
      const notice = screen.getByRole('status')
      expect(notice.textContent).not.toMatch(/matrix_login_timed_out/)
      expect(notice.textContent!.length).toBeGreaterThan(20)

      const label = {
        en: 'Continue with Google',
        vi: 'Tiếp tục với Google',
        ja: 'Google で続行',
        zh: '使用 Google 继续',
        'zh-hant': '使用 Google 繼續'
      }[locale]

      expect(window.document.querySelector('input[type="password"]')).toBeNull()
      fireEvent.click(await screen.findByRole('button', { name: label }))
      await waitFor(() => expect(bridge.signIn).toHaveBeenCalledTimes(1))
    }
  )
  it('puts a split disk-full notice and its action directly above the composer', async () => {
    const { emit, bridge, view } = fixture()

    const room = {
      id: '!disk-full:test',
      name: 'Atum',
      membership: 'join' as const,
      encrypted: true,
      assistant: true,
      ...assistantFields
    }

    emit({
      ...signedOut,
      state: 'error',
      error: 'matrix_disk_full',
      identity: { userId: '@owner:test', deviceId: 'A' },
      domainEnabled: true,
      readiness: { phase: 'ready', since: 1 },
      rooms: [room],
      roomId: room.id
    })

    const notice = view.container.querySelector<HTMLElement>('[data-matrix-composer-notice="disk-full"]')!
    expect(await within(notice).findByText("This Mac's disk is full")).toBeTruthy()
    expect(within(notice).getByText('Free up space and Atum reconnects on its own.')).toBeTruthy()
    expect(notice.closest('[data-slot="composer-root"]')).toBeTruthy()
    expect(view.container.querySelector('[data-matrix-status-stack] [data-matrix-composer-notice]')).toBeNull()
    fireEvent.click(within(notice).getByRole('button', { name: 'Open Storage settings' }))
    expect(bridge.openStorageSettings).toHaveBeenCalledOnce()
    emit({ ...signedOut, state: 'ready', identity: { userId: '@owner:test', deviceId: 'A' }, rooms: [room], roomId: room.id })
    await waitFor(() => expect(view.container.querySelector('[data-matrix-composer-notice="disk-full"]')).toBeNull())
  })
  // Preserve user-visible identity, state and recovery behavior across connection changes.
  // it was dismissed. A filling disk is the status indicator's, top right, and nowhere in the panel.
  it('keeps a nearly full disk out of the chat panel: the status indicator says it, no band or pill', async () => {
    const { emit, view } = fixture()
    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@alice:test', deviceId: 'A' },
      domainEnabled: true,
      readiness: { phase: 'ready', since: 1 },
      disk: { state: 'critical', freeGb: 1.6 },
      rooms: [{ id: '!chat:test', name: 'Atum QA', membership: 'join', encrypted: false, direct: true }],
      roomId: '!chat:test'
    })

    await screen.findByRole('button', { name: /Mac is out of space/ })
    expect(view.container.querySelector('[data-matrix-status-stack] [data-matrix-disk]')).toBeNull()
    expect(view.container.querySelector('[data-matrix-disk-dismissed]')).toBeNull()
    expect(screen.queryByText(/Storage critical/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Dismiss for now|Show storage warning/ })).toBeNull()
  })
  it('presents pending remote logout honestly and retries logout rather than implying success', async () => {
    const { emit, bridge } = fixture()
    emit({ ...signedOut, state: 'error', error: 'matrix_sign_out_pending' })
    await screen.findByRole('heading', { name: 'Signing out didn’t finish' })
    expect(screen.getByText(/some cleanup is left/)).toBeTruthy()
    // Its own screen: the ways in are not there at all, not merely disabled.
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(bridge.signOut).toHaveBeenCalledTimes(1))
    expect(bridge.signIn).not.toHaveBeenCalled()
  })
  it('only reads a configured domain resource on request and displays the returned principal', async () => {
    const { emit, bridge } = fixture()
    emit({ ...signedOut, state: 'ready', identity: { userId: '@alice:test', deviceId: 'A' }, domainEnabled: true })
    expect(bridge.readDomain).not.toHaveBeenCalled()
    openAtumAccount()
    fireEvent.click(screen.getByRole('button', { name: 'Check your Atum account' }))
    await screen.findByText('Account ID: principal')
    expect(bridge.readDomain).toHaveBeenCalledTimes(1)
    emit(signedOut)
    expect(screen.queryByText('Account ID: principal')).toBeNull()
  })
  it('cancel and account removal discard a late domain response without showing an error', async () => {
    const { emit, bridge } = fixture()
    let finish!: (value: Awaited<ReturnType<MatrixUiBridge['readDomain']>>) => void
    vi.mocked(bridge.readDomain).mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    emit({ ...signedOut, state: 'ready', identity: { userId: '@alice:test', deviceId: 'A' }, domainEnabled: true })
    openAtumAccount()
    fireEvent.click(screen.getByRole('button', { name: 'Check your Atum account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(bridge.cancelDomain).toHaveBeenCalledTimes(1)
    await act(async () => finish({ issuer: 'https://id.test/', subject: 'alice', principal: 'late-principal' }))
    expect(screen.queryByText(/late-principal/)).toBeNull()
    expect(screen.queryByText(/Could not verify/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check your Atum account' }))
    emit(signedOut)
    await act(async () => finish({ issuer: 'https://id.test/', subject: 'alice', principal: 'after-logout' }))
    expect(screen.queryByText(/after-logout/)).toBeNull()
  })
  it('registers only on explicit request and represents unresolved server cleanup without claiming execution', async () => {
    const { emit, bridge } = fixture()
    emit({ ...signedOut, state: 'ready', identity: { userId: '@alice:test', deviceId: 'A' }, domainEnabled: true })
    openAtumAccount()
    await screen.findByText('Not connected')
    expect(bridge.enrollHermes).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Connect assistant' }))
    await screen.findByText('Connected on this Mac')
    vi.mocked(bridge.revokeHermes).mockRejectedValueOnce(new Error('network'))
    vi.mocked(bridge.enrollment).mockResolvedValue({ state: 'revoking', identity: null })
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    await screen.findByText('Disconnecting didn’t finish. Try Disconnect again.')
    expect((screen.getByRole('button', { name: 'Connect assistant' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Disconnect' }) as HTMLButtonElement).disabled).toBe(false)
    emit(signedOut)
    expect(screen.queryByText('Assistant connection on this Mac')).toBeNull()
  })
  it('can retry a pending registration after restart from the actual UI', async () => {
    const { emit, bridge } = fixture()
    vi.mocked(bridge.enrollment).mockResolvedValue({ state: 'pending', identity: null })
    emit({ ...signedOut, state: 'ready', identity: { userId: '@alice:test', deviceId: 'A' }, domainEnabled: true })
    openAtumAccount()
    await screen.findByText('Connecting didn’t finish. Connect again, or disconnect.')
    fireEvent.click(screen.getByRole('button', { name: 'Connect assistant' }))
    await waitFor(() => expect(bridge.enrollHermes).toHaveBeenCalledTimes(1))
  })
  it('retries a failed local status read without claiming registration failed or starting enrollment', async () => {
    const { emit, bridge } = fixture()
    vi.mocked(bridge.enrollment).mockRejectedValueOnce(new Error('vault'))
    emit({ ...signedOut, state: 'ready', identity: { userId: '@alice:test', deviceId: 'A' }, domainEnabled: true })
    openAtumAccount()
    await screen.findByText('Couldn’t check the connection on this Mac.')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await screen.findByText('Not connected')
    expect(bridge.enrollHermes).not.toHaveBeenCalled()
  })
  it('starts the chosen way in, and says plainly when email sign-in is not open yet', async () => {
    const { bridge, emit } = fixture()
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with email' }))
    expect(bridge.signIn).toHaveBeenCalledExactlyOnceWith('email')
    emit({ ...signedOut, error: 'matrix_password_unavailable' })
    expect((await screen.findByRole('status')).textContent).toBe(
      'Email sign-in isn’t supported yet. Continue with Google for now.'
    )
    expect(screen.queryByRole('button', { name: 'Create an account' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
    expect(bridge.signIn).toHaveBeenLastCalledWith('google')
  })
  it('offers only Google once main has learned the server takes no email sign-in', async () => {
    const { bridge, emit } = fixture()
    await screen.findByRole('button', { name: 'Continue with email' })
    emit({ ...signedOut, signInMethods: { email: 'unavailable' } })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Continue with email' })).toBeNull())
    expect(screen.queryByRole('button', { name: 'Create an account' })).toBeNull()
    expect(screen.getByText('New to Atum? Continue with Google to create your account.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
    expect(bridge.signIn).toHaveBeenCalledExactlyOnceWith('google')
  })
  it('allows fresh sign-in while honestly warning about retained operator reconciliation', async () => {
    const { emit } = fixture()
    emit({ ...signedOut, agentCleanupRequired: true })
    await screen.findByText(
      'An earlier assistant setup needs cleaning up by Atum support. Nothing is lost, and you can keep using Atum.'
    )
    expect((screen.getByRole('button', { name: 'Continue with Google' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('first-launch assistant setup', () => {
  const noAssistant: MatrixSnapshot = {
    ...signedOut,
    state: 'ready',
    identity: { userId: '@owner:test', deviceId: 'DEVICE' },
    domainEnabled: true,
    hermes: 'unavailable'
  }

  it('offers one click when automatic setup could not run, with one line saying why, then calls setup', async () => {
    const { bridge } = fixture(async () => ({ ...noAssistant, assistantSetup: 'action_required' }))
    expect(await screen.findByText('Atum isn’t set up on this Mac yet.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Set up now' }))
    expect(bridge.setupAssistant).toHaveBeenCalledOnce()
  })
  it('never asks a cloud-only primary to set up on this Mac', async () => {
    fixture(async () => ({
      ...noAssistant,
      readiness: { phase: 'ready', since: 1 },
      agents: [
        {
          principal: '22345678-1234-1234-1234-123456789abc',
          userId: '@agent-0123:test',
          isDefault: true,
          ready: false,
          hermes: 'unavailable',
          readiness: { phase: 'ready', since: 1 },
          atumModel: true,
          answering: 'cloud'
        }
      ]
    }))

    expect(await screen.findByRole('button', { name: 'Atum' })).toBeTruthy()
    expect(window.document.querySelector('[data-matrix-setup-card]')).toBeNull()
    expect(screen.queryByText('Atum isn’t set up on this Mac yet.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Set up now' })).toBeNull()
  })
  it('shows progress while setting up and Try again after a failure', async () => {
    const { emit } = fixture(async () => ({ ...noAssistant, assistantSetup: 'working' }))
    expect(await screen.findByText('Setting up your assistant…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Set up now' })).toBeNull()
    emit({ ...noAssistant, assistantSetup: 'failed' })
    expect(await screen.findByText('Your assistant is not set up yet. Please try again.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Set up now' })).toBeNull()
  })
  it('keeps retry reachable when the assistant exists but its model setup failed', async () => {
    const { bridge } = fixture(async () => ({
      ...noAssistant,
      assistant: { userId: '@agent-0123:test', deviceId: 'A' },
      assistantSetup: 'failed'
    }))

    expect(await screen.findByText('Your assistant is not set up yet. Please try again.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(bridge.setupAssistant).toHaveBeenCalledOnce()
  })
  it('names the ready assistant in Vietnamese without showing its Matrix ID', async () => {
    fixture(
      async () => ({ ...noAssistant, hermes: 'ready', assistant: { userId: '@agent-0123:test', deviceId: 'A' } }),
      'vi'
    )
    const button = await screen.findByRole('button', { name: 'Atum' })
    // The decorative avatar now uses the first grapheme, including Atum.
    expect(within(button).getByText('Atum').textContent).toBe('Atum')
    expect(button.querySelector('[data-atum-assistant-avatar]')?.getAttribute('aria-hidden')).toBe('true')
    expect(button.textContent).not.toContain('@agent-0123:test')
    expect(screen.queryByRole('button', { name: 'Thiết lập Atum' })).toBeNull()
  })
})

describe('cold-start preparation screen', () => {
  const owner = { userId: '@owner:test', deviceId: 'DEVICE' }

  const preparing: MatrixSnapshot = {
    ...signedOut,
    state: 'ready',
    identity: owner,
    domainEnabled: true,
    hermes: 'unconfigured',
    startup: { step: 'assistant', state: 'working' }
  }

  const plate = () => window.document.querySelector('[data-slot="matrix-startup"]')

  it('offers actual recovery at startup rather than trapping an encrypted identity behind Retry', async () => {
    const { bridge } = fixture(async () => ({
      ...preparing,
      readiness: { phase: 'blocked', step: 'assistant', code: 'recovery_required', since: 1 },
      security: { recovery: 'idle' }
    }))

    await waitFor(() => expect(plate()?.textContent).toContain('Unlock your assistant on this Mac'))
    const recovery = within(plate() as HTMLElement)
    expect(recovery.getByRole('button', { name: 'Set up recovery key' })).toBeTruthy()
    fireEvent.click(recovery.getByRole('button', { name: 'Use my recovery key' }))
    const key = recovery.getByLabelText('Recovery key')
    fireEvent.change(key, { target: { value: 'synthetic-recovery' } })
    fireEvent.click(recovery.getByRole('button', { name: 'Unlock' }))
    await waitFor(() =>
      expect(bridge.command).toHaveBeenCalledWith({ kind: 'recoveryRestore', key: 'synthetic-recovery' })
    )
    expect(recovery.queryByLabelText('Their Atum ID')).toBeNull()
  })

  it('holds the window on the real step until the assistant and its model are ready, then lands in its chat', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { bridge, emit } = fixture(async () => ({ ...signedOut, state: 'connecting', identity: owner }))
    await waitFor(() => expect(plate()?.textContent).toContain('Signing you in…'))
    emit(preparing)
    await waitFor(() => expect(plate()?.textContent).toContain('Waking your assistant…'))
    emit({
      ...preparing,
      startup: { step: 'model', state: 'working' },
      assistant: { userId: '@atum:test', deviceId: 'ATUM' }
    })
    await waitFor(() => expect(plate()?.textContent).toContain("Connecting your assistant to Atum's model…"))
    vi.mocked(bridge.command).mockResolvedValueOnce('!assistant:test')
    emit({ ...preparing, startup: undefined, hermes: 'ready', assistant: { userId: '@atum:test', deviceId: 'ATUM' } })
    await passLaunch()
    await waitFor(() => expect(plate()).toBeNull(), LAUNCH_OPENS)
    await waitFor(() =>
      expect(bridge.command).toHaveBeenCalledWith({ kind: 'create', name: '', invite: ['@atum:test'], direct: true })
    )
    expect(bridge.connectHermes).toHaveBeenCalledWith('!assistant:test')
  })
  it('opens the product window for the launch the moment a sign-in lands, and keeps it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { bridge, emit } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    await waitFor(() => expect(bridge.setWindowMode).toHaveBeenLastCalledWith('auth'))
    emit({ ...signedOut, state: 'connecting', identity: owner })
    // Preserve user-visible identity, state and recovery behavior across connection changes.
    await waitFor(() => expect(plate()?.querySelector('.atum-launch-sun')).not.toBeNull())
    expect(plate()?.querySelector('[data-atum-auth]')).toBeNull()
    expect(bridge.setWindowMode).toHaveBeenLastCalledWith('normal')
    emit(preparing)
    await waitFor(() => expect(plate()?.textContent).toContain('Waking your assistant…'))
    emit({ ...preparing, startup: undefined, hermes: 'ready', assistant: { userId: '@atum:test', deviceId: 'ATUM' } })
    await passLaunch()
    await waitFor(() => expect(plate()).toBeNull(), LAUNCH_OPENS)
    expect(vi.mocked(bridge.setWindowMode).mock.calls.map(([mode]) => mode)).toEqual(['auth', 'normal'])
  })
  it('asks for the one click an unfinished Atum account needs and keeps that genuine account gate', async () => {
    const { bridge } = fixture(async () => ({ ...preparing, startup: { step: 'assistant', state: 'action_required' } }))
    await waitFor(() => expect(plate()?.textContent).toContain('Your Atum account didn’t finish connecting'))
    expect(plate()?.querySelector('[data-atum-auth]')).toBeNull()
    await waitFor(() => expect(bridge.setWindowMode).toHaveBeenCalledWith('normal'))
    expect(bridge.setWindowMode).not.toHaveBeenCalledWith('auth')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(bridge.setupAssistant).toHaveBeenCalledOnce()
    expect(plate()).not.toBeNull()
    expect(within(plate() as HTMLElement).queryByRole('button', { name: 'Open Atum anyway' })).toBeNull()
  })
  it('does not let a failed legacy assistant model step hold launch', async () => {
    const { bridge } = fixture(async () => ({ ...preparing, startup: { step: 'model', state: 'failed' } }), 'vi')
    await waitFor(() => expect(plate()).toBeNull(), LAUNCH_OPENS)
    expect(bridge.setupAssistant).not.toHaveBeenCalled()
  })
  it('never covers the sign-in screen, and stops a signed-in account whose chats never loaded on the launch', async () => {
    const { emit, bridge } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    expect(plate()).toBeNull()
    // The sign-in landed, then the session failed before its chats ever loaded.
    emit({ ...preparing, state: 'error', error: 'matrix_connection_failed' })
    await waitFor(() => expect(plate()?.textContent).toContain('Can’t reach Atum right now'))
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull()
    fireEvent.click(within(plate() as HTMLElement).getByRole('button', { name: 'Try again' }))
    expect(bridge.retry).toHaveBeenCalledOnce()
  })
  it('opens a saved account whose chat engine did not start on the launch’s stop, never the sign-in screen', async () => {
    const { bridge } = fixture(async () => ({
      ...signedOut,
      state: 'error',
      identity: owner,
      error: 'matrix_sdk_start_failed',
      domainEnabled: true,
      readiness: { phase: 'starting', step: 'signed_in', since: Date.now() }
    }))

    await waitFor(() => expect(plate()?.textContent).toContain('Couldn’t open your chats'))
    expect(plate()?.textContent).toContain(
      'You’re still signed in on this Mac. Try again — if it keeps happening, send us feedback.'
    )
    expect(window.document.querySelector('[data-atum-auth]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull()
    await waitFor(() => expect(bridge.setWindowMode).toHaveBeenCalledWith('normal'))
    expect(bridge.setWindowMode).not.toHaveBeenCalledWith('auth')
    // The quiet way out is still there: signing out, confirmed in place.
    fireEvent.click(within(plate() as HTMLElement).getByRole('button', { name: 'Sign out' }))
    expect(within(plate() as HTMLElement).getByText('Sign out of Atum on this Mac?')).toBeTruthy()
  })
})

describe("the first launch's story", () => {
  const story = () => window.document.querySelector('[data-slot="matrix-welcome"]')

  it('plays once per install on a clean signed-out start, over a sign-in it keeps out of reach', async () => {
    window.localStorage.removeItem('io.atum.welcome.played')
    fixture()
    await waitFor(() => expect(story()).not.toBeNull())
    const signIn = screen.getByRole('button', { name: 'Continue with Google' })
    expect(signIn.closest('[inert]')).toBeTruthy()
    // Skip is offered once the story has begun, never as an invisible control.
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }, { timeout: 3_000 }))
    await waitFor(() => expect(story()).toBeNull())
    expect(signIn.closest('[inert]')).toBeNull()
    expect(window.localStorage.getItem('io.atum.welcome.played')).toBe('1')
    cleanup()
    fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })
    expect(story()).toBeNull()
  })

  it('skips with Escape', async () => {
    window.localStorage.removeItem('io.atum.welcome.played')
    fixture()
    await waitFor(() => expect(story()).not.toBeNull())
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(story()).toBeNull())
  })

  it('never plays for a signed-in start, a sign-in error, or before the first snapshot', async () => {
    window.localStorage.removeItem('io.atum.welcome.played')
    let resolve!: (value: MatrixSnapshot) => void
    fixture(() => new Promise(done => (resolve = done)))
    // Before main's first snapshot nothing is claimed, signed out or otherwise.
    expect(window.document.querySelector('[data-matrix-unsettled]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull()
    expect(story()).toBeNull()
    await act(async () =>
      resolve({ ...signedOut, state: 'connecting', identity: { userId: '@owner:test', deviceId: 'D' } })
    )
    expect(story()).toBeNull()
    cleanup()
    fixture(async () => ({ ...signedOut, error: 'matrix_login_timed_out' }))
    await screen.findByRole('button', { name: 'Continue with Google' })
    expect(story()).toBeNull()
    expect(window.localStorage.getItem('io.atum.welcome.played')).toBeNull()
  })
})

describe('the sign-in screen asks one thing', () => {
  it('offers only the ways in, with the terms, sharing and the language quiet in its footer: no Mac access guide', async () => {
    const { bridge } = fixture()
    const native = { status: vi.fn(), openSettings: vi.fn() }
    bridge.permissions = native
    await screen.findByRole('button', { name: 'Continue with Google' })
    const auth = window.document.querySelector<HTMLElement>('[data-atum-auth]')!
    expect(within(auth).queryByRole('button', { name: 'Review Mac access' })).toBeNull()
    expect(window.document.querySelector('[data-matrix-permission-guide]')).toBeNull()
    // Only ways in under the welcome: no reconnecting, no signing out.
    const ways = auth.querySelector<HTMLElement>('[data-matrix-ways-in]')!
    expect(
      within(ways)
        .getAllByRole('button')
        .map(button => button.textContent)
    ).toEqual(['Continue with Google', 'Continue with email'])
    expect(within(auth).queryByRole('button', { name: 'Reconnect' })).toBeNull()
    expect(within(auth).queryByRole('button', { name: 'Sign out' })).toBeNull()

    for (const control of within(auth).queryAllByRole('switch')) {
      expect(control.closest('[data-matrix-auth-footer]')).not.toBeNull()
    }

    expect(native.status).not.toHaveBeenCalled()
  })
})

describe('a session the sign-in server ended ', () => {
  const owner = { userId: '@owner:test', deviceId: 'MINI' }
  // As main publishes it (session-route.ts matrixSessionEndedSnapshot): no account open.
  const ended: MatrixSnapshot = { ...signedOut, error: 'matrix_session_ended', domainEnabled: true }

  it('opens on the compact sign-in with the notice, never the account card or Try again, and signs the same person back in', async () => {
    window.localStorage.setItem('io.atum.welcome.played', '1')
    const { bridge, emit } = fixture(async () => ended)

    expect((await screen.findByRole('status')).textContent).toBe(
      'You were signed out on this Mac. Sign in again to continue.'
    )
    expect(window.document.querySelector('[data-matrix-account-unavailable]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull()
    await waitFor(() => expect(bridge.setWindowMode).toHaveBeenCalledWith('auth'))
    expect(bridge.setWindowMode).not.toHaveBeenCalledWith('normal')

    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }))
    expect(bridge.signIn).toHaveBeenCalledExactlyOnceWith('google')
    // Main's sign-in over the ended record: the same account, back in its product window.
    emit({ ...ended, state: 'signing_in', error: null })
    expect(screen.queryByRole('status')?.textContent ?? '').not.toContain('You were signed out')
    emit({ ...signedOut, state: 'connecting', identity: owner, error: null, domainEnabled: true })
    await waitFor(() => expect(bridge.setWindowMode).toHaveBeenLastCalledWith('normal'))
    expect(screen.queryByRole('button', { name: 'Continue with Google' })).toBeNull()
  })

  it('keeps the notice when the person cancels the browser trip, since the account still waits', async () => {
    window.localStorage.setItem('io.atum.welcome.played', '1')
    const { emit } = fixture(async () => ended)
    await screen.findByRole('status')
    emit({ ...ended, state: 'signing_in', error: null })
    emit(ended)

    expect((await screen.findByRole('status')).textContent).toBe(
      'You were signed out on this Mac. Sign in again to continue.'
    )
  })

  it('refuses another account in the same window and offers signing out, confirmed', async () => {
    window.localStorage.setItem('io.atum.welcome.played', '1')
    const { bridge, emit } = fixture(async () => ended)
    await screen.findByRole('status')
    emit({ ...ended, error: 'matrix_account_mismatch' })

    expect((await screen.findByRole('status')).textContent).toContain('a different Atum account')
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign out anyway' }))
    await waitFor(() => expect(bridge.signOut).toHaveBeenCalledOnce())
  })
})

describe('the local assistant path (plan 2026-09-26-reliable-local-first-chat)', () => {
  const owner = { userId: '@owner:test', deviceId: 'DEVICE' }
  const turnId = '00000000-0000-4000-8000-31f949766961'
  const plate = () => window.document.querySelector('[data-slot="matrix-startup"]')

  const ready: MatrixSnapshot = {
    ...signedOut,
    state: 'ready',
    identity: owner,
    assistant: { userId: '@atum:test', deviceId: 'ATUM' },
    domainEnabled: true,
    hermes: 'ready',
    assistantPath: 'local',
    readiness: { phase: 'ready', since: 1 },
    roomId: '!assistant:test',
    rooms: [
      {
        ...assistantFields,
        id: '!assistant:test',
        name: 'Atum',
        membership: 'join',
        encrypted: true,
        direct: true,
        assistant: true
      }
    ]
  }

  const gate = (readiness: MatrixSnapshot['readiness']): MatrixSnapshot => ({ ...ready, readiness })

  function taskDrive(
    taskStatus: MatrixDriveBridge['taskStatus'] = vi.fn(async () => ({ state: 'ready' as const })),
    sendTask: MatrixDriveBridge['sendTask'] = vi.fn(async () => ({ state: 'sent' as const, eventId: '$task' })),
    rows: MatrixDriveView['rows'] = []
  ) {
    const view: MatrixDriveView = { state: 'ready', revision: 9, rows, canGoBack: false, truncated: false }
    let listener: ((next: typeof view) => void) | undefined

    const bridge: MatrixDriveBridge = {
      read: vi.fn(async () => view),
      connect: vi.fn(async () => view),
      chooseFolder: vi.fn(async () => ({ cancelled: true as const })),
      cancelSignIn: vi.fn(async () => view),
      disconnect: vi.fn(async () => ({ ...view, state: 'disconnected' as const })),
      enter: vi.fn(async () => view),
      back: vi.fn(async () => view),
      preview: vi.fn(async () => ({
        token: 'drive-preview',
        name: 'notes.txt',
        kind: 'text' as const,
        text: 'Preview notes',
        size: 13,
        modifiedAt: 1
      })),
      closePreview: vi.fn(async () => {}),
      open: vi.fn(async () => {}),
      reveal: vi.fn(async () => {}),
      taskStatus,
      sendTask,
      subscribe: vi.fn(next => {
        listener = next

        return vi.fn()
      })
    }

    return { bridge, sendTask, taskStatus, emit: (next = view) => act(() => listener?.(next)) }
  }

  function stageTask() {
    act(() => {
      setMatrixDriveTaskScope({ ...owner, roomId: '!assistant:test' }, 9)
      selectMatrixDriveFile('opaque-notes', 'notes.txt', 'read')
    })
  }

  async function openChat(snapshot: MatrixSnapshot = ready, drive?: MatrixDriveBridge) {
    const harness = fixture(async () => snapshot, 'en', undefined, undefined, drive)

    if (snapshot.readiness?.phase === 'blocked' || snapshot.readiness?.phase === 'degraded') {
      await waitForLaunchToOpen()
    }

    await waitFor(() => expect(plate()).toBeNull(), LAUNCH_OPENS)

    return harness
  }

  it("gives the pet one ground: the composer's own top edge, inside the dock", async () => {
    const { bridge, view } = await openChat()
    await screen.findByRole('textbox', { name: COMPOSER })

    const composer = view.container.querySelector<HTMLElement>('[data-slot="composer-surface"]')!

    expect(composer.dataset.petPerch).toBe('composer')
    expect(composer.closest('[data-matrix-composer-dock]')).not.toBeNull()
    // No separate floor marker behind the glass: the rim is the ground now.
    expect(view.container.querySelector('[data-pet-floor]')).toBeNull()
    expect(composer.querySelector('[data-slot="composer-actions"]')).not.toBeNull()
  })

  it('opens the composer plus as a small menu instead of the file picker', async () => {
    await openChat()
    const composer = await screen.findByRole('textbox', { name: COMPOSER })
    const root = composer.closest<HTMLElement>('[data-slot="composer-root"]')!
    const trigger = within(root).getByRole('button', { name: 'Add' })

    // The two attach entries are both the ordinary picker: images, and everything else.
    expect((within(root).getByLabelText('Photos and videos') as HTMLInputElement).accept).toBe('image/*')
    expect(within(root).getByLabelText('Attach file (up to 20 MB)')).toBeTruthy()

    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
    fireEvent.pointerUp(trigger, { button: 0, pointerType: 'mouse' })
    fireEvent.click(trigger)

    const menu = await screen.findByRole('menu')

    // This assistant chat has no routines bridge and no Store roster: only attach applies.
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map(item => item.textContent)
    ).toEqual(['Photos and videos', 'Files'])

    fireEvent.change(composer, { target: { value: 'Keep this draft' } })
    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect((composer as HTMLTextAreaElement).value).toBe('Keep this draft')
  })

  it('always draws Drive and lets its page own unavailable and recovery states', async () => {
    const unavailable: MatrixDriveView = {
      state: 'unavailable',
      revision: 1,
      rows: [],
      canGoBack: false,
      truncated: false
    }

    const listeners = new Set<(next: MatrixDriveView) => void>()
    let current = unavailable

    const drive = {
      read: vi.fn(async () => current),
      subscribe: vi.fn((listener: (next: MatrixDriveView) => void) => {
        listeners.add(listener)

        return () => listeners.delete(listener)
      }),
      taskStatus: vi.fn(async () => ({ state: 'unavailable' as const }))
    } as unknown as MatrixDriveBridge

    const push = (next: MatrixDriveView) =>
      act(() => {
        current = next
        listeners.forEach(listener => listener(next))
      })

    await openChat(ready, drive)
    await waitFor(() => expect(drive.read).toHaveBeenCalled())
    await waitFor(() => expect(window.document.querySelector('[data-atum-nav-home]')).toBeTruthy())
    expect(window.document.querySelector('[data-atum-nav-drive]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Atum Drive' }))
    expect(await screen.findByText('Atum Drive is coming soon')).toBeTruthy()
    push({ ...unavailable, state: 'disconnected', revision: 2 })
    expect(await screen.findByText('Getting your Drive ready — about a minute')).toBeTruthy()
    push({ ...unavailable, revision: 3 })
    expect(await screen.findByText('Atum Drive is coming soon')).toBeTruthy()
    expect(
      screen.getAllByRole('button', { name: 'Atum Drive' }).some(button => button.hasAttribute('data-atum-nav-drive'))
    ).toBe(true)
  })

  it('opens a Drive row in the side panel and Ask returns to the active chat with read authority', async () => {
    const drive = taskDrive(undefined, undefined, [
      { id: 'opaque-notes', name: 'notes.txt', kind: 'file', size: 13, modifiedAt: 1 }
    ])

    await openChat(ready, drive.bridge)

    fireEvent.click(screen.getByRole('button', { name: 'Atum Drive' }))
    await screen.findByRole('heading', { name: 'Recents' })
    fireEvent.doubleClick(window.document.querySelector<HTMLElement>('[data-matrix-drive-item="opaque-notes"]')!)
    await screen.findByText('Preview notes')
    fireEvent.click(screen.getByRole('button', { name: 'Ask Atum about this' }))

    expect(await screen.findByRole('textbox', { name: COMPOSER })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Recents' })).toBeNull()
    expect($matrixDriveTaskSelection.get()).toMatchObject({
      revision: 9,
      scope: { ...owner, roomId: '!assistant:test' },
      selections: [{ id: 'opaque-notes', name: 'notes.txt', mode: 'read' }]
    })
    await waitFor(() => expect(drive.bridge.closePreview).toHaveBeenCalledWith('drive-preview'))
  })

  it('releases startup to human chat and the account menu when native agent authority disappears', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { emit, bridge } = fixture(async () => gate({ phase: 'starting', step: 'signed_in', since: 1 }))
    await screen.findByRole('progressbar', { name: 'Opening Atum' })
    emit({
      ...ready,
      assistant: undefined,
      agents: undefined,
      readiness: undefined,
      startup: undefined,
      hermes: 'unavailable'
    })
    await passLaunch()
    await waitFor(() => expect(plate()).toBeNull(), LAUNCH_OPENS)
    const account = await screen.findByRole('button', { name: 'Account: owner' })
    expect(account.closest('[data-matrix-shell-layer]')?.hasAttribute('inert')).toBe(false)
    fireEvent.pointerDown(account, { button: 0 })
    expect(await screen.findByRole('menu')).toBeTruthy()
    expect(bridge.setupAssistant).not.toHaveBeenCalled()
    expect(bridge.signIn).not.toHaveBeenCalled()
  })

  it('opens automatically during a setup cooldown while assistant sending remains paused', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { emit, bridge } = fixture(async () => gate({ phase: 'starting', step: 'signed_in', since: 1 }))
    await screen.findByRole('progressbar', { name: 'Opening Atum' })
    const retryAt = Date.now() + 12 * 60 * 60_000
    const waiting = gate({ phase: 'starting', step: 'assistant', code: 'rate_limited', since: 1, retryAt })
    emit(waiting)
    await passLaunch()
    await waitForLaunchToOpen()
    const notice = await screen.findByText(/Assistant setup is waiting for a limit to reset/)
    expect(notice.textContent).toContain('Next setup attempt:')
    expect(notice.textContent).toContain('resumes setup automatically')
    // Paused with words in the box (an empty box is muted anyway).
    fireEvent.change(screen.getByRole('textbox', { name: COMPOSER }), { target: { value: 'Hi' } })
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    const account = screen.getByRole('button', { name: 'Account: owner' })
    expect(account.closest('[data-matrix-shell-layer]')?.hasAttribute('inert')).toBe(false)
    fireEvent.pointerDown(account, { button: 0 })
    expect(await screen.findByRole('menu')).toBeTruthy()
    expect(bridge.retryReadiness).not.toHaveBeenCalled()
    expect(bridge.setupAssistant).not.toHaveBeenCalled()
    expect(waiting.readiness?.phase).toBe('starting')
    emit(ready)
    await waitFor(() => expect(screen.queryByText(/Assistant setup is waiting for a limit to reset/)).toBeNull())
  })

  it('shows a valid unseen starter allowance only in the settled default assistant chat', async () => {
    const command = vi.fn(() => new Promise<unknown>(() => {}))

    const starter: MatrixSnapshot = {
      ...ready,
      petScope: 'starter-scope',
      starterMarker: 'unseen',
      starter: { kind: 'founding', amount: 50_000_999_999 },
      agents: [
        {
          principal: 'default',
          userId: '@atum:test',
          isDefault: true,
          ready: true,
          hermes: 'ready',
          readiness: { phase: 'ready', since: 1 },
          atumModel: true
        }
      ]
    }

    const { bridge } = fixture(async () => starter, 'en', undefined, command)

    await waitFor(() => expect(plate()).toBeNull(), LAUNCH_OPENS)
    await waitFor(() =>
      expect(window.document.querySelectorAll('[data-matrix-starter-notice] p')[1]?.textContent).toBe(
        'Enough for about 20 chats.'
      )
    )
    expect(command).toHaveBeenCalledWith({
      kind: 'starterSeen',
      identity: owner,
      scope: 'starter-scope'
    })
    const composer = screen.getByRole('textbox', { name: COMPOSER })
    fireEvent.change(composer, { target: { value: 'First message' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(bridge.sendTurn).toHaveBeenCalledWith('!assistant:test', 'First message'))
    await waitFor(() => expect(window.document.querySelector('[data-matrix-starter-notice]')).toBeNull())
  })

  it('says a start after launch only in the message box, however slow, never as lines in its chat', async () => {
    const { emit } = fixture(async () => ready)
    await waitFor(() => expect(plate()).toBeNull(), LAUNCH_OPENS)
    emit(gate({ phase: 'starting', step: 'hermes', since: Date.now() }))
    const notice = () => window.document.querySelector('[data-matrix-launch-notice]')
    const placeholder = () => screen.getByRole('textbox', { name: COMPOSER }).getAttribute('placeholder')
    await waitFor(() => expect(placeholder()).toBe('Atum is starting… You can type ahead.'))
    expect(notice()).toBeNull()
    expect(plate()).toBeNull()
    // A slow one says nothing more in the chat: no "Preparing its workspace…".
    emit(gate({ phase: 'starting', step: 'hermes', since: Date.now() - 31_000 }))
    await waitFor(() => expect(placeholder()).toBe('Atum is starting… You can type ahead.'))
    expect(notice()).toBeNull()
    expect(screen.queryByText(/Preparing its workspace…|Atum is getting ready…/)).toBeNull()
    expect(window.document.querySelector('[data-matrix-shell-layer]')?.hasAttribute('inert')).toBe(false)
    emit(gate({ phase: 'starting', step: 'ai', since: Date.now() - 31_000 }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true))
    expect(screen.queryByText("Connecting to Atum's AI…")).toBeNull()
    emit(ready)
    await waitFor(() => expect(placeholder()).not.toBe('Atum is starting… You can type ahead.'))
  })

  it('says an AI outage in the assistant’s chat with Try again, and keeps the window open', async () => {
    // An outage that outlasted a launch's settling (a fresh one stays quiet: agent-attention.ts).
    const { bridge } = fixture(async () =>
      gate({ phase: 'blocked', step: 'ai', code: 'ai_unavailable', since: Date.now() - 10_000 })
    )

    await waitForLaunchToOpen()
    expect(await screen.findByText('Atum’s AI isn’t responding')).toBeTruthy()
    expect(screen.queryByText('Check your internet connection.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(bridge.retryReadiness).toHaveBeenCalledOnce()
  })

  it('adds the connection hint after two minutes blocked', async () => {
    fixture(async () =>
      gate({ phase: 'blocked', step: 'signed_in', code: 'chat_unreachable', since: Date.now() - 3 * 60_000 })
    )
    await waitFor(() => expect(plate()?.textContent).toContain('Check your internet connection.'))
  })

  // A cause every assistant shares is said once, as the title bar's indicator item (quiet
  // verification, 2026-10-06 check): the open chat has no card for it, its message box names it.
  it('offers the latest Atum, not a retry that cannot help, when the install itself is damaged', async () => {
    const { bridge } = fixture(async () =>
      gate({ phase: 'blocked', step: 'hermes', code: 'runtime_invalid', since: Date.now() })
    )

    await waitForLaunchToOpen()
    const indicator = await screen.findByRole('button', { name: 'Needs you: Update Atum' })
    expect(window.document.querySelector('[data-matrix-launch-notice]')).toBeNull()
    expect(screen.getByRole('textbox', { name: COMPOSER }).getAttribute('placeholder')).toBe('Update Atum')
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    fireEvent.click(indicator)
    fireEvent.click(await screen.findByRole('button', { name: /^Update Atum/ }))
    await waitFor(() => expect(bridge.openLink).toHaveBeenCalledWith(ATUM_LINKS.download))
    expect(bridge.retryReadiness).not.toHaveBeenCalled()
  })

  it('explains withdrawn execution without reconnect, retry or an irrelevant network hint', async () => {
    const { bridge } = fixture(async () =>
      gate({ phase: 'blocked', step: 'authority', code: 'authority_withdrawn', since: Date.now() - 3 * 60_000 })
    )

    await waitForLaunchToOpen()
    expect(await screen.findByText(/This Mac can no longer run this assistant/)).toBeTruthy()
    expect(screen.getByText(/Your chats and saved setup are kept/)).toBeTruthy()
    expect(screen.queryByText('Check your internet connection.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Connect assistant' })).toBeNull()
    expect(bridge.retryReadiness).not.toHaveBeenCalled()
    expect(bridge.setupAssistant).not.toHaveBeenCalled()
  })

  it('says running out of Protons once, in the indicator, and tops up from there', async () => {
    const { bridge } = fixture(async () =>
      gate({ phase: 'blocked', step: 'ai', code: 'out_of_protons', since: Date.now() })
    )

    await waitForLaunchToOpen()
    const indicator = await screen.findByRole('button', { name: 'Needs you: Out of Protons' })
    expect(window.document.querySelector('[data-matrix-launch-notice]')).toBeNull()
    expect(screen.getByRole('textbox', { name: COMPOSER }).getAttribute('placeholder')).toBe(
      'Top up Protons to continue.'
    )
    expect(screen.queryByRole('button', { name: 'Proton purchase terms' })).toBeNull()
    fireEvent.click(indicator)
    fireEvent.click(await screen.findByRole('button', { name: /^Out of Protons/ }))
    await waitFor(() => expect(bridge.openTopUp).toHaveBeenCalledOnce())
  })

  it('opens Connections from the cloud-only out-of-Protons model action', async () => {
    fixture(async () => ({
      ...gate({ phase: 'blocked', step: 'ai', code: 'out_of_protons', since: Date.now() }),
      roomId: null,
      rooms: []
    }))

    await waitForLaunchToOpen()
    fireEvent.click(await screen.findByRole('button', { name: 'Use your ChatGPT or OpenCode plan' }))
    const settings = window.document.querySelector<HTMLElement>('[data-matrix-settings]')!

    await waitFor(() => expect(settings.hidden).toBe(false))
    expect(settings.querySelector('[data-matrix-settings-pane="connections"]')?.getAttribute('aria-current')).toBe('page')
    expect(settings.querySelector('[data-matrix-settings-section="subscriptions"]')).toBeTruthy()
  })

  it('pauses sending when Protons run out mid-chat, with the top-up and a model of their own', async () => {
    const pages: MatrixPagesBridge = {
      open: vi.fn(async () => ({ viewId: 'runtime-page' })),
      setBounds: vi.fn(async () => ({ ok: true as const })),
      setVisibility: vi.fn(async () => ({ ok: true as const })),
      focus: vi.fn(async () => ({ ok: true as const })),
      close: vi.fn(async () => ({ ok: true as const })),
      onState: vi.fn(() => vi.fn())
    }

    const { bridge } = fixture(
      async () => ({
        ...ready,
        readiness: { phase: 'degraded', step: 'ai', code: 'out_of_protons', since: 1 },
        atumModel: true,
        rooms: [{ ...ready.rooms[0]!, agentPrincipal: 'agent-atum' }],
        agents: [
          {
            principal: 'agent-atum',
            userId: '@atum:test',
            name: 'Atum',
            isDefault: true,
            ready: true,
            hermes: 'ready',
            // As main publishes it: each agent's own readiness (main.ts `readinessOf`).
            readiness: { phase: 'degraded', step: 'ai', code: 'out_of_protons', since: 1 },
            atumModel: true
          }
        ]
      }),
      'en',
      pages
    )

    await waitFor(() => expect(plate()).toBeNull(), LAUNCH_OPENS)
    // Said once, in the indicator; the message box says sending waits on it.
    const indicator = await screen.findByRole('button', { name: 'Needs you: Out of Protons' })
    expect(window.document.querySelector('[data-matrix-launch-notice]')).toBeNull()
    expect(screen.getByRole('textbox', { name: COMPOSER }).getAttribute('placeholder')).toBe(
      'Top up Protons to continue.'
    )
    fireEvent.change(screen.getByRole('textbox', { name: COMPOSER }), { target: { value: 'Hi' } })
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    // No Store checkout in this build: the top-up is Atum's payments page.
    fireEvent.click(indicator)
    fireEvent.click(await screen.findByRole('button', { name: /^Out of Protons/ }))
    await waitFor(() => expect(bridge.openTopUp).toHaveBeenCalledOnce())
    // A model of their own stays one step away, in the message box's model menu.
    fireEvent.click(screen.getByRole('button', { name: 'Model: Nguyệt Thực 1.3' }))
    const modelCard = within(await screen.findByRole('dialog', { name: 'Model' }))
    fireEvent.click(modelCard.getByRole('button', { name: CONNECTIONS }))
    const settings = () => window.document.querySelector<HTMLElement>('[data-matrix-settings]')!
    await waitFor(() => expect(settings().hidden).toBe(false))
    expect(
      settings().querySelector('[data-matrix-settings-pane="connections"]')?.getAttribute('aria-current')
    ).toBe('page')
    expect(settings().querySelector('[data-matrix-settings-section="subscriptions"]')).toBeTruthy()
    expect(pages.open).not.toHaveBeenCalled()
  })

  it('sends an out-of-Protons top-up to the Store’s own checkout when the build has one', async () => {
    const { bridge } = fixture(async () => ({
      ...ready,
      readiness: { phase: 'degraded', step: 'ai', code: 'out_of_protons', since: 1 },
      atumModel: true,
      apps: { state: 'ready', apps: [], connections: {} },
      checkout: {
        state: 'ready',
        packs: [],
        checkoutOpen: true,
        order: null,
        reconciliationPending: false,
        intent: null
      }
    }))

    await waitFor(() => expect(plate()).toBeNull(), LAUNCH_OPENS)
    fireEvent.click(await screen.findByRole('button', { name: 'Needs you: Out of Protons' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Out of Protons/ }))
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith({ kind: 'discoverApps' }))
    expect(bridge.openTopUp).not.toHaveBeenCalled()
  })

  it('opens when the gate is ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { emit } = fixture(async () => gate({ phase: 'starting', step: 'signed_in', since: Date.now() }))
    await waitFor(() => expect(plate()?.textContent).toContain('Signing you in…'))
    emit(ready)
    await passLaunch()
    await waitFor(() => expect(plate()).toBeNull(), LAUNCH_OPENS)
  })

  it('keeps preparation behind loading until ready and never reads 100 before completion', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { emit } = fixture(async () => gate({ phase: 'starting', step: 'signed_in', since: Date.now() }))
    await waitFor(() => expect(plate()?.textContent).toContain('Signing you in…'))
    const bar = within(plate() as HTMLElement).getByRole('progressbar', { name: 'Opening Atum' })
    expect(Number(bar.getAttribute('aria-valuenow'))).toBeLessThan(100)
    // The assistant's own start, once it has run long enough to say so in its chat.
    emit(gate({ phase: 'starting', step: 'hermes', since: Date.now() - 31_000 }))
    // A synced account does not dismiss active preparation.
    expect(window.document.querySelector('[data-phase="lit"]')).toBeNull()
    await passLaunch()
    expect(window.document.querySelector('[data-phase="lit"]')).toBeNull()
    expect(plate()).not.toBeNull()
    expect(
      Number(
        within(plate() as HTMLElement)
          .getByRole('progressbar')
          .getAttribute('aria-valuenow')
      )
    ).toBeLessThan(100)
    emit(ready)
    await passLaunch()
    await waitFor(() => expect(plate()).toBeNull(), LAUNCH_OPENS)
    // Later reconnects stay local to the affected chat, in its message box: no loading screen,
    // and no progress lines in the chat.
    emit(gate({ phase: 'starting', step: 'hermes', since: Date.now() - 31_000 }))
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: COMPOSER }).getAttribute('placeholder')).toBe(
        'Atum is starting… You can type ahead.'
      )
    )
    expect(plate()).toBeNull()
    expect(window.document.querySelector('[data-matrix-launch-notice]')).toBeNull()
    // Typing ahead hides the placeholder: the same words stay, faint, under the box, so Enter
    // doing nothing yet is never unexplained.
    const hint = () => window.document.querySelector('[data-matrix-paused-hint]')
    expect(hint()).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: COMPOSER }), { target: { value: 'Hi' } })
    await waitFor(() => expect(hint()?.textContent).toBe('Atum is starting… You can type ahead.'))
    emit(ready)
    await waitFor(() => expect(hint()).toBeNull())
  })

  it('says so when the chats keep loading, then that it can take a minute', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fixture(async () => gate({ phase: 'starting', step: 'signed_in', since: Date.now() }))
    await waitFor(() => expect(plate()?.textContent).toContain('Signing you in…'))
    expect(plate()?.textContent).not.toContain('Still working on it…')
    await act(async () => vi.advanceTimersByTime(6_000))
    expect(plate()?.textContent).toContain('Still working on it…')
    await act(async () => vi.advanceTimersByTime(30_000))
    expect(plate()?.textContent).toContain('This step can take a minute.')
  })

  it('stops the bar and marks the step that stopped while the chats cannot load', async () => {
    fixture(async () => gate({ phase: 'blocked', step: 'signed_in', code: 'chat_unreachable', since: Date.now() }))
    await waitFor(() => expect(plate()?.textContent).toContain('Can’t reach your chats right now'))
    expect(within(plate() as HTMLElement).queryByRole('progressbar')).toBeNull()

    const steps = [...(plate() as HTMLElement).querySelectorAll('[data-slot="matrix-startup-steps"] li')].map(step =>
      step.getAttribute('data-state')
    )

    expect(steps).toEqual(['failed'])
    // Nothing to open to yet: the way out is feedback and signing out, not "open anyway".
    expect(within(plate() as HTMLElement).queryByRole('button', { name: 'Open Atum anyway' })).toBeNull()
    expect(within(plate() as HTMLElement).getByRole('button', { name: 'Sign out' })).toBeTruthy()
  })

  it('keeps the window behind the launch, and its native pages, out of reach until it opens', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    const pages: MatrixPagesBridge = {
      open: vi.fn(async () => ({ viewId: 'launch-page' })),
      setBounds: vi.fn(async () => ({ ok: true as const })),
      setVisibility: vi.fn(async () => ({ ok: true as const })),
      focus: vi.fn(async () => ({ ok: true as const })),
      close: vi.fn(async () => ({ ok: true as const })),
      onState: vi.fn(() => vi.fn())
    }

    const agents: MatrixAgentView[] = [
      {
        principal: 'agent-1',
        userId: '@atum:test',
        name: 'Atum',
        isDefault: true,
        ready: true,
        hermes: 'ready',
        atumModel: true
      }
    ]

    const layer = () => window.document.querySelector('[data-matrix-shell-layer]')

    const { emit } = fixture(
      async () => ({
        ...gate({ phase: 'starting', step: 'signed_in', since: Date.now() }),
        agents,
        companyWorkspaceEnabled: true
      }),
      'en',
      pages,
      undefined,
      undefined,
      companyWorkspace()
    )

    await waitFor(() => expect(plate()).not.toBeNull())
    expect(layer()?.hasAttribute('inert')).toBe(true)
    // The launch owns focus: Settings and its native pages cannot open behind it.
    fireEvent.keyDown(window, { key: ',', code: 'Comma', metaKey: true })
    const settings = window.document.querySelector<HTMLElement>('[data-matrix-settings]')!
    expect(settings.hidden).toBe(true)
    expect(pages.open).not.toHaveBeenCalled()

    emit({ ...ready, agents, companyWorkspaceEnabled: true })
    await passLaunch()
    await waitFor(() => expect(plate()).toBeNull(), LAUNCH_OPENS)
    expect(layer()?.hasAttribute('inert')).toBe(false)

    await screen.findByRole('button', { name: 'Account: owner' })
    fireEvent.keyDown(window, { key: ',', code: 'Comma', metaKey: true })
    fireEvent.click(settings.querySelector('[data-matrix-settings-pane="advanced"]')!)
    const advanced = within(settings).getByRole('dialog', { name: 'Advanced' })
    fireEvent.click(within(advanced).getByRole('button', { name: /^Scheduled tasks/ }))
    await waitFor(() => expect(pages.open).toHaveBeenCalledWith(expect.objectContaining({ page: 'scheduled' })))
    await waitFor(() =>
      expect(pages.setVisibility).toHaveBeenLastCalledWith({
        viewId: 'launch-page',
        visible: true,
        overlayActive: false
      })
    )
  })

  it('falls back from the finale with the gate, below 100, and opens once it is ready again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { emit } = fixture(async () => gate({ phase: 'starting', step: 'signed_in', since: Date.now() }))
    await waitFor(() => expect(plate()?.textContent).toContain('Signing you in…'))

    const progress = () =>
      Number(
        within(plate() as HTMLElement)
          .getByRole('progressbar')
          .getAttribute('aria-valuenow')
      )

    for (const into of [200, 700]) {
      // Ready: the finale starts. Then the gate falls back, during the flash (200 ms) and
      // during the flight (700 ms): the launch stays, below 100, past where it would have ended.
      emit(ready)
      await act(async () => vi.advanceTimersByTime(into))
      emit(gate({ phase: 'starting', step: 'signed_in', since: Date.now() }))
      await act(async () => vi.advanceTimersByTime(3_000))
      expect(plate()).not.toBeNull()
      expect(progress()).toBeLessThan(100)
    }

    emit(ready)
    await act(async () => vi.advanceTimersByTime(3_000))
    expect(plate()).toBeNull()
  })

  it('opens straight to the chat, with no launch at all, when nothing is left to wait for', async () => {
    const seen: boolean[] = []
    const observer = new MutationObserver(() => seen.push(Boolean(plate())))
    observer.observe(window.document.body, { childList: true, subtree: true })
    await openChat()
    observer.disconnect()
    expect(seen.some(Boolean)).toBe(false)
  })

  it('sends straight to this Mac: no assistant server path, no dialog', async () => {
    const { bridge } = await openChat()
    const composer = await screen.findByRole('textbox', { name: COMPOSER })
    fireEvent.change(composer, { target: { value: 'Plan the next task' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(bridge.sendTurn).toHaveBeenCalledWith('!assistant:test', 'Plan the next task'))
    expect(bridge.sendAssistant).not.toHaveBeenCalled()
    expect(bridge.command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'send' }))
  })

  /** The transcript's messages holding these words (never the message box). */
  const bubbles = (words: string) =>
    [...window.document.querySelectorAll<HTMLElement>('[data-matrix-message-id]')].filter(found =>
      found.textContent?.includes(words)
    )

  it('shows your message the moment you press Send, before this Mac has even kept it, then never twice', async () => {
    const { bridge, emit } = await openChat()
    let accept!: (value: { turnId: string }) => void
    vi.mocked(bridge.sendTurn).mockImplementationOnce(() => new Promise(resolve => (accept = resolve)))
    const composer = await screen.findByRole('textbox', { name: COMPOSER })
    fireEvent.change(composer, { target: { value: 'Hi there' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    // Main has not answered yet: the bubble is already there, with a small sending clock.
    const root = await waitFor(() => {
      const found = bubbles('Hi there')

      expect(found).toHaveLength(1)

      return found[0]!
    })

    expect(root.dataset.matrixMessageId).toMatch(/^echo-/)
    expect(within(root).getByRole('status', { name: 'Sending' })).toBeTruthy()

    const turnId = '00000000-0000-4000-8000-87d96e07d1bf'
    emit({
      ...ready,
      localTurns: [
        {
          turnId,
          roomId: '!assistant:test',
          text: 'Hi there',
          createdAt: Date.now(),
          state: 'waiting',
          synced: { question: false, answer: false }
        }
      ]
    })
    await act(async () => accept({ turnId }))
    await waitFor(() =>
      expect(bubbles('Hi there').map(found => found.dataset.matrixMessageId)).toEqual([`local-q-${turnId}`])
    )
    expect(screen.queryByRole('status', { name: 'Sending' })).toBeNull()
  })

  /** The window's failure band (its one line and its Try again). */
  const band = () => window.document.querySelector<HTMLElement>('[data-matrix-failure]')

  // Preserve user-visible identity, state and recovery behavior across connection changes.
  // finishing another step" while the assistant could not start at all.
  it('keeps the words of a send this Mac could not take in the box, says why in one line, and Try again sends them', async () => {
    const { bridge } = await openChat()
    vi.mocked(bridge.sendTurn).mockRejectedValueOnce(new Error('matrix_not_ready'))
    const composer = (await screen.findByRole('textbox', { name: COMPOSER })) as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: 'Try me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(band()?.dataset.matrixFailure).toBe('not_ready'))
    expect(band()!.textContent).toContain('Atum isn’t ready yet, so nothing was sent. Try again in a moment.')
    expect(band()!.textContent).not.toContain('finishing another step')
    await waitFor(() => expect(composer.value).toBe('Try me'))
    // Never twice: the words are in the box, not also in the chat as a failed message.
    await waitFor(() => expect(bubbles('Try me')).toHaveLength(0))

    fireEvent.click(within(band()!).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(bridge.sendTurn).toHaveBeenCalledTimes(2))
    expect(bridge.sendTurn).toHaveBeenLastCalledWith('!assistant:test', 'Try me')
    await waitFor(() => expect(composer.value).toBe(''))
    expect(band()).toBeNull()
  })

  it('names an assistant whose setup is failing on this Mac, and keeps the words', async () => {
    const { bridge } = await openChat(gate({ phase: 'degraded', step: 'assistant', code: 'setup_failed', since: 1 }))
    const composer = (await screen.findByRole('textbox', { name: COMPOSER })) as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: 'Are you there?' } })
    // Send is off while it is paused; a send that gets through anyway (Enter) is the case here.
    fireEvent.submit(composer.closest('form')!)

    await waitFor(() => expect(band()?.dataset.matrixFailure).toBe('assistant_cant_start'))
    expect(band()!.textContent).toContain('Atum can’t start on this Mac right now, so nothing was sent.')
    expect(composer.value).toBe('Are you there?')
    expect(bridge.sendTurn).not.toHaveBeenCalled()
    expect(within(band()!).getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('says busy only when the assistant really is busy', async () => {
    const { bridge } = await openChat()
    vi.mocked(bridge.sendTurn).mockRejectedValueOnce(new Error('matrix_agent_busy'))
    const composer = (await screen.findByRole('textbox', { name: COMPOSER })) as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: 'One more thing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(band()?.dataset.matrixFailure).toBe('busy'))
    expect(band()!.textContent).toContain('Atum is finishing another step. Try again in a moment.')
    await waitFor(() => expect(composer.value).toBe('One more thing'))
  })

  it('clears the box once a send went out', async () => {
    const { bridge } = await openChat()
    const composer = (await screen.findByRole('textbox', { name: COMPOSER })) as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: 'Gone for good' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(bridge.sendTurn).toHaveBeenCalledWith('!assistant:test', 'Gone for good'))
    await waitFor(() => expect(composer.value).toBe(''))
    expect(band()).toBeNull()
  })

  it('Try again sends what the box holds now, and a second failure gives those words back', async () => {
    const { bridge } = await openChat()
    vi.mocked(bridge.sendTurn).mockRejectedValueOnce(new Error('matrix_not_ready')).mockRejectedValueOnce(new Error('matrix_not_ready'))
    const composer = (await screen.findByRole('textbox', { name: COMPOSER })) as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: 'First words' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(composer.value).toBe('First words'))

    // The person types something else; Try again from the band sends what the box holds now.
    fireEvent.change(composer, { target: { value: 'Other words' } })
    fireEvent.click(within(band()!).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(bridge.sendTurn).toHaveBeenLastCalledWith('!assistant:test', 'Other words'))
    await waitFor(() => expect(composer.value).toBe('Other words'))
  })

  it('sends a long message, and keeps one too long for a single message in the box with the reason (FR20)', async () => {
    const { bridge } = await openChat()
    const composer = await screen.findByRole('textbox', { name: COMPOSER })
    const long = 'Plan the next task in detail. '.repeat(700)
    fireEvent.change(composer, { target: { value: long } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(bridge.sendTurn).toHaveBeenCalledWith('!assistant:test', long))

    vi.mocked(bridge.sendTurn).mockClear()
    const tooLong = '字'.repeat(16_000)
    fireEvent.change(composer, { target: { value: tooLong } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText(/too long to send in one go/)).toBeTruthy()
    expect(bridge.sendTurn).not.toHaveBeenCalled()
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(tooLong))
  })

  it('keeps the listening room on the local path too (the composer branch is gone)', async () => {
    const { bridge } = await openChat({
      ...ready,
      hermesListening: { roomId: '!assistant:test', expiresAt: Date.now() + 60_000, queued: 0, state: 'listening' }
    })

    const composer = await screen.findByRole('textbox', { name: COMPOSER })
    fireEvent.change(composer, { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(bridge.sendTurn).toHaveBeenCalledWith('!assistant:test', 'Hello'))
    expect(bridge.command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'send' }))
  })

  it('keeps a linked document on the server path, where it is confirmed', async () => {
    const { bridge } = await openChat({ ...ready, linkedDocument: { name: 'plan.pdf', state: 'linked' } })
    const composer = await screen.findByRole('textbox', { name: COMPOSER })
    fireEvent.change(composer, { target: { value: 'Summarize it' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(bridge.sendAssistant).toHaveBeenCalledWith('!assistant:test', 'Summarize it', 'en'))
    expect(bridge.sendTurn).not.toHaveBeenCalled()
  })

  describe('the title bar’s placement control', () => {
    const principal = '00000000-0000-4000-8000-bd7662a5eeb4'
    const MAC_A = 'mac:00000000-0000-4000-8000-b454f82c5857' as const
    const MAC_B = 'mac:00000000-0000-4000-8000-f6222a1106ee' as const

    /** The main assistant with a saved policy over `order` (every destination ready). */
    function withPolicy(order: Array<'cloud' | typeof MAC_A | typeof MAC_B>) {
      const base = promotedMainSnapshot()

      const policy = {
        profile: 'atum.execution-policy/1' as const,
        agentPrincipal: principal,
        revision: 2,
        source: 'saved' as const,
        order,
        disabled: []
      }

      const status = {
        profile: 'atum.execution-status/1' as const,
        agentPrincipal: principal,
        policyRevision: 2,
        asOf: 10,
        state: 'idle' as const,
        current: null,
        desired: 'cloud' as const,
        order,
        disabled: [],
        destinations: Object.fromEntries(order.map(id => [id, { state: 'ready' as const, observedAt: 9 }]))
      } as never

      const snapshot: MatrixSnapshot = {
        ...base,
        roomId: '!main:test',
        agents: base.agents?.map(agent =>
          agent.principal === 'main'
            ? { ...agent, principal, executionPolicy: { policy, status, stale: false } }
            : agent
        ),
        rooms: base.rooms.map(room => (room.id === '!main:test' ? { ...room, agentPrincipal: principal } : room))
      }

      const executionPolicy: MatrixExecutionPolicyBridge = {
        read: vi.fn(async () => ({ policy, status, stale: false })),
        save: vi.fn<MatrixExecutionPolicyBridge['save']>(async (_agentPrincipal, update) => ({
          ok: true as const,
          value: { ...policy, revision: 3, order: update.order, disabled: update.disabled }
        }))
      }

      return { executionPolicy, snapshot }
    }

    const migratedHome = (): NonNullable<MatrixAgentView['home']> => ({
      lives: { kind: 'cloud' },
      move: null,
      targets: [{ id: MAC_A.slice(4), name: 'Mac mini' }],
      issue: null,
      placement: {
        profile: 'atum.agent-home/2.5',
        moveAvailable: true,
        current: 'cloud',
        reachability: 'reachable',
        modelStatus: 'applied',
        destinations: [
          { id: 'cloud', kind: 'cloud', name: '', thisMac: false, eligibility: 'ready', catalogRevision: 0, models: [] },
          {
            id: MAC_A.slice(4),
            kind: 'mac',
            name: 'Mac mini',
            thisMac: false,
            eligibility: 'ready',
            catalogRevision: 1,
            models: []
          }
        ]
      }
    })

    it('hides the legacy execution-policy control under cloud-only even with multiple Macs', async () => {
      const { executionPolicy, snapshot } = withPolicy(['cloud', MAC_A, MAC_B])
      const { bridge, emit } = fixture(undefined, 'en', undefined, undefined, undefined, undefined, undefined, {}, true)
      bridge.executionPolicy = executionPolicy
      emit(snapshot)

      await screen.findByRole('textbox', { name: COMPOSER })
      expect(document.querySelector('[data-matrix-chat-subtitle]')).toBeNull()
      expect(document.querySelector('[data-matrix-execution-policy]')).toBeNull()
      expect(screen.queryByRole('button', { name: /About to answer on|Answering on/ })).toBeNull()
      expect(executionPolicy.read).not.toHaveBeenCalled()
    })

    it('hides the settled cloud home icon while keeping both native bridges idle', async () => {
      const { executionPolicy, snapshot } = withPolicy(['cloud', MAC_A, MAC_B])
      const home = migratedHome()

      const migrated: MatrixSnapshot = {
        ...snapshot,
        agents: snapshot.agents?.map(agent => {
          if (agent.principal !== principal) {
            return agent
          }

          const legacy = agent.executionPolicy!

          return {
            ...agent,
            home,
            executionPolicy: {
              ...legacy,
              status: {
                ...legacy.status!,
                destinations: {
                  ...legacy.status!.destinations,
                  [MAC_A]: { state: 'offline', reason: 'not_present', observedAt: 9 }
                }
              }
            }
          }
        })
      }

      const agentHome: MatrixAgentHomeBridge = {
        read: vi.fn(async () => home),
        preflight: vi.fn(),
        move: vi.fn(),
        cancel: vi.fn(),
        model: vi.fn(),
        prepare: vi.fn()
      }

      const { bridge, emit } = fixture(undefined, 'vi', undefined, undefined, undefined, undefined, undefined, {}, true)
      bridge.executionPolicy = executionPolicy
      bridge.agentHome = agentHome
      emit(migrated)

      await waitFor(() => expect(document.querySelector('[data-atum-chat]')).toBeTruthy())
      expect(document.querySelector('[data-matrix-agent-home]')).toBeNull()
      expect(document.querySelector('[data-matrix-execution-policy]')).toBeNull()
      expect(agentHome.read).not.toHaveBeenCalled()
      expect(executionPolicy.read).not.toHaveBeenCalled()
    })

    it.each([
      ['the cloud alone', ['cloud'] as Array<'cloud' | typeof MAC_A>],
      ['the cloud and this one Mac', ['cloud', MAC_A] as Array<'cloud' | typeof MAC_A>]
    ])('draws no placement control in the first chat when the person has %s', async (_name, order) => {
      const { executionPolicy, snapshot } = withPolicy(order)
      const { bridge, emit } = fixture()
      bridge.executionPolicy = executionPolicy
      emit(snapshot)

      // Wait for the chat itself, then see that no priority list or switches are on offer in it.
      await screen.findByRole('textbox', { name: COMPOSER })
      expect(document.querySelector('[data-matrix-execution-policy]')).toBeNull()
      expect(screen.queryByRole('button', { name: /About to answer on|Answering on/ })).toBeNull()
    })
  })

  it('with assistantPath=server keeps today’s listening branch (parity)', async () => {
    const { bridge } = await openChat({
      ...ready,
      assistantPath: 'server',
      hermesListening: { roomId: '!assistant:test', expiresAt: Date.now() + 60_000, queued: 0, state: 'listening' }
    })

    const composer = await screen.findByRole('textbox', { name: COMPOSER })
    fireEvent.change(composer, { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(bridge.command).toHaveBeenCalledWith({ kind: 'send', roomId: '!assistant:test', body: 'Hello' })
    )
    expect(bridge.sendTurn).not.toHaveBeenCalled()
  })

  it('pauses the composer while degraded, with a banner, and keeps the draft', async () => {
    const { bridge } = await openChat({
      ...ready,
      readiness: { phase: 'degraded', step: 'ai', code: 'offline', since: 1 }
    })

    expect(await screen.findByText(/You're offline\. I'll be back when you are\./)).toBeTruthy()
    const composer = await screen.findByRole('textbox', { name: COMPOSER })
    fireEvent.change(composer, { target: { value: 'Draft kept' } })
    expect((composer as HTMLTextAreaElement).value).toBe('Draft kept')
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(bridge.sendTurn).not.toHaveBeenCalled()
    expect((composer as HTMLTextAreaElement).value).toBe('Draft kept')
  })

  it('sends staged Drive files through cloud even while this Mac is paused', async () => {
    const drive = taskDrive()

    const { bridge } = await openChat(
      { ...ready, hermes: 'unavailable', readiness: { phase: 'degraded', step: 'ai', code: 'offline', since: 1 } },
      drive.bridge
    )

    stageTask()
    const composer = await screen.findByRole('textbox', { name: COMPOSER })
    fireEvent.change(composer, { target: { value: 'Use these notes' } })

    await waitFor(() => {
      expect(drive.taskStatus).toHaveBeenCalledWith('!assistant:test')
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(drive.sendTask).toHaveBeenCalledWith({
        roomId: '!assistant:test',
        body: 'Use these notes',
        revision: 9,
        selections: [{ id: 'opaque-notes', mode: 'read' }]
      })
    )
    expect(bridge.sendTurn).not.toHaveBeenCalled()
    expect(bridge.sendAssistant).not.toHaveBeenCalled()
    expect(bridge.command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'send' }))
  })

  it('accepts a staged file with four Drive reads and sends both under the ten-input limit', async () => {
    const drive = taskDrive()
    const { bridge } = await openChat(ready, drive.bridge)
    act(() => {
      setMatrixDriveTaskScope({ ...owner, roomId: '!assistant:test' }, 9)

      for (let index = 1; index <= 4; index++) {
        selectMatrixDriveFile(`opaque-${index}`, `source-${index}.txt`, 'read')
      }
    })
    const notes = new File(['hello'], 'notes.txt')
    Object.defineProperty(notes, 'arrayBuffer', { value: async () => new TextEncoder().encode('hello').buffer })
    fireEvent.change(screen.getByLabelText('Attach file (up to 20 MB)'), { target: { files: [notes] } })
    fireEvent.change(screen.getByRole('textbox', { name: COMPOSER }), { target: { value: 'Compare these sources' } })

    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(bridge.command).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'attach',
          roomId: '!assistant:test',
          name: 'notes.txt'
        })
      )
    )
    await waitFor(() =>
      expect(drive.sendTask).toHaveBeenCalledWith({
        roomId: '!assistant:test',
        body: 'Compare these sources',
        revision: 9,
        selections: Array.from({ length: 4 }, (_, index) => ({ id: `opaque-${index + 1}`, mode: 'read' }))
      })
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the draft and staged files when the pre-ack Drive authority check fails', async () => {
    let available = true
    const drive = taskDrive(vi.fn(async () => ({ state: available ? ('ready' as const) : ('unavailable' as const) })))
    const { bridge } = await openChat(ready, drive.bridge)
    stageTask()
    const composer = await screen.findByRole('textbox', { name: COMPOSER })
    fireEvent.change(composer, { target: { value: 'Keep this draft' } })

    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
    )
    available = false
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(drive.taskStatus).toHaveBeenCalledTimes(2))
    expect(drive.sendTask).not.toHaveBeenCalled()
    expect(bridge.sendTurn).not.toHaveBeenCalled()
    expect((composer as HTMLTextAreaElement).value).toBe('Keep this draft')
    expect($matrixDriveTaskSelection.get().selections).toEqual([
      expect.objectContaining({ id: 'opaque-notes', mode: 'read' })
    ])
  })

  it('keeps the draft after a native Drive preflight returns not_sent', async () => {
    const drive = taskDrive(
      undefined,
      vi.fn(async () => ({ state: 'not_sent' as const }))
    )

    const { bridge } = await openChat(ready, drive.bridge)
    stageTask()
    const composer = await screen.findByRole('textbox', { name: COMPOSER })
    fireEvent.change(composer, { target: { value: 'Native metadata is not ready' } })
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(drive.sendTask).toHaveBeenCalledOnce())
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe('Native metadata is not ready'))
    expect($matrixDriveTaskSelection.get().selections).toHaveLength(1)
    expect(bridge.sendTurn).not.toHaveBeenCalled()
  })

  it('does not restore a Drive task draft after the native IPC reply is lost', async () => {
    const drive = taskDrive(
      undefined,
      vi.fn(async () => {
        throw new Error('lost IPC reply')
      })
    )

    const { bridge } = await openChat(ready, drive.bridge)
    stageTask()
    const composer = await screen.findByRole('textbox', { name: COMPOSER })
    fireEvent.change(composer, { target: { value: 'Do not duplicate delivery' } })
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Not sure the message was sent. Check the chat before sending again.')).toBeTruthy()
    expect((composer as HTMLTextAreaElement).value).toBe('')
    expect($matrixDriveTaskSelection.get().selections).toEqual([])
    expect(drive.sendTask).toHaveBeenCalledOnce()
    expect(bridge.sendTurn).not.toHaveBeenCalled()
  })

  it.each([
    {
      result: { state: 'grant_failed_after_ack', eventId: '$ack' } as MatrixDriveTaskResult,
      notice: 'Message sent; files were unavailable.'
    },
    {
      result: { state: 'send_unknown' } as MatrixDriveTaskResult,
      notice: 'Not sure the message was sent. Check the chat before sending again.'
    }
  ])('finishes an acknowledged Drive send without retrying when $result.state', async ({ result, notice }) => {
    const drive = taskDrive(
      undefined,
      vi.fn(async () => result)
    )

    const { bridge } = await openChat(ready, drive.bridge)
    stageTask()
    const composer = await screen.findByRole('textbox', { name: COMPOSER })
    fireEvent.change(composer, { target: { value: 'One delivery only' } })

    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(drive.sendTask).toHaveBeenCalledOnce())
    expect(await screen.findByText(notice)).toBeTruthy()
    expect($matrixDriveTaskSelection.get().selections).toEqual([])
    expect((composer as HTMLTextAreaElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(drive.sendTask).toHaveBeenCalledOnce()
    expect(bridge.sendTurn).not.toHaveBeenCalled()
    expect(bridge.sendAssistant).not.toHaveBeenCalled()
    expect(bridge.command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'send' }))
  })

  it.each([
    ['owner', { ...ready, identity: { userId: '@other:test', deviceId: owner.deviceId } }],
    ['device', { ...ready, identity: { userId: owner.userId, deviceId: 'OTHER' } }],
    [
      'room',
      {
        ...ready,
        roomId: '!other:test',
        rooms: [...ready.rooms, { ...ready.rooms[0]!, id: '!other:test', name: 'Other assistant room' }]
      }
    ]
  ] satisfies Array<[string, MatrixSnapshot]>)(
    'clears staged Drive handles when the %s scope changes while chat is visible',
    async (_scope, next) => {
      const drive = taskDrive()
      const { emit } = await openChat(ready, drive.bridge)
      stageTask()
      expect($matrixDriveTaskSelection.get().selections).toHaveLength(1)
      emit(next)
      await waitFor(() => expect($matrixDriveTaskSelection.get().selections).toEqual([]))
    }
  )

  it('clears staged Drive handles when its revision changes while chat is visible', async () => {
    const drive = taskDrive()
    await openChat(ready, drive.bridge)
    stageTask()
    drive.emit({ state: 'ready', revision: 10, rows: [], canGoBack: false, truncated: false })
    await waitFor(() => expect($matrixDriveTaskSelection.get().selections).toEqual([]))
  })

  it('clears staged Drive handles when Drive access is withdrawn while chat is visible', async () => {
    const drive = taskDrive()
    await openChat(ready, drive.bridge)
    stageTask()
    drive.emit({ state: 'unavailable', revision: 9, rows: [], canGoBack: false, truncated: false })
    await waitFor(() => expect($matrixDriveTaskSelection.get().selections).toEqual([]))
  })

  it('shows the echo from the snapshot at once and never twice once room events arrive', async () => {
    const { emit } = await openChat()

    const waiting = {
      turnId,
      roomId: '!assistant:test',
      text: 'Echo me',
      createdAt: 5,
      state: 'waiting' as const,
      synced: { question: false, answer: false }
    }

    emit({ ...ready, localTurns: [waiting] })
    expect(await screen.findByText('Echo me')).toBeTruthy()
    // No status words under it: the assistant shows typing, as in any messaging app.
    expect(screen.queryByText('Waiting to start…')).toBeNull()
    expect(screen.getByRole('status', { name: 'Atum is typing…' })).toBeTruthy()

    emit({
      ...ready,
      localTurns: [{ ...waiting, state: 'answered', answer: 'Echoed', synced: { question: true, answer: false } }],
      messages: [
        {
          id: '$q',
          sender: '@owner:test',
          body: 'Echo me',
          timestamp: 6,
          own: true,
          encrypted: true,
          decryptionFailed: false,
          pending: false,
          failed: false,
          attachment: false,
          turn: turnId
        }
      ]
    })
    await waitFor(() => expect(screen.getAllByText('Echo me')).toHaveLength(1))
    expect(await screen.findByText('Echoed')).toBeTruthy()
    expect(screen.queryByRole('status', { name: 'Atum is typing…' })).toBeNull()
  })

  it('offers Try again on an interrupted turn', async () => {
    const { bridge } = await openChat({
      ...ready,
      localTurns: [
        {
          turnId,
          roomId: '!assistant:test',
          text: 'Do it',
          createdAt: 5,
          state: 'interrupted',
          synced: { question: true, answer: false }
        }
      ]
    })

    expect(await screen.findByText('Something went wrong while I was working on this. Try again?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(bridge.retryTurn).toHaveBeenCalledWith(turnId)
  })
})

describe("the person's other agents (per-agent runtime plan §2.8)", () => {
  const plate = () => window.document.querySelector('[data-slot="matrix-startup"]')
  const readiness = { phase: 'ready' as const, since: 1 }

  const agentView = (principal: string, userId: string, extra: Partial<MatrixAgentView> = {}): MatrixAgentView => ({
    principal,
    userId,
    isDefault: principal === 'default',
    ready: true,
    hermes: 'ready',
    readiness,
    atumModel: true,
    ...extra
  })

  const alfredRoom = {
    id: '!alfred:test',
    name: 'Alfred',
    membership: 'join',
    encrypted: true,
    direct: true,
    assistant: true,
    roomType: MATRIX_ASSISTANT_ROOM_TYPE,
    agentPrincipal: 'alfred',
    participants: [
      { userId: '@owner:test', membership: 'join' },
      { userId: '@alfred:test', membership: 'join' }
    ]
  }

  const ready: MatrixSnapshot = {
    ...signedOut,
    state: 'ready',
    identity: { userId: '@owner:test', deviceId: 'DEVICE' },
    assistant: { userId: '@atum:test', deviceId: 'ATUM' },
    domainEnabled: true,
    hermes: 'ready',
    assistantPath: 'local',
    readiness,
    roomId: '!assistant:test',
    rooms: [
      {
        ...assistantFields,
        id: '!assistant:test',
        name: 'Atum',
        membership: 'join',
        encrypted: true,
        direct: true,
        assistant: true,
        agentPrincipal: 'default'
      },
      alfredRoom
    ],
    agents: [
      agentView('default', '@atum:test'),
      agentView('alfred', '@alfred:test', { name: 'Alfred', deviceId: 'ALFRED' })
    ],
    agentTurns: [],
    agentCreation: true
  }

  const planSignIn = {
    phase: 'blocked' as const,
    step: 'assistant' as const,
    code: 'plan_sign_in',
    since: 1
  }

  const chatGptPlansBlocked = (): MatrixSnapshot => ({
    ...ready,
    readiness: planSignIn,
    ownModel: true,
    atumModel: false,
    connectedModel: { provider: 'openai-codex', model: 'gpt-5.6-luna' },
    agents: ready.agents!.map(agent => ({
      ...agent,
      ready: false,
      hermes: 'unavailable' as const,
      readiness: planSignIn,
      atumModel: false,
      connectedModel: { provider: 'openai-codex', model: 'gpt-5.6-luna' }
    }))
  })

  const agentRow = () => within(window.document.querySelector<HTMLElement>('[data-matrix-agent="alfred"]')!)
  // The chat's notice, not the roster row that also names the trouble in its description.
  const notRoster = { ignore: 'script, style, [data-atum-roster] *' }

  async function open(snapshot: MatrixSnapshot) {
    const harness = fixture(async () => snapshot)

    await waitFor(() => expect(plate()).toBeNull(), LAUNCH_OPENS)

    return harness
  }

  const coldWithdrawn = (phase: 'blocked' | 'degraded' = 'blocked'): MatrixSnapshot => {
    const withdrawn: NonNullable<MatrixSnapshot['readiness']> = {
      phase,
      step: 'authority',
      code: 'authority_withdrawn',
      since: 1
    }

    return {
      ...ready,
      // Main retains display-only roster metadata, not a withdrawn SDK identity.
      assistant: undefined,
      hermes: 'unavailable',
      readiness: withdrawn,
      agents: [
        agentView('default', '@atum:test', { ready: false, hermes: 'unavailable', readiness: withdrawn }),
        agentView('alfred', '@alfred:test', { name: 'Alfred', deviceId: 'ALFRED' })
      ]
    }
  }

  it('keeps the Main star out of the roster and header (Atum Kit) and moves it with the role in the palette', async () => {
    const { emit } = await open(ready)

    const row = (principal: string) => window.document.querySelector<HTMLElement>(`[data-matrix-agent="${principal}"]`)!

    const header = () => window.document.querySelector<HTMLElement>('[data-matrix-header-card]')!

    const paletteStar = async (name: RegExp) => {
      fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true })
      const palette = await screen.findByRole('dialog', { name: 'Command palette' })
      const star = within(within(palette).getByRole('option', { name })).queryByRole('img', { name: 'Main agent' })
      fireEvent.keyDown(palette, { key: 'Escape', code: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull())

      return star
    }

    expect(within(row('default')).queryByRole('img', { name: 'Main agent' })).toBeNull()
    expect(within(header()).queryByRole('img', { name: 'Main agent' })).toBeNull()
    expect(await paletteStar(/Atum/)).toBeTruthy()
    expect(await paletteStar(/Alfred/)).toBeNull()

    emit({
      ...ready,
      agents: ready.agents!.map(agent => ({ ...agent, isDefault: agent.principal === 'alfred' }))
    })
    await waitFor(async () => expect(await paletteStar(/Alfred/)).toBeTruthy())
    expect(within(row('alfred')).queryByRole('img', { name: 'Main agent' })).toBeNull()
  })

  it.each(['blocked', 'degraded'] as const)(
    'opens the cold shell automatically for a %s withdrawn default without restoring its execution',
    async phase => {
      const { bridge } = await open(coldWithdrawn(phase))
      expect(window.document.querySelector('[data-matrix-shell-layer]')?.hasAttribute('inert')).toBe(false)
      expect(await screen.findByText(/This Mac can no longer run this assistant/, notRoster)).toBeTruthy()
      expect(screen.getByText(/Your chats and saved setup are kept/)).toBeTruthy()
      fireEvent.change(screen.getByRole('textbox', { name: COMPOSER }), { target: { value: 'Hi' } })
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Connect assistant' })).toBeNull()
      expect(bridge.setupAssistant).not.toHaveBeenCalled()
      expect(bridge.enrollHermes).not.toHaveBeenCalled()
      expect(bridge.revokeHermes).not.toHaveBeenCalled()
      expect(bridge.retryReadiness).not.toHaveBeenCalled()
      expect(bridge.sendTurn).not.toHaveBeenCalled()
    }
  )

  it('keeps human sends and a healthy named agent usable after a cold withdrawn-default launch', async () => {
    const human = { id: '!human:test', name: 'Morgan', membership: 'join', encrypted: true, direct: true }
    const cold = { ...coldWithdrawn(), rooms: [...ready.rooms, human], roomId: human.id }
    const { bridge, emit } = await open(cold)
    const composer = await screen.findByRole('textbox', { name: COMPOSER })
    fireEvent.change(composer, { target: { value: 'Hi Morgan' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(bridge.command).toHaveBeenCalledWith({ kind: 'send', roomId: human.id, body: 'Hi Morgan' })
    )
    expect(bridge.sendTurn).not.toHaveBeenCalled()
    expect(bridge.sendAssistant).not.toHaveBeenCalled()

    fireEvent.click(await agentRow().findByRole('button', { name: 'Alfred' }))
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith({ kind: 'select', roomId: '!alfred:test' }))
    emit({ ...cold, roomId: '!alfred:test' })
    expect(screen.queryByText(/This Mac can no longer run this assistant/, notRoster)).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: COMPOSER }), { target: { value: 'Brief me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(bridge.sendTurn).toHaveBeenCalledWith('!alfred:test', 'Brief me'))
    expect(bridge.setupAssistant).not.toHaveBeenCalled()
    expect(bridge.enrollHermes).not.toHaveBeenCalled()
    expect(bridge.retryReadiness).not.toHaveBeenCalled()
  })

  it('does not let a withdrawn account finishing startup skip the next account’s normal gate', async () => {
    const { emit } = await open(coldWithdrawn())
    emit(signedOut)
    await screen.findByRole('button', { name: 'Continue with Google' })

    const next: MatrixSnapshot = {
      ...ready,
      identity: { userId: '@next:test', deviceId: 'NEXT' },
      readiness: { phase: 'blocked', step: 'signed_in', code: 'chat_unreachable', since: 1 }
    }

    emit(next)
    await waitFor(() => expect(plate()).not.toBeNull())
    expect(window.document.querySelector('[data-matrix-shell-layer]')?.hasAttribute('inert')).toBe(true)
    expect(within(plate() as HTMLElement).getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('lists each other agent under Atum, and its row opens its own room', async () => {
    const { bridge } = await open(ready)
    fireEvent.click(await agentRow().findByRole('button', { name: 'Alfred' }))
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith({ kind: 'select', roomId: '!alfred:test' }))
  })

  it("answers in another agent's room with that agent's own state: one broken agent never blocks another", async () => {
    // The default agent is degraded; Alfred is ready, so Alfred's room sends.
    const alfredSelected = {
      ...ready,
      roomId: '!alfred:test',
      readiness: { phase: 'degraded' as const, step: 'ai' as const, code: 'offline', since: 1 }
    }

    const { bridge, emit } = await open(alfredSelected)
    const composer = await screen.findByRole('textbox', { name: COMPOSER })
    fireEvent.change(composer, { target: { value: 'Brief me' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(bridge.sendTurn).toHaveBeenCalledWith('!alfred:test', 'Brief me'))

    // Alfred degraded while the default is ready: Alfred's room pauses, and its row says so.
    emit({
      ...ready,
      roomId: '!alfred:test',
      agents: [
        agentView('default', '@atum:test'),
        agentView('alfred', '@alfred:test', { name: 'Alfred', readiness: { phase: 'degraded', since: 1 } })
      ]
    })
    fireEvent.change(await screen.findByRole('textbox', { name: COMPOSER }), { target: { value: 'Hi' } })
    await waitFor(() => expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true))
    expect(agentRow().getByRole('button', { name: /^Alfred/ }).textContent).toContain('Unavailable')
  })

  it('keeps chats, Drive and Settings usable when every optional ChatGPT plan needs reconnecting', async () => {
    const human = { id: '!human:test', name: 'Morgan', membership: 'join' as const, encrypted: true, direct: true }
    const blocked = { ...chatGptPlansBlocked(), roomId: human.id, rooms: [...ready.rooms, human] }
    const { bridge } = await open(blocked)

    expect(window.document.querySelector('[data-matrix-shell-layer]')?.hasAttribute('inert')).toBe(false)
    const composer = await screen.findByRole('textbox', { name: COMPOSER })
    fireEvent.change(composer, { target: { value: 'Hi Morgan' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(bridge.command).toHaveBeenCalledWith({ kind: 'send', roomId: human.id, body: 'Hi Morgan' })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Atum Drive' }))
    expect(await screen.findByText('Atum Drive is coming soon')).toBeTruthy()
    fireEvent.keyDown(window, { key: ',', code: 'Comma', metaKey: true })
    expect(window.document.querySelector<HTMLElement>('[data-matrix-settings]')?.hidden).toBe(false)
    expect(bridge.sendTurn).not.toHaveBeenCalled()
  })

  it('routes the ChatGPT recovery CTA through account Connections without assistant pages', async () => {
    let connected!: (value: { status: 'connected' }) => void

    const startChatGpt = vi.fn(
      () =>
        new Promise<{ status: 'connected' }>(resolve => {
          connected = resolve
        })
    )

    const harness = fixture(async () => chatGptPlansBlocked())
    harness.bridge.subscriptions = {
      status: vi.fn(async () => ({ scope: 'account' as const, providers: [] })),
      catalog: vi.fn(async () => ({ destination: 'this_mac' as const, providers: [] })),
      startChatGpt,
      pollChatGpt: vi.fn(async () => ({ status: 'pending' as const })),
      cancelChatGpt: vi.fn(async () => undefined),
      disconnectChatGpt: vi.fn(async () => undefined),
      connectOpenCode: vi.fn(async () => ({ status: 'applied' as const })),
      disconnectOpenCode: vi.fn(async () => undefined)
    }

    await waitFor(() => expect(plate()).toBeNull(), LAUNCH_OPENS)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect ChatGPT' }))
    const settings = window.document.querySelector<HTMLElement>('[data-matrix-settings]')!

    await waitFor(() => expect(settings.hidden).toBe(false))
    expect(within(settings).getByRole('heading', { name: 'Connections' })).toBeTruthy()
    expect(settings.querySelector('[data-matrix-settings-section="subscriptions"]')).toBeTruthy()
    expect(startChatGpt).not.toHaveBeenCalled()
    expect(harness.bridge.pages).toBeUndefined()

    fireEvent.click(within(settings).getByRole('button', { name: 'Connect' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Your subscription' })).getByRole('button', { name: /ChatGPT/u }))
    await waitFor(() => expect(startChatGpt).toHaveBeenCalledOnce())
    expect(harness.bridge.retryReadiness).not.toHaveBeenCalled()

    await act(async () => connected({ status: 'connected' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'ChatGPT' })).toBeNull())
    expect(harness.bridge.retryReadiness).not.toHaveBeenCalled()
  })

  it('offers a blocked default assistant an explicit Atum switch and never chooses it silently', async () => {
    const useAtumModel = vi.fn(async () => ({ state: 'ready' as const }))

    const harness = fixture(
      async () => chatGptPlansBlocked(),
      'en',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { useAtumModel }
    )

    await waitFor(() => expect(plate()).toBeNull(), LAUNCH_OPENS)
    expect(useAtumModel).not.toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: 'Connect ChatGPT' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Switch back to Atum’s AI' }))
    await waitFor(() => expect(useAtumModel).toHaveBeenCalledOnce())
  })

  it('offers New assistant only where the platform can make assistants', async () => {
    await open({ ...ready, agentCreation: false })
    await agentRow().findByRole('button', { name: 'Alfred' })
    expect(screen.queryByRole('button', { name: 'New assistant' })).toBeNull()
  })

  it('shows an agent content failure without disabling its healthy composer or changing row navigation', async () => {
    const { bridge } = await open({
      ...ready,
      roomId: '!alfred:test',
      agents: [ready.agents![0]!, { ...ready.agents![1]!, content: { state: 'error', error: 'denied' } }]
    })

    fireEvent.click(await agentRow().findByRole('button', { name: 'Alfred' }))
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith({ kind: 'select', roomId: '!alfred:test' }))
    fireEvent.contextMenu(agentRow().getByRole('button', { name: 'Alfred' }))
    // What it has on this Mac lives in its edit sheet now (Advanced), not this menu.
    expect(screen.queryByRole('menuitem', { name: /Content on this Mac/ })).toBeNull()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    fireEvent.change(screen.getByRole('textbox', { name: COMPOSER }), { target: { value: 'Still ready' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(bridge.sendTurn).toHaveBeenCalledWith('!alfred:test', 'Still ready'))
    expect(agentRow().getByRole('button', { name: 'Alfred' })).toBeTruthy()
  })

  it.each(['blocked', 'degraded'] as const)(
    'keeps other agents usable while a %s withdrawn selected agent explains its stopped permission',
    async phase => {
      const { bridge, emit } = await open(ready)
      emit({
        ...ready,
        roomId: '!alfred:test',
        agents: [
          agentView('default', '@atum:test'),
          agentView('alfred', '@alfred:test', {
            name: 'Alfred',
            ready: false,
            readiness: { phase, step: 'authority', code: 'authority_withdrawn', since: 1 }
          })
        ]
      })
      await screen.findByText(/This Mac can no longer run this assistant/, notRoster)
      expect(screen.getByText(/Your chats and saved setup are kept/)).toBeTruthy()
      expect(screen.queryByText(/Sending is paused until it's back/)).toBeNull()
      fireEvent.change(screen.getByRole('textbox', { name: COMPOSER }), { target: { value: 'Hi' } })
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
      expect(bridge.retryReadiness).not.toHaveBeenCalled()
      expect(bridge.sendTurn).not.toHaveBeenCalled()
      emit(ready)
      expect(await screen.findByRole('textbox', { name: COMPOSER })).toBeTruthy()
      fireEvent.change(screen.getByRole('textbox', { name: COMPOSER }), {
        target: { value: 'Default still works' }
      })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await waitFor(() => expect(bridge.sendTurn).toHaveBeenCalledWith('!assistant:test', 'Default still works'))
    }
  )

  it('creates an assistant from the "+" in one sheet, then opens its conversation and nothing else', async () => {
    const { bridge, emit } = await open(ready)
    const bea = agentView('bea', '@bea:test', { name: 'Bea', deviceId: 'BEA' })

    vi.mocked(bridge.createAgent).mockImplementationOnce(async () => {
      // Main lists the new assistant before it answers in its room.
      emit({ ...ready, agents: [...ready.agents!, bea] })

      return { principal: 'bea', roomId: '!bea:test' }
    })

    fireEvent.click(await screen.findByRole('button', { name: 'New…' }))
    const start = screen.getByRole('dialog', { name: 'Start a chat' })
    fireEvent.click(within(start).getByRole('button', { name: 'New assistant' }))
    const sheet = await screen.findByRole('dialog', { name: 'New assistant' })
    // The start sheet handed over: one dialog at a time.
    expect(screen.getAllByRole('dialog')).toEqual([sheet])
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Display name' }), { target: { value: 'Bea' } })
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'What they do' }), {
      target: { value: 'Keeps my calendar.' }
    })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create assistant' }))
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith({ kind: 'select', roomId: '!bea:test' }))
    expect(bridge.createAgent).toHaveBeenCalledExactlyOnceWith('Bea', '# Bea\n\n## What you do\n\nKeeps my calendar.')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // Its card does not follow: everything it asks was asked in the sheet.
    expect(window.document.querySelector('[data-assistant-card]')).toBeNull()
  })

  it('creates an assistant from a name, who it is and what it does', async () => {
    const { bridge } = await open(ready)
    await openNewAssistant()
    fireEvent.change(await screen.findByRole('textbox', { name: 'Display name' }), { target: { value: '  Bea ' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Who they are' }), { target: { value: 'Warm and brief.' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'What they do' }), { target: { value: 'Keeps my calendar.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create assistant' }))
    await waitFor(() =>
      expect(bridge.createAgent).toHaveBeenCalledWith(
        'Bea',
        '# Bea\n\n## Who you are\n\nWarm and brief.\n\n## What you do\n\nKeeps my calendar.'
      )
    )
    // Its room opens once it answers there.
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith({ kind: 'select', roomId: '!agent:test' }))
  })

  it('keeps the dialog open with the reason when the platform refuses the name', async () => {
    const { bridge } = await open(ready)
    vi.mocked(bridge.createAgent).mockResolvedValueOnce({ refused: 'name' })
    await openNewAssistant()
    // A name the app's own rules allow, so the refusal is the platform's.
    fireEvent.change(await screen.findByRole('textbox', { name: 'Display name' }), { target: { value: 'Linh' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create assistant' }))
    expect(await screen.findByText("That name can't be used. Try another one.")).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Display name' })).toBeTruthy()
  })

  it('imports through the native picker without sending a path or persona from the renderer', async () => {
    const { bridge } = await open(ready)
    await openNewAssistant()
    fireEvent.change(await screen.findByRole('textbox', { name: 'Display name' }), { target: { value: ' Bach ' } })
    // Importing is an advanced path, folded away until asked for.
    expect(screen.queryByRole('button', { name: 'Import a prepared profile…' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    fireEvent.click(screen.getByRole('button', { name: 'Import a prepared profile…' }))
    await waitFor(() => expect(bridge.importAgent).toHaveBeenCalledWith('Bach'))
    expect(bridge.createAgent).not.toHaveBeenCalled()
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith({ kind: 'select', roomId: '!imported:test' }))
  })

  it('keeps an import form available after the native picker is cancelled', async () => {
    const { bridge } = await open(ready)
    vi.mocked(bridge.importAgent).mockResolvedValueOnce({ cancelled: true })
    await openNewAssistant()
    fireEvent.change(await screen.findByRole('textbox', { name: 'Display name' }), { target: { value: 'Bach' } })
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    fireEvent.click(screen.getByRole('button', { name: 'Import a prepared profile…' }))
    await waitFor(() => expect(bridge.importAgent).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Import a prepared profile…' }) as HTMLButtonElement).disabled).toBe(
        false
      )
    )
    expect(screen.getByRole('textbox', { name: 'Display name' })).toBeTruthy()
    expect(bridge.createAgent).not.toHaveBeenCalled()
  })

  it('deletes an agent only after a confirmation that says it is permanent', async () => {
    const { bridge } = await open(ready)
    fireEvent.contextMenu(await screen.findByRole('button', { name: 'Alfred' }))
    expect(bridge.retireAgent).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete Alfred' }))
    expect(await screen.findByRole('dialog', { name: 'Delete Alfred permanently?' })).toBeTruthy()
    expect(screen.getByText(/Alfred stops answering for good/)).toBeTruthy()
    expect(bridge.retireAgent).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(bridge.retireAgent).toHaveBeenCalledWith('alfred'))
  })

  it('opens the chosen named agent’s one conversation from New message, never a newer earlier chat', async () => {
    const owner = '@owner:test'

    const main = {
      ...alfredRoom,
      lastActiveAt: 1,
      conversation: { role: 'main' as const, main: alfredRoom.id, at: 2 },
      conversationOwnerId: owner
    }

    const earlier = {
      ...alfredRoom,
      id: '!alfred-earlier:test',
      lastActiveAt: 9,
      conversation: { role: 'earlier' as const, main: alfredRoom.id, at: 2 },
      conversationOwnerId: owner
    }

    const { bridge } = await open({ ...ready, rooms: [ready.rooms[0]!, main, earlier] })
    fireEvent.keyDown(window, { key: 'n', code: 'KeyN', metaKey: true })
    const start = await screen.findByRole('dialog', { name: 'Start a chat' })
    expect(bridge.command).not.toHaveBeenCalled()
    fireEvent.click(
      within(within(start).getByRole('group', { name: 'Assistants' })).getByRole('button', { name: /^Alfred/ })
    )
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith({ kind: 'select', roomId: '!alfred:test' }))
    expect(bridge.command).not.toHaveBeenCalledWith({ kind: 'select', roomId: '!alfred-earlier:test' })
    expect(bridge.command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'create' }))
    expect(bridge.createAgent).not.toHaveBeenCalled()
    expect(bridge.retireAgent).not.toHaveBeenCalled()
  })

  it('finds a named agent once in the palette and opens its main conversation, never an earlier chat', async () => {
    const owner = '@owner:test'

    const main = {
      ...alfredRoom,
      lastActiveAt: 1,
      conversation: { role: 'main' as const, main: alfredRoom.id, at: 2 },
      conversationOwnerId: owner
    }

    // Newer and waiting unread, yet earlier: it is not the conversation.
    const earlier = {
      ...alfredRoom,
      id: '!alfred-earlier:test',
      firstLine: 'Old plan',
      lastActiveAt: 9,
      unreadNotifications: 3,
      conversation: { role: 'earlier' as const, main: alfredRoom.id, at: 2 },
      conversationOwnerId: owner
    }

    const { bridge } = await open({ ...ready, rooms: [ready.rooms[0]!, main, earlier] })
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true })
    const palette = await screen.findByRole('dialog', { name: 'Command palette' })
    expect(within(palette).getAllByRole('option', { name: /Alfred/ })).toHaveLength(1)
    expect(within(palette).queryByRole('option', { name: /Old plan/ })).toBeNull()
    fireEvent.click(within(palette).getByRole('option', { name: /Alfred/ }))
    await waitFor(() => expect(bridge.command).toHaveBeenCalledWith({ kind: 'select', roomId: '!alfred:test' }))
    expect(bridge.command).not.toHaveBeenCalledWith({ kind: 'select', roomId: '!alfred-earlier:test' })
  })

  it("shows another agent's question with its room, and stops that agent's turn", async () => {
    const prompt: MatrixHermesPrompt = {
      id: 'prompt-1',
      kind: 'clarify',
      question: 'Which calendar?',
      choices: [],
      deadlineAt: Date.now() + 60_000
    }

    const { bridge } = await open({ ...ready, agentTurns: [{ roomId: '!alfred:test', prompts: [prompt] }] })

    const banner = await screen.findByRole('region', { name: matrixActionCopy.en.hermesNeedsInput })
    expect(banner.textContent).toContain('Alfred')
    fireEvent.click(within(banner).getByRole('button', { name: matrixActionCopy.en.cancelHermes }))
    await waitFor(() => expect(bridge.cancelHermes).toHaveBeenCalledWith('!alfred:test'))
  })
})

describe("Home's chat (launch night, second wave)", () => {
  const owner = { userId: '@owner:test', deviceId: 'DEVICE' }
  const plate = () => window.document.querySelector('[data-slot="matrix-startup"]')

  const message = (id: string, extra: Partial<MatrixSnapshot['messages'][number]> = {}) => ({
    id,
    sender: owner.userId,
    body: `Message ${id}`,
    timestamp: 1,
    own: true,
    encrypted: true,
    decryptionFailed: false,
    pending: false,
    failed: false,
    attachment: false,
    ...extra
  })

  const assistantRoom = {
    ...assistantFields,
    id: '!assistant:test',
    name: 'Atum',
    membership: 'join',
    encrypted: true,
    direct: true,
    assistant: true
  }

  const group = {
    id: '!group:test',
    name: 'Design team',
    membership: 'join',
    encrypted: true,
    canInvite: true,
    participants: [
      { userId: owner.userId, membership: 'join' },
      { userId: '@linh:test', membership: 'join' },
      { userId: '@quan:test', membership: 'join' }
    ]
  }

  const ready: MatrixSnapshot = {
    ...signedOut,
    state: 'ready',
    identity: owner,
    assistant: { userId: '@atum:test', deviceId: 'ATUM' },
    domainEnabled: true,
    hermes: 'ready',
    assistantPath: 'local',
    readiness: { phase: 'ready', since: 1 },
    agentRoster: { state: 'ready', since: 1 },
    roomId: assistantRoom.id,
    rooms: [assistantRoom, group],
    messages: [
      message('$q', { body: 'Plan a trip to Đà Lạt' }),
      message('$a', { own: false, sender: '@atum:test', body: 'Here is a **plan**.', replyTo: '$q' })
    ]
  }

  async function openChat(snapshot: MatrixSnapshot = ready, command?: MatrixUiBridge['command']) {
    const harness = fixture(async () => snapshot, 'en', undefined, command)
    await waitFor(() => expect(plate()).toBeNull(), LAUNCH_OPENS)
    await waitFor(
      () => expect(window.document.querySelector('[data-matrix-shell-layer]')?.hasAttribute('inert')).toBe(false),
      LAUNCH_OPENS
    )
    await screen.findByRole('textbox', { name: COMPOSER })

    return harness
  }

  it('keeps Send muted until there is something to send', async () => {
    await openChat()
    const send = () => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
    expect(send().disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: COMPOSER }), { target: { value: '   ' } })
    expect(send().disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: COMPOSER }), { target: { value: 'Hi' } })
    expect(send().disabled).toBe(false)
  })

  const answerToolbar = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-matrix-message-id="$a"] [data-matrix-message-toolbar]')!

  const openAnswerMenu = (container: HTMLElement) =>
    fireEvent.keyDown(answerToolbar(container).querySelector('[data-matrix-answer-menu]')!, { key: 'Enter' })

  it("shows R9's small answer-action row and retains the message toolbar for reply and overflow", async () => {
    const { bridge, view } = await openChat()
    const toolbar = answerToolbar(view.container)
    const actions = view.container.querySelector<HTMLElement>('[data-matrix-answer-actions]')!

    expect(toolbar.dataset.matrixMessageToolbar).toBe('corner')
    expect(toolbar.classList.contains('opacity-0')).toBe(true)
    expect(toolbar.classList.contains('group-hover/message:opacity-100')).toBe(true)
    expect(toolbar.classList.contains('focus-within:opacity-100')).toBe(true)
    expect(toolbar.classList.contains('absolute')).toBe(true)
    expect(actions.dataset.latest).toBe('true')
    expect(actions.classList.contains('opacity-0')).toBe(false)
    expect(within(actions).getByRole('button', { name: 'Copy' })).toBeTruthy()
    expect(within(actions).getByRole('button', { name: 'Good answer' })).toBeTruthy()
    expect(within(actions).getByRole('button', { name: 'Bad answer' })).toBeTruthy()
    expect(within(actions).getByRole('button', { name: 'Retry' })).toBeTruthy()
    fireEvent.click(within(actions).getByRole('button', { name: 'Good answer' }))
    await waitFor(() =>
      expect(bridge.command).toHaveBeenCalledWith({
        kind: 'react', roomId: assistantRoom.id, eventId: '$a', key: '👍', reacted: true
      })
    )
    expect(within(toolbar).getByRole('button', { name: 'Reply' }).tabIndex).toBe(0)
    expect(within(toolbar).queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(within(toolbar).queryByRole('button', { name: 'Copy' })).toBeNull()
  })

  it("asks an answer's question again and copies it from the R9 row", async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { bridge, view } = await openChat()

    const actions = view.container.querySelector<HTMLElement>('[data-matrix-answer-actions]')!
    fireEvent.click(within(actions).getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(bridge.sendTurn).toHaveBeenCalledExactlyOnceWith('!assistant:test', 'Plan a trip to Đà Lạt')
    )
    fireEvent.click(within(actions).getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Here is a **plan**.'))
    expect(bridge.command).not.toHaveBeenCalled()
  })

  it("copies through the Matrix window's clipboard bridge, never the refused web clipboard", async () => {
    // The Matrix window has no hermesDesktop and its session denies the web clipboard, so the
    // renderer must hand the text to main through window.atumMatrix.clipboard.
    const refused = vi.fn(async () => {
      throw new DOMException('Write permission denied.', 'NotAllowedError')
    })

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: refused } })
    const { bridge, view } = await openChat()

    const writeText = vi.fn(async (_text: string) => {})

    ;(bridge as { clipboard?: unknown }).clipboard = { writeText }

    openAnswerMenu(view.container)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith('Here is a **plan**.'))
    expect(refused).not.toHaveBeenCalled()
  })

  it('opens the same menu when the message is right-clicked, and leaves a text selection alone', async () => {
    const { view } = await openChat()
    const answer = view.container.querySelector<HTMLElement>('[data-matrix-message-id="$a"]')!
    const own = view.container.querySelector<HTMLElement>('[data-matrix-message-id="$q"]')!

    expect(fireEvent.contextMenu(answer.querySelector('.matrix-chat-bubble')!)).toBe(false)
    expect(await screen.findByRole('menuitem', { name: 'Copy' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Retry' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    // Yours opens your own "…" (Edit and Delete).
    expect(fireEvent.contextMenu(own.querySelector('.composer-human-message')!)).toBe(false)
    expect(await screen.findByRole('menuitem', { name: 'Edit' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    // Words the person has selected keep the browser's own menu (copy that selection).
    const bubble = answer.querySelector('.matrix-chat-bubble')!
    window.getSelection()!.selectAllChildren(bubble)
    expect(fireEvent.contextMenu(bubble)).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
    window.getSelection()!.removeAllRanges()
  })

  it('shows a working line only while its turn works: an ended one, a settled one and a removed one leave nothing', async () => {
    const line = (id: string, body: string, extra: Partial<MatrixSnapshot['messages'][number]> = {}) =>
      message(id, {
        own: false,
        sender: '@atum:test',
        body,
        notice: true,
        replyTo: '$q',
        progress: {
          profile: 'atum.agent-turns/1.3',
          scope: 'owner_private',
          phase: 'working',
          kind: 'todo',
          revision: 0
        },
        ...extra
      })

    const working = {
      ...ready,
      messages: [
        message('$q', { body: 'Plan a trip to Đà Lạt' }),
        message('$ack', { own: false, sender: '@atum:test', body: 'Để mình xem rồi lên kế hoạch nhé.', interim: true }),
        line('$line', 'Đang tra cứu trên web…')
      ]
    }

    const root = (id: string) => window.document.querySelector<HTMLElement>(`[data-matrix-message-id="${id}"]`)
    const { emit } = await openChat(working)
    // The acknowledgement is a real message; the working line is one muted row under the
    // typing bubble, never a transcript message of its own.
    expect(root('$ack')).toBeTruthy()
    expect(root('$line')).toBeNull()
    const workingLine = window.document.querySelector<HTMLElement>('[data-matrix-progress-line]')
    expect(workingLine?.textContent).toBe('Đang tra cứu trên web…')
    expect(workingLine?.closest('[data-matrix-agent-working]')).toBeTruthy()

    emit({
      ...working,
      messages: [
        ...working.messages,
        // History: a settled line of an earlier build, an old fixed wait line, and a line the agent removed.
        line('$settled', 'Sắp xong.', {
          progress: {
            profile: 'atum.agent-turns/1.3',
            scope: 'owner_private',
            phase: 'settled',
            kind: 'settled',
            revision: 2
          }
        }),
        message('$waited', { own: false, sender: '@atum:test', body: 'Đã chờ máy Mac của bạn.', notice: true }),
        message('$removed', { own: false, sender: '@atum:test', body: '', redacted: true }),
        message('$a', { own: false, sender: '@atum:test', body: 'Here is a plan.', replyTo: '$q' })
      ]
    })
    await waitFor(() => expect(window.document.querySelector('[data-matrix-message-id="$a"]')).toBeTruthy())

    for (const id of ['$line', '$settled', '$waited', '$removed']) {
      expect(window.document.querySelector(`[data-matrix-message-id="${id}"]`)).toBeNull()
    }

    expect(window.document.querySelector('[data-matrix-progress-line]')).toBeNull()
    // The acknowledgement stays: it was a real message.
    expect(root('$ack')).toBeTruthy()
    expect(screen.queryByText('Message deleted')).toBeNull()
  })

  it('edits your newest question for real, then asks it again as the next turn', async () => {
    const command = vi.fn<MatrixUiBridge['command']>(async () => '$edit')
    const { bridge } = await openChat(ready, command)
    const box = () => screen.getByRole('textbox', { name: COMPOSER }) as HTMLTextAreaElement
    fireEvent.change(box(), { target: { value: 'a draft' } })
    const trigger = window.document.querySelector<HTMLButtonElement>('[data-matrix-message-actions]')!
    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    await waitFor(() => expect(box().value).toBe('Plan a trip to Đà Lạt'))
    // Your newest question in your assistant's chat: it answers again once changed.
    expect(screen.getByText('Editing · Atum will answer again')).toBeTruthy()
    expect(bridge.sendTurn).not.toHaveBeenCalled()

    fireEvent.change(box(), { target: { value: 'Plan a trip to Huế' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({
        kind: 'edit',
        roomId: '!assistant:test',
        eventId: '$q',
        body: 'Plan a trip to Huế'
      })
    )
    // Append-only: the changed words are the next turn, nothing earlier is rewritten.
    await waitFor(() =>
      expect(bridge.sendTurn).toHaveBeenCalledExactlyOnceWith('!assistant:test', 'Plan a trip to Huế')
    )
    // The draft that was in the box comes back.
    await waitFor(() => expect(box().value).toBe('a draft'))
    expect(screen.queryByText('Editing · Atum will answer again')).toBeNull()
    // Answered already: Find the answer is not offered.
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(screen.queryByRole('menuitem', { name: 'Find the answer' })).toBeNull()
  })

  it('never drops a send that still reaches the box while the assistant is paused', async () => {
    const { bridge, emit, view } = await openChat()
    const box = () => screen.getByRole('textbox', { name: COMPOSER }) as HTMLTextAreaElement
    fireEvent.change(box(), { target: { value: 'Book the train' } })
    // The assistant pauses between typing and sending: Send goes off at once, and so does an
    // answer's Retry…
    emit({ ...ready, readiness: { phase: 'degraded', step: 'ai', code: 'offline', since: 2 } })
    await waitFor(() => expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true))
    openAnswerMenu(view.container)
    expect(screen.getByRole('menuitem', { name: 'Retry' }).hasAttribute('data-disabled')).toBe(true)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    // …and a send that gets through anyway keeps its words, and says why.
    fireEvent.submit(box().closest('form')!)
    expect(await screen.findByText('Atum isn’t ready yet, so nothing was sent. Try again in a moment.')).toBeTruthy()
    expect(box().value).toBe('Book the train')
    expect(bridge.sendTurn).not.toHaveBeenCalled()

    // Back to ready, the same words go out.
    emit(ready)
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(bridge.sendTurn).toHaveBeenCalledExactlyOnceWith('!assistant:test', 'Book the train'))
  })

  it('never lets a retry of an older message too long to send replace the draft in the box', async () => {
    // Sent by an earlier build (16,000 characters), now over one message's bytes (FR20).
    const legacy = '字'.repeat(16_000)

    const { bridge, view } = await openChat({
      ...ready,
      messages: [
        message('$q', { body: legacy }),
        message('$a', { own: false, sender: '@atum:test', body: 'Here is a **plan**.', replyTo: '$q' })
      ]
    })

    const box = () => screen.getByRole('textbox', { name: COMPOSER }) as HTMLTextAreaElement
    fireEvent.change(box(), { target: { value: 'a draft' } })
    openAnswerMenu(view.container)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Retry' }))

    expect(await screen.findByText(/too long to send in one go/)).toBeTruthy()
    expect(box().value).toBe('a draft')
    expect(bridge.sendTurn).not.toHaveBeenCalled()
  })

  it('keeps an edit that asks again in its bar while the assistant is paused, saving nothing', async () => {
    const command = vi.fn<MatrixUiBridge['command']>(async () => '$edit')
    const { bridge, emit } = await openChat(ready, command)
    const box = () => screen.getByRole('textbox', { name: COMPOSER }) as HTMLTextAreaElement
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    await waitFor(() => expect(box().value).toBe('Plan a trip to Đà Lạt'))
    expect(screen.getByText('Editing · Atum will answer again')).toBeTruthy()
    fireEvent.change(box(), { target: { value: 'Plan a trip to Huế' } })
    emit({ ...ready, readiness: { phase: 'starting', step: 'hermes', since: 2 } })
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true))
    fireEvent.submit(box().closest('form')!)

    expect(await screen.findByText('Atum isn’t ready yet, so nothing was sent. Try again in a moment.')).toBeTruthy()
    expect(box().value).toBe('Plan a trip to Huế')
    expect(screen.getByText('Editing · Atum will answer again')).toBeTruthy()
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'edit' }))
    expect(bridge.sendTurn).not.toHaveBeenCalled()
  })

  it('stages a chosen file as a chip, sends it before the words, and says plainly when it is too big', async () => {
    const command = vi.fn<MatrixUiBridge['command']>(async () => null)
    const { bridge } = await openChat({ ...ready, roomId: group.id, messages: [] }, command)
    const input = screen.getByLabelText('Attach file (up to 20 MB)') as HTMLInputElement

    const big = new File(['x'], 'huge.mov')
    Object.defineProperty(big, 'size', { value: MATRIX_MAX_FILE_BYTES + 1 })
    fireEvent.change(input, { target: { files: [big] } })
    expect(screen.getByRole('alert').textContent).toBe('Choose a file no larger than 20 MB.')
    expect(window.document.querySelector('[data-matrix-staged-file]')).toBeNull()

    const notes = new File(['hello'], 'notes.txt')
    Object.defineProperty(notes, 'arrayBuffer', { value: async () => new TextEncoder().encode('hello').buffer })
    fireEvent.change(input, { target: { files: [notes] } })
    expect(screen.queryByRole('alert')).toBeNull()
    const chip = window.document.querySelector<HTMLElement>('[data-matrix-staged-file]')!
    expect(within(chip).getByText('notes.txt')).toBeTruthy()
    // Choosing never sends: the file waits for Send.
    expect(command).not.toHaveBeenCalled()

    fireEvent.click(within(chip).getByRole('button', { name: 'Remove notes.txt' }))
    expect(window.document.querySelector('[data-matrix-staged-file]')).toBeNull()

    fireEvent.change(input, { target: { files: [notes] } })
    fireEvent.change(screen.getByRole('textbox', { name: COMPOSER }), {
      target: { value: 'Here are the notes' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2))
    expect(command.mock.calls[0]![0]).toMatchObject({ kind: 'attach', roomId: group.id, name: 'notes.txt' })
    expect(command.mock.calls[1]![0]).toEqual({ kind: 'send', roomId: group.id, body: 'Here are the notes' })
    await waitFor(() => expect(window.document.querySelector('[data-matrix-staged-file]')).toBeNull())
    expect(bridge.sendTurn).not.toHaveBeenCalled()
  })

  it('sends a staged file on its own, from the button or Enter', async () => {
    const command = vi.fn<MatrixUiBridge['command']>(async () => null)
    await openChat({ ...ready, roomId: group.id, messages: [] }, command)
    const notes = new File(['hello'], 'notes.txt')
    Object.defineProperty(notes, 'arrayBuffer', { value: async () => new TextEncoder().encode('hello').buffer })

    fireEvent.change(screen.getByLabelText('Attach file (up to 20 MB)'), { target: { files: [notes] } })
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
    expect(send.disabled).toBe(false)
    fireEvent.click(send)
    await waitFor(() => expect(command).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'attach' })))

    fireEvent.change(screen.getByLabelText('Attach file (up to 20 MB)'), { target: { files: [notes] } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: COMPOSER }), { key: 'Enter' })
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2))
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'send' }))
  })

  it('keeps the staged file and the words when the send fails, and Try again sends both', async () => {
    let refuse = true

    const command = vi.fn<MatrixUiBridge['command']>(async request => {
      if (request.kind === 'attach' && refuse) {
        refuse = false
        throw new Error("Error invoking remote method 'matrix:ui': Error: matrix_not_ready")
      }

      return null
    })

    await openChat({ ...ready, roomId: group.id, messages: [] }, command)
    const notes = new File(['hello'], 'notes.txt')
    Object.defineProperty(notes, 'arrayBuffer', { value: async () => new TextEncoder().encode('hello').buffer })
    fireEvent.change(screen.getByLabelText('Attach file (up to 20 MB)'), { target: { files: [notes] } })
    const box = screen.getByRole('textbox', { name: COMPOSER }) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'Here are the notes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const failure = () => window.document.querySelector<HTMLElement>('[data-matrix-failure]')
    await waitFor(() => expect(failure()?.dataset.matrixFailure).toBe('not_ready'))
    expect(failure()!.textContent).not.toContain('finishing another step')
    await waitFor(() => expect(box.value).toBe('Here are the notes'))
    expect(within(window.document.querySelector<HTMLElement>('[data-matrix-staged-file]')!).getByText('notes.txt')).toBeTruthy()
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'send' }))

    fireEvent.click(within(failure()!).getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(command).toHaveBeenLastCalledWith({ kind: 'send', roomId: group.id, body: 'Here are the notes' })
    )
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ kind: 'attach', name: 'notes.txt' }))
    await waitFor(() => expect(window.document.querySelector('[data-matrix-staged-file]')).toBeNull())
    await waitFor(() => expect(box.value).toBe(''))
  })

  it('keeps the attach entry where the assistant answers on this Mac', async () => {
    await openChat()
    expect(screen.getByLabelText('Attach file (up to 20 MB)')).toBeTruthy()
  })

  it("offers the attach entry, stages one file, and sends it in a cloud assistant's chat", async () => {
    const command = vi.fn<MatrixUiBridge['command']>(async () => null)
    const { emit, view } = await openChat(ready, command)
    expect(screen.getByLabelText('Attach file (up to 20 MB)')).toBeTruthy()

    const cloud: MatrixSnapshot = {
      ...ready,
      rooms: ready.rooms.map(each => (each.assistant ? { ...each, agentPrincipal: 'cloud-t' } : each)),
      agents: [
        {
          principal: 'cloud-t',
          userId: '@atum:test',
          ready: false,
          isDefault: true,
          atumModel: true,
          hermes: 'unavailable',
          answering: 'cloud'
        }
      ]
    }

    emit(cloud)
    await waitFor(() => expect(screen.getByLabelText('Attach file (up to 20 MB)')).toBeTruthy())

    // Over 20 MB (the controller's per-file bound): the localized reason, and nothing staged.
    const big = new File(['x'], 'huge.mov')
    Object.defineProperty(big, 'size', { value: MATRIX_MAX_FILE_BYTES + 1 })
    fireEvent.change(screen.getByLabelText('Attach file (up to 20 MB)'), { target: { files: [big] } })
    expect(screen.getByRole('alert').textContent).toBe('Choose a file no larger than 20 MB.')
    expect(view.container.querySelector('[data-matrix-staged-file]')).toBeNull()

    const notes = new File(['hello'], 'notes.txt')
    Object.defineProperty(notes, 'arrayBuffer', { value: async () => new TextEncoder().encode('hello').buffer })
    fireEvent.change(screen.getByLabelText('Attach file (up to 20 MB)'), { target: { files: [notes] } })
    const chip = view.container.querySelector<HTMLElement>('[data-matrix-staged-file]')!
    expect(within(chip).getByText('notes.txt')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ kind: 'attach', roomId: assistantRoom.id, name: 'notes.txt' })
      )
    )
  })

  it("shows a received file as a card with Save, and people's markdown rendered", async () => {
    const command = vi.fn<MatrixUiBridge['command']>(async () => null)

    const { view } = await openChat(
      {
        ...ready,
        roomId: group.id,
        members: [
          { userId: owner.userId, name: 'Owner', membership: 'join', canRemove: false },
          { userId: '@linh:test', name: 'Linh', membership: 'join', canRemove: false }
        ],
        messages: [
          message('$m1', { own: false, sender: '@linh:test', body: 'The **menu** is in.' }),
          message('$m2', { own: false, sender: '@linh:test', body: 'menu.pdf', attachment: true, attachmentSize: 2048 })
        ]
      },
      command
    )

    expect((await screen.findByText('menu')).closest('[data-streamdown="strong"]')).toBeTruthy()
    expect(screen.queryByText(/\*\*/)).toBeNull()
    // One name for the run, not one per message.
    expect(view.container.querySelectorAll('[data-matrix-sender]')).toHaveLength(1)
    const card = view.container.querySelector<HTMLElement>('[data-matrix-file-card]')!
    expect(within(card).getByText('menu.pdf')).toBeTruthy()
    expect(within(card).getByText(/2\s*kB/i)).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: 'Save menu.pdf' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'download', roomId: group.id, eventId: '$m2' }))
  })

  it('offers Try now inline and keeps Delete last in the failed message menu', async () => {
    const command = vi.fn<MatrixUiBridge['command']>(async () => null)
    await openChat(
      {
        ...ready,
        roomId: group.id,
        messages: [message('~!group:test:m1', { failed: true, body: 'Taste on Thursday?' })]
      },
      command
    )

    const failed = window.document.querySelector<HTMLElement>('[data-matrix-send-failed]')!
    expect(failed.textContent).toContain("Not sent. Sending when you're back online.")
    expect(within(failed).queryByRole('button', { name: 'Delete' })).toBeNull()
    fireEvent.click(within(failed).getByRole('button', { name: 'Try now' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({ kind: 'resend', roomId: group.id, eventId: '~!group:test:m1' })
    )
    const failedRoot = failed.closest<HTMLElement>('[data-matrix-message-id]')!
    fireEvent.keyDown(within(failedRoot).getByRole('button', { name: /Message actions/ }), { key: 'Enter' })
    const items = screen.getAllByRole('menuitem')
    expect(items.at(-1)?.textContent).toBe('Delete')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete for everyone?' })).getByRole('button', { name: 'Delete' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({ kind: 'discard', roomId: group.id, eventId: '~!group:test:m1' })
    )
  })

  it("says a message can't be read on this Mac, and Restore messages opens recovery in Settings", async () => {
    await openChat({
      ...ready,
      roomId: group.id,
      security: { recovery: 'idle', backupAvailable: true },
      messages: [message('$x', { own: false, sender: '@linh:test', decryptionFailed: true, body: '' })]
    })
    expect(screen.getByText("Couldn't load this message.")).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Restore messages' }))
    const settings = window.document.querySelector<HTMLElement>('[data-matrix-settings]')!
    await waitFor(() => expect(settings.hidden).toBe(false))
    // Privacy is a section of the Account page (Atum Kit Settings); the link lands on it.
    expect(settings.querySelector('[data-matrix-settings-pane="account"]')?.getAttribute('aria-current')).toBe('page')
    expect(settings.querySelector('[data-matrix-settings-section="privacy"]')).toBeTruthy()
  })

  it.each([undefined, false])(
    'does not offer Restore for an unknown message without a confirmed backup (%s)',
    async backupAvailable => {
      await openChat({
        ...ready,
        roomId: group.id,
        security: { recovery: 'idle', backupAvailable },
        messages: [message('$x', { own: false, sender: '@linh:test', decryptionFailed: true, body: '' })]
      })

      expect(screen.getByText("Couldn't load this message.")).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Restore messages' })).toBeNull()
    }
  )

  it('logs an automatic existing-room refresh failure without raising the window band', async () => {
    const { bridge } = await openChat()
    const diagnostic = vi.fn()
    bridge.windowFailureDiagnostic = diagnostic
    vi.mocked(bridge.connectHermes).mockRejectedValueOnce(
      new Error("Error invoking remote method 'matrix:ui': Error: matrix_agent_unavailable")
    )
    fireEvent.click(screen.getByRole('button', { name: /^Atum$/ }))
    await waitFor(() => expect(bridge.connectHermes).toHaveBeenCalledWith('!assistant:test'))
    await waitFor(() =>
      expect(diagnostic).toHaveBeenCalledWith({
        source: 'connectHermes',
        code: 'matrix_agent_unavailable',
        retryable: true
      })
    )
    expect(screen.queryByText('That didn’t work. Try again.')).toBeNull()
    expect(screen.queryByText('This assistant isn’t available right now. Try again in a moment.')).toBeNull()
  })

  it('opens a cloud assistant chat without asking this Mac to connect a local host', async () => {
    const cloud: MatrixSnapshot = {
      ...ready,
      rooms: ready.rooms.map(room =>
        room.id === assistantRoom.id ? { ...room, agentPrincipal: '066233c7-raymond' } : room
      ),
      agents: [
        {
          principal: '066233c7-raymond',
          userId: '@atum:test',
          name: 'Raymond',
          isDefault: true,
          ready: true,
          hermes: 'unavailable',
          atumModel: true,
          answering: 'cloud'
        }
      ]
    }

    const { bridge } = await openChat(cloud)
    vi.mocked(bridge.connectHermes).mockClear()
    fireEvent.click(screen.getByRole('button', { name: /^Raymond$/ }))
    await waitFor(() =>
      expect(bridge.command).toHaveBeenCalledWith({ kind: 'select', roomId: assistantRoom.id })
    )
    expect(bridge.connectHermes).not.toHaveBeenCalled()
    expect(screen.queryByText('That didn’t work. Try again.')).toBeNull()
  })

  it("opens a new person's first chat on the greeting and inline connector card, with no checklist", async () => {
    const firstRun = { allow: vi.fn(async () => {}), decline: vi.fn(async () => {}), finish: vi.fn(async () => {}) }

    const fresh: MatrixSnapshot = {
      ...ready,
      messages: [],
      ownProfile: { userId: owner.userId, displayName: 'Minh', avatarMxc: null },
      firstRunMarker: 'unseen',
      firstRunWelcome: 'open',
      firstRun: 'offer',
      firstRunOpen: true,
      googleAssistant: { state: 'connect' },
      agents: [
        {
          principal: '00000000-0000-4000-8000-576f18824476',
          userId: '@atum:test',
          name: 'Atum',
          isDefault: true,
          ready: true,
          hermes: 'ready',
          atumModel: true
        }
      ]
    }

    const { bridge, emit } = fixture(async () => fresh)
    bridge.firstRun = firstRun
    bridge.googleConnections = {
      status: vi.fn(async () => ({ status: { sources: [], available: true } })),
      connect: vi.fn(async () => ({ status: null, error: 'cancelled' as const })),
      disconnect: vi.fn(async () => ({ status: { sources: [], available: true } })),
      setSourcePreferences: vi.fn(async () => ({ status: { sources: [], available: true } }))
    }
    bridge.assistants = {
      read: vi.fn<MatrixAssistantCardsBridge['read']>(async () => ({ ok: false, error: 'unavailable' })),
      save: vi.fn<MatrixAssistantCardsBridge['save']>(async () => ({ ok: false, error: 'unavailable' })),
      avatar: vi.fn<MatrixAssistantCardsBridge['avatar']>(async () => ({ ok: false, error: 'unavailable' }))
    }
    emit(fresh)

    const card = await waitFor(() => {
      const found = window.document.querySelector<HTMLElement>('[data-matrix-first-run="offer"]')
      expect(found).not.toBeNull()

      return found!
    })

    // The welcome is one message: who it is, the invitation to name it, then what it can do. Naming
    // is the person's reply in the composer, answered by the assistant itself: no form, no chips.
    expect(card.textContent).toContain('Hi Minh, I’m Atum. You can rename me anytime')
    expect(card.querySelector('input:not([type="checkbox"]), textarea, form')).toBeNull()
    expect(within(card).queryByRole('button', { name: 'Na' })).toBeNull()
    expect(within(card).queryByRole('button', { name: 'Save name' })).toBeNull()
    expect(card.textContent).not.toContain('What would you like to call me?')
    expect(window.document.querySelector('[data-matrix-greeting]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Plan a trip' })).toBeNull()

    // There is no checklist: one inline Atum asks card owns the happy path.
    expect(card.querySelector('[data-matrix-first-run-checklist]')).toBeNull()
    expect(card.querySelector('[data-checklist-row]')).toBeNull()
    expect(card.querySelector('[data-matrix-first-run-connect-card]')).not.toBeNull()
    expect(await within(card).findByRole('button', { name: 'Continue' })).toBeTruthy()
    expect(card.querySelector('[data-atum-ask="google"]')).not.toBeNull()
    expect(card.textContent).not.toContain('If Google warns you')
    expect(bridge.assistants.read).not.toHaveBeenCalled()
    expect(bridge.assistants.save).not.toHaveBeenCalled()
    expect(bridge.enrollHermes).not.toHaveBeenCalled()
    expect(firstRun.allow).not.toHaveBeenCalled()

    // Answered (anywhere): the ordinary greeting and starters come back for new chats, without the invitation.
    emit({
      ...fresh,
      firstRun: undefined,
      firstRunOpen: undefined,
      firstRunMarker: 'answered',
      firstRunWelcome: 'done'
    })
    await waitFor(() => expect(window.document.querySelector('[data-matrix-greeting]')).not.toBeNull())
    expect(window.document.body.textContent).not.toContain('You can rename me anytime')
    expect(bridge.sendTurn).not.toHaveBeenCalled()
  })

  describe('a new account whose primary assistant answers in the cloud', () => {
    // The folder review is this Mac's, so main sets no `firstRun` for a cloud-placed primary; the
    // welcome is the account's, so `firstRunOpen` is set all the same.
    const cloudFresh: MatrixSnapshot = {
      ...ready,
      messages: [],
      ownProfile: { userId: owner.userId, displayName: 'Minh', avatarMxc: null },
      firstRunMarker: 'unseen',
      firstRunWelcome: 'open',
      firstRunOpen: true,
      googleAssistant: { state: 'connect' },
      agents: [
        {
          principal: '00000000-0000-4000-8000-576f18824476',
          userId: '@atum:test',
          name: 'Atum Bot',
          isDefault: true,
          ready: true,
          hermes: 'ready',
          atumModel: true
        }
      ]
    }

    const welcome = () => window.document.querySelector<HTMLElement>('[data-matrix-first-run="open"]')
    const skipped = () => window.document.querySelector<HTMLElement>('[data-matrix-first-run="skipped"]')
    const nudge = () => window.document.querySelector('[data-matrix-google-nudge]')

    const google: MatrixGoogleConnectionBridge = {
      status: vi.fn(async () => ({ status: { sources: [], available: true } })),
      connect: vi.fn(async () => ({ status: null, error: 'cancelled' as const })),
      disconnect: vi.fn(async () => ({ status: { sources: [], available: true } })),
      setSourcePreferences: vi.fn(async () => ({ status: { sources: [], available: true } }))
    }

    it('opens its first chat on the same welcome and Atum asks card', async () => {
      const firstRun = { allow: vi.fn(async () => {}), decline: vi.fn(async () => {}), finish: vi.fn(async () => {}) }
      const { bridge, emit } = fixture(async () => cloudFresh)
      bridge.firstRun = firstRun
      bridge.googleConnections = google
      emit(cloudFresh)

      const card = await waitFor(() => {
        expect(welcome()).not.toBeNull()

        return welcome()!
      })

      expect(card.textContent).toContain('Hi Minh, I’m Atum Bot. You can rename me anytime')
      expect(window.document.querySelector('[data-matrix-greeting]')).toBeNull()
      expect(card.querySelector('[data-matrix-first-run-checklist]')).toBeNull()
      expect(card.querySelector('[data-checklist-row]')).toBeNull()
      expect(within(card).getByRole('button', { name: 'Continue' })).toBeTruthy()
      expect(card.querySelector('[data-atum-ask="google"]')).not.toBeNull()
      expect(nudge()).toBeNull()

      // Skipping starts first learning through the legacy fallback in this older bridge fixture.
      fireEvent.click(within(card).getByRole('button', { name: 'Not now' }))
      await waitFor(() => expect(firstRun.decline).toHaveBeenCalledOnce())
      expect(within(card).queryByRole('button', { name: 'Continue' })).toBeNull()
      expect(firstRun.allow).not.toHaveBeenCalled()

      emit({ ...cloudFresh, firstRunOpen: undefined, firstRunMarker: 'answered', firstRunWelcome: 'dismissed' })
      await waitFor(() => expect(skipped()).not.toBeNull())
      expect(welcome()).toBeNull()
      // Skipped: the same greeting remains, but the card has collapsed to the chip.
      expect(skipped()!.textContent).toContain('You can rename me anytime')
      await waitFor(() => expect(nudge()).not.toBeNull())
    })

    it('lets the greeting give way to the conversation after the person replies', async () => {
      const firstRun = { allow: vi.fn(async () => {}), decline: vi.fn(async () => {}), finish: vi.fn(async () => {}) }
      const { bridge, emit } = fixture(async () => cloudFresh)
      bridge.firstRun = firstRun
      bridge.googleConnections = google
      emit(cloudFresh)
      await waitFor(() => expect(welcome()).not.toBeNull())

      // The person replies with a name and the assistant answers: the chat now has messages.
      const exchanged: MatrixSnapshot = {
        ...cloudFresh,
        messages: [
          message('$name', { body: 'Bông' }),
          message('$done', { own: false, sender: '@atum:test', body: 'Done. I’m Bông now.', timestamp: 2 })
        ],
        agents: [{ ...cloudFresh.agents![0]!, name: 'Bông' }]
      }

      emit(exchanged)
      expect(await screen.findByText('Done. I’m Bông now.')).toBeTruthy()
      await waitFor(() => expect(welcome()).toBeNull())
      expect(screen.queryByText(/You can rename me anytime/)).toBeNull()
      expect(firstRun.decline).not.toHaveBeenCalled()
      expect(firstRun.finish).not.toHaveBeenCalled()
      expect(nudge()).toBeNull()
    })
  })

  describe('the welcome follows the account’s record, not the window', () => {
    const cloudAccount: MatrixSnapshot = {
      ...ready,
      messages: [],
      ownProfile: { userId: owner.userId, displayName: 'Minh', avatarMxc: null },
      firstRunMarker: 'unseen',
      firstRunWelcome: 'open',
      firstRunOpen: true,
      googleAssistant: { state: 'connect' },
      agents: [
        {
          principal: '00000000-0000-4000-8000-576f18824476',
          userId: '@atum:test',
          name: 'Atum Bot',
          isDefault: true,
          ready: true,
          hermes: 'ready',
          atumModel: true
        }
      ]
    }

    const exchanged: MatrixSnapshot = {
      ...cloudAccount,
      messages: [
        message('$name', { body: 'Bông' }),
        message('$done', { own: false, sender: '@atum:test', body: 'Done. I’m Bông now.', timestamp: 2 })
      ],
      agents: [{ ...cloudAccount.agents![0]!, name: 'Bông' }]
    }

    const welcome = () => window.document.querySelector<HTMLElement>('[data-matrix-first-run="open"]')

    const google: MatrixGoogleConnectionBridge = {
      status: vi.fn(async () => ({ status: { sources: [], available: true } })),
      connect: vi.fn(async () => ({ status: null, error: 'cancelled' as const })),
      disconnect: vi.fn(async () => ({ status: { sources: [], available: true } })),
      setSourcePreferences: vi.fn(async () => ({ status: { sources: [], available: true } }))
    }

    const open = (snapshot: MatrixSnapshot) => {
      const view = fixture(async () => snapshot)
      view.bridge.firstRun = {
        allow: vi.fn(async () => {}),
        decline: vi.fn(async () => {}),
        finish: vi.fn(async () => {})
      }
      view.bridge.googleConnections = google
      view.emit(snapshot)

      return view
    }

    it('shows an existing account no welcome above its history: no folder answer is not a new account', async () => {
      // A cloud-first account from before the welcome existed: a week of chat with its assistant and no
      // folder answer, so its marker is "unseen". Main evaluated it once and wrote its record `done`.
      const history: MatrixSnapshot = { ...exchanged, firstRunWelcome: 'done', firstRunOpen: undefined }

      open(history)
      expect(await screen.findByText('Done. I’m Bông now.')).toBeTruthy()
      expect(window.document.querySelector('[data-matrix-first-run]')).toBeNull()
      expect(screen.queryByRole('heading', { name: 'Let me help with more' })).toBeNull()
      expect(window.document.body.textContent).not.toContain('You can rename me anytime')
    })

    it('shows nothing before the account has been evaluated, even with history, and never invents a welcome', async () => {
      for (const evaluating of [{ firstRunWelcome: 'unseen' as const }, { firstRunWelcome: 'unknown' as const }, {}]) {
        const unevaluated: MatrixSnapshot = { ...exchanged, firstRunOpen: undefined, ...evaluating }
        const { emit } = open(unevaluated)

        expect(await screen.findByText('Done. I’m Bông now.')).toBeTruthy()
        expect(window.document.querySelector('[data-matrix-first-run]')).toBeNull()
        emit({ ...unevaluated, rooms: [] })
        cleanup()
      }
    })

    it('opens the greeting for a new account and never pins it above real dialogue', async () => {
      const first = open(cloudAccount)
      await waitFor(() => expect(welcome()).not.toBeNull())
      expect(window.document.querySelector('[data-matrix-greeting]')).toBeNull()

      // The first exchange is the conversation now; no setup surface is pinned above it.
      first.emit(exchanged)
      expect(await screen.findByText('Done. I’m Bông now.')).toBeTruthy()
      await waitFor(() => expect(welcome()).toBeNull())
      cleanup()

      // A reload: a fresh window over the same synced account, with the history already there.
      open(exchanged)
      expect(await screen.findByText('Done. I’m Bông now.')).toBeTruthy()
      expect(welcome()).toBeNull()
    })

    it('skips the connector card and records the legacy dismissal on an older bridge', async () => {
      const { bridge } = open(cloudAccount)
      await waitFor(() => expect(welcome()).not.toBeNull())

      fireEvent.click(within(welcome()!).getByRole('button', { name: 'Not now' }))
      await waitFor(() => expect(bridge.firstRun!.decline).toHaveBeenCalledOnce())
      await waitFor(() => expect(within(welcome()!).queryByRole('button', { name: 'Continue' })).toBeNull())
      expect(bridge.firstRun!.finish).not.toHaveBeenCalled()
    })

    it('keeps the registry row when Google becomes connected', async () => {
      const { emit } = open(cloudAccount)
      await waitFor(() => expect(within(welcome()!).getByRole('button', { name: 'Continue' })).toBeTruthy())
      expect(welcome()!.querySelector('[data-atum-ask="google"]')).not.toBeNull()

      emit({
        ...cloudAccount,
        googleAssistant: {
          state: 'ready',
          services: { gmail: true, send: true, calendar: true, drive: true }
        }
      })
      await waitFor(() => expect(welcome()!.querySelector('[data-atum-ask="google"]')).not.toBeNull())
    })
  })

  it('uses the same minimal Google and Full Disk ask when the first run answers on this Mac', async () => {
    const firstRun = { allow: vi.fn(async () => {}), decline: vi.fn(async () => {}), finish: vi.fn(async () => {}) }

    const fresh: MatrixSnapshot = {
      ...ready,
      ownProfile: { userId: owner.userId, displayName: 'Minh', avatarMxc: null },
      firstRunMarker: 'unseen',
      firstRunWelcome: 'open',
      firstRun: 'offer',
      firstRunOpen: true,
      googleAssistant: { state: 'connect' },
      messages: [],
      agents: [
        {
          principal: 'default',
          userId: '@atum:test',
          name: 'Bông',
          isDefault: true,
          ready: true,
          hermes: 'ready',
          atumModel: true
        }
      ]
    }

    const { bridge, emit } = fixture(async () => fresh)
    bridge.firstRun = firstRun
    bridge.googleConnections = {
      status: vi.fn(async () => ({ status: { sources: [], available: true } })),
      connect: vi.fn(async () => ({ status: null, error: 'cancelled' as const })),
      disconnect: vi.fn(async () => ({ status: { sources: [], available: true } })),
      setSourcePreferences: vi.fn(async () => ({ status: { sources: [], available: true } }))
    }
    emit(fresh)

    const card = await waitFor(() => {
      const found = window.document.querySelector<HTMLElement>('[data-matrix-first-run="offer"]')
      expect(found).not.toBeNull()

      return found!
    })

    expect(card.querySelector('[data-matrix-first-run-checklist]')).toBeNull()
    expect(card.querySelector('[data-checklist-row]')).toBeNull()
    expect(within(card).getByRole('button', { name: 'Continue' })).toBeTruthy()
    expect(card.querySelector('[data-atum-ask="messages"]')).not.toBeNull()
    expect(bridge.enrollHermes).not.toHaveBeenCalled()
    expect(firstRun.allow).not.toHaveBeenCalled()
    expect(card.textContent).toContain('I’m Bông.')

    emit({
      ...fresh,
      firstRun: undefined,
      firstRunOpen: undefined,
      firstRunMarker: 'answered',
      firstRunWelcome: 'done'
    })
    await waitFor(() => expect(window.document.querySelector('[data-matrix-first-run]')).toBeNull())
  })

  // Two launch-night lanes meet in the assistant's first chat: conversational first run and
  // check-ins' first mention (heartbeat). The gift/balance notice never enters onboarding.
  it("keeps check-ins' first mention off the first message, until the assistant has spoken", async () => {
    const firstRun = { allow: vi.fn(async () => {}), decline: vi.fn(async () => {}), finish: vi.fn(async () => {}) }
    const intro = matrixCheckInsCopy.en.intro('8:00 AM')

    const fresh: MatrixSnapshot = {
      ...ready,
      messages: [],
      ownProfile: { userId: owner.userId, displayName: 'Minh', avatarMxc: null },
      firstRunMarker: 'unseen',
      firstRunWelcome: 'open',
      firstRun: 'offer',
      firstRunOpen: true,
      // Check-ins belong to the default assistant's own chat.
      agents: [
        { principal: 'default', userId: '@atum:test', isDefault: true, ready: true, hermes: 'ready', atumModel: true }
      ],
      checkIns: {
        settings: defaultMatrixCheckInSettings(),
        feedback: { muted: [], snoozed: [], ackAt: 0 },
        ledger: emptyMatrixCheckInLedger(),
        writable: true
      }
    }

    const { bridge, emit } = fixture(async () => fresh)
    bridge.firstRun = firstRun
    emit(fresh)

    await waitFor(() => expect(window.document.querySelector('[data-matrix-first-run="offer"]')).not.toBeNull())
    expect(screen.queryByText(intro)).toBeNull()

    // The review has answered: the first message has given way, and the mention may come.
    emit({
      ...fresh,
      firstRun: undefined,
      firstRunOpen: undefined,
      firstRunMarker: 'answered',
      firstRunWelcome: 'done',
      messages: [message('$review', { own: false, sender: '@atum:test', body: 'Here’s what I see: …', timestamp: 2 })]
    })

    expect(await screen.findByText(intro)).toBeTruthy()
    expect(window.document.querySelector('[data-matrix-first-run]')).toBeNull()

    // Check-ins are the assistant's own: Change opens its card, never Settings.
    act(() => $assistantCard.set(null))
    fireEvent.click(screen.getByRole('button', { name: matrixCheckInsCopy.en.introChange }))
    expect($assistantCard.get()).toEqual({ kind: 'agent', principal: 'default' })
    expect(window.document.querySelector<HTMLElement>('[data-matrix-settings]')?.hidden ?? true).toBe(true)
  })

  it('shows only the short System Settings recovery after a just-in-time folder denial', async () => {
    const firstRun = { allow: vi.fn(async () => {}), decline: vi.fn(async () => {}), finish: vi.fn(async () => {}) }
    const openSettings = vi.fn(async () => {})

    const blocked: MatrixSnapshot = {
      ...ready,
      messages: [],
      firstRunMarker: 'unseen',
      firstRunWelcome: 'open',
      firstRun: 'blocked',
      firstRunOpen: true
    }

    const { bridge, emit } = fixture(async () => blocked)
    bridge.firstRun = firstRun
    bridge.permissions = {
      status: vi.fn(async () => ({
        platform: 'macos',
        permissions: {
          accessibility: 'not-granted',
          screen: 'not-granted',
          microphone: 'not-granted',
          automation: 'not-granted',
          files: 'not-granted',
          fullDisk: 'not-granted',
          location: 'not-determined'
        }
      }) satisfies MatrixPermissionsSnapshot),
      openSettings
    }
    emit(blocked)

    const card = await waitFor(() => {
      const found = window.document.querySelector<HTMLElement>('[data-matrix-first-run="blocked"]')
      expect(found).not.toBeNull()

      return found!
    })

    expect(card.querySelector('[data-matrix-first-run-checklist]')).toBeNull()
    expect(card.querySelector('[data-checklist-row]')).toBeNull()
    expect(screen.getByText('macOS kept those folders closed.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(openSettings).not.toHaveBeenCalled()
    expect(firstRun.allow).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open System Settings' }))
    await waitFor(() => expect(openSettings).toHaveBeenCalledExactlyOnceWith('files'))
    expect(firstRun.decline).not.toHaveBeenCalled()
  })

  it('shows the first message in the main panel while the assistant is still getting ready', async () => {
    const firstRun = { allow: vi.fn(async () => {}), decline: vi.fn(async () => {}), finish: vi.fn(async () => {}) }

    const starting: MatrixSnapshot = {
      ...ready,
      roomId: null,
      rooms: [],
      messages: [],
      readiness: { phase: 'starting', step: 'hermes', since: Date.now() },
      firstRunMarker: 'unseen',
      firstRunWelcome: 'open',
      firstRun: 'offer',
      firstRunOpen: true,
      googleAssistant: { state: 'connect' }
    }

    const { bridge, emit } = fixture(async () => starting, 'vi')
    bridge.firstRun = firstRun
    bridge.googleConnections = {
      status: vi.fn(async () => ({ status: { sources: [], available: true } })),
      connect: vi.fn(async () => ({ status: null, error: 'cancelled' as const })),
      disconnect: vi.fn(async () => ({ status: { sources: [], available: true } })),
      setSourcePreferences: vi.fn(async () => ({ status: { sources: [], available: true } }))
    }
    emit(starting)

    const panel = await waitFor(() => {
      const found = window.document.querySelector<HTMLElement>('[data-matrix-first-run-panel]')
      expect(found).not.toBeNull()

      return found!
    })

    // The approved one-piece welcome says the assistant can be renamed without opening a naming form.
    expect(panel.textContent).toContain(
      'Chào bạn, mình là Atum. Bạn có thể đổi tên mình bất cứ lúc nào, chỉ cần nói tên bạn muốn gọi.'
    )
    expect(panel.textContent).not.toContain('Bạn muốn gọi mình là gì?')
    expect(panel.querySelector('input:not([type="checkbox"]), textarea, form')).toBeNull()
    expect(panel.querySelector('[data-matrix-launch-line="starting"]')).not.toBeNull()
    expect(await within(panel).findByRole('button', { name: 'Tiếp tục' })).toBeTruthy()
    expect(panel.querySelector('[data-atum-ask="google"]')).not.toBeNull()
    expect(panel.querySelector('[data-matrix-first-run-checklist]')).toBeNull()
    expect(bridge.enrollHermes).not.toHaveBeenCalled()
    expect(firstRun.allow).not.toHaveBeenCalled()
    expect(within(panel).getByRole('button', { name: 'Để sau' })).toBeTruthy()
  })

  it('fills the box from a starter in an empty chat, without sending', async () => {
    const { bridge } = await openChat({ ...ready, messages: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Plan a trip' }))
    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: COMPOSER }) as HTMLTextAreaElement).value).toBe(
        'Help me plan a trip to '
      )
    )
    expect(bridge.sendTurn).not.toHaveBeenCalled()
  })

  it('puts the caret in the box when a chat opens, and the skip link goes there too', async () => {
    await openChat()
    await waitFor(() => expect(window.document.activeElement).toBe(screen.getByRole('textbox', { name: COMPOSER })))
    act(() => (window.document.activeElement as HTMLElement).blur())
    fireEvent.click(screen.getByRole('link', { name: 'Skip to message box' }))
    expect(window.document.activeElement).toBe(screen.getByRole('textbox', { name: COMPOSER }))
  })

  it('opens New message (the start sheet) from Cmd+N and returns to the assistant’s existing conversation', async () => {
    const command = vi.fn<MatrixUiBridge['command']>(async () => null)
    const { bridge } = await openChat(ready, command)
    fireEvent.keyDown(screen.getByRole('textbox', { name: COMPOSER }), {
      key: 'n',
      code: 'KeyN',
      metaKey: true
    })
    const start = await screen.findByRole('dialog', { name: 'Start a chat' })
    fireEvent.click(
      within(within(start).getByRole('group', { name: 'Assistants' })).getByRole('button', { name: /^Atum/ })
    )
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: '!assistant:test' }))
    await waitFor(() => expect(bridge.connectHermes).toHaveBeenCalledWith('!assistant:test'))
    expect(command).not.toHaveBeenCalledWith({ kind: 'create', name: '', invite: ['@atum:test'], direct: true })
  })

  it('moves to the main when the open room becomes earlier, with the draft, and the next send goes there', async () => {
    const command = vi.fn<MatrixUiBridge['command']>(async () => null)
    const { bridge, emit } = await openChat(ready, command)
    fireEvent.change(screen.getByRole('textbox', { name: COMPOSER }), {
      target: { value: 'Keep this draft with Atum' }
    })

    const main = {
      ...assistantRoom,
      id: '!main:test',
      name: 'Atum main',
      agentPrincipal: 'atum',
      conversation: { role: 'main' as const, main: '!main:test', at: 2 },
      conversationOwnerId: owner.userId
    }

    const earlier = {
      ...assistantRoom,
      agentPrincipal: 'atum',
      conversation: { role: 'earlier' as const, main: main.id, at: 2 },
      conversationOwnerId: owner.userId
    }

    const agents = [
      {
        principal: 'atum',
        userId: '@atum:test',
        name: 'Atum',
        isDefault: true,
        ready: true,
        hermes: 'ready' as const,
        atumModel: true
      }
    ]

    expect(resolveProjectedConversation([earlier, main], owner.userId, '@atum:test')).toMatchObject({
      main: main.id,
      earlier: [earlier.id]
    })
    // The 0.20 move made a plain main while the old chat was open: the agent no longer answers
    // there, so the window goes to the main by itself. No Earlier banner, no button.
    emit({ ...ready, rooms: [earlier, main, group], agents })
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: main.id }))
    expect(command).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/This conversation is closed/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()

    // Main selects it: the draft is in the main's box, and sending it goes to the main.
    emit({ ...ready, roomId: main.id, rooms: [earlier, main, group], agents })
    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: COMPOSER }) as HTMLTextAreaElement).value).toBe(
        'Keep this draft with Atum'
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(bridge.sendTurn).toHaveBeenCalledWith(main.id, 'Keep this draft with Atum'))
    expect(bridge.sendTurn).not.toHaveBeenCalledWith(earlier.id, expect.anything())
    expect(command).toHaveBeenCalledTimes(1)
  })

  it('keeps the words in the old chat when the move to the main fails, with no copy left for the main', async () => {
    const command = vi.fn<MatrixUiBridge['command']>(async request =>
      request.kind === 'select' ? Promise.reject(new Error('matrix_not_ready')) : null
    )

    const { emit } = await openChat(ready, command)
    fireEvent.change(screen.getByRole('textbox', { name: COMPOSER }), { target: { value: 'Still here' } })

    const main = {
      ...assistantRoom,
      id: '!main:test',
      conversation: { role: 'main' as const, main: '!main:test', at: 2 },
      conversationOwnerId: owner.userId
    }

    const earlier = {
      ...assistantRoom,
      conversation: { role: 'earlier' as const, main: main.id, at: 2 },
      conversationOwnerId: owner.userId
    }

    emit({ ...ready, rooms: [earlier, main, group] })
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: main.id }))
    await waitFor(() => expect($matrixStoreDraft.get()).toBeNull())
    expect((screen.getByRole('textbox', { name: COMPOSER }) as HTMLTextAreaElement).value).toBe('Still here')
    expect(command).toHaveBeenCalledTimes(1)
  })

  it('stays in a chat with no marks yet, and in the main itself', async () => {
    const command = vi.fn<MatrixUiBridge['command']>(async () => null)
    const { emit } = await openChat(ready, command)
    const second = { ...assistantRoom, id: '!second:test', name: 'Atum 2', lastActiveAt: 9 }
    emit({ ...ready, rooms: [assistantRoom, second, group] })

    const main = {
      ...assistantRoom,
      conversation: { role: 'main' as const, main: assistantRoom.id, at: 2 },
      conversationOwnerId: owner.userId
    }

    const earlier = {
      ...second,
      conversation: { role: 'earlier' as const, main: main.id, at: 2 },
      conversationOwnerId: owner.userId
    }

    emit({ ...ready, rooms: [main, earlier, group] })
    await act(async () => {})
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'select' }))
    expect(screen.getByRole('textbox', { name: COMPOSER })).toBeTruthy()
  })

  it('finds chats, assistants and people in the palette alongside what you can do', async () => {
    const command = vi.fn<MatrixUiBridge['command']>(async () => null)
    await openChat(
      {
        ...ready,
        rooms: [
          ...ready.rooms,
          {
            id: '!linh:test',
            name: 'Linh',
            membership: 'join',
            encrypted: true,
            direct: true,
            participants: [
              { userId: owner.userId, membership: 'join' },
              { userId: '@linh:test', membership: 'join' }
            ]
          }
        ]
      },
      command
    )
    fireEvent.keyDown(screen.getByRole('textbox', { name: COMPOSER }), {
      key: 'k',
      code: 'KeyK',
      metaKey: true
    })
    const palette = await screen.findByRole('dialog', { name: 'Command palette' })
    expect(within(palette).getByPlaceholderText('Search chats and actions')).toBeTruthy()
    expect(within(palette).getByRole('option', { name: /Hide sidebar/ })).toBeTruthy()
    expect(within(palette).getByRole('option', { name: 'Design team' })).toBeTruthy()
    fireEvent.change(within(palette).getByRole('combobox'), { target: { value: 'linh' } })
    fireEvent.click(within(palette).getByRole('option', { name: 'Linh' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: '!linh:test' }))
  })

  it('opens the same start sheet from the palette’s New message, with New group in reach', async () => {
    const command = vi.fn<MatrixUiBridge['command']>(async () => null)
    await openChat(ready, command)
    fireEvent.keyDown(screen.getByRole('textbox', { name: COMPOSER }), {
      key: 'k',
      code: 'KeyK',
      metaKey: true
    })
    const palette = await screen.findByRole('dialog', { name: 'Command palette' })
    fireEvent.click(within(palette).getByRole('option', { name: /New message/ }))
    const start = await screen.findByRole('dialog', { name: 'Start a chat' })
    fireEvent.click(within(start).getByRole('button', { name: 'New group' }))
    expect(await screen.findByRole('dialog', { name: 'New group' })).toBeTruthy()
    // Opening the sheet decides nothing: no chat is made or chosen until you pick.
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'create' }))
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'select' }))
  })

  it('never shows working steps, while it works or above its answer: it types, then answers', async () => {
    const turnId = '00000000-0000-4000-8000-31f949766961'

    const tools = [
      { name: 'Search web', state: 'complete' as const, detail: 'guesthouse Đà Lạt' },
      { name: 'Read web', state: 'running' as const, detail: 'listings' }
    ]

    const { emit, view } = await openChat({
      ...ready,
      messages: [message('$q', { body: 'Find a guesthouse', turn: turnId })],
      hermesActivity: { roomId: assistantRoom.id, turnId, invocationId: 'live', state: 'running', text: '', tools }
    })

    expect(screen.getByRole('status', { name: 'Atum is typing…' })).toBeTruthy()
    expect(screen.queryByText('guesthouse Đà Lạt')).toBeNull()
    emit({
      ...ready,
      messages: [
        message('$q', { body: 'Find a guesthouse', turn: turnId }),
        message('$a2', { own: false, sender: '@atum:test', body: 'Hillside pines.', turn: turnId })
      ],
      hermesActivity: {
        roomId: assistantRoom.id,
        turnId,
        invocationId: 'live',
        state: 'complete',
        text: 'Hillside pines.',
        tools: tools.map(tool => ({ ...tool, state: 'complete' as const }))
      }
    })

    await waitFor(() => expect(screen.queryByRole('status', { name: 'Atum is typing…' })).toBeNull())
    expect(screen.getByText('Hillside pines.')).toBeTruthy()
    expect(screen.queryByText('guesthouse Đà Lạt')).toBeNull()
    expect(view.container.querySelector('[data-matrix-steps-list]')).toBeNull()
  })

  it('renames a chat from the header menu for you only, and mutes it', async () => {
    const command = vi.fn<MatrixUiBridge['command']>(async () => null)
    await openChat({ ...ready, roomId: group.id, messages: [] }, command)
    expect(screen.getByRole('button', { name: 'Members (0)' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Conversation options' }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const field = await screen.findByRole('textbox', { name: 'Name' })
    fireEvent.change(field, { target: { value: 'Menu team' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({ kind: 'chatTitle', roomId: group.id, title: 'Menu team' })
    )
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull())
    fireEvent.keyDown(screen.getByRole('button', { name: 'Conversation options' }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mute notifications' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'mute', roomId: group.id, muted: true }))
  })

  // Matrix's own chat features (launch night, ).
  describe("Matrix's own message features", () => {
    const linh = { userId: '@linh:test', name: 'Linh', membership: 'join', canRemove: false }
    const people = [{ userId: owner.userId, name: 'Owner', membership: 'join', canRemove: false }, linh]
    const root = (id: string) => window.document.querySelector<HTMLElement>(`[data-matrix-message-id="${id}"]`)!

    const groupChat = (messages: MatrixSnapshot['messages'], extra: Partial<MatrixSnapshot> = {}): MatrixSnapshot => ({
      ...ready,
      roomId: group.id,
      members: people,
      messages,
      ...extra
    })

    it('reacts from a message, shows reactions as chips with yours highlighted, and a chip takes yours back', async () => {
      const command = vi.fn<MatrixUiBridge['command']>(async () => null)
      await openChat(
        groupChat([
          message('$g1', {
            own: false,
            sender: linh.userId,
            body: 'Draft menu is in.',
            reactions: [
              { key: '👍', count: 2, own: true, senders: [owner.userId, linh.userId] },
              { key: '❤️', count: 1, own: false, senders: [linh.userId] }
            ]
          })
        ]),
        command
      )

      const mine = within(root('$g1')).getByRole('button', { name: '👍 2' })
      expect(mine.getAttribute('aria-pressed')).toBe('true')
      expect(within(root('$g1')).getByRole('button', { name: '❤️ 1' }).getAttribute('aria-pressed')).toBe('false')
      fireEvent.click(mine)
      await waitFor(() =>
        expect(command).toHaveBeenCalledWith({
          kind: 'react',
          roomId: group.id,
          eventId: '$g1',
          key: '👍',
          reacted: false
        })
      )
      fireEvent.click(within(root('$g1')).getByRole('button', { name: '❤️ 1' }))
      await waitFor(() =>
        expect(command).toHaveBeenCalledWith({
          kind: 'react',
          roomId: group.id,
          eventId: '$g1',
          key: '❤️',
          reacted: true
        })
      )

      // The quick reactions, from the message's own toolbar.
      fireEvent.click(within(root('$g1')).getByRole('button', { name: 'React' }))
      const picker = await screen.findByRole('group', { name: 'React' })
      expect(within(picker).getByRole('button', { name: 'React with 👍' }).getAttribute('aria-pressed')).toBe('true')
      fireEvent.click(within(picker).getByRole('button', { name: 'React with 😂' }))
      await waitFor(() =>
        expect(command).toHaveBeenCalledWith({
          kind: 'react',
          roomId: group.id,
          eventId: '$g1',
          key: '😂',
          reacted: true
        })
      )
      await waitFor(() => expect(screen.queryByRole('group', { name: 'React' })).toBeNull())
    })

    it("replies to someone's message: the bar names them, Esc ends it, and the reply goes with the words", async () => {
      const command = vi.fn<MatrixUiBridge['command']>(async () => null)
      await openChat(
        groupChat([message('$g1', { own: false, sender: linh.userId, body: 'Thoughts by Friday?' })]),
        command
      )
      const box = () => screen.getByRole('textbox', { name: COMPOSER }) as HTMLTextAreaElement

      fireEvent.click(within(root('$g1')).getByRole('button', { name: 'Reply' }))
      const bar = () => window.document.querySelector<HTMLElement>('[data-matrix-composer-context="reply"]')
      expect(within(bar()!).getByText('Replying to Linh')).toBeTruthy()
      expect(within(bar()!).getByText('Thoughts by Friday?')).toBeTruthy()
      fireEvent.keyDown(box(), { key: 'Escape' })
      expect(bar()).toBeNull()

      fireEvent.click(within(root('$g1')).getByRole('button', { name: 'Reply' }))
      fireEvent.change(box(), { target: { value: 'Love it' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await waitFor(() =>
        expect(command).toHaveBeenCalledWith({ kind: 'send', roomId: group.id, body: 'Love it', replyTo: '$g1' })
      )
      await waitFor(() => expect(bar()).toBeNull())

      // × ends a reply too.
      fireEvent.click(within(root('$g1')).getByRole('button', { name: 'Reply' }))
      fireEvent.click(within(bar()!).getByRole('button', { name: 'Cancel reply' }))
      expect(bar()).toBeNull()
    })

    it("replies to your assistant's answer with the answer's words as context", async () => {
      const { bridge } = await openChat()
      const actions = root('$a').querySelector<HTMLElement>('[data-matrix-message-toolbar]')!

      fireEvent.click(within(actions).getByRole('button', { name: 'Reply' }))
      expect(screen.getByText('Replying to Atum')).toBeTruthy()
      fireEvent.change(screen.getByRole('textbox', { name: COMPOSER }), {
        target: { value: 'Make it two days' }
      })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await waitFor(() =>
        expect(bridge.sendTurn).toHaveBeenCalledExactlyOnceWith('!assistant:test', 'Make it two days', {
          eventId: '$a',
          quote: 'Here is a **plan**.'
        })
      )
    })

    it('changes an older question only for what is shown: your assistant does not answer it again', async () => {
      const command = vi.fn<MatrixUiBridge['command']>(async () => '$edit')

      const { bridge } = await openChat(
        {
          ...ready,
          messages: [
            message('$q1', { body: 'Plan a trip to Đà Lạt' }),
            message('$a1', { own: false, sender: '@atum:test', body: 'Here is a plan.', replyTo: '$q1' }),
            message('$q2', { body: 'Thanks!' })
          ]
        },
        command
      )

      fireEvent.keyDown(root('$q1').querySelector<HTMLButtonElement>('[data-matrix-message-actions]')!, {
        key: 'Enter'
      })
      fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
      expect(screen.getByText('Editing · only what’s shown changes')).toBeTruthy()
      fireEvent.change(screen.getByRole('textbox', { name: COMPOSER }), {
        target: { value: 'Plan a trip to Đà Lạt in May' }
      })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() =>
        expect(command).toHaveBeenCalledWith({
          kind: 'edit',
          roomId: '!assistant:test',
          eventId: '$q1',
          body: 'Plan a trip to Đà Lạt in May'
        })
      )
      await waitFor(() => expect(screen.queryByText('Editing · only what’s shown changes')).toBeNull())
      expect(bridge.sendTurn).not.toHaveBeenCalled()
    })

    it('edits your last message with Up in an empty box, Esc gives the box back, and unchanged words send nothing', async () => {
      const command = vi.fn<MatrixUiBridge['command']>(async () => '$edit')
      await openChat(
        groupChat([
          message('$g1', { own: false, sender: linh.userId, body: 'Menu?' }),
          message('$g5', { body: 'Looks good to me.' }),
          // A file is never edited: Up skips it for your last words.
          message('$file', { body: 'menu.pdf', attachment: true })
        ]),
        command
      )
      const box = () => screen.getByRole('textbox', { name: COMPOSER }) as HTMLTextAreaElement

      fireEvent.keyDown(box(), { key: 'ArrowUp' })
      await waitFor(() => expect(box().value).toBe('Looks good to me.'))
      expect(screen.getByText('Editing message')).toBeTruthy()
      fireEvent.keyDown(box(), { key: 'Escape' })
      await waitFor(() => expect(box().value).toBe(''))
      expect(screen.queryByText('Editing message')).toBeNull()

      fireEvent.keyDown(box(), { key: 'ArrowUp' })
      await waitFor(() => expect(box().value).toBe('Looks good to me.'))
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(screen.queryByText('Editing message')).toBeNull())
      expect(command).not.toHaveBeenCalled()

      fireEvent.keyDown(box(), { key: 'ArrowUp' })
      await waitFor(() => expect(box().value).toBe('Looks good to me.'))
      fireEvent.change(box(), { target: { value: 'Looks great to me.' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() =>
        expect(command).toHaveBeenCalledExactlyOnceWith({
          kind: 'edit',
          roomId: group.id,
          eventId: '$g5',
          body: 'Looks great to me.'
        })
      )
      // Typed words stay typed: Up only edits from an empty box.
      fireEvent.change(box(), { target: { value: 'half a thought' } })
      fireEvent.keyDown(box(), { key: 'ArrowUp' })
      expect(box().value).toBe('half a thought')
    })

    it('deletes your own message for everyone after asking, and says in your assistant chat that it may remember', async () => {
      const command = vi.fn<MatrixUiBridge['command']>(async () => null)
      await openChat(ready, command)

      fireEvent.keyDown(root('$q').querySelector<HTMLButtonElement>('[data-matrix-message-actions]')!, { key: 'Enter' })
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      const confirm = screen.getByRole('dialog', { name: 'Delete for everyone?' })
      expect(
        within(confirm).getByText('It disappears for everyone in this chat. Atum may still remember what it saw.')
      ).toBeTruthy()
      expect(command).not.toHaveBeenCalled()
      fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }))
      await waitFor(() =>
        expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'redact', roomId: '!assistant:test', eventId: '$q' })
      )
      // Nobody else's message can be deleted from here.
      expect(root('$a').querySelector('[data-matrix-message-actions]')).toBeNull()
    })

    it('asks plainly before deleting your message in a chat with people, and offers Report, not Delete, on theirs', async () => {
      await openChat(
        groupChat([message('$g1', { own: false, sender: linh.userId, body: 'Menu?' }), message('$g5', { body: 'Yes' })])
      )

      fireEvent.keyDown(root('$g5').querySelector<HTMLButtonElement>('[data-matrix-message-actions]')!, {
        key: 'Enter'
      })
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      const confirm = screen.getByRole('dialog', { name: 'Delete for everyone?' })
      expect(within(confirm).getByText('It disappears for everyone in this chat.')).toBeTruthy()
      fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

      fireEvent.keyDown(root('$g1').querySelector<HTMLButtonElement>('[data-matrix-report-message]')!, { key: 'Enter' })
      expect(screen.getByRole('menuitem', { name: 'Report' })).toBeTruthy()
      expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull()
      expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull()
    })

    // 0.20: new groups are plain. Their messages get the same actions; a plaintext message in an
    // encrypted chat gets none (no downgrade).
    const plainGroup = (encryptedRoom: boolean): MatrixSnapshot =>
      groupChat(
        [
          message('$g1', { own: false, sender: linh.userId, body: 'Menu?', encrypted: false }),
          message('$g5', { body: 'Yes', encrypted: false })
        ],
        { rooms: [assistantRoom, { ...group, encrypted: encryptedRoom }] }
      )

    it('offers react, report, edit and delete on plain messages in a plain group', async () => {
      await openChat(plainGroup(false))
      expect(within(root('$g1')).getByRole('button', { name: 'React' })).toBeTruthy()
      fireEvent.keyDown(root('$g1').querySelector<HTMLButtonElement>('[data-matrix-report-message]')!, { key: 'Enter' })
      expect(screen.getByRole('menuitem', { name: 'Report' })).toBeTruthy()
      fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Report' }), { key: 'Escape' })
      fireEvent.keyDown(root('$g5').querySelector<HTMLButtonElement>('[data-matrix-message-actions]')!, {
        key: 'Enter'
      })
      expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeTruthy()
      expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy()
    })

    it('offers no react, report or edit on a plaintext message in an encrypted group', async () => {
      await openChat(plainGroup(true))
      expect(within(root('$g1')).queryByRole('button', { name: 'React' })).toBeNull()
      expect(root('$g1').querySelector('[data-matrix-report-message]')).toBeNull()
      expect(within(root('$g5')).queryByRole('button', { name: 'React' })).toBeNull()
      // The own message keeps only Copy: no Edit, no Delete.
      fireEvent.keyDown(root('$g5').querySelector<HTMLButtonElement>('[data-matrix-message-actions]')!, {
        key: 'Enter'
      })
      expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull()
      expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull()
    })

    it("shows a deleted message as one line, an edited one as edited, and a thread message under its thread's first", async () => {
      await openChat(
        groupChat([
          message('$g1', { own: false, sender: linh.userId, body: 'Thread root' }),
          message('$d', { own: false, sender: linh.userId, body: '', redacted: true }),
          message('$e', { body: 'Fixed typo', edited: true }),
          message('$t', { own: false, sender: '@quan:test', body: 'Agreed', thread: true, replyTo: '$g1' })
        ])
      )

      expect(within(root('$d')).getByText('Message deleted')).toBeTruthy()
      expect(within(root('$d')).queryByRole('button', { name: 'React' })).toBeNull()
      expect(within(root('$d')).queryByRole('button', { name: 'Reply' })).toBeNull()
      expect(within(root('$e')).getByText('edited')).toBeTruthy()
      const quote = root('$t').querySelector<HTMLElement>('[data-matrix-reply-quote]')!
      expect(within(quote).getByText(/In a thread/)).toBeTruthy()
      expect(within(quote).getByText('Thread root')).toBeTruthy()
    })

    it('shows the message a reply quotes when the quote is clicked', async () => {
      await openChat(
        groupChat([
          message('$g1', { own: false, sender: linh.userId, body: 'Thoughts by Friday?' }),
          message('$r', { body: 'Love it', replyTo: '$g1' })
        ])
      )

      fireEvent.click(within(root('$r')).getByRole('button', { name: 'Show the original message: Linh' }))
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
      expect(root('$g1').hasAttribute('data-matrix-highlight')).toBe(true)
    })

    it('shows your message to people the moment you press Send, then the Matrix copy in its place', async () => {
      let sent!: (eventId: string) => void

      const command = vi.fn<MatrixUiBridge['command']>(async input =>
        input.kind === 'send' ? new Promise(resolve => (sent = resolve)) : null
      )

      const { emit } = await openChat(
        groupChat([message('$g1', { own: false, sender: linh.userId, body: 'Hi' })]),
        command
      )

      const bubbles = () =>
        [...window.document.querySelectorAll<HTMLElement>('[data-matrix-message-id]')].filter(found =>
          found.textContent?.includes('See you at 8')
        )

      fireEvent.change(screen.getByRole('textbox', { name: COMPOSER }), { target: { value: 'See you at 8' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await waitFor(() => expect(bubbles()).toHaveLength(1))
      expect(bubbles()[0]!.dataset.matrixMessageId).toMatch(/^echo-/)
      expect(within(bubbles()[0]!).getByRole('status', { name: 'Sending' })).toBeTruthy()

      emit(
        groupChat([
          message('$g1', { own: false, sender: linh.userId, body: 'Hi' }),
          message('$mine', { body: 'See you at 8', timestamp: Date.now(), sent: true })
        ])
      )
      await act(async () => sent('$mine'))
      await waitFor(() => expect(bubbles().map(found => found.dataset.matrixMessageId)).toEqual(['$mine']))
    })

    it("says who is typing in a chat with people and tells them while you type, never in your assistant's chat", async () => {
      const { emit } = await openChat(
        groupChat([message('$g1', { own: false, sender: linh.userId, body: 'Hi' })], { typing: [linh.userId] })
      )

      const typing = vi.fn(async () => null)
      window.atumMatrix.typing = typing
      expect(screen.getByText('Linh is typing…')).toBeTruthy()

      fireEvent.change(screen.getByRole('textbox', { name: COMPOSER }), { target: { value: 'Hel' } })
      await waitFor(() => expect(typing).toHaveBeenCalledWith(group.id, true))
      fireEvent.change(screen.getByRole('textbox', { name: COMPOSER }), { target: { value: '' } })
      await waitFor(() => expect(typing).toHaveBeenLastCalledWith(group.id, false))

      typing.mockClear()
      // Your assistant's chat: it shows the assistant typing (its own typing notification, from
      // wherever it runs) in the transcript, but your own typing is told to nobody there.
      const agentTyping = () => screen.queryAllByRole('status', { name: 'Atum is typing…' })
      emit({ ...ready, typing: ['@atum:test'] })
      await waitFor(() => expect(agentTyping()).toHaveLength(1))
      expect(window.document.querySelector('[data-matrix-typing]')).toBeNull()
      fireEvent.change(screen.getByRole('textbox', { name: COMPOSER }), { target: { value: 'Plan a trip' } })
      expect(typing).not.toHaveBeenCalledWith(assistantRoom.id, true)

      // A run on this Mac, with or without its typing notification: one sign, never two.
      emit({ ...ready, typing: ['@atum:test'], hermes: 'running' })
      await waitFor(() => expect(agentTyping()).toHaveLength(1))
      emit({
        ...ready,
        localTurns: [
          {
            turnId: '00000000-0000-4000-8000-31f949766961',
            roomId: assistantRoom.id,
            text: 'Plan a trip',
            createdAt: 1,
            state: 'running',
            synced: { question: false, answer: false }
          }
        ]
      })
      await waitFor(() => expect(agentTyping()).toHaveLength(1))
      emit({ ...ready })
      await waitFor(() => expect(agentTyping()).toHaveLength(0))
    })

    it("says Sent under your newest message once the server has it, then Seen in your assistant's chat", async () => {
      const { emit } = await openChat({
        ...ready,
        messages: [message('$old', { sent: true }), message('$new', { pending: true })]
      })

      // Still sending: a small clock (named for screen readers), nothing says Sent yet.
      expect(within(root('$new')).getByRole('status', { name: 'Sending' })).toBeTruthy()
      expect(within(root('$new')).queryByText('Sending')).toBeNull()
      expect(window.document.querySelector('[data-matrix-sent]')).toBeNull()

      emit({ ...ready, messages: [message('$old', { sent: true }), message('$new', { sent: true })] })
      await waitFor(() => expect(within(root('$new')).getByText('Sent')).toBeTruthy())
      expect(within(root('$old')).queryByText('Sent')).toBeNull()

      // The assistant's receipt: one Seen, no count, on your newest message only.
      emit({
        ...ready,
        messages: [message('$old', { sent: true }), message('$new', { sent: true, readBy: ['@atum:test'] })]
      })
      await waitFor(() => expect(root('$new').querySelector('[data-matrix-seen]')).toBeTruthy())
      expect(within(root('$new')).queryByText('Sent')).toBeNull()
      expect(root('$old').querySelector('[data-matrix-seen]')).toBeNull()
      expect(screen.queryByText(/Seen by/)).toBeNull()
      // One reader: their face, never a count.
      expect(root('$new').querySelector('[data-matrix-reader-avatar]')).toBeTruthy()
      expect(root('$new').querySelector('[data-matrix-seen-more]')).toBeNull()
      expect(root('$new').querySelector('[data-matrix-seen]')?.getAttribute('aria-label')).toBe('Seen')
    })

    it.each([
      ['en', 'Sent', 'Seen'],
      ['vi', 'Đã gửi', 'Đã xem'],
      ['ja', '送信済み', '既読'],
      ['zh', '已发送', '已读'],
      ['zh-hant', '已傳送', '已讀']
    ] as const)("Sent becomes Seen once your assistant's receipt covers it (%s)", async (locale, sent, seen) => {
      const { emit } = fixture(async () => ({ ...ready, messages: [message('$q', { sent: true })] }), locale)
      await waitFor(() => expect(plate()).toBeNull(), LAUNCH_OPENS)
      await waitFor(() => expect(within(root('$q')).getByText(sent)).toBeTruthy())
      expect(root('$q').querySelector('[data-matrix-seen]')).toBeNull()

      // The agent's public receipt arrives (projected as readBy): its face says Seen, no Sent.
      emit({ ...ready, messages: [message('$q', { sent: true, readBy: ['@atum:test'] })] })
      await waitFor(() => expect(root('$q').querySelector('[data-matrix-seen]')).toBeTruthy())
      expect(within(root('$q')).queryByText(sent)).toBeNull()
      expect(root('$q').querySelector('[data-matrix-seen]')?.getAttribute('aria-label')).toBe(seen)
    })

    it('shows the readers who read a message as faces in a chat with people, and Sent on your newest unread one', async () => {
      await openChat(groupChat([message('$g1', { sent: true, readBy: [linh.userId] }), message('$g2', { sent: true })]))

      expect(root('$g1').querySelector('[data-matrix-seen]')?.getAttribute('aria-label')).toBe('Seen by 1')
      expect(root('$g1').querySelectorAll('[data-matrix-reader-avatar]')).toHaveLength(1)
      expect(within(root('$g2')).getByText('Sent')).toBeTruthy()
      expect(root('$g2').querySelector('[data-matrix-seen]')).toBeNull()
    })

    // Preserve user-visible identity, state and recovery behavior across connection changes.
    // beside the run's last bubble; the run's other bubbles keep an empty gutter of the same width.
    it("draws everyone's words as bubbles, a name over a run's first and a face beside its last", async () => {
      const sender = (id: string, from: string, body: string, at: number) =>
        message(id, { own: false, sender: from, body, timestamp: at })

      await openChat(
        groupChat(
          [
            sender('$r1', linh.userId, 'First line of the menu.', 1_000),
            sender('$r2', linh.userId, 'And the second.', 2_000),
            sender('$r2b', linh.userId, 'And the third.', 3_000),
            sender('$r3', '@quan:test', 'Thursday works.', 4_000),
            message('$r4', { body: 'Then Thursday it is.', sent: true, timestamp: 5_000 })
          ],
          {
            members: [...people, { userId: '@quan:test', name: 'Quân', membership: 'join', canRemove: false }]
          }
        )
      )

      // Everyone writes in the same left bubble; yours keeps its right one.
      expect(root('$r1').querySelector('.matrix-chat-bubble')).toBeTruthy()
      expect(root('$r2').querySelector('.matrix-chat-bubble')).toBeTruthy()
      expect(root('$r3').querySelector('.matrix-chat-bubble')).toBeTruthy()
      expect(root('$r4').querySelector('.composer-human-message')).toBeTruthy()

      // A run of three: the name on the first only, the face on the last only.
      expect(root('$r1').querySelector('[data-matrix-sender]')?.textContent).toBe('Linh')
      expect(root('$r2').querySelector('[data-matrix-sender]')).toBeNull()
      expect(root('$r2b').querySelector('[data-matrix-sender]')).toBeNull()
      expect(root('$r1').querySelector('[data-matrix-avatar]')).toBeNull()
      expect(root('$r2').querySelector('[data-matrix-avatar]')).toBeNull()
      expect(root('$r2b').querySelector('[data-matrix-avatar]')?.getAttribute('data-matrix-avatar')).toBe(linh.userId)
      // One message is a run of its own: name and face both.
      expect(root('$r3').querySelector('[data-matrix-sender]')?.textContent).toBe('Quân')
      expect(root('$r3').querySelector('[data-matrix-avatar]')?.getAttribute('data-matrix-avatar')).toBe('@quan:test')
      expect(root('$r4').querySelector('[data-matrix-avatar]')).toBeNull()

      // The run lines up: every bubble of it keeps the same 28 px gutter, the face at its bottom.
      for (const id of ['$r1', '$r2', '$r2b']) {
        const gutter = root(id).querySelector<HTMLElement>('[data-matrix-face-gutter]')!
        expect(gutter.classList.contains('w-7')).toBe(true)
        expect(gutter.classList.contains('self-end')).toBe(true)
      }

      // Everyone's face is the one shared round face, at 28 px.
      const face = root('$r2b').querySelector<HTMLElement>('[data-matrix-avatar] > *')!
      expect(face.classList.contains('atum-avatar')).toBe(true)
      expect(face.classList.contains('size-7')).toBe(true)
    })

    it('starts a new run after a pause over five minutes, a new day, or the unread line', async () => {
      const day = new Date(2026, 10, 5, 23, 50).getTime()
      const sender = (id: string, at: number) => message(id, { own: false, sender: linh.userId, body: id, timestamp: at })

      await openChat(
        groupChat(
          [
            sender('$b1', day),
            // Six minutes later: a pause.
            sender('$b2', day + 6 * 60_000),
            // Two minutes later, but after midnight: a new day.
            sender('$b3', day + 11 * 60_000),
            // A minute later, but the first unread message.
            sender('$b4', day + 12 * 60_000),
            sender('$b5', day + 13 * 60_000)
          ],
          { readMarkerEventId: '$b3' }
        )
      )

      // Each break ends the run before it (a face) and opens a new one (a name).
      for (const id of ['$b1', '$b2', '$b3']) {
        expect(root(id).querySelector('[data-matrix-sender]')?.textContent, id).toBe('Linh')
        expect(root(id).querySelector('[data-matrix-avatar]')?.getAttribute('data-matrix-avatar'), id).toBe(linh.userId)
      }

      expect(root('$b4').querySelector('[data-team-space-new-messages]')).toBeTruthy()
      expect(root('$b4').querySelector('[data-matrix-sender]')?.textContent).toBe('Linh')
      expect(root('$b4').querySelector('[data-matrix-avatar]')).toBeNull()
      expect(root('$b5').querySelector('[data-matrix-sender]')).toBeNull()
      expect(root('$b5').querySelector('[data-matrix-avatar]')?.getAttribute('data-matrix-avatar')).toBe(linh.userId)
    })

    it('draws an app in a group with its squircle face from the catalog', async () => {
      const moon = {
        app: 'moon',
        app_id: '00000000-0000-4000-8000-11e594f48195',
        app_version_id: '00000000-0000-4000-8000-e79acd97ac88',
        name: { en: 'Moon' },
        subtitle: null,
        description: null,
        icon: null,
        accent: '#E8743B',
        affiliation: 'first_party',
        verified: true,
        verification: 'official',
        availability: 'available',
        roster_default: true,
        roster_order: 0,
        supported_modes: [],
        matrix_room_context: 'addressed_only',
        has_surface: true,
        link: { mode: 'external_account', state: 'linked' },
        bot: {
          v: 1,
          user_id: '@app-moon:test',
          handle: 'moon_bot',
          display_name: 'Moon',
          avatar: { url: '', sha256: 'a'.repeat(64) },
          device_generation: 1,
          device: { device_id: 'MOON_1', ed25519: 'a'.repeat(43), curve25519: 'b'.repeat(43) },
          state: 'active',
          groups: true,
          consent: 'accepted',
          disclosure_version: 1,
          open_route_id: 'chat',
          open_shared_memory: true,
          purchase_route_id: 'chat'
        }
      } satisfies AppDescriptor

      await openChat(
        groupChat([message('$m1', { own: false, sender: moon.bot.user_id, body: 'A good day for it.', timestamp: 1_000 })], {
          apps: { state: 'ready', apps: [moon], connections: {} },
          members: [...people, { userId: moon.bot.user_id, name: 'Moon', membership: 'join', canRemove: false }]
        })
      )

      const face = root('$m1').querySelector<HTMLElement>('[data-matrix-avatar] > *')!
      expect(face.getAttribute('data-face')).toBe('app')
      expect(face.classList.contains('atum-avatar')).toBe(true)
    })

    // One-to-one chats look and behave the same whoever is on the other side: no face, no face
    // Preserve user-visible identity, state and recovery behavior across connection changes.
    it.each([
      ['a person', { direct: true }],
      ['an app', { appBot: { appId: '00000000-0000-4000-8000-11e594f48195', botUserId: linh.userId } }]
    ] as const)('shows no face, gutter or name in a one-to-one chat with %s', async (_kind, kind) => {
      const room = {
        id: '!one:test',
        name: 'Linh',
        membership: 'join',
        encrypted: true,
        ...kind,
        participants: [
          { userId: owner.userId, membership: 'join' },
          { userId: linh.userId, membership: 'join' }
        ]
      }

      await openChat({
        ...ready,
        rooms: [...ready.rooms, room],
        roomId: room.id,
        members: people,
        messages: [
          message('$d1', { own: false, sender: linh.userId, body: 'Dinner Saturday?', timestamp: 1_000 }),
          message('$d2', { own: false, sender: linh.userId, body: '7pm?', timestamp: 2_000 })
        ]
      })

      for (const id of ['$d1', '$d2']) {
        expect(root(id).querySelector('.matrix-chat-bubble'), id).toBeTruthy()
        expect(root(id).querySelector('[data-matrix-face-gutter]'), id).toBeNull()
        expect(root(id).querySelector('[data-matrix-sender]'), id).toBeNull()
      }
    })

    it('draws your assistant answers as left bubbles too, with no face or name in its own chat', async () => {
      const { view } = await openChat()
      const answer = view.container.querySelector<HTMLElement>('[data-matrix-message-id="$a"]')!

      expect(answer.querySelector('.matrix-chat-bubble')).toBeTruthy()
      expect(answer.querySelector('[data-matrix-face-gutter]')).toBeNull()
      expect(answer.querySelector('[data-matrix-sender]')).toBeNull()
    })

    it('stacks at most three reader faces and folds the rest into a count', async () => {
      const readers = ['@linh:test', '@quan:test', '@lan:test', '@my:test']
      await openChat(
        groupChat([message('$g1', { sent: true, readBy: readers })], {
          members: [
            { userId: owner.userId, name: 'Owner', membership: 'join', canRemove: false },
            { userId: '@linh:test', name: 'Linh', membership: 'join', canRemove: false },
            { userId: '@quan:test', name: 'Quân', membership: 'join', canRemove: false },
            { userId: '@lan:test', name: 'Lan', membership: 'join', canRemove: false },
            { userId: '@my:test', name: 'My', membership: 'join', canRemove: false }
          ]
        })
      )

      expect(root('$g1').querySelectorAll('[data-matrix-reader-avatar]')).toHaveLength(3)

      for (const reader of root('$g1').querySelectorAll('[data-matrix-reader-avatar] > *')) {
        expect(reader.classList.contains('atum-avatar')).toBe(true)
        expect([...reader.classList].some(name => name.startsWith('ring'))).toBe(false)
      }

      expect(root('$g1').querySelector('[data-matrix-seen-more]')?.textContent).toBe('+1')
      expect(root('$g1').querySelector('[data-matrix-seen]')?.getAttribute('aria-label')).toBe('Seen by 4')
    })
  })
})

// Owner report on 0.19.1 (2026-10-08): the rail's Store took two clicks (the first jumped back to
// Home), and Drive jumped back to the page before it. Main is played as it runs: the launch
// restores the last chat, and every accepted navigation and every sync is a fresh snapshot.
describe('the rail goes where it is clicked, the first time', () => {
  const owner = { userId: '@owner:test', deviceId: 'DEVICE' }
  const plate = () => window.document.querySelector('[data-slot="matrix-startup"]')
  const rail = () => screen.getByRole('navigation', { name: 'Main navigation' })
  const place = (name: string) => within(rail()).getByRole('button', { name }).getAttribute('aria-current')

  const assistantRoom = {
    ...assistantFields,
    id: '!assistant:test',
    name: 'Atum',
    membership: 'join' as const,
    encrypted: true,
    direct: true,
    assistant: true,
    agentPrincipal: 'agent-atum'
  }

  // The window as main restores it at launch: the last chat already open, the Store's catalog in.
  const restored: MatrixSnapshot = {
    ...signedOut,
    state: 'ready',
    identity: owner,
    assistant: { userId: '@atum:test', deviceId: 'ATUM' },
    domainEnabled: true,
    hermes: 'ready',
    assistantPath: 'local',
    readiness: { phase: 'ready', since: 1 },
    roomId: assistantRoom.id,
    destination: { kind: 'room', roomId: assistantRoom.id },
    rooms: [assistantRoom],
    apps: { state: 'ready', apps: [], connections: {} },
    agents: [
      {
        principal: 'agent-atum',
        userId: '@atum:test',
        name: 'Atum',
        isDefault: true,
        ready: true,
        hermes: 'ready',
        atumModel: true
      }
    ]
  }

  function readyDrive(): MatrixDriveBridge {
    const view: MatrixDriveView = { state: 'ready', revision: 3, rows: [], canGoBack: false, truncated: false }

    return {
      read: vi.fn(async () => view),
      subscribe: vi.fn(() => vi.fn()),
      taskStatus: vi.fn(async () => ({ state: 'ready' as const }))
    } as unknown as MatrixDriveBridge
  }

  /** A launch the startup screen covered, ending in the restored chat; main answers navigation. */
  async function launch(
    options: {
      drive?: MatrixDriveBridge
      pages?: MatrixPagesBridge
      companies?: MatrixCompanyBridge
      snapshot?: Partial<MatrixSnapshot>
      /** Main is busy: it takes the Store only once this settles. */
      busy?: Promise<void>
    } = {}
  ) {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const launched: MatrixSnapshot = { ...restored, ...options.snapshot }
    let current = launched

    let emit: (state: MatrixSnapshot) => unknown = () => {}

    // sdk.ts: `discoverApps` leaves the chat for the Store; `select` opens the chat.
    const command = vi.fn(async (input: Parameters<MatrixUiBridge['command']>[0]) => {
      await Promise.resolve()

      if (input.kind === 'discoverApps') {
        await options.busy
        current = { ...current, roomId: null, destination: { kind: 'discover' } }
        emit(current)
      } else if (input.kind === 'select') {
        current = { ...current, roomId: input.roomId, destination: { kind: 'room', roomId: input.roomId } }
        emit(current)
      }

      return null
    })

    const harness = fixture(
      async () => ({ ...launched, readiness: { phase: 'starting', step: 'signed_in', since: Date.now() } }),
      'en',
      options.pages,
      command,
      options.drive,
      options.companies
    )

    await waitFor(() => expect(plate()?.textContent).toContain('Signing you in…'))
    emit = harness.emit
    emit(launched)
    await passLaunch()
    await waitFor(() => expect(plate()).toBeNull(), LAUNCH_OPENS)
    await screen.findByRole('textbox', { name: COMPOSER })
    command.mockClear()

    return {
      ...harness,
      command,
      // Any sync, receipt or wallet change: the same place, as a new snapshot object.
      sync: () => emit({ ...current, destination: current.destination ? { ...current.destination } : null })
    }
  }

  /** Lets main's answers and the effects they start run out. */
  const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(50)))

  it('opens the Store on the first click after a launch that restored a chat', async () => {
    const { command } = await launch()

    fireEvent.click(within(rail()).getByRole('button', { name: 'Store' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'discoverApps' }))
    await settle()

    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'select' }))
    expect(place('Store')).toBe('page')
    expect(place('Chats')).toBeNull()
    expect(screen.queryByRole('textbox', { name: COMPOSER })).toBeNull()

    // Home is still one click back to the chat.
    fireEvent.click(within(rail()).getByRole('button', { name: 'Chats' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: assistantRoom.id }))
    await settle()
    expect(place('Chats')).toBe('page')
  })

  it('opens Drive on the first click from Home and keeps it there as snapshots arrive', async () => {
    const { sync } = await launch({ drive: readyDrive() })

    fireEvent.click(await within(rail()).findByRole('button', { name: 'Atum Drive' }))
    await settle()
    sync()
    await settle()

    expect(place('Atum Drive')).toBe('page')
    expect(window.document.querySelector('[data-matrix-drive]')).toBeTruthy()
  })

  it('opens Drive on the first click from the Store and keeps it there as snapshots arrive', async () => {
    const { command, sync } = await launch({ drive: readyDrive() })

    fireEvent.click(within(rail()).getByRole('button', { name: 'Store' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'discoverApps' }))
    await settle()
    expect(place('Store')).toBe('page')

    fireEvent.click(await within(rail()).findByRole('button', { name: 'Atum Drive' }))
    await settle()
    expect(place('Atum Drive')).toBe('page')
    // The next sync repeats "the Store" as a new snapshot; Drive stays in front of it.
    sync()
    await settle()

    expect(place('Atum Drive')).toBe('page')
    expect(place('Store')).toBeNull()
    expect(window.document.querySelector('[data-matrix-drive]')).toBeTruthy()

    // The Store is one click back, and shows again.
    fireEvent.click(within(rail()).getByRole('button', { name: 'Store' }))
    await settle()
    expect(place('Store')).toBe('page')
    expect(window.document.querySelector('[data-matrix-drive]')).toBeNull()
  })

  it('opens Team Space on the first click from the Store and keeps it there as snapshots arrive', async () => {
    const { command, sync } = await launch({
      pages: workplacePages(),
      companies: companyWorkspace(),
      snapshot: { companyWorkspaceEnabled: true }
    })

    fireEvent.click(within(rail()).getByRole('button', { name: 'Store' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'discoverApps' }))
    await settle()
    expect(place('Store')).toBe('page')

    fireEvent.click(within(rail()).getByRole('button', { name: 'Team space' }))
    await settle()
    expect(place('Team space')).toBe('page')
    sync()
    await settle()

    expect(place('Team space')).toBe('page')
    expect(window.document.querySelector('[data-matrix-company-workspace]')).toBeTruthy()
    expect(window.document.querySelector('[data-matrix-workplace]')).toBeNull()
  })

  it('keeps Drive when it is picked while main is still answering the Store', async () => {
    let answer!: () => void
    const { command } = await launch({ drive: readyDrive(), busy: new Promise(resolve => (answer = resolve)) })

    fireEvent.click(within(rail()).getByRole('button', { name: 'Store' }))
    fireEvent.click(await within(rail()).findByRole('button', { name: 'Atum Drive' }))
    await act(async () => answer())
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'discoverApps' }))
    await settle()

    expect(place('Atum Drive')).toBe('page')
    expect(window.document.querySelector('[data-matrix-drive]')).toBeTruthy()
  })

  it("keeps a Store listing's Skills Hub open while snapshots arrive, and still comes back to the Store", async () => {
    const pages = workplacePages()
    const { command, sync } = await launch({ pages })

    fireEvent.click(within(rail()).getByRole('button', { name: 'Store' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'discoverApps' }))
    await settle()

    act(() => $matrixStoreHubRequest.set(hubSkillRequest(HUB_INSTALL, 'agent-atum')))
    await waitFor(() => expect(pages.open).toHaveBeenCalledWith(expect.objectContaining({ page: 'skills' })))
    sync()
    await settle()

    expect(pages.close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Back to the Store' }))
    await waitFor(() => expect(pages.close).toHaveBeenCalled())
    expect(place('Store')).toBe('page')
    $matrixStoreShelfRequest.set(null)
  })

  it.each([
    ['the assistant card', () => $matrixStoreShelfRequest.set('pets')],
    ['a top-up', () => $matrixStoreShelfRequest.set('topups')]
  ])('still brings the Store to the front over Drive when %s asks for it', async (_, shelf) => {
    const { sync } = await launch({ drive: readyDrive() })

    fireEvent.click(within(rail()).getByRole('button', { name: 'Store' }))
    await settle()
    fireEvent.click(await within(rail()).findByRole('button', { name: 'Atum Drive' }))
    await settle()
    expect(place('Atum Drive')).toBe('page')

    // Another surface asks main for the Store, which it already is underneath Drive.
    act(shelf)
    await act(async () => void (await runMatrixCommand({ kind: 'discoverApps' })))
    sync()
    await settle()

    expect(place('Store')).toBe('page')
    expect(window.document.querySelector('[data-matrix-drive]')).toBeNull()
    $matrixStoreShelfRequest.set(null)
  })
})

describe('Company AI honesty and Turn into task in a company channel', () => {
  const COS = '@chief-of-staff:atum.example'
  const MANAGER = '@atum-team-space:atum.example'
  // A real company id: a message link (and so a task's source) is built only from one.
  const COMPANY = '00000000-0000-4000-8000-24ec437dbdf3'
  const PRIVATE_ROOM = '!private-cos:test'
  const MEMBER_PRINCIPAL = '00000000-0000-4000-8000-7acf30c68b5e'
  const INCARNATION = '00000000-0000-4000-8000-2003d0eebf32'
  const EXECUTOR = '00000000-0000-4000-8000-8d9d536cf024'

  const binding = {
    companyId: COMPANY,
    channelId: '00000000-0000-4000-8000-676a3a34ff0f',
    managerUserId: MANAGER
  }

  const aiView = (over: Partial<CompanyAIView> = {}): CompanyAIView => ({
    schemaVersion: 1,
    companyId: COMPANY,
    agent: { principal: '00000000-0000-4000-8000-9896148e0625', userId: COS, displayName: 'Chief of Staff' },
    enabled: true,
    revision: 1,
    state: 'ready',
    canManage: true,
    ...over
  })

  const message = (id: string, body: string, over: Partial<MatrixSnapshot['messages'][number]> = {}) => ({
    id, sender: '@linh:test', body, timestamp: 10, own: false, encrypted: false, decryptionFailed: false,
    pending: false, failed: false, attachment: false, ...over
  })

  const privateCapability: MatrixCompanyPrivateCosCapabilityV13 = {
    schemaVersion: 4,
    profile: 'atum.company-private-cos/1.3',
    capability: 'company.private-cos',
    supportedProfiles: [
      'atum.company-private-cos/1',
      'atum.company-private-cos/1.1',
      'atum.company-private-cos/1.2',
      'atum.company-private-cos/1.3'
    ],
    wire: { header: 'Atum-Company-Wire', value: '1.3' },
    displayName: 'Chief of Staff',
    teamDmPosition: 2,
    lazyCreation: true,
    fundingKind: 'company_wallet',
    separatePrice: false,
    purgeAfterDays: 30,
    userExport: false,
    roomType: MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE,
    roomName: 'Chief of Staff',
    roomEncrypted: false,
    greetingVersion: 2,
    ensureLocale: true
  }

  const privateView: MatrixCompanyPrivateCosView = {
    schemaVersion: 1,
    state: 'ready',
    pair: {
      companyPrincipal: COMPANY,
      memberPrincipal: MEMBER_PRINCIPAL,
      membershipIncarnation: INCARNATION
    },
    greetingState: 'published',
    binding: {
      scope: {
        pair: {
          companyPrincipal: COMPANY,
          memberPrincipal: MEMBER_PRINCIPAL,
          membershipIncarnation: INCARNATION
        },
        authorityEpoch: 1,
        contextEpoch: 1,
        homeGeneration: 1
      },
      agentPrincipal: '00000000-0000-4000-8000-c24048d7f808',
      agentUserId: COS,
      executorId: EXECUTOR,
      homeId: '00000000-0000-4000-8000-3d2ed3af722e',
      roomId: PRIVATE_ROOM,
      storeGeneration: 1,
      profileDigest: 'a'.repeat(64)
    }
  }

  const privateRoom: MatrixRoom = {
    id: PRIVATE_ROOM,
    name: 'Chief of Staff',
    membership: 'join',
    encrypted: false,
    roomType: MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE,
    roomVersion: '11',
    companyPrivateCos: {
      v: 1,
      classification: 'company_private_cos',
      companyId: COMPANY,
      membershipIncarnation: INCARNATION,
      executorId: EXECUTOR
    },
    joinRule: 'invite',
    historyVisibility: 'joined',
    participants: [
      { userId: '@owner:test', membership: 'join' },
      { userId: COS, membership: 'join' }
    ],
    powerLevels: {
      users: { '@manager:test': 100, '@owner:test': 0, [COS]: 0 },
      users_default: 0,
      events_default: 0,
      state_default: 100,
      invite: 100,
      kick: 100,
      ban: 100,
      redact: 100,
      events: {}
    }
  }

  beforeEach(() => {
    $companyAIStatuses.set({})
    $companySpacePreferences.set({})
    clearCompanyPrivateCos('@owner:test:OWNER')
    // The window's company turn memory lives for the session; each test starts a new one.
    companyTurnMemory('@owner:test:OWNER').ended.clear()
    companyTurnMemory('@owner:test:OWNER').lines.clear()
  })

  async function openChannel(view: CompanyAIView, extra: Partial<MatrixSnapshot> = {}, role: 'admin' | 'member' = 'admin') {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const adapter = playgroundCompanyDesktopAdapter()
    const companyDesktop = { ...adapter, readAI: vi.fn(async () => view), commandBoard: vi.fn(adapter.commandBoard) }
    const command = vi.fn(async () => null)

    const { emit, view: rendered } = fixture(undefined, 'en', undefined, command, undefined,
      companyWorkspaceWithChannel('!launch:test', undefined, COMPANY, role), undefined, { companyDesktop })

    await screen.findByRole('button', { name: 'Continue with Google' })

    const snapshot: MatrixSnapshot = {
      ...signedOut, state: 'ready', identity: { userId: '@owner:test', deviceId: 'OWNER' },
      companyWorkspaceEnabled: true, roomId: '!launch:test',
      rooms: [{
        id: '!launch:test', name: 'launch', membership: 'join', encrypted: false, roomType: MATRIX_COMPANY_CHANNEL_TYPE,
        companyChannel: binding,
        participants: [
          { userId: '@owner:test', membership: 'join' },
          { userId: '@linh:test', membership: 'join' },
          { userId: COS, membership: 'join' }
        ]
      }],
      members: [
        { userId: '@owner:test', name: 'You', membership: 'join', canRemove: false },
        { userId: '@linh:test', name: 'Linh', membership: 'join', canRemove: false },
        { userId: COS, name: 'Chief of Staff', membership: 'join', canRemove: false },
        { userId: MANAGER, name: 'Atum Team Space', membership: 'join', canRemove: false }
      ],
      messages: [message('$quote', 'Send the quote before Friday')],
      ...extra
    }

    emit(snapshot)

    const composer = await screen.findByRole('textbox', { name: COMPOSER })
    await waitFor(() => expect(companyDesktop.readAI).toHaveBeenCalledWith(COMPANY))

    return { command, companyDesktop, composer, emit, snapshot, view: rendered }
  }

  it('inserts and sends a ready Chief of Staff as a real Matrix mention pill', async () => {
    const { command, composer, view } = await openChannel(aiView())

    fireEvent.change(composer, { target: { value: 'Ask @Chi' } })
    fireEvent.click(await screen.findByRole('option', { name: /Chief of Staff/ }))
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe('Ask @Chief of Staff '))
    expect(window.document.querySelector('[data-company-ai-mention-state]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({
      kind: 'send', roomId: '!launch:test', body: 'Ask @Chief of Staff ', mentions: [COS]
    }))
    await waitFor(() => expect(
      [...view.container.querySelectorAll<HTMLElement>('[data-matrix-mention-pill]')]
        .some(pill => pill.textContent === '@Chief of Staff')
    ).toBe(true))
  })

  it('never offers the create-event-declared room manager as a person mention', async () => {
    const { composer } = await openChannel(aiView())

    fireEvent.change(composer, { target: { value: 'Ask @Atum Team' } })
    expect(screen.queryByRole('option', { name: /Atum Team Space/ })).toBeNull()
  })

  it('shows a Chief of Staff that is being set up as one line, never a target', async () => {
    const { composer } = await openChannel(aiView({ state: 'preparing' }))

    fireEvent.change(composer, { target: { value: 'Ask @Chi' } })

    const notice = await waitFor(() => {
      const found = window.document.querySelector<HTMLElement>('[data-company-ai-mention-state="preparing"]')
      expect(found).toBeTruthy()

      return found!
    })

    expect(within(notice).getByText('Not available yet')).toBeTruthy()
    expect(screen.queryByRole('option', { name: /Chief of Staff/ })).toBeNull()
  })

  async function statusThread(
    role: 'admin' | 'member',
    body: string,
    over: Partial<MatrixSnapshot['messages'][number]> = {}
  ) {
    const root = message('$ask', '@Chief of Staff summarise this', { sender: '@owner:test', own: true })

    const status = message('$status', body, {
      sender: COS, thread: true, threadRootId: '$ask', replyTo: '$ask', timestamp: 20, ...over
    })

    // The view says this account manages the Chief of Staff either way: only the workspace's wallet gate decides.
    const { view } = await openChannel(aiView({ canManage: true }), {
      messages: [root],
      threads: [{
        root, replies: [status], participantIds: ['@owner:test', COS], replyCount: 1, lastActivityAt: 20,
        unread: false, highlights: 0, followed: true
      }]
    }, role)

    const conversationOptions = await screen.findByRole('button', { name: 'Conversation options' })
    fireEvent.keyDown(conversationOptions, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open threads' }))
    const panel = view.container.querySelector<HTMLElement>('[data-matrix-thread-panel]')!
    fireEvent.click(within(panel).getByRole('button', { name: /summarise this/ }))

    return { panel, view }
  }

  async function unfundedThread(role: 'admin' | 'member') {
    const { view } = await statusThread(role, 'Company AI needs Protons.')

    const line = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>('[data-company-ai-status="unfunded"]')
      expect(found).toBeTruthy()

      return found!
    })

    return { line, view }
  }

  it('draws nothing for the uncertain “couldn’t confirm” reply, in the thread or anywhere else', async () => {
    const { view } = await statusThread('admin', "Company AI couldn't confirm this answer.")

    await waitFor(() =>
      expect(view.container.querySelector('[data-matrix-thread-panel] [data-matrix-message-id="$ask"]')).toBeTruthy()
    )
    expect(view.container.querySelector('[data-matrix-message-id="$status"]')).toBeNull()
    expect(view.container.querySelector('[data-company-ai-status]')).toBeNull()
    expect(view.container.textContent).not.toMatch(/couldn.t confirm/i)
  })

  it('keeps a Chief of Staff answer in the thread even when its text matches the frozen sentence', async () => {
    const answer = { ...COMPANY_AI_ANSWER_FIXTURE, companyId: COMPANY, channelId: binding.channelId, threadRootEventId: '$ask' }

    const { view } = await statusThread('admin', "Company AI couldn't confirm this answer.", {
      companyAIAnswer: answer
    } as Partial<MatrixSnapshot['messages'][number]>)

    const reply = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>('[data-matrix-thread-panel] [data-matrix-message-id="$status"]')
      expect(found).toBeTruthy()

      return found!
    })

    expect(reply.querySelector('[data-company-ai-answer]')).toBeTruthy()
    expect(view.container.querySelector('[data-company-ai-status]')).toBeNull()
  })

  it('offers an empty channel a welcome draft the Chief of Staff can write, filling the box without sending', async () => {
    const { command, composer } = await openChannel(aiView(), { messages: [] })

    fireEvent.click(await screen.findByRole('button', { name: 'Ask Chief of Staff' }))
    await waitFor(() =>
      expect((composer as HTMLTextAreaElement).value).toBe('@Chief of Staff draft a short welcome message for this channel')
    )
    expect((composer as HTMLTextAreaElement).value).not.toMatch(/pin/i)
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'send' }))
  })

  it('says “needs Protons” in a thread in the reader’s words, and Top up opens the company wallet', async () => {
    const { line, view } = await unfundedThread('admin')

    expect(line.textContent).toContain('Chief of Staff needs Protons to answer.')
    const topUp = await within(line).findByRole('button', { name: 'Top up' })
    fireEvent.click(topUp)
    await waitFor(() => expect(view.container.querySelector('[data-company-wallet]')).toBeTruthy())
  })

  it('offers no Top up the workspace would not honour; it says who can top up instead', async () => {
    const { line, view } = await unfundedThread('member')

    await waitFor(() => expect(line.textContent).toContain('Ask the company owner to top up.'))
    expect(within(line).queryByRole('button', { name: 'Top up' })).toBeNull()
    expect(view.container.querySelector('[data-company-wallet]')).toBeNull()
  })

  async function unfundedPrivateCos(
    role: 'admin' | 'member',
    locale: 'en' | 'vi' = 'en'
  ) {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const adapter = playgroundCompanyDesktopAdapter(role === 'member')

    const companyDesktop = {
      ...adapter,
      readPrivateCosCapability: vi.fn(async () => privateCapability),
      readPrivateCos: vi.fn(async () => privateView),
      ensurePrivateCos: vi.fn(async () => privateView),
      readPrivateCosReceipt: vi.fn(async () => {throw new Error('not used')}),
      stopPrivateCos: vi.fn(async () => {throw new Error('not used')})
    }

    const command = vi.fn(async () => null)

    const { emit, view } = fixture(
      undefined,
      locale,
      undefined,
      command,
      undefined,
      companyWorkspaceWithChannel('!launch:test', undefined, COMPANY, role),
      undefined,
      { companyDesktop }
    )

    await screen.findByRole('button', { name: /Google/ })
    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'OWNER' },
      companyWorkspaceEnabled: true,
      roomId: PRIVATE_ROOM,
      rooms: [privateRoom],
      members: [
        { userId: '@owner:test', name: 'You', membership: 'join', canRemove: false },
        { userId: COS, name: 'Chief of Staff', membership: 'join', canRemove: false }
      ],
      messages: [message('$private-status', 'Company AI needs Protons.', { sender: COS })]
    })

    const line = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>('[data-company-ai-status="unfunded"]')
      expect(found).toBeTruthy()

      return found!
    })

    return { line, view }
  }

  it('turns the bound private agent’s empty-wallet line into the owner’s translated Top up action', async () => {
    const { line, view } = await unfundedPrivateCos('admin')

    expect(line.textContent).toContain('Chief of Staff needs Protons to answer.')
    fireEvent.click(await within(line).findByRole('button', { name: 'Top up' }))
    await waitFor(() => expect(view.container.querySelector('[data-company-wallet]')).toBeTruthy())
  })

  it('turns the bound private agent’s empty-wallet line into translated owner guidance for a member', async () => {
    const { line, view } = await unfundedPrivateCos('member', 'vi')

    expect(line.textContent).toBe('Chief of Staff cần thêm Proton để trả lời. Nhờ chủ công ty nạp thêm Proton.')
    expect(line.textContent).not.toContain('Company AI needs Protons.')
    expect(within(line).queryByRole('button')).toBeNull()
    expect(view.container.querySelector('[data-company-wallet]')).toBeNull()
  })

  // agent-turns/1.6: the company agent's working line and interim remarks, drawn as a personal agent's.
  const TURN_TASK = 'c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f'
  const TURN_INVOCATION = 'd4e5f6a7-b8c9-4d0e-9f2a-3b4c5d6e7f8a'

  const companyTurn = (audience: MatrixCompanyAudience, roomId: string, agentPrincipal: string, rootId: string): MatrixCompanyPresentation => ({
    companyId: COMPANY,
    agentPrincipal,
    audience,
    roomId,
    threadRootEventId: rootId,
    taskId: TURN_TASK,
    invocationId: TURN_INVOCATION,
    revision: 0,
    triggerEventId: rootId
  })

  const companyLine = (id: string, body: string, turn: ReturnType<typeof companyTurn>, over = {}) =>
    message(id, body, {
      sender: COS, notice: true, timestamp: 20,
      progress: { profile: 'atum.agent-turns/1.6', scope: 'company', phase: 'working', kind: 'todo', revision: 0 },
      company: turn,
      ...over
    })

  const companyRemark = (id: string, body: string, turn: ReturnType<typeof companyTurn>, over = {}) =>
    message(id, body, {
      sender: COS, interim: true, timestamp: 15, company: turn,
      ...over
    })

  async function companyProgressThread(replies: MatrixSnapshot['messages'], view = aiView()) {
    const root = message('$ask', '@Chief of Staff summarise this', { sender: '@owner:test', own: true })
    const threaded = replies.map(reply => ({ ...reply, thread: true as const, threadRootId: '$ask', replyTo: '$ask' }))

    const opened = await openChannel(view, {
      messages: [root],
      threads: [{
        root, replies: threaded, participantIds: ['@owner:test', COS], replyCount: threaded.length, lastActivityAt: 20,
        unread: false, highlights: 0, followed: true
      }]
    })

    const rendered = opened.view

    const conversationOptions = await screen.findByRole('button', { name: 'Conversation options' })
    fireEvent.keyDown(conversationOptions, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open threads' }))
    const panel = rendered.container.querySelector<HTMLElement>('[data-matrix-thread-panel]')!
    fireEvent.click(within(panel).getByRole('button', { name: /summarise this/ }))
    await waitFor(() => expect(panel.querySelector('[data-matrix-message-id="$ask"]')).toBeTruthy())

    return Object.assign(panel, { opened })
  }

  it('shows the Chief of Staff working in a channel thread with its interim remark, as a personal chat does', async () => {
    const turn = companyTurn({ kind: 'channel', channelId: binding.channelId }, '!launch:test', aiView().agent.principal, '$ask')

    const panel = await companyProgressThread([
      companyRemark('$remark', 'Let me check the board first.', turn),
      companyLine('$line', 'Reading the board.', turn)
    ])

    const working = await waitFor(() => {
      const found = panel.querySelector<HTMLElement>('[data-matrix-agent-working]')
      expect(found).toBeTruthy()

      return found!
    })

    expect(working.getAttribute('aria-label')).toBe('Chief of Staff is typing…')
    expect(working.querySelector('[data-matrix-progress-line]')?.textContent).toBe('Reading the board.')
    // The line is the transient row only; the remark is a real message of the thread.
    expect(panel.querySelector('[data-matrix-message-id="$line"]')).toBeNull()
    expect(panel.querySelector('[data-matrix-message-id="$remark"]')?.textContent).toContain('Let me check the board first.')
  })

  it('clears the channel line only when its own turn settles, and never draws one that is not the bound agent', async () => {
    const turn = companyTurn({ kind: 'channel', channelId: binding.channelId }, '!launch:test', aiView().agent.principal, '$ask')

    // An answer of the agent to another task in this thread (it names no trigger) leaves this line.
    const unrelated = await companyProgressThread([
      companyRemark('$remark', 'Let me check the board first.', turn),
      companyLine('$line', 'Reading the board.', turn, { timestamp: 18 }),
      message('$answer', 'Here is the other summary.', { sender: COS, timestamp: 30 })
    ])

    await waitFor(() => expect(unrelated.querySelector('[data-matrix-message-id="$answer"]')).toBeTruthy())
    expect(unrelated.querySelector('[data-matrix-progress-line]')?.textContent).toBe('Reading the board.')
    cleanup()

    const settled = await companyProgressThread([
      companyRemark('$remark', 'Let me check the board first.', turn),
      companyLine('$line', 'Done.', turn, {
        timestamp: 18,
        progress: { profile: 'atum.agent-turns/1.6', scope: 'company', phase: 'settled', kind: 'settled', revision: 3 }
      }),
      message('$answer', 'Here is the summary.', { sender: COS, timestamp: 30 })
    ])

    await waitFor(() => expect(settled.querySelector('[data-matrix-message-id="$answer"]')).toBeTruthy())
    expect(settled.querySelector('[data-matrix-agent-working]')).toBeNull()
    expect(settled.querySelector('[data-matrix-message-id="$line"]')).toBeNull()
    expect(settled.querySelector('[data-matrix-message-id="$remark"]')).toBeTruthy()
    cleanup()

    // Another principal in the marker, or another sender: the standard notice, never a working line.
    const stranger = await companyProgressThread([
      companyLine('$forged', 'Reading the board.', { ...turn, agentPrincipal: MEMBER_PRINCIPAL }),
      companyLine('$member', 'Also reading.', turn, { sender: '@linh:test', timestamp: 21 })
    ])

    await waitFor(() => expect(stranger.querySelector('[data-matrix-message-id="$forged"]')).toBeTruthy())
    expect(stranger.querySelector('[data-matrix-message-id="$member"]')).toBeTruthy()
    expect(stranger.querySelector('[data-matrix-agent-working]')).toBeNull()
  })

  it('stops drawing the old agent’s line once the channel is reassigned, and draws none while the binding is changing', async () => {
    const NEXT = '@cos-next:test'
    const turn = companyTurn({ kind: 'channel', channelId: binding.channelId }, '!launch:test', aiView().agent.principal, '$ask')
    const reassigned = aiView({ revision: 2, agent: { principal: MEMBER_PRINCIPAL, userId: NEXT, displayName: 'Chief of Staff' } })
    let answer: (view: CompanyAIView) => void = () => undefined

    const panel = await companyProgressThread([companyLine('$line', 'Reading the board.', turn)])

    await waitFor(() => expect(panel.querySelector('[data-matrix-progress-line]')?.textContent).toBe('Reading the board.'))

    // The platform now names another agent; the old one stays a member. The new one joining is the change.
    const { companyDesktop, emit, snapshot } = panel.opened

    companyDesktop.readAI.mockImplementation(() => new Promise<CompanyAIView>(resolve => {
      answer = resolve
    }))
    emit({
      ...snapshot,
      rooms: snapshot.rooms.map(room => ({
        ...room,
        participants: [...(room.participants ?? []), { userId: NEXT, membership: 'join' }]
      }))
    })

    // Until the fresh read answers, the old agent's line is the standard message, not a working line.
    await waitFor(() => expect(panel.querySelector('[data-matrix-agent-working]')).toBeNull())
    expect(panel.querySelector('[data-matrix-message-id="$line"]')?.textContent).toContain('Reading the board.')

    await act(async () => answer(reassigned))
    expect(panel.querySelector('[data-matrix-agent-working]')).toBeNull()
    expect(panel.querySelector('[data-matrix-message-id="$line"]')).toBeTruthy()
  })

  it('refreshes at once when a marker comes from an agent no view has bound, with both agents joined, and fails closed until it answers', async () => {
    const NEXT = '@cos-next:test'
    const turn = companyTurn({ kind: 'channel', channelId: binding.channelId }, '!launch:test', aiView().agent.principal, '$ask')
    const nextTurn = { ...turn, agentPrincipal: MEMBER_PRINCIPAL, invocationId: '00000000-0000-4000-8000-0e1f2a3b4c5d' }
    const reassigned = aiView({ revision: 2, agent: { principal: MEMBER_PRINCIPAL, userId: NEXT, displayName: 'Chief of Staff' } })
    let answer: (view: CompanyAIView) => void = () => undefined

    const panel = await companyProgressThread([companyLine('$line', 'Reading the board.', turn)])
    const { companyDesktop, emit, snapshot } = panel.opened

    // Both agents are already channel members: no membership change will follow the reassignment.
    const joined: MatrixSnapshot = {
      ...snapshot,
      rooms: snapshot.rooms.map(room => ({
        ...room,
        participants: [...(room.participants ?? []), { userId: NEXT, membership: 'join' }]
      }))
    }

    emit(joined)
    await waitFor(() => expect(panel.querySelector('[data-matrix-progress-line]')?.textContent).toBe('Reading the board.'))
    const reads = companyDesktop.readAI.mock.calls.length

    companyDesktop.readAI.mockImplementation(() => new Promise<CompanyAIView>(resolve => {
      answer = resolve
    }))

    const thread = joined.threads![0]!

    const nextLine = {
      ...companyLine('$next', 'Planning the launch.', nextTurn, { sender: NEXT, timestamp: 30 }),
      thread: true as const, threadRootId: '$ask', replyTo: '$ask'
    }

    emit({ ...joined, threads: [{ ...thread, replies: [...thread.replies, nextLine], replyCount: 2, lastActivityAt: 30 }] })

    // The stranger's marker asks the platform again at once, and until it answers no line is drawn as one.
    await waitFor(() => expect(companyDesktop.readAI.mock.calls.length).toBeGreaterThan(reads))
    await waitFor(() => expect(panel.querySelector('[data-matrix-agent-working]')).toBeNull())
    expect(panel.querySelector('[data-matrix-message-id="$line"]')?.textContent).toContain('Reading the board.')

    // The platform names the new agent: its line is the working line; the old one's is a plain message.
    await act(async () => answer(reassigned))
    await waitFor(() => expect(panel.querySelector('[data-matrix-progress-line]')?.textContent).toBe('Planning the launch.'))
    expect(panel.querySelector('[data-matrix-message-id="$line"]')?.textContent).toContain('Reading the board.')
    expect(panel.querySelector('[data-matrix-message-id="$next"]')).toBeNull()
  })

  it('re-reads the channel binding every half minute while markers show, and stops trusting an answer older than a minute', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    const turn = companyTurn({ kind: 'channel', channelId: binding.channelId }, '!launch:test', aiView().agent.principal, '$ask')
    const panel = await companyProgressThread([companyLine('$line', 'Reading the board.', turn)])
    const { companyDesktop } = panel.opened

    await waitFor(() => expect(panel.querySelector('[data-matrix-progress-line]')?.textContent).toBe('Reading the board.'))
    const reads = companyDesktop.readAI.mock.calls.length

    // The quiet re-read answers as before: the line stays drawn throughout.
    await act(async () => void vi.advanceTimersByTime(30_000))
    await waitFor(() => expect(companyDesktop.readAI.mock.calls.length).toBeGreaterThan(reads))
    expect(panel.querySelector('[data-matrix-progress-line]')?.textContent).toBe('Reading the board.')

    // The platform stops answering: the last answer ages out at a minute and the line is no longer drawn.
    companyDesktop.readAI.mockImplementation(() => new Promise<CompanyAIView>(() => undefined))
    await act(async () => void vi.advanceTimersByTime(30_000))
    expect(panel.querySelector('[data-matrix-progress-line]')?.textContent).toBe('Reading the board.')
    await act(async () => void vi.advanceTimersByTime(31_000))
    await waitFor(() => expect(panel.querySelector('[data-matrix-agent-working]')).toBeNull())
    expect(panel.querySelector('[data-matrix-message-id="$line"]')?.textContent).toContain('Reading the board.')
  })

  it('hides a channel line three quiet heartbeats after its newest revision, by a timer, and expired is not done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    const start = Date.now()
    const turn = companyTurn({ kind: 'channel', channelId: binding.channelId }, '!launch:test', aiView().agent.principal, '$ask')

    const panel = await companyProgressThread([
      companyLine('$line', 'Reading the board.', { ...turn, revisedAt: start })
    ])

    const { emit, snapshot } = panel.opened

    await waitFor(() => expect(panel.querySelector('[data-matrix-progress-line]')?.textContent).toBe('Reading the board.'))

    // Nothing arrives: once the newest revision is older than 540000 ms the line is gone, by its own timer.
    await act(async () => void vi.advanceTimersByTime(start + 540_001 - Date.now()))
    await waitFor(() => expect(panel.querySelector('[data-matrix-agent-working]')).toBeNull())
    // Hidden, not finished: no transcript row, and nothing the user could read as done.
    expect(panel.querySelector('[data-matrix-message-id="$line"]')).toBeNull()

    // Expiry never ends the turn: a newer revision of the same tuple shows it again.
    const thread = snapshot.threads![0]!

    const heartbeat = {
      ...companyLine('$line', 'Still reading the board.', { ...turn, revision: 1, revisedAt: Date.now() }, {
        progress: { profile: 'atum.agent-turns/1.6', scope: 'company', phase: 'working', kind: 'heartbeat', revision: 1 }
      }),
      thread: true as const, threadRootId: '$ask', replyTo: '$ask'
    }

    emit({ ...snapshot, threads: [{ ...thread, replies: [heartbeat] }] })
    await waitFor(() => expect(panel.querySelector('[data-matrix-progress-line]')?.textContent).toBe('Still reading the board.'))
  })

  it('hides the private Chief of Staff’s line three quiet heartbeats after its newest revision, never as done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(window.document, 'hasFocus').mockReturnValue(true)

    const adapter = playgroundCompanyDesktopAdapter()

    const companyDesktop = {
      ...adapter,
      readPrivateCosCapability: vi.fn(async () => privateCapability),
      readPrivateCos: vi.fn(async () => privateView),
      ensurePrivateCos: vi.fn(async () => privateView),
      readPrivateCosReceipt: vi.fn(async () => {throw new Error('not used')}),
      stopPrivateCos: vi.fn(async () => {throw new Error('not used')})
    }

    const { emit, view } = fixture(undefined, 'en', undefined, vi.fn(async () => null), undefined,
      companyWorkspaceWithChannel('!launch:test', undefined, COMPANY), undefined, { companyDesktop })

    await screen.findByRole('button', { name: /Google/ })

    const start = Date.now()

    const turn = {
      ...companyTurn(
        { kind: 'private', memberPrincipal: MEMBER_PRINCIPAL, membershipIncarnation: INCARNATION },
        PRIVATE_ROOM,
        privateView.state === 'ready' ? privateView.binding.agentPrincipal : '',
        '$question'
      ),
      revisedAt: start
    }

    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'OWNER' },
      companyWorkspaceEnabled: true,
      roomId: PRIVATE_ROOM,
      rooms: [privateRoom],
      members: [
        { userId: '@owner:test', name: 'You', membership: 'join', canRemove: false },
        { userId: COS, name: 'Chief of Staff', membership: 'join', canRemove: false }
      ],
      messages: [
        message('$question', 'Plan the launch', { sender: '@owner:test', own: true, timestamp: 5 }),
        companyLine('$line', 'Reading the board.', turn)
      ]
    })

    await waitFor(() =>
      expect(view.container.querySelector('[data-matrix-progress-line]')?.textContent).toBe('Reading the board.'))

    await act(async () => void vi.advanceTimersByTime(start + 540_001 - Date.now()))
    await waitFor(() => expect(view.container.querySelector('[data-matrix-agent-working]')).toBeNull())
    // Hidden only: no row for it, and no answer is implied (the question still waits for one).
    expect(view.container.querySelector('[data-matrix-message-id="$line"]')).toBeNull()
    expect(view.container.querySelector('[data-matrix-message-id="$question"]')).toBeTruthy()
  })

  it('shows the private Chief of Staff working in its room, bound to the platform pair', async () => {
    vi.spyOn(window.document, 'hasFocus').mockReturnValue(true)

    const adapter = playgroundCompanyDesktopAdapter()

    const companyDesktop = {
      ...adapter,
      readPrivateCosCapability: vi.fn(async () => privateCapability),
      readPrivateCos: vi.fn(async () => privateView),
      ensurePrivateCos: vi.fn(async () => privateView),
      readPrivateCosReceipt: vi.fn(async () => {throw new Error('not used')}),
      stopPrivateCos: vi.fn(async () => {throw new Error('not used')})
    }

    const { emit, view } = fixture(undefined, 'vi', undefined, vi.fn(async () => null), undefined,
      companyWorkspaceWithChannel('!launch:test', undefined, COMPANY), undefined, { companyDesktop })

    await screen.findByRole('button', { name: /Google/ })

    const turn = companyTurn(
      { kind: 'private', memberPrincipal: MEMBER_PRINCIPAL, membershipIncarnation: INCARNATION },
      PRIVATE_ROOM,
      privateView.state === 'ready' ? privateView.binding.agentPrincipal : '',
      '$question'
    )

    const snapshot: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'OWNER' },
      companyWorkspaceEnabled: true,
      roomId: PRIVATE_ROOM,
      rooms: [privateRoom],
      members: [
        { userId: '@owner:test', name: 'You', membership: 'join', canRemove: false },
        { userId: COS, name: 'Chief of Staff', membership: 'join', canRemove: false }
      ],
      messages: [
        message('$question', 'Plan the launch', { sender: '@owner:test', own: true, timestamp: 5 }),
        companyRemark('$remark', 'Để mình xem bảng công việc trước.', turn),
        companyLine('$line', 'Đang đọc bảng công việc.', turn)
      ]
    }

    emit(snapshot)

    const working = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>('[data-matrix-agent-working]')
      expect(found).toBeTruthy()

      return found!
    })

    expect(working.querySelector('[data-matrix-progress-line]')?.textContent).toBe('Đang đọc bảng công việc.')
    expect(working.getAttribute('aria-label')).toBe('Chief of Staff đang soạn tin…')
    expect(view.container.querySelector('[data-matrix-message-id="$remark"]')).toBeTruthy()

    // A later message of the agent (another task's final, a Stop line) never clears this turn's line.
    emit({ ...snapshot, messages: [...snapshot.messages,
      message('$other-answer', 'Done with the other question.', { sender: COS, timestamp: 30 }),
      message('$stopped', 'Stopped.', { sender: COS, notice: true, timestamp: 40 })] })
    await waitFor(() => expect(view.container.querySelector('[data-matrix-message-id="$other-answer"]')).toBeTruthy())
    expect(view.container.querySelector('[data-matrix-progress-line]')?.textContent).toBe('Đang đọc bảng công việc.')

    // A personal interim flag from the bound agent, without the 1.6 identity, is a plain message.
    emit({ ...snapshot, messages: [...snapshot.messages,
      message('$personal', 'Một phút nhé.', { sender: COS, interim: true, timestamp: 35 })] })
    await waitFor(() => expect(view.container.querySelector('[data-matrix-message-id="$personal"]')).toBeTruthy())

    // Its publisher's cleanup (the line redacted) ends it; the remark stays history.
    emit({ ...snapshot, messages: [
      ...snapshot.messages.filter(entry => entry.id !== '$line'),
      message('$line', '', { sender: COS, notice: true, redacted: true, timestamp: 20 })
    ] })
    await waitFor(() => expect(view.container.querySelector('[data-matrix-agent-working]')).toBeNull())
    expect(view.container.querySelector('[data-matrix-message-id="$remark"]')).toBeTruthy()
  })

  // Preserve user-visible identity, state and recovery behavior across connection changes.
  // Preserve user-visible identity, state and recovery behavior across connection changes.
  // server sends it, projected by the SDK and by main, opened from the workspace and sent to, end to end.
  it('opens the private Chief of Staff from the workspace as the company’s chat, never the person’s own assistant', async () => {
    const OWNER = '@owner:test'
    const RAYMOND = '@raymond:test'
    const client = createClient({ baseUrl: 'https://matrix.test', userId: OWNER })
    const sdkRoom = new Room(PRIVATE_ROOM, client, OWNER)

    const state = (type: string, content: object, stateKey = '', sender = MANAGER) =>
      new MatrixEvent({ type, state_key: stateKey, sender, room_id: PRIVATE_ROOM, content, origin_server_ts: 1_762_560_000_000 })

    sdkRoom.currentState.setStateEvents([
      state(EventType.RoomCreate, { creator: MANAGER, room_version: '11', type: MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE }),
      state(EventType.RoomName, { name: 'Chief of Staff' }),
      state('io.atum.company_private_cos', {
        v: 1,
        classification: 'company_private_cos',
        companyId: COMPANY,
        membershipIncarnation: INCARNATION,
        executorId: EXECUTOR,
        attemptId: '00000000-0000-4000-8000-b99b2567070e'
      }),
      state(EventType.RoomJoinRules, { join_rule: 'invite' }),
      state(EventType.RoomHistoryVisibility, { history_visibility: 'joined' }),
      state(EventType.RoomPowerLevels, privateRoom.powerLevels!),
      state(EventType.RoomMember, { membership: 'join', displayname: 'You' }, OWNER, OWNER),
      state(EventType.RoomMember, { membership: 'join', displayname: 'Chief of Staff' }, COS, COS)
    ])
    sdkRoom.updateMyMembership('join')

    // The person's own default assistant, with its own private room beside the company's.
    const agents = [{ principal: 'raymond-principal', userId: RAYMOND }]

    const raymondRoom: MatrixRoom = {
      id: '!raymond:test',
      name: 'Raymond',
      membership: 'join',
      encrypted: false,
      plainAgent: true,
      roomType: MATRIX_ASSISTANT_ROOM_TYPE,
      participants: [{ userId: OWNER, membership: 'join' }, { userId: RAYMOND, membership: 'join' }]
    }

    const projected = assistantRooms(
      [conversationRoom(client, sdkRoom), raymondRoom],
      { userId: RAYMOND, deviceId: 'RAYMOND' },
      agents,
      OWNER
    )

    const cosRoom = projected.find(room => room.id === PRIVATE_ROOM)!

    expect(cosRoom).toMatchObject({ assistant: false, companyPrivateCos: { companyId: COMPANY } })
    expect(cosRoom.agentPrincipal).toBeUndefined()
    expect(projected.find(room => room.id === raymondRoom.id)).toMatchObject({ assistant: true, agentPrincipal: 'raymond-principal' })

    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const adapter = playgroundCompanyDesktopAdapter()

    const companyDesktop = {
      ...adapter,
      readAI: vi.fn(async () => aiView()),
      readPrivateCosCapability: vi.fn(async () => privateCapability),
      readPrivateCos: vi.fn(async () => privateView),
      ensurePrivateCos: vi.fn(async () => privateView),
      readPrivateCosReceipt: vi.fn(async () => {throw new Error('not used')}),
      stopPrivateCos: vi.fn(async () => {throw new Error('not used')})
    }

    const command = vi.fn(async () => null)

    const { bridge, emit, view } = fixture(undefined, 'en', undefined, command, undefined,
      companyWorkspaceWithChannel('!launch:test', undefined, COMPANY), undefined, { companyDesktop })

    await screen.findByRole('button', { name: 'Continue with Google' })

    const signedIn: MatrixSnapshot = {
      ...signedOut,
      state: 'ready',
      identity: { userId: OWNER, deviceId: 'OWNER' },
      companyWorkspaceEnabled: true,
      assistant: { userId: RAYMOND, deviceId: 'RAYMOND' },
      agents: [{
        principal: 'raymond-principal', userId: RAYMOND, deviceId: 'RAYMOND', name: 'Raymond', isDefault: true,
        ready: true, hermes: 'ready', atumModel: true, answering: 'cloud'
      }],
      hermes: 'ready',
      roomId: '!launch:test',
      rooms: [
        {
          id: '!launch:test', name: 'launch', membership: 'join', encrypted: false, roomType: MATRIX_COMPANY_CHANNEL_TYPE,
          companyChannel: binding,
          participants: [{ userId: OWNER, membership: 'join' }, { userId: COS, membership: 'join' }]
        },
        ...projected
      ],
      members: [
        { userId: OWNER, name: 'You', membership: 'join', canRemove: false },
        { userId: COS, name: 'Chief of Staff', membership: 'join', canRemove: false }
      ],
      messages: []
    }

    emit(signedIn)
    await screen.findByRole('textbox', { name: COMPOSER })

    // The workspace's Chief of Staff row opens the platform-bound room.
    const row = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>('[data-company-private-cos-row][data-company-private-cos-state="ready"]')
      expect(found).toBeTruthy()

      return found!
    })

    fireEvent.click(within(row).getByRole('button', { name: 'Chief of Staff' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'select', roomId: PRIVATE_ROOM }))

    emit({
      ...signedIn,
      roomId: PRIVATE_ROOM,
      messages: [message('$greeting', 'Hi, I’m your Chief of Staff at Alpha.', { sender: COS })]
    })

    const composer = await screen.findByRole('textbox', { name: 'Message Chief of Staff' })
    await screen.findByText('Hi, I’m your Chief of Staff at Alpha.')

    const header = view.container.querySelector<HTMLElement>('[data-matrix-header-identity]')!
    await waitFor(() => expect(header.querySelector('[data-matrix-private-cos-title]')?.textContent).toBe('Chief of Staff'))
    expect(header.querySelector('[data-matrix-private-cos-face]')).toBeTruthy()
    expect(header.textContent).not.toMatch(/Raymond|Chat ·/)
    expect(header.querySelector('[data-matrix-header-card]')).toBeNull()
    expect(screen.queryByText(/not connected to your current assistant/)).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Message Raymond' })).toBeNull()
    // The company's menu, not the personal chat's (no rename, delete or block of the Chief of Staff).
    expect(view.container.querySelector('[data-matrix-private-cos-menu]')).toBeTruthy()
    expect(view.container.querySelector('[data-matrix-chat-menu="header"]')).toBeNull()

    fireEvent.change(composer, { target: { value: 'Please help with the launch plan' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(command).toHaveBeenCalledWith({
      kind: 'send', roomId: PRIVATE_ROOM, body: 'Please help with the launch plan'
    }))
    expect(bridge.sendAssistant).not.toHaveBeenCalled()
    // The ordinary send names the Chief of Staff: the SDK's own recipient rule on this very room.
    expect(companyPrivateCosRecipient(sdkRoom, OWNER)).toBe(COS)

    // An older main that still labels the room as the person's assistant changes nothing on screen.
    emit({
      ...signedIn,
      roomId: PRIVATE_ROOM,
      rooms: signedIn.rooms.map(room => room.id === PRIVATE_ROOM
        ? { ...room, assistant: true, agentPrincipal: 'raymond-principal' }
        : room),
      messages: [message('$greeting', 'Hi, I’m your Chief of Staff at Alpha.', { sender: COS })]
    })
    await screen.findByRole('textbox', { name: 'Message Chief of Staff' })
    expect(view.container.querySelector('[data-matrix-header-identity]')!.textContent).not.toMatch(/Raymond|Chat ·/)
    expect(screen.queryByText(/not connected to your current assistant/)).toBeNull()
  })

  it('keeps a restored stale private-CoS selection unmounted when the platform view is denied', async () => {
    const base = playgroundCompanyDesktopAdapter()

    const companyDesktop = {
      ...base,
      readPrivateCosCapability: vi.fn(async () => {throw new Error('denied')}),
      readPrivateCos: vi.fn(async () => {throw new Error('denied')}),
      ensurePrivateCos: vi.fn(async () => {throw new Error('denied')}),
      readPrivateCosReceipt: vi.fn(async () => {throw new Error('not used')}),
      stopPrivateCos: vi.fn(async () => {throw new Error('not used')})
    }

    const { emit, view } = fixture(
      undefined,
      'en',
      undefined,
      vi.fn(async () => null),
      undefined,
      companyWorkspaceWithChannel('!launch:test', undefined, COMPANY),
      undefined,
      { companyDesktop }
    )

    await screen.findByRole('button', { name: 'Continue with Google' })
    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'OWNER' },
      companyWorkspaceEnabled: true,
      roomId: PRIVATE_ROOM,
      rooms: [{
        ...privateRoom,
        companyPrivateCos: {
          ...privateRoom.companyPrivateCos!,
          membershipIncarnation: '00000000-0000-4000-8000-574a85d37f85'
        }
      }],
      members: [
        { userId: '@owner:test', name: 'You', membership: 'join', canRemove: false },
        { userId: COS, name: 'Chief of Staff', membership: 'join', canRemove: false }
      ],
      messages: [message('$stale-private', 'restored private transcript secret', { sender: COS })]
    })

    await waitFor(() => expect(companyDesktop.readPrivateCosCapability).toHaveBeenCalledWith(COMPANY))
    expect(screen.queryByText('restored private transcript secret')).toBeNull()
    expect(screen.queryByRole('textbox', { name: COMPOSER })).toBeNull()
    expect(view.container.querySelector('[data-matrix-failure]')).toBeNull()
  })

  it('keeps exact, malformed and platform-bound private-CoS claims out of Personal global search', async () => {
    const { emit } = fixture()
    await screen.findByRole('button', { name: 'Continue with Google' })

    const privateClaimBase = {
      ...privateRoom,
      membership: 'join'
    }

    emit({
      ...signedOut,
      state: 'ready',
      identity: { userId: '@owner:test', deviceId: 'OWNER' },
      rooms: [
        { ...privateClaimBase, id: '!exact-private:test', name: 'Leak exact private' },
        {
          ...privateClaimBase,
          id: '!malformed-private:test',
          name: 'Leak malformed private',
          companyPrivateCos: undefined,
          companyPrivateCosClaim: true
        },
        {
          ...privateClaimBase,
          id: '!bound-private:test',
          name: 'Leak bound private',
          companyPrivateCos: undefined,
          companyPrivateCosBound: true
        }
      ],
      roomId: null
    })

    fireEvent.change(screen.getByRole('textbox', { name: 'Search everything' }), {
      target: { value: 'Leak' }
    })

    expect(screen.queryByRole('button', { name: 'Leak exact private' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Leak malformed private' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Leak bound private' })).toBeNull()
  })

  it('turns a public channel message into a task that links back, keeping the person in the chat', async () => {
    const { companyDesktop, view } = await openChannel(aiView())

    const actions = await waitFor(() => {
      const found = view.container.querySelector<HTMLButtonElement>(
        '[data-matrix-message-id="$quote"] [data-matrix-report-message]'
      )

      expect(found).toBeTruthy()

      return found!
    })

    fireEvent.keyDown(actions, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Turn into task' }))

    await waitFor(() => expect(companyDesktop.commandBoard).toHaveBeenCalledOnce())
    const [companyId, command, version] = companyDesktop.commandBoard.mock.calls[0]!
    expect(companyId).toBe(COMPANY)
    expect(version).toBe('1.1')
    expect(command).toMatchObject({ operation: 'create', title: 'Send the quote before Friday' })
    expect((command as { description: string }).description).toMatch(/^atum:\/\/message\/v1\//)

    const receipt = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>('[data-company-board-capture-added]')
      expect(found).toBeTruthy()

      return found!
    })

    expect(receipt.textContent).toBe('Added to Board · Open task')
    expect(companySpacePreferences(`@owner:test:OWNER\u0000${COMPANY}`).tab).toBe('chat')

    fireEvent.click(within(receipt).getByRole('button', { name: 'Open task' }))
    await waitFor(() => expect(companySpacePreferences(`@owner:test:OWNER\u0000${COMPANY}`).tab).toBe('board'))
  })
})
