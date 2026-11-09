import { describe, expect, it } from 'vitest'

import type { MatrixLocalTurnView, MatrixMessage } from '../../shared/matrix'
import { en } from '../i18n/en'
import { ja } from '../i18n/ja'
import { vi as viCopy } from '../i18n/vi'
import { zh } from '../i18n/zh'
import { zhHant } from '../i18n/zh-hant'

import { matrixAgentTyping, matrixTurnStatus, mergeLocalTurns } from './local-turns'

const turnId = '00000000-0000-4000-8000-31f949766961'

const view = (patch: Partial<MatrixLocalTurnView> = {}): MatrixLocalTurnView => ({
  turnId,
  roomId: '!room:test',
  text: 'Hello',
  createdAt: 2_000,
  state: 'running',
  synced: { question: false, answer: false },
  ...patch
})

const room = (id: string, timestamp: number, patch: Partial<MatrixMessage> = {}): MatrixMessage => ({
  id,
  sender: '@owner:test',
  body: id,
  timestamp,
  own: true,
  encrypted: true,
  decryptionFailed: false,
  pending: false,
  failed: false,
  attachment: false,
  ...patch
})

describe('merging local turns into the transcript', () => {
  it('shows the question at once, before any room event exists', () => {
    const entries = mergeLocalTurns([room('$old', 1_000)], [view()], { human: '@owner:test', assistant: '@a:test' })
    expect(entries.map(entry => entry.message.id)).toEqual(['$old', `local-q-${turnId}`])
    expect(entries[1]?.local?.role).toBe('question')
  })

  it('never shows a turn twice: its room echo, pending or sent, is hidden while the turn is listed', () => {
    const entries = mergeLocalTurns(
      [room('~pending', 2_001, { turn: turnId, pending: true }), room('$answer', 2_500, { turn: turnId, own: false })],
      [view({ state: 'answered', answer: 'Hi!' })],
      { human: '@owner:test', assistant: '@a:test' }
    )

    expect(entries.map(entry => entry.message.id)).toEqual([`local-q-${turnId}`, `local-a-${turnId}`])
    expect(entries[1]?.message).toMatchObject({ body: 'Hi!', sender: '@a:test', own: false })
  })

  it('leaves the room events alone once main drops the turn', () => {
    const entries = mergeLocalTurns([room('$q', 2_000, { turn: turnId })], [], {})
    expect(entries.map(entry => entry.message.id)).toEqual(['$q'])
  })
})

describe('turn status copy', () => {
  const copy = en.matrixShell

  it.each([
    [view({ state: 'not_sent' }), copy.turnNotSent, 'retry'],
    [view({ state: 'interrupted' }), copy.turnInterrupted, 'retry'],
    [view({ state: 'interrupted', notice: 'offline' }), copy.readinessOffline, 'retry'],
    [view({ state: 'interrupted', notice: 'ai_unavailable' }), copy.readinessAiUnavailable, 'retry'],
    [view({ state: 'interrupted', notice: 'out_of_protons' }), copy.readinessOutOfProtons, 'top_up']
  ])('%# says a failure plainly, with the one thing to do', (input, text, action) => {
    expect(matrixTurnStatus(input, 'question', copy)).toEqual({ text, tone: 'notice', action })
  })

  it('says nothing about progress: waiting, a long wait, syncing, answering elsewhere or done', () => {
    for (const input of [
      view({ state: 'waiting' }),
      view({ state: 'running' }),
      view({ state: 'running', notice: 'still_waiting' }),
      view({ state: 'answered', notice: 'not_synced' }),
      view({ state: 'done', notice: 'not_synced', synced: { question: false, answer: false } }),
      view({ state: 'handed_off' }),
      view({ state: 'handed_off', notice: 'answered_elsewhere' }),
      view({ state: 'handed_off', route: 'cloud', notice: 'still_waiting' })
    ]) {
      expect(matrixTurnStatus(input, 'question', copy)).toBeNull()
      expect(matrixTurnStatus(input, 'answer', copy)).toBeNull()
    }
  })

  it('says only "no reply yet" for a cloud question past its long bound: this Mac never runs it', () => {
    const quiet = view({ state: 'handed_off', route: 'cloud', notice: 'home_quiet' })
    expect(matrixTurnStatus(quiet, 'question', copy)).toEqual({ text: copy.turnHomeQuiet, tone: 'notice' })
    expect(matrixTurnStatus(quiet, 'answer', copy)).toBeNull()
  })

  it('offers to answer right away only when the other Mac went quiet, never naming a place (vi first)', () => {
    const place = /Mac|máy này|đám mây|cloud|クラウド|云|雲|这台|這台|另一台|もう一台/i
    const quiet = view({ state: 'handed_off', notice: 'home_quiet' })

    expect(matrixTurnStatus(quiet, 'question', copy)).toEqual({
      text: copy.turnHomeQuiet,
      tone: 'notice',
      action: 'answer_here'
    })

    for (const locale of [viCopy, en, ja, zh, zhHant]) {
      const words = locale.matrixShell

      for (const text of [
        matrixTurnStatus(quiet, 'question', words)?.text ?? '',
        words.turnAnswerHere,
        words.turnAlwaysAnswerHere,
        words.turnAnswerHereFailed
      ]) {
        expect(text).not.toMatch(place)
      }
    }
  })

  it('has copy for every state and notice in all five locales, never naming the runtime', () => {
    const keys = [
      'turnNotSent',
      'turnInterrupted',
      'turnRetry',
      'turnHomeQuiet',
      'turnAnswerHere',
      'turnAlwaysAnswerHere',
      'readinessOffline',
      'readinessAiUnavailable',
      'readinessOutOfProtons',
      'readinessSignIn',
      'readinessPlatform',
      'readinessAssistant',
      'readinessChat',
      'readinessHelp',
      'readinessPaused',
      'startupHermes',
      'startupAi',
      'startupAuthority'
    ] as const

    for (const locale of [en, viCopy, ja, zh, zhHant]) {
      for (const key of keys) {
        const text = locale.matrixShell[key]
        expect(typeof text === 'string' && text.length > 0, key).toBe(true)
        expect(text).not.toMatch(/hermes/i)
      }
    }
  })
})

describe('the agent typing, as the chat shows it', () => {
  const roomId = '!room:test'

  it('types while a turn of this room is still being answered, on any path', () => {
    for (const state of ['waiting', 'running', 'handed_off'] as const) {
      expect(matrixAgentTyping({ roomId, turns: [view({ state })] })).toBe(true)
      expect(matrixAgentTyping({ roomId, turns: [view({ state, route: 'cloud' })] })).toBe(true)
    }
  })

  it('stops once the answer is in, the turn failed, or it belongs to another chat', () => {
    expect(matrixAgentTyping({ roomId, turns: [view({ state: 'running', answer: 'Hi' })] })).toBe(false)
    expect(matrixAgentTyping({ roomId, turns: [view({ state: 'answered', answer: 'Hi' })] })).toBe(false)
    expect(matrixAgentTyping({ roomId, turns: [view({ state: 'not_sent' })] })).toBe(false)
    expect(matrixAgentTyping({ roomId, turns: [view({ state: 'interrupted' })] })).toBe(false)
    expect(matrixAgentTyping({ roomId, turns: [view({ state: 'running', roomId: '!other:test' })] })).toBe(false)
  })

  it('leaves a quiet other Mac, or a cloud past its bound, to its own line, with nothing typing', () => {
    expect(matrixAgentTyping({ roomId, turns: [view({ state: 'handed_off', notice: 'home_quiet' })] })).toBe(false)
    expect(
      matrixAgentTyping({ roomId, turns: [view({ state: 'handed_off', route: 'cloud', notice: 'home_quiet' })] })
    ).toBe(false)
    // The agent's own typing notification still shows: it says it is working.
    expect(
      matrixAgentTyping({
        roomId,
        agentId: '@agent:test',
        typing: ['@agent:test'],
        turns: [view({ state: 'handed_off', route: 'cloud', notice: 'home_quiet' })]
      })
    ).toBe(true)
  })

  it("follows the agent's own typing notification and a run on this Mac", () => {
    expect(matrixAgentTyping({ roomId, agentId: '@a:test', typing: ['@a:test'] })).toBe(true)
    expect(matrixAgentTyping({ roomId, agentId: '@a:test', typing: ['@someone:test'] })).toBe(false)
    expect(matrixAgentTyping({ roomId, running: true })).toBe(true)
    expect(matrixAgentTyping({ roomId })).toBe(false)
  })
})
