import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MatrixUiBridge } from '../../../shared/matrix'
import type { MatrixCompanyRequest, MatrixCompanyResult } from '../../../shared/matrix-company'
import type { CompanyInviteCapabilities } from '../../../shared/matrix-company-team-space'

import { inviteEmailOf, inviteHandleOf, inviteStanding } from './invite-sheet'
import { COMPANY_ID, platform, type Platform, renderTeamSpace, resetTeamSpace, TestResizeObserver } from './test-support'

vi.stubGlobal('ResizeObserver', TestResizeObserver)

beforeEach(() => resetTeamSpace())
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

const now = Math.floor(Date.now() / 1000)
const SEARCH = 'Name, @username or email'

const READY: CompanyInviteCapabilities = {
  schemaVersion: 1,
  directoryInvite: 'ready',
  emailInvite: 'delivery_unavailable',
  emailCreation: 'ready',
  emailDelivery: 'not_implemented',
  inviteLink: 'ready',
  emailAutoClaim: 'verification_required'
}

const pendingTu = {
  id: '00000000-0000-4000-8000-2aaeca158aeb',
  companyId: COMPANY_ID,
  targetHandle: 'tu_tran',
  role: 'member' as const,
  state: 'pending' as const,
  createdAt: now - 600,
  expiresAt: now + 86_400 * 5,
  inviter: { handle: 'minh', displayName: 'Minh' }
}

/** The people bridge answering every query with these directory results. */
function people(results: Array<{ userId: string; name: string; handle?: string }>) {
  const search = vi.fn(async () => ({ ok: true as const, value: { limited: false, results } }))

  window.atumMatrix = {
    people: {
      search,
      privacy: vi.fn(async () => ({ ok: true as const, enabled: true })),
      setPrivacy: vi.fn(async (enabled: boolean) => ({ ok: true as const, enabled }))
    }
  } as unknown as MatrixUiBridge

  return search
}

const directoryReceipt = (input: MatrixCompanyRequest): MatrixCompanyResult => ({ ok: true, value: { schemaVersion: 11, replayed: false,
  authorityGeneration: 7, invitation: { ...pendingTu, id: '00000000-0000-4000-8000-ae985e49793d',
    role: (input as { role: 'admin' | 'member' }).role, targetHandle: null } } } as MatrixCompanyResult)

const emailReceipt = (): MatrixCompanyResult => ({ ok: true, value: { schemaVersion: 10,
  invitationId: '00000000-0000-4000-8000-662b4919353f', state: 'accepted', mailStatus: 'accepted', expiresAt: now + 86_400 * 7,
  replayed: false } } as MatrixCompanyResult)

async function openSheet(source: Platform) {
  renderTeamSpace(source)
  await screen.findByRole('list', { name: 'Members' })
  fireEvent.click(await screen.findByRole('button', { name: 'Invite' }))

  return screen.findByRole('dialog', { name: 'Add people to Atum Studio' })
}

const type = (dialog: HTMLElement, value: string) =>
  fireEvent.change(within(dialog).getByLabelText(SEARCH), { target: { value } })

describe('reading what was typed', () => {
  it('takes a complete email lowercased, a handle without its @, and nothing else', () => {
    expect(inviteEmailOf('  Lan@Example.COM ')).toBe('lan@example.com')
    expect(inviteEmailOf('lan@example')).toBeUndefined()
    expect(inviteEmailOf('lan')).toBeUndefined()
    expect(inviteHandleOf('@Lan_Nguyen')).toBe('lan_nguyen')
    expect(inviteHandleOf('Lan Nguyen')).toBeUndefined()
    expect(inviteHandleOf('lan@example.com')).toBeUndefined()
  })

  it('knows a person is already in the company or already invited by their handle', () => {
    const roster = [{ memberRef: 'r', role: 'member' as const, state: 'active' as const, self: false, handle: 'lan', displayName: 'Lan' }]
    const invitations = [{ id: 'i', targetHandle: 'tu', role: 'member' as const, createdAt: 1, expiresAt: 2, inviter: { handle: null, displayName: null }, expired: false }]

    expect(inviteStanding('lan', roster, invitations)).toBe('member')
    expect(inviteStanding('tu', roster, invitations)).toBe('invited')
    expect(inviteStanding('tu', roster, [{ ...invitations[0]!, expired: true }])).toBe('none')
    expect(inviteStanding(undefined, roster, invitations)).toBe('none')
  })
})

describe('Add people', () => {
  it('tells two people with one name apart by @handle, and says who is already in or already invited', async () => {
    people([
      { userId: '@lan:test', name: 'Lan Nguyễn', handle: 'lan_nguyen' },
      { userId: '@lan2:test', name: 'Lan Nguyễn', handle: 'lan_pham' },
      { userId: '@tu:test', name: 'Tú Trần', handle: 'tu_tran' }
    ])

    const dialog = await openSheet(platform({ invitations: [pendingTu] }))
    type(dialog, 'lan')

    const list = await within(dialog).findByRole('list', { name: 'Add people to Atum Studio' })
    const rows = within(list).getAllByRole('listitem')

    expect(rows).toHaveLength(3)
    expect(within(rows[0]!).getByText('@lan_nguyen')).toBeTruthy()
    expect(within(rows[0]!).getByText('Already a member')).toBeTruthy()
    expect(within(rows[0]!).queryByRole('button')).toBeNull()
    expect(within(rows[1]!).getByText('@lan_pham')).toBeTruthy()
    expect(within(rows[1]!).getByRole('button', { name: 'Add Lan Nguyễn' })).toBeTruthy()
    expect(within(rows[2]!).getByText('Invited')).toBeTruthy()
    // Pending invitations sit in the sheet itself.
    expect(within(dialog).getByRole('list', { name: 'Pending invitations' })).toBeTruthy()
    expect(within(within(dialog).getByRole('list', { name: 'Pending invitations' })).getByText('@tu_tran')).toBeTruthy()
  })

  it('adds with one press and says so on the row, without closing the sheet', async () => {
    people([{ userId: '@lan2:test', name: 'Lan Phạm', handle: 'lan_pham' }])
    const source = platform({ mutations: { 'invitation-create-directory': directoryReceipt } })
    const dialog = await openSheet(source)

    type(dialog, 'lan')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add Lan Phạm' }))

    await waitFor(() => expect(source.calls('invitation-create-directory')).toHaveLength(1))
    expect(await within(dialog).findByText('Invited Lan Phạm. They’ll see it in Atum.')).toBeTruthy()
    expect(dialog.querySelector('[data-invite-row-result="invited"]')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'Add Lan Phạm' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Add people to Atum Studio' })).toBe(dialog)
  })

  it('adds on Enter only when exactly one person can be added', async () => {
    people([
      { userId: '@a:test', name: 'An Phạm', handle: 'an_pham' },
      { userId: '@b:test', name: 'An Phạm', handle: 'an_pham2' }
    ])
    const source = platform({ mutations: { 'invitation-create-directory': directoryReceipt } })
    const dialog = await openSheet(source)

    type(dialog, 'An Phạm')
    await within(dialog).findAllByRole('button', { name: 'Add An Phạm' })
    fireEvent.keyDown(within(dialog).getByLabelText(SEARCH), { key: 'Enter' })
    expect(source.calls('invitation-create-directory')).toHaveLength(0)
  })

  it('adds the one person found on Enter', async () => {
    people([{ userId: '@a:test', name: 'An Phạm', handle: 'an_pham' }])
    const source = platform({ mutations: { 'invitation-create-directory': directoryReceipt } })
    const dialog = await openSheet(source)

    type(dialog, 'An Phạm')
    await within(dialog).findByRole('button', { name: 'Add An Phạm' })
    fireEvent.keyDown(within(dialog).getByLabelText(SEARCH), { key: 'Enter' })

    await waitFor(() => expect(source.calls('invitation-create-directory')).toHaveLength(1))
    expect(source.calls('invitation-create-directory')[0]).toMatchObject({ memberMatrixUser: '@a:test' })
  })

  it('says plainly when the company lets only owners and admins invite', async () => {
    people([{ userId: '@lan2:test', name: 'Lan Phạm', handle: 'lan_pham' }])
    const source = platform({ mutations: { 'invitation-create-directory': () => ({ ok: false, error: 'denied' }) } })
    const dialog = await openSheet(source)

    type(dialog, 'lan')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add Lan Phạm' }))

    expect(await within(dialog).findByText('Only owners and admins can invite people here.')).toBeTruthy()
    expect(dialog.querySelector('[data-invite-row-result="failed"]')).toBeTruthy()
  })

  it('says it cannot invite someone the platform will not resolve, without guessing why', async () => {
    people([{ userId: '@lan2:test', name: 'Lan Phạm', handle: 'lan_pham' }])
    const source = platform({ mutations: {
      'invitation-create-directory': () => ({ ok: false, error: 'missing', reason: 'invitation_unavailable' })
    } })
    const dialog = await openSheet(source)

    type(dialog, 'lan')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add Lan Phạm' }))

    expect(await within(dialog).findByText('Can’t invite them. They may already be invited.')).toBeTruthy()
  })
})

describe('Add people by email', () => {
  it('offers one email row when no one answers to the address, and says invited, never sent', async () => {
    people([])
    const source = platform({ inviteReadiness: READY, mutations: { 'email-invitation-create': emailReceipt } })
    const dialog = await openSheet(source)

    type(dialog, 'Lan@Example.com')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add lan@example.com' }))

    await waitFor(() => expect(source.calls('email-invitation-create')).toHaveLength(1))
    expect(source.calls('email-invitation-create')[0]).toEqual({ action: 'email-invitation-create', companyId: COMPANY_ID,
      requestId: expect.any(String), email: 'lan@example.com', locale: 'en' })

    const status = await within(dialog).findByText(/Invited lan@example\.com by email\./u)
    expect(status.textContent).toContain('No email goes out yet, so send them the invite link.')
    expect(dialog.textContent).not.toMatch(/email sent|sent an email/iu)
    // The new invitation is listed with the others for this opening of the sheet.
    const pending = within(dialog).getByRole('list', { name: 'Pending invitations' })
    expect(within(pending).getByText('lan@example.com')).toBeTruthy()
    expect(within(pending).getByText(/By email/u)).toBeTruthy()
  })

  it('invites the person an exact email found, by their Matrix ID, and offers no second email row', async () => {
    people([{ userId: '@lan2:test', name: 'Lan Phạm', handle: 'lan_pham' }])
    const source = platform({ inviteReadiness: READY, mutations: { 'invitation-create-directory': directoryReceipt } })
    const dialog = await openSheet(source)

    type(dialog, 'lan@example.com')
    const row = await within(dialog).findByRole('button', { name: 'Add Lan Phạm' })
    expect(within(dialog).queryByRole('button', { name: 'Add lan@example.com' })).toBeNull()
    expect(within(dialog).getByText('@lan_pham')).toBeTruthy()
    expect(within(dialog).getByText('lan@example.com')).toBeTruthy()
    fireEvent.click(row)

    await waitFor(() => expect(source.calls('invitation-create-directory')).toHaveLength(1))
    expect(source.calls('email-invitation-create')).toHaveLength(0)
  })

  it('points to the invite link when the server does not take email invitations yet', async () => {
    people([])
    const dialog = await openSheet(platform({ inviteReadiness: { ...READY, emailCreation: 'not_configured', emailInvite: 'not_configured' } }))

    type(dialog, 'lan@example.com')

    expect(await within(dialog).findByText('Email invites aren’t on yet. Send the invite link instead.')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'Add lan@example.com' })).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Copy invite link' })).toBeTruthy()
  })

  it('offers no email row on a server that predates invite readiness, and points to the link', async () => {
    people([])
    const dialog = await openSheet(platform())

    type(dialog, 'lan@example.com')

    expect(await within(dialog).findByText('Email invites aren’t on yet. Send the invite link instead.')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'Add lan@example.com' })).toBeNull()
  })

  it('shows the platform’s reason when an email invitation is refused', async () => {
    people([])
    const source = platform({ inviteReadiness: READY, mutations: {
      'email-invitation-create': () => ({ ok: false, error: 'limit', reason: 'email_invite_limited' })
    } })
    const dialog = await openSheet(source)

    type(dialog, 'lan@example.com')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add lan@example.com' }))

    expect(await within(dialog).findByText('Too many invitations. Try again in a few minutes.')).toBeTruthy()
  })
})

describe('who may invite (company policy 1.2)', () => {
  it('lets a member invite as a member when the company allows it: no role choice, no Revoke', async () => {
    people([{ userId: '@lan2:test', name: 'Lan Phạm', handle: 'lan_pham' }])

    const source = platform({ viewer: 'member', invitePolicy: 'members', inviteReadiness: READY,
      links: [{ id: '00000000-0000-4000-8000-05d9ec66b6d2', uses: 1, maxUses: 10, expiresAt: now + 86_400 * 3 }],
      mutations: { 'invitation-create-directory': directoryReceipt } })

    const dialog = await openSheet(source)

    expect(within(dialog).queryByRole('radio', { name: 'Admin' })).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Copy invite link' })).toBeTruthy()
    await waitFor(() => expect(dialog.querySelector('[data-invite-link-id]')).toBeTruthy())
    expect(within(dialog).queryByRole('button', { name: 'Revoke' })).toBeNull()

    type(dialog, 'lan')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add Lan Phạm' }))
    await waitFor(() => expect(source.calls('invitation-create-directory')).toHaveLength(1))
    expect(source.calls('invitation-create-directory')[0]).toMatchObject({ role: 'member' })
  })

  it('says no one matches, and nothing else, for someone who may not make links', async () => {
    people([])
    const dialog = await openSheet(platform({ viewer: 'member', invitePolicy: 'members',
      inviteReadiness: { ...READY, emailCreation: 'not_configured', inviteLink: 'not_configured' } }))

    type(dialog, 'lan@example.com')

    expect(await within(dialog).findByText('No one matches that.')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'Copy invite link' })).toBeNull()
  })

  it('gives a member no Invite at all when the company keeps invitations to owners and admins', async () => {
    renderTeamSpace(platform({ viewer: 'member', invitePolicy: 'admins', inviteReadiness: READY }))
    await screen.findByRole('list', { name: 'Members' })

    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull()
  })

  it('falls back to the 1.3 administration read when the server refuses policy 1.2, and keeps working', async () => {
    const source = platform()
    renderTeamSpace(source)
    await screen.findByRole('list', { name: 'Members' })

    // Policy 1.3, then 1.2, each refused (400) by this older server, then the plain read.
    await waitFor(() => expect(source.calls('administration')).toHaveLength(1))
    expect(source.calls('administration-policy').map(call => (call as { profile?: string }).profile)).toEqual(['1.3', undefined])
  })
})
