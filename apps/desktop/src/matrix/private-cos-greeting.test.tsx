import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fireEvent, render, screen } from '@testing-library/react'
import { createClient, EventType, MatrixEvent, Room } from 'matrix-js-sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { MarkdownContent } from '@/components/assistant-ui/markdown-surface'

import {
  MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE,
  MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT
} from '../../shared/matrix-company-private-cos'

import { MATRIX_MARKDOWN_HOST } from './markdown-host'
import { matrixMessage } from './message'
import { privateCosGreetingMarkdown } from './private-cos-greeting'
import { $companyBoardLinkRequest } from './team-space/board-links'

const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../contracts/atum-company-private-cos-v1.2/fixtures'
)

function fixture(file: string) {
  return JSON.parse(readFileSync(resolve(root, file), 'utf8')) as Record<string, unknown>
}

function privateRoom() {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@member:atum.example' })
  const room = new Room('!private-cos:test', client, '@member:atum.example')
  const state = (type: string, content: object) => new MatrixEvent({
    type,
    state_key: '',
    room_id: room.roomId,
    sender: '@manager:atum.example',
    content
  })

  room.currentState.setStateEvents([
    state(EventType.RoomCreate, { type: MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE, room_version: '11' }),
    state(MATRIX_COMPANY_PRIVATE_COS_STATE_EVENT, {
      v: 1,
      classification: 'company_private_cos',
      companyId: '00000000-0000-4000-8000-540eb3b6436f',
      membershipIncarnation: '00000000-0000-4000-8000-ea3f14245121',
      executorId: '00000000-0000-4000-8000-3f48695086a0'
    })
  ])

  return room
}

afterEach(() => {
  $companyBoardLinkRequest.set(undefined)
  Reflect.deleteProperty(window, 'atumMatrix')
})

it.each([
  ['greeting.matrix-content.json', 'Open company board', undefined],
  ['greeting.matrix-content.card.json', 'How to use your company space', '00000000-0000-4000-8000-ed2914fe0e5a']
] as const)('renders the real %s pill and board target without raw HTML or URL text', (file, title, cardId) => {
  const content = fixture(file)
  const event = new MatrixEvent({
    type: EventType.RoomMessage,
    room_id: '!private-cos:test',
    event_id: '$greeting',
    sender: '@private-cos:atum.example',
    origin_server_ts: 1,
    content
  })
  const message = matrixMessage(event, '@member:atum.example', new Set(), privateRoom())!
  const markdown = privateCosGreetingMarkdown(message)!
  const bridge = { openLink: vi.fn(async () => {}) }
  window.atumMatrix = bridge as unknown as typeof window.atumMatrix

  const view = render(<MarkdownContent host={MATRIX_MARKDOWN_HOST} isRunning={false} text={markdown} />)
  const agent = screen.getByRole('link', { name: '@Chief of Staff' })
  const board = screen.getByRole('link', { name: title })

  fireEvent.click(agent)
  expect(bridge.openLink).toHaveBeenCalledExactlyOnceWith('https://matrix.to/#/@private-cos:atum.example')
  fireEvent.click(board)
  expect($companyBoardLinkRequest.get()?.target).toEqual({
    kind: cardId ? 'company_board_card' : 'company_board',
    companyId: '00000000-0000-4000-8000-540eb3b6436f',
    boardId: '00000000-0000-4000-8000-7b0cac15d6b0',
    ...(cardId ? { cardId } : {})
  })
  expect(bridge.openLink).toHaveBeenCalledOnce()
  expect(view.container.textContent).not.toContain('https://')
  expect(view.container.textContent).not.toContain('<a')
})
