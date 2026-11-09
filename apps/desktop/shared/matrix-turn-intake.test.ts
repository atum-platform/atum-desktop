import { describe, expect, it } from 'vitest'

import { MATRIX_MESSAGE_MAX_BYTES, MATRIX_TURN_QUOTE_MAX } from './matrix'
import { matrixReplyWords, matrixTurnIntake, matrixTurnQuote } from './matrix-turn-intake'

const text = { msgtype: 'm.text', body: 'Plan a trip to Huế' }

const message = (content: Record<string, unknown>, extra: { wireRelation?: unknown; redacted?: boolean } = {}) =>
  matrixTurnIntake({ type: 'm.room.message', content, redacted: false, ...extra })

describe('the agent-room turn contract', () => {
  it('starts a turn only for a new top-level text or file message', () => {
    expect(message(text)).toEqual({ turn: true })
    expect(message({ msgtype: 'm.file', body: 'notes.pdf', file: { url: 'mxc://test/a' } })).toEqual({ turn: true })
  })

  it('takes a file sent in a room without encryption, named by its plain URL, and no file that names no media', () => {
    expect(message({ msgtype: 'm.file', body: 'notes.pdf', url: 'mxc://test/a' })).toEqual({ turn: true })
    expect(message({ msgtype: 'm.file', body: 'notes.pdf' })).toEqual({ turn: false, reason: 'not_text' })
    expect(message({ msgtype: 'm.file', body: 'notes.pdf', url: 42 })).toEqual({ turn: false, reason: 'not_text' })
  })

  it('takes a photo (m.image) like a file, but no video or audio, and no image that names no media', () => {
    expect(message({ msgtype: 'm.image', body: 'IMG_1.jpg', file: { url: 'mxc://test/a' } })).toEqual({ turn: true })
    expect(message({ msgtype: 'm.image', body: 'IMG_1.jpg', url: 'mxc://test/a' })).toEqual({ turn: true })
    expect(message({ msgtype: 'm.image', body: 'IMG_1.jpg' })).toEqual({ turn: false, reason: 'not_text' })

    for (const msgtype of ['m.video', 'm.audio']) {
      expect(message({ msgtype, body: 'clip', file: { url: 'mxc://test/a' } })).toEqual({
        turn: false,
        reason: 'not_text'
      })
    }
  })

  it('never starts a turn for an edit, wherever the edit names its message', () => {
    const edit = { rel_type: 'm.replace', event_id: '$q' }

    expect(message({ ...text, 'm.new_content': text, 'm.relates_to': edit })).toEqual({ turn: false, reason: 'edit' })
    // An encrypted edit can carry its relation only outside the ciphertext.
    expect(message({ ...text, 'm.new_content': text }, { wireRelation: edit })).toEqual({ turn: false, reason: 'edit' })
  })

  it('never starts a turn for a reaction, a redaction or a message that was deleted', () => {
    expect(
      matrixTurnIntake({
        type: 'm.reaction',
        content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$a', key: '👍' } },
        redacted: false
      })
    ).toEqual({ turn: false, reason: 'reaction' })
    // An annotation dressed as a message is still a reaction.
    expect(message(text, { wireRelation: { rel_type: 'm.annotation', event_id: '$a', key: '👍' } })).toEqual({
      turn: false,
      reason: 'reaction'
    })
    expect(matrixTurnIntake({ type: 'm.room.redaction', content: {}, redacted: false })).toEqual({
      turn: false,
      reason: 'redaction'
    })
    expect(message(text, { redacted: true })).toEqual({ turn: false, reason: 'redacted' })
  })

  it('never starts a turn inside a thread: assistant rooms have none', () => {
    expect(message({ ...text, 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' } })).toEqual({
      turn: false,
      reason: 'thread'
    })
  })

  it('starts a turn for a reply, carrying the message it answers as context', () => {
    const reply = { 'm.in_reply_to': { event_id: '$answer' } }

    expect(message({ ...text, 'm.relates_to': reply })).toEqual({ turn: true, replyTo: '$answer' })
    expect(message({ ...text, 'm.relates_to': reply }, { wireRelation: reply })).toEqual({ turn: true, replyTo: '$answer' })
  })

  it('refuses a reply only the clear text names: the server could have added it', () => {
    // A plain "yes, go ahead" must not become a reply to a message the server chose.
    expect(message(text, { wireRelation: { 'm.in_reply_to': { event_id: '$answer' } } })).toEqual({
      turn: false,
      reason: 'relation'
    })
  })

  it('refuses a relation it does not know, or a reply hiding something else, rather than guess', () => {
    for (const relation of [
      {},
      { 'm.in_reply_to': {} },
      { 'm.in_reply_to': { event_id: 'answer' } },
      { 'm.in_reply_to': { event_id: '$answer' }, rel_type: 'm.reference', event_id: '$x' },
      { 'm.in_reply_to': { event_id: '$answer' }, is_falling_back: true },
      'reply'
    ]) {
      expect(message({ ...text, 'm.relates_to': relation })).toEqual({ turn: false, reason: 'relation' })
    }

    // The relation the server sees and the one inside the ciphertext must agree.
    expect(
      message(
        { ...text, 'm.relates_to': { 'm.in_reply_to': { event_id: '$one' } } },
        { wireRelation: { 'm.in_reply_to': { event_id: '$two' } } }
      )
    ).toEqual({ turn: false, reason: 'relation' })
    expect(
      message(
        { ...text, 'm.relates_to': { rel_type: 'm.replace', event_id: '$q' } },
        { wireRelation: { 'm.in_reply_to': { event_id: '$q' } } }
      )
    ).toEqual({ turn: false, reason: 'edit' })
  })

  it('never runs a question this Mac already ran, nor anything that is not a text or a file', () => {
    expect(message({ ...text, 'io.atum.turn': '00000000-0000-4000-8000-31f949766961' })).toEqual({
      turn: false,
      reason: 'marker'
    })

    for (const content of [
      { msgtype: 'm.notice', body: 'note' },
      { msgtype: 'm.text', body: '' },
      { msgtype: 'm.text', body: 'x'.repeat(MATRIX_MESSAGE_MAX_BYTES + 1) },
      { msgtype: 'm.file', body: 'plain.txt' },
      { msgtype: 'm.text' }
    ]) {
      expect(message(content)).toEqual({ turn: false, reason: 'not_text' })
    }

    expect(matrixTurnIntake({ type: 'm.sticker', content: text, redacted: false })).toEqual({
      turn: false,
      reason: 'not_message'
    })
  })
})

describe("a reply's quote", () => {
  it('is the message trimmed, bounded as main measures it, and never half a character', () => {
    expect(matrixTurnQuote('  Day 1: the lake  ')).toBe('Day 1: the lake')
    expect(matrixTurnQuote('x'.repeat(MATRIX_TURN_QUOTE_MAX + 50))).toHaveLength(MATRIX_TURN_QUOTE_MAX)

    // Emoji are two UTF-16 units: a cut through one drops it whole.
    const emoji = matrixTurnQuote(`a${'😀'.repeat(MATRIX_TURN_QUOTE_MAX)}`)
    expect(emoji.length).toBeLessThanOrEqual(MATRIX_TURN_QUOTE_MAX)
    expect(emoji.length).toBe(MATRIX_TURN_QUOTE_MAX - 1)
    expect([...emoji].at(-1)).toBe('😀')
  })
})

describe("a reply's own words", () => {
  it('drop the quoted fallback an older client put first, and nothing else', () => {
    expect(matrixReplyWords('> <@agent:test> Sunny\n> in Huế\n\nAnd tomorrow?')).toBe('And tomorrow?')
    expect(matrixReplyWords('> * <@owner:test> waves\n\nHi')).toBe('Hi')
    expect(matrixReplyWords('And tomorrow?')).toBe('And tomorrow?')
    // A quote the person wrote inside their own words is theirs.
    expect(matrixReplyWords('Look:\n> a line\n\nthen this')).toBe('Look:\n> a line\n\nthen this')
    // Without the blank line that ends a fallback, nothing is a fallback.
    expect(matrixReplyWords('> just a quote')).toBe('> just a quote')
  })

  it("keep a blockquote someone wrote first: only the spec's fallback shape is a fallback", () => {
    // Clients no longer send a fallback, so a leading quote is the person's own words…
    expect(matrixReplyWords('> never touch prod\n\nis this rule still right?')).toBe(
      '> never touch prod\n\nis this rule still right?'
    )
    // …or an assistant's Markdown, which never carries a fallback.
    expect(matrixReplyWords('> Can I ship on Friday?\n\nNo: migration 0148 must land first.')).toBe(
      '> Can I ship on Friday?\n\nNo: migration 0148 must land first.'
    )
    expect(matrixReplyWords('> <not a user> hi\n\nok')).toBe('> <not a user> hi\n\nok')
  })
})
