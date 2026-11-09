import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixRoom, MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import type { MatrixAliasBridge, MatrixAliasResult } from '../../shared/matrix-aliases'

import { ConversationMembership, MatrixMembers, MatrixMembersButton } from './conversation-controls'
import { bindMatrixHandleOwner, rememberMatrixHandle, resetMatrixHandlesForTest } from './person-handles'

afterEach(() => {
  cleanup()
  resetMatrixHandlesForTest()
  Reflect.deleteProperty(window, 'atumMatrix')
})
const room: MatrixRoom = { id: '!r:test', name: 'Friends', encrypted: true, membership: 'join', canInvite: true }

const snapshot: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@alice:test', deviceId: 'A' },
  rooms: [room],
  roomId: room.id,
  messages: [],
  error: null,
  members: [{ userId: '@bob:test', name: 'Bob', membership: 'join', canRemove: true }]
}

function setup(
  child: React.ReactNode,
  command = vi.fn<MatrixUiBridge['command']>().mockResolvedValue(null),
  aliases?: MatrixAliasBridge
) {
  window.atumMatrix = { command, ...(aliases ? { aliases } : {}) } as unknown as MatrixUiBridge

  const wrap = (child: React.ReactNode) => (
    <I18nProvider configClient={null} initialLocale="en">
      {child}
    </I18nProvider>
  )

  const view = render(wrap(child))

  return { command, ...view, rerender: (child: React.ReactNode) => view.rerender(wrap(child)) }
}

const aliasBridge = (result: MatrixAliasResult): MatrixAliasBridge => ({
  pending: vi.fn(),
  request: vi.fn(async () => result)
})

/** A two-person conversation with someone the owner already talks to. */
const direct = (id: string, userId: string, name: string): MatrixRoom => ({
  id,
  name,
  encrypted: true,
  direct: true,
  membership: 'join',
  participants: [
    { userId: '@alice:test', membership: 'join' },
    { userId, membership: 'join' }
  ]
})

/** Opens the members dialog, then the picker that adds to it. */
function openAddMembers(count = 1) {
  fireEvent.click(screen.getByRole('button', { name: `Members (${count})` }))
  fireEvent.click(screen.getByRole('button', { name: 'Add members' }))

  return screen.getByRole('dialog', { name: 'Add members' })
}

/** Looks someone up by their @name in the picker. */
function findPerson(picker: HTMLElement, query: string, handle = query.replace(/^@/, '').toLowerCase()) {
  fireEvent.change(within(picker).getByRole('textbox', { name: 'Search names, or enter an @name' }), {
    target: { value: query }
  })
  fireEvent.click(within(picker).getByRole('button', { name: `Find @${handle} on Atum` }))
}

/** The header's people button and the members dialog it opens, as the chat's header has them. */
function Members({ room, snapshot }: { room: MatrixRoom; snapshot: MatrixSnapshot }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <MatrixMembersButton onOpen={() => setOpen(true)} snapshot={snapshot} />
      <MatrixMembers onOpenChange={setOpen} open={open} room={room} snapshot={snapshot} />
    </>
  )
}

/** Opens a member's "…" and picks one of its actions. */
function memberAction(name: string, action: string) {
  fireEvent.keyDown(screen.getByRole('button', { name: `Options for ${name}` }), { key: 'Enter' })
  fireEvent.click(screen.getByRole('menuitem', { name: action }))
}

/** The row a person has in the members dialog, as it reads. */
// A row reads "name / second line": the second line is the @handle (or another server's address).
const memberRows = () =>
  [...window.document.querySelectorAll('[data-matrix-member-name]')].map(name =>
    [...name.children].map(line => line.textContent).filter(Boolean).join(' / '))

describe('conversation controls', () => {
  it('shows participant avatars in the group header instead of a generic people tab', () => {
    const members = [
      { userId: '@alice:test', name: 'Alice', membership: 'join', canRemove: false },
      { userId: '@bob:test', name: 'Bob', membership: 'join', canRemove: true },
      { userId: '@carol:test', name: 'Carol', membership: 'join', canRemove: true }
    ]
    const view = setup(<MatrixMembersButton onOpen={() => {}} snapshot={{ ...snapshot, members }} />)

    expect(view.container.querySelector('[data-matrix-member-avatars]')?.textContent).toBe('BC')
    expect(screen.getByRole('button', { name: 'Members (3)' })).toBeTruthy()
  })

  it('lists people by name, with an @handle only the directory gave, never an ID, and keeps another server in view', () => {
    const lan = '@user-3f2a9c0d1e2b4a5f6c7d8e9f0a1b2c3d:test'
    const hoa = '@user-7b1e0c9d8a7f6e5d4c3b2a1f0e9d8c7b:test'
    const nameless = '@user-0123456789abcdef0123456789abcdef:test'

    const members = [
      { userId: lan, name: 'Lan', membership: 'join', canRemove: false },
      { userId: hoa, name: `Hoa (${hoa})`, membership: 'join', canRemove: false },
      { userId: '@eve:other.test', name: 'Lan', membership: 'join', canRemove: false },
      { userId: nameless, name: nameless, membership: 'join', canRemove: false }
    ]

    bindMatrixHandleOwner('@alice:test')
    rememberMatrixHandle(lan, 'lan')
    setup(<Members room={room} snapshot={{ ...snapshot, members }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Members (4)' }))
    expect(memberRows()).toEqual(['Lan / @lan', 'Hoa', 'Lan / @eve:other.test', 'Atum user'])
    expect(screen.queryByText(/user-[0-9a-f]{8}/)).toBeNull()
    // No "Joined" on every line: what is unusual is said, what is usual is not.
    expect(screen.queryByText('Joined')).toBeNull()
    expect(screen.getByRole('button', { name: 'Options for Atum user' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })
  it('requires a fresh confirmation when synced membership changes from ban to unban', async () => {
    const initial = { ...snapshot, members: [{ ...snapshot.members![0], canBan: true }] }
    const { command, rerender } = setup(<Members room={room} snapshot={initial} />)
    fireEvent.click(screen.getByRole('button', { name: 'Members (1)' }))
    memberAction('Bob', 'Ban from room')
    expect(screen.getByRole('dialog', { name: 'Ban Bob from this chat?' })).toBeTruthy()

    const banned = {
      ...snapshot,
      members: [{ ...snapshot.members![0], membership: 'ban', canRemove: false, canUnban: true }]
    }

    rerender(<Members room={room} snapshot={banned} />)
    // A personal group's sheet is named by the group; its people follow under their count.
    expect(within(screen.getByRole('dialog', { name: 'Friends' })).getByText('Members (0)')).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Ban Bob from this chat?' })).toBeNull()
    expect(command).not.toHaveBeenCalled()
    memberAction('Bob', 'Unban')
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Let Bob back in?' })).getByRole('button', { name: 'Unban' })
    )
    await waitFor(() =>
      expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'unban', roomId: room.id, userId: '@bob:test' })
    )
    expect(screen.getByText('Banned')).toBeTruthy()
  })
  it('confirms a ban with what it means, and keeps ignore a separate, explained step', async () => {
    const { command } = setup(
      <Members room={room} snapshot={{ ...snapshot, members: [{ ...snapshot.members![0], canBan: true }] }} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Members (1)' }))
    memberAction('Bob', 'Ignore')
    const ignore = screen.getByRole('dialog', { name: 'Ignore Bob?' })
    expect(within(ignore).getByText(/won’t see their messages/)).toBeTruthy()
    expect(command).not.toHaveBeenCalled()
    fireEvent.click(within(ignore).getByRole('button', { name: 'Ignore' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'ignore', userId: '@bob:test', ignored: true }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ignore Bob?' })).toBeNull())

    memberAction('Bob', 'Ban from room')
    const ban = screen.getByRole('dialog', { name: 'Ban Bob from this chat?' })
    expect(within(ban).getByText(/can’t rejoin this chat/)).toBeTruthy()
    expect(command).toHaveBeenCalledTimes(1)
    fireEvent.click(within(ban).getByRole('button', { name: 'Ban from room' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'ban', roomId: room.id, userId: '@bob:test' }))
  })
  it.each(['disappears', 'changes membership', 'loses power'])(
    'does not revive a destructive confirmation after the target %s',
    change => {
      const member = { ...snapshot.members![0], canBan: true }
      const initial = { ...snapshot, members: [member] }
      const { command, rerender } = setup(<Members room={room} snapshot={initial} />)
      fireEvent.click(screen.getByRole('button', { name: 'Members (1)' }))
      memberAction('Bob', 'Ban from room')

      const members =
        change === 'disappears'
          ? []
          : [{ ...member, ...(change === 'changes membership' ? { membership: 'invite' } : { canBan: false }) }]

      rerender(<Members room={room} snapshot={{ ...snapshot, members }} />)
      rerender(<Members room={room} snapshot={initial} />)
      expect(screen.queryByRole('dialog', { name: 'Ban Bob from this chat?' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Options for Bob' })).toBeTruthy()
      expect(command).not.toHaveBeenCalled()
    }
  )
  it('adds members with the same picker that makes a group, one invitation each', async () => {
    const withPeople: MatrixSnapshot = {
      ...snapshot,
      rooms: [room, direct('!dana:test', '@dana:test', 'Dana'), direct('!bob-dm:test', '@bob:test', 'Bob')]
    }

    const { command } = setup(<Members room={room} snapshot={withPeople} />)
    const picker = openAddMembers()
    const bob = within(picker).getByRole('checkbox', { name: 'Bob' }) as HTMLInputElement
    // Bob is already in: shown ticked, with why, and can't be picked again.
    expect(bob.checked).toBe(true)
    expect(bob.disabled).toBe(true)
    expect(within(picker).getByText('Already in this group')).toBeTruthy()
    expect((within(picker).getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(picker).getByRole('checkbox', { name: 'Dana' }))
    fireEvent.click(within(picker).getByRole('button', { name: 'Add 1' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'invite', roomId: room.id, userId: '@dana:test' })
    )
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add members' })).toBeNull())
    expect(within(screen.getByRole('dialog', { name: 'Friends' })).getByText('Members (1)')).toBeTruthy()
  })
  it('invites someone found by their @name, never asking for a Matrix address', async () => {
    const aliases = aliasBridge({
      ok: true,
      value: { kind: 'lookup', handle: 'carol', state: 'assigned', principalKind: 'human', matrixUser: '@carol:test' }
    })

    const { command } = setup(<Members room={room} snapshot={snapshot} />, undefined, aliases)
    const picker = openAddMembers()
    expect(screen.queryByLabelText('Matrix user ID')).toBeNull()
    findPerson(picker, '@Carol')
    await waitFor(() =>
      expect((within(picker).getByRole('checkbox', { name: '@carol' }) as HTMLInputElement).checked).toBe(true)
    )
    expect(aliases.request).toHaveBeenCalledExactlyOnceWith({ action: 'lookup', handle: 'carol' })
    fireEvent.click(within(picker).getByRole('button', { name: 'Add 1' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'invite', roomId: room.id, userId: '@carol:test' })
    )
  })
  it('keeps only who still needs inviting when an invitation fails, and keeps the draft across dismissal', async () => {
    const withPeople: MatrixSnapshot = {
      ...snapshot,
      rooms: [room, direct('!dana:test', '@dana:test', 'Dana'), direct('!eve:test', '@eve:test', 'Eve')]
    }

    const command = vi.fn<MatrixUiBridge['command']>(async value =>
      value.kind === 'invite' && value.userId === '@eve:test' ? Promise.reject(new Error('offline')) : null
    )

    setup(<Members room={room} snapshot={withPeople} />, command)
    let picker = openAddMembers()
    fireEvent.click(within(picker).getByRole('checkbox', { name: 'Dana' }))
    fireEvent.click(within(picker).getByRole('checkbox', { name: 'Eve' }))
    fireEvent.click(within(picker).getByRole('button', { name: 'Add 2' }))
    expect(await within(picker).findByRole('alert')).toBeTruthy()
    expect(within(picker).getByRole('alert').textContent).toContain("Couldn't add everyone")
    expect(within(picker).queryByRole('button', { name: 'Remove Dana' })).toBeNull()
    expect(within(picker).getByRole('button', { name: 'Remove Eve' })).toBeTruthy()
    // Dismissed and opened again, the picks and the search are still there.
    fireEvent.change(within(picker).getByRole('textbox', { name: 'Search names, or enter an @name' }), {
      target: { value: 'ev' }
    })
    fireEvent.keyDown(picker, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add members' })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Add members' }))
    picker = screen.getByRole('dialog', { name: 'Add members' })
    expect(within(picker).getByDisplayValue('ev')).toBeTruthy()
    expect(within(picker).getByRole('button', { name: 'Remove Eve' })).toBeTruthy()
    expect(command).toHaveBeenCalledTimes(2)
  })
  it('never reopens Add members by itself once Members was closed from outside', () => {
    // The chat's header closes Members when the person moves to another chat, Add members open.
    function Header() {
      const [open, setOpen] = useState(false)

      return (
        <>
          <MatrixMembersButton onOpen={() => setOpen(true)} snapshot={snapshot} />
          <button onClick={() => setOpen(false)} type="button">
            elsewhere
          </button>
          <MatrixMembers onOpenChange={setOpen} open={open} room={room} snapshot={snapshot} />
        </>
      )
    }

    setup(<Header />)
    openAddMembers()
    fireEvent.click(screen.getByText('elsewhere'))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Members (1)' }))
    expect(screen.getByRole('dialog', { name: 'Friends' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Add members' })).toBeNull()
  })
  it('adds one of your own assistants as an invitation main recognises, five at most', async () => {
    const assistant = (name: string, userId: string) => ({
      principal: `${name}-principal`,
      userId,
      name,
      isDefault: false,
      ready: true,
      hermes: 'ready' as const,
      atumModel: true
    })

    const bea = assistant('Bea', '@bea:test')
    const withAgents: MatrixSnapshot = { ...snapshot, agents: [bea] }
    const { command } = setup(<Members room={room} snapshot={withAgents} />)
    const picker = openAddMembers()
    fireEvent.click(within(picker).getByRole('button', { name: /^Assistants$/ }))
    fireEvent.click(within(picker).getByRole('checkbox', { name: 'Bea' }))
    expect(within(picker).getByText(/Only you can ask your assistants here/)).toBeTruthy()
    fireEvent.click(within(picker).getByRole('button', { name: 'Add 1' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'invite', roomId: room.id, userId: '@bea:test' }))
    cleanup()

    // A group already holding five of yours takes no sixth.
    const five = ['A1', 'A2', 'A3', 'A4', 'A5'].map(name => assistant(name, `@${name.toLowerCase()}:test`))
    const sixth = assistant('Six', '@six:test')

    const full: MatrixSnapshot = {
      ...snapshot,
      agents: [...five, sixth],
      members: five.map(each => ({ userId: each.userId, name: each.name, membership: 'join', canRemove: true }))
    }

    setup(<Members room={room} snapshot={full} />)
    const again = openAddMembers(5)
    fireEvent.click(within(again).getByRole('button', { name: /^Assistants$/ }))
    expect((within(again).getByRole('checkbox', { name: 'Six' }) as HTMLInputElement).disabled).toBe(true)
    expect(within(again).getByText('Up to 5 assistants in a group')).toBeTruthy()
  })
  it('says plainly when someone found is already in the conversation', async () => {
    const aliases = aliasBridge({
      ok: true,
      value: { kind: 'lookup', handle: 'bob', state: 'assigned', principalKind: 'human', matrixUser: '@bob:test' }
    })

    const { command } = setup(<Members room={room} snapshot={snapshot} />, undefined, aliases)
    const picker = openAddMembers()
    findPerson(picker, '@bob')
    await waitFor(() => expect(within(picker).getByText(/Already in this group/)).toBeTruthy())
    expect((within(picker).getByRole('checkbox', { name: '@bob' }) as HTMLInputElement).disabled).toBe(true)
    expect(command).not.toHaveBeenCalled()
  })
  it('requires confirmation before removal, uses the explicit target, and displays authoritative membership', async () => {
    const { command } = setup(<Members room={room} snapshot={snapshot} />)
    fireEvent.click(screen.getByRole('button', { name: 'Members (1)' }))
    memberAction('Bob', 'Remove')
    expect(command).not.toHaveBeenCalled()
    const remove = screen.getByRole('dialog', { name: 'Remove Bob from this chat?' })
    // It says what happens to them: no new messages, and what they received stays theirs.
    expect(within(remove).getByText(/won’t get new messages here/)).toBeTruthy()
    fireEvent.click(within(remove).getByRole('button', { name: 'Remove' }))
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({ kind: 'removeMember', roomId: room.id, userId: '@bob:test' })
    )
    // No optimistic roster mutation: Bob disappears only after an SDK snapshot.
    expect(memberRows()).toEqual(['Bob'])
  })
  it('accepts or declines invitations through Matrix, with no send control', async () => {
    const invited = { ...room, membership: 'invite' }
    const { command } = setup(<ConversationMembership room={invited} snapshot={snapshot} />)
    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'join', roomId: room.id }))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Decline invitation' }) as HTMLButtonElement).disabled).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Decline invitation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm decline' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'leave', roomId: room.id }))
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull()
  })
  // 0.20: new people chats and groups are plain. Their invitations are accepted, and members are
  // added, exactly as in an encrypted one.
  it('accepts an invitation to a plain chat', async () => {
    const invited = { ...room, encrypted: false, membership: 'invite' }
    const { command } = setup(<ConversationMembership room={invited} snapshot={snapshot} />)
    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'join', roomId: room.id }))
  })

  it.each([false, true])('offers Add members in a group (encrypted: %s)', encrypted => {
    const group = { ...room, encrypted }
    setup(<Members room={group} snapshot={{ ...snapshot, rooms: [group] }} />)
    expect(openAddMembers()).toBeTruthy()
  })

  it('does not publish a delayed old-room failure into a new room', async () => {
    let reject!: (reason: Error) => void

    const command = vi.fn<MatrixUiBridge['command']>(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )

    const withPeople = { ...snapshot, rooms: [room, direct('!dana:test', '@dana:test', 'Dana')] }
    const { rerender } = setup(<Members key="old" room={room} snapshot={withPeople} />, command)
    const picker = openAddMembers()
    fireEvent.click(within(picker).getByRole('checkbox', { name: 'Dana' }))
    fireEvent.click(within(picker).getByRole('button', { name: 'Add 1' }))
    rerender(<Members key="new" room={{ ...room, id: '!new:test' }} snapshot={withPeople} />)
    await act(async () => reject(new Error('old request failed')))
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('disables member actions offline, and a room you left says so with nothing to press', () => {
    const { rerender, command } = setup(<Members room={room} snapshot={{ ...snapshot, state: 'offline' }} />)

    fireEvent.click(screen.getByRole('button', { name: 'Members (1)' }))
    expect((screen.getByRole('button', { name: 'Options for Bob' }) as HTMLButtonElement).disabled).toBe(true)
    expect(command).not.toHaveBeenCalled()
    rerender(<ConversationMembership room={{ ...room, membership: 'leave' }} snapshot={snapshot} />)
    expect(screen.getByText(/You are no longer a member/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
