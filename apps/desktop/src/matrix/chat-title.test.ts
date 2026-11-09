import { describe, expect, it } from 'vitest'

import type { MatrixRoom } from '../../shared/matrix'

import { matrixChatDate, matrixChatTitle } from './chat-title'

const copy = (locale: string) => ({ locale, untitled: 'Untitled chat', chatOn: (date: string) => `Chat · ${date}` })
const room = (extra: Partial<MatrixRoom>): MatrixRoom => ({ id: '!r:test', name: 'Atum', membership: 'join', encrypted: true, ...extra })
const october = new Date(2026, 9, 4, 12).getTime()

describe('chat titles', () => {
  it("never names an assistant's history by the assistant: its first message, else the day it began", () => {
    expect(matrixChatTitle(room({ assistant: true, firstLine: 'Plan a trip' }), copy('en'))).toBe('Plan a trip')

    const dated = matrixChatTitle(room({ assistant: true, createdAt: october }), copy('en'), october)
    expect(dated).toBe(`Chat · ${matrixChatDate(october, 'en', october)}`)
    expect(dated).not.toContain('Atum')
    // Without a start, its last activity dates it; with neither, it is untitled, never blank.
    expect(matrixChatTitle(room({ assistant: true, lastActiveAt: october }), copy('en'), october)).toBe(dated)
    expect(matrixChatTitle(room({ assistant: true }), copy('en'))).toBe('Untitled chat')
  })

  it('puts your own name for a chat first, for any kind of chat', () => {
    expect(matrixChatTitle(room({ assistant: true, firstLine: 'Plan a trip', title: '  Budget ' }), copy('en'))).toBe('Budget')
    expect(matrixChatTitle(room({ name: 'Design team', title: 'Work' }), copy('en'))).toBe('Work')
    expect(matrixChatTitle(room({ name: 'Design team', title: '   ' }), copy('en'))).toBe('Design team')
  })

  it('keeps the name a chat with people goes by, and never a blank title', () => {
    expect(matrixChatTitle(room({ name: 'Linh' }), copy('en'))).toBe('Linh')
    expect(matrixChatTitle(room({ name: '  ' }), copy('en'))).toBe('Untitled chat')
  })

  it("writes the day the way each language does, with the year only when it isn't this one", () => {
    expect(matrixChatDate(october, 'vi', october)).toBe(
      new Intl.DateTimeFormat('vi', { day: 'numeric', month: 'numeric' }).format(october)
    )
    expect(matrixChatDate(october, 'en', october)).toBe(
      new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' }).format(october)
    )

    const lastYear = new Date(2025, 9, 4, 12).getTime()
    expect(matrixChatDate(lastYear, 'en', october)).toContain('2025')
    expect(matrixChatDate(october, 'en', october)).not.toContain('2026')
  })
})
