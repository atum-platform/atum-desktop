import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { GroupOperationInput, GroupOperationResult, GroupRoom } from '../../../shared/atum-group-conversations'

import { GroupRoomReportDialog } from './group-room-report-dialog'

const room: GroupRoom = {
  conversationId: 'room-1',
  title: 'Weekend',
  revision: 1,
  retiredAt: null,
  membershipEpoch: 1,
  updatedAt: '2026-09-06T00:00:00.000Z',
  members: [{ userId: 'lan', displayName: 'Lan', handle: 'lan', role: 'member', membershipEpoch: 1 }]
}

afterEach(cleanup)

describe('GroupRoomReportDialog', () => {
  it('submits a shared-room agent report as an explicit member assistant', async () => {
    const onOperate = vi
      .fn<(input: GroupOperationInput) => Promise<GroupOperationResult>>()
      .mockResolvedValue({ operationId: 'report-agent', state: 'sent', conversationId: 'room-1', errorCode: null })

    const assistant = {
      assistantId: 'agent-1',
      displayName: 'Research agent',
      ownerUserId: 'lan',
      ownerDisplayName: 'Lan',
      membershipEpoch: 1,
      availability: 'assistant_not_owned' as const
    }

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <GroupRoomReportDialog
          createOperationId={() => 'report-agent'}
          onOpenChange={vi.fn()}
          onOperate={onOperate}
          open
          room={{ ...room, contextMode: 'shared_group', assistants: [assistant] }}
          target={{ kind: 'assistant', assistant }}
        />
      </I18nProvider>
    )

    fireEvent.click(screen.getByLabelText('Spam'))
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }))

    await waitFor(() =>
      expect(onOperate).toHaveBeenCalledWith({
        action: 'report',
        clientOperationId: 'report-agent',
        conversationId: 'room-1',
        memberAssistant: 'agent-1',
        note: undefined,
        reason: 'spam'
      })
    )
  })

  it('submits an explicit member target and keeps a queued report honest', async () => {
    const onOperate = vi
      .fn<(input: GroupOperationInput) => Promise<GroupOperationResult>>()
      .mockResolvedValue({ operationId: 'report-1', state: 'queued', conversationId: 'room-1', errorCode: null })

    const onOpenChange = vi.fn()

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <GroupRoomReportDialog
          createOperationId={() => 'report-1'}
          onOpenChange={onOpenChange}
          onOperate={onOperate}
          open
          room={room}
          target={{ kind: 'member', member: room.members[0]! }}
        />
      </I18nProvider>
    )

    fireEvent.click(screen.getByLabelText('Spam'))
    fireEvent.change(screen.getByLabelText('Add details (optional)'), { target: { value: '  repeated links  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }))

    await waitFor(() =>
      expect(onOperate).toHaveBeenCalledWith({
        action: 'report',
        clientOperationId: 'report-1',
        conversationId: 'room-1',
        memberUserId: 'lan',
        note: 'repeated links',
        reason: 'spam'
      })
    )
    expect(screen.getByText('This report is queued and has not been sent yet.')).toBeTruthy()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('replays a lost-response report with its original target, note, and operation id', async () => {
    const createOperationId = vi.fn().mockReturnValue('report-1')

    const onOperate = vi
      .fn<(input: GroupOperationInput) => Promise<GroupOperationResult>>()
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValueOnce({ operationId: 'report-1', state: 'queued', conversationId: 'room-1', errorCode: null })

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <GroupRoomReportDialog
          createOperationId={createOperationId}
          onOpenChange={vi.fn()}
          onOperate={onOperate}
          open
          room={room}
          target={{ kind: 'member', member: room.members[0]! }}
        />
      </I18nProvider>
    )

    fireEvent.click(screen.getByLabelText('Spam'))
    fireEvent.change(screen.getByLabelText('Add details (optional)'), { target: { value: 'repeated links' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }))
    await screen.findByText('The report could not be sent.')

    expect((screen.getByLabelText('Add details (optional)') as HTMLTextAreaElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(onOperate).toHaveBeenCalledTimes(2))
    expect(onOperate.mock.calls[0]).toEqual(onOperate.mock.calls[1])
    expect(createOperationId).toHaveBeenCalledTimes(1)
  })

  it('closes once when a persisted report result settles after reopening', async () => {
    const pendingReport: Extract<GroupOperationInput, { action: 'report' }> = {
      action: 'report',
      clientOperationId: 'report-1',
      conversationId: 'room-1',
      memberUserId: 'lan',
      reason: 'spam'
    }

    const onOpenChange = vi.fn()
    const onPendingReportChange = vi.fn()

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <GroupRoomReportDialog
          createOperationId={() => 'report-2'}
          onOpenChange={onOpenChange}
          onOperate={vi.fn()}
          onPendingReportChange={onPendingReportChange}
          open
          operationResults={[{ operationId: 'report-1', state: 'sent', conversationId: 'room-1', errorCode: null }]}
          pendingReport={pendingReport}
          room={room}
          target={{ kind: 'member', member: room.members[0]! }}
        />
      </I18nProvider>
    )

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledTimes(1))
    expect(onPendingReportChange).toHaveBeenCalledWith(null)
  })
})
