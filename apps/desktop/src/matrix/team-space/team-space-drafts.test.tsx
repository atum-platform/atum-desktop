import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  CHANNEL_IDS,
  channelRoom,
  platform,
  renderTeamSpace,
  resetTeamSpace,
  TestResizeObserver
} from './test-support'

beforeAll(() => vi.stubGlobal('ResizeObserver', TestResizeObserver))

afterEach(() => {
  cleanup()
  resetTeamSpace()
})

const roomId = '!general:atum.example'
const roomDraft = { room_id: roomId, text: 'Ship the launch plan', updated_at: 200 }
const threadDraft = { room_id: roomId, thread_root_id: '$root', text: 'Tuesday works', updated_at: 300 }
const lostDraft = { room_id: '!lost:atum.example', text: 'private words', updated_at: 400 }

describe('Team Space Drafts', () => {
  it('lists only current authorized room/thread drafts and opens through the membership fence', async () => {
    const onOpenCompanyDraft = vi.fn(async () => {})

    renderTeamSpace(platform(), {
      drafts: { records: [lostDraft, threadDraft, roomDraft], writable: true },
      onOpenCompanyDraft,
      rooms: [channelRoom(CHANNEL_IDS.general, 'general')]
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Drafts' }))
    const view = await screen.findByRole('region', { name: 'Drafts' })

    expect(within(view).getByText('Tuesday works')).toBeTruthy()
    expect(within(view).getByText('Ship the launch plan')).toBeTruthy()
    expect(within(view).queryByText('private words')).toBeNull()
    expect(within(view).getByText('Thread draft')).toBeTruthy()
    expect(within(view).getByText('Message draft')).toBeTruthy()

    fireEvent.click(within(view).getByRole('button', { name: /Tuesday works/ }))
    await waitFor(() => expect(onOpenCompanyDraft).toHaveBeenCalledWith(threadDraft, expect.any(Function)))
  })

  it('keeps the channel composer mounted behind the Drafts return path', async () => {
    renderTeamSpace(platform(), {
      channelContent: <input aria-label="Channel composer" defaultValue="half-written" />,
      drafts: { records: [roomDraft], writable: true },
      rooms: [channelRoom(CHANNEL_IDS.general, 'general')]
    })

    const composer = await screen.findByRole('textbox', { name: 'Channel composer' }) as HTMLInputElement
    fireEvent.change(composer, { target: { value: 'keep this local selection' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Drafts' }))
    await screen.findByRole('region', { name: 'Drafts' })

    expect(composer.isConnected).toBe(true)
    expect(composer.value).toBe('keep this local selection')
  })

  it('hides a draft as soon as current Matrix membership is lost', async () => {
    const onPurgeCompanyDraft = vi.fn(async () => {})

    renderTeamSpace(platform(), {
      drafts: { records: [roomDraft], writable: true },
      onPurgeCompanyDraft,
      rooms: [channelRoom(CHANNEL_IDS.general, 'general', { membership: 'leave' })]
    })

    await screen.findByRole('button', { name: 'Open # general' })
    expect(screen.queryByRole('button', { name: 'Drafts' })).toBeNull()
    await waitFor(() => expect(onPurgeCompanyDraft).toHaveBeenCalledWith(roomDraft))
  })
})
