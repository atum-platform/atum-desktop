import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MatrixUiBridge } from '../../../shared/matrix'
import type { MatrixCompanyRequest, MatrixCompanyResult } from '../../../shared/matrix-company'
import type { CompanyInviteCapabilities, CompanyInviteCapabilities3 } from '../../../shared/matrix-company-team-space'

import { addModeOf, memberAddResult } from './invite-sheet'
import { COMPANY_ID, platform, type Platform, renderTeamSpace, resetTeamSpace, TestResizeObserver } from './test-support'

vi.stubGlobal('ResizeObserver', TestResizeObserver)

beforeEach(() => resetTeamSpace())
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

const SEARCH = 'Name, @username or email'
const now = Math.floor(Date.now() / 1000)

/** An install that serves direct add and the mail state (invites profile 3). */
const READY3: CompanyInviteCapabilities3 = {
  schemaVersion: 3,
  directoryInvite: 'ready',
  emailInvite: 'delivery_unavailable',
  emailCreation: 'ready',
  emailDelivery: 'not_configured',
  inviteLink: 'ready',
  emailAutoClaim: 'verification_required',
  directAdd: 'ready'
}

/** A server before #799/#801: profile 1 only. */
const READY1: CompanyInviteCapabilities = {
  schemaVersion: 1,
  directoryInvite: 'ready',
  emailInvite: 'delivery_unavailable',
  emailCreation: 'ready',
  emailDelivery: 'not_implemented',
  inviteLink: 'ready',
  emailAutoClaim: 'verification_required'
}

const LAN = { userId: '@lan:test', name: 'Lan Phạm', handle: 'lan_pham' }

function people(results: Array<{ userId: string; name: string; handle?: string }>) {
  window.atumMatrix = {
    people: {
      search: vi.fn(async () => ({ ok: true as const, value: { limited: false, results } })),
      privacy: vi.fn(async () => ({ ok: true as const, enabled: true })),
      setPrivacy: vi.fn(async (enabled: boolean) => ({ ok: true as const, enabled }))
    }
  } as unknown as MatrixUiBridge
}

async function openSheet(source: Platform) {
  renderTeamSpace(source)
  await screen.findByRole('list', { name: 'Members' })
  fireEvent.click(await screen.findByRole('button', { name: 'Invite' }))

  return screen.findByRole('dialog', { name: 'Add people to Atum Studio' })
}

const type = (dialog: HTMLElement, value: string) => fireEvent.change(within(dialog).getByLabelText(SEARCH), { target: { value } })

const answer = (value: Record<string, unknown>): MatrixCompanyResult =>
  ({ ok: true, value: { schemaVersion: 12, replayed: false, ...value } }) as MatrixCompanyResult

const added = (input: MatrixCompanyRequest) => answer({ outcome: 'added', companyId: COMPANY_ID, memberRef: 'D'.repeat(43),
  role: (input as { role: string }).role, invitationId: '00000000-0000-4000-8000-9ead0f7cb564', authorityGeneration: 8 })

const directAddServer = (over: Parameters<typeof platform>[0] = {}) =>
  platform({ invitePolicy: 'members', directMemberAdd: 'members', inviteReadiness: READY3, memberAdd: { directAdd: 'allowed' }, ...over })

const memberAdds = (source: Platform) =>
  source.calls('member-add') as Array<Extract<MatrixCompanyRequest, { action: 'member-add' }>>

describe('what Add does in a company', () => {
  it('follows the readiness: add, invite only, neither; and the one-press invite where there is no direct add', () => {
    const value = { schemaVersion: 12 as const, companyId: COMPANY_ID, policy: 'members' as const, assignableRoles: ['member' as const], rosterRemaining: 9 }

    expect(addModeOf({ state: 'ready', value: { ...value, directAdd: 'allowed' } })).toBe('add')
    expect(addModeOf({ state: 'ready', value: { ...value, directAdd: 'invite_only' } })).toBe('invite')
    expect(addModeOf({ state: 'ready', value: { ...value, directAdd: 'not_allowed', assignableRoles: [] } })).toBe('none')
    expect(addModeOf({ state: 'checking' })).toBe('checking')
    expect(addModeOf({ state: 'unsupported' })).toBe('legacy')
    expect(addModeOf({ state: 'off' })).toBe('legacy')
  })

  it('reads a refusal as a refusal: the row keeps its button (a new ID next time) unless the person is in or unknown', () => {
    expect(memberAddResult({ schemaVersion: 12, outcome: 'not_allowed', reason: 'admins_only', replayed: false })).toEqual({
      row: undefined, tone: 'error', reload: true })
    expect(memberAddResult({ schemaVersion: 12, outcome: 'unknown_user', replayed: false })).toMatchObject({ row: { state: 'failed' } })
    expect(memberAddResult({ schemaVersion: 12, outcome: 'already_member', companyId: COMPANY_ID, memberRef: 'D'.repeat(43), replayed: false }))
      .toMatchObject({ row: { state: 'member' }, tone: 'ok' })
  })
})

describe('Add people with direct add', () => {
  it('adds a person at once by the Matrix ID the directory found, and says Added', async () => {
    people([LAN])
    const source = directAddServer({ mutations: { 'member-add': added } })
    const dialog = await openSheet(source)

    await waitFor(() => expect(source.calls('member-add-readiness')).toHaveLength(1))
    type(dialog, 'lan')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add Lan Phạm' }))

    expect(await within(dialog).findByText('Added Lan Phạm.')).toBeTruthy()
    expect(within(dialog).getByText('Added', { selector: '[data-invite-row-state="added"]' })).toBeTruthy()
    expect(memberAdds(source)).toEqual([expect.objectContaining({ companyId: COMPANY_ID, role: 'member',
      target: { kind: 'matrixUser', memberMatrixUser: '@lan:test' } })])
    expect(source.calls('invitation-create-directory')).toHaveLength(0)
    // The readiness is read again after an add (the roster moved).
    await waitFor(() => expect(source.calls('member-add-readiness').length).toBeGreaterThanOrEqual(2))
  })

  it.each([
    ['already_member', { outcome: 'already_member', companyId: COMPANY_ID, memberRef: 'D'.repeat(43) }, 'Lan Phạm is already a member.'],
    ['admins_only', { outcome: 'not_allowed', reason: 'admins_only' }, 'Only owners and admins can add people here. You can invite them.'],
    ['owner_only_role', { outcome: 'not_allowed', reason: 'owner_only_role' }, 'Only the owner can add an admin.'],
    ['roster_full', { outcome: 'roster_full', limit: 100 }, 'This company is full (100 people).'],
    ['unknown_user', { outcome: 'unknown_user' }, 'Can’t add them.']
  ])('says %s in one line', async (_name, outcome, line) => {
    people([LAN])
    const source = directAddServer({ mutations: { 'member-add': () => answer(outcome) } })
    const dialog = await openSheet(source)

    type(dialog, 'lan')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add Lan Phạm' }))

    const status = await within(dialog).findByText(line)
    expect(status.closest('[data-matrix-company-invite-status]')).toBeTruthy()
    expect(within(dialog).queryByText(/Added Lan/u)).toBeNull()
  })

  it('says the add budget is used up, inline, and sends nothing else', async () => {
    people([LAN])
    const source = directAddServer({ mutations: { 'member-add': () => ({ ok: false, error: 'limit', reason: 'member_add_limited' }) } })
    const dialog = await openSheet(source)

    type(dialog, 'lan')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add Lan Phạm' }))

    expect(await within(dialog).findByText('You’ve added a lot of people. Try again in a while.')).toBeTruthy()
    expect(memberAdds(source)).toHaveLength(1)
    // Nothing was recorded: no Retry holds the sheet, and the next press is a new request.
    expect(within(dialog).queryByRole('button', { name: 'Retry' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Lan Phạm' }))
    await waitFor(() => expect(memberAdds(source)).toHaveLength(2))
    expect(memberAdds(source)[1]!.requestId).not.toBe(memberAdds(source)[0]!.requestId)
  })

  it('takes a new request ID for each press after a refusal, with the same person and role', async () => {
    people([LAN])
    const source = directAddServer({ mutations: { 'member-add': () => answer({ outcome: 'unknown_user' }) } })
    const dialog = await openSheet(source)

    type(dialog, 'lan')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add Lan Phạm' }))
    await within(dialog).findByText('Can’t add them.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Lan Phạm' }))
    await waitFor(() => expect(memberAdds(source)).toHaveLength(2))

    const [first, second] = memberAdds(source)
    expect(second!.requestId).not.toBe(first!.requestId)
    expect(second!.target).toEqual(first!.target)
    expect(second!.role).toBe(first!.role)
  })

  it('replays the exact request (same ID, same person) when its answer was lost', async () => {
    people([LAN])
    let lost = true

    const source = directAddServer({ mutations: { 'member-add': input => {
      if (lost) {
        lost = false

        return { ok: false, error: 'unavailable' }
      }

      return added(input)
    } } })

    const dialog = await openSheet(source)

    type(dialog, 'lan')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add Lan Phạm' }))
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Retry' }))

    expect(await within(dialog).findByText('Added Lan Phạm.')).toBeTruthy()
    const [first, second] = memberAdds(source)
    expect(second).toEqual(first)
  })

  it('says Invite where the viewer may only invite, and invites', async () => {
    people([LAN])
    const source = directAddServer({ viewer: 'member', memberAdd: { directAdd: 'invite_only', policy: 'admins' } })
    const dialog = await openSheet(source)

    type(dialog, 'lan')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Invite Lan Phạm' }))

    await waitFor(() => expect(source.calls('invitation-create-directory')).toHaveLength(1))
    expect(memberAdds(source)).toHaveLength(0)
  })

  it('offers neither where the viewer may do neither', async () => {
    people([LAN])
    const source = directAddServer({ memberAdd: { directAdd: 'not_allowed' } })
    const dialog = await openSheet(source)

    expect(await within(dialog).findByText('Only owners and admins can invite people here.')).toBeTruthy()
    expect(within(dialog).getByLabelText(SEARCH).closest('.hidden')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: /^Add |^Invite / })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Copy invite link' })).toBeNull()
  })

  it('lets the owner grant admin when the platform says so, and sends it on the add', async () => {
    people([LAN])
    const source = directAddServer({ mutations: { 'member-add': added } })
    const dialog = await openSheet(source)

    const role = await within(dialog).findByRole('radiogroup', { name: 'Role' })
    fireEvent.click(within(role).getByRole('radio', { name: 'Admin' }))
    type(dialog, 'lan')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add Lan Phạm' }))

    await waitFor(() => expect(memberAdds(source)).toHaveLength(1))
    expect(memberAdds(source)[0]!.role).toBe('admin')
  })

  it('never offers an address as admin, and invites an address by email, never adds it', async () => {
    people([])
    const source = directAddServer()
    const dialog = await openSheet(source)

    const role = await within(dialog).findByRole('radiogroup', { name: 'Role' })
    fireEvent.click(within(role).getByRole('radio', { name: 'Admin' }))
    type(dialog, 'lan@example.com')
    await waitFor(() => expect(within(dialog).queryByText('Searching…')).toBeNull())
    expect(within(dialog).queryByRole('button', { name: /lan@example\.com/u })).toBeNull()

    fireEvent.click(within(role).getByRole('radio', { name: 'Member' }))
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add lan@example.com' }))

    await waitFor(() => expect(source.calls('email-invitation-create')).toHaveLength(1))
    expect(memberAdds(source)).toHaveLength(0)
  })

  it('warns how much room is left, and holds Add when the company is full', async () => {
    people([LAN])
    const source = directAddServer({ memberAdd: { directAdd: 'allowed', rosterRemaining: 0 } })
    const dialog = await openSheet(source)

    expect(await within(dialog).findByText('This company is full (100 people).')).toBeTruthy()
    type(dialog, 'lan')
    expect((await within(dialog).findByRole('button', { name: 'Add Lan Phạm' })).hasAttribute('disabled')).toBe(true)
  })
})

/** A readiness answer the test releases, so the sheet can be caught while it is still reading. */
function deferredReadiness() {
  let release!: (result: MatrixCompanyResult) => void
  const pending = new Promise<MatrixCompanyResult>(done => {
    release = done
  })

  return {
    handler: () => pending as unknown as MatrixCompanyResult,
    release: (directAdd: 'allowed' | 'invite_only' | 'not_allowed', rosterRemaining = 50) => release({ ok: true, value: {
      schemaVersion: 12, companyId: COMPANY_ID, directAdd, policy: 'members',
      assignableRoles: directAdd === 'not_allowed' ? [] : ['member', 'admin'], rosterRemaining } } as MatrixCompanyResult)
  }
}

const enter = (dialog: HTMLElement) => fireEvent.keyDown(within(dialog).getByLabelText(SEARCH), { key: 'Enter' })
const sent = (source: Platform) => source.mutations().filter(input => input.action !== 'invite-link-create')

describe('one guard for the button and Enter', () => {
  it('Enter sends nothing while the readiness is still being read, then adds once it says allowed', async () => {
    people([LAN])
    const readiness = deferredReadiness()
    const source = directAddServer({ mutations: { 'member-add-readiness': readiness.handler, 'member-add': added } })
    const dialog = await openSheet(source)

    type(dialog, 'lan')
    expect((await within(dialog).findByRole('button', { name: 'Add Lan Phạm' })).hasAttribute('disabled')).toBe(true)
    enter(dialog)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(sent(source)).toEqual([])

    readiness.release('allowed')
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Add Lan Phạm' }).hasAttribute('disabled')).toBe(false))
    enter(dialog)
    await waitFor(() => expect(memberAdds(source)).toHaveLength(1))
    expect(source.calls('invitation-create-directory')).toHaveLength(0)
  })

  it('Enter sends nothing when the company is full', async () => {
    people([LAN])
    const source = directAddServer({ memberAdd: { directAdd: 'allowed', rosterRemaining: 0 } })
    const dialog = await openSheet(source)

    await within(dialog).findByText('This company is full (100 people).')
    type(dialog, 'lan')
    await within(dialog).findByRole('button', { name: 'Add Lan Phạm' })
    enter(dialog)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(sent(source)).toEqual([])
  })

  it('Enter sends nothing where the viewer may do neither', async () => {
    people([LAN])
    const source = directAddServer({ memberAdd: { directAdd: 'not_allowed' } })
    const dialog = await openSheet(source)

    await within(dialog).findByText('Only owners and admins can invite people here.')
    type(dialog, 'lan')
    enter(dialog)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(sent(source)).toEqual([])
  })
})

describe('direct add switching on under an open sheet', () => {
  it('never sends the old invitation once the install says direct add is ready', async () => {
    people([LAN])
    const readiness = deferredReadiness()
    // The install's readiness answers only after the sheet is open: the sheet first mounts with direct add off.
    let releaseInstall!: () => void
    const install = new Promise<void>(done => {
      releaseInstall = done
    })
    const source = platform({ invitePolicy: 'members', directMemberAdd: 'members', mutations: {
      'invite-readiness': input => install.then(() => (input as { profile?: string }).profile === '3'
        ? { ok: true, value: READY3 }
        : { ok: false, error: 'invalid' }) as unknown as MatrixCompanyResult,
      'member-add-readiness': readiness.handler,
      'member-add': added
    } })

    const dialog = await openSheet(source)
    type(dialog, 'lan')
    await within(dialog).findByRole('button', { name: 'Add Lan Phạm' })
    expect(source.calls('member-add-readiness')).toHaveLength(0)
    releaseInstall()

    // Direct add turns on while the sheet is open; the company's readiness is still out.
    await waitFor(() => expect(source.calls('member-add-readiness')).toHaveLength(1))
    type(dialog, 'lan')
    const button = await within(dialog).findByRole('button', { name: 'Add Lan Phạm' })
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.click(button)
    enter(dialog)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(source.calls('invitation-create-directory')).toHaveLength(0)

    readiness.release('allowed')
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Add Lan Phạm' }).hasAttribute('disabled')).toBe(false))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Lan Phạm' }))
    await waitFor(() => expect(memberAdds(source)).toHaveLength(1))
    expect(source.calls('invitation-create-directory')).toHaveLength(0)
  })

  it('an admins-only answer holds Add until the new readiness, then the button invites', async () => {
    people([LAN])
    let readinessReads = 0
    const later = deferredReadiness()
    const source = directAddServer({ mutations: {
      'member-add-readiness': input => {
        readinessReads += 1

        return readinessReads === 1
          ? { ok: true, value: { schemaVersion: 12, companyId: (input as { companyId: string }).companyId, directAdd: 'allowed',
              policy: 'members', assignableRoles: ['member', 'admin'], rosterRemaining: 50 } } as MatrixCompanyResult
          : later.handler()
      },
      'member-add': () => answer({ outcome: 'not_allowed', reason: 'admins_only' })
    } })
    const dialog = await openSheet(source)

    type(dialog, 'lan')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add Lan Phạm' }))
    await within(dialog).findByText('Only owners and admins can add people here. You can invite them.')
    expect(within(dialog).getByRole('button', { name: 'Add Lan Phạm' }).hasAttribute('disabled')).toBe(true)
    enter(dialog)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(memberAdds(source)).toHaveLength(1)

    later.release('invite_only')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Invite Lan Phạm' }))
    await waitFor(() => expect(source.calls('invitation-create-directory')).toHaveLength(1))
    expect(memberAdds(source)).toHaveLength(1)
  })
})

describe('older servers keep the one-press invite', () => {
  it('without direct add, Add invites, and the readiness for adding is never asked', async () => {
    people([LAN])

    const source = platform({ invitePolicy: 'members', inviteReadiness: READY1, mutations: { 'invitation-create-directory': input => ({
      ok: true, value: { schemaVersion: 11, replayed: false, authorityGeneration: 7, invitation: { id: '00000000-0000-4000-8000-ae985e49793d',
        companyId: COMPANY_ID, targetHandle: null, role: (input as { role: 'member' }).role, state: 'pending', createdAt: now, expiresAt: now + 86_400,
        inviter: { handle: 'minh', displayName: 'Minh' } } } }) as MatrixCompanyResult } })

    const dialog = await openSheet(source)

    type(dialog, 'lan')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add Lan Phạm' }))

    expect(await within(dialog).findByText('Invited Lan Phạm. They’ll see it in Atum.')).toBeTruthy()
    expect(source.calls('member-add-readiness')).toHaveLength(0)
    expect(memberAdds(source)).toHaveLength(0)
  })

  it('falls back to inviting when the server serves no 1.12 readiness (404)', async () => {
    people([LAN])
    const source = platform({ invitePolicy: 'members', inviteReadiness: READY3 })
    const dialog = await openSheet(source)

    await waitFor(() => expect(source.calls('member-add-readiness')).toHaveLength(1))
    type(dialog, 'lan')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add Lan Phạm' }))

    await waitFor(() => expect(source.calls('invitation-create-directory')).toHaveLength(1))
    expect(memberAdds(source)).toHaveLength(0)
  })
})

const emailReceipt = (): MatrixCompanyResult => ({ ok: true, value: { schemaVersion: 10,
  invitationId: '00000000-0000-4000-8000-662b4919353f', state: 'accepted', mailStatus: 'accepted', expiresAt: now + 86_400 * 7,
  replayed: false } } as MatrixCompanyResult)

describe('email invitation mail state', () => {
  it.each([
    ['queued', 'Email waiting to send'],
    ['sent', 'Email sent'],
    ['failed', 'Email not sent. Send them the invite link.'],
    ['cancelled', 'Email cancelled']
  ] as const)('says %s truthfully, and never “no email goes out yet”', async (mailStatus, line) => {
    people([])
    const source = directAddServer({ mailStatus, mutations: { 'email-invitation-create': emailReceipt } })
    const dialog = await openSheet(source)

    type(dialog, 'lan@example.com')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add lan@example.com' }))

    expect(await within(dialog).findByText('Invited lan@example.com by email.')).toBeTruthy()
    expect(await within(dialog).findByText(line, { exact: false, selector: '[data-matrix-company-invite-mail]' })).toBeTruthy()
    expect(within(dialog).queryByText(/No email goes out yet/u)).toBeNull()
    expect(source.calls('email-invitation-status')).toEqual([expect.objectContaining({ companyId: COMPANY_ID,
      invitationId: '00000000-0000-4000-8000-662b4919353f' })])

    const row = within(dialog).getByText('lan@example.com', { selector: '[data-invitation-state="email"] *' }).closest('li')!
    expect(row.getAttribute('data-invitation-mail')).toBe(mailStatus)
  })

  it('keeps today’s line on a server that cannot tell the mail state', async () => {
    people([])
    const source = platform({ invitePolicy: 'members', inviteReadiness: READY1, mutations: { 'email-invitation-create': emailReceipt } })
    const dialog = await openSheet(source)

    type(dialog, 'lan@example.com')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add lan@example.com' }))

    expect(await within(dialog).findByText(/No email goes out yet/u)).toBeTruthy()
    expect(source.calls('email-invitation-status')).toHaveLength(0)
  })
})

describe('who can add people directly (company settings)', () => {
  it('shows the setting from policy 1.3 and sends all five policy fields when it changes', async () => {
    const source = directAddServer()
    renderTeamSpace(source)

    const group = await screen.findByRole('radiogroup', { name: 'Who can add people directly' })
    expect(within(group).getByRole('radio', { name: 'Members' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(within(group).getByRole('radio', { name: 'Admins only' }))
    await waitFor(() => expect(source.calls('policy-update')).toHaveLength(1))
    expect(source.calls('policy-update')[0]).toMatchObject({
      companyId: COMPANY_ID,
      expectedAuthorityGeneration: 7,
      policy: { channelCreation: 'members', publicChannelMembership: 'members', privateChannelMembership: 'members',
        companyInvitations: 'members', directMemberAdd: 'admins' }
    })
  })

  it('is not shown where the server has no policy 1.3, nor to a member', async () => {
    renderTeamSpace(platform({ invitePolicy: 'members' }))
    await screen.findByRole('radiogroup', { name: 'Who can create channels' })
    expect(screen.queryByRole('radiogroup', { name: 'Who can add people directly' })).toBeNull()

    cleanup()
    resetTeamSpace()
    renderTeamSpace(directAddServer({ viewer: 'member' }))
    await screen.findByRole('list', { name: 'Members' })
    expect(screen.queryByRole('radiogroup', { name: 'Who can add people directly' })).toBeNull()
  })
})
