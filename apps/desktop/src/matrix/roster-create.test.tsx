import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { AppDescriptor } from '../../shared/app-catalog'
import { ACME, ACME_GUEST, botApp } from '../../shared/app-catalog.test-support'
import type { MatrixAgentView, MatrixRoom, MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import type { MatrixAliasBridge, MatrixAliasRequest, MatrixAliasResult } from '../../shared/matrix-aliases'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'

import { MatrixAddMembers } from './add-members'
import { useOpenApp } from './app-bots/use-open-app'
import { matrixFailureSubject } from './chat-error'
import { MatrixRosterCreate, type MatrixRosterCreation } from './roster-create'

const ME = '@me:test'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

const agent = (principal: string, userId: string, extra: Partial<MatrixAgentView> = {}): MatrixAgentView => ({
  principal,
  userId,
  isDefault: false,
  ready: true,
  hermes: 'ready',
  atumModel: true,
  readiness: { phase: 'ready', since: 1 },
  ...extra
})

const ATUM = agent('atum-principal', '@atum:test', { isDefault: true })
const BEA = agent('bea-principal', '@bea:test', { name: 'Bea' })
const CAM = agent('cam-principal', '@cam:test', { name: 'Cam' })

/** An assistant's private room with the owner, as main projects it. */
const assistantRoom = (id: string, who: MatrixAgentView, lastActiveAt: number): MatrixRoom => ({
  id,
  name: who.name ?? 'Atum',
  membership: 'join',
  encrypted: true,
  roomType: MATRIX_ASSISTANT_ROOM_TYPE,
  agentPrincipal: who.principal,
  lastActiveAt,
  participants: [
    { userId: ME, membership: 'join' },
    { userId: who.userId, membership: 'join' }
  ]
})

const direct = (id: string, userId: string, name: string, lastActiveAt: number): MatrixRoom => ({
  id,
  name,
  membership: 'join',
  encrypted: true,
  direct: true,
  lastActiveAt,
  participants: [
    { userId: ME, membership: 'join' },
    { userId, membership: 'join' }
  ]
})

/** An app approved for addressed-only group context: it can start a group once connected. */
const groupApp = (slug: string, order: number, linked: boolean): AppDescriptor => ({
  app: slug,
  app_id: `00000000-0000-4000-8000-00000000000${order}`,
  app_version_id: `00000000-0000-4000-9000-00000000000${order}`,
  name: { en: slug[0].toUpperCase() + slug.slice(1) },
  subtitle: null,
  description: null,
  icon: null,
  accent: '#2c8078',
  affiliation: 'first_party',
  verified: true,
  availability: 'available',
  roster_default: false,
  roster_order: order,
  supported_modes: ['direct'],
  matrix_room_context: 'addressed_only',
  has_surface: true,
  link: linked ? { mode: 'external_account', state: 'linked' } : { mode: 'none', state: 'never_linked' }
})

const SNAPSHOT: MatrixSnapshot = {
  state: 'ready',
  domainEnabled: true,
  identity: { userId: ME, deviceId: 'D' },
  assistant: { userId: ATUM.userId, deviceId: 'A' },
  agents: [ATUM, BEA, CAM],
  agentCreation: true,
  rooms: [
    assistantRoom('!atum:test', ATUM, 5),
    assistantRoom('!bea-old:test', BEA, 10),
    assistantRoom('!bea-new:test', BEA, 20),
    direct('!linh:test', '@linh:test', 'Linh', 30),
    {
      id: '!design:test',
      name: 'Design team',
      membership: 'join',
      encrypted: true,
      lastActiveAt: 40,
      participants: [
        { userId: ME, membership: 'join' },
        { userId: '@linh:test', membership: 'join' },
        { userId: '@quan:test', membership: 'join' }
      ]
    }
  ],
  roomId: null,
  messages: [],
  error: null
}

/** Bea's older room marked as her one conversation (Plan 7); the newer one is a stray chat. */
const ONE_CONVERSATION: MatrixSnapshot = {
  ...SNAPSHOT,
  rooms: SNAPSHOT.rooms.map(room =>
    room.id === '!bea-old:test'
      ? { ...room, conversation: { role: 'main' as const, main: room.id, at: 2 }, conversationOwnerId: ME }
      : room
  )
}

/** The alias directory: each handle's answer, or a refusal. */
function directory(answers: Record<string, MatrixAliasResult>): MatrixAliasBridge {
  return {
    pending: vi.fn(),
    request: vi.fn(async (input: MatrixAliasRequest) => {
      const handle = 'handle' in input ? input.handle : ''

      return answers[handle] ?? { ok: true, value: { kind: 'lookup', handle, state: 'available' } }
    })
  }
}

const person = (handle: string, matrixUser: string | null): MatrixAliasResult => ({
  ok: true,
  value: { kind: 'lookup', handle, state: 'assigned', principalKind: 'human', matrixUser }
})

function setup({
  aliases = directory({}),
  command = vi.fn<MatrixUiBridge['command']>().mockResolvedValue(null),
  group = vi.fn(async () => '!app-group:test' as string | null),
  initial = { kind: 'start' },
  snapshot = SNAPSHOT
}: {
  aliases?: MatrixAliasBridge | null
  command?: ReturnType<typeof vi.fn<MatrixUiBridge['command']>>
  group?: ReturnType<typeof vi.fn<(appId: string, name: string, locale?: string) => Promise<string | null>>>
  initial?: MatrixRosterCreation | null
  snapshot?: MatrixSnapshot
} = {}) {
  window.atumMatrix = {
    command,
    ...(aliases ? { aliases } : {}),
    apps: { group }
  } as unknown as MatrixUiBridge

  const spies = {
    openAssistant: vi.fn(),
    openAgentChat: vi.fn(),
    selectRoom: vi.fn(),
    openApp: vi.fn(),
    onConversationCreated: vi.fn()
  }

  let open: (next: MatrixRosterCreation | null) => void = () => {}

  function Harness() {
    const [creating, setCreating] = useState<MatrixRosterCreation | null>(initial)
    open = setCreating

    return <MatrixRosterCreate creating={creating} onCreatingChange={setCreating} snapshot={snapshot} {...spies} />
  }

  const view = render(
    <I18nProvider configClient={null} initialLocale="en">
      <Harness />
    </I18nProvider>
  )

  return { ...spies, aliases, command, group, view, open: (next: MatrixRosterCreation | null) => act(() => open(next)) }
}

const dialog = (name: string) => screen.getByRole('dialog', { name })

/** The one answer a search shows: who was found, with what can be done. */
function found() {
  const row = window.document.querySelector<HTMLElement>('[data-matrix-person-found]')

  if (!row) {
    throw new Error('No one was found')
  }

  return row
}

describe('the start menu behind the roster’s +', () => {
  it('is a kit form sheet with one search and only secondary footer actions', () => {
    const app = botApp(ACME)
    setup({
      snapshot: {
        ...SNAPSHOT,
        apps: { state: 'ready', apps: [app], connections: {} },
        appShortcuts: { [app.app_id]: { visibility: 'default', status: 'ready' } }
      }
    })
    const start = dialog('Start a chat')
    const footer = start.querySelector<HTMLElement>('[data-atum-start-chat-footer]')!

    expect(start.classList.contains('ak-sheet')).toBe(true)
    expect(start.querySelector('.ak-sheet-title')?.textContent).toBe('Start a chat')
    expect(within(start).getByRole('textbox', { name: 'Search people, assistants and apps' })).toBeTruthy()
    expect([...start.querySelectorAll('.ak-section')].map(section => section.textContent)).toEqual([
      'Assistants',
      'People',
      'Apps'
    ])
    expect(within(footer).getAllByRole('button').map(button => button.textContent)).toEqual([
      'New assistant',
      'Invite a friend'
    ])
    expect(footer.querySelector('.ak-btn--primary')).toBeNull()
  })

  it('opens the default assistant the way its roster row does', () => {
    const { openAssistant, selectRoom } = setup()
    const start = dialog('Start a chat')
    fireEvent.click(
      within(within(start).getByRole('group', { name: 'Assistants' })).getByRole('button', { name: /Atum.*Main agent/u })
    )
    expect(openAssistant).toHaveBeenCalledOnce()
    expect(selectRoom).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens another assistant’s newest chat, or starts its first one', () => {
    const { open, openAgentChat, selectRoom } = setup()
    fireEvent.click(within(dialog('Start a chat')).getByRole('button', { name: 'Bea' }))
    expect(selectRoom).toHaveBeenCalledExactlyOnceWith('!bea-new:test')
    open({ kind: 'start' })
    fireEvent.click(within(dialog('Start a chat')).getByRole('button', { name: 'Cam' }))
    expect(openAgentChat).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ principal: CAM.principal }))
  })

  it('opens an assistant’s one conversation, never a newer chat, and never makes a second', () => {
    const { open, openAgentChat, openAssistant, selectRoom } = setup({ snapshot: ONE_CONVERSATION })
    fireEvent.click(within(dialog('Start a chat')).getByRole('button', { name: 'Bea' }))
    expect(selectRoom).toHaveBeenCalledExactlyOnceWith('!bea-old:test')
    open({ kind: 'start' })
    fireEvent.click(
      within(within(dialog('Start a chat')).getByRole('group', { name: 'Assistants' })).getByRole('button', {
        name: /Atum.*Main agent/u
      })
    )
    // The default assistant resolves its own conversation (MatrixRoster's openAssistant).
    expect(openAssistant).toHaveBeenCalledOnce()
    expect(openAgentChat).not.toHaveBeenCalled()
  })

  it('before a conversation is marked, opens the chat waiting with unread messages, like the roster row', () => {
    const { selectRoom } = setup({
      snapshot: {
        ...SNAPSHOT,
        rooms: SNAPSHOT.rooms.map(room => (room.id === '!bea-old:test' ? { ...room, unreadNotifications: 2 } : room))
      }
    })

    fireEvent.click(within(dialog('Start a chat')).getByRole('button', { name: /^Bea/ }))
    expect(selectRoom).toHaveBeenCalledExactlyOnceWith('!bea-old:test')
  })

  it('opens the conversation you already have with a person or a group', () => {
    const { open, selectRoom } = setup()
    const people = within(dialog('Start a chat')).getByRole('group', { name: 'People' })
    // A person is listed once, by name, never as an address; assistants are not people.
    expect(within(people).getByRole('button', { name: 'Linh' })).toBeTruthy()
    expect(within(people).getByRole('button', { name: /^Design team/ })).toBeTruthy()
    expect(within(people).getByRole('button', { name: 'New group' })).toBeTruthy()
    fireEvent.click(within(people).getByRole('button', { name: 'Linh' }))
    expect(selectRoom).toHaveBeenLastCalledWith('!linh:test')
    open({ kind: 'start' })
    fireEvent.click(within(dialog('Start a chat')).getByRole('button', { name: /^Design team/ }))
    expect(selectRoom).toHaveBeenLastCalledWith('!design:test')
  })

  it('searches every section by name, and Enter opens the first match', () => {
    const { selectRoom } = setup()
    const start = dialog('Start a chat')
    fireEvent.change(within(start).getByRole('textbox', { name: 'Search people, assistants and apps' }), {
      target: { value: 'LINH' }
    })
    expect(within(start).queryByRole('group', { name: 'Assistants' })).toBeNull()
    expect(within(start).getByRole('button', { name: 'Linh' })).toBeTruthy()
    fireEvent.submit(
      within(start).getByRole('textbox', { name: 'Search people, assistants and apps' }).closest('form')!
    )
    expect(selectRoom).toHaveBeenCalledExactlyOnceWith('!linh:test')
  })

  it('never dead-ends: an @name nobody here matches is looked up on Atum', async () => {
    const aliases = directory({ lan: person('lan', '@lan:test') })
    setup({ aliases })
    const start = dialog('Start a chat')
    fireEvent.change(within(start).getByRole('textbox', { name: 'Search people, assistants and apps' }), {
      target: { value: '@lan' }
    })
    fireEvent.click(within(start).getByRole('button', { name: 'Find @lan on Atum' }))
    await waitFor(() => expect(within(found()).getByText('@lan')).toBeTruthy())
    expect(dialog('Add a friend')).toBeTruthy()
    // One lookup for the @name; the sheet's own contacts read (handles of people it lists) aside.
    const lookups = vi.mocked(aliases!.request).mock.calls.filter(([input]) => input.action !== 'contacts')
    expect(lookups).toEqual([[{ action: 'lookup', handle: 'lan' }]])
  })

  it('hands making something new to its own dialog', () => {
    const { open } = setup()
    fireEvent.click(within(dialog('Start a chat')).getByRole('button', { name: 'New group' }))
    expect(dialog('New group')).toBeTruthy()
    open({ kind: 'start' })
    fireEvent.click(within(dialog('Start a chat')).getByRole('button', { name: 'Invite a friend' }))
    expect(dialog('Add a friend')).toBeTruthy()
    open({ kind: 'start' })
    fireEvent.click(within(dialog('Start a chat')).getByRole('button', { name: 'New assistant' }))
    expect(dialog('New assistant')).toBeTruthy()
  })

  it('gives the new assistant dialog the names of the catalog’s apps, so none is taken', () => {
    const createAgent = vi.fn(async () => ({ principal: 'dan', roomId: '!dan:test' }))

    setup({
      snapshot: {
        ...SNAPSHOT,
        apps: { state: 'ready', apps: [botApp({ ...ACME, name: 'Demoza', slug: 'demoza' })], connections: {} }
      }
    })
    Object.assign(window.atumMatrix, { createAgent })
    fireEvent.click(within(dialog('Start a chat')).getByRole('button', { name: 'New assistant' }))

    const sheet = dialog('New assistant')

    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Display name' }), {
      target: { value: 'Demoza Official' }
    })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create assistant' }))

    expect(within(sheet).getByRole('alert').textContent).toBe('This name belongs to an Atum assistant.')
    expect(createAgent).not.toHaveBeenCalled()
  })

  it('offers only what this account can do', () => {
    setup({ aliases: null, snapshot: { ...SNAPSHOT, agentCreation: false } })
    const start = dialog('Start a chat')
    expect(within(start).queryByRole('button', { name: 'New assistant' })).toBeNull()
    expect(within(start).queryByRole('button', { name: 'Invite a friend' })).toBeNull()
    fireEvent.change(within(start).getByRole('textbox', { name: 'Search people, assistants and apps' }), {
      target: { value: 'lan' }
    })
    expect(within(start).queryByRole('button', { name: 'Find @lan on Atum' })).toBeNull()
    expect(within(start).getByText('No matches')).toBeTruthy()
  })
})

describe('adding a friend by their @name', () => {
  const findFriend = (query: string) => {
    fireEvent.change(within(dialog('Add a friend')).getByRole('textbox', { name: 'Their @name' }), {
      target: { value: query }
    })
    fireEvent.click(within(dialog('Add a friend')).getByRole('button', { name: 'Find' }))
  }

  it('starts a direct conversation with someone new', async () => {
    const { command, onConversationCreated } = setup({
      aliases: directory({ lan: person('lan', '@lan:test') }),
      initial: { kind: 'friend' }
    })

    findFriend('Lan')
    await waitFor(() => expect(within(found()).getByText('@lan')).toBeTruthy())
    expect(within(found()).getByText('On Atum')).toBeTruthy()
    fireEvent.click(within(found()).getByRole('button', { name: 'Message' }))
    expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'create', name: '', invite: ['@lan:test'], direct: true })
    await waitFor(() => expect(onConversationCreated).toHaveBeenCalledOnce())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reuses the conversation you already have instead of making a second', async () => {
    const { command, selectRoom } = setup({
      aliases: directory({ linh: person('linh', '@linh:test') }),
      initial: { kind: 'friend' }
    })

    findFriend('@linh')
    // Shown by the name the roster already uses, with their @name beside it.
    await waitFor(() => expect(within(found()).getByText('Linh')).toBeTruthy())
    fireEvent.click(within(found()).getByRole('button', { name: 'Message' }))
    expect(selectRoom).toHaveBeenCalledExactlyOnceWith('!linh:test')
    expect(command).not.toHaveBeenCalled()
  })

  it('opens your own assistant when its @name is found', async () => {
    const { selectRoom } = setup({
      aliases: directory({
        bea_bot: {
          ok: true,
          value: {
            kind: 'lookup',
            handle: 'bea_bot',
            state: 'assigned',
            principalKind: 'agent',
            matrixUser: BEA.userId
          }
        }
      }),
      initial: { kind: 'friend' }
    })

    findFriend('bea_bot')
    await waitFor(() => expect(within(found()).getByText('Your assistant', { exact: false })).toBeTruthy())
    fireEvent.click(within(found()).getByRole('button', { name: 'Open' }))
    expect(selectRoom).toHaveBeenCalledExactlyOnceWith('!bea-new:test')
  })

  it('opens your own assistant’s one conversation when its @name is found', async () => {
    const { selectRoom } = setup({
      aliases: directory({
        bea_bot: {
          ok: true,
          value: {
            kind: 'lookup',
            handle: 'bea_bot',
            state: 'assigned',
            principalKind: 'agent',
            matrixUser: BEA.userId
          }
        }
      }),
      initial: { kind: 'friend' },
      snapshot: ONE_CONVERSATION
    })

    findFriend('bea_bot')
    await waitFor(() => expect(within(found()).getByText('Your assistant', { exact: false })).toBeTruthy())
    fireEvent.click(within(found()).getByRole('button', { name: 'Open' }))
    expect(selectRoom).toHaveBeenCalledExactlyOnceWith('!bea-old:test')
  })

  it.each([
    [
      'nobody',
      { ok: true, value: { kind: 'lookup', handle: 'nobody', state: 'available' } },
      'No one on Atum is called @nobody.'
    ],
    [
      'gone',
      { ok: true, value: { kind: 'lookup', handle: 'gone', state: 'unavailable' } },
      'No one on Atum is called @gone.'
    ],
    ['busy', { ok: false, error: 'limit', retryAfterSeconds: 30 }, 'Try again in 30 seconds.'],
    ['signedout', { ok: false, error: 'authentication' }, 'Sign in again to find people.'],
    ['offline', { ok: false, error: 'unavailable' }, "Couldn't search right now."],
    ['tuan', person('tuan', null), "On Atum, but can't be messaged yet."],
    [
      'spa_bot',
      {
        ok: true,
        value: { kind: 'lookup', handle: 'spa_bot', state: 'assigned', principalKind: 'agent', matrixUser: '@spa:test' }
      },
      'Only its owner can chat with this assistant.'
    ],
    [
      'river',
      {
        ok: true,
        value: { kind: 'lookup', handle: 'river', state: 'assigned', principalKind: 'app', matrixUser: '@river:test' }
      },
      'This is an app.'
    ],
    ['minh', person('minh', ME), "That's you."]
  ] as const)(
    'says plainly what a search for @%s found, with nothing to press when nothing can be done',
    async (handle, answer, text) => {
      const { command } = setup({
        aliases: directory({ [handle]: answer as MatrixAliasResult }),
        initial: { kind: 'friend' }
      })

      findFriend(handle)
      await waitFor(() => expect(within(dialog('Add a friend')).getByText(text, { exact: false })).toBeTruthy())
      expect(within(dialog('Add a friend')).queryByRole('button', { name: 'Message' })).toBeNull()
      expect(command).not.toHaveBeenCalled()
    }
  )

  it('asks for an exact @name instead of searching for a name', () => {
    const { aliases } = setup({ initial: { kind: 'friend' } })
    findFriend('Lan Nguyen')
    expect(within(dialog('Add a friend')).getByText('To find someone new, enter their exact @name.')).toBeTruthy()
    expect(aliases!.request).not.toHaveBeenCalled()
  })

  it('quietly accepts a whole Matrix address without a lookup', async () => {
    const { aliases, command } = setup({ initial: { kind: 'friend' } })
    findFriend('@user-0a1b:test')
    fireEvent.click(within(found()).getByRole('button', { name: 'Message' }))
    expect(aliases!.request).not.toHaveBeenCalled()
    expect(command).toHaveBeenCalledExactlyOnceWith({
      kind: 'create',
      name: '',
      invite: ['@user-0a1b:test'],
      direct: true
    })
  })

  it('drops an answer that arrives after the query changed', async () => {
    let answer!: (value: MatrixAliasResult) => void

    const aliases: MatrixAliasBridge = {
      pending: vi.fn(),
      request: vi.fn(() => new Promise<MatrixAliasResult>(resolve => (answer = resolve)))
    }

    setup({ aliases, initial: { kind: 'friend' } })
    findFriend('lan')
    expect(within(dialog('Add a friend')).getByText('Searching…')).toBeTruthy()
    fireEvent.change(within(dialog('Add a friend')).getByRole('textbox', { name: 'Their @name' }), {
      target: { value: 'linh' }
    })
    await act(async () => answer(person('lan', '@lan:test')))
    expect(window.document.querySelector('[data-matrix-person-found]')).toBeNull()
  })

  it('starts one conversation at a time, even across a dismissal, and a late success leaves the roster alone', async () => {
    let finish!: (value: unknown) => void
    const command = vi.fn<MatrixUiBridge['command']>(() => new Promise(resolve => (finish = resolve)))

    const { open, onConversationCreated } = setup({
      aliases: directory({ lan: person('lan', '@lan:test') }),
      command,
      initial: { kind: 'friend' }
    })

    findFriend('lan')
    await waitFor(() => expect(within(found()).getByRole('button', { name: 'Message' })).toBeTruthy())
    fireEvent.click(within(found()).getByRole('button', { name: 'Message' }))
    fireEvent.keyDown(dialog('Add a friend'), { key: 'Escape' })
    open({ kind: 'friend' })
    findFriend('lan')
    await waitFor(() =>
      expect((within(found()).getByRole('button', { name: 'Message' }) as HTMLButtonElement).disabled).toBe(true)
    )
    fireEvent.keyDown(dialog('Add a friend'), { key: 'Escape' })
    await act(async () => finish('!dm:test'))
    expect(command).toHaveBeenCalledOnce()
    expect(onConversationCreated).not.toHaveBeenCalled()
  })

  it('keeps the dialog open with a plain failure when the conversation cannot start', async () => {
    const command = vi.fn<MatrixUiBridge['command']>().mockRejectedValue(new Error('offline'))
    setup({ aliases: directory({ lan: person('lan', '@lan:test') }), command, initial: { kind: 'friend' } })
    findFriend('lan')
    await waitFor(() => expect(within(found()).getByRole('button', { name: 'Message' })).toBeTruthy())
    fireEvent.click(within(found()).getByRole('button', { name: 'Message' }))
    expect(await within(dialog('Add a friend')).findByRole('alert')).toBeTruthy()
    expect(within(dialog('Add a friend')).getByRole('alert').textContent).toContain("Couldn't start the chat.")
  })
})

describe('a new group', () => {
  const groupDialog = () => dialog('New group')
  const create = () => within(groupDialog()).getByRole('button', { name: 'Create group' }) as HTMLButtonElement
  const row = (name: string) => within(groupDialog()).getByRole('checkbox', { name }) as HTMLInputElement

  const search = (value: string) =>
    fireEvent.change(within(groupDialog()).getByRole('textbox', { name: 'Search names, or enter an @name' }), {
      target: { value }
    })

  it('makes the group from its name and everyone picked, known or found by their @name', async () => {
    const { command, onConversationCreated } = setup({
      aliases: directory({ lan: person('lan', '@lan:test') }),
      initial: { kind: 'group' }
    })

    // The history rule is said plainly, once.
    expect(within(groupDialog()).getByText('People added later can see earlier messages too.')).toBeTruthy()
    expect(create().disabled).toBe(true)
    // One list, no tabs: recent chats lead it.
    expect(within(groupDialog()).queryByRole('radio')).toBeNull()
    expect(within(within(groupDialog()).getByRole('region', { name: 'Recent chats' })).getByText('Linh')).toBeTruthy()
    fireEvent.click(row('Linh'))
    // A member is enough to make a group, as in Zalo; a name is optional.
    expect(create().disabled).toBe(false)
    search('@lan')
    fireEvent.click(within(groupDialog()).getByRole('button', { name: 'Find @lan on Atum' }))
    // Found on purpose: listed, and ticked straight away.
    await waitFor(() => expect(row('@lan').checked).toBe(true))
    expect(within(groupDialog()).getByRole('button', { name: 'Remove @lan' })).toBeTruthy()
    fireEvent.change(within(groupDialog()).getByLabelText('Group name'), { target: { value: ' Book club ' } })
    fireEvent.click(create())
    expect(command).toHaveBeenCalledExactlyOnceWith({
      kind: 'create',
      name: 'Book club',
      invite: ['@linh:test', '@lan:test'],
      direct: false
    })
    await waitFor(() => expect(onConversationCreated).toHaveBeenCalledOnce())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('wears its own name as its face, never the first member’s initial', () => {
    setup({ initial: { kind: 'group' } })
    const face = () => groupDialog().querySelector('[data-matrix-new-group-face]')!
    fireEvent.click(row('Linh'))
    // Named after Linh by default, but the face is a plain group mark, not Linh's "L".
    expect(face().textContent).toBe('')
    expect(face().querySelector('svg')).toBeTruthy()
    fireEvent.change(within(groupDialog()).getByLabelText('Group name'), { target: { value: ' Book club ' } })
    expect(face().textContent).toBe('B')
  })

  it('names a group after its members when it has no name of its own', async () => {
    const { command } = setup({ initial: { kind: 'group' } })
    fireEvent.click(row('Linh'))
    fireEvent.click(create())
    await waitFor(() =>
      expect(command).toHaveBeenCalledExactlyOnceWith({
        kind: 'create',
        name: 'Linh',
        invite: ['@linh:test'],
        direct: false
      })
    )
  })

  it('adds your own assistants to a new group with people, and says what that means', async () => {
    const away = agent('dee-principal', '@dee:test', { name: 'Dee', ready: false })

    const { command, onConversationCreated } = setup({
      aliases: directory({
        bea_bot: {
          ok: true,
          value: {
            kind: 'lookup',
            handle: 'bea_bot',
            state: 'assigned',
            principalKind: 'agent',
            matrixUser: BEA.userId
          }
        }
      }),
      initial: { kind: 'group' },
      snapshot: { ...SNAPSHOT, agents: [ATUM, BEA, CAM, away] }
    })

    fireEvent.click(within(groupDialog()).getByRole('button', { name: 'Assistants' }))
    expect(within(groupDialog()).getByRole('button', { name: 'Assistants' }).getAttribute('aria-pressed')).toBe('true')

    for (const name of ['Atum', 'Bea', 'Cam']) {
      expect(row(name).disabled).toBe(false)
    }

    // One still being set up can't join yet, and says so without naming a place.
    expect(row('Dee').disabled).toBe(true)
    expect(within(groupDialog()).getByText('Not ready yet')).toBeTruthy()
    expect(within(groupDialog()).queryByRole('checkbox', { name: 'Linh' })).toBeNull()
    fireEvent.click(row('Bea'))
    // Picking one says, once, who can ask it and who reads its answers.
    expect(
      within(groupDialog()).getByText(
        'Only you can ask your assistants here, and everyone can read their answers. In a group with only your assistants, relevant ones may join without being named. Your message, their work descriptions, a quoted message, and recent group messages may go to AI services to choose and prepare replies.'
      )
    ).toBeTruthy()
    // Found by @name, one of yours is the assistant row already, never offered as a person.
    fireEvent.click(within(groupDialog()).getByRole('button', { name: 'All' }))
    search('bea_bot')
    fireEvent.click(within(groupDialog()).getByRole('button', { name: 'Find @bea_bot on Atum' }))
    await waitFor(() => expect(within(groupDialog()).getByText('Bea: Your assistant')).toBeTruthy())
    expect(within(groupDialog()).queryByRole('checkbox', { name: '@bea_bot' })).toBeNull()
    search('')
    fireEvent.click(row('Linh'))
    fireEvent.change(within(groupDialog()).getByLabelText('Group name'), { target: { value: 'Trip' } })
    fireEvent.click(create())
    // One create: the people, then your assistants; main tells them apart and has each join.
    expect(command).toHaveBeenCalledExactlyOnceWith({
      kind: 'create',
      name: 'Trip',
      invite: ['@linh:test', BEA.userId],
      direct: false
    })
    await waitFor(() => expect(onConversationCreated).toHaveBeenCalledOnce())
  })

  it('stops at five of your assistants in one group', () => {
    const crew = Array.from({ length: 6 }, (_, index) =>
      agent(`crew${index}-principal`, `@crew${index}:test`, { name: `Crew ${index}` })
    )

    setup({ initial: { kind: 'group' }, snapshot: { ...SNAPSHOT, agents: [ATUM, ...crew] } })
    fireEvent.click(within(groupDialog()).getByRole('button', { name: 'Assistants' }))

    for (const index of [0, 1, 2, 3, 4]) {
      fireEvent.click(row(`Crew ${index}`))
    }

    expect(row('Crew 5').disabled).toBe(true)
    expect(row('Atum').disabled).toBe(true)
    expect(within(groupDialog()).getAllByText('Up to 5 assistants in a group').length).toBeGreaterThan(0)
  })

  it('lists every app, and starts a group with a connected one through the app’s own confirmation', async () => {
    const river = groupApp('river', 1, true)
    const ledger = groupApp('ledger', 2, false)
    const moon = { ...groupApp('moon', 3, true), matrix_room_context: null, roster_default: true }

    const { command, group, onConversationCreated } = setup({
      initial: { kind: 'group' },
      snapshot: { ...SNAPSHOT, apps: { state: 'ready', apps: [river, ledger, moon], connections: {} } }
    })

    fireEvent.change(within(groupDialog()).getByLabelText('Group name'), { target: { value: 'Ledger review' } })
    fireEvent.click(within(groupDialog()).getByRole('button', { name: 'Apps' }))
    // An app that can't join a group yet is still listed, with why.
    expect(row('Moon').disabled).toBe(true)
    expect(row('Ledger').disabled).toBe(true)
    expect(within(groupDialog()).getByText('Connect this app first')).toBeTruthy()
    fireEvent.click(row('River'))
    expect(within(groupDialog()).getByText('A group with this app is just you and the app.')).toBeTruthy()
    fireEvent.click(within(groupDialog()).getByRole('button', { name: 'All' }))
    // A you-and-this-app group holds no one else: no person, and none of your assistants.
    expect(row('Linh').disabled).toBe(true)
    expect(row('Bea').disabled).toBe(true)
    expect(within(groupDialog()).getAllByText('Not with the app you picked').length).toBeGreaterThan(1)
    fireEvent.click(create())
    await waitFor(() => expect(group).toHaveBeenCalledExactlyOnceWith(river.app_id, 'Ledger review', 'en'))
    await waitFor(() => expect(onConversationCreated).toHaveBeenCalledOnce())
    expect(command).not.toHaveBeenCalled()
  })

  it('keeps the draft through a dismissal and after a failure', async () => {
    const command = vi.fn<MatrixUiBridge['command']>().mockRejectedValueOnce(new Error('offline'))
    const { open } = setup({ command, initial: { kind: 'group' } })
    fireEvent.change(within(groupDialog()).getByLabelText('Group name'), { target: { value: 'Family' } })
    fireEvent.click(row('Linh'))
    fireEvent.keyDown(groupDialog(), { key: 'Escape' })
    open({ kind: 'group' })
    expect((within(groupDialog()).getByLabelText('Group name') as HTMLInputElement).value).toBe('Family')
    expect(row('Linh').checked).toBe(true)
    fireEvent.click(create())
    expect(await within(groupDialog()).findByRole('alert')).toBeTruthy()
    expect((within(groupDialog()).getByLabelText('Group name') as HTMLInputElement).value).toBe('Family')
    expect(within(groupDialog()).getByRole('button', { name: 'Remove Linh' })).toBeTruthy()
  })

  it('reads in Vietnamese by default', () => {
    window.atumMatrix = { command: vi.fn(), apps: { group: vi.fn() } } as unknown as MatrixUiBridge
    render(
      <I18nProvider configClient={null} initialLocale="vi">
        <MatrixRosterCreate
          creating={{ kind: 'group' }}
          onConversationCreated={vi.fn()}
          onCreatingChange={vi.fn()}
          openAgentChat={vi.fn()}
          openApp={vi.fn()}
          openAssistant={vi.fn()}
          selectRoom={vi.fn()}
          snapshot={SNAPSHOT}
        />
      </I18nProvider>
    )

    const view = dialog('Tạo nhóm')
    expect(within(view).getByRole('textbox', { name: 'Nhập tên hoặc @tên' })).toBeTruthy()
    expect(within(view).getByRole('region', { name: 'Trò chuyện gần đây' })).toBeTruthy()

    for (const chip of ['Tất cả', 'Người', 'Trợ lý', 'Ứng dụng']) {
      expect(within(view).getByRole('button', { name: chip })).toBeTruthy()
    }

    expect(within(view).getByRole('button', { name: 'Tạo nhóm' })).toBeTruthy()
  })
})

describe('adding members says what newcomers see', () => {
  it('in a plain group: its history; in an encrypted one from before 0.20: only what follows', () => {
    const group = SNAPSHOT.rooms.find(room => room.id === '!design:test')!

    for (const [encrypted, rule] of [
      [false, 'People added later can see earlier messages too.'],
      [true, 'People added later only see messages sent after they join.']
    ] as const) {
      window.atumMatrix = { command: vi.fn() } as unknown as MatrixUiBridge
      render(
        <I18nProvider configClient={null} initialLocale="en">
          <MatrixAddMembers
            members={(group.participants ?? []).map(each => ({ ...each, name: each.userId, canRemove: false }))}
            onOpenChange={vi.fn()}
            open
            room={{ ...group, encrypted }}
            snapshot={SNAPSHOT}
          />
        </I18nProvider>
      )
      expect(screen.getByText(rule)).toBeTruthy()
      cleanup()
    }
  })
})

describe('an app in the start menu', () => {
  const ready = { visibility: 'default' as const, status: 'ready' as const }

  function menu(apps: AppDescriptor[], bridge: { chat?: ReturnType<typeof vi.fn> } = {}) {
    const command = vi.fn<MatrixUiBridge['command']>().mockResolvedValue(null)
    const chat = bridge.chat ?? vi.fn().mockResolvedValue(undefined)
    const fail = vi.fn()
    const navigated = vi.fn()
    window.atumMatrix = { command, apps: { chat } } as unknown as MatrixUiBridge

    const snapshot: MatrixSnapshot = {
      ...SNAPSHOT,
      apps: { state: 'ready', apps, connections: {} },
      appShortcuts: Object.fromEntries(apps.map(app => [app.app_id, ready]))
    }

    function Harness() {
      const { openApp } = useOpenApp(snapshot, 'en', fail)

      return (
        <MatrixRosterCreate
          creating={{ kind: 'start' }}
          onConversationCreated={vi.fn()}
          onCreatingChange={navigated}
          openAgentChat={vi.fn()}
          openApp={openApp}
          openAssistant={vi.fn()}
          selectRoom={vi.fn()}
          snapshot={snapshot}
        />
      )
    }

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <Harness />
      </I18nProvider>
    )

    return { chat, command, fail }
  }

  const pick = (name: RegExp) => fireEvent.click(within(dialog('Start a chat')).getByRole('button', { name }))

  it.each([
    ['an app the client has no code for', ACME],
    ['a guest-enabled one', ACME_GUEST]
  ])('starts the chat with %s, as its roster row does, and not its page', async (_label, seed) => {
    const acme = botApp(seed)
    const { chat, command, fail } = menu([acme])

    pick(/^Acme/u)

    await waitFor(() => expect(chat).toHaveBeenCalledExactlyOnceWith(ACME.appId, 'en'))
    expect(command).not.toHaveBeenCalled()
    expect(fail).not.toHaveBeenCalled()
  })

  it('opens an app that has no bot on its page, as before', async () => {
    const river = { ...botApp(ACME), bot: null, has_surface: true }
    const { chat, command } = menu([river])

    pick(/^Acme/u)

    await waitFor(() => expect(command).toHaveBeenCalledExactlyOnceWith({ kind: 'selectApp', appId: ACME.appId }))
    expect(chat).not.toHaveBeenCalled()
  })

  it('says why when the bot cannot be opened, naming the bot', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('matrix_app_bot_paused'))
    const { fail } = menu([botApp(ACME)], { chat })

    pick(/^Acme/u)

    await waitFor(() => expect(fail).toHaveBeenCalledOnce())
    expect(matrixFailureSubject(fail.mock.calls[0]![0])).toBe('Acme')
  })

  it('opens one bot at a time: a second pick while the first is opening is ignored', async () => {
    let finish: () => void = () => {}
    const chat = vi.fn(() => new Promise<void>(resolve => (finish = resolve)))
    menu([botApp(ACME)], { chat })

    pick(/^Acme/u)
    pick(/^Acme/u)
    expect(chat).toHaveBeenCalledOnce()
    finish()
  })
})
