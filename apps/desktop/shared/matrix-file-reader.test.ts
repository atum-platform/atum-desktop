import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { parseFileAnswer, parseFileUpdate } from '../../../packages/device-protocol/agent-files'

import { type FileReaderAuthority, type FileReaderEvent, readFileAnswer, reduceFileUpdate } from './matrix-file-reader'
const root = new URL('../../../packages/device-protocol/fixtures/agent-turns-v1.7/', import.meta.url)
const load = (path: string) => JSON.parse(readFileSync(new URL(path, root), 'utf8'))
const pack = load('contract.json')
const answer = () => load('fixtures/files-owner_private-recovering-answer.json')

const event = (content = answer()): FileReaderEvent => ({
  eventId: '$answer',
  roomId: '!files:example.test',
  sender: '@agent:example.test',
  type: 'm.room.message',
  content
})

const authority = (): FileReaderAuthority => ({
  identity: answer()['io.atum.files'].identity,
  agentUserId: '@agent:example.test',
  triggerEventId: '$trigger'
})

const update = (outcome = 'committed'): FileReaderEvent => ({
  ...event(load(`fixtures/files-owner_private-${outcome}-update.json`)),
  eventId: '$update',
  type: 'io.atum.files.update'
})

describe('passive file reader', () => {
  for (const fixture of pack.fixtures.filter((f: { message?: string }) => f.message?.startsWith('files.'))) {
    it(fixture.file, () =>
      expect(
        Boolean(
          fixture.message === 'files.answer' ? parseFileAnswer(load(fixture.file)) : parseFileUpdate(load(fixture.file))
        )
      ).toBe(fixture.expect === 'accept')
    )
  }

  it('preserves the legacy invocation when parsing a 1.7 answer', () => {
    const parsed = parseFileAnswer(answer())!
    expect(parsed['io.atum.result'].invocation).toBe(parsed['io.atum.files'].identity.invocationId)
    expect(parsed['m.relates_to'].event_id).toBe(parsed['m.relates_to']['m.in_reply_to'].event_id)
    const missing = answer()
    delete missing['io.atum.result']
    expect(parseFileAnswer(missing)).toBeUndefined()
  })

  it('preserves fallback body through settlement, retry and history replay', () => {
    const state = readFileAnswer(event(), authority())!
    const saved = reduceFileUpdate(state, update(), authority())
    expect(saved.body).toBe(answer().body)
    expect(saved.files[0]!.state).toBe('saved')
    expect(reduceFileUpdate(saved, update(), authority())).toBe(saved)
    expect(reduceFileUpdate(readFileAnswer(event(), authority())!, update(), authority())).toEqual(saved)
  })
  it('ignores wrong sender/room/type/trigger/identity, redacted and legacy originals', () => {
    for (const changed of [
      { sender: '@other:example.test' },
      { roomId: '!other:example.test' },
      { type: 'm.room.encrypted' },
      { redacted: true }
    ]) {
      expect(readFileAnswer({ ...event(), ...changed }, authority())).toBeUndefined()
    }

    expect(readFileAnswer(event(), { ...authority(), triggerEventId: '$other' })).toBeUndefined()
    expect(
      readFileAnswer(event(), {
        ...authority(),
        identity: { ...authority().identity, taskId: 'abcdabcd-abcd-4abc-8abc-abcabcabcab9' }
      })
    ).toBeUndefined()
    expect(readFileAnswer(event({ body: 'legacy' }), authority())).toBeUndefined()
  })
  it('admits company private/channel identities but rejects stale incarnations', () => {
    const content = load('fixtures/files-company-recovering-answer.json')
    const auth = { ...authority(), identity: structuredClone(content['io.atum.files'].identity) }
    expect(readFileAnswer(event(content), auth)).toBeDefined()
    content['io.atum.files'].identity.audience.membershipIncarnation = 'abcdabcd-abcd-4abc-8abc-abcabcabcab9'
    expect(readFileAnswer(event(content), auth)).toBeUndefined()
    content['io.atum.files'].identity.audience = { kind: 'channel', channelId: 'abcdabcd-abcd-4abc-8abc-abcabcabcab8' }
    expect(readFileAnswer(event(content), { ...auth, identity: content['io.atum.files'].identity })).toBeDefined()
  })
  it('ignores unrelated updates, unknown keys, lower/equal revisions and terminal regressions', () => {
    const state = readFileAnswer(event(), authority())!

    for (const content of [load('fixtures/files-owner_private-committed-update.json')]) {
      content['io.atum.files'].file.fileKey = 'opaque_unknown_file'
      expect(reduceFileUpdate(state, { ...update(), content }, authority())).toBe(state)
      content['io.atum.files'].file.fileKey = state.files[0]!.fileKey
      content['io.atum.files'].answerEventId = '$other'
      expect(reduceFileUpdate(state, { ...update(), content }, authority())).toBe(state)
    }

    for (const changed of [{ sender: '@other:example.test' }, { roomId: '!other:example.test' }]) {
      expect(reduceFileUpdate(state, { ...update(), ...changed }, authority())).toBe(state)
    }

    for (const outcome of ['committed', 'committed_with_siblings', 'draft_evicted']) {
      const terminal = reduceFileUpdate(state, update(outcome), authority())
      const content = load('fixtures/files-owner_private-recovering-update.json')
      content['io.atum.files'].file.revision = 9
      expect(reduceFileUpdate(terminal, { ...update(), content }, authority())).toBe(terminal)
    }

    const content = load('fixtures/files-owner_private-committed-update.json')
    content['io.atum.files'].file.revision = 0
    expect(reduceFileUpdate(state, { ...update(), content }, authority())).toBe(state)
  })
  it('redaction never resurrects retained bytes; parsing isolates input and rejects duplicate keys', () => {
    const original = answer()
    const state = readFileAnswer(event(original), authority())!
    state.files[0]!.name = 'changed'
    expect(original['io.atum.files'].files[0].name).toBe('Plan.docx')
    original['io.atum.files'].files.push(original['io.atum.files'].files[0])
    expect(readFileAnswer(event(original), authority())).toBeUndefined()
    const redacted = reduceFileUpdate(state, { ...event(), redacted: true }, authority())
    expect(redacted.files).toEqual([])
    expect(reduceFileUpdate(redacted, update(), authority())).toBe(redacted)
    expect(reduceFileUpdate(state, { ...update(), redacted: true }, authority()).invalidated).toBe(true)
  })
  it('handles SDK-stripped redaction of the latest accepted update', () => {
    const state = readFileAnswer(event(), authority())!
    const saved = reduceFileUpdate(state, update(), authority())
    const redacted = reduceFileUpdate(saved, { ...update(), redacted: true, content: {} }, authority())
    expect(redacted.invalidated).toBe(true)
    expect(redacted.files).toEqual([])
  })
})
