import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixAgentServiceStatus, MatrixMessage } from '../../shared/matrix'

import { MATRIX_NO_REPLY_MS, MatrixNoReplyBanner, matrixUnansweredOwnerMessage } from './no-reply-banner'

const OWNER = '@owner:test'
const AGENT = '@agent:test'
const PRINCIPAL = '00000000-0000-4000-8000-11e594f48195'
const START = Date.UTC(2026, 9, 11, 8, 0)

function message(overrides: Partial<MatrixMessage> = {}): MatrixMessage {
  return {
    id: '$owner',
    sender: OWNER,
    body: 'Are you there?',
    timestamp: START,
    own: true,
    encrypted: true,
    decryptionFailed: false,
    pending: false,
    failed: false,
    attachment: false,
    ...overrides
  }
}

const working: MatrixAgentServiceStatus = {
  profile: 'atum.agent-service-status/1',
  agentPrincipal: PRINCIPAL,
  state: 'working',
  asOf: START + MATRIX_NO_REPLY_MS
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('unanswered owner messages', () => {
  it('keeps the oldest sent owner message after the latest real answer', () => {
    const first = message()
    const second = message({ id: '$second', timestamp: START + 1_000 })
    const notice = message({ id: '$notice', own: false, sender: AGENT, notice: true, timestamp: START + 2_000 })

    expect(matrixUnansweredOwnerMessage([first, second, notice], new Set([AGENT]))).toBe(first)
    expect(
      matrixUnansweredOwnerMessage(
        [...[first, second, notice], message({ id: '$answer', own: false, sender: AGENT, timestamp: START + 3_000 })],
        new Set([AGENT])
      )
    ).toBeNull()
  })

  it('never counts the agent\u2019s progress line as an answer, even one that names the owner event', () => {
    const owner = message()

    const progress = message({
      id: '$progress',
      own: false,
      sender: AGENT,
      notice: true,
      replyTo: '$owner',
      progress: { profile: 'atum.agent-turns/1.3', scope: 'owner_private', phase: 'working', kind: 'interim', revision: 0 },
      timestamp: START + 1_000
    })

    expect(matrixUnansweredOwnerMessage([owner, progress], new Set([AGENT]))).toBe(owner)
    // Only the final answer ends it; the progress line settling changes nothing.
    expect(
      matrixUnansweredOwnerMessage(
        [owner, { ...progress, progress: { ...progress.progress!, phase: 'settled', kind: 'settled', revision: 2 } }],
        new Set([AGENT])
      )
    ).toBe(owner)
    expect(
      matrixUnansweredOwnerMessage(
        [owner, progress, message({ id: '$answer', own: false, sender: AGENT, timestamp: START + 5_000 })],
        new Set([AGENT])
      )
    ).toBeNull()
  })

  it('never counts the agent\u2019s interim remark as an answer: only the answer ends the wait', () => {
    const owner = message()
    const interim = message({ id: '$interim', own: false, sender: AGENT, interim: true, timestamp: START + 1_000 })

    expect(matrixUnansweredOwnerMessage([owner, interim], new Set([AGENT]))).toBe(owner)
    expect(
      matrixUnansweredOwnerMessage(
        [owner, interim, message({ id: '$answer', own: false, sender: AGENT, timestamp: START + 5_000 })],
        new Set([AGENT])
      )
    ).toBeNull()
  })

  it('does not warn for a failed or deleted send', () => {
    expect(matrixUnansweredOwnerMessage([message({ pending: true })], new Set([AGENT]))).toBeNull()
    expect(matrixUnansweredOwnerMessage([message({ failed: true })], new Set([AGENT]))).toBeNull()
    expect(matrixUnansweredOwnerMessage([message({ redacted: true })], new Set([AGENT]))).toBeNull()
  })

  it('does not treat an unreadable or deleted agent event as an answer', () => {
    const owner = message()

    for (const answer of [
      message({ id: '$pending', own: false, sender: AGENT, pending: true }),
      message({ id: '$failed', own: false, sender: AGENT, failed: true }),
      message({ id: '$redacted', own: false, sender: AGENT, redacted: true }),
      message({ id: '$encrypted', own: false, sender: AGENT, decryptionFailed: true })
    ]) {
      expect(matrixUnansweredOwnerMessage([owner, answer], new Set([AGENT]))).toBe(owner)
    }
  })

  it('lets an agent notice resolve only the owner event it names', () => {
    const first = message()
    const second = message({ id: '$second', timestamp: START + 1_000 })
    const interrupted = message({
      id: '$interrupted',
      own: false,
      sender: AGENT,
      notice: true,
      replyTo: first.id,
      timestamp: START + 2_000
    })

    expect(matrixUnansweredOwnerMessage([first, second, interrupted], new Set([AGENT]))).toBe(second)
    expect(matrixUnansweredOwnerMessage([first, interrupted], new Set([AGENT]))).toBeNull()
  })
})

describe('three-minute no-reply banner', () => {
  it('shows the generic words at three minutes even when status cannot be read', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
    const readStatus = vi.fn(async () => Promise.reject(new Error('offline')))
    render(
      <MatrixNoReplyBanner
        agentPrincipal={PRINCIPAL}
        assistantName="Atum"
        locale="en"
        message={message()}
        readStatus={readStatus}
        typing={false}
      />
    )

    expect(screen.queryByText(/hasn't been able/u)).toBeNull()
    await act(async () => void (await vi.advanceTimersByTimeAsync(MATRIX_NO_REPLY_MS)))
    expect(screen.getByText("Atum hasn't been able to answer yet. Atum will answer as soon as it can.")).toBeTruthy()
    expect(readStatus).toHaveBeenCalledTimes(1)
  })

  it('offers Send again only once the wait is due', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
    const onResend = vi.fn()
    render(
      <MatrixNoReplyBanner
        agentPrincipal={PRINCIPAL}
        assistantName="Atum"
        locale="en"
        message={message()}
        onResend={onResend}
        typing={false}
      />
    )

    expect(screen.queryByRole('button', { name: 'Send again' })).toBeNull()

    await act(async () => void (await vi.advanceTimersByTimeAsync(MATRIX_NO_REPLY_MS)))
    const button = screen.getByRole('button', { name: 'Send again' })
    expect(button).toBeTruthy()
    expect(button).toHaveProperty('disabled', false)
  })

  it('resends the unanswered message once, then waits for a reply or a new message', () => {
    vi.useFakeTimers()
    vi.setSystemTime(START + MATRIX_NO_REPLY_MS)
    const onResend = vi.fn()

    const view = render(
      <MatrixNoReplyBanner
        agentPrincipal={PRINCIPAL}
        assistantName="Atum"
        locale="en"
        message={message()}
        onResend={onResend}
        typing={false}
      />
    )

    const button = screen.getByRole('button', { name: 'Send again' })
    fireEvent.click(button)
    fireEvent.click(button)

    expect(onResend).toHaveBeenCalledTimes(1)
    expect(onResend).toHaveBeenCalledWith('Are you there?')
    expect(button).toHaveProperty('disabled', true)

    view.rerender(
      <MatrixNoReplyBanner
        agentPrincipal={PRINCIPAL}
        assistantName="Atum"
        locale="en"
        message={message({ id: '$next' })}
        onResend={onResend}
        typing={false}
      />
    )
    const next = screen.getByRole('button', { name: 'Send again' })
    fireEvent.click(next)

    expect(next).toHaveProperty('disabled', true)
    expect(onResend).toHaveBeenCalledTimes(2)
  })

  it('hides the Send again action while the agent is typing', () => {
    vi.useFakeTimers()
    vi.setSystemTime(START + MATRIX_NO_REPLY_MS)
    const onResend = vi.fn()
    render(
      <MatrixNoReplyBanner
        agentPrincipal={PRINCIPAL}
        assistantName="Atum"
        locale="en"
        message={message()}
        onResend={onResend}
        typing
      />
    )

    expect(screen.queryByText(/hasn't been able/u)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send again' })).toBeNull()
  })

  it('uses the server-down time, hides while typing, and goes away with the answered message', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(START + MATRIX_NO_REPLY_MS)
    const down: MatrixAgentServiceStatus = {
      ...working,
      state: 'server_down',
      serverDownSince: START + 90_000
    }
    const readStatus = vi.fn(async () => down)
    const view = render(
      <MatrixNoReplyBanner
        agentPrincipal={PRINCIPAL}
        assistantName="Atum"
        locale="en"
        message={message()}
        readStatus={readStatus}
        typing={false}
      />
    )

    await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
    expect(screen.getByText(/server has had a problem since/u)).toBeTruthy()

    view.rerender(
      <MatrixNoReplyBanner
        agentPrincipal={PRINCIPAL}
        assistantName="Atum"
        locale="en"
        message={message()}
        readStatus={readStatus}
        typing
      />
    )
    expect(screen.queryByText(/server has had a problem/u)).toBeNull()

    view.rerender(
      <MatrixNoReplyBanner
        agentPrincipal={PRINCIPAL}
        assistantName="Atum"
        locale="en"
        message={null}
        readStatus={readStatus}
        typing={false}
      />
    )
    expect(screen.queryByText(/hasn't been able/u)).toBeNull()
  })
})
