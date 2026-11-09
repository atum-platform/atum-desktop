import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { MatrixUiBridge } from '../../../shared/matrix'
import type { MatrixSavedMessageView } from '../../../shared/matrix-saved-messages'

import {
  COMPANY_ID,
  platform,
  renderTeamSpace,
  resetTeamSpace,
  TestResizeObserver
} from './test-support'

beforeAll(() => vi.stubGlobal('ResizeObserver', TestResizeObserver))

afterEach(() => {
  cleanup()
  resetTeamSpace()
  Reflect.deleteProperty(window, 'atumMatrix')
})

const records = [
  { room_id: '!launch:atum.example', event_id: '$new', saved_at: 200 },
  { room_id: '!gone:atum.example', event_id: '$gone', saved_at: 100 }
]

const resolved: MatrixSavedMessageView[] = [
  {
    ...records[0]!,
    available: true,
    companyId: COMPANY_ID,
    roomName: 'launch',
    roomKind: 'channel',
    senderName: 'Linh',
    own: false,
    body: 'Ship the launch plan',
    sentAt: 150
  },
  { ...records[1]!, available: false }
]

describe('Team Space Saved messages', () => {
  it('keeps the open channel mounted behind Saved so its draft survives the return path', async () => {
    window.atumMatrix = {
      command: vi.fn(async input => input.kind === 'savedMessagesRead' ? resolved : null)
    } as unknown as MatrixUiBridge

    renderTeamSpace(platform(), {
      channelContent: <input aria-label="Channel draft" defaultValue="half-written" />,
      savedMessages: { records, writable: true }
    })

    const draft = await screen.findByRole('textbox', { name: 'Channel draft' }) as HTMLInputElement
    fireEvent.change(draft, { target: { value: 'keep this draft' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Saved' }))
    await screen.findByRole('region', { name: 'Saved' })

    expect(draft.isConnected).toBe(true)
    expect(draft.value).toBe('keep this draft')
  })

  it('opens from the sidebar and shows account-wide rows newest first with company/channel context', async () => {
    const command = vi.fn(async input => input.kind === 'savedMessagesRead' ? resolved : null)
    const onOpenSavedMessage = vi.fn(async () => {})
    window.atumMatrix = { command } as unknown as MatrixUiBridge

    renderTeamSpace(platform(), {
      onOpenSavedMessage,
      savedMessages: { records, writable: true }
    })

    fireEvent.click(await screen.findByRole('tab', { name: 'Board' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Saved' }))
    const view = await screen.findByRole('region', { name: 'Saved' })
    expect(within(view).getByText('Atum Studio')).toBeTruthy()
    expect(within(view).getByText('launch')).toBeTruthy()
    expect(within(view).getByText('Ship the launch plan')).toBeTruthy()
    expect(within(view).getByText('Message unavailable')).toBeTruthy()
    expect(within(view).getAllByRole('listitem')[0]?.textContent).toContain('Ship the launch plan')

    fireEvent.click(within(view).getByRole('button', { name: /Jump to message/ }))
    await waitFor(() => expect(onOpenSavedMessage).toHaveBeenCalledWith(resolved[0]))
  })

  it('removes an unavailable row without needing to open its room', async () => {
    const command = vi.fn(async input => input.kind === 'savedMessagesRead' ? [resolved[1]] : null)
    window.atumMatrix = { command } as unknown as MatrixUiBridge

    renderTeamSpace(platform(), {
      savedMessages: { records: [records[1]!], writable: true }
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Saved' }))
    const view = await screen.findByRole('region', { name: 'Saved' })
    fireEvent.click(within(view).getByRole('button', { name: 'Remove from Saved' }))

    await waitFor(() => expect(command).toHaveBeenCalledWith({
      kind: 'savedMessage',
      roomId: '!gone:atum.example',
      eventId: '$gone',
      saved: false
    }))
    expect(within(view).queryByText('Message unavailable')).toBeNull()
  })

  it('uses Vietnamese copy in the same entry point and unavailable state', async () => {
    window.atumMatrix = {
      command: vi.fn(async input => input.kind === 'savedMessagesRead' ? [resolved[1]] : null)
    } as unknown as MatrixUiBridge

    renderTeamSpace(platform(), {
      savedMessages: { records: [records[1]!], writable: true }
    }, 'vi')

    fireEvent.click(await screen.findByRole('button', { name: 'Đã lưu' }))
    expect(await screen.findByText('Không còn xem được tin nhắn')).toBeTruthy()
  })
})
