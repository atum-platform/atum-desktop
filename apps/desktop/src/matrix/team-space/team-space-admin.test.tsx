import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MatrixUiBridge } from '../../../shared/matrix'
import type { MatrixCompanyRequest } from '../../../shared/matrix-company'

import {
  CHANNEL_IDS,
  channelRoom,
  COMPANY_ID,
  OTHER_COMPANY_ID,
  platform,
  type Platform,
  REFS,
  renderTeamSpace,
  resetTeamSpace,
  TestResizeObserver
} from './test-support'

vi.stubGlobal('ResizeObserver', TestResizeObserver)

beforeEach(() => resetTeamSpace())
afterEach(cleanup)

const writeText = vi.fn(async (_text: string) => {})

beforeEach(() => {
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
})

/** Opens a Radix dropdown the way the rest of the suite does: from the keyboard. */
function openMenu(button: HTMLElement) {
  fireEvent.keyDown(button, { key: 'Enter' })
}

async function roster(source: Platform, expectBadges = true) {
  renderTeamSpace(source)
  const list = await screen.findByRole('list', { name: 'Members' })

  if (expectBadges) {
    await waitFor(() => expect(list.querySelector('[data-role-badge]')).toBeTruthy())
  }

  return list
}

const row = (list: HTMLElement, name: string) => within(list).getByText(name).closest('li') as HTMLElement
const menuOf = (item: HTMLElement) => within(item).getByRole('button', { name: /^Actions for / })

describe('C1 administration: what each role sees', () => {
  it('shows the owner, admins and members, and gives the owner a reason instead of a Leave that can only fail', async () => {
    const list = await roster(platform())
    const rows = within(list).getAllByRole('listitem')

    expect(rows.map(item => item.getAttribute('data-member-role'))).toEqual(['owner', 'admin', 'member'])
    expect(within(rows[0]!).getByText('Owner')).toBeTruthy()
    expect(within(rows[0]!).getByText('Make someone else the owner before you leave.')).toBeTruthy()
    expect(within(rows[0]!).queryByRole('button')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Leave company' })).toBeNull()
  })

  it('lets the owner promote, hand over and remove ordinary members, and only those things', async () => {
    const list = await roster(platform())
    openMenu(menuOf(row(list, 'Lan Nguyễn')))

    expect(screen.getByRole('menuitem', { name: 'Make admin' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Make owner…' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Remove from company' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Make member' })).toBeNull()
  })

  it('offers an admin only the removal of ordinary members: never roles, ownership, the owner or another admin', async () => {
    const list = await roster(platform({ viewer: 'admin' }))

    openMenu(menuOf(row(list, 'Lan Nguyễn')))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Remove from company'])
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    // The owner has nothing to act on, and an admin's own row offers only leaving.
    expect(within(row(list, 'Minh')).queryByRole('button')).toBeNull()
    openMenu(menuOf(row(list, 'Bảo')))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Leave company'])
  })

  it('gives a member no invitation, role or policy control, only their own way out', async () => {
    const list = await roster(platform({ viewer: 'member' }))

    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull()
    expect(screen.queryByRole('radiogroup', { name: 'Who can create channels' })).toBeNull()
    expect(within(row(list, 'Minh')).queryByRole('button')).toBeNull()
    expect(within(row(list, 'Bảo')).queryByRole('button')).toBeNull()
    openMenu(menuOf(row(list, 'Lan Nguyễn')))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Leave company'])
  })
})

describe('C1 role changes and ownership', () => {
  it('changes a role at the generation it was read at, then reads the administration snapshot again', async () => {
    const source = platform()
    const list = await roster(source)
    const before = source.calls('administration').length

    openMenu(menuOf(row(list, 'Lan Nguyễn')))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Make admin' }))

    await waitFor(() => expect(source.calls('role-change')).toHaveLength(1))
    expect(source.calls('role-change')[0]).toMatchObject({
      companyId: COMPANY_ID,
      memberRef: REFS.member,
      role: 'admin',
      expectedAuthorityGeneration: 7
    })
    await waitFor(() => expect(source.calls('administration').length).toBeGreaterThan(before))
  })

  it('transfers ownership only after an explicit confirmation that names the person and the company', async () => {
    const source = platform()
    const list = await roster(source)

    openMenu(menuOf(row(list, 'Lan Nguyễn')))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Make owner…' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Make Lan Nguyễn the owner?')).toBeTruthy()
    expect(dialog.textContent).toContain('Lan Nguyễn owns Atum Studio; you become an admin.')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(source.calls('ownership-transfer')).toHaveLength(0)

    openMenu(menuOf(row(list, 'Lan Nguyễn')))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Make owner…' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Make owner' }))

    await waitFor(() => expect(source.calls('ownership-transfer')).toHaveLength(1))
    expect(source.calls('ownership-transfer')[0]).toMatchObject({
      companyId: COMPANY_ID,
      targetMemberRef: REFS.member,
      expectedAuthorityGeneration: 7
    })
  })

  it('says in the dialog why a transfer was refused, and keeps the owner as the owner', async () => {
    const source = platform({
      mutations: {
        'ownership-transfer': () => ({ ok: false, error: 'conflict', reason: 'owner_generation_conflict' })
      }
    })

    const list = await roster(source)
    openMenu(menuOf(row(list, 'Lan Nguyễn')))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Make owner…' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Make owner' }))

    expect(await screen.findByText('The company changed while you were deciding. Check the list and try again.')).toBeTruthy()
    // A definitive refusal is not retried under another request id, and the roster is unchanged.
    expect(source.calls('ownership-transfer')).toHaveLength(1)
    expect(within(row(list, 'Minh')).getByText('Owner')).toBeTruthy()
  })

  it('shows a removal as “Removing…” until the platform has finished, with nothing to click', async () => {
    const source = platform({
      mutations: {
        'remove-member': input => {
          source.state.members[2]!.state = 'revoking'

          return { ok: true, value: { schemaVersion: 2, companyId: COMPANY_ID, memberRef: (input as { memberRef: string }).memberRef,
            state: 'revoking', authorityGeneration: 8 } }
        }
      }
    })

    const list = await roster(source)
    openMenu(menuOf(row(list, 'Lan Nguyễn')))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from company' }))
    fireEvent.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: 'Remove from company' }))

    await waitFor(() => expect(row(list, 'Lan Nguyễn').getAttribute('data-member-state')).toBe('revoking'))
    expect(within(row(list, 'Lan Nguyễn')).getByText('Removing…')).toBeTruthy()
    expect(within(row(list, 'Lan Nguyễn')).queryByRole('button')).toBeNull()
  })
})

describe('C1 invitations', () => {
  const now = Math.floor(Date.now() / 1000)

  const invitation = (id: string, role: 'admin' | 'member', handle: string, createdAt: number, expiresAt: number) => ({
    id,
    companyId: COMPANY_ID,
    targetHandle: handle,
    role,
    state: 'pending' as const,
    createdAt,
    expiresAt,
    inviter: { handle: 'minh', displayName: 'Minh' }
  })

  const waiting = [
    invitation('00000000-0000-4000-8000-2aaeca158aeb', 'member', 'tu_tran', now - 600, now + 86_400 * 5),
    invitation('00000000-0000-4000-8000-5c42c29ff6ed', 'admin', 'ha_vy', now - 700, now + 86_400 * 3),
    invitation('00000000-0000-4000-8000-3930c72168d2', 'member', 'old_timer', now - 86_400 * 8, now - 86_400)
  ]

  it('lists pending invitations with their expiry and lets the owner resend or cancel each', async () => {
    const source = platform({ invitations: waiting })
    await roster(source)
    const pending = await screen.findByRole('list', { name: 'Pending invitations' })

    expect(within(pending).getAllByRole('listitem')).toHaveLength(3)
    expect(within(pending).getByText(/Expires in 5 days/)).toBeTruthy()
    expect(within(pending).getByText(/^Expired/)).toBeTruthy()

    const target = within(pending).getByText('@tu_tran').closest('li') as HTMLElement
    fireEvent.click(within(target).getByRole('button', { name: 'Resend' }))
    await waitFor(() => expect(source.calls('invitation-resend')).toHaveLength(1))
    expect(source.calls('invitation-resend')[0]).toMatchObject({ companyId: COMPANY_ID, invitationId: waiting[0]!.id })
  })

  it('cancels a pending invitation by its id without removing anyone', async () => {
    const source = platform({ invitations: waiting, mutations: {
      'invitation-cancel': input => ({ ok: true, value: { schemaVersion: 4, replayed: false, invitation: { ...waiting[0]!, state: 'cancelled' as const, id: (input as { invitationId: string }).invitationId } } })
    } })

    await roster(source)
    const pending = await screen.findByRole('list', { name: 'Pending invitations' })
    const target = within(pending).getByText('@tu_tran').closest('li') as HTMLElement
    fireEvent.click(within(target).getByRole('button', { name: /^Cancel invitation: @tu_tran$/ }))

    await waitFor(() => expect(source.calls('invitation-cancel')).toHaveLength(1))
    expect(source.calls('invitation-cancel')[0]).toMatchObject({ invitationId: waiting[0]!.id })
    expect(source.calls('remove-member')).toHaveLength(0)
  })

  it('leaves an admin invitation to the owner: an admin sees neither resend nor cancel on it', async () => {
    await roster(platform({ viewer: 'admin', invitations: waiting }))
    const pending = await screen.findByRole('list', { name: 'Pending invitations' })
    const adminInvite = within(pending).getByText('@ha_vy').closest('li') as HTMLElement
    const memberInvite = within(pending).getByText('@tu_tran').closest('li') as HTMLElement

    expect(within(adminInvite).queryByRole('button')).toBeNull()
    expect(within(memberInvite).getAllByRole('button')).toHaveLength(2)
  })

  it('invites by handle as a member, or as an admin when the owner chooses it', async () => {
    const source = platform({ mutations: {
      'invitation-create': input => ({ ok: true, value: { schemaVersion: 4, replayed: false, authorityGeneration: 7,
        invitation: { ...waiting[0]!, role: (input as { role: 'admin' | 'member' }).role, targetHandle: 'quan_le' } } })
    } })

    await roster(source)
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    const dialog = await screen.findByRole('dialog', { name: /^Add people to / })
    fireEvent.change(within(dialog).getByLabelText('Name, @username or email'), { target: { value: '@Quan_Le' } })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Admin' }))
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add @quan_le' }))

    await waitFor(() => expect(source.calls('invitation-create')).toHaveLength(1))
    expect(source.calls('invitation-create')[0]).toMatchObject({ companyId: COMPANY_ID, memberHandle: '@Quan_Le', role: 'admin' })
    expect(source.calls('invite')).toHaveLength(0)
    expect(await within(dialog).findByText('Invited @quan_le. They’ll see it in Atum.')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'Add @quan_le' })).toBeNull()
  })

  /** The people bridge answering every query with these directory results. */
  function people(results: Array<{ userId: string; name: string; handle?: string }>) {
    const search = vi.fn(async () => ({ ok: true as const, value: { limited: false, results } }))
    window.atumMatrix = {
      people: {
        search,
        privacy: vi.fn(async () => ({ ok: true as const, enabled: true })),
        setPrivacy: vi.fn(async enabled => ({ ok: true as const, enabled }))
      }
    } as unknown as MatrixUiBridge

    return search
  }

  /** A 1.10 platform: the person is resolved from the Matrix user ID and may have no handle. */
  const directoryPlatform = () => platform({ mutations: {
    'invitation-create-directory': input => ({ ok: true, value: { schemaVersion: 11, replayed: false, authorityGeneration: 7,
      invitation: { ...waiting[0]!, role: (input as { role: 'admin' | 'member' }).role, targetHandle: null } } })
  } })

  it('invites a name-only match by the Matrix user ID the directory answered with', async () => {
    const search = people([{ userId: '@opaque-person:test', name: 'Poon Nguyen' }])
    const source = directoryPlatform()

    await roster(source)
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    const dialog = await screen.findByRole('dialog', { name: /^Add people to / })
    fireEvent.change(within(dialog).getByLabelText('Name, @username or email'), { target: { value: 'Poon Nguyen' } })

    await waitFor(() => expect(search).toHaveBeenCalledWith({ query: 'Poon Nguyen', limit: 20 }))
    // One press adds: no pick-then-send step.
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add Poon Nguyen' }))

    await waitFor(() => expect(source.calls('invitation-create-directory')).toHaveLength(1))
    expect(source.calls('invitation-create-directory')[0]).toEqual({ action: 'invitation-create-directory',
      companyId: COMPANY_ID, requestId: expect.any(String), memberMatrixUser: '@opaque-person:test', role: 'member' })
    expect(source.calls('invitation-create')).toHaveLength(0)
    expect(await within(dialog).findByText('Invited Poon Nguyen. They’ll see it in Atum.')).toBeTruthy()
  })

  it('invites by exact email through the server-side directory match, never sending the address or a handle', async () => {
    const search = people([{ userId: '@user-0123456789abcdef:test', name: 'Poon Nguyen' }])
    const source = directoryPlatform()

    await roster(source)
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    const dialog = await screen.findByRole('dialog', { name: /^Add people to / })
    fireEvent.change(within(dialog).getByLabelText('Name, @username or email'), { target: { value: 'poon@example.com' } })

    await waitFor(() => expect(search).toHaveBeenCalledWith({ query: 'poon@example.com', limit: 20 }))
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add Poon Nguyen' }))
    // The person's row says the address that found them, so it is told apart from anyone with the same name.
    expect(within(dialog).getByText('poon@example.com')).toBeTruthy()

    await waitFor(() => expect(source.calls('invitation-create-directory')).toHaveLength(1))
    const sent = source.calls('invitation-create-directory')[0]!
    expect(sent).toMatchObject({ memberMatrixUser: '@user-0123456789abcdef:test', role: 'member' })
    expect(JSON.stringify(sent)).not.toContain('poon@example.com')
    expect(sent).not.toHaveProperty('memberHandle')
  })

  it('sends an exact-handle pick by its Matrix user ID too, so the platform resolves the person itself', async () => {
    people([{ userId: '@opaque-person:test', name: '@poon', handle: 'poon' }])
    const source = directoryPlatform()

    await roster(source)
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    const dialog = await screen.findByRole('dialog', { name: /^Add people to / })
    fireEvent.change(within(dialog).getByLabelText('Name, @username or email'), { target: { value: '@poon' } })
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add @poon' }))

    await waitFor(() => expect(source.calls('invitation-create-directory')).toHaveLength(1))
    expect(source.calls('invitation-create-directory')[0]).toMatchObject({ memberMatrixUser: '@opaque-person:test' })
    expect(source.calls('invitation-create')).toHaveLength(0)
  })

  it('never sends a pick made in one company into another company', async () => {
    people([{ userId: '@opaque-person:test', name: 'Poon Nguyen' }])

    const source = platform({ companies: [{ id: COMPANY_ID, displayName: 'Atum Studio' },
      { id: OTHER_COMPANY_ID, displayName: 'Beta Works' }], mutations: {
      'invitation-create-directory': input => ({ ok: true, value: { schemaVersion: 11, replayed: false, authorityGeneration: 7,
        invitation: { ...waiting[0]!, companyId: (input as { companyId: string }).companyId, targetHandle: null } } })
    } })

    await roster(source)
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    let dialog = await screen.findByRole('dialog', { name: 'Add people to Atum Studio' })
    fireEvent.change(within(dialog).getByLabelText('Name, @username or email'), { target: { value: 'Poon Nguyen' } })
    expect(await within(dialog).findByRole('button', { name: 'Add Poon Nguyen' })).toBeTruthy()

    // The selection moves to Beta Works while the sheet is open: the sheet, and what was typed in it, go.
    fireEvent.keyDown(window.document.querySelector('[data-matrix-company-menu-trigger]')!, { key: 'Enter' })
    fireEvent.click(screen.getAllByRole('menuitemradio')[1]!)
    expect(await screen.findByRole('heading', { name: 'Beta Works' })).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add people to Atum Studio' })).toBeNull())
    expect(source.calls('invitation-create-directory')).toHaveLength(0)

    // Added in Beta Works, the invitation is for Beta Works only.
    fireEvent.click(await screen.findByRole('button', { name: 'Invite' }))
    dialog = await screen.findByRole('dialog', { name: 'Add people to Beta Works' })
    expect((within(dialog).getByLabelText('Name, @username or email') as HTMLInputElement).value).toBe('')
    fireEvent.change(within(dialog).getByLabelText('Name, @username or email'), { target: { value: 'Poon Nguyen' } })
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add Poon Nguyen' }))
    await waitFor(() => expect(source.calls('invitation-create-directory')).toHaveLength(1))
    expect(source.calls('invitation-create-directory')[0]).toMatchObject({ companyId: OTHER_COMPANY_ID,
      memberMatrixUser: '@opaque-person:test' })
  })

  it('gives a typed handle the directory did not show its own row, invited by that handle', async () => {
    people([{ userId: '@opaque-person:test', name: 'Poon Nguyen' }])
    const source = directoryPlatform()

    await roster(source)
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    const dialog = await screen.findByRole('dialog', { name: /^Add people to / })
    fireEvent.change(within(dialog).getByLabelText('Name, @username or email'), { target: { value: '@quan_le' } })
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add @quan_le' }))

    await waitFor(() => expect(source.calls('invitation-create')).toHaveLength(1))
    expect(source.calls('invitation-create')[0]).toMatchObject({ memberHandle: '@quan_le' })
    expect(source.calls('invitation-create-directory')).toHaveLength(0)
  })

  it('never offers an admin the admin role: an admin invites members only', async () => {
    await roster(platform({ viewer: 'admin' }))
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    const dialog = await screen.findByRole('dialog', { name: /^Add people to / })

    expect(within(dialog).queryByRole('radio', { name: 'Admin' })).toBeNull()
  })

  it('declines an invitation addressed to the viewer on the platform, not just on this screen', async () => {
    const invitationId = '00000000-0000-4000-8000-4af9a86e17b6'

    const source = platform({ mutations: {
      list: () => ({ ok: true, value: { schemaVersion: 2, canCreate: false, companies: [],
        invitations: [{ id: invitationId, companyId: '00000000-0000-4000-8000-0535bd89d837', displayName: 'Other Co', role: 'member',
          inviter: { handle: 'minh', displayName: 'Minh' } }] } }),
      'invitation-decline': input => ({ ok: true, value: { schemaVersion: 4, replayed: false, invitation: { ...waiting[0]!,
        id: (input as { invitationId: string }).invitationId, state: 'declined' as const } } })
    } })

    renderTeamSpace(source)
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }))

    await waitFor(() => expect(source.calls('invitation-decline')).toHaveLength(1))
    expect(source.calls('invitation-decline')[0]).toMatchObject({ companyId: '00000000-0000-4000-8000-0535bd89d837', invitationId })
  })

  it('accepts a handle invitation and converges into the company default channel without invite links', async () => {
    const invitationId = '00000000-0000-4000-8000-69f40a63bebd'
    let accepted = false
    const onOpenChannel = vi.fn(async () => {})
    const source = platform({ companies: [], canCreate: false, mutations: {
      list: () => ({ ok: true, value: { schemaVersion: 2, canCreate: false,
        invitations: accepted ? [] : [{ id: invitationId, companyId: COMPANY_ID, displayName: 'Atum Studio', role: 'member',
          inviter: { handle: 'minh', displayName: 'Minh' } }],
        companies: accepted ? [{ id: COMPANY_ID, displayName: 'Atum Studio', role: 'member', authorityGeneration: 7 }] : [] } }),
      accept: () => {
        accepted = true

        return { ok: true, value: { schemaVersion: 2, defaultChannelId: CHANNEL_IDS.general, projects: [],
          company: { id: COMPANY_ID, displayName: 'Atum Studio', role: 'member', authorityGeneration: 7 },
          members: [{ memberRef: REFS.member, role: 'member', state: 'active', self: true,
            handle: 'lan_nguyen', displayName: 'Lan Nguyễn' }] } }
      }
    } })

    renderTeamSpace(source, {
      convergenceDelayMs: 1,
      onOpenChannel,
      rooms: [channelRoom(CHANNEL_IDS.general, 'general')]
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Join' }))

    await waitFor(() => expect(source.calls('accept')).toHaveLength(1))
    expect(source.calls('accept')[0]).toMatchObject({ companyId: COMPANY_ID, invitationId })
    await waitFor(() => expect(onOpenChannel).toHaveBeenCalledWith('!general:atum.example', expect.any(Function)))
  })
})

describe('C1 invite links and the channel-creation policy', () => {
  it('makes a member-only link on one press, copies it, shows it once, and revokes it by id', async () => {
    const source = platform()
    await roster(source)
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    const dialog = await screen.findByRole('dialog', { name: /^Add people to / })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy invite link' }))

    await waitFor(() => expect(source.calls('invite-link-create')).toHaveLength(1))
    expect(source.calls('invite-link-create')[0]).toMatchObject({ companyId: COMPANY_ID, role: 'member' })
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`https://atum.app/j/${'A'.repeat(43)}`))
    expect(await within(dialog).findByText('Link copied')).toBeTruthy()
    expect((within(dialog).getByLabelText('Copy invite link', { selector: 'input' }) as HTMLInputElement).value)
      .toBe(`https://atum.app/j/${'A'.repeat(43)}`)
    // One short line under the link: how long and for how many. Who can use it is the tooltip.
    expect(dialog.textContent).toMatch(/Works for \d+ days\. Up to 10 people can use it\./u)
    expect(dialog.querySelector('[title="Anyone with this link can join as a member."]')).toBeTruthy()

    source.state.links.push({ id: '00000000-0000-4000-8000-05d9ec66b6d2', uses: 2, maxUses: 10, expiresAt: Math.floor(Date.now() / 1000) + 86_400 * 4 })
    source.state.mutations['invite-link-revoke'] = input => ({ ok: true, value: { schemaVersion: 3, linkId: (input as { linkId: string }).linkId,
      state: 'revoked', revokedAt: 1_800_000_100, replayed: false } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy invite link' }))
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Revoke' })).toBeTruthy())
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(source.calls('invite-link-revoke')).toHaveLength(1))
    expect(source.calls('invite-link-revoke')[0]).toMatchObject({ linkId: '00000000-0000-4000-8000-05d9ec66b6d2' })
  })

  it('says when the link was made but could not be copied, and still shows it to copy by hand', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    await roster(platform())
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    const dialog = await screen.findByRole('dialog', { name: /^Add people to / })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy invite link' }))

    expect(await within(dialog).findByText(/Couldn’t copy it automatically/)).toBeTruthy()
    expect((within(dialog).getByLabelText('Copy invite link', { selector: 'input' }) as HTMLInputElement).value).toMatch(/^https:\/\/atum\.app\/j\//)
  })

  it('does not offer a link to anyone who cannot make one', async () => {
    await roster(platform({ viewer: 'member' }))
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull()
  })

  it('changes who can create channels at the generation it was read at, and rolls back with the reason when refused', async () => {
    const source = platform()
    await roster(source)
    const group = await screen.findByRole('radiogroup', { name: 'Who can create channels' })
    expect(within(group).getByRole('radio', { name: 'Everyone' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(within(group).getByRole('radio', { name: 'Owner and admins' }))
    await waitFor(() => expect(source.calls('policy-update')).toHaveLength(1))
    expect(source.calls('policy-update')[0]).toMatchObject({
      companyId: COMPANY_ID,
      policy: { channelCreation: 'admins_only' },
      expectedAuthorityGeneration: 7
    })
  })

  it('rolls the policy back and says why when the platform refuses it', async () => {
    const source = platform({ mutations: { 'policy-update': () => ({ ok: false, error: 'conflict', reason: 'owner_generation_conflict' }) } })
    await roster(source)
    const group = await screen.findByRole('radiogroup', { name: 'Who can create channels' })

    fireEvent.click(within(group).getByRole('radio', { name: 'Owner and admins' }))

    expect(await screen.findByText('The company changed while you were deciding. Check the list and try again.')).toBeTruthy()
    await waitFor(() => expect(within(group).getByRole('radio', { name: 'Everyone' }).getAttribute('aria-checked')).toBe('true'))
  })
})

describe('C1 against older or switched-off servers', () => {
  const legacyRequests = (source: Platform): MatrixCompanyRequest['action'][] =>
    source.request.mock.calls.map(([input]) => (input as MatrixCompanyRequest).action)

  it.each(['missing', 'inactive', 'unavailable', 'channels-only'] as const)(
    'with discovery %s the roster is the 1.1 one: two roles, text buttons, no administration read',
    async discovery => {
      const source = platform({ discovery, viewer: 'admin' })
      const list = await roster(source, false)
      await waitFor(() => expect(source.calls('capabilities')).toHaveLength(1))
      await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3))

      expect(list.querySelector('[data-role-badge]')).toBeTruthy()
      expect(within(list).queryByText('Owner')).toBeNull()
      // The 1.1 client's controls, exactly: text buttons, no menu, no policy, no pending list.
      expect(within(list).getAllByRole('button', { name: 'Remove from company' }).length).toBeGreaterThan(0)
      expect(within(list).queryByRole('button', { name: /^Actions for / })).toBeNull()
      expect(screen.queryByRole('radiogroup', { name: 'Who can create channels' })).toBeNull()
      expect(screen.queryByRole('list', { name: 'Pending invitations' })).toBeNull()
      expect(legacyRequests(source)).not.toContain('administration')
    }
  )

  it('invites with the 1.1 invitation and no role choice or link on a server without C1', async () => {
    const source = platform({ discovery: 'missing', viewer: 'admin', mutations: {
      invite: () => ({ ok: true, value: { schemaVersion: 2, companyId: COMPANY_ID, company: { id: COMPANY_ID, displayName: 'Atum Studio', role: 'admin', authorityGeneration: 8 },
        members: [], projects: [], defaultChannelId: null } as never })
    } })

    await roster(source, false)
    await waitFor(() => expect(source.calls('capabilities')).toHaveLength(1))
    fireEvent.click(await screen.findByRole('button', { name: 'Invite' }))
    const dialog = await screen.findByRole('dialog', { name: /^Add people to / })

    expect(within(dialog).queryByRole('radiogroup')).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Copy invite link' })).toBeNull()
    fireEvent.change(within(dialog).getByLabelText('Name, @username or email'), { target: { value: 'quan_le' } })
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add @quan_le' }))

    await waitFor(() => expect(source.calls('invite')).toHaveLength(1))
    expect(source.calls('invite')[0]).toMatchObject({ memberHandle: 'quan_le', role: 'member' })
    expect(source.calls('invitation-create')).toHaveLength(0)
  })

  it('draws no Decline on a server without C1: “Not now” is the only way out', async () => {
    const source = platform({ discovery: 'missing', mutations: {
      list: () => ({ ok: true, value: { schemaVersion: 2, canCreate: false, companies: [],
        invitations: [{ id: '00000000-0000-4000-8000-4af9a86e17b6', companyId: '00000000-0000-4000-8000-0535bd89d837', displayName: 'Other Co', role: 'member',
          inviter: { handle: 'minh', displayName: 'Minh' } }] } })
    } })

    renderTeamSpace(source)
    expect(await screen.findByRole('button', { name: 'Not now' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull()
  })
})
