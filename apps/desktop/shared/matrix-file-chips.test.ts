import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { matrixAgentStatusText } from './matrix-agent-status-copy'
import {
  matrixAdmittedFiles,
  matrixFileAnswerBody,
  matrixFileAnswerProjection,
  type MatrixFileBinding,
  matrixFileBindingForRoom,
  matrixFileGlyph,
  matrixHideFileStatusNotices
} from './matrix-file-chips'
import type { FileReaderEvent } from './matrix-file-reader'

const root = new URL('../../../packages/device-protocol/fixtures/agent-turns-v1.7/fixtures/', import.meta.url)
const load = (name: string) => JSON.parse(readFileSync(new URL(name, root), 'utf8'))

const owner = '@owner:example.test'
const agentUser = '@agent:example.test'
const roomId = '!files:example.test'

const answerEvent = (content: unknown, sender = agentUser): FileReaderEvent => ({
  eventId: '$answer',
  roomId,
  sender,
  type: 'm.room.message',
  content
})

const updateEvent = (outcome: string, revision: number, eventId = `$u-${outcome}`, sender = agentUser): FileReaderEvent => {
  const content = load(`files-owner_private-${outcome}-update.json`)
  content['io.atum.files'].file.revision = revision

  return { eventId, roomId, sender, type: 'io.atum.files.update', content }
}

const personal = (scope = 'owner_private', outcome = 'recovering') => load(`files-${scope}-${outcome}-answer.json`)

function personalBinding(overrides: Partial<MatrixFileBinding> = {}): MatrixFileBinding {
  const identity = personal()['io.atum.files'].identity

  return {
    roomId,
    ownerPrincipal: identity.ownerPrincipal,
    ownerUserId: owner,
    agents: [{ principal: identity.agentPrincipal, userId: agentUser }],
    roomAgentPrincipal: identity.agentPrincipal,
    ...overrides
  }
}

const message = (content = personal(), sender = agentUser, triggerSender: string | null = owner) => ({
  id: '$answer',
  sender,
  own: false,
  files: matrixFileAnswerProjection(answerEvent(content, sender), [], triggerSender ?? undefined)
})

describe('file chip projection (history replay)', () => {
  const states = [
    ['recovering', 'saving'],
    ['committed', 'saved'],
    ['committed_with_siblings', 'saved_as_copy'],
    ['terminal_unknown', 'not_confirmed'],
    ['refused', 'not_confirmed'],
    ['draft_evicted', 'expired']
  ] as const

  for (const [outcome, state] of states) {
    it(`an answer sent as ${outcome} shows ${state}`, () => {
      expect(matrixFileAnswerProjection(answerEvent(personal('owner_private', outcome)), [], owner)?.files[0]?.state).toBe(
        state
      )
    })
  }

  it('settles a saving chip by its updates, whatever order the room returns them in', () => {
    const projected = matrixFileAnswerProjection(
      answerEvent(personal()),
      [updateEvent('committed', 2), updateEvent('recovering', 1)],
      owner
    )

    expect(projected).toMatchObject({ triggerEventId: '$trigger', triggerSender: owner })
    expect(projected?.files.map(file => [file.state, file.revision])).toEqual([['saved', 2]])
    // The answer's words never change with the file's state.
    expect(personal().body).toBe('Here is the plan.')
  })

  it('ignores an update from anyone but the answer’s sender, and a redaction leaves no chip', () => {
    const spoofed = matrixFileAnswerProjection(answerEvent(personal()), [updateEvent('committed', 2, '$x', '@mallory:example.test')])
    expect(spoofed?.files[0]?.state).toBe('saving')

    const redacted = matrixFileAnswerProjection(answerEvent(personal()), [
      updateEvent('committed', 2),
      { ...updateEvent('draft_evicted', 3), redacted: true, content: {} }
    ])

    expect(redacted?.files[0]?.state).toBe('saved')
    expect(matrixFileAnswerProjection({ ...answerEvent(personal()), redacted: true }, [])).toBeUndefined()
  })

  it('reads no chip from a message without a valid 1.7 marker', () => {
    expect(matrixFileAnswerProjection(answerEvent({ msgtype: 'm.text', body: 'Here is the plan.' }), [])).toBeUndefined()
    expect(matrixFileAnswerProjection(answerEvent(load('files-owner_private-committed-warning.json')), [])).toBeUndefined()
    expect(matrixFileAnswerProjection(answerEvent(load('files-owner_private-committed-path.json')), [])).toBeUndefined()
  })
})

describe('file chip admission (platform binding)', () => {
  it('shows chips for the owner’s agent in its own room, answering the owner', () => {
    expect(matrixAdmittedFiles(message(), personalBinding())?.map(file => file.name)).toEqual(['Plan.docx'])
  })

  it('ignores a stray or spoofed chip and keeps the message as it was', () => {
    const cases: [ReturnType<typeof message>, MatrixFileBinding][] = [
      [message(personal(), '@mallory:example.test'), personalBinding()],
      [message(), personalBinding({ agents: [{ principal: 'another-agent', userId: agentUser }] })],
      [message(), personalBinding({ roomAgentPrincipal: undefined })],
      [message(), personalBinding({ roomId: '!other:example.test' })],
      [message(), personalBinding({ companyChannel: { companyId: 'c', channelId: 'h' } })],
      [message(personal(), agentUser, '@mallory:example.test'), personalBinding()],
      [message(personal(), agentUser, null), personalBinding()],
      [{ ...message(), own: true }, personalBinding()]
    ]

    for (const [candidate, binding] of cases) {
      expect(matrixAdmittedFiles(candidate, binding)).toBeUndefined()
    }
  })

  it('admits a company channel answer only from that company’s Chief of Staff in that channel', () => {
    const content = personal('company', 'committed')
    const identity = content['io.atum.files'].identity
    identity.audience = { kind: 'channel', channelId: 'abcdabcd-abcd-4abc-8abc-abcabcabcab8' }
    const member = '@member:example.test'

    const binding: MatrixFileBinding = {
      roomId,
      companyChannel: { companyId: identity.companyId, channelId: identity.audience.channelId },
      companyAgent: { companyId: identity.companyId, principal: identity.agentPrincipal, userId: agentUser }
    }

    expect(matrixAdmittedFiles(message(content, agentUser, member), binding)).toHaveLength(1)
    expect(
      matrixAdmittedFiles(message(content, agentUser, member), {
        ...binding,
        companyChannel: { ...binding.companyChannel!, channelId: 'abcdabcd-abcd-4abc-8abc-abcabcabcab9' }
      })
    ).toBeUndefined()
    expect(matrixAdmittedFiles(message(content, agentUser, member), { ...binding, companyAgent: undefined })).toBeUndefined()
    // A private Chief of Staff pair is not admitted by a channel binding.
    expect(matrixAdmittedFiles(message(personal('company', 'committed'), agentUser, member), binding)).toBeUndefined()
  })

  it('binds only an agent’s own room, never a company room', () => {
    const room = { id: roomId, assistant: true, agentPrincipal: 'p' }
    expect(matrixFileBindingForRoom(room, {})?.roomAgentPrincipal).toBe('p')
    expect(matrixFileBindingForRoom({ ...room, assistant: false }, {})?.roomAgentPrincipal).toBeUndefined()
    expect(matrixFileBindingForRoom({ ...room, companyPrivateCos: {} }, {})?.roomAgentPrincipal).toBeUndefined()
    expect(matrixFileBindingForRoom(undefined, {})).toBeUndefined()
  })
})

describe('answers are only the agent’s words', () => {
  it('drops Atum’s own trailing sentences in any locale, and only those', () => {
    for (const locale of ['vi', 'en', 'ja'] as const) {
      const saved = matrixAgentStatusText('saved_to_drive', locale)
      const memory = matrixAgentStatusText('memory_not_saved', locale)
      expect(matrixFileAnswerBody(`Here is the plan.\n\n${saved}\n\n${memory}`)).toBe('Here is the plan.')
    }

    const own = `I put it in Documents.\n\n${matrixAgentStatusText('saved_to_drive', 'en')} Then I checked it twice.`
    expect(matrixFileAnswerBody(own)).toBe(own)
    expect(matrixFileAnswerBody(matrixAgentStatusText('saved_to_drive', 'en'))).toBe(
      matrixAgentStatusText('saved_to_drive', 'en')
    )
  })

  it('leaves out a file or memory notice about a question whose answer shows its files', () => {
    const answer = message()

    const notice = (code: string, id: string, sender = agentUser, replyTo = '$trigger') => ({
      id,
      sender,
      own: false,
      notice: true,
      replyTo,
      cloudStatus: { code }
    })

    const messages = [
      answer,
      notice('memory_not_saved', '$memory'),
      notice('saved_as_copy', '$copy'),
      notice('daily_cap', '$cap'),
      notice('memory_not_saved', '$elsewhere', agentUser, '$other'),
      notice('memory_not_saved', '$stranger', '@mallory:example.test')
    ]

    expect(matrixHideFileStatusNotices(messages, personalBinding()).map(each => each.id)).toEqual([
      '$answer',
      '$cap',
      '$elsewhere',
      '$stranger'
    ])
    // An old answer (no chips) keeps every notice beside it, as today.
    const legacy = [{ id: '$old', sender: agentUser, own: false }, notice('memory_not_saved', '$memory')]
    expect(matrixHideFileStatusNotices(legacy, personalBinding())).toEqual(legacy)
  })
})

it('picks the kit glyph from the file’s real name', () => {
  expect(['Kế hoạch Q4.docx', 'Báo giá (bản 2).xlsx', 'a.PDF', 'notes', 'photo.heic'].map(matrixFileGlyph)).toEqual([
    'file-doc',
    'file-xls',
    'file-pdf',
    'file',
    'image'
  ])
})


it('requires exact signed-in principal ownership even when roster and sender match', () => {
  expect(matrixAdmittedFiles(message(), personalBinding())).toHaveLength(1)
  const principal = personalBinding().ownerPrincipal!
  for (const ownerPrincipal of [undefined, '', principal.toUpperCase(), `${principal} `, 'another-owner']) {
    expect(matrixAdmittedFiles(message(), personalBinding({ ownerPrincipal }))).toBeUndefined()
  }
  const binding = matrixFileBindingForRoom(
    { id: roomId, assistant: true, agentPrincipal: personalBinding().roomAgentPrincipal }, personalBinding()
  )!
  expect(matrixAdmittedFiles(message(), binding)).toHaveLength(1)
})
