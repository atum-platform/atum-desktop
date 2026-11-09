import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CHANNEL_IDS,
  channelRoom,
  COMPANY_ID,
  platform,
  renderTeamSpace,
  resetTeamSpace,
  TestResizeObserver
} from './test-support'

vi.stubGlobal('ResizeObserver', TestResizeObserver)

const token = 'A'.repeat(43)
const preview = {
  schemaVersion: 3 as const,
  company: { id: COMPANY_ID, displayName: 'Atum Studio' },
  role: 'member' as const,
  inviter: { handle: 'minh', displayName: 'Minh' },
  expiresAt: Math.floor(Date.now() / 1000) + 86_400,
  maxUses: 5,
  usesRemaining: 3
}

beforeEach(() => resetTeamSpace())
afterEach(cleanup)

async function pasteInvite() {
  // The platform directory owns whether Add company is available; wait for
  // its ready channel projection before opening the menu.
  await screen.findByRole('button', { name: 'Open # general' })
  fireEvent.keyDown(window.document.querySelector('[data-matrix-company-menu-trigger]')!, { key: 'Enter' })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Add company' }))
  const add = await screen.findByRole('dialog', { name: 'New company' })
  fireEvent.click(within(add).getByRole('button', { name: 'Join with invite link' }))
  const dialog = await screen.findByRole('dialog', { name: 'Join a company' })
  fireEvent.change(within(dialog).getByLabelText('Invite link'), {
    target: { value: `https://account.atumplatform.com/j/${token}` }
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Preview invite' }))

  return dialog
}

describe('Team Space invite-link journey', () => {
  it('previews before one explicit Join, redeems, and opens the converged default channel', async () => {
    const onOpenChannel = vi.fn(async () => {})
    const source = platform({ canCreate: true, mutations: {
      'invite-link-preview': () => ({ ok: true, value: preview }),
      'invite-link-redeem': () => ({ ok: true, value: {
        schemaVersion: 3, companyId: COMPANY_ID, memberRef: 'A'.repeat(43), role: 'member', state: 'active',
        link: { id: '00000000-0000-4000-8000-05d9ec66b6d2', maxUses: 5, usesRemaining: 2,
          consumedNow: true, replayed: false }
      } })
    } })

    renderTeamSpace(source, {
      convergenceDelayMs: 1,
      onOpenChannel,
      rooms: [channelRoom(CHANNEL_IDS.general, 'general')]
    })
    const dialog = await pasteInvite()

    expect(await within(dialog).findByText('You’re invited to Atum Studio.')).toBeTruthy()
    expect(within(dialog).getByText('Invited by Minh.')).toBeTruthy()
    expect(source.calls('invite-link-redeem')).toHaveLength(0)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Join' }))

    await waitFor(() => expect(source.calls('invite-link-redeem')).toHaveLength(1))
    await waitFor(() => expect(onOpenChannel).toHaveBeenCalledWith('!general:atum.example', expect.any(Function)))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Join a company' })).toBeNull())
  })

  it('reuses the exact in-memory request id after an unclear redeem and accepts the replay receipt', async () => {
    let attempts = 0
    const source = platform({ canCreate: true, mutations: {
      'invite-link-preview': () => ({ ok: true, value: preview }),
      'invite-link-redeem': () => {
        attempts += 1

        return attempts === 1
          ? { ok: false, error: 'unavailable' }
          : { ok: true, value: {
              schemaVersion: 3, companyId: COMPANY_ID, memberRef: 'A'.repeat(43), role: 'member', state: 'active',
              link: { id: '00000000-0000-4000-8000-05d9ec66b6d2', maxUses: 5, usesRemaining: 2,
                consumedNow: false, replayed: true }
            } }
      }
    } })

    renderTeamSpace(source, {
      convergenceDelayMs: 1,
      rooms: [channelRoom(CHANNEL_IDS.general, 'general')]
    })
    let dialog = await pasteInvite()
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Join' }))
    expect(await within(dialog).findByText('The invite could not be checked. Try again.')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview invite' }))
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Join' }))

    await waitFor(() => expect(source.calls('invite-link-redeem')).toHaveLength(2))
    const [first, second] = source.calls('invite-link-redeem') as Array<{ requestId: string; token: string }>
    expect(second.requestId).toBe(first.requestId)
    expect(second.token).toBe(first.token)
  })

  it('says an email-bound link is claimed by its address, and never tries to redeem it', async () => {
    const source = platform({ canCreate: true, mutations: {
      'invite-link-preview': () => ({ ok: false, error: 'conflict', reason: 'email_invite_claim_required' })
    } })

    renderTeamSpace(source, { rooms: [channelRoom(CHANNEL_IDS.general, 'general')] })
    const dialog = await pasteInvite()

    // Not an error: one line that says what to do, and one way out.
    const line = await within(dialog).findByText('This invite was sent to an email address. Sign in with the invited address to join.')
    expect(line.getAttribute('role')).toBe('status')
    expect(within(dialog).queryByRole('alert')).toBeNull()
    expect(within(dialog).getAllByRole('button').map(button => button.textContent)).toEqual(['OK'])
    expect(source.calls('invite-link-redeem')).toHaveLength(0)

    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Join a company' })).toBeNull())
  })
})
