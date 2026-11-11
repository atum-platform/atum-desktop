import { describe, expect, it } from 'vitest'

import type { MatrixMessage } from './matrix'
import {
  matrixAdmitCompanyPresentation,
  type MatrixCompanyPresentationBinding,
  matrixCompanyPresentationClaimed,
  matrixCompanyPresentationContent,
  sameMatrixCompanyTurn
} from './matrix-company-presentation'

// The frozen pack's shapes (agent-turns/1.6 company), with synthetic hex identifiers.
const COMPANY = '3c1a9e2b-7d4f-4a10-8b2e-5f6a7b8c9d0e'
const AGENT = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const CHANNEL = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'
const TASK = 'c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f'
const INVOCATION = 'd4e5f6a7-b8c9-4d0e-9f2a-3b4c5d6e7f8a'
const MEMBER = 'e5f6a7b8-c9d0-4e1f-8a3b-4c5d6e7f8a9b'
const INCARNATION = 'f6a7b8c9-d0e1-4f2a-9b4c-5d6e7f8a9b0c'
const ROOM = '!company:example.test'
const AGENT_USER = '@cos:example.test'

const channel = { kind: 'channel', channelId: CHANNEL } as const
const privatePair = { kind: 'private', memberPrincipal: MEMBER, membershipIncarnation: INCARNATION } as const

const marker = (audience: object = channel, revision = 0) => ({
  profile: 'atum.agent-turns/1.6',
  scope: 'company',
  companyId: COMPANY,
  agentPrincipal: AGENT,
  audience,
  roomId: ROOM,
  threadRootEventId: '$root',
  taskId: TASK,
  invocationId: INVOCATION,
  revision
})

const thread = {
  rel_type: 'm.thread',
  event_id: '$root',
  is_falling_back: false,
  'm.in_reply_to': { event_id: '$trigger' }
}

const progress = (audience: object = channel, patch: Record<string, unknown> = {}) => ({
  msgtype: 'm.notice',
  body: 'Checking the next step.',
  'io.atum.progress': { ...marker(audience), phase: 'working', kind: 'todo', ...patch },
  'm.relates_to': thread
})

const interim = (audience: object = channel) => ({
  msgtype: 'm.text',
  body: 'Let me look at the board first.',
  'io.atum.interim': true,
  'io.atum.company': marker(audience),
  'm.relates_to': thread
})

describe('reading a company presentation content (agent-turns/1.6)', () => {
  it('reads channel and private progress with the identity, the phase and the trigger', () => {
    for (const audience of [channel, privatePair]) {
      const read = matrixCompanyPresentationContent(progress(audience))

      expect(read).toEqual({
        stream: 'progress',
        identity: {
          companyId: COMPANY,
          agentPrincipal: AGENT,
          audience,
          roomId: ROOM,
          threadRootEventId: '$root',
          taskId: TASK,
          invocationId: INVOCATION,
          revision: 0,
          triggerEventId: '$trigger'
        },
        progress: { profile: 'atum.agent-turns/1.6', scope: 'company', phase: 'working', kind: 'todo', revision: 0 }
      })
    }
  })

  it('reads channel and private interim remarks as real messages', () => {
    expect(matrixCompanyPresentationContent(interim(channel))?.stream).toBe('interim')
    expect(matrixCompanyPresentationContent(interim(privatePair))?.stream).toBe('interim')
  })

  it('keeps device and heartbeat, and accepts an optional 1.5 descriptor without reading it', () => {
    const read = matrixCompanyPresentationContent({
      ...progress(channel, { phase: 'waiting', kind: 'device', device: 'MacBook', heartbeat: false }),
      'io.atum.presentation': { profile: 'atum.agent-turns/1.5' }
    })

    expect(read?.stream === 'progress' && read.progress).toMatchObject({
      phase: 'waiting',
      kind: 'device',
      device: 'MacBook',
      heartbeat: false
    })
  })

  it('refuses any field the contract keeps out of content (tool details, reasoning, authority)', () => {
    for (const key of ['toolArguments', 'toolResult', 'reasoning', 'modelToken', 'leaseToken', 'homeId', 'grant']) {
      expect(matrixCompanyPresentationContent({ ...progress(), [key]: 'not-public' })).toBeUndefined()
      expect(matrixCompanyPresentationContent({ ...interim(), [key]: 'not-public' })).toBeUndefined()
      expect(matrixCompanyPresentationContent(progress(channel, { [key]: 'not-public' }))).toBeUndefined()
      expect(
        matrixCompanyPresentationContent({ ...interim(), 'io.atum.company': { ...marker(), [key]: 'not-public' } })
      ).toBeUndefined()
    }
  })

  it('refuses a mixed audience, a personal marker, a missing task or a non-thread relation', () => {
    expect(matrixCompanyPresentationContent(progress({ ...channel, memberPrincipal: MEMBER }))).toBeUndefined()
    expect(
      matrixCompanyPresentationContent(progress(channel, { profile: 'atum.agent-turns/1.3', scope: 'owner_private' }))
    ).toBeUndefined()
    expect(matrixCompanyPresentationContent(progress(channel, { taskId: undefined }))).toBeUndefined()
    expect(matrixCompanyPresentationContent(progress(channel, { kind: 'interim' }))).toBeUndefined()
    expect(matrixCompanyPresentationContent(progress(channel, { revision: 49 }))).toBeUndefined()
    expect(matrixCompanyPresentationContent(progress(channel, { companyId: COMPANY.toUpperCase() }))).toBeUndefined()

    const { 'm.relates_to': _relation, ...unthreaded } = progress()

    expect(matrixCompanyPresentationContent(unthreaded)).toBeUndefined()
    expect(
      matrixCompanyPresentationContent({ ...progress(), 'm.relates_to': { ...thread, is_falling_back: true } })
    ).toBeUndefined()
    expect(
      matrixCompanyPresentationContent({ ...progress(), 'm.relates_to': { ...thread, event_id: '$other' } })
    ).toBeUndefined()
    expect(
      matrixCompanyPresentationContent({ ...interim(), 'm.relates_to': { rel_type: 'm.replace', event_id: '$x' } })
    ).toBeUndefined()
    expect(matrixCompanyPresentationContent({ ...interim(), 'io.atum.interim': 'yes' })).toBeUndefined()
    expect(matrixCompanyPresentationContent({ ...progress(), body: '' })).toBeUndefined()
    expect(matrixCompanyPresentationContent({ ...progress(), body: 'x'.repeat(1001) })).toBeUndefined()
  })

  it('says which contents claim the company profile, so they are never read as personal', () => {
    expect(matrixCompanyPresentationClaimed(progress())).toBe(true)
    expect(matrixCompanyPresentationClaimed({ ...interim(), 'io.atum.company': 'garbage' })).toBe(true)
    expect(matrixCompanyPresentationClaimed({ msgtype: 'm.text', body: 'x', 'io.atum.interim': true })).toBe(false)
    expect(
      matrixCompanyPresentationClaimed({
        msgtype: 'm.notice',
        body: 'x',
        'io.atum.progress': {
          profile: 'atum.agent-turns/1.3',
          scope: 'owner_private',
          phase: 'working',
          kind: 'todo',
          revision: 0
        }
      })
    ).toBe(false)
  })

  it('compares the immutable identity of a turn, including its trigger', () => {
    const left = matrixCompanyPresentationContent(progress())!.identity

    expect(sameMatrixCompanyTurn(left, { ...left, revision: 3 })).toBe(true)
    expect(sameMatrixCompanyTurn(left, { ...left, taskId: INVOCATION })).toBe(false)
    expect(sameMatrixCompanyTurn(left, { ...left, triggerEventId: '$root' })).toBe(false)
    expect(sameMatrixCompanyTurn(left, { ...left, audience: privatePair })).toBe(false)
  })
})

describe('admitting company presentation for the room bound agent', () => {
  const identity = matrixCompanyPresentationContent(progress())!.identity

  const binding: MatrixCompanyPresentationBinding = {
    companyId: COMPANY,
    agentPrincipal: AGENT,
    agentUserId: AGENT_USER,
    roomId: ROOM,
    audience: channel
  }

  const message = (patch: Partial<MatrixMessage>): MatrixMessage => ({
    id: '$line',
    sender: AGENT_USER,
    body: 'Checking the next step.',
    timestamp: 1,
    own: false,
    encrypted: false,
    decryptionFailed: false,
    pending: false,
    failed: false,
    attachment: false,
    notice: true,
    progress: { profile: 'atum.agent-turns/1.6', scope: 'company', phase: 'working', kind: 'todo', revision: 0 },
    company: identity,
    ...patch
  })

  it('keeps a line from the bound agent naming this company, agent, audience, room and thread', () => {
    const line = message({})

    expect(matrixAdmitCompanyPresentation([line], binding, '$root')[0]).toBe(line)
    expect(matrixAdmitCompanyPresentation([line], binding)[0]).toBe(line)
  })

  it('drops the company meaning for any mismatch, leaving the standard message', () => {
    const cases: Array<[Partial<MatrixMessage>, MatrixCompanyPresentationBinding | undefined, string?]> = [
      [{ sender: '@someone:example.test' }, binding],
      [{ own: true }, binding],
      [{}, { ...binding, agentPrincipal: MEMBER }],
      [{}, { ...binding, companyId: TASK }],
      [{}, { ...binding, roomId: '!other:example.test' }],
      [{}, { ...binding, audience: { kind: 'channel', channelId: TASK } }],
      [{}, { ...binding, audience: privatePair }],
      [{}, binding, '$another-root'],
      [{}, undefined]
    ]

    for (const [patch, against, root] of cases) {
      const [shown] = matrixAdmitCompanyPresentation([message(patch)], against, root)

      expect(shown).not.toHaveProperty('company')
      expect(shown).not.toHaveProperty('progress')
      expect(shown?.body).toBe('Checking the next step.')
      expect(shown?.notice).toBe(true)
    }

    const [remark] = matrixAdmitCompanyPresentation(
      [message({ notice: false, progress: undefined, interim: true, sender: '@someone:example.test' })],
      binding
    )

    expect(remark).not.toHaveProperty('interim')
  })

  it('never reads a personal marker as a working line in a company view, and changes nothing elsewhere', () => {
    const personal = message({
      company: undefined,
      progress: { profile: 'atum.agent-turns/1.3', scope: 'owner_private', phase: 'working', kind: 'todo', revision: 0 }
    })

    expect(matrixAdmitCompanyPresentation([personal], binding)[0]).not.toHaveProperty('progress')
    expect(matrixAdmitCompanyPresentation([personal], undefined)[0]).toBe(personal)
  })
})
