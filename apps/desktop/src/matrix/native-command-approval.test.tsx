import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixMessage, MatrixReaction } from '../../shared/matrix'
import type { MatrixNativeCommandConfirm, MatrixNativeMacBridge } from '../../shared/matrix-native-mac'
import { matrixNativeMacCopy } from '../../shared/matrix-native-mac-copy'

import {
  type MatrixNativeApproval,
  matrixNativeApproval,
  MatrixNativeApprovalCard,
  NATIVE_APPROVE_KEY,
  NATIVE_DENY_KEY
} from './native-command-approval'

const AGENT = '@assistant:test.invalid'
const COMMAND = 'rm -rf ~/Projects/old-build'
const NOW = 1_800_000_000_000
const words = matrixNativeMacCopy.en.approval

/** What the Hermes Matrix gateway posts (header, fence, reason, deadline, typed hints, legend). */
const BODY = [
  '⚠️ **Hermes wants to run a command that needs your OK**',
  '```',
  COMMAND,
  '```',
  'Why it was flagged: recursive delete',
  '',
  "If you don't answer within 5 minutes it will NOT run.",
  '',
  'Reply `!approve` to execute once, or `!deny` to cancel.',
  '',
  'You can also click the reaction to approve:',
  '✅ = approve once',
  '❎ = deny'
].join('\n')

const seeded: MatrixReaction[] = [
  { key: NATIVE_APPROVE_KEY, count: 1, own: false, senders: [AGENT] },
  { key: NATIVE_DENY_KEY, count: 1, own: false, senders: [AGENT] }
]

function message(overrides: Partial<MatrixMessage> = {}): MatrixMessage {
  return {
    id: '$approval',
    sender: AGENT,
    body: BODY,
    timestamp: NOW,
    own: false,
    encrypted: true,
    decryptionFailed: false,
    pending: false,
    failed: false,
    attachment: false,
    reactions: seeded,
    ...overrides
  }
}

afterEach(cleanup)

describe('reading a native Hermes approval from its Matrix message', () => {
  it('finds the command and reason and waits while the gateway has seeded its answers', () => {
    expect(matrixNativeApproval(message(), NOW + 1_000)).toEqual({
      command: COMMAND,
      reason: 'recursive delete',
      state: 'waiting'
    })
  })

  it('reads the same message in another language by its typed commands, not its words', () => {
    const vietnamese = BODY.replace('Why it was flagged', 'Lý do bị gắn cờ').replace(
      'Reply `!approve` to execute once, or `!deny` to cancel.',
      'Trả lời `!approve` để chạy một lần, hoặc `!deny` để hủy.'
    )

    expect(matrixNativeApproval(message({ body: vietnamese }), NOW)?.reason).toBe('recursive delete')
  })

  it('answered by you is approved or denied, from any of your devices', () => {
    const approved = [...seeded, { key: NATIVE_APPROVE_KEY, count: 2, own: true, senders: [AGENT, '@owner:test.invalid'] }]
    const denied = [{ key: '❎', count: 1, own: true, senders: ['@owner:test.invalid'] }]

    expect(matrixNativeApproval(message({ reactions: approved }), NOW)?.state).toBe('approved')
    expect(matrixNativeApproval(message({ reactions: denied }), NOW)?.state).toBe('denied')
  })

  it('without its seeded answers it is arriving when fresh and closed later', () => {
    expect(matrixNativeApproval(message({ reactions: undefined }), NOW + 2_000)?.state).toBe('arriving')
    expect(matrixNativeApproval(message({ reactions: undefined }), NOW + 60_000)?.state).toBe('closed')
  })

  it('ignores your own messages, plain code and answers someone else seeded', () => {
    expect(matrixNativeApproval(message({ own: true }), NOW)).toBeNull()
    expect(matrixNativeApproval(message({ body: '```\nls\n```' }), NOW)).toBeNull()
    expect(matrixNativeApproval(message({ body: 'Reply `!approve` or `!deny`.' }), NOW)).toBeNull()

    const foreign = [{ key: NATIVE_APPROVE_KEY, count: 1, own: false, senders: ['@someone:test.invalid'] }]
    expect(matrixNativeApproval(message({ reactions: foreign }), NOW + 60_000)?.state).toBe('closed')
  })
})

function renderCard(
  approval: MatrixNativeApproval,
  presence: MatrixNativeCommandConfirm | Error = 'confirmed',
  bridgeMissing = false
) {
  const confirmCommand = vi.fn(async () => {
    if (presence instanceof Error) {
      throw presence
    }

    return presence
  })

  const send = vi.fn(async () => undefined)
  const bridge = bridgeMissing ? undefined : ({ ssh: vi.fn(), confirmCommand } as unknown as MatrixNativeMacBridge)

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixNativeApprovalCard approval={approval} bridge={bridge} eventId="$approval" roomId="!room:test" send={send} />
    </I18nProvider>
  )

  return { confirmCommand, send }
}

const waiting: MatrixNativeApproval = { command: COMMAND, reason: 'recursive delete', state: 'waiting' }

describe('the approval card', () => {
  it('asks in one line where it runs, with the command on one line and the rest one click away', () => {
    renderCard(waiting)

    expect(screen.getByText(words.title)).toBeTruthy()
    expect(screen.getByText(COMMAND)).toBeTruthy()
    expect(screen.queryByText(/recursive delete/u)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: words.showAll }))

    expect(screen.getByText(`${words.why}: recursive delete`)).toBeTruthy()
    expect(screen.getByRole('button', { name: words.showAll }).getAttribute('aria-expanded')).toBe('true')
  })

  it('asks for Touch ID first, then answers that exact prompt with its approve reaction', async () => {
    const { confirmCommand, send } = renderCard(waiting)

    fireEvent.click(screen.getByRole('button', { name: words.approve }))

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(confirmCommand).toHaveBeenCalledWith(COMMAND)
    expect(confirmCommand.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!)
    expect(send).toHaveBeenCalledWith({
      kind: 'react',
      roomId: '!room:test',
      eventId: '$approval',
      key: NATIVE_APPROVE_KEY,
      reacted: true
    })
    expect((await screen.findByRole('status')).textContent).toBe(words.approved)
  })

  it('sends nothing when Touch ID is cancelled, and keeps asking', async () => {
    const { confirmCommand, send } = renderCard(waiting, 'declined')

    fireEvent.click(screen.getByRole('button', { name: words.approve }))

    await waitFor(() => expect(confirmCommand).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByRole('button', { name: words.approve })).toBeTruthy())
    expect(send).not.toHaveBeenCalled()
  })

  it('denies without Touch ID', async () => {
    const { confirmCommand, send } = renderCard(waiting)

    fireEvent.click(screen.getByRole('button', { name: words.deny }))

    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ key: NATIVE_DENY_KEY })))
    expect(confirmCommand).not.toHaveBeenCalled()
    expect((await screen.findByRole('status')).textContent).toBe(words.denied)
  })

  it('without a way to ask on this Mac, it says to approve on the phone and keeps Deny', async () => {
    const { send } = renderCard(waiting, 'unavailable')

    fireEvent.click(screen.getByRole('button', { name: words.approve }))

    expect(await screen.findByText(words.unavailable)).toBeTruthy()
    expect(screen.queryByRole('button', { name: words.approve })).toBeNull()
    expect(screen.getByRole('button', { name: words.deny })).toBeTruthy()
    expect(send).not.toHaveBeenCalled()
  })

  it('a reaction that does not send says so and lets the owner try again', async () => {
    const { send } = renderCard(waiting)
    send.mockRejectedValueOnce(new Error('offline'))

    fireEvent.click(screen.getByRole('button', { name: words.deny }))

    expect(await screen.findByText(words.sendFailed)).toBeTruthy()
    expect((screen.getByRole('button', { name: words.deny }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('an answered, arriving or closed prompt offers nothing to press', () => {
    renderCard({ ...waiting, state: 'closed' })
    expect(screen.getByRole('status').textContent).toBe(words.closed)
    expect(screen.queryByRole('button', { name: words.approve })).toBeNull()
    cleanup()

    renderCard({ ...waiting, state: 'arriving' })
    expect((screen.getByRole('button', { name: words.approve }) as HTMLButtonElement).disabled).toBe(true)
  })
})
