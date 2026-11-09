import { describe, expect, it, vi } from 'vitest'

import type { MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'

import { MatrixFirstRunWelcome } from './first-run-welcome'

const owner = { userId: '@minh:test', deviceId: 'MAC' }
const atum = { userId: '@atum:test', deviceId: 'ATUM' }

const chat = (dialogue?: MatrixRoom['dialogue']): MatrixRoom => ({
  id: '!first:test',
  name: 'Atum',
  membership: 'join',
  encrypted: true,
  assistant: true,
  roomType: MATRIX_ASSISTANT_ROOM_TYPE,
  participants: [
    { userId: owner.userId, membership: 'join' },
    { userId: atum.userId, membership: 'join' }
  ],
  ...(dialogue ? { dialogue } : {})
})

/** An account with no welcome record yet, as main publishes it after a complete sync. */
const unevaluated: MatrixSnapshot = {
  state: 'ready',
  identity: owner,
  assistant: atum,
  rooms: [],
  roomId: null,
  messages: [],
  error: null,
  firstRunMarker: 'unseen',
  firstRunWelcome: 'unseen',
  agents: [
    { principal: 'p-atum', userId: atum.userId, name: 'Atum', isDefault: true, ready: true, hermes: 'ready', atumModel: true }
  ]
}

function evaluator(write = vi.fn(async () => {}), clock = { now: 1_000 }) {
  const lines: string[] = []
  const flow = new MatrixFirstRunWelcome({ write, log: line => void lines.push(line), now: () => clock.now })

  return { flow, write, lines, clock }
}

describe("an account's welcome, evaluated once", () => {
  it('opens the welcome for a new account', () => {
    const { flow, write } = evaluator()

    flow.observe({ ...unevaluated, rooms: [chat('none')] })
    expect(write).toHaveBeenCalledExactlyOnceWith(owner, 'open')
  })

  it('writes done for an existing account, so its history never gets a welcome above it', () => {
    const { flow, write } = evaluator()

    // No folder answer and a week of chat: the cloud-first account from before the welcome existed.
    flow.observe({ ...unevaluated, rooms: [chat('started')] })
    expect(write).toHaveBeenCalledExactlyOnceWith(owner, 'done')
  })

  it('writes done for an account that already answered the folder offer', () => {
    const { flow, write } = evaluator()

    flow.observe({ ...unevaluated, firstRunMarker: 'answered' })
    expect(write).toHaveBeenCalledExactlyOnceWith(owner, 'done')
  })

  it('writes nothing while the verdict is unknown, and nothing for an account that has a record', () => {
    const { flow, write } = evaluator()

    // A chat whose loaded history cannot say; the marker not known yet; offline; no primary yet.
    flow.observe({ ...unevaluated, rooms: [chat()] })
    flow.observe({ ...unevaluated, firstRunMarker: 'unknown' })
    flow.observe({ ...unevaluated, state: 'offline' })
    flow.observe({ ...unevaluated, assistant: undefined })
    flow.observe({ ...unevaluated, firstRunWelcome: 'unknown' })

    for (const firstRunWelcome of ['open', 'done', 'dismissed'] as const) {
      flow.observe({ ...unevaluated, firstRunWelcome, rooms: [chat('started')] })
    }

    expect(write).not.toHaveBeenCalled()
  })

  it('is one write however many snapshots arrive while it is under way', async () => {
    let finish = () => {}

    const { flow, write } = evaluator(
      vi.fn(
        () =>
          new Promise<void>(resolve => {
            finish = resolve
          })
      )
    )

    flow.observe(unevaluated)
    flow.observe(unevaluated)
    flow.observe(unevaluated)
    expect(write).toHaveBeenCalledOnce()
    finish()
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
  })

  it('tries a failed write again only after a pause, and on to the same account', async () => {
    const write = vi.fn(async () => Promise.reject(new Error('offline')))
    const { flow, lines, clock } = evaluator(write)

    flow.observe(unevaluated)
    await vi.waitFor(() => expect(lines.length).toBeGreaterThan(0))
    expect(lines[0]).toContain('could not be evaluated yet')

    flow.observe(unevaluated)
    expect(write).toHaveBeenCalledOnce()

    clock.now += 31_000
    flow.observe(unevaluated)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('forgets a failure and work under way when the account signs out', async () => {
    const write = vi.fn(async () => Promise.reject(new Error('offline')))
    const { flow, lines } = evaluator(write)

    flow.observe(unevaluated)
    await vi.waitFor(() => expect(lines.length).toBeGreaterThan(0))
    flow.reset()
    flow.observe(unevaluated)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('logs the verdict without anything from the account’s chats', async () => {
    const { flow, lines } = evaluator()

    flow.observe({ ...unevaluated, rooms: [chat('started')] })
    await vi.waitFor(() => expect(lines.length).toBe(1))
    expect(lines[0]).toMatch(/not offered: the account already exists/)
    expect(lines[0]).not.toContain(owner.userId)
  })
})
