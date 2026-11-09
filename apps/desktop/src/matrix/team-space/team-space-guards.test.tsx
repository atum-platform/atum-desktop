import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { requestTeamSpaceIntent } from './intents'
import {
  CHANNEL_IDS,
  channelRoom,
  COMPANY_ID,
  OTHER_COMPANY_ID,
  platform,
  type Platform,
  renderTeamSpace,
  rerenderTeamSpace,
  resetTeamSpace,
  TestResizeObserver
} from './test-support'

vi.stubGlobal('ResizeObserver', TestResizeObserver)

const writeText = vi.fn(async (_text: string) => {})

beforeEach(() => {
  resetTeamSpace()
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
})

afterEach(cleanup)

const urlOf = (letter: string) => `https://atum.app/j/${letter.repeat(43)}`
const LINK_ID = '00000000-0000-4000-8000-05d9ec66b6d2'
const STUDIO = { id: COMPANY_ID, displayName: 'Atum Studio' }
const BETA = { id: OTHER_COMPANY_ID, displayName: 'Beta Works' }
const NOT_ALLOWED = 'Your role changed, so you can’t do this any more.'

/** The window learns what changed on the platform, as it does when it is focused again. */
const learn = () => act(() => void window.dispatchEvent(new Event('focus')))

async function ready(source: Platform) {
  const view = renderTeamSpace(source)
  await screen.findByRole('list', { name: 'Members' })

  return view
}

const openInvite = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Invite' }))

  return screen.findByRole('dialog', { name: /^Add people to / })
}

/** The one-time text of a link is drawn in this box; a dialog with no link made has none. */
const linkText = (dialog: HTMLElement) => dialog.querySelector('[data-matrix-company-invite-link-created]')

describe('an invite link’s text across companies', () => {
  it('goes with the dialog when another company is chosen under it, and is not in the next company’s dialog', async () => {
    const source = platform({ companies: [STUDIO, BETA] })
    await ready(source)

    const dialog = await openInvite()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy invite link' }))
    expect(await within(dialog).findByDisplayValue(urlOf('A'))).toBeTruthy()

    // A shortcut or a notification takes the window to the other company while the dialog is open.
    act(() => requestTeamSpaceIntent({ kind: 'switch-company', to: { slot: 2 } }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Add people to / })).toBeNull())
    expect(screen.queryByDisplayValue(urlOf('A'))).toBeNull()
    expect(document.body.textContent).not.toContain(urlOf('A'))

    // The other company's own dialog starts empty, and makes its own link.
    await screen.findByRole('heading', { name: 'Beta Works' })
    await screen.findByRole('list', { name: 'Members' })
    const betaDialog = await openInvite()
    expect(linkText(betaDialog)).toBeNull()
    fireEvent.click(within(betaDialog).getByRole('button', { name: 'Copy invite link' }))
    expect(await within(betaDialog).findByDisplayValue(urlOf('B'))).toBeTruthy()
    expect(screen.queryByDisplayValue(urlOf('A'))).toBeNull()

    // And back: the first company's text is not there.
    act(() => requestTeamSpaceIntent({ kind: 'switch-company', to: { slot: 1 } }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Add people to / })).toBeNull())
    expect(screen.queryByDisplayValue(urlOf('B'))).toBeNull()
    await screen.findByRole('list', { name: 'Members' })
    expect(linkText(await openInvite())).toBeNull()
  })

  it('also goes when a notification takes the window to another company: the dialog closes with the text', async () => {
    const source = platform({ companies: [STUDIO, BETA] })
    const view = renderTeamSpace(source, { preferredCompanyId: COMPANY_ID })
    await screen.findByRole('list', { name: 'Members' })

    const dialog = await openInvite()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy invite link' }))
    expect(await within(dialog).findByDisplayValue(urlOf('A'))).toBeTruthy()

    rerenderTeamSpace(view, source, { preferredCompanyId: OTHER_COMPANY_ID })

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Add people to / })).toBeNull())
    expect(screen.queryByDisplayValue(urlOf('A'))).toBeNull()
    expect(document.body.textContent).not.toContain(urlOf('A'))
  })

  it('closes every other dialog with the company too: an ownership hand-over, a removal, a new company', async () => {
    const source = platform({ companies: [STUDIO, BETA], canCreate: true })
    await ready(source)
    const menuOfLan = () =>
      within(within(screen.getByRole('list', { name: 'Members' })).getByText('Lan Nguyễn').closest('li') as HTMLElement).getByRole('button', { name: /^Actions for / })

    // A hand-over being decided. (A shortcut or a notification can move the window under a modal.)
    fireEvent.keyDown(menuOfLan(), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Make owner…' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
    act(() => requestTeamSpaceIntent({ kind: 'switch-company', to: { slot: 2 } }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await screen.findByRole('heading', { name: 'Beta Works' })

    // A removal being confirmed.
    await screen.findByRole('list', { name: 'Members' })
    fireEvent.keyDown(menuOfLan(), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove from company' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
    act(() => requestTeamSpaceIntent({ kind: 'switch-company', to: { slot: 1 } }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await screen.findByRole('heading', { name: 'Atum Studio' })

    // A company being named.
    fireEvent.keyDown(document.querySelector('[data-matrix-company-menu-trigger]')!, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add company' }))
    const naming = await screen.findByRole('dialog', { name: 'New company' })
    fireEvent.change(within(naming).getByLabelText('Company name'), { target: { value: 'Half named' } })
    act(() => requestTeamSpaceIntent({ kind: 'switch-company', to: { slot: 2 } }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(source.calls('create')).toHaveLength(0)
  })
})

describe('a replayed invite link', () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 86_400 * 7

  it('says on its row that its text can only be shown once, when the workspace’s Retry made it', async () => {
    let calls = 0
    const source = platform({ mutations: {
      'invite-link-create': () => {
        calls += 1

        return calls === 1
          ? { ok: false, error: 'unavailable' }
          : { ok: true, value: { schemaVersion: 3, replayed: true,
              link: { id: LINK_ID, role: 'member', state: 'active', createdAt: 1_800_000_000, expiresAt, maxUses: 10, uses: 0 } } }
      }
    } })

    await ready(source)
    const dialog = await openInvite()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy invite link' }))

    // The answer was lost: the request stays in the workspace's journal, and its banner offers Retry.
    const retry = await screen.findByRole('button', { name: 'Retry' })
    source.state.links.push({ id: LINK_ID, uses: 0, maxUses: 10, expiresAt })
    fireEvent.click(retry)

    await waitFor(() => expect(source.calls('invite-link-create')).toHaveLength(2))
    const [first, second] = source.calls('invite-link-create') as Array<{ requestId: string }>
    expect(second!.requestId).toBe(first!.requestId)

    // The dialog is still open: the link's row says it exists, cannot be shown again, and can be revoked.
    const row = (await within(dialog).findByText(/can only be shown once/)).closest('li') as HTMLElement
    expect(row.getAttribute('data-invite-link-id')).toBe(LINK_ID)
    expect(within(row).getByRole('button', { name: 'Revoke' })).toBeTruthy()
    expect(within(dialog).queryByDisplayValue(urlOf('A'))).toBeNull()
  })

  it('says the same on its row when the dialog’s own button got the replay', async () => {
    const source = platform({ mutations: {
      'invite-link-create': () => ({ ok: true, value: { schemaVersion: 3, replayed: true,
        link: { id: LINK_ID, role: 'member', state: 'active', createdAt: 1_800_000_000, expiresAt, maxUses: 10, uses: 0 } } })
    }, links: [{ id: LINK_ID, uses: 0, maxUses: 10, expiresAt }] })

    await ready(source)
    const dialog = await openInvite()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy invite link' }))

    expect(await within(dialog).findByText(/can only be shown once/)).toBeTruthy()
    expect(linkText(dialog)).toBeNull()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('still says it after the dialog is closed and opened again', async () => {
    const source = platform({ mutations: {
      'invite-link-create': () => ({ ok: true, value: { schemaVersion: 3, replayed: true,
        link: { id: LINK_ID, role: 'member', state: 'active', createdAt: 1_800_000_000, expiresAt, maxUses: 10, uses: 0 } } })
    }, links: [{ id: LINK_ID, uses: 0, maxUses: 10, expiresAt }] })

    await ready(source)
    const dialog = await openInvite()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy invite link' }))
    await within(dialog).findByText(/can only be shown once/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Add people to / })).toBeNull())

    expect(await within(await openInvite()).findByText(/can only be shown once/)).toBeTruthy()
  })
})

describe('a dialog that outlives the standing it was opened under', () => {
  it('stops offering the ownership hand-over when this person is no longer the owner, and sends nothing', async () => {
    const source = platform()
    const list = await ready(source).then(() => screen.getByRole('list', { name: 'Members' }))

    fireEvent.keyDown(within(within(list).getByText('Lan Nguyễn').closest('li') as HTMLElement).getByRole('button', { name: /^Actions for / }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Make owner…' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Make owner' }).hasAttribute('disabled')).toBe(false)

    // Meanwhile the company changed hands: this person is an admin now.
    source.state.viewer = 'admin'
    learn()

    expect(await within(dialog).findByText(NOT_ALLOWED)).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Make owner' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make owner' }))
    fireEvent.keyDown(dialog, { key: 'Enter' })
    expect(source.calls('ownership-transfer')).toHaveLength(0)

    // Cancel still works.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('stops offering an invitation when this person is demoted under the open invite dialog', async () => {
    const source = platform({ viewer: 'admin' })
    await ready(source)
    const dialog = await openInvite()
    fireEvent.change(within(dialog).getByLabelText('Name, @username or email'), { target: { value: 'quan_le' } })
    expect((await within(dialog).findByRole('button', { name: 'Add @quan_le' })).hasAttribute('disabled')).toBe(false)

    source.state.viewer = 'member'
    learn()

    expect(await within(dialog).findByText(NOT_ALLOWED)).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Add @quan_le' }).hasAttribute('disabled')).toBe(true)
    expect(within(dialog).queryByRole('button', { name: 'Copy invite link' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add @quan_le' }))
    fireEvent.keyDown(within(dialog).getByLabelText('Name, @username or email'), { key: 'Enter' })
    expect(source.calls('invitation-create')).toHaveLength(0)
    expect(source.calls('invite')).toHaveLength(0)
  })

  it('does not send an admin invitation under the name of someone who is no longer the owner', async () => {
    const source = platform({ mutations: {
      'invitation-create': () => ({ ok: false, error: 'unavailable' })
    } })

    await ready(source)
    const dialog = await openInvite()
    fireEvent.change(within(dialog).getByLabelText('Name, @username or email'), { target: { value: 'quan_le' } })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Admin' }))

    // The owner hands over: still an admin, no longer able to make admins. The role control goes.
    source.state.viewer = 'admin'
    learn()
    await waitFor(() => expect(within(dialog).queryByRole('radio', { name: 'Admin' })).toBeNull())

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add @quan_le' }))
    await waitFor(() => expect(source.calls('invitation-create')).toHaveLength(1))
    // What goes out is what the dialog shows: a member invitation.
    expect(source.calls('invitation-create')[0]).toMatchObject({ role: 'member' })
  })

  it('stops offering a removal when this person is demoted under its confirmation', async () => {
    const source = platform({ viewer: 'admin' })
    const list = await ready(source).then(() => screen.getByRole('list', { name: 'Members' }))

    fireEvent.keyDown(within(within(list).getByText('Lan Nguyễn').closest('li') as HTMLElement).getByRole('button', { name: /^Actions for / }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from company' }))
    const dialog = await screen.findByRole('dialog')

    source.state.viewer = 'member'
    learn()

    expect(await within(dialog).findByText(NOT_ALLOWED)).toBeTruthy()
    const confirm = within(dialog).getByRole('button', { name: 'Remove from company' })
    expect(confirm.hasAttribute('disabled')).toBe(true)
    fireEvent.click(confirm)
    expect(source.calls('remove-member')).toHaveLength(0)
  })

  it('closes a removal’s confirmation when the person it was about is already gone, rather than offer a moot removal', async () => {
    const source = platform()
    const list = await ready(source).then(() => screen.getByRole('list', { name: 'Members' }))

    fireEvent.keyDown(within(within(list).getByText('Lan Nguyễn').closest('li') as HTMLElement).getByRole('button', { name: /^Actions for / }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from company' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()

    // Lan left the company a moment ago.
    source.state.members = source.state.members.filter(entry => entry.key !== 'member')
    learn()

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(source.calls('remove-member')).toHaveLength(0)
  })

  it('stops offering Create channel when the policy closes under an open dialog, and sends nothing if forced', async () => {
    const general = { id: CHANNEL_IDS.general, name: 'general', systemKey: 'default' as const, actions: ['update_metadata' as const] }
    const source = platform({ viewer: 'member', channels: [general] })
    renderTeamSpace(source, { rooms: [channelRoom(general.id, general.name)] })
    await screen.findByRole('button', { name: 'Open # general' })
    const section = document.querySelector('[data-matrix-company-channels]') as HTMLElement
    await waitFor(() => expect(within(section).queryByRole('button', { name: 'Add channels' })).toBeTruthy())
    fireEvent.keyDown(within(section).getByRole('button', { name: 'Add channels' }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create a channel' }))
    const dialog = await screen.findByRole('dialog', { name: 'Create a channel' })
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'ops' } })
    expect(within(dialog).getByRole('button', { name: 'Create channel' }).hasAttribute('disabled')).toBe(false)

    // The owner sets channel creation to admins only.
    source.state.policy = 'admins_only'
    learn()

    expect(await within(dialog).findByText('Only the owner and admins can create channels.')).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Create channel' }).hasAttribute('disabled')).toBe(true)
    fireEvent.submit(within(dialog).getByLabelText('Name').closest('form')!)
    expect(source.calls('channel-command')).toHaveLength(0)
  })

  it('stops offering Archive when the platform no longer allows it, and sends nothing', async () => {
    const ops = { id: CHANNEL_IDS.ops, name: 'ops', ownerRef: 'x', actions: ['leave' as const, 'update_metadata' as const, 'archive' as const] }
    const source = platform({ channels: [{ id: CHANNEL_IDS.general, name: 'general', systemKey: 'default', actions: ['update_metadata'] }, ops] })
    renderTeamSpace(source, { rooms: [channelRoom(ops.id, ops.name)] })
    await screen.findByRole('button', { name: 'Open # ops' })
    await waitFor(() => expect(document.querySelector('[data-matrix-company-channels]')).toBeTruthy())

    act(() => requestTeamSpaceIntent({ kind: 'archive-channel', channelId: ops.id }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Archive channel' }).hasAttribute('disabled')).toBe(false)

    // Someone else archived it first (or took the right away).
    source.state.channels[1]!.actions = ['leave', 'update_metadata']
    learn()

    expect(await within(dialog).findByText(NOT_ALLOWED)).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Archive channel' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive channel' }))
    expect(source.calls('channel-command')).toHaveLength(0)
  })
})

describe('a change sent without a dialog', () => {
  it('is checked as it leaves too: a restore the platform no longer allows is refused in the banner, before anything is sent', async () => {
    const archived = { id: CHANNEL_IDS.old, name: 'old', state: 'archived' as const, actions: ['restore' as const] }
    const source = platform({ channels: [{ id: CHANNEL_IDS.general, name: 'general', systemKey: 'default', actions: ['update_metadata'] }, archived] })
    renderTeamSpace(source, { rooms: [channelRoom(CHANNEL_IDS.general, 'general')] })
    await screen.findByRole('button', { name: 'Open # general' })
    await waitFor(() => expect(document.querySelector('[data-matrix-company-channels]')).toBeTruthy())

    // The right to restore went (someone restored it first, or this person was demoted).
    source.state.channels[1]!.actions = []
    learn()
    await waitFor(() => expect(source.calls('admitted-channels').length).toBeGreaterThan(1))

    act(() => requestTeamSpaceIntent({ kind: 'restore-channel', channelId: archived.id }))

    expect(await screen.findByText(NOT_ALLOWED)).toBeTruthy()
    expect(document.querySelector('[data-matrix-company-not-allowed]')).toBeTruthy()
    expect(source.calls('channel-command')).toHaveLength(0)
  })
})

describe('a link that does not work', () => {
  it('says one thing for a link that is gone, whichever way it went', async () => {
    const source = platform({
      links: [{ id: LINK_ID, uses: 0, maxUses: 10, expiresAt: Math.floor(Date.now() / 1000) + 86_400 }],
      mutations: { 'invite-link-revoke': () => ({ ok: false, error: 'missing', reason: 'invite_link_unavailable' }) }
    })

    await ready(source)
    const dialog = await openInvite()
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Revoke' }))

    expect(await within(dialog).findByText(/^This invite link is invalid\./)).toBeTruthy()
    expect(dialog.textContent).not.toMatch(/expired|revoked|used up/i)
  })
})
