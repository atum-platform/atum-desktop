import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MatrixCompanyBridge, MatrixCompanyRequest, MatrixCompanyResult } from '../../../shared/matrix-company'

import { $companyAdmin, clearCompanyAdmin, loadCompanyAdmin } from './admin-store'
import { $companyChannels, channelViewForRoom, clearCompanyChannels, loadCompanyChannels } from './channels-store'
import {
  $teamSpaceDiscovery,
  clearTeamSpaceDiscovery,
  currentTeamSpaceProfile,
  loadJoinableChannelBrowse,
  loadTeamSpaceDiscovery
} from './discovery-store'
import { teamSpaceKey } from './keys'

const companyId = '00000000-0000-4000-8000-3f27f2fc4915'
const channelId = '00000000-0000-4000-8000-f19cafd05964'
const privateId = '00000000-0000-4000-8000-be9a925bf429'
const ref = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE'

const capabilities = (channels: 'active' | 'inactive' = 'active') => ({
  schemaVersion: 4 as const,
  wireVersion: '1.3' as const,
  supportedWireVersions: ['1', '1.1', '1.2', '1.3', '1.4'] as ('1' | '1.1' | '1.2' | '1.3' | '1.4')[],
  features: { ownership: true as const, invitationLifecycle: true as const, capabilityDiscovery: true as const,
    channelAdmission: true, companyConversations: false },
  activation: { teamAdmin: 'active' as const, channelAdmission: channels, companyConversations: 'inactive' as const },
  controller: { roomReconciliation: 'ready' as const }
})

const admitted = (id: string, name: string, visibility: 'public' | 'private') => ({
  schemaVersion: 5 as const,
  channel: { id, companyId, displayName: name, visibility, topic: '', purpose: '', state: 'active' as const,
    ownerMemberRef: ref, authorityGeneration: 1, channelGeneration: 2, metadataRevision: 1 },
  selfAdmission: { memberRef: ref, state: 'active' as const, admissionEpoch: 1, admissionGeneration: 1 },
  memberCount: 2,
  room: { state: 'ready' as const, roomId: `!${name}:x` },
  actions: [] as never[]
})

const legacyDirectory = () => ({
  schemaVersion: 2 as const,
  channels: [{
    schemaVersion: 2 as const,
    channel: { id: channelId, companyId, displayName: 'general', visibility: 'company' as const, state: 'active' as const,
      projectId: null, authorityGeneration: 1, channelGeneration: 1, systemKey: 'default' as const },
    memberCount: 2,
    room: { state: 'ready' as const, roomId: '!general:x' }
  }]
})

type Answer = MatrixCompanyResult | Promise<MatrixCompanyResult>

function bridge(answer: (input: MatrixCompanyRequest) => Answer) {
  const request = vi.fn(async (input: MatrixCompanyRequest) => answer(input))

  return { request, pending: vi.fn(async () => ({ ok: true as const, request: null })) } as unknown as MatrixCompanyBridge & {
    request: ReturnType<typeof vi.fn>
  }
}

beforeEach(() => {
  window.localStorage.clear()
  clearTeamSpaceDiscovery()
  clearCompanyAdmin('a')
  clearCompanyChannels('a')
})

afterEach(() => vi.useRealTimers())

describe('discovery', () => {
  it('keeps the server’s answer, and asks once for concurrent callers', async () => {
    const source = bridge(() => ({ ok: true, value: capabilities() }))

    await Promise.all([loadTeamSpaceDiscovery(source, 'a'), loadTeamSpaceDiscovery(source, 'a')])

    expect(source.request).toHaveBeenCalledTimes(1)
    expect(currentTeamSpaceProfile('a')).toEqual({ admin: true, channels: true, rooms: true, conversations: false })
    // Settled and discovered: a second entry does not ask again unless it is forced.
    await loadTeamSpaceDiscovery(source, 'a')
    expect(source.request).toHaveBeenCalledTimes(1)
    await loadTeamSpaceDiscovery(source, 'a', { force: true })
    expect(source.request).toHaveBeenCalledTimes(2)
  })

  it('caches a joinable browse, while a forced click-time read asks the platform again', async () => {
    const answer = { schemaVersion: 7 as const, channels: [] }
    const source = bridge(() => ({ ok: true, value: answer }))

    await Promise.all([
      loadJoinableChannelBrowse(source, 'a', companyId),
      loadJoinableChannelBrowse(source, 'a', companyId)
    ])
    expect(source.request).toHaveBeenCalledTimes(1)

    await loadJoinableChannelBrowse(source, 'a', companyId)
    expect(source.request).toHaveBeenCalledTimes(1)

    await loadJoinableChannelBrowse(source, 'a', companyId, { force: true })
    expect(source.request).toHaveBeenCalledTimes(2)
    expect(source.request).toHaveBeenLastCalledWith({ action: 'browse-joinable-channels', companyId })

    clearTeamSpaceDiscovery()
    await loadJoinableChannelBrowse(source, 'a', companyId)
    expect(source.request).toHaveBeenCalledTimes(3)
  })

  it.each(['missing', 'invalid'] as const)('a server answering %s predates discovery: C1/C2 are off', async error => {
    await loadTeamSpaceDiscovery(bridge(() => ({ ok: false, error })), 'a')

    expect($teamSpaceDiscovery.get()?.discovery.state).toBe('legacy')
    expect(currentTeamSpaceProfile('a')).toEqual({ admin: false, channels: false, rooms: false, conversations: false })
  })

  it('an older host that answers with some other wire is a server without discovery', async () => {
    await loadTeamSpaceDiscovery(bridge(() => ({ ok: true, value: { schemaVersion: 2, companies: [], invitations: [], canCreate: true } })), 'a')

    expect($teamSpaceDiscovery.get()?.discovery.state).toBe('legacy')
  })

  it('a failed refresh neither takes features away nor invents them', async () => {
    const answers: MatrixCompanyResult[] = [
      { ok: true, value: capabilities() },
      { ok: false, error: 'unavailable' },
      { ok: false, error: 'authentication' }
    ]

    const source = bridge(() => answers.shift()!)

    await loadTeamSpaceDiscovery(source, 'a')
    await loadTeamSpaceDiscovery(source, 'a', { force: true })
    await loadTeamSpaceDiscovery(source, 'a', { force: true })

    expect(currentTeamSpaceProfile('a').channels).toBe(true)

    clearTeamSpaceDiscovery()
    await loadTeamSpaceDiscovery(bridge(() => ({ ok: false, error: 'unavailable' })), 'a')
    // Before a first answer a failure reads as unknown, which gates like legacy and is asked again.
    expect($teamSpaceDiscovery.get()?.discovery.state).toBe('unknown')
    expect(currentTeamSpaceProfile('a')).toEqual({ admin: false, channels: false, rooms: false, conversations: false })
  })

  it('never shows one account’s discovery for another', async () => {
    await loadTeamSpaceDiscovery(bridge(() => ({ ok: true, value: capabilities() })), 'a')

    expect(currentTeamSpaceProfile('a').channels).toBe(true)
    expect(currentTeamSpaceProfile('b')).toEqual({ admin: false, channels: false, rooms: false, conversations: false })
  })

  it('drops a late answer for an account that has since been replaced', async () => {
    let release!: (value: MatrixCompanyResult) => void
    const slow = bridge(() => new Promise<MatrixCompanyResult>(resolve => { release = resolve }))
    const late = loadTeamSpaceDiscovery(slow, 'a')

    await loadTeamSpaceDiscovery(bridge(() => ({ ok: true, value: capabilities('inactive') })), 'b')
    release({ ok: true, value: capabilities() })
    await late

    expect($teamSpaceDiscovery.get()?.accountKey).toBe('b')
    expect(currentTeamSpaceProfile('b').channels).toBe(false)
  })
})

const adminSnapshot = (role: 'owner' | 'admin' | 'member' = 'owner') => ({
  schemaVersion: 4 as const,
  company: { id: companyId, displayName: 'Atum', role, ownerMemberRef: ref, authorityGeneration: 7,
    policy: { channelCreation: 'members' as const } },
  members: [{ memberRef: ref, role: 'owner' as const, state: 'active' as const, admissionEpoch: 1 }],
  invitations: []
})

describe('administration snapshot', () => {
  const key = teamSpaceKey('a', companyId)

  it('keeps the newest read and ignores a slower, older one', async () => {
    const releases: Array<(value: MatrixCompanyResult) => void> = []
    const source = bridge(() => new Promise<MatrixCompanyResult>(resolve => releases.push(resolve)))
    const first = loadCompanyAdmin(source, 'a', companyId)
    const second = loadCompanyAdmin(source, 'a', companyId)

    releases[1]!({ ok: true, value: adminSnapshot('owner') })
    releases[0]!({ ok: true, value: adminSnapshot('member') })
    await Promise.all([first, second])

    expect($companyAdmin.get()[key]?.snapshot?.company.role).toBe('owner')
  })

  it('a quiet failure keeps what is on screen; losing access clears it either way', async () => {
    await loadCompanyAdmin(bridge(() => ({ ok: true, value: adminSnapshot() })), 'a', companyId)
    await loadCompanyAdmin(bridge(() => ({ ok: false, error: 'unavailable' })), 'a', companyId, { quiet: true })

    expect($companyAdmin.get()[key]).toMatchObject({ snapshot: { company: { role: 'owner' } }, loading: false })
    expect($companyAdmin.get()[key]?.error).toBeUndefined()

    await loadCompanyAdmin(bridge(() => ({ ok: false, error: 'unavailable' })), 'a', companyId)
    expect($companyAdmin.get()[key]).toMatchObject({ snapshot: { company: { role: 'owner' } }, error: 'unavailable' })

    await loadCompanyAdmin(bridge(() => ({ ok: false, error: 'denied' })), 'a', companyId, { quiet: true })
    expect($companyAdmin.get()[key]?.snapshot).toBeUndefined()
  })

  it('clears one company or a whole account', async () => {
    const source = bridge(() => ({ ok: true, value: adminSnapshot() }))
    await loadCompanyAdmin(source, 'a', companyId)
    await loadCompanyAdmin(source, 'b', companyId)

    clearCompanyAdmin('a')
    expect(Object.keys($companyAdmin.get())).toEqual([teamSpaceKey('b', companyId)])
    clearCompanyAdmin('b', companyId)
    expect($companyAdmin.get()).toEqual({})
  })
})

describe('channel directory', () => {
  const key = teamSpaceKey('a', companyId)

  it('reads the admitted directory when channel admission is active, private channels included', async () => {
    const source = bridge(input =>
      input.action === 'admitted-channels'
        ? { ok: true, value: { schemaVersion: 5, channels: [admitted(channelId, 'general', 'public'), admitted(privateId, 'leadership', 'private')] } }
        : { ok: false, error: 'missing' }
    )

    const state = await loadCompanyChannels(source, 'a', companyId, { channels: true })

    expect(source.request).toHaveBeenCalledTimes(1)
    expect(state.wire).toBe('1.4')
    expect(state.channels.map(channel => [channel.displayName, channel.visibility])).toEqual([
      ['general', 'public'],
      ['leadership', 'private']
    ])
    expect($companyChannels.get()[key]).toBe(state)
  })

  it('reads the 1.1 company-wide directory otherwise, as public channels', async () => {
    const source = bridge(input =>
      input.action === 'list-channels' ? { ok: true, value: legacyDirectory() } : { ok: false, error: 'missing' }
    )

    const state = await loadCompanyChannels(source, 'a', companyId, { channels: false })

    expect(source.request).toHaveBeenCalledWith({ action: 'list-channels', companyId })
    expect(state).toMatchObject({ wire: '1.1', channels: [{ displayName: 'general', visibility: 'public', systemKey: 'default' }] })
  })

  it('replaces a directory wholesale: a private channel that left the answer leaves the screen', async () => {
    await loadCompanyChannels(
      bridge(() => ({ ok: true, value: { schemaVersion: 5, channels: [admitted(privateId, 'leadership', 'private')] } })),
      'a', companyId, { channels: true }
    )
    expect($companyChannels.get()[key]?.channels).toHaveLength(1)

    // Channel admission switched off: the 1.1 directory lists admitted public channels only.
    await loadCompanyChannels(bridge(() => ({ ok: true, value: legacyDirectory() })), 'a', companyId, { channels: false })

    expect($companyChannels.get()[key]?.channels.map(channel => channel.displayName)).toEqual(['general'])
  })

  it('marks a quiet transient read stale, but an explicit denial evicts rows and stays visible', async () => {
    const good = bridge(() => ({ ok: true, value: legacyDirectory() }))
    await loadCompanyChannels(good, 'a', companyId, { channels: false }, { now: () => 123 })

    const failing = bridge(() => ({ ok: false, error: 'unavailable' }))
    await loadCompanyChannels(failing, 'a', companyId, { channels: false }, { quiet: true })
    expect($companyChannels.get()[key]).toMatchObject({ channels: [{ displayName: 'general' }], stale: true, lastSuccessAt: 123 })
    expect($companyChannels.get()[key]?.error).toBeUndefined()

    await loadCompanyChannels(bridge(() => ({ ok: false, error: 'denied' })), 'a', companyId, { channels: false }, { quiet: true })
    expect($companyChannels.get()[key]).toMatchObject({ channels: [], error: 'denied', loading: false, lastSuccessAt: 123 })
  })

  it('keeps channels through repeated foreground transport failures and loading, then recovers', async () => {
    await loadCompanyChannels(bridge(() => ({ ok: true, value: legacyDirectory() })), 'a', companyId, { channels: false })
    for (let i = 0; i < 3; i++) {
      await loadCompanyChannels(bridge(() => { throw new Error('unreachable') }), 'a', companyId, { channels: false })
      expect($companyChannels.get()[key]).toMatchObject({ channels: [{ displayName: 'general' }], stale: true })
      expect(channelViewForRoom($companyChannels.get()[key], { companyChannel: { companyId, channelId } } as never)).toBeUndefined()
    }
    await loadCompanyChannels(bridge(() => ({ ok: true, value: legacyDirectory() })), 'a', companyId, { channels: false })
    expect($companyChannels.get()[key]?.stale).toBeUndefined()
  })

  it('refuses an answer from the wrong wire rather than draw it', async () => {
    const wrong = bridge(() => ({ ok: true, value: legacyDirectory() }))

    await expect(loadCompanyChannels(wrong, 'a', companyId, { channels: true })).resolves.toMatchObject({ error: 'invalid', channels: [] })
  })

  it('finds the channel a room belongs to by the directory, never by name', async () => {
    const state = await loadCompanyChannels(bridge(() => ({ ok: true, value: legacyDirectory() })), 'a', companyId, { channels: false })

    expect(channelViewForRoom(state, { companyChannel: { companyId, channelId } })?.displayName).toBe('general')
    expect(channelViewForRoom(state, { companyChannel: { companyId, channelId: privateId } })).toBeUndefined()
    expect(channelViewForRoom(state, {})).toBeUndefined()
    expect(channelViewForRoom(undefined, { companyChannel: { companyId, channelId } })).toBeUndefined()
  })
})


it('restores durable channels before the wire answers, never grants stale authority, and evicts on refusal', async () => {
  const key = teamSpaceKey('a', companyId)
  await loadCompanyChannels(bridge(() => ({ ok: true, value: legacyDirectory() })), 'a', companyId, { channels: false })
  clearCompanyChannels('a')
  void loadCompanyChannels(bridge(() => new Promise(() => {})), 'a', companyId, { channels: false })
  expect($companyChannels.get()[key]).toMatchObject({ channels: [{ displayName: 'general' }], loading: true, stale: true })
  expect(channelViewForRoom($companyChannels.get()[key], { companyChannel: { channelId } } as never)).toBeUndefined()
  await loadCompanyChannels(bridge(() => ({ ok: false, error: 'denied' })), 'a', companyId, { channels: false })
  clearCompanyChannels('a')
  void loadCompanyChannels(bridge(() => new Promise(() => {})), 'a', companyId, { channels: false })
  expect($companyChannels.get()[key]?.channels).toEqual([])
})
