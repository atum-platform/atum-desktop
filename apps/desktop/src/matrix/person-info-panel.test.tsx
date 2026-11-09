import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixCommand, MatrixRoom, MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import type {
  MatrixRoomSharedItem,
  MatrixRoomSharedPage,
  MatrixRoomSharedSection
} from '../../shared/matrix-room-shared'

import {
  matrixConversationInfo,
  matrixRoomSharedRefreshed,
  resetMatrixRoomSharedThumbnailsForTest
} from './person-info-model'
import { MatrixPersonInfoPanel } from './person-info-panel'

// Preserve user-visible identity, state and recovery behavior across connection changes.
// information panel like in zalo screenshot there - about that person, about the conversation,
// files and links etc."

const owner = '@owner:test'
const linhId = '@user-0123456789abcdef0123:test'

const linh: MatrixRoom = {
  id: '!linh:test',
  name: 'Linh',
  membership: 'join',
  encrypted: true,
  direct: true,
  createdAt: Date.UTC(2026, 9, 1),
  participants: [
    { userId: owner, membership: 'join' },
    { userId: linhId, membership: 'join' }
  ]
}

const plainLinh: MatrixRoom = { ...linh, id: '!plain:test', encrypted: false }

const group: MatrixRoom = {
  id: '!group:test',
  name: 'Friends',
  topic: 'Weekend plans',
  membership: 'join',
  encrypted: false,
  participants: [
    { userId: owner, membership: 'join' },
    { userId: '@bob:test', membership: 'join' },
    { userId: '@cam:test', membership: 'join' }
  ]
}

const assistant: MatrixRoom = {
  id: '!assistant:test',
  name: 'Atum',
  membership: 'join',
  encrypted: true,
  assistant: true,
  roomType: 'io.atum.assistant',
  participants: [
    { userId: owner, membership: 'join' },
    { userId: '@atum:test', membership: 'join' }
  ]
}

const moon: MatrixRoom = {
  id: '!moon:test',
  name: 'Moon',
  membership: 'join',
  encrypted: false,
  direct: true,
  appBot: { appId: '00000000-0000-4000-8000-bd7662a5eeb4', botUserId: '@moon:test', current: true },
  participants: [
    { userId: owner, membership: 'join' },
    { userId: '@moon:test', membership: 'join' }
  ]
}

const company: MatrixRoom = {
  id: '!channel:test',
  name: 'chung',
  membership: 'join',
  encrypted: false,
  companyChannel: {
    companyId: '00000000-0000-4000-8000-db3855a227f2',
    channelId: '00000000-0000-4000-8000-0e80de01723d'
  },
  participants: [
    { userId: owner, membership: 'join' },
    { userId: linhId, membership: 'join' }
  ]
}

function snapshotFor(room: MatrixRoom, patch: Partial<MatrixSnapshot> = {}): MatrixSnapshot {
  return {
    state: 'ready',
    identity: { userId: owner, deviceId: 'OWNER' },
    assistant: { userId: '@atum:test', deviceId: 'ATUM' },
    rooms: [linh, plainLinh, group, assistant, moon, company].map(value => (value.id === room.id ? room : value)),
    roomId: room.id,
    messages: [],
    members: [
      { userId: owner, name: 'Owner', membership: 'join', canRemove: false },
      { userId: linhId, name: 'Linh Trần', membership: 'join', canRemove: false }
    ],
    error: null,
    ...patch
  } as MatrixSnapshot
}

const item = (
  patch: Partial<MatrixRoomSharedItem> & Pick<MatrixRoomSharedItem, 'id' | 'kind'>
): MatrixRoomSharedItem => ({
  eventId: patch.id.split('#')[0]!,
  sender: linhId,
  at: Date.UTC(2026, 10, 1),
  ...patch
})

type Pages = Partial<Record<MatrixRoomSharedSection, Array<Omit<MatrixRoomSharedPage, 'section'>>>>

/** The bridge: each section answers its pages in order (the first read, then each "Load more"). */
function bridge(pages: Pages) {
  const reads: Partial<Record<MatrixRoomSharedSection, number>> = {}

  const command = vi.fn(async (value: MatrixCommand) => {
    if (value.kind === 'roomShared') {
      const index = value.from ? Number(value.from.replace('p', '')) : 0
      reads[value.section] = (reads[value.section] ?? 0) + 1
      const page = pages[value.section]?.[index] ?? { items: [], source: 'server', unreadable: 0 }

      return { section: value.section, ...page }
    }

    if (value.kind === 'roomSharedThumbnail') {
      return 'data:image/png;base64,iVBORw0KGgo='
    }

    return null
  })

  window.atumMatrix = { command } as unknown as MatrixUiBridge

  return { command, reads }
}

function renderPanel(room: MatrixRoom, patch?: Partial<MatrixSnapshot>) {
  const view = render(panel(room, snapshotFor(room, patch)))

  return { rerender: (next: Partial<MatrixSnapshot>) => view.rerender(panel(room, snapshotFor(room, next))) }
}

function panel(room: MatrixRoom, snapshot: MatrixSnapshot) {
  const info = matrixConversationInfo(room, snapshot)!

  return (
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixPersonInfoPanel
        compact={false}
        expanded={false}
        fail={vi.fn()}
        hidden={false}
        info={info}
        motion={{ finishExit: vi.fn(), phase: 'open', rendered: true }}
        onClose={vi.fn()}
        onExpand={vi.fn()}
        onPercentChange={vi.fn()}
        percent={40}
        room={room}
        snapshot={snapshot}
        windowControls={null}
      />
    </I18nProvider>
  )
}

const section = (name: MatrixRoomSharedSection) =>
  window.document.querySelector<HTMLElement>(`[data-matrix-person-info-section="${name}"]`)!

beforeEach(() => resetMatrixRoomSharedThumbnailsForTest())
afterEach(() => cleanup())

describe('which chats get the conversation info panel', () => {
  it('a one-to-one chat with a person, and a group of people', () => {
    expect(matrixConversationInfo(linh, snapshotFor(linh))).toEqual({ kind: 'person', userId: linhId })
    expect(matrixConversationInfo(group, snapshotFor(group))).toEqual({ kind: 'group' })
  })

  it('never an assistant’s, an app’s or a Team Space room: they keep their own panels', () => {
    for (const room of [assistant, moon, company]) {
      expect(matrixConversationInfo(room, snapshotFor(room))).toBeNull()
    }
  })
})

describe('the conversation info panel', () => {
  it('says who the person is and what the conversation is, never their raw Matrix ID', async () => {
    bridge({})
    renderPanel(linh)

    const identity = window.document.querySelector<HTMLElement>('[data-matrix-person-info-identity]')!
    expect(within(identity).getByRole('heading', { name: 'Linh Trần' })).toBeTruthy()
    expect(identity.textContent).not.toContain(linhId)
    expect(screen.getByRole('tab', { name: 'Conversation info' })).toBeTruthy()
    expect(screen.getByText('End-to-end encrypted')).toBeTruthy()
    expect(screen.getByText(/^Started /u)).toBeTruthy()
    await waitFor(() => expect(section('links').textContent).toContain('No links shared in this chat yet'))
  })

  it('shows the newest photos, files and links of an encrypted chat from its pages', async () => {
    const { command } = bridge({
      media: [
        {
          items: [
            item({ id: '$p1', kind: 'image', name: 'beach.jpg', preview: true }),
            item({ id: '$v1', kind: 'video', name: 'clip.mp4' })
          ],
          source: 'device',
          unreadable: 0
        }
      ],
      files: [
        {
          items: [item({ id: '$f1', kind: 'file', name: 'hop-dong.pdf', size: 2048 })],
          source: 'device',
          unreadable: 0
        }
      ],
      links: [
        {
          items: [item({ id: '$l1', kind: 'link', url: 'https://www.atum.chat/pricing' })],
          source: 'device',
          unreadable: 0
        }
      ]
    })

    renderPanel(linh)

    await waitFor(() => expect(section('files').textContent).toContain('hop-dong.pdf'))
    expect(command).toHaveBeenCalledWith({ kind: 'roomShared', roomId: linh.id, section: 'media', limit: 6 })
    expect(command).toHaveBeenCalledWith({ kind: 'roomShared', roomId: linh.id, section: 'files', limit: 3 })
    expect(section('links').textContent).toContain('atum.chat')
    expect(section('links').textContent).toContain('https://www.atum.chat/pricing')
    // A photo asks for its picture; a video without a thumbnail of its own does not.
    await waitFor(() => expect(section('media').querySelector('img')).toBeTruthy())
    expect(command).toHaveBeenCalledWith({ kind: 'roomSharedThumbnail', roomId: linh.id, eventId: '$p1' })
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'roomSharedThumbnail', eventId: '$v1' }))

    // A file and a photo save through the chat's own Save path.
    fireEvent.click(within(section('files')).getByRole('button', { name: 'Save hop-dong.pdf' }))
    expect(command).toHaveBeenCalledWith({ kind: 'download', roomId: linh.id, eventId: '$f1' })
  })

  it('"See all" opens the section and pages older items on request, saying what it could not read', async () => {
    const { command } = bridge({
      files: [
        { items: [item({ id: '$f1', kind: 'file', name: 'a.pdf' })], source: 'device', unreadable: 0, next: 'p1' },
        { items: [item({ id: '$f2', kind: 'file', name: 'b.pdf' })], source: 'device', unreadable: 0, next: 'p2' },
        { items: [item({ id: '$f3', kind: 'file', name: 'c.pdf' })], source: 'device', unreadable: 2 }
      ]
    })

    renderPanel(linh)
    fireEvent.click(await screen.findByRole('button', { name: 'See all files' }))

    const all = () => window.document.querySelector<HTMLElement>('[data-matrix-person-info-all="files"]')!
    await waitFor(() => expect(all().textContent).toContain('a.pdf'))
    expect(command).toHaveBeenCalledWith({ kind: 'roomShared', roomId: linh.id, section: 'files', limit: 30 })

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(all().textContent).toContain('b.pdf'))
    expect(command).toHaveBeenCalledWith({
      kind: 'roomShared',
      roomId: linh.id,
      section: 'files',
      limit: 30,
      from: 'p1'
    })

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(all().textContent).toContain('c.pdf'))
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
    expect(all().textContent).toContain('2 older encrypted messages can’t be read on this Mac.')

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(section('files')).toBeTruthy()
  })

  it('offers "See all" when recent messages held nothing but older history is unread', async () => {
    // An encrypted chat whose newest pages are all text, with a photo further back.
    const { command } = bridge({
      media: [
        { items: [], source: 'device', unreadable: 0, next: 'p1' },
        {
          items: [item({ id: '$old', kind: 'image', name: 'old.jpg', preview: true })],
          source: 'device',
          unreadable: 0
        }
      ]
    })

    renderPanel(linh)

    await waitFor(() => expect(section('media').textContent).toContain('None in recent messages.'))
    expect(section('media').querySelector('[data-matrix-person-info-scan="partial"]')).toBeTruthy()
    // A section read to the room's start says so, and has nothing to open.
    await waitFor(() => expect(section('files').textContent).toContain('No files shared in this chat yet'))
    expect(section('files').querySelector('[data-matrix-person-info-scan="complete"]')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'See all files' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'See all photos and videos' }))
    const all = () => window.document.querySelector<HTMLElement>('[data-matrix-person-info-all="media"]')!
    await waitFor(() => expect(all().textContent).toContain('None in recent messages.'))

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(all().querySelector('[data-matrix-person-info-media="image"]')).toBeTruthy())
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ kind: 'roomShared', section: 'media', from: 'p1' }))
    expect(all().querySelector('[data-matrix-person-info-empty]')).toBeNull()
  })

  it('"See all" takes in a file that arrives while it is open, keeping the older pages it loaded', async () => {
    let heads = 0

    const command = vi.fn(async (value: MatrixCommand): Promise<unknown> => {
      if (value.kind !== 'roomShared') {
        return null
      }

      if (value.section !== 'files') {
        return { section: value.section, items: [], source: 'device', unreadable: 0 }
      }

      if (value.from === 'p1') {
        return {
          section: 'files',
          items: [item({ id: '$b', kind: 'file', name: 'b.pdf', at: 2 })],
          source: 'device',
          unreadable: 1,
          next: 'p2'
        }
      }

      if (value.from === 'p2') {
        return {
          section: 'files',
          items: [item({ id: '$c', kind: 'file', name: 'c.pdf', at: 1 })],
          source: 'device',
          unreadable: 0
        }
      }

      heads++

      return {
        section: 'files',
        items: [
          ...(heads > 2 ? [item({ id: '$new', kind: 'file', name: 'new.pdf', at: 9 })] : []),
          item({ id: '$a', kind: 'file', name: 'a.pdf', at: 3 })
        ],
        source: 'device',
        unreadable: 0,
        next: 'p1'
      }
    })

    window.atumMatrix = { command } as unknown as MatrixUiBridge
    const view = renderPanel(linh)

    fireEvent.click(await screen.findByRole('button', { name: 'See all files' }))
    const all = () => window.document.querySelector<HTMLElement>('[data-matrix-person-info-all="files"]')!

    const names = () =>
      [...all().querySelectorAll('[data-matrix-person-info-file]')].map(row =>
        row.getAttribute('data-matrix-person-info-file')
      )

    await waitFor(() => expect(names()).toEqual(['$a']))
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(names()).toEqual(['$a', '$b']))

    // A new attachment lands in the open chat: the newest page is read again, without a loading
    // state, and merged in front of what was already loaded.
    view.rerender({
      messages: [
        { id: '$new', sender: linhId, body: 'new.pdf', attachment: true } as MatrixSnapshot['messages'][number]
      ]
    })

    await waitFor(() => expect(names()).toEqual(['$new', '$a', '$b']))
    expect(all().querySelector('[data-matrix-person-info-loading]')).toBeNull()
    expect(all().textContent).toContain('1 older encrypted message')

    // The deepest cursor is kept: the next page is still the one after b.pdf.
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(names()).toEqual(['$new', '$a', '$b', '$c']))
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ section: 'files', from: 'p2' }))
  })

  it('reads a chat without encryption the same way, and offers a retry when a read fails', async () => {
    const command = vi.fn(async (value: MatrixCommand): Promise<unknown> => {
      if (value.kind === 'roomShared' && value.section === 'links') {
        throw new Error('matrix_room_shared_unavailable')
      }

      return value.kind === 'roomShared' ? { section: value.section, items: [], source: 'server', unreadable: 0 } : null
    })

    window.atumMatrix = { command } as unknown as MatrixUiBridge
    renderPanel(plainLinh)

    expect(screen.getByText('Not end-to-end encrypted')).toBeTruthy()
    await waitFor(() => expect(section('links').textContent).toContain('Couldn’t load this.'))
    command.mockImplementation(async (value: MatrixCommand) =>
      value.kind === 'roomShared'
        ? {
            section: value.section,
            items: [item({ id: '$l', kind: 'link', url: 'https://x.test/' })],
            source: 'server',
            unreadable: 0
          }
        : null
    )
    fireEvent.click(within(section('links')).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(section('links').textContent).toContain('x.test'))
  })

  it('keeps the chat’s own actions: mute, low priority, report, block and delete', async () => {
    const { command } = bridge({})
    renderPanel(linh)

    fireEvent.click(screen.getByRole('switch', { name: 'Mute notifications' }))
    expect(command).toHaveBeenCalledWith({ kind: 'mute', roomId: linh.id, muted: true })
    fireEvent.click(screen.getByRole('switch', { name: 'Low priority' }))
    expect(command).toHaveBeenCalledWith({ kind: 'lowPriority', roomId: linh.id, lowPriority: true })

    fireEvent.click(screen.getByRole('button', { name: 'Delete chat' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete this chat?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'forget', roomId: linh.id }))

    expect(window.document.querySelector('[data-matrix-person-info-report]')).toBeTruthy()
    expect(window.document.querySelector('[data-matrix-person-info-block="block"]')).toBeTruthy()
  })

  it('names a group, its topic and its members, and offers Leave rather than Delete', async () => {
    bridge({})
    renderPanel(group)

    expect(screen.getByRole('tab', { name: 'Group info' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Friends' })).toBeTruthy()
    expect(screen.getByText('Weekend plans')).toBeTruthy()
    expect(screen.getByRole('button', { name: '3 members' })).toBeTruthy()
    expect(window.document.querySelector('[data-matrix-person-info-end="leave"]')).toBeTruthy()
    expect(window.document.querySelector('[data-matrix-person-info-block]')).toBeNull()
  })
})

describe('a re-read of the newest page laid over the pages already loaded', () => {
  const at = (id: string, time: number) => item({ id, kind: 'file', at: time })
  const loaded = { items: [at('$a', 5), at('$b', 3), at('$c', 1)], next: 'deep', unreadable: 4, headUnreadable: 1 }

  it('puts new items first, drops one deleted inside the fresh stretch, and keeps the deepest cursor', () => {
    const merged = matrixRoomSharedRefreshed(loaded, {
      section: 'files',
      items: [at('$new', 9), at('$b', 3)],
      next: 'head',
      source: 'device',
      unreadable: 2
    })

    expect(merged.items.map(value => value.id)).toEqual(['$new', '$b', '$c'])
    expect(merged).toMatchObject({ next: 'deep', unreadable: 5, headUnreadable: 2 })
  })

  it('takes a fresh page that reached the room start as the whole story', () => {
    const merged = matrixRoomSharedRefreshed(loaded, {
      section: 'files',
      items: [at('$a', 5)],
      source: 'device',
      unreadable: 0
    })

    expect(merged.items.map(value => value.id)).toEqual(['$a'])
    expect(merged).not.toHaveProperty('next')
  })

  it('keeps everything when the fresh page found nothing yet but history goes on', () => {
    const merged = matrixRoomSharedRefreshed(loaded, {
      section: 'files',
      items: [],
      next: 'head',
      source: 'device',
      unreadable: 0
    })

    expect(merged.items.map(value => value.id)).toEqual(['$a', '$b', '$c'])
    expect(merged.next).toBe('deep')
  })
})
