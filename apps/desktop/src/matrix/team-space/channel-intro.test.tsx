import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { DESKTOP_LOCALES } from '../../../shared/desktop-locale'
import type { MatrixCompanyResult } from '../../../shared/matrix-company'
import { matrixCompanyCopy } from '../../../shared/matrix-company-copy'
import { matrixTeamSpaceCopy } from '../../../shared/matrix-team-space-copy'
import { timelineReachesStart } from '../timeline-history'

import { NO_CHANNEL_ABILITIES } from './abilities'
import { channelDescription, ChannelHeaderMeta } from './channel-chrome'
import { ChannelCreateDialog } from './channel-create-dialog'
import { ChannelDetailsDialog } from './channel-details-dialog'
import { ChannelIntro, ChannelIntroFor, clearChannelIntroNames, companyMemberName } from './channel-intro'
import { $companyChannels } from './channels-store'
import { $teamSpaceDiscovery, clearTeamSpaceDiscovery } from './discovery-store'
import { $teamSpaceIntent } from './intents'
import { teamSpaceKey } from './keys'
import { $companyStanding } from './standing-store'
import { capabilities, CHANNEL_IDS, channelRoom, COMPANY_ID, REFS } from './test-support'
import type { CompanyChannelView } from './views'

afterEach(cleanup)

beforeEach(() => {
  clearTeamSpaceDiscovery()
  clearChannelIntroNames()
  $companyChannels.set({})
  $companyStanding.set({})
  $teamSpaceIntent.set(undefined)
})

const view = (over: Partial<CompanyChannelView> = {}): CompanyChannelView => ({
  id: CHANNEL_IDS.ops,
  companyId: COMPANY_ID,
  displayName: 'ops',
  visibility: 'public',
  state: 'active',
  topic: '',
  purpose: 'Day-to-day operations and on-call handoffs',
  memberCount: 3,
  room: { state: 'ready', roomId: '!ops:atum.example' },
  projectId: null,
  channelGeneration: 9,
  wire: '1.4',
  ownerMemberRef: REFS.owner,
  admission: { memberRef: REFS.owner, state: 'active', epoch: 1, generation: 5 },
  actions: ['leave', 'update_metadata', 'archive'],
  ...over
})

const mount = (node: React.ReactNode, locale = 'en') =>
  render(<I18nProvider configClient={null} initialLocale={locale}>{node}</I18nProvider>)

// 3 November 2026, 09:00 in Ho Chi Minh City: the same calendar day in UTC.
const CREATED = Date.UTC(2026, 10, 3, 2)
const editor = { addPeople: false, edit: true }
const reader = { addPeople: false, edit: false }

describe('the channel intro', () => {
  it('names the channel, says what it is for, and who made it and when', () => {
    mount(<ChannelIntro abilities={reader} canInvite={false} channel={view()} createdAt={CREATED} creatorName="Linh" />)

    const intro = screen.getByRole('region', { name: 'This is the start of #ops' })
    expect(within(intro).getByRole('heading', { name: 'ops' })).toBeTruthy()
    expect(within(intro).getByText('Day-to-day operations and on-call handoffs')).toBeTruthy()
    expect(within(intro).getByText('Linh created this channel on November 3, 2026.')).toBeTruthy()
    // A reader of a described channel has nothing to do here.
    expect(within(intro).queryByRole('button')).toBeNull()
  })

  it('says only when when the maker is unknown, and nothing of either when the room’s date is unknown', () => {
    mount(<ChannelIntro abilities={reader} canInvite={false} channel={view()} createdAt={CREATED} />)
    expect(screen.getByText('Created on November 3, 2026.')).toBeTruthy()
    cleanup()

    const { container } = mount(<ChannelIntro abilities={reader} canInvite={false} channel={view()} creatorName="Linh" />)
    expect(container.querySelector('[data-matrix-channel-intro-made]')).toBeNull()
  })

  it('offers an editor of an undescribed channel to add a description, opening details on that field', () => {
    const { container } = mount(<ChannelIntro abilities={editor} canInvite={false} channel={view({ purpose: '' })} createdAt={CREATED} />)

    expect(container.querySelector('[data-matrix-channel-intro-description]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add a description' }))
    expect($teamSpaceIntent.get()?.intent).toEqual({ kind: 'channel-details', channelId: CHANNEL_IDS.ops, field: 'purpose' })
  })

  it('offers a member who may not edit nothing about the description, even when there is none', () => {
    const { container } = mount(<ChannelIntro abilities={reader} canInvite={false} channel={view({ purpose: '' })} />)

    expect(screen.queryByRole('button', { name: 'Add a description' })).toBeNull()
    expect(container.querySelector('[data-matrix-channel-intro-description]')).toBeNull()
  })

  it('never offers to add a description that is already there', () => {
    mount(<ChannelIntro abilities={editor} canInvite={false} channel={view()} />)
    expect(screen.queryByRole('button', { name: 'Add a description' })).toBeNull()
  })

  it('adds people to a private channel, and invites teammates to a public one', () => {
    mount(
      <ChannelIntro abilities={{ addPeople: true, edit: true }} canInvite channel={view({ visibility: 'private', purpose: '' })} emphasis />
    )

    const add = screen.getByRole('button', { name: 'Add people' })
    // The empty channel's first step is the view's one primary.
    expect(add.className).toContain('ak-btn--primary')
    expect(screen.getByRole('button', { name: 'Add a description' }).className).not.toContain('ak-btn--primary')
    expect(screen.queryByRole('button', { name: 'Invite teammates' })).toBeNull()
    fireEvent.click(add)
    expect($teamSpaceIntent.get()?.intent).toEqual({ kind: 'add-people', channelId: CHANNEL_IDS.ops })
    cleanup()

    mount(<ChannelIntro abilities={reader} canInvite channel={view()} />)
    const invite = screen.getByRole('button', { name: 'Invite teammates' })
    // Above a history the intro stays quiet.
    expect(invite.className).not.toContain('ak-btn--primary')
    fireEvent.click(invite)
    expect($teamSpaceIntent.get()?.intent).toEqual({ kind: 'invite-members' })
  })

  it('offers nothing in an archived channel', () => {
    mount(<ChannelIntro abilities={{ addPeople: true, edit: true }} canInvite channel={view({ state: 'archived', purpose: '' })} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows a long description whole: the intro is where it is read in full', () => {
    const long = 'Launch '.repeat(71).trim().slice(0, 500)
    const { container } = mount(<ChannelIntro abilities={reader} canInvite={false} channel={view({ purpose: long })} />)

    const shown = container.querySelector('[data-matrix-channel-intro-description]')!
    expect(shown.textContent).toBe(long)
    expect(shown.className).not.toContain('truncate')
  })

  it('gives the default channel its localized name and description until an admin writes one', () => {
    const general = view({ id: CHANNEL_IDS.general, displayName: 'general', systemKey: 'default', purpose: '' })
    mount(<ChannelIntro abilities={editor} canInvite={false} channel={general} />, 'vi')

    expect(screen.getByRole('heading', { name: 'chung' })).toBeTruthy()
    expect(screen.getByText(matrixTeamSpaceCopy('vi').defaultChannelPurpose)).toBeTruthy()
    expect(screen.queryByRole('button', { name: matrixTeamSpaceCopy('vi').addDescription })).toBeNull()
    cleanup()

    mount(<ChannelIntro abilities={editor} canInvite={false} channel={{ ...general, purpose: 'Tin của Demoza' }} />, 'vi')
    expect(screen.getByText('Tin của Demoza')).toBeTruthy()
  })
})

describe('the intro in every locale', () => {
  it.each(DESKTOP_LOCALES)('%s has its own words for the intro, its actions and the description field', locale => {
    const team = matrixTeamSpaceCopy(locale)
    const english = matrixTeamSpaceCopy('en')

    for (const value of [team.addDescription, team.channelPurposePlaceholder, team.defaultChannelPurpose, team.channelPurposeLabel]) {
      expect(value.trim().length).toBeGreaterThan(0)
    }

    expect(team.channelCreatedBy('Linh', 'D8')).toContain('Linh')
    expect(team.channelCreatedBy('Linh', 'D8')).toContain('D8')
    expect(team.channelCreatedOn('D8')).toContain('D8')

    if (locale !== 'en') {
      expect(team.addDescription).not.toBe(english.addDescription)
      expect(team.defaultChannelPurpose).not.toBe(english.defaultChannelPurpose)
    }

    const general = view({ id: CHANNEL_IDS.general, displayName: 'general', systemKey: 'default', purpose: '' })
    const { container } = mount(<ChannelIntro abilities={reader} canInvite={false} channel={general} createdAt={CREATED} creatorName="Linh" />, locale)

    expect(screen.getByRole('region', { name: team.channelStartTitle(matrixCompanyCopy(locale).defaultChannelName) })).toBeTruthy()
    expect(screen.getByText(team.defaultChannelPurpose)).toBeTruthy()
    expect(container.querySelector('[data-matrix-channel-intro-made]')!.textContent).toContain('Linh')
  })
})

describe('the channel header’s line', () => {
  it('shows the description when there is no topic, on one line that opens Channel details', () => {
    mount(<ChannelHeaderMeta channel={view()} />)

    const line = screen.getByRole('button', { name: 'Day-to-day operations and on-call handoffs' })
    expect(line.className).toContain('truncate')
    fireEvent.click(line)
    expect($teamSpaceIntent.get()?.intent).toEqual({ kind: 'channel-details', channelId: CHANNEL_IDS.ops })
  })

  it('prefers the topic, and draws no line for a channel with neither', () => {
    mount(<ChannelHeaderMeta channel={view({ topic: 'Freeze until Friday' })} />)
    expect(screen.getByRole('button', { name: 'Freeze until Friday' })).toBeTruthy()
    expect(screen.queryByText('Day-to-day operations and on-call handoffs')).toBeNull()
    cleanup()

    const { container } = mount(<ChannelHeaderMeta channel={view({ purpose: '' })} />)
    expect(container.querySelector('[data-matrix-channel-topic]')).toBeNull()
  })

  it('keeps a long description to one truncated line', () => {
    const long = 'Everything about the spring launch, '.repeat(13).trim()
    const { container } = mount(<ChannelHeaderMeta channel={view({ purpose: long })} />)

    const line = container.querySelector('[data-matrix-channel-topic]')!
    expect(line.textContent).toBe(long)
    expect(line.className).toContain('truncate')
    expect(line.className).toContain('min-w-0')
  })

  it('reads the default channel’s localized description', () => {
    mount(<ChannelHeaderMeta channel={view({ systemKey: 'default', purpose: '' })} />, 'ja')
    expect(screen.getByRole('button', { name: matrixTeamSpaceCopy('ja').defaultChannelPurpose })).toBeTruthy()
  })

  it('is the same description everywhere: stored first, else the default channel’s line, else none', () => {
    const team = matrixTeamSpaceCopy('en')
    expect(channelDescription({ purpose: '  Plans  ' }, team)).toBe('Plans')
    expect(channelDescription({ purpose: '', systemKey: 'default' }, team)).toBe(team.defaultChannelPurpose)
    expect(channelDescription({ purpose: '' }, team)).toBe('')
  })
})

describe('the open channel’s intro', () => {
  const KEY = 'acct'
  const key = teamSpaceKey(KEY, COMPANY_ID)

  const roster = (members: Array<{ memberRef: string; displayName: string | null; handle: string | null }>): MatrixCompanyResult => ({
    ok: true,
    value: {
      schemaVersion: 2,
      company: { id: COMPANY_ID, displayName: 'Demoza' },
      members: members.map(member => ({ ...member, role: 'member', state: 'active', self: false })),
      projects: [],
      defaultChannelId: null
    }
  }) as unknown as MatrixCompanyResult

  function discover() {
    $teamSpaceDiscovery.set({ accountKey: KEY, discovery: { state: 'discovered', capabilities: capabilities('full') } })
  }

  it('names its maker from the company roster and dates it by the room', async () => {
    const request = vi.fn(async () => roster([{ memberRef: REFS.owner, displayName: 'Linh', handle: 'linh' }]))
    discover()
    $companyChannels.setKey(key, { wire: '1.4', channels: [view()], loading: false })
    mount(<ChannelIntroFor accountKey={KEY} bridge={{ request }} room={channelRoom(CHANNEL_IDS.ops, 'ops', { createdAt: CREATED })} />)

    expect(await screen.findByText('Linh created this channel on November 3, 2026.')).toBeTruthy()
    expect(request).toHaveBeenCalledWith({ action: 'read', companyId: COMPANY_ID })
  })

  it('draws nothing until the platform’s directory names the channel', () => {
    discover()
    const { container } = mount(<ChannelIntroFor accountKey={KEY} bridge={{ request: vi.fn() }} room={channelRoom(CHANNEL_IDS.ops, 'ops')} />)
    expect(container.textContent).toBe('')
    act(() => $companyChannels.setKey(key, { wire: '1.4', channels: [view()], loading: false }))
    expect(screen.getByText('Day-to-day operations and on-call handoffs')).toBeTruthy()
  })

  it('reads a roster once for every intro, and again only for someone it does not have yet', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(roster([{ memberRef: REFS.owner, displayName: 'Linh', handle: null }]))
      .mockResolvedValueOnce(roster([
        { memberRef: REFS.owner, displayName: 'Linh', handle: null },
        { memberRef: REFS.member, displayName: null, handle: 'minh' }
      ]))

    expect(await companyMemberName({ request }, KEY, COMPANY_ID, REFS.owner)).toBe('Linh')
    expect(await companyMemberName({ request }, KEY, COMPANY_ID, REFS.owner)).toBe('Linh')
    expect(request).toHaveBeenCalledTimes(1)
    expect(await companyMemberName({ request }, KEY, COMPANY_ID, REFS.member)).toBe('@minh')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('leaves the maker unnamed when the roster has no name for them or cannot be read', async () => {
    const failing = vi.fn(async () => ({ ok: false, error: 'unavailable' }) as unknown as MatrixCompanyResult)
    expect(await companyMemberName({ request: failing }, KEY, COMPANY_ID, REFS.owner).catch(() => undefined)).toBeUndefined()

    const nameless = vi.fn(async () => roster([{ memberRef: REFS.owner, displayName: null, handle: null }]))
    expect(await companyMemberName({ request: nameless }, 'other', COMPANY_ID, REFS.owner)).toBeUndefined()
  })
})

describe('creating a channel', () => {
  const abilities = { createChannel: true, createPrivateChannel: false, creationBlocked: 'none' as const }

  it('asks for a description with an example, and creates without one', async () => {
    const mutate = vi.fn(async () => ({ ok: true as const, value: { channelId: CHANNEL_IDS.ops } }))
    mount(<ChannelCreateDialog abilities={abilities} bridge={{} as never} channels={[]} companyId={COMPANY_ID} mutate={mutate as never} onChanged={() => {}} onClose={() => {}} onCreated={() => {}} open roster={[]} />)

    const description = screen.getByLabelText('Description') as HTMLInputElement
    expect(description.placeholder).toBe(matrixTeamSpaceCopy('en').channelPurposePlaceholder)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ops' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create channel' }))

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
    expect(JSON.stringify(mutate.mock.calls[0])).not.toContain('purpose')
  })

  it('will not send a description over 500 characters', () => {
    mount(<ChannelCreateDialog abilities={abilities} bridge={{} as never} channels={[]} companyId={COMPANY_ID} mutate={vi.fn()} onChanged={() => {}} onClose={() => {}} onCreated={() => {}} open roster={[]} />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ops' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'x'.repeat(501) } })
    expect(screen.getByRole('button', { name: 'Create channel' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'x'.repeat(500) } })
    expect(screen.getByRole('button', { name: 'Create channel' }).hasAttribute('disabled')).toBe(false)
  })

  it('still creates a public channel with its people where the company has no private channels', async () => {
    const mutate = vi.fn(async () => ({ ok: true as const, value: { schemaVersion: 6, operation: 'create', channelId: CHANNEL_IDS.ops,
      authorityGeneration: 8, channelGeneration: 1, replayed: false,
      admissions: [REFS.owner, REFS.member].map(memberRef => ({ memberRef, state: 'active', admissionEpoch: 1, admissionGeneration: 1 })) } }))

    const onClose = vi.fn()

    const roster = [
      { memberRef: REFS.owner, role: 'owner' as const, state: 'active' as const, self: true, handle: 'an', displayName: 'An' },
      { memberRef: REFS.member, role: 'member' as const, state: 'active' as const, self: false, handle: 'lan', displayName: 'Lan' }
    ]

    mount(<ChannelCreateDialog abilities={abilities} bridge={{} as never} channels={[]} companyId={COMPANY_ID} mutate={mutate as never} onChanged={() => {}} onClose={onClose} onCreated={() => {}} open roster={roster} />)

    // No Public/Private choice to make, but the people are still asked for.
    expect(screen.queryByRole('radio', { name: 'Private' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ops' } })
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Add people' })).getByRole('option', { name: /Lan/u }))
    fireEvent.click(screen.getByRole('button', { name: 'Create channel' }))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'channel-command',
      command: expect.objectContaining({ operation: 'create', visibility: 'public', initialMemberRefs: [REFS.member] })
    }))
  })

  it.each(DESKTOP_LOCALES)('%s labels and exemplifies the description field', locale => {
    const team = matrixTeamSpaceCopy(locale)
    mount(<ChannelCreateDialog abilities={abilities} bridge={{} as never} channels={[]} companyId={COMPANY_ID} mutate={vi.fn()} onChanged={() => {}} onClose={() => {}} onCreated={() => {}} open roster={[]} />, locale)

    expect((screen.getByLabelText(team.channelPurposeLabel) as HTMLInputElement).placeholder).toBe(team.channelPurposePlaceholder)
  })
})

describe('editing the description later', () => {
  const details = (over: Partial<Parameters<typeof ChannelDetailsDialog>[0]> = {}) => (
    <ChannelDetailsDialog
      abilities={{ edit: true }}
      bridge={{} as never}
      channel={view({ purpose: '' })}
      companyId={COMPANY_ID}
      mutate={vi.fn()}
      onChanged={() => {}}
      onClose={() => {}}
      open
      {...over}
    />
  )

  it('opens on the description when the intro asked for it, and on the name otherwise', async () => {
    mount(details({ focusField: 'purpose' }))
    await waitFor(() => expect(screen.getByRole('dialog').ownerDocument.activeElement).toBe(screen.getByLabelText('Description')))
    cleanup()

    mount(details())
    await waitFor(() => expect(screen.getByRole('dialog').ownerDocument.activeElement).toBe(screen.getByLabelText('Name')))
  })

  it('shows a reader the description, the default channel’s included, with nothing to edit', () => {
    mount(details({ abilities: NO_CHANNEL_ABILITIES, channel: view({ systemKey: 'default', purpose: '' }) }))

    expect(screen.getByText(matrixTeamSpaceCopy('en').defaultChannelPurpose)).toBeTruthy()
    expect(screen.queryByLabelText('Description')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
  })

  it('shows the default channel’s line as the example an admin writes over', () => {
    mount(details({ channel: view({ systemKey: 'default', purpose: '' }) }))
    expect((screen.getByLabelText('Description') as HTMLInputElement).placeholder).toBe(matrixTeamSpaceCopy('en').defaultChannelPurpose)
  })
})

describe('where a channel’s history starts', () => {
  const events = (...types: string[]) => types.map(type => ({ getType: () => type }))

  it('starts at the room’s creation, or where the server has nothing older', () => {
    expect(timelineReachesStart(events('m.room.create', 'm.room.member', 'm.room.message'), 200, 'token')).toBe(true)
    expect(timelineReachesStart(events('m.room.member', 'm.room.message'), 200, null)).toBe(true)
    expect(timelineReachesStart([], 200, null)).toBe(true)
  })

  it('does not start while older pages remain or the renderer’s window hides some of what is loaded', () => {
    expect(timelineReachesStart(events('m.room.member', 'm.room.message'), 200, 'token')).toBe(false)
    expect(timelineReachesStart(events('m.room.create', 'm.room.member', 'm.room.message'), 2, null)).toBe(false)
  })
})
