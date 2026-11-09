import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'

import { ArchivedChannelBanner, ChannelGlyph, ChannelHeaderMeta, ChannelHeaderMetaFor, ChannelTitleFor } from './channel-chrome'
import { $companyChannels } from './channels-store'
import { $teamSpaceDiscovery, clearTeamSpaceDiscovery } from './discovery-store'
import { $teamSpaceIntent } from './intents'
import { teamSpaceKey } from './keys'
import { $companyStanding } from './standing-store'
import { capabilities, CHANNEL_IDS, channelRoom, COMPANY_ID, REFS } from './test-support'
import { useCompanyChannelFacts } from './use-channel-facts'
import { type CompanyChannelView } from './views'

afterEach(cleanup)

beforeEach(() => {
  clearTeamSpaceDiscovery()
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
  topic: 'Day to day',
  purpose: '',
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

const mount = (node: React.ReactNode) => render(<I18nProvider configClient={null} initialLocale="en">{node}</I18nProvider>)

describe('channel header pieces', () => {
  it('marks a private channel with a lock the screen reader hears, and a public one with a quiet hash', () => {
    mount(<><ChannelGlyph channel={view({ visibility: 'private' })} /></>)
    expect(screen.getByRole('img', { name: 'Private channel' })).toBeTruthy()
    cleanup()
    mount(<ChannelGlyph channel={view()} />)
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('shows the topic beside the name and nothing else there (Atum Kit: people sit with search)', () => {
    const general = view({ systemKey: 'default', memberCount: 7 })
    mount(<ChannelHeaderMeta channel={general} />)

    // The line itself is the only control: it opens Channel details, where the whole of it is.
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['Day to day'])
    fireEvent.click(screen.getByRole('button', { name: 'Day to day' }))
    expect($teamSpaceIntent.get()?.intent).toEqual({ kind: 'channel-details', channelId: CHANNEL_IDS.ops })
  })

  it('says a channel is private to assistive technology and shows nothing for a 1.1 channel', () => {
    mount(<ChannelHeaderMeta channel={view({ visibility: 'private' })} />)
    expect(screen.getByText('Private channel').className).toContain('sr-only')
    cleanup()
    const { container } = mount(<ChannelHeaderMeta channel={view({ wire: '1.1', actions: null })} />)
    expect(container.textContent).toBe('')
  })

  it('tells an archived channel it is read-only and offers its way back only to those who may', () => {
    mount(<ArchivedChannelBanner abilities={{ restore: true }} channel={view({ state: 'archived' })} />)

    expect(screen.getByText('Archived: read-only until an admin restores it.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Restore channel' }))
    expect($teamSpaceIntent.get()?.intent).toEqual({ kind: 'restore-channel', channelId: CHANNEL_IDS.ops })
    cleanup()
    mount(<ArchivedChannelBanner abilities={{ restore: false }} channel={view({ state: 'archived' })} />)
    expect(screen.queryByRole('button', { name: 'Restore channel' })).toBeNull()
  })
})

describe('the open channel’s facts', () => {
  const KEY = 'acct'
  const key = teamSpaceKey(KEY, COMPANY_ID)

  function Facts() {
    const { abilities, channel } = useCompanyChannelFacts(KEY, channelRoom(CHANNEL_IDS.ops, 'ops'))

    return <p data-testid="facts">{JSON.stringify({ channel: channel?.displayName ?? null, leave: abilities.leave, edit: abilities.edit })}</p>
  }

  const facts = () => JSON.parse(screen.getByTestId('facts').textContent!) as { channel: string | null; leave: boolean; edit: boolean }

  function discover(channels: 'active' | 'inactive') {
    $teamSpaceDiscovery.set({ accountKey: KEY, discovery: { state: 'discovered', capabilities: {
      ...capabilities('full'), activation: { ...capabilities('full').activation, channelAdmission: channels } } } })
  }

  it('reads the platform’s record and what the viewer may do in it', () => {
    discover('active')
    $companyChannels.setKey(key, { wire: '1.4', channels: [view()], loading: false })
    mount(<Facts />)

    expect(facts()).toEqual({ channel: 'ops', leave: true, edit: true })
  })

  // Atum Kit board: the header carries the name and topic only; inviting and adding channels live in
  // the company menu, the members panel and the sidebar, so moderator standing never adds buttons here.
  it('keeps the #general header to its name and topic when the workspace publishes moderator standing', () => {
    const general = view({ id: CHANNEL_IDS.general, displayName: 'general', room: { state: 'ready', roomId: '!general:atum.example' },
      systemKey: 'default' })
    const room = channelRoom(CHANNEL_IDS.general, 'general')

    discover('active')
    $companyChannels.setKey(key, { wire: '1.4', channels: [general], loading: false })
    mount(<><ChannelTitleFor accountKey={KEY} fallback="general" room={room} /><ChannelHeaderMetaFor accountKey={KEY} room={room} /></>)
    expect(screen.getByText('general')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Invite members' })).toBeNull()

    act(() => $companyStanding.setKey(key, { role: 'admin', policy: 'members' }))
    expect(screen.getByText('general')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Invite members' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add channel' })).toBeNull()
  })

  it('never draws from a directory read on another wire than discovery selects', () => {
    $companyChannels.setKey(key, { wire: '1.4', channels: [view({ visibility: 'private' })], loading: false })
    discover('inactive')
    mount(<Facts />)

    // A private channel's record is not used while the 1.1 wire is selected: no name, no actions.
    expect(facts()).toEqual({ channel: null, leave: false, edit: false })
    act(() => discover('active'))
    expect(facts().channel).toBe('ops')
  })

  it('has nothing for a room the directory does not list', () => {
    discover('active')
    mount(<Facts />)

    expect(facts()).toEqual({ channel: null, leave: false, edit: false })
  })
})

describe('whether the platform has archived the open channel', () => {
  const KEY = 'acct'
  const key = teamSpaceKey(KEY, COMPANY_ID)

  function Archived({ company = true }: { company?: boolean }) {
    const facts = useCompanyChannelFacts(KEY, company ? channelRoom(CHANNEL_IDS.ops, 'ops') : { companyChannel: undefined })

    return (
      <>
        <p data-testid="archived">{String(facts.archived)}</p>
        <p data-testid="state">{facts.state}</p>
      </>
    )
  }

  const archived = () => screen.getByTestId('archived').textContent
  const state = () => screen.getByTestId('state').textContent

  function discover(channels: 'active' | 'inactive') {
    $teamSpaceDiscovery.set({ accountKey: KEY, discovery: { state: 'discovered', capabilities: {
      ...capabilities('full'), activation: { ...capabilities('full').activation, channelAdmission: channels } } } })
  }

  it('is the platform’s record, on either wire, and follows it when the channel is archived and restored', () => {
    discover('active')
    $companyChannels.setKey(key, { wire: '1.4', channels: [view()], loading: false })
    mount(<Archived />)
    expect(archived()).toBe('false')

    expect(state()).toBe('active')

    act(() => $companyChannels.setKey(key, { wire: '1.4', channels: [view({ state: 'archived' })], loading: false }))
    expect(archived()).toBe('true')
    expect(state()).toBe('archived')

    act(() => $companyChannels.setKey(key, { wire: '1.4', channels: [view({ state: 'active' })], loading: false }))
    expect(archived()).toBe('false')
    expect(state()).toBe('active')

    act(() => discover('inactive'))
    act(() => $companyChannels.setKey(key, { wire: '1.1', channels: [view({ state: 'archived', wire: '1.1', actions: null })], loading: false }))
    expect(archived()).toBe('true')
  })

  it('claims nothing it does not know: no record, another wire’s record, or a room that is no company channel', () => {
    discover('active')
    mount(<Archived />)
    expect(archived()).toBe('false')

    // An archived record read on the wire discovery no longer selects is not drawn from.
    act(() => $companyChannels.setKey(key, { wire: '1.1', channels: [view({ state: 'archived', wire: '1.1', actions: null })], loading: false }))
    expect(archived()).toBe('false')

    cleanup()
    mount(<Archived company={false} />)
    expect(archived()).toBe('false')
    expect(state()).toBe('active')
  })

  it('is unknown, not active, for a company channel until the matching-wire directory is read', () => {
    discover('active')
    mount(<Archived />)
    expect(state()).toBe('unknown')

    // Still unknown while only another wire’s directory is held, or the read failed.
    act(() => $companyChannels.setKey(key, { wire: '1.1', channels: [view({ wire: '1.1', actions: null })], loading: false }))
    expect(state()).toBe('unknown')
    act(() => $companyChannels.setKey(key, { channels: [], loading: false, error: 'unavailable' }))
    expect(state()).toBe('unknown')

    act(() => $companyChannels.setKey(key, { wire: '1.4', channels: [view()], loading: false }))
    expect(state()).toBe('active')
  })
})

describe('where a file may be attached', () => {
  const KEY = 'acct'
  const key = teamSpaceKey(KEY, COMPANY_ID)

  function Attach({ company = true }: { company?: boolean }) {
    const facts = useCompanyChannelFacts(KEY, company ? channelRoom(CHANNEL_IDS.ops, 'ops') : { companyChannel: undefined })

    return <p data-testid="attach">{String(facts.attachments)}</p>
  }

  const allowed = () => screen.getByTestId('attach').textContent

  function discover(channels: 'active' | 'inactive') {
    $teamSpaceDiscovery.set({ accountKey: KEY, discovery: { state: 'discovered', capabilities: {
      ...capabilities('full'), activation: { ...capabilities('full').activation, channelAdmission: channels } } } })
  }

  it('is open for a room that is no company channel', () => {
    discover('active')
    mount(<Attach company={false} />)
    expect(allowed()).toBe('true')
  })

  it('is open in public and private channels only after exact admission is authoritative', () => {
    discover('active')
    $companyChannels.setKey(key, { wire: '1.4', channels: [view()], loading: false })
    mount(<Attach />)
    expect(allowed()).toBe('true')

    act(() => $companyChannels.setKey(key, { wire: '1.4', channels: [view({ visibility: 'private' })], loading: false }))
    expect(allowed()).toBe('true')
  })

  it('stays closed until the directory says the channel is public: unknown is not public', () => {
    discover('active')
    mount(<Attach />)
    expect(allowed()).toBe('false')
  })

  it('is open before channel admission exists, when no channel can be private', () => {
    mount(<Attach />)
    expect(allowed()).toBe('true')
  })
})
