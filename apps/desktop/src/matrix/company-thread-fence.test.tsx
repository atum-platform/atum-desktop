import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixCompanyThread, MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'

import type { CompanyThreadsViewProps } from './team-space/company-threads'

const capturedThreadsView = vi.hoisted(() => ({ current: undefined as CompanyThreadsViewProps | undefined }))

vi.mock('./team-space/company-threads', async importOriginal => {
  const actual = await importOriginal()

  return {
    ...(actual as Record<string, unknown>),
    CompanyThreadsView: (props: CompanyThreadsViewProps) => {
      capturedThreadsView.current = props

      return null
    }
  }
})

import { MatrixWorkspace } from './workspace'

afterEach(() => {
  cleanup()
  capturedThreadsView.current = undefined
  window.localStorage.clear()
  Reflect.deleteProperty(window, 'atumMatrix')
})

const company = { id: 'company-1', displayName: 'Acme', role: 'member' as const, authorityGeneration: 1 }
const room = {
  id: '!decisions:test',
  name: 'decisions',
  membership: 'join' as const,
  encrypted: false,
  companyChannel: { companyId: company.id, channelId: '00000000-0000-4000-8000-676a3a34ff0f' }
}
const thread: MatrixCompanyThread = {
  companyId: company.id,
  roomId: room.id,
  root: {
    id: '$root',
    sender: '@linh:test',
    body: 'Decision thread',
    timestamp: 10,
    own: false,
    encrypted: true,
    decryptionFailed: false,
    pending: false,
    failed: false,
    attachment: false
  },
  replies: [],
  participantIds: ['@linh:test'],
  replyCount: 3,
  lastActivityAt: 20,
  unread: true,
  highlights: 0,
  followed: false
}

const baseSnapshot: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@alice:test', deviceId: 'A' },
  rooms: [room],
  roomId: null,
  messages: [],
  error: null,
  companyWorkspaceEnabled: true
}

function mount(companyThreads: readonly MatrixCompanyThread[]) {
  const request = vi.fn(async (input: { action: string }) => {
    if (input.action === 'list') {
      return { ok: true as const, value: { schemaVersion: 1 as const, companies: [company], invitations: [] } }
    }

    if (input.action === 'read') {
      return {
        ok: true as const,
        value: { schemaVersion: 1 as const, company, members: [], projects: [] }
      }
    }

    if (input.action === 'list-channels') {
      return {
        ok: true as const,
        value: {
          schemaVersion: 1 as const,
          channels: [{
            schemaVersion: 1 as const,
            channel: {
              id: room.companyChannel.channelId,
              companyId: company.id,
              displayName: room.name,
              visibility: 'company' as const,
              state: 'active' as const,
              projectId: null,
              authorityGeneration: 1,
              channelGeneration: 1
            },
            memberPrincipals: [],
            room: { state: 'ready' as const, roomId: room.id }
          }]
        }
      }
    }

    return { ok: false as const, error: 'missing' as const }
  })
  const command = vi.fn(async () => null)
  const onOpenConversation = vi.fn()

  window.atumMatrix = {
    companies: { pending: vi.fn(async () => ({ ok: true as const, request: null })), request },
    command
  } as unknown as MatrixUiBridge

  const ui = (threads: readonly MatrixCompanyThread[]) => (
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixWorkspace
        obstructed={false}
        onOpenConversation={onOpenConversation}
        snapshot={{ ...baseSnapshot, companyThreads: [...threads] }}
      />
    </I18nProvider>
  )
  const view = render(ui(companyThreads))

  return { command, onOpenConversation, rerender: (threads: readonly MatrixCompanyThread[]) => view.rerender(ui(threads)) }
}

async function captureRenderedRowActions() {
  // A Threads-only inbox is intentionally folded into the Activity utility row.
  fireEvent.click(await screen.findByRole('button', { name: 'Threads' }))
  await waitFor(() => expect(capturedThreadsView.current).toBeDefined())

  return capturedThreadsView.current!
}

it('opens, reads and follows a rendered thread after only its activity metadata changes', async () => {
  const view = mount([thread])
  const rendered = await captureRenderedRowActions()

  view.rerender([{ ...thread, replyCount: 4, lastActivityAt: 30, highlights: 1 }])

  await act(async () => {
    await rendered.onRead(thread)
    await rendered.onFollow(thread, true)
    await rendered.onOpen(thread)
  })

  expect(view.command).toHaveBeenCalledWith({ kind: 'threadRead', roomId: room.id, rootId: thread.root.id })
  expect(view.command).toHaveBeenCalledWith({
    kind: 'threadFollow',
    roomId: room.id,
    rootId: thread.root.id,
    followed: true
  })
  expect(view.command).toHaveBeenCalledWith({ kind: 'select', roomId: room.id })
  expect(view.onOpenConversation).toHaveBeenCalledExactlyOnceWith({ roomId: room.id, threadRootId: thread.root.id })
})

it('no-ops every action from a rendered row after that thread is removed', async () => {
  const view = mount([thread])
  const rendered = await captureRenderedRowActions()

  view.rerender([])

  await expect(rendered.onRead(thread)).resolves.toBeUndefined()
  await expect(rendered.onFollow(thread, true)).resolves.toBeUndefined()
  await expect(rendered.onOpen(thread)).resolves.toBeUndefined()
  expect(view.command).not.toHaveBeenCalled()
  expect(view.onOpenConversation).not.toHaveBeenCalled()
})
