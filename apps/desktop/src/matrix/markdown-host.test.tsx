import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { MarkdownContent } from '@/components/assistant-ui/markdown-surface'

import { storeListingLink } from '../../shared/discovery-links'
import { matrixMessageLink } from '../../shared/matrix-message-link'

import { MATRIX_MARKDOWN_HOST, openMatrixMarkdownLink, prepareMatrixMessageLinks } from './markdown-host'
import { $matrixStoreListingRequest, $matrixStoreShelfRequest } from './store/top-up'
import { $companyBoardLinkRequest } from './team-space/board-links'
import { $matrixMessageLinkRequest } from './team-space/message-links'

afterEach(() => {
  $matrixStoreListingRequest.set(null)
  $matrixStoreShelfRequest.set(null)
  $matrixMessageLinkRequest.set(null)
  $companyBoardLinkRequest.set(undefined)
  Reflect.deleteProperty(window, 'atumMatrix')
})

it.each([
  [
    'company_board',
    'https://atumplatform.com/#atum-board/00000000-0000-4000-8000-540eb3b6436f/00000000-0000-4000-8000-7b0cac15d6b0',
    undefined
  ],
  [
    'company_board_card',
    'https://atumplatform.com/#atum-board/00000000-0000-4000-8000-540eb3b6436f/00000000-0000-4000-8000-7b0cac15d6b0/card/00000000-0000-4000-8000-ed2914fe0e5a',
    '00000000-0000-4000-8000-ed2914fe0e5a'
  ]
] as const)('intercepts the %s greeting link and keeps it in the company board', async (kind, url, cardId) => {
  const bridge = { command: vi.fn(async () => null), openLink: vi.fn(async () => {}) }
  window.atumMatrix = bridge as unknown as typeof window.atumMatrix

  render(<MarkdownContent host={MATRIX_MARKDOWN_HOST} isRunning={false} text={`[Open board](${url})`} />)
  fireEvent.click(await screen.findByRole('link', { name: 'Open board' }))

  expect($companyBoardLinkRequest.get()?.target).toEqual({
    kind,
    companyId: '00000000-0000-4000-8000-540eb3b6436f',
    boardId: '00000000-0000-4000-8000-7b0cac15d6b0',
    ...(cardId ? { cardId } : {})
  })
  expect(bridge.openLink).not.toHaveBeenCalled()
})

it('a pasted Team space message link stays inside Atum and queues its identifier target', async () => {
  const bridge = { command: vi.fn(async () => null), openLink: vi.fn(async () => {}) }
  window.atumMatrix = bridge as unknown as typeof window.atumMatrix
  const target = {
    companyId: '00000000-0000-4000-8000-4423c334534f',
    roomId: '!general:atum.example',
    eventId: '$message'
  }
  const link = matrixMessageLink(target)

  render(<MarkdownContent host={MATRIX_MARKDOWN_HOST} isRunning={false} text={link} />)
  fireEvent.click(await screen.findByRole('link'))

  expect($matrixMessageLinkRequest.get()?.target).toEqual(target)
  expect(bridge.openLink).not.toHaveBeenCalled()
})

it('linkifies only valid bare message links and leaves code examples unchanged', () => {
  const link = matrixMessageLink({
    companyId: '00000000-0000-4000-8000-4423c334534f',
    roomId: '!general:atum.example',
    eventId: '$message'
  })

  expect(prepareMatrixMessageLinks(`Open ${link}. Keep \`${link}\` and \`\`\`\n${link}\n\`\`\`.`)).toBe(
    `Open <${link}>. Keep \`${link}\` and \`\`\`\n${link}\n\`\`\`.`
  )
  expect(prepareMatrixMessageLinks('atum://message/v1/not+base64')).toBe('atum://message/v1/not+base64')
})

it('a malformed Atum message URL is inert text, not an external or in-app navigation', () => {
  const bridge = { command: vi.fn(async () => null), openLink: vi.fn(async () => {}) }
  window.atumMatrix = bridge as unknown as typeof window.atumMatrix

  render(<MarkdownContent host={MATRIX_MARKDOWN_HOST} isRunning={false} text="[Bad](atum://message/v1/not+base64)" />)

  expect(screen.queryByRole('link', { name: 'Bad' })).toBeNull()
  expect(screen.getByText('Bad')).toBeTruthy()
  expect($matrixMessageLinkRequest.get()).toBeNull()
  expect(bridge.openLink).not.toHaveBeenCalled()
})

it('a recommendation click opens the exact Store listing intent, never an acquisition or external page', async () => {
  const bridge = { command: vi.fn(async () => null), openLink: vi.fn(async () => {}) }
  window.atumMatrix = bridge as unknown as typeof window.atumMatrix
  render(
    <MarkdownContent
      host={MATRIX_MARKDOWN_HOST}
      isRunning={false}
      text={`[Focus listing](${storeListingLink('agent/focus')})`}
    />
  )
  fireEvent.click(await screen.findByRole('link', { name: /Focus listing/ }))
  expect($matrixStoreListingRequest.get()).toBe('agent/focus')
  expect($matrixStoreShelfRequest.get()).toBe('agents')
  expect(bridge.command).toHaveBeenCalledExactlyOnceWith({ kind: 'discoverApps' })
  expect(bridge.openLink).not.toHaveBeenCalled()
})

it('a failed navigation clears its own intent, and lookalike origins are only ordinary web links', async () => {
  const bridge = {
    command: vi.fn(async () => {
      throw new Error('unavailable')
    }),
    openLink: vi.fn(async () => {})
  }
  window.atumMatrix = bridge as unknown as typeof window.atumMatrix
  await expect(openMatrixMarkdownLink(storeListingLink('skill/focus'))).rejects.toThrow('unavailable')
  expect($matrixStoreListingRequest.get()).toBeNull()
  await openMatrixMarkdownLink('https://atumplatform.com.evil.test/#atum-store/skill%2Ffocus')
  expect(bridge.openLink).toHaveBeenCalledOnce()
  expect(bridge.command).toHaveBeenCalledOnce()
})
