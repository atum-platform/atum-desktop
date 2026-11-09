import { expect, it } from 'vitest'

import { parseMatrixCommand } from '../ipc-policy'

import { groupBudget, groupPauseBudget, groupPausedTransaction } from './budget'
import { requireGroupPolicyRead } from './policy-read'

const read = { policy: { v: 1, agents: {} }, usage: { v: 1, day: '2026-10-07', turns: 30 } }

it('refuses renderer attempts to read or write the native participation ports', () => {
  for (const kind of ['readRoomPolicy', 'readGroupSettled', 'writeRoomUsage']) {
    expect(() =>
      parseMatrixCommand({
        kind,
        roomId: '!room:test',
        ownerId: '@owner:test',
        agentId: '@one:test',
        eventId: '$owner',
        agentIds: ['@one:test'],
        change: 'claimed',
        dailyTurns: 200
      })
    ).toThrow('matrix_command_invalid')
  }
})

it('validates the native projection, refuses malformed/future policy, and pauses before any claim', () => {
  expect(groupBudget(requireGroupPolicyRead(read), Date.UTC(2026, 9, 7))).toMatchObject({
    allowed: false,
    notice: true
  })

  for (const value of [
    null,
    {},
    { ...read, policy: { v: 2, agents: {} } },
    { ...read, usage: { ...read.usage, turns: -1 } }
  ]) {
    expect(() => requireGroupPolicyRead(value)).toThrow('matrix_group_policy_unreadable')
  }
})

it('a cap raise resumes and a paused receipt suppresses duplicate notices until UTC reset', () => {
  const current = requireGroupPolicyRead({ ...read, usage: { ...read.usage, pausedNoticed: true } })
  expect(groupBudget(current, Date.UTC(2026, 9, 7))).toMatchObject({ allowed: false, notice: false })
  expect(
    groupBudget({ ...current, policy: { ...current.policy, dailyTurns: 31 } }, Date.UTC(2026, 9, 7))
  ).toMatchObject({ allowed: true })
  expect(groupBudget(current, Date.UTC(2026, 9, 8))).toMatchObject({ allowed: true, turns: 0 })
  expect(groupPausedTransaction('!room:test', '2026-10-07')).toBe(groupPausedTransaction('!room:test', '2026-10-07'))
  expect(groupPausedTransaction('!room:test', '2026-10-08')).not.toBe(
    groupPausedTransaction('!room:test', '2026-10-07')
  )
})

it('a canonical refusal can repair undercount without repeating a notice or overwriting a cap raise', () => {
  const now = Date.UTC(2026, 9, 7)
  const undercount = requireGroupPolicyRead({ ...read, usage: { ...read.usage, turns: 2 } })
  expect(groupPauseBudget(undercount, { position: 0, canonicalCap: 30, now })).toMatchObject({ cap: 30 })
  expect(groupPauseBudget(undercount, { position: 0, now })).toBeUndefined()
  expect(groupPauseBudget(undercount, { position: 1, canonicalCap: 30, now })).toBeUndefined()
  expect(
    groupPauseBudget(
      { ...undercount, usage: { ...undercount.usage, pausedNoticed: true } },
      { position: 0, canonicalCap: 30, now }
    )
  ).toBeUndefined()
  expect(
    groupPauseBudget(
      { ...undercount, policy: { ...undercount.policy, dailyTurns: 31 } },
      { position: 0, canonicalCap: 30, now }
    )
  ).toBeUndefined()
})
