import { describe, expect, it } from 'vitest'

import type { ChatMessage } from '@/lib/chat-messages'

import { finalizeInterruptedMessages } from './rewind'

function assistant(parts: ChatMessage['parts']): ChatMessage {
  return { id: 'assistant-live', parts, pending: true, role: 'assistant' }
}

describe('finalizeInterruptedMessages', () => {
  it('keeps an interrupted web search visible with a typed cancelled result', () => {
    const messages = finalizeInterruptedMessages([
      assistant([
        {
          args: { query: 'Atum browser permissions' },
          result: undefined,
          toolCallId: 'search-1',
          toolName: 'web_search',
          type: 'tool-call'
        }
      ])
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]?.pending).toBe(false)
    expect(messages[0]?.parts).toEqual([
      {
        args: { query: 'Atum browser permissions' },
        result: { code: 'USER_CANCELLED', status: 'cancelled' },
        toolCallId: 'search-1',
        toolName: 'web_search',
        type: 'tool-call'
      }
    ])
  })

  it('still drops an empty interrupted placeholder for unrelated tools', () => {
    expect(
      finalizeInterruptedMessages([
        assistant([
          {
            args: { path: '/tmp/demo.txt' },
            result: undefined,
            toolCallId: 'read-1',
            toolName: 'read_file',
            type: 'tool-call'
          }
        ])
      ])
    ).toEqual([])
  })

  it('keeps an interrupted computer-control action visible with a typed cancelled result', () => {
    const messages = finalizeInterruptedMessages([
      assistant([
        {
          args: { action: 'click' },
          result: undefined,
          toolCallId: 'computer-1',
          toolName: 'computer_use',
          type: 'tool-call'
        }
      ])
    ])

    expect(messages[0]?.parts[0]).toMatchObject({
      result: { code: 'USER_CANCELLED', status: 'cancelled' },
      toolName: 'computer_use'
    })
  })
})
