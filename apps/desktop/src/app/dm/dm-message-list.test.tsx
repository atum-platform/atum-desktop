import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $atumAppCatalog } from '@/lib/atum-app-catalog'
import type { AtumMessagingMessage } from '@/lib/atum-messaging-client'

import type { GroupMember, GroupMembershipEvent } from '../../../shared/atum-group-conversations'

import { DmMessageList } from './dm-message-list'

const ROOM_ID = 'room-1'
const MOON_ID = '00000000-0000-4000-8000-bd7662a5eeb4'
const OWNER_ID = '00000000-0000-4000-8000-b454f82c5857'
const ALICE_ID = '00000000-0000-4000-8000-f6222a1106ee'

const members: GroupMember[] = [
  { userId: 'owner', displayName: 'Minh', handle: 'minh', role: 'owner', membershipEpoch: 1 },
  { userId: 'lan', displayName: 'Lan', handle: 'lan', role: 'member', membershipEpoch: 1 }
]

function message(overrides: Partial<AtumMessagingMessage> = {}): AtumMessagingMessage {
  return {
    attachments: [],
    clientMessageId: null,
    content: 'Hello from Lan',
    conversationId: ROOM_ID,
    createdAt: '2026-09-06T00:02:00.000Z',
    delivery: 'sent',
    editedAt: null,
    forwardedFrom: null,
    id: 'message-1',
    kind: 'text',
    localId: 'local-1',
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

function event(kind: GroupMembershipEvent['kind'], createdAt: string, id: string): GroupMembershipEvent {
  return {
    actorUserId: 'owner',
    conversationId: ROOM_ID,
    createdAt,
    id,
    identitySnapshot: { displayName: 'Lan', handle: 'lan' },
    kind,
    subjectUserId: 'lan'
  }
}

function renderList(overrides: Partial<ComponentProps<typeof DmMessageList>> = {}) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <DmMessageList
        accountId="owner"
        emptyContent={<p>Empty room</p>}
        messages={[message()]}
        olderState="exhausted"
        onLoadOlder={vi.fn()}
        onRetry={vi.fn()}
        retryLabel="Retry"
        {...overrides}
      />
    </I18nProvider>
  )
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  $atumAppCatalog.set({ accountId: 'owner', apps: [{ app: 'moon', app_id: '00000000-0000-0000-0000-000000000001', app_version_id: '00000000-0000-0000-0000-000000000002', name: { en: 'Moon', vi: 'Moon' }, subtitle: null, icon: null, verified: true, availability: 'available', supported_modes: ['direct'], link: { mode: 'none', state: 'never_linked' } }], state: 'ready' })
})

afterEach(cleanup)

describe('DmMessageList group timeline', () => {
  it('attributes both owned-agent replies from the advisory roster when no identity snapshot is attached', () => {
    const { container } = renderList({
      groupMembers: members.slice(0, 1),
      groupAdvisors: [
        { target: { type: 'assistant', id: 'a1' }, displayName: 'Marketing', avatar: '', availability: 'available' },
        { target: { type: 'assistant', id: 'a2' }, displayName: 'Research', avatar: '', availability: 'available' }
      ],
      messages: [
        message({ id: 'reply-a1', sender: { type: 'assistant', id: 'a1' }, content: 'Choose the book.' }),
        message({ id: 'reply-a2', sender: { type: 'assistant', id: 'a2' }, content: 'Then prepare the room.' })
      ]
    })

    const labels = [...container.querySelectorAll('[data-dm-group-sender]')].map(node => node.textContent)
    expect(labels[0]).toContain('Marketing')
    expect(labels[1]).toContain('Research')
    expect(screen.getByText('Choose the book.')).toBeTruthy()
    expect(screen.getByText('Then prepare the room.')).toBeTruthy()
  })

  it('merges membership events and messages by timestamp, with current member names', () => {
    const { container } = renderList({
      groupMembers: members,
      membershipEvents: [
        event('created', '2026-09-06T00:00:00.000Z', 'event-1'),
        event('member_added', '2026-09-06T00:01:00.000Z', 'event-2')
      ]
    })

    const order = Array.from(container.querySelectorAll('[data-group-membership-event], [data-dm-group-sender]')).map(
      node => node.textContent
    )

    expect(order).toEqual(['Minh (@minh) created the room.', 'Minh (@minh) added Lan (@lan).', 'Lan (@lan)'])
    expect(screen.getByText('Hello from Lan')).toBeTruthy()
  })

  it('renders an event-only room instead of the normal empty state', () => {
    renderList({
      groupMembers: members,
      membershipEvents: [event('member_left', '2026-09-06T00:00:00.000Z', 'event-1')],
      messages: []
    })

    expect(screen.getByText('Lan (@lan) left the room.')).toBeTruthy()
    expect(screen.queryByText('Empty room')).toBeNull()
  })

  it('uses a generic former-member label and does not surface an unknown sender UUID', () => {
    renderList({
      groupMembers: members,
      messages: [message({ sender: { type: 'user', id: 'removed-user-uuid' } })]
    })

    expect(screen.getByText('A former member')).toBeTruthy()
    expect(screen.queryByText('removed-user-uuid')).toBeNull()
  })

  it('does not offer a report control for the viewer’s own group message', () => {
    const onReport = vi.fn()
    renderList({
      groupMembers: members,
      messages: [message({ sender: { type: 'user', id: 'owner' } })],
      onReport
    })

    expect(screen.queryByRole('button', { name: 'Report' })).toBeNull()
    expect(onReport).not.toHaveBeenCalled()
  })

  it('reports another member’s group message through the canonical message id', () => {
    const onReport = vi.fn()
    renderList({ groupMembers: members, onReport })

    fireEvent.click(screen.getByRole('button', { name: 'Report' }))
    expect(onReport).toHaveBeenCalledWith('message-1')
  })

  it('keeps a bare one-to-one app reply recognizable without group identity metadata', () => {
    renderList({ messages: [message({ sender: { type: 'specialist', id: 'moon' }, metadata: { turn_id: 'turn-1' } })] })
    expect(screen.getByText('Moon')).toBeTruthy()
    expect(screen.queryByText('A former member')).toBeNull()
  })

  it('labels a specialist sender from the room projection and offers a bounded explicit quote', () => {
    const onQuote = vi.fn()
    renderList({
      groupMembers: members,
      groupSpecialists: [
        { specialist: 'moon', displayName: 'Moon', avatar: '☾', membershipEpoch: 1, availability: 'available' }
      ],
      messages: [message({ sender: { type: 'specialist', id: 'moon' } })],
      onQuote,
      quoteEnabled: true,
      quoteLimit: 4
    })
    expect(screen.getByText('Moon')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Quote for apps' })).toBeNull()

    renderList({
      groupMembers: members,
      messages: [message({ content: 'Okay' })],
      onQuote,
      quoteEnabled: true,
      quoteLimit: 4
    })
    fireEvent.click(screen.getByRole('button', { name: 'Quote for apps' }))
    expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({ id: 'message-1', version: 1 }))
  })
  it('retains the published app name after removal or renaming', () => {
    renderList({
      groupMembers: members,
      groupSpecialists: [],
      messages: [message({ sender: { type: 'specialist', id: 'moon' },
        metadata: { specialist_identity: { specialist: 'moon', display_name: 'Moon at publication', avatar: '☾', revision: 1 } } })]
    })
    expect(screen.getByText('Moon at publication')).toBeTruthy()
  })

  it('attributes one Moon app to each recorded owner without adding roster rows', () => {
    const { container } = renderList({
      accountId: OWNER_ID,
      groupSpecialists: [{ specialist: 'moon', displayName: 'Moon today', avatar: '☾', membershipEpoch: 1, availability: 'available' }],
      messages: [
        message({ id: 'moon-owner', sender: { type: 'specialist', id: 'moon' }, metadata: {
          participant: { kind: 'app', id: MOON_ID, owner_user_id: OWNER_ID, display_name: 'Moon', owner_display_name: 'Minh', avatar_url: 'https://cdn.atum.test/minh-moon.png' }
        } }),
        message({ id: 'moon-alice', sender: { type: 'specialist', id: 'moon' }, metadata: {
          participant: { kind: 'app', id: MOON_ID, owner_user_id: ALICE_ID, display_name: 'Moon', owner_display_name: 'Alice', avatar_url: 'https://cdn.atum.test/alice-moon.png' }
        } })
      ]
    })

    expect(screen.getByText('My Moon')).toBeTruthy()
    expect(screen.getByText("Alice's Moon")).toBeTruthy()
    expect(container.querySelector('img[src="https://cdn.atum.test/minh-moon.png"]')).toBeTruthy()
    expect(container.querySelector('img[src="https://cdn.atum.test/alice-moon.png"]')).toBeTruthy()
  })

  it('falls back honestly when an app snapshot has no owner, without inferring one from live metadata', () => {
    renderList({
      accountId: OWNER_ID,
      groupSpecialists: [{ specialist: 'moon', displayName: 'Moon today', avatar: '☾', membershipEpoch: 1, availability: 'available' }],
      messages: [message({ sender: { type: 'specialist', id: 'moon' }, metadata: {
        participant: { kind: 'app', id: MOON_ID, display_name: 'Forged ownerless Moon' },
        specialist_identity: { specialist: 'moon', display_name: 'Moon at publication', avatar: '☾', revision: 1 }
      } })]
    })

    expect(screen.getByText('Moon at publication')).toBeTruthy()
    expect(screen.queryByText('My Forged ownerless Moon')).toBeNull()
  })

  it('keeps recorded app names and photos across a live rename or lifecycle change', () => {
    const { container } = renderList({
      accountId: OWNER_ID,
      groupSpecialists: [{ specialist: 'moon', displayName: 'Moon renamed today', avatar: '☾', membershipEpoch: 2, availability: 'specialist_not_linked' }],
      messages: [message({ sender: { type: 'specialist', id: 'moon' }, metadata: {
        participant: { kind: 'app', id: MOON_ID, owner_user_id: ALICE_ID, display_name: 'Moon at publication', owner_display_name: 'Alice at publication', avatar_url: 'https://cdn.atum.test/moon-before.png' }
      } })]
    })

    expect(screen.getByText("Alice at publication's Moon at publication")).toBeTruthy()
    expect(screen.queryByText('Moon renamed today')).toBeNull()
    expect(container.querySelector('img[src="https://cdn.atum.test/moon-before.png"]')).toBeTruthy()
  })

  it('requires assistant and user participant snapshots to match the sender', () => {
    renderList({
      groupAdvisors: [{ target: { type: 'assistant', id: 'actual-assistant' }, displayName: 'Live advisor', avatar: '', availability: 'available' }],
      groupMembers: [],
      messages: [
        message({ id: 'assistant', sender: { type: 'assistant', id: 'actual-assistant' }, metadata: {
          participant: { kind: 'assistant', id: MOON_ID, owner_user_id: OWNER_ID, display_name: 'Wrong assistant' }
        } }),
        message({ id: 'user', sender: { type: 'user', id: 'unknown-user' }, metadata: {
          participant: { kind: 'user', id: MOON_ID, display_name: 'Wrong person' }
        } })
      ]
    })

    expect(screen.getByText('Live advisor')).toBeTruthy()
    expect(screen.getByText('A former member')).toBeTruthy()
    expect(screen.queryByText('Wrong assistant')).toBeNull()
    expect(screen.queryByText('Wrong person')).toBeNull()
  })

  it('recomputes owner-qualified names when the viewer changes accounts', () => {
    const messages = [message({ sender: { type: 'specialist', id: 'moon' }, metadata: {
      participant: { kind: 'app', id: MOON_ID, owner_user_id: ALICE_ID, display_name: 'Moon', owner_display_name: 'Alice' }
    } })]

    const rendered = renderList({ accountId: OWNER_ID, messages })

    expect(screen.getByText("Alice's Moon")).toBeTruthy()

    rendered.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <DmMessageList
          accountId={ALICE_ID}
          emptyContent={<p>Empty room</p>}
          messages={messages}
          olderState="exhausted"
          onLoadOlder={vi.fn()}
          onRetry={vi.fn()}
          retryLabel="Retry"
        />
      </I18nProvider>
    )

    expect(screen.getByText('My Moon')).toBeTruthy()
    expect(screen.queryByText("Alice's Moon")).toBeNull()
  })

})
