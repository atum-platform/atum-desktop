import { randomUUID } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import type {
  AgentSourceAccessSnapshot,
  AgentSourceAdmission,
  AgentSourceDescriptor
} from '../../../../packages/device-protocol/agent-sources'

import {
  BackgroundSweepSourceRegistry,
  collectBackgroundSweepSources,
  collectLegacyBackgroundSweepSources,
  NATIVE_AGENT_SOURCE_OPERATIONS,
  nativeMacAgentSourceRegistration,
  projectAgentSourceAccessForHost
} from './background-sweep-sources'

const capturedAt = 1_793_017_200_000
const digest = 'a'.repeat(64)

function descriptor(
  id: string,
  operationRef: string,
  optOutGate: string | null = null,
  provenanceTags: string[] = []
): AgentSourceDescriptor {
  return { id, kind: 'fixture.source', connectionRef: 'fixture:connection', optOutGate, revision: 1,
    scopeRef: `fixture:${id}`, readCapabilities: [{ operationRef, backgroundSafe: true }],
    scan: { operationRef, cursorSemantics: 'opaque-v1' }, provenanceTags, policyTags: ['owner-only'] }
}

function admission(source: AgentSourceDescriptor): AgentSourceAdmission {
  return { descriptor: source, binding: { connectionRef: source.connectionRef, scopeRef: source.scopeRef,
    descriptorRevision: source.revision, authorityRevision: 1 } }
}

function collect(
  sources: AgentSourceAdmission[],
  registry: BackgroundSweepSourceRegistry,
  sourceCursors: Record<string, string> = {},
  gateEnabled: (gate: string) => boolean = () => true
) {
  return collectBackgroundSweepSources({ ownerTimeZone: 'Asia/Ho_Chi_Minh',
    admittedSources: { profile: 'atum.agent-sources/1', snapshotRevision: 1, snapshotDigest: digest, sources },
    sourceCursors, registry, gateEnabled, current: () => true,
    signal: new AbortController().signal, now: () => capturedAt })
}

describe('descriptor-driven native background source collection', () => {
  it('round-trips an unknown app/source through a generic operation with no enrollment path', async () => {
    const slug = `unknown-${randomUUID().slice(0, 8)}`
    const source = descriptor(`app:${randomUUID()}:chat`, NATIVE_AGENT_SOURCE_OPERATIONS.scopedRoom,
      'team_spaces', ['app-declared', 'matrix-derived'])
    const registry = new BackgroundSweepSourceRegistry()
    const read = vi.fn(async context => ({ status: 'ok' as const, cursor: `opaque:${slug}:event-1`,
      entries: context.priorCursor ? [] : [{ source: 'ignored-by-v2', scope: 'room-fixture',
        objectId: '$event-1:test', anchorId: '$event-1:test', dueAt: null, observedAt: capturedAt,
        text: 'Owner-visible fixture event', fresh: true }] }))
    registry.register(NATIVE_AGENT_SOURCE_OPERATIONS.scopedRoom, read)

    const first = await collect([admission(source)], registry)
    expect(first.entries).toEqual([expect.objectContaining({ sourceId: source.id, source: source.id,
      id: expect.stringMatching(/^src:/u) })])
    expect(first.cursorDeltas).toEqual({ [source.id]: `opaque:${slug}:event-1` })
    expect(first.sources[0]).toMatchObject({ sourceId: source.id, status: 'ok' })

    const second = await collect([admission(source)], registry, { [source.id]: `opaque:${slug}:event-1` })
    expect(second.entries).toEqual([])
    expect(second.cursorDeltas).toEqual({})
    expect(read).toHaveBeenCalledTimes(2)
    expect([...registry.operations()]).toEqual([NATIVE_AGENT_SOURCE_OPERATIONS.scopedRoom])
    expect([...registry.operations()].some(operation => /enroll|start|prompt/iu.test(operation))).toBe(false)
  })

  it('applies descriptor gate data, including one google opt-out for mail, calendar and drive', async () => {
    const sources = [
      descriptor('google_mail', NATIVE_AGENT_SOURCE_OPERATIONS.googleMail, 'google'),
      descriptor('google_calendar', NATIVE_AGENT_SOURCE_OPERATIONS.googleCalendar, 'google'),
      descriptor('google_drive', NATIVE_AGENT_SOURCE_OPERATIONS.googleDrive, 'google'),
      ...nativeMacAgentSourceRegistration({ connectionRef: 'native:home', scopeRef: 'home:1', revision: 1 }).sources
    ]
    const registry = new BackgroundSweepSourceRegistry()
    const read = vi.fn(async context => ({ status: 'ok' as const, cursor: `opaque:${context.admission.descriptor.id}`,
      entries: [] }))
    for (const operation of sources.map(source => source.scan!.operationRef)) {
      registry.register(operation, read)
    }
    const gates = { google: false, folders: false, messages: true, browser: false, location: true }
    const snapshot = await collect(sources.map(admission), registry, {}, gate => gates[gate as keyof typeof gates] ?? false)
    const statuses = Object.fromEntries(snapshot.sources.map(source => [source.sourceId, source.status]))

    expect(statuses).toMatchObject({ google_mail: 'not_authorized', google_calendar: 'not_authorized',
      google_drive: 'not_authorized', mac_files: 'not_authorized', mac_browser_history: 'not_authorized',
      mac_messages: 'ok', mac_location: 'ok' })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('reports a Mac-only source as authorized but unreachable on a cloud host', () => {
    const mac = nativeMacAgentSourceRegistration({ connectionRef: 'native:home', scopeRef: 'home:1', revision: 1 })
      .sources.find(source => source.id === 'mac_messages')!
    const bound = admission(mac).binding
    const access: AgentSourceAccessSnapshot = { profile: 'atum.agent-sources/1', snapshotRevision: 1,
      snapshotDigest: digest, generatedAt: capturedAt,
      sources: [{ descriptor: mac, availability: 'available', backgroundEligibility: 'eligible', binding: bound }] }
    const cloud = projectAgentSourceAccessForHost(access, new Set(['matrix.read_scoped_room']), () => true)
    const native = projectAgentSourceAccessForHost(access,
      new Set([NATIVE_AGENT_SOURCE_OPERATIONS.macMessages]), () => true)

    expect(cloud[0]).toMatchObject({ authorized: true, reachable: false, availability: 'available' })
    expect(native[0]).toMatchObject({ authorized: true, reachable: true, availability: 'available' })
  })

  it('drops evidence and cursor advancement when a gate or live authority changes during the read', async () => {
    const source = descriptor('plugin:revoked', 'fixture.read', 'messages')
    const registry = new BackgroundSweepSourceRegistry()
    let gate = true
    let current = true
    registry.register('fixture.read', async () => {
      gate = false
      current = false
      return { status: 'ok', cursor: 'opaque:new', entries: [{ source: source.id, scope: 'fixture',
        objectId: 'one', anchorId: 'one', dueAt: null, observedAt: capturedAt,
        text: 'must not survive revocation', fresh: true }] }
    })
    const snapshot = await collectBackgroundSweepSources({ ownerTimeZone: 'Asia/Ho_Chi_Minh',
      admittedSources: { profile: 'atum.agent-sources/1', snapshotRevision: 1, snapshotDigest: digest,
        sources: [admission(source)] }, sourceCursors: { [source.id]: 'opaque:old' }, registry,
      gateEnabled: () => gate, current: () => current, signal: new AbortController().signal,
      now: () => capturedAt })

    expect(snapshot.sources[0]).toMatchObject({ sourceId: source.id, status: 'not_authorized', evidenceIds: [] })
    expect(snapshot.entries).toEqual([])
    expect(snapshot.cursorDeltas).toEqual({})
  })

  it('keeps the exact five legacy keys while descriptor operations drive collection', async () => {
    const registry = new BackgroundSweepSourceRegistry()
    const operations = [NATIVE_AGENT_SOURCE_OPERATIONS.googleMail, NATIVE_AGENT_SOURCE_OPERATIONS.legacyCalendarDrive,
      NATIVE_AGENT_SOURCE_OPERATIONS.chats, NATIVE_AGENT_SOURCE_OPERATIONS.conversation,
      NATIVE_AGENT_SOURCE_OPERATIONS.legacyMemoryFiles]
    for (const operation of operations) {
      registry.register(operation, async context => ({ status: 'ok',
        cursor: `next:${context.admission.descriptor.id}`, entries: [] }))
    }
    registry.register(NATIVE_AGENT_SOURCE_OPERATIONS.macMessages, async () => {
      throw new Error('new_source_must_not_run_on_legacy_profile')
    })
    const snapshot = await collectLegacyBackgroundSweepSources({ ownerTimeZone: 'Asia/Ho_Chi_Minh',
      prior: { googleMail: 'old-mail', googleCalendar: null, atumChats: 'old-chat',
        conversation: null, memory: null }, registry, gateEnabled: () => true,
      signal: new AbortController().signal, now: () => capturedAt })

    expect(Object.keys(snapshot.watermarks).sort()).toEqual(
      ['atumChats', 'conversation', 'googleCalendar', 'googleMail', 'memory'].sort())
    expect(snapshot.watermarks).toEqual({ googleMail: 'next:google_mail',
      googleCalendar: 'next:google_calendar', atumChats: 'next:atum_chats',
      conversation: 'next:conversation', memory: 'next:memory' })
    expect(snapshot.sources.map(source => source.source)).toEqual(
      ['google_mail', 'google_calendar', 'atum_chats', 'conversation', 'memory'])
  })

  it('bounds aggregate evidence in descriptor ID order and reports the rest as budget skipped', async () => {
    const registry = new BackgroundSweepSourceRegistry()
    registry.register('fixture.read', async context => ({ status: 'ok', cursor: `next:${context.admission.descriptor.id}`,
      entries: Array.from({ length: 10 }, (_, index) => ({ source: context.admission.descriptor.id,
        scope: 'fixture', objectId: `${context.admission.descriptor.id}:${index}`, anchorId: String(index),
        dueAt: null, observedAt: capturedAt + index, text: 'Evidence', fresh: true })) }))
    const sources = ['fixture:c', 'fixture:a', 'fixture:b'].map(id => admission(descriptor(id, 'fixture.read')))
    const snapshot = await collect(sources, registry)

    expect(snapshot.entries).toHaveLength(20)
    expect(snapshot.entries.slice(0, 10).every(entry => entry.sourceId === 'fixture:a')).toBe(true)
    expect(snapshot.entries.slice(10).every(entry => entry.sourceId === 'fixture:b')).toBe(true)
    expect(snapshot.sources.map(source => [source.sourceId, source.status])).toEqual([
      ['fixture:a', 'ok'], ['fixture:b', 'ok'], ['fixture:c', 'budget_skipped']
    ])
  })
})
