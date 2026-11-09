import { describe, expect, it } from 'vitest'

import { MATRIX_MESSAGE_MAX_BYTES, matrixMessageTooLong } from './matrix'
import { matrixAnswerPart, matrixAnswerParts, matrixAnswerPartTransaction } from './matrix-answer-parts'

const bytes = (text: string) => new TextEncoder().encode(JSON.stringify(text)).byteLength

/** Every word of the answer, in order, ignoring how the parts were broken and fenced. */
const words = (text: string) => text.split(/\s+/).filter(word => word && !/^(`{3,}|~{3,})/.test(word))

function paragraphs(count: number, words = 40, word = 'lorem') {
  return Array.from({ length: count }, (_, index) => `Paragraph ${index}. ${`${word} `.repeat(words).trim()}`).join(
    '\n\n'
  )
}

describe('an answer that fits one message', () => {
  it('is that one message, unchanged', () => {
    const text = `  Leading space, **markdown**, \`code\`, and a trailing newline.\n\n${paragraphs(20)}\n`
    expect(matrixMessageTooLong(text)).toBe(false)
    expect(matrixAnswerParts(text)).toEqual([text])
  })

  it('is one message right up to the bound', () => {
    const text = 'a'.repeat(MATRIX_MESSAGE_MAX_BYTES - 2)
    expect(bytes(text)).toBe(MATRIX_MESSAGE_MAX_BYTES)
    expect(matrixAnswerParts(text)).toEqual([text])
    expect(matrixAnswerParts(`${text}b`)).toHaveLength(2)
  })
})

describe('an answer too long for one message', () => {
  it.each([
    ['English paragraphs', paragraphs(600)],
    ['Vietnamese paragraphs', paragraphs(500, 40, 'Tiếng Việt có dấu')],
    ['Chinese text without spaces', '这是一个很长的回答没有空格'.repeat(9000)],
    ['emoji and quotes', `"${'🙂 \\ "quoted" '.repeat(12000)}"`],
    ['one huge line', 'word '.repeat(40_000)],
    ['no whitespace at all', 'x'.repeat(150_000)]
  ])('%s: every part fits one message and the words stay in order', (_name, text) => {
    const parts = matrixAnswerParts(text)
    expect(parts.length).toBeGreaterThan(1)

    for (const part of parts) {
      expect(matrixMessageTooLong(part)).toBe(false)
      expect(part.trim()).not.toBe('')
    }

    // Nothing is lost or reordered (a mid-word cut, the last resort, may split a word in two).
    expect(words(parts.join(' ')).join('')).toBe(words(text).join(''))
  })

  it('breaks between paragraphs, and never leaves a part nearly empty', () => {
    const text = paragraphs(600)
    const parts = matrixAnswerParts(text)

    for (const [index, part] of parts.entries()) {
      expect(part.startsWith('Paragraph ')).toBe(true)
      expect(/\n$/.test(part)).toBe(false)

      if (index < parts.length - 1) {
        expect(bytes(part)).toBeGreaterThan(MATRIX_MESSAGE_MAX_BYTES / 2)
      }
    }

    // Joined back the way the conversation's history joins one turn's answers, it is the answer.
    expect(parts.join('\n\n')).toBe(text)
  })

  it('breaks between lines when there are no paragraphs', () => {
    const text = Array.from({ length: 4000 }, (_, index) => `- item ${index} ${'detail '.repeat(4).trim()}`).join('\n')
    const parts = matrixAnswerParts(text)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every(part => part.startsWith('- item '))).toBe(true)
    expect(parts.join('\n')).toBe(text)
  })

  it('breaks outside a code block when it can, even if that part is shorter', () => {
    const code = `\`\`\`ts\n${Array.from({ length: 1500 }, (_, index) => `const value${index} = ${index}`).join('\n')}\n\`\`\``
    const text = `${paragraphs(1, 3000)}\n\n${code}\n\nAfter the code.`
    expect(matrixMessageTooLong(code)).toBe(false)
    const parts = matrixAnswerParts(text)
    expect(parts.length).toBeGreaterThan(1)
    const fenceCounts = parts.map(part => (part.match(/^```/gm) ?? []).length)

    // The code block is never cut: it moves whole to its own message.
    expect(parts.some(part => part.includes(code))).toBe(true)
    expect(fenceCounts.every(count => count % 2 === 0)).toBe(true)
  })

  it('closes and reopens a code block too long for one message, with its language', () => {
    const lines = Array.from({ length: 6000 }, (_, index) => `print("line ${index}")`)
    const text = `Here is the script:\n\n\`\`\`python\n${lines.join('\n')}\n\`\`\`\n\nThat is all.`
    const parts = matrixAnswerParts(text)
    expect(parts.length).toBeGreaterThan(2)

    for (const part of parts) {
      expect(matrixMessageTooLong(part)).toBe(false)
      // Every message renders on its own: its fences pair up.
      expect((part.match(/^```/gm) ?? []).length % 2).toBe(0)
    }

    const inner = parts.filter(part => part.includes('print('))
    expect(inner.length).toBeGreaterThan(1)
    expect(inner.slice(1).every(part => part.startsWith('```python\n'))).toBe(true)
    expect(inner.slice(0, -1).every(part => part.endsWith('\n```'))).toBe(true)

    // No message holds an empty block (a break just after the opening line or before the closing one).
    expect(parts.some(part => /```python\n```/.test(part))).toBe(false)

    // Every code line survives, whole and in order.
    const code = parts.flatMap(part => part.split('\n').filter(line => line.startsWith('print(')))
    expect(code).toEqual(lines)
  })

  it('is the same parts every time: a retry posts exactly what the first attempt did', () => {
    const text = paragraphs(700, 30, 'mixed Tiếng Việt 中文')
    expect(matrixAnswerParts(text)).toEqual(matrixAnswerParts(text))
  })
})

describe('part markers and transactions', () => {
  it('reads only a well-formed position', () => {
    expect(matrixAnswerPart({ index: 0, count: 2 })).toEqual({ index: 0, count: 2 })
    expect(matrixAnswerPart({ index: 2, count: 2 })).toBeUndefined()
    expect(matrixAnswerPart({ index: 0, count: 1 })).toBeUndefined()
    expect(matrixAnswerPart({ index: -1, count: 3 })).toBeUndefined()
    expect(matrixAnswerPart({ index: 0.5, count: 3 })).toBeUndefined()
    expect(matrixAnswerPart('0/2')).toBeUndefined()
    expect(matrixAnswerPart(undefined)).toBeUndefined()
  })

  it('gives every part its own fixed transaction, the first keeping the answer one', () => {
    const base = 'atum-a-00000000-0000-4000-8000-d16e5c7a9689'
    const transactions = [0, 1, 2, 3].map(index => matrixAnswerPartTransaction(base, index))
    expect(transactions[0]).toBe(base)
    expect(new Set(transactions).size).toBe(4)
    expect(matrixAnswerPartTransaction(base, 2)).toBe(matrixAnswerPartTransaction(base, 2))
  })
})
