import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixSnapshot, MatrixUiBridge } from '../../../shared/matrix'
import type { MatrixCompanyRequest } from '../../../shared/matrix-company'
import { matrixTeamSpaceCopy } from '../../../shared/matrix-team-space-copy'
import { MatrixCompanyChannelMenu, MatrixCompanyMembersButton } from '../company-channel-menu'
import { companySpacePreferences, companySpaceScope, type CompanySpaceTab, patchCompanySpacePreferences } from '../company-space-store'
import { MatrixCompanyWorkspace } from '../company-workspace'

import { clearCompanyChannels } from './channels-store'
import { $companyDirectories } from './directory-store'
import { clearTeamSpaceDiscovery } from './discovery-store'
import { requestTeamSpaceIntent } from './intents'
import {
  CHANNEL_IDS,
  channelRoom,
  COMPANY_ID,
  platform,
  type Platform,
  REFS,
  renderTeamSpace,
  resetTeamSpace,
  type ScriptedChannel,
  TestResizeObserver
} from './test-support'

vi.stubGlobal('ResizeObserver', TestResizeObserver)

beforeEach(() => {resetTeamSpace(); $companyDirectories.set({})})
afterEach(cleanup)

const general: ScriptedChannel = { id: CHANNEL_IDS.general, name: 'general', systemKey: 'default', actions: ['update_metadata'] }

const ops: ScriptedChannel = {
  id: CHANNEL_IDS.ops, name: 'ops', ownerRef: REFS.owner, actions: ['leave', 'invite', 'remove', 'update_metadata', 'archive'], generation: 9,
  admissionGeneration: 5
}

const leadership: ScriptedChannel = {
  id: CHANNEL_IDS.leadership, name: 'leadership', visibility: 'private', topic: 'Q4 plans', ownerRef: REFS.owner,
  actions: ['leave', 'invite', 'remove', 'update_metadata', 'archive'], generation: 11, admissionGeneration: 6
}

const NEW_CHANNEL = '00000000-0000-4000-8000-516f647ced28'

const old: ScriptedChannel = { id: CHANNEL_IDS.old, name: 'old', state: 'archived', actions: ['restore'] }

const rooms = (...channels: ScriptedChannel[]) => channels.map(channel => channelRoom(channel.id, channel.name))

const channelsSection = () => document.querySelector('[data-matrix-company-channels]') as HTMLElement
const open = (name: string) => screen.findByRole('button', { name: `Open # ${name}` })

function addMenu() {
  fireEvent.keyDown(within(channelsSection()).getByRole('button', { name: 'Add channels' }), { key: 'Enter' })
}

describe('C2 sidebar', () => {
  it('returns to Chat when a channel is opened from another company view', async () => {
    const source = platform({ channels: [general] })
    const scope = companySpaceScope('account-a', COMPANY_ID)
    patchCompanySpacePreferences(scope, { tab: 'board' })
    const onOpenChannel = vi.fn(async () => {})

    renderTeamSpace(source, {
      channelContent: <div data-testid="channel-transcript">Channel transcript</div>,
      onOpenChannel,
      rooms: rooms(general)
    })

    expect((await screen.findByRole('tab', { name: 'Board' })).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(await open('general'))

    await waitFor(() => expect(onOpenChannel).toHaveBeenCalledWith('!general:atum.example', expect.any(Function)))
    expect(companySpacePreferences(scope).tab).toBe('chat')
    expect(screen.getByTestId('channel-transcript').closest('[hidden]')).toBeNull()
  })

  it('draws Favorites, Channels (a private one marked), and Archived apart, from the admitted directory', async () => {
    const source = platform({ channels: [general, ops, leadership, old] })
    const all = [general, ops, leadership, old]
    renderTeamSpace(source, { rooms: [channelRoom(ops.id, 'ops', { favourite: true }), ...rooms(general, leadership, old)] })

    await open('general')
    const favorites = document.querySelector('[data-matrix-company-favorites]') as HTMLElement

    expect(within(favorites).getByRole('button', { name: 'Open # ops' })).toBeTruthy()
    expect(within(channelsSection()).queryByRole('button', { name: 'Open # ops' })).toBeNull()

    const secret = within(channelsSection()).getByRole('button', { name: 'Open # leadership · Private channel' })
    expect(secret.closest('[data-matrix-company-channel-row]')?.getAttribute('data-channel-visibility')).toBe('private')
    expect(within(channelsSection()).getByRole('button', { name: 'Open # general' })).toBeTruthy()

    // Archived is collapsed until asked for.
    const archived = document.querySelector('[data-matrix-company-archived]') as HTMLElement
    expect(within(archived).queryByRole('button', { name: 'Open # old' })).toBeNull()
    fireEvent.click(within(archived).getByRole('button', { name: 'Archived' }))
    expect(within(archived).getByRole('button', { name: 'Open # old' })).toBeTruthy()

    expect(source.calls('admitted-channels').length).toBeGreaterThan(0)
    expect(source.calls('list-channels')).toHaveLength(0)
    expect(all).toHaveLength(4)
  })

  it('reads the 1.1 company-wide directory and draws the flat list when channel admission is not active', async () => {
    const source = platform({ discovery: 'admin-only', channels: [general, ops, leadership] })
    renderTeamSpace(source, { rooms: rooms(general, ops, leadership) })

    await open('general')
    await open('ops')

    // The private channel never reaches a 1.1 client, and the new controls are not drawn.
    expect(screen.queryByRole('button', { name: /leadership/ })).toBeNull()
    expect(document.querySelector('[data-matrix-company-favorites]')).toBeNull()
    expect(document.querySelector('[data-matrix-company-archived]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add channels' })).toBeNull()
    expect(source.calls('admitted-channels')).toHaveLength(0)
    expect(source.calls('list-channels').length).toBeGreaterThan(0)
  })

  it('offers an admin the 1.1 inline create form on an older server, exactly as before', async () => {
    const source = platform({ discovery: 'missing', viewer: 'admin', channels: [general] })
    renderTeamSpace(source, { rooms: rooms(general) })
    await open('general')

    fireEvent.click(screen.getByRole('button', { name: 'Create channel' }))
    fireEvent.change(await screen.findByLabelText('Channel name'), { target: { value: 'launch' } })
    fireEvent.click(within(screen.getByRole('form', { name: 'Create channel' })).getByRole('button', { name: 'Create channel' }))

    await waitFor(() => expect(source.calls('create-channel')).toHaveLength(1))
    expect(source.calls('create-channel')[0]).toMatchObject({ companyId: COMPANY_ID, displayName: 'launch' })
    expect(source.calls('channel-command')).toHaveLength(0)
  })
})

describe('C2 who can add or browse channels', () => {
  it.each([
    ['an owner', { viewer: 'owner' }, ['Create a channel', 'Browse channels']],
    ['a member while everyone may create', { viewer: 'member' }, ['Create a channel', 'Browse channels']],
    ['a member once creation is restricted', { viewer: 'member', policy: 'admins_only' }, ['Browse channels']],
    ['an admin once creation is restricted', { viewer: 'admin', policy: 'admins_only' }, ['Create a channel', 'Browse channels']],
    ['a member while the room controller is not ready', { viewer: 'member', rooms: 'not_ready' }, ['Browse channels']]
  ] as const)('gives %s only what the platform allows', async (_name, over, items) => {
    const source = platform({ channels: [general], ...over } as never)
    renderTeamSpace(source, { rooms: rooms(general) })
    await open('general')
    await waitFor(() => expect(within(channelsSection()).queryByRole('button', { name: 'Add channels' })).toBeTruthy())
    addMenu()

    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(items)
  })

  it('explains why creating is not offered, in Browse channels', async () => {
    const source = platform({ viewer: 'member', policy: 'admins_only', channels: [general] })
    renderTeamSpace(source, { rooms: rooms(general) })
    await open('general')
    await waitFor(() => expect(within(channelsSection()).queryByRole('button', { name: 'Add channels' })).toBeTruthy())
    addMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Browse channels' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Only the owner and admins can create channels.')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'Create a channel' })).toBeNull()
  })
})

describe('C2 creating a channel', () => {
  const NEW_ID = '00000000-0000-4000-8000-47f93d02c87b'

  function creating(): Platform {
    const source: Platform = platform({
      channels: [general],
      mutations: {
        'channel-command': input => {
          const command = (input as Extract<MatrixCompanyRequest, { action: 'channel-command' }>).command

          if (command.operation !== 'create') {
            return { ok: false, error: 'unavailable' }
          }

          source.state.channels.push({ id: NEW_ID, name: command.displayName, visibility: command.visibility, ownerRef: REFS.owner })

          return { ok: true, value: { schemaVersion: 5, operation: 'create', channelId: NEW_ID, authorityGeneration: 8, channelGeneration: 1,
            admission: { memberRef: REFS.owner, state: 'active', admissionEpoch: 1, admissionGeneration: 1 }, replayed: false } }
        }
      }
    })

    return source
  }

  it('creates a private channel on the 1.4 wire, says visibility is final, and opens it once its room is ready', async () => {
    const source = creating()
    const onOpenChannel = vi.fn(async () => {})
    renderTeamSpace(source, { rooms: rooms(general), onOpenChannel, convergenceDelayMs: 5 })
    await open('general')
    await waitFor(() => expect(within(channelsSection()).queryByRole('button', { name: 'Add channels' })).toBeTruthy())
    addMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create a channel' }))

    const dialog = await screen.findByRole('dialog', { name: 'Create a channel' })
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: ' leadership ' } })
    expect(within(dialog).getByText('Everyone in the company can find it and join.')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Private' }))
    expect(within(dialog).getByText('Only the people you add can find it.')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create channel' }))

    await waitFor(() => expect(source.calls('channel-command')).toHaveLength(1))
    expect(source.calls('channel-command')[0]).toMatchObject({
      action: 'channel-command',
      companyId: COMPANY_ID,
      command: { operation: 'create', displayName: 'leadership', visibility: 'private' }
    })
    expect(source.calls('channel-command')[0]).not.toHaveProperty('channelId')
    // The legacy company-wide create is never used for a channel the person asked to keep private.
    expect(source.calls('create-channel')).toHaveLength(0)
    await waitFor(() => expect(onOpenChannel).toHaveBeenCalledWith('!leadership:atum.example', expect.any(Function)))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create a channel' })).toBeNull())
  })

  it('creates a public channel by default, with an optional description', async () => {
    const source = creating()
    renderTeamSpace(source, { rooms: rooms(general), convergenceDelayMs: 5 })
    await open('general')
    await waitFor(() => expect(within(channelsSection()).queryByRole('button', { name: 'Add channels' })).toBeTruthy())
    addMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create a channel' }))
    const dialog = await screen.findByRole('dialog', { name: 'Create a channel' })

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'ops' } })
    fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: 'Day-to-day' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create channel' }))

    await waitFor(() => expect(source.calls('channel-command')).toHaveLength(1))
    expect(source.calls('channel-command')[0]).toMatchObject({
      command: { operation: 'create', displayName: 'ops', visibility: 'public', purpose: 'Day-to-day' }
    })
  })

  it('will not send an empty or over-long name, and shows the platform’s reason for a taken one', async () => {
    const source = platform({ channels: [general], mutations: {
      'channel-command': () => ({ ok: false, error: 'conflict', reason: 'channel_name_conflict' })
    } })

    renderTeamSpace(source, { rooms: rooms(general) })
    await open('general')
    await waitFor(() => expect(within(channelsSection()).queryByRole('button', { name: 'Add channels' })).toBeTruthy())
    addMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create a channel' }))
    const dialog = await screen.findByRole('dialog', { name: 'Create a channel' })
    const submit = within(dialog).getByRole('button', { name: 'Create channel' })

    expect(submit.hasAttribute('disabled')).toBe(true)
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'x'.repeat(81) } })
    expect(submit.hasAttribute('disabled')).toBe(true)
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'ops' } })
    expect(submit.hasAttribute('disabled')).toBe(false)
    fireEvent.click(submit)

    expect(await within(dialog).findByText('A public channel with that name already exists.')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Create a channel' })).toBeTruthy()
  })
})

describe('C2 creating a channel with its people', () => {
  const people = [
    { key: 'owner' as const, role: 'owner' as const }, { key: 'admin' as const, role: 'admin' as const },
    { key: 'member' as const, role: 'member' as const }, { key: 'other' as const, role: 'member' as const }
  ]

  async function createSheet(source: Platform) {
    renderTeamSpace(source, { rooms: rooms(general), convergenceDelayMs: 5 })
    await open('general')
    await waitFor(() => expect(within(channelsSection()).queryByRole('button', { name: 'Add channels' })).toBeTruthy())
    addMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create a channel' }))

    return screen.findByRole('dialog', { name: 'Create a channel' })
  }

  const chips = (dialog: HTMLElement) =>
    [...dialog.querySelectorAll('[data-matrix-channel-person-chip]')].map(chip => chip.getAttribute('data-matrix-channel-person-chip'))

  const commands = (source: Platform) =>
    source.calls('channel-command').map(call => (call as Extract<MatrixCompanyRequest, { action: 'channel-command' }>).command)

  it('offers the people picker for a public channel and a private one alike', async () => {
    const dialog = await createSheet(platform({ channels: [general], members: people }))

    expect(dialog.querySelector('[data-matrix-channel-create-people]')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Private' }))
    expect(dialog.querySelector('[data-matrix-channel-create-people]')).toBeTruthy()
    const search = within(dialog).getByRole('combobox', { name: 'Search by name or @username' })
    const list = within(dialog).getByRole('listbox', { name: 'Add people' })

    // Everyone active but the creator, who is in the channel already.
    expect(within(list).getAllByRole('option').map(option => option.getAttribute('data-matrix-channel-person')))
      .toEqual([REFS.admin, REFS.member, REFS.other])
    expect(within(list).getByRole('option', { name: /Lan Nguyễn\s*@lan_nguyen/u })).toBeTruthy()

    // Accents ignored, @username matched; Enter picks the match while searching.
    fireEvent.change(search, { target: { value: 'nguyen' } })
    expect(within(list).getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(chips(dialog)).toEqual([REFS.member])
    expect((search as HTMLInputElement).value).toBe('')

    fireEvent.change(search, { target: { value: '@bao' } })
    expect(within(list).getAllByRole('option')).toHaveLength(1)
    fireEvent.click(within(list).getByRole('option', { name: /Bảo/u }))
    fireEvent.change(search, { target: { value: '' } })
    fireEvent.click(within(list).getByRole('option', { name: /Tú/u }))
    expect(chips(dialog)).toEqual([REFS.member, REFS.admin, REFS.other])
    expect(within(list).getByRole('option', { name: /Tú/u }).getAttribute('aria-selected')).toBe('true')

    // A chip's × removes it; Backspace in an empty search drops the last one.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Lan Nguyễn' }))
    fireEvent.keyDown(search, { key: 'Backspace' })
    expect(chips(dialog)).toEqual([REFS.admin])

    fireEvent.change(search, { target: { value: 'zz' } })
    expect(within(dialog).getByText('No one matches that.')).toBeTruthy()
  })

  it('creates a private channel with the picked people in the create command, and invites no one afterwards', async () => {
    const source = platform({ channels: [general], members: people })
    const dialog = await createSheet(source)

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'leadership' } })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Private' }))
    const list = within(dialog).getByRole('listbox', { name: 'Add people' })
    fireEvent.click(within(list).getByRole('option', { name: /Bảo/u }))
    fireEvent.click(within(list).getByRole('option', { name: /Tú/u }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create channel' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create a channel' })).toBeNull())
    expect(commands(source)).toEqual([
      expect.objectContaining({ operation: 'create', displayName: 'leadership', visibility: 'private', initialMemberRefs: [REFS.admin, REFS.other] })
    ])
    // Admitted in the one command: no invitation and no per-person read of the new channel.
    expect(source.calls('read-admitted-channel').filter(call => (call as { channelId?: string }).channelId === CHANNEL_IDS.ops)).toHaveLength(0)
  })

  it('creates a public channel with the picked people in the create command', async () => {
    const source = platform({ channels: [general], members: people })
    const dialog = await createSheet(source)

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'town-hall' } })
    fireEvent.click(within(within(dialog).getByRole('listbox', { name: 'Add people' })).getByRole('option', { name: /Lan/u }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create channel' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create a channel' })).toBeNull())
    expect(commands(source)).toEqual([
      expect.objectContaining({ operation: 'create', displayName: 'town-hall', visibility: 'public', initialMemberRefs: [REFS.member] })
    ])
  })

  it('creates with nobody picked as a 1.1 create with no people', async () => {
    const source = platform({ channels: [general], members: people })
    const dialog = await createSheet(source)

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'quiet' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create channel' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create a channel' })).toBeNull())
    expect(commands(source)).toEqual([expect.objectContaining({ operation: 'create', initialMemberRefs: [] })])
  })

  it('when a pick has left the company, makes the channel anyway, adds the rest, says who is missing, and retries only what can work', async () => {
    let lanRaced = true

    const source: Platform = platform({ channels: [general], members: people, mutations: {
      'channel-command': input => {
        const command = (input as Extract<MatrixCompanyRequest, { action: 'channel-command' }>).command

        if (command.operation === 'create' && 'initialMemberRefs' in command) {
          // The create and its picks commit together: one person who left (Bảo) refuses all of it.
          if (command.initialMemberRefs.includes(REFS.admin)) {
            return { ok: false, error: 'missing', reason: 'channel_unavailable' }
          }

          source.state.channels.push({ id: NEW_CHANNEL, name: command.displayName, visibility: command.visibility, ownerRef: REFS.owner,
            actions: ['invite', 'leave', 'update_metadata', 'archive'] })

          return { ok: true, value: { schemaVersion: 6, operation: 'create', channelId: NEW_CHANNEL, authorityGeneration: 8, channelGeneration: 1,
            admissions: [{ memberRef: REFS.owner, state: 'active', admissionEpoch: 1, admissionGeneration: 1 }], replayed: false } }
        }

        if (command.operation === 'add') {
          if (command.memberRef === REFS.admin) {
            return { ok: false, error: 'missing', reason: 'channel_unavailable' }
          }

          if (command.memberRef === REFS.member && lanRaced) {
            return { ok: false, error: 'conflict', reason: 'admission_generation_conflict' }
          }

          return { ok: true, value: { schemaVersion: 6, operation: 'add', channelId: NEW_CHANNEL, authorityGeneration: 8, channelGeneration: 2,
            admissions: [{ memberRef: command.memberRef, state: 'active', admissionEpoch: 1, admissionGeneration: 1 }], replayed: false } }
        }

        return { ok: false, error: 'unavailable' }
      }
    } })

    const dialog = await createSheet(source)
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'launch' } })
    const list = within(dialog).getByRole('listbox', { name: 'Add people' })
    fireEvent.click(within(list).getByRole('option', { name: /Bảo/u }))
    fireEvent.click(within(list).getByRole('option', { name: /Lan/u }))
    fireEvent.click(within(list).getByRole('option', { name: /Tú/u }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create channel' }))

    const result = await screen.findByRole('dialog', { name: '#launch is ready' })
    expect(within(result).getByText('Some people couldn’t be added.')).toBeTruthy()

    const state = () => [...result.querySelectorAll('[data-matrix-channel-add-result]')].map(row => [row.textContent?.includes('Bảo') ? 'Bảo'
      : row.textContent?.includes('Lan') ? 'Lan' : 'Tú', row.getAttribute('data-matrix-channel-add-result')])

    expect(state()).toEqual([['Bảo', 'failed'], ['Lan', 'failed'], ['Tú', 'added']])

    const rows = [...result.querySelectorAll('[data-matrix-channel-add-result]')] as HTMLElement[]
    expect(within(rows[0]!).getByText('No longer in the company.')).toBeTruthy()
    expect(within(rows[1]!).getByText(matrixTeamSpaceCopy('en').refusal.admission_generation_conflict)).toBeTruthy()
    expect(within(rows[2]!).getByText('Added')).toBeTruthy()

    // Try again sends only Lan's add: nothing brings back someone who left.
    lanRaced = false
    fireEvent.click(within(result).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(state()).toEqual([['Bảo', 'failed'], ['Lan', 'added'], ['Tú', 'added']]))
    expect(within(result).queryByRole('button', { name: 'Try again' })).toBeNull()
    fireEvent.click(within(result).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    expect(commands(source).map(command => [command.operation, 'initialMemberRefs' in command ? command.initialMemberRefs
      : 'memberRef' in command ? command.memberRef : undefined])).toEqual([
      ['create', [REFS.admin, REFS.member, REFS.other]], ['create', []],
      ['add', REFS.admin], ['add', REFS.member], ['add', REFS.other], ['add', REFS.member]
    ])
    // Never through the invitation path.
    expect(commands(source).some(command => command.operation === 'invite')).toBe(false)
  })

  it('says inline when a name is empty, too long, or a public name already taken', async () => {
    const dialog = await createSheet(platform({ channels: [general], members: people }))
    const name = within(dialog).getByLabelText('Name')
    const submit = within(dialog).getByRole('button', { name: 'Create channel' })

    // Untouched: nothing said yet, nothing to send.
    expect(dialog.querySelector('[data-matrix-channel-name-problem]')).toBeNull()
    expect(submit.hasAttribute('disabled')).toBe(true)

    fireEvent.change(name, { target: { value: 'a' } })
    fireEvent.change(name, { target: { value: '  ' } })
    expect(within(dialog).getByText('Give the channel a name.')).toBeTruthy()
    expect(name.getAttribute('aria-invalid')).toBe('true')

    fireEvent.change(name, { target: { value: 'x'.repeat(81) } })
    expect(within(dialog).getByText('Use 80 characters or fewer.')).toBeTruthy()
    expect(submit.hasAttribute('disabled')).toBe(true)

    fireEvent.change(name, { target: { value: 'general' } })
    expect(within(dialog).getByText('A public channel with that name already exists.')).toBeTruthy()
    expect(submit.hasAttribute('disabled')).toBe(true)

    // A private channel may share a public one's name.
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Private' }))
    expect(dialog.querySelector('[data-matrix-channel-name-problem]')).toBeNull()
    expect(submit.hasAttribute('disabled')).toBe(false)
  })
})

describe('C2 browsing channels', () => {
  const browse = {
    schemaVersion: 5,
    channels: [
      { id: CHANNEL_IDS.general, companyId: COMPANY_ID, displayName: 'general', visibility: 'public', topic: 'Team updates', purpose: '', state: 'active', memberCount: 3, joined: true, systemKey: 'default' },
      { id: CHANNEL_IDS.ops, companyId: COMPANY_ID, displayName: 'ops', visibility: 'public', topic: '', purpose: 'Day-to-day operations', state: 'active', memberCount: 1, joined: false },
      { id: '00000000-0000-4000-8000-bd1ee75ed104', companyId: COMPANY_ID, displayName: 'planning', visibility: 'public', topic: '', purpose: 'Roadmap', state: 'active', memberCount: 7, joined: false },
      { id: CHANNEL_IDS.old, companyId: COMPANY_ID, displayName: 'old', visibility: 'public', topic: '', purpose: '', state: 'archived', memberCount: 2, joined: false }
    ]
  }

  const joinableBrowse = {
    schemaVersion: 7,
    channels: browse.channels.map((channel, index) => ({ ...channel, channelGeneration: index + 4 }))
  }

  async function browsing(source: Platform, props: Parameters<typeof renderTeamSpace>[1] = {}) {
    renderTeamSpace(source, { rooms: rooms(general), ...props })
    await open('general')
    await waitFor(() => expect(within(channelsSection()).queryByRole('button', { name: 'Add channels' })).toBeTruthy())
    addMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Browse channels' }))

    return screen.findByRole('dialog', { name: 'Browse channels' })
  }

  it('lists every public channel with its size and whether you are in it, searchable, with Archived apart', async () => {
    const source = platform({ channels: [general] }, { joinableBrowse })
    const dialog = await browsing(source)
    const list = await within(dialog).findByRole('list', { name: 'Browse channels' })

    expect(within(list).getAllByRole('listitem').map(item => item.getAttribute('data-browse-channel'))).toEqual([
      CHANNEL_IDS.general, CHANNEL_IDS.ops, '00000000-0000-4000-8000-bd1ee75ed104'
    ])
    expect(within(list).getByText(/1 member · Day-to-day operations/)).toBeTruthy()
    expect(within(list).getByText(/7 members · Roadmap/)).toBeTruthy()

    fireEvent.change(within(dialog).getByLabelText('Search channels'), { target: { value: 'road' } })
    expect(within(dialog).getByText('No channels match your search.')).toBeTruthy()

    fireEvent.change(within(dialog).getByLabelText('Search channels'), { target: { value: 'plan' } })
    expect(within(await within(dialog).findByRole('list')).getByText('planning')).toBeTruthy()

    fireEvent.change(within(dialog).getByLabelText('Search channels'), { target: { value: '' } })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Archived' }))
    const archived = within(dialog).getByRole('list', { name: 'Browse channels' })
    expect(within(archived).getAllByRole('listitem')).toHaveLength(1)
    expect(within(archived).queryByRole('button')).toBeNull()
    expect(source.calls('browse-joinable-channels')).toHaveLength(1)
    expect(source.calls('browse-channels')).toHaveLength(0)
  })

  it('keeps Browse read-only on an older platform, while an already-joined channel shows View', async () => {
    const onOpenChannel = vi.fn(async () => {})
    const dialog = await browsing(platform({ channels: [general] }, { browse }), { onOpenChannel })
    const list = await within(dialog).findByRole('list', { name: 'Browse channels' })

    const joined = within(list).getByText('general').closest('li') as HTMLElement
    expect(within(joined).getByText('Joined')).toBeTruthy()

    const notJoined = within(list).getByText('ops').closest('li') as HTMLElement
    expect(within(notJoined).getByRole('button', { name: 'Join: ops' }).hasAttribute('disabled')).toBe(true)
    expect(within(notJoined).queryByText('Joined')).toBeNull()

    fireEvent.click(within(joined).getByRole('button', { name: 'View' }))
    await waitFor(() => expect(onOpenChannel).toHaveBeenCalledWith('!general:atum.example', expect.any(Function)))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Browse channels' })).toBeNull())
  })

  it('refreshes the platform generation, joins once, then opens when Matrix membership is ready', async () => {
    const onOpenChannel = vi.fn(async () => {})
    const source = platform({ channels: [general, ops] }, { joinableBrowse })
    const dialog = await browsing(source, { onOpenChannel })
    const list = await within(dialog).findByRole('list', { name: 'Browse channels' })
    const notJoined = within(list).getByText('ops').closest('li') as HTMLElement

    fireEvent.click(within(notJoined).getByRole('button', { name: 'Join: ops' }))

    await waitFor(() => expect(source.calls('browse-joinable-channels')).toHaveLength(2))
    await waitFor(() => expect(source.calls('channel-command')).toHaveLength(1))
    expect(source.calls('channel-command')[0]).toMatchObject({
      companyId: COMPANY_ID,
      channelId: CHANNEL_IDS.ops,
      command: { operation: 'join', expectedChannelGeneration: 5 }
    })
    await waitFor(() => expect(onOpenChannel).toHaveBeenCalledWith('!ops:atum.example', expect.any(Function)))
    expect(screen.queryByRole('dialog', { name: 'Browse channels' })).toBeNull()
  })

  it('keeps the sheet open and names a definitive join refusal', async () => {
    const source = platform({
      channels: [general, ops],
      mutations: {
        'channel-command': () => ({
          ok: false,
          error: 'conflict',
          reason: 'admission_generation_conflict'
        })
      }
    }, { joinableBrowse })

    const dialog = await browsing(source)
    const notJoined = within(dialog).getByText('ops').closest('li') as HTMLElement

    fireEvent.click(within(notJoined).getByRole('button', { name: 'Join: ops' }))

    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'This channel changed while you were looking. Try again.'
    )
    expect(screen.getByRole('dialog', { name: 'Browse channels' })).toBeTruthy()
  })

  it('says when the list could not be read', async () => {
    const source = platform({ channels: [general], mutations: { 'browse-channels': () => ({ ok: false, error: 'unavailable' }) } })
    const dialog = await browsing(source)

    expect(await within(dialog).findByText(/Couldn’t load the channels/)).toBeTruthy()
  })
})

const KEY = '@me:test:D'

/** The open channel's header menu inside the workspace, as the window composes them. */
function openChannelView(source: Platform, channel: ScriptedChannel, props: Partial<Parameters<typeof renderTeamSpace>[1]> = {}) {
  const room = channelRoom(channel.id, channel.name)
  const command = vi.fn<MatrixUiBridge['command']>().mockResolvedValue(null)
  window.atumMatrix = { command, companies: source.bridge } as unknown as MatrixUiBridge

  const snapshot: MatrixSnapshot = {
    state: 'ready', identity: { userId: '@me:test', deviceId: 'D' }, rooms: [room], roomId: room.id, messages: [], error: null
  }

  const onOpenChannel = vi.fn(async () => {})

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixCompanyWorkspace
        accountKey={KEY}
        activeRoomId={room.id}
        bridge={source.bridge}
        channelContent={<MatrixCompanyChannelMenu fail={vi.fn()} room={room} snapshot={snapshot} title={channel.name} />}
        convergenceDelayMs={5}
        ensureDefaultChannels={false}
        onOpenChannel={onOpenChannel}
        preferredCompanyId={COMPANY_ID}
        rooms={[room, ...rooms(general).filter(candidate => candidate.id !== room.id)]}
        {...props}
      />
    </I18nProvider>
  )

  return { command, onOpenChannel, room }
}

/** The menu's items, opening it only if it is not already open (a retry must not toggle it shut). */
async function channelMenu() {
  const trigger = await screen.findByRole('button', { name: 'Conversation options' })

  if (trigger.getAttribute('aria-expanded') !== 'true') {
    fireEvent.keyDown(trigger, { key: 'Enter' })
  }

  return screen.queryAllByRole('menuitem').map(item => item.textContent)
}

describe('C2 the open channel’s menu', () => {
  it('offers what the platform lets the viewer do in this channel, and #general no way out', async () => {
    const source = platform({ channels: [general, ops] })
    openChannelView(source, ops)

    // A public channel is joined, not invited to, so there is no “Add people”.
    await waitFor(async () => expect(await channelMenu()).toContain('Leave channel'))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Channel members', 'Edit channel', 'Add to favorites', 'Notifications', 'Leave channel', 'Archive channel'
    ])
  })

  it('adds “Add people” to a private channel only', async () => {
    const source = platform({ channels: [general, leadership] })
    openChannelView(source, leadership)

    await waitFor(async () => expect(await channelMenu()).toContain('Add people'))
  })

  it('has no Leave or Archive for the default channel, whatever else it allows', async () => {
    const source = platform({ channels: [{ ...general, actions: ['leave', 'archive', 'invite', 'update_metadata'] }] })
    openChannelView(source, general)

    await waitFor(async () => expect(await channelMenu()).toContain('Edit channel'))
    const names = screen.getAllByRole('menuitem').map(item => item.textContent)

    expect(names).not.toContain('Leave channel')
    expect(names).not.toContain('Archive channel')
    expect(names).not.toContain('Add people')
  })

  it('favorites a channel with the Matrix tag, so the sidebar’s Favorites follows the account', async () => {
    const source = platform({ channels: [general, ops] })
    const { command, room } = openChannelView(source, ops)

    await waitFor(async () => expect(await channelMenu()).toContain('Add to favorites'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to favorites' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ kind: 'favourite', roomId: room.id, favourite: true }))
  })

  it('leaves a channel on the current generations, after an explicit confirmation, and moves to #general', async () => {
    const source = platform({ channels: [general, ops] })
    const { onOpenChannel } = openChannelView(source, ops)

    await waitFor(async () => expect(await channelMenu()).toContain('Leave channel'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Leave channel' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Leave ops?')).toBeTruthy()
    expect(dialog.textContent).toContain('Leave now; rejoin later from Browse channels.')
    expect(source.calls('channel-command')).toHaveLength(0)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave channel' }))
    await waitFor(() => expect(source.calls('channel-command')).toHaveLength(1))
    expect(source.calls('channel-command')[0]).toMatchObject({
      companyId: COMPANY_ID,
      channelId: CHANNEL_IDS.ops,
      command: { operation: 'leave', expectedChannelGeneration: 9, expectedAdmissionGeneration: 5 }
    })
    // The generations were read from the platform just before, not taken from the directory on screen.
    expect(source.calls('read-admitted-channel').some(call => 'channelId' in call && call.channelId === CHANNEL_IDS.ops)).toBe(true)
    await waitFor(() => expect(onOpenChannel).toHaveBeenCalledWith('!general:atum.example', expect.any(Function)))
  })

  it('tells a person leaving a private channel they will need a new invitation', async () => {
    const source = platform({ channels: [general, leadership] })
    openChannelView(source, leadership)

    await waitFor(async () => expect(await channelMenu()).toContain('Leave channel'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Leave channel' }))

    expect((await screen.findByRole('dialog')).textContent).toContain('returning needs a new invitation')
  })

  it('archives only after a confirmation, then draws the channel under Archived', async () => {
    const source = platform({ channels: [general, ops], mutations: {
      'channel-command': () => {
        source.state.channels[1]!.state = 'archived'
        source.state.channels[1]!.actions = ['restore']

        return { ok: true, value: { schemaVersion: 5, operation: 'archive' as const, channelId: CHANNEL_IDS.ops,
          authorityGeneration: 8, channelGeneration: 10, admission: null, replayed: false } }
      }
    } })

    openChannelView(source, ops)
    await waitFor(async () => expect(await channelMenu()).toContain('Archive channel'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive channel' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('Archived channels stay readable but become read-only.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive channel' }))

    await waitFor(() => expect(source.calls('channel-command')).toHaveLength(1))
    expect(source.calls('channel-command')[0]).toMatchObject({ command: { operation: 'archive', expectedChannelGeneration: 9 } })
    await waitFor(() => expect(document.querySelector('[data-matrix-company-archived]')).toBeTruthy())
  })

  it('restores an archived channel from its menu on the current generation', async () => {
    const source = platform({ channels: [general, { ...ops, state: 'archived', actions: ['restore'] }] })
    openChannelView(source, ops)

    await waitFor(async () => expect(await channelMenu()).toContain('Restore channel'))
    expect(screen.queryByRole('menuitem', { name: 'Leave channel' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Archive channel' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restore channel' }))

    await waitFor(() => expect(source.calls('channel-command')).toHaveLength(1))
    expect(source.calls('channel-command')[0]).toMatchObject({ command: { operation: 'restore', expectedChannelGeneration: 9 } })
  })

  it('says in the dialog that the channel changed when the generation was stale, and does not send it again', async () => {
    const source = platform({ channels: [general, ops], mutations: {
      'channel-command': () => ({ ok: false, error: 'conflict', reason: 'admission_generation_conflict' })
    } })

    openChannelView(source, ops)
    await waitFor(async () => expect(await channelMenu()).toContain('Leave channel'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Leave channel' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Leave channel' }))

    expect(await screen.findByText('This channel changed while you were looking. Try again.')).toBeTruthy()
    expect(source.calls('channel-command')).toHaveLength(1)
  })

  it('a note left by the header while the channels are not on 1.4 does nothing', async () => {
    const source = platform({ discovery: 'missing', viewer: 'admin', channels: [general, ops] })
    openChannelView(source, ops)
    await screen.findByRole('button', { name: 'Conversation options' })

    act(() => requestTeamSpaceIntent({ kind: 'leave-channel', channelId: CHANNEL_IDS.ops }))
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(source.calls('channel-command')).toHaveLength(0)
  })
})

describe('C2 channel people', () => {
  const members = (...rows: Array<[string, 'active' | 'invited' | 'revoking', number]>) => ({
    schemaVersion: 5, channelId: CHANNEL_IDS.leadership, channelGeneration: 11,
    members: rows.map(([memberRef, state, admissionGeneration]) => ({ memberRef, state, admissionEpoch: 1, admissionGeneration }))
  })

  async function peopleDialog(source: Platform, channel = leadership) {
    openChannelView(source, channel)
    await waitFor(async () => expect(await channelMenu()).toContain('Channel members'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Channel members' }))

    return screen.findByRole('complementary', { name: 'Channel members' })
  }

  const everyone = [
    { key: 'owner' as const, role: 'owner' as const }, { key: 'admin' as const, role: 'admin' as const },
    { key: 'member' as const, role: 'member' as const }, { key: 'other' as const, role: 'member' as const }
  ]

  // Minh and Lan are in, Tú is invited; Bảo is in the company but not in the channel.
  const moderated = (): Platform => platform({ channels: [general, leadership], members: everyone },
    { members: members([REFS.owner, 'active', 3], [REFS.member, 'active', 4], [REFS.other, 'invited', 6]) })

  async function headerMembersPanel(
    source: Platform,
    tab: CompanySpaceTab,
    channel: ScriptedChannel = leadership
  ) {
    const room = channelRoom(channel.id, channel.name)

    const snapshot: MatrixSnapshot = {
      state: 'ready', identity: { userId: '@me:test', deviceId: 'D' }, rooms: [room], roomId: room.id,
      messages: [], error: null
    }

    const scope = companySpaceScope(KEY, COMPANY_ID)

    window.atumMatrix = { command: vi.fn().mockResolvedValue(null), companies: source.bridge } as unknown as MatrixUiBridge
    patchCompanySpacePreferences(scope, { tab })

    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MatrixCompanyMembersButton snapshot={snapshot} />
        <MatrixCompanyWorkspace
          accountKey={KEY}
          activeRoomId={room.id}
          bridge={source.bridge}
          channelContent={<div data-testid="channel-content" />}
          convergenceDelayMs={5}
          ensureDefaultChannels={false}
          onOpenChannel={vi.fn(async () => {})}
          preferredCompanyId={COMPANY_ID}
          rooms={[room, channelRoom(general.id, general.name)]}
        />
      </I18nProvider>
    )

    const trigger = window.document.querySelector<HTMLButtonElement>('[data-matrix-company-members-button]')!
    await waitFor(() => expect(trigger.getAttribute('aria-label')).toMatch(/member/i))
    fireEvent.click(trigger)

    const panel = await screen.findByRole('complementary', { name: 'Channel members' })
    expect(companySpacePreferences(scope).tab).toBe(tab)

    return panel
  }

  it.each([
    ['Chat', 'chat'],
    ['Board', 'board']
  ] as const)('opens the header member stack in the right panel from %s', async (_label, tab) => {
    const panel = await headerMembersPanel(moderated(), tab)

    expect(panel.getAttribute('data-matrix-company-channel-members-panel')).not.toBeNull()
  })

  it('opens the company-wide channel roster in the right panel on the 1.1 fallback', async () => {
    const panel = await headerMembersPanel(
      platform({ discovery: 'admin-only', channels: [general, leadership], members: everyone }),
      'chat'
    )

    expect(panel.getAttribute('data-matrix-company-members-panel')).not.toBeNull()
    expect(within(panel).getByRole('list', { name: 'Members' })).toBeTruthy()
  })

  it('lists who is in a channel by name, with their state, to the people who may see it', async () => {
    const dialog = await peopleDialog(moderated())
    const list = await within(dialog).findByRole('list', { name: 'Channel members' })
    const items = within(list).getAllByRole('listitem')

    expect(items.map(item => item.getAttribute('data-admission-state'))).toEqual(['active', 'active', 'invited'])
    expect(within(items[0]!).getByText('Minh')).toBeTruthy()
    expect(within(items[0]!).getByText('Channel owner')).toBeTruthy()
    expect(within(items[2]!).getByText('Invited')).toBeTruthy()
  })

  it('shows a person being removed as “Removing…”, with nothing to click, and does not offer to add them back', async () => {
    const source = platform({ channels: [general, leadership], members: everyone },
      { members: members([REFS.owner, 'active', 3], [REFS.member, 'active', 4], [REFS.admin, 'revoking', 2]) })

    const dialog = await peopleDialog(source)
    const list = await within(dialog).findByRole('list', { name: 'Channel members' })
    const going = within(list).getByText('Bảo').closest('li') as HTMLElement

    expect(within(going).getByText('Removing…')).toBeTruthy()
    expect(within(going).queryByRole('button')).toBeNull()
    expect(within(within(dialog).getByRole('list', { name: 'Add people' })).queryByText('Bảo')).toBeNull()
  })

  it('removes a person at their own admission generation, and cancels an invitation the same way', async () => {
    const source = moderated()
    const dialog = await peopleDialog(source)
    const list = await within(dialog).findByRole('list', { name: 'Channel members' })

    fireEvent.click(within(within(list).getByText('Lan Nguyễn').closest('li') as HTMLElement).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(source.calls('channel-command')).toHaveLength(1))
    expect(source.calls('channel-command')[0]).toMatchObject({
      channelId: CHANNEL_IDS.leadership,
      command: { operation: 'remove', memberRef: REFS.member, expectedChannelGeneration: 11, expectedAdmissionGeneration: 4 }
    })

    fireEvent.click(within(within(list).getByText('Tú').closest('li') as HTMLElement).getByRole('button', { name: 'Cancel invitation' }))
    await waitFor(() => expect(source.calls('channel-command')).toHaveLength(2))
    expect(source.calls('channel-command')[1]).toMatchObject({ command: { operation: 'remove', memberRef: REFS.other, expectedAdmissionGeneration: 6 } })
  })

  it('offers no removal for yourself, the channel’s owner or a person already being removed', async () => {
    const dialog = await peopleDialog(moderated())
    const list = await within(dialog).findByRole('list', { name: 'Channel members' })

    expect(within(within(list).getByText('Minh').closest('li') as HTMLElement).queryByRole('button')).toBeNull()
  })

  it('adds people to a private channel by inviting them on the current channel generation', async () => {
    const source = moderated()
    const dialog = await peopleDialog(source)
    await within(dialog).findByRole('list', { name: 'Channel members' })
    const add = within(dialog).getByRole('list', { name: 'Add people' })

    // Only company members who are not already in (or going out of) the channel can be added.
    expect(within(add).queryByText('Lan Nguyễn')).toBeNull()
    fireEvent.click(within(add).getByRole('button', { name: 'Add: Bảo' }))

    await waitFor(() => expect(source.calls('channel-command')).toHaveLength(1))
    expect(source.calls('channel-command')[0]).toMatchObject({
      channelId: CHANNEL_IDS.leadership,
      command: { operation: 'invite', memberRef: REFS.admin, expectedChannelGeneration: 11 }
    })
    expect(await within(dialog).findByText('Bảo was invited.')).toBeTruthy()
  })

  it('shows an ordinary member the reason instead of a list the platform would not send', async () => {
    const source = platform({ viewer: 'member', channels: [general, { ...leadership, ownerRef: REFS.owner }] })
    const dialog = await peopleDialog(source)

    expect(await within(dialog).findByText('Only owners and admins can view this member list.')).toBeTruthy()
    expect(source.calls('channel-members')).toHaveLength(0)
  })
})

describe('C2 channel details', () => {
  it('edits only what changed, on the current generation, and never offers a visibility change', async () => {
    const source = platform({ channels: [general, leadership] })
    openChannelView(source, leadership)

    await waitFor(async () => expect(await channelMenu()).toContain('Edit channel'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit channel' }))
    const dialog = await screen.findByRole('dialog', { name: 'Channel details' })

    expect(within(dialog).getByText('Private · only people who were added can find it')).toBeTruthy()
    fireEvent.pointerMove(within(dialog).getByRole('button', { name: 'More info' }))
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      'Visibility can’t be changed after a channel is created.'
    )
    expect(within(dialog).queryByRole('radiogroup')).toBeNull()
    const save = within(dialog).getByRole('button', { name: 'Save changes' })
    expect(save.hasAttribute('disabled')).toBe(true)

    fireEvent.change(within(dialog).getByLabelText('Topic'), { target: { value: 'Q1 plans' } })
    fireEvent.click(save)

    await waitFor(() => expect(source.calls('channel-command')).toHaveLength(1))
    expect(source.calls('channel-command')[0]).toMatchObject({
      channelId: CHANNEL_IDS.leadership,
      command: { operation: 'update_metadata', expectedChannelGeneration: 11, topic: 'Q1 plans' }
    })
    expect(JSON.stringify(source.calls('channel-command')[0])).not.toMatch(/visibility|displayName|purpose/)
  })

  it('keeps the default channel’s name fixed while its topic can change', async () => {
    const source = platform({ channels: [general] })
    openChannelView(source, general)

    await waitFor(async () => expect(await channelMenu()).toContain('Edit channel'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit channel' }))
    const dialog = await screen.findByRole('dialog', { name: 'Channel details' })

    expect(within(dialog).getByLabelText('Name').hasAttribute('disabled')).toBe(true)
    expect(within(dialog).getByLabelText('Topic').hasAttribute('disabled')).toBe(false)
  })

  it('says the platform’s reason when a rename collides with a public channel', async () => {
    const source = platform({ channels: [general, ops], mutations: {
      'channel-command': () => ({ ok: false, error: 'conflict', reason: 'channel_name_conflict' })
    } })

    openChannelView(source, ops)
    await waitFor(async () => expect(await channelMenu()).toContain('Edit channel'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit channel' }))
    const dialog = await screen.findByRole('dialog', { name: 'Channel details' })
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'general-2' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    expect(await within(dialog).findByText('A public channel with that name already exists.')).toBeTruthy()
  })
})

describe('C2 privacy never widens', () => {
  it('keeps a transient directory visibly stale, then evicts it on explicit denial', async () => {
    const source = platform({ channels: [general, leadership] })
    renderTeamSpace(source, { rooms: rooms(general, leadership) })
    await screen.findByRole('button', { name: 'Open # leadership · Private channel' })

    source.state.mutations['admitted-channels'] = () => ({ ok: false, error: 'unavailable' })
    act(() => { window.dispatchEvent(new Event('focus')) })

    await screen.findByText('Atum is unreachable. Try again shortly.')
    expect(screen.getByRole('button', { name: 'Open # leadership · Private channel' })).toBeTruthy()
    expect(document.querySelector('[data-matrix-company-channels-stale]')).toBeTruthy()

    source.state.mutations['admitted-channels'] = () => ({ ok: false, error: 'denied' })
    act(() => { window.dispatchEvent(new Event('focus')) })

    await screen.findByText('You no longer have access to this company.')
    expect(screen.queryByRole('button', { name: /leadership/ })).toBeNull()
    expect(document.querySelector('[data-matrix-company-channels-stale]')).toBeNull()
  })

  it('stops drawing a private channel the moment discovery says channel admission is off, never as a plain row', async () => {
    const source = platform({ channels: [general, leadership] })
    renderTeamSpace(source, { rooms: rooms(general, leadership) })
    await screen.findByRole('button', { name: 'Open # leadership · Private channel' })

    // Channel admission is switched off; the 1.1 read that follows is slow to answer.
    source.state.discovery = 'inactive'
    source.state.mutations['list-channels'] = () => new Promise(() => {}) as never
    act(() => { window.dispatchEvent(new Event('focus')) })

    await waitFor(() => expect(source.calls('capabilities').length).toBeGreaterThan(1))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add channels' })).toBeNull())
    expect(screen.queryByRole('button', { name: /leadership/ })).toBeNull()
    expect(screen.queryByText('leadership')).toBeNull()
  })

  it('draws no channel from a directory read on a different wire than discovery selects', async () => {
    const source = platform({ discovery: 'unavailable', channels: [general, leadership] })
    renderTeamSpace(source, { rooms: rooms(general, leadership) })

    // Discovery is unknown, which gates like legacy: the 1.1 list, and no private channel.
    await open('general')
    expect(screen.queryByRole('button', { name: /leadership/ })).toBeNull()
    expect(source.calls('admitted-channels')).toHaveLength(0)
  })
})


it('cold-starts private channel sections from disk while discovery and live reads are pending', async () => {
  const source = platform({ channels: [general, leadership] })
  renderTeamSpace(source)
  await open('leadership · Private channel')
  cleanup()
  clearTeamSpaceDiscovery()
  clearCompanyChannels('account-a')
  $companyDirectories.set({})
  source.request.mockImplementation(() => new Promise(() => {}))
  renderTeamSpace(source)
  expect(await open('leadership · Private channel')).toBeTruthy()
  expect(document.querySelector('[data-matrix-company-channels-stale]')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Add channels' })).toBeNull()
})
