import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

const { listAssistants, refreshProfiles } = vi.hoisted(() => ({ listAssistants: vi.fn(), refreshProfiles: vi.fn() }))

vi.mock('@/lib/atum-messaging-client', () => ({ atumMessagingClient: () => ({ listAssistants }) }))
vi.mock('@/store/profile', () => ({ refreshProfiles }))
vi.mock('../atum/agents', () => ({
  $atumAgents: atom([{ id: 'marketing', identityId: 'identity-marketing', title: 'Marketing' }])
}))
vi.mock('../atum/assistant-directory', () => ({
  $atumAssistantDirectory: atom({ accountId: null, entries: [], state: 'empty' }),
  refreshAtumAssistantDirectory: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./group-state', () => ({
  $groupCapabilities: atom(null),
  refreshGroupCapabilities: vi.fn().mockResolvedValue(undefined)
}))

import { $groupCapabilities, refreshGroupCapabilities } from './group-state'
import { SharedGroupPersonaApprovalDialog } from './shared-group-persona-approval-dialog'

const assistant = {
  assistantId: 'agent-1',
  displayName: 'Marketing',
  ownerUserId: 'me',
  ownerDisplayName: 'Minh',
  membershipEpoch: 1,
  availability: 'assistant_not_approved' as const
}

const preview = {
  assistantId: 'agent-1',
  profile: 'marketing',
  content: 'You help with product marketing.',
  digest: 'a'.repeat(64),
  identityId: 'identity-marketing',
  approvalRevision: null,
  approved: false,
  modelAlias: 'binh-minh' as const
}

beforeEach(() => {
  vi.mocked(refreshGroupCapabilities).mockReset().mockResolvedValue(undefined)
  listAssistants.mockReset().mockResolvedValue([{ id: 'agent-1', identityId: 'identity-marketing', status: 'active' }])
  refreshProfiles.mockReset().mockResolvedValue(undefined)
  $groupCapabilities.set({
    available: true,
    creationEnabled: true,
    humanMemberLimit: 32,
    sharedAgents: { enabled: true, assistantMemberLimit: 4, ownAssistantOnly: true, assistantCatalog: [] }
  })
})

afterEach(cleanup)

describe('SharedGroupPersonaApprovalDialog', () => {
  it('previews the exact shareable persona and requires an explicit device approval', async () => {
    const approve = vi.fn().mockResolvedValue({ ok: true })
    const revoke = vi.fn().mockResolvedValue({ ok: true })
    const onOpenChange = vi.fn()
    Object.assign(window, {
      hermesDesktop: { atumSharedGroups: { preview: vi.fn().mockResolvedValue(preview), approve, revoke } }
    })

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <SharedGroupPersonaApprovalDialog assistant={assistant} onOpenChange={onOpenChange} open />
      </I18nProvider>
    )

    expect(await screen.findByText('You help with product marketing.')).toBeTruthy()
    expect(screen.getByText(/People in the group can read/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Enable for group chats' }))

    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith({
        assistantId: 'agent-1',
        profile: 'marketing',
        expectedDigest: 'a'.repeat(64)
      })
    )
    expect(revoke).not.toHaveBeenCalled()
  })

  it('keeps an offline approved agent distinct and lets the owner revoke access', async () => {
    const revoke = vi.fn().mockResolvedValue({ ok: true })
    Object.assign(window, {
      hermesDesktop: {
        atumSharedGroups: {
          preview: vi.fn().mockResolvedValue({ ...preview, approved: true, approvalRevision: 2 }),
          approve: vi.fn(),
          revoke
        }
      }
    })

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <SharedGroupPersonaApprovalDialog
          assistant={{ ...assistant, availability: 'assistant_offline' }}
          onOpenChange={vi.fn()}
          open
        />
      </I18nProvider>
    )

    expect(await screen.findByText('This agent’s group connection is currently offline.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke group access' }))
    await waitFor(() => expect(revoke).toHaveBeenCalledWith({ assistantId: 'agent-1', profile: 'marketing' }))
  })

  it('keeps locally approved instructions retryable after reopening without claiming group access', async () => {
    const read = vi.fn().mockResolvedValue({ ...preview, approved: true, approvalRevision: 7 })
    const approve = vi.fn().mockResolvedValue({ ok: true })
    const revoke = vi.fn()
    Object.assign(window, { hermesDesktop: { atumSharedGroups: { preview: read, approve, revoke } } })

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <SharedGroupPersonaApprovalDialog assistant={assistant} onOpenChange={vi.fn()} open />
      </I18nProvider>
    )

    const connect = await screen.findByRole('button', { name: 'Connect for group chats' })
    expect(screen.queryByText('This agent is enabled for group chats on this computer.')).toBeNull()
    fireEvent.click(connect)
    expect(await screen.findByText('This agent is enabled for group chats on this computer.')).toBeTruthy()
    expect(approve).toHaveBeenCalledWith({
      assistantId: 'agent-1',
      profile: 'marketing',
      expectedDigest: preview.digest
    })
    expect(revoke).not.toHaveBeenCalled()
  })

  it('reads back a partial approval after failure and offers connection retry and withdrawal', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(preview)
      .mockResolvedValue({ ...preview, approved: true, approvalRevision: 8 })

    const approve = vi.fn().mockRejectedValue(new Error('device_enable_failed'))
    Object.assign(window, { hermesDesktop: { atumSharedGroups: { preview: read, approve, revoke: vi.fn() } } })

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <SharedGroupPersonaApprovalDialog assistant={assistant} onOpenChange={vi.fn()} open />
      </I18nProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Enable for group chats' }))
    expect(await screen.findByRole('button', { name: 'Connect for group chats' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Revoke group access' })).toBeTruthy()
    expect(screen.queryByText('This agent is enabled for group chats on this computer.')).toBeNull()
    expect(screen.getByText('This agent could not be prepared for group chats on this computer.')).toBeTruthy()
  })

  it('recognizes the existing server binding when a successful connection is reopened', async () => {
    const read = vi.fn().mockResolvedValue({ ...preview, approved: true, approvalRevision: 7 })
    const approve = vi.fn().mockResolvedValue({ ok: true })
    Object.assign(window, { hermesDesktop: { atumSharedGroups: { preview: read, approve, revoke: vi.fn() } } })

    const view = (open: boolean) => (
      <I18nProvider configClient={null} initialLocale="en">
        <SharedGroupPersonaApprovalDialog
          assistant={{ ...assistant, availability: 'available' }} onOpenChange={vi.fn()} open={open}
        />
      </I18nProvider>
    )

    const { rerender } = render(view(true))
    fireEvent.click(await screen.findByRole('button', { name: 'Connect for group chats' }))
    expect(await screen.findByText('This agent is enabled for group chats on this computer.')).toBeTruthy()
    rerender(view(false))
    rerender(view(true))
    expect(await screen.findByText('This agent has a group connection on one of your computers.')).toBeTruthy()
    expect(screen.queryByText(/Group access is confirmed when/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Connect for group chats' })).toBeTruthy()
  })

  it.each(['pending', 'failed', 'older-build'] as const)('permits retry when capabilities are %s', async state => {
    $groupCapabilities.set(state === 'older-build'
      ? { available: false, creationEnabled: false, humanMemberLimit: 32 }
      : null)

    if (state === 'failed') {
      vi.mocked(refreshGroupCapabilities).mockRejectedValue(new Error('unavailable'))
    }

    const approve = vi.fn().mockResolvedValue({ ok: true })
    Object.assign(window, {
      hermesDesktop: { atumSharedGroups: {
        preview: vi.fn().mockResolvedValue({ ...preview, approved: true, approvalRevision: 7 }),
        approve, revoke: vi.fn()
      } }
    })
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <SharedGroupPersonaApprovalDialog assistant={assistant} onOpenChange={vi.fn()} open />
      </I18nProvider>
    )
    const connect = await screen.findByRole('button', { name: 'Connect for group chats' })
    expect((connect as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText(/Shared group access is not enabled yet/)).toBeNull()
    fireEvent.click(connect)
    await waitFor(() => expect(approve).toHaveBeenCalled())
  })

  it('explains disabled rollout without attempting registration and still permits withdrawal', async () => {
    const caps = $groupCapabilities.get()!
    $groupCapabilities.set({ ...caps, sharedAgents: { ...caps.sharedAgents!, enabled: false } })
    const approve = vi.fn()
    const revoke = vi.fn().mockResolvedValue({ ok: true })
    Object.assign(window, {
      hermesDesktop: {
        atumSharedGroups: {
          preview: vi.fn().mockResolvedValue({ ...preview, approved: true, approvalRevision: 4 }),
          approve,
          revoke
        }
      }
    })

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <SharedGroupPersonaApprovalDialog assistant={assistant} onOpenChange={vi.fn()} open />
      </I18nProvider>
    )

    const connect = await screen.findByRole('button', { name: 'Connect for group chats' })
    expect((connect as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(connect)
    expect(approve).not.toHaveBeenCalled()
    expect(screen.getByText(/Shared group access is not enabled yet/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke group access' }))
    await waitFor(() => expect(revoke).toHaveBeenCalled())
  })
})
