import {
  AGENT_SOURCES_PROFILE,
  type AgentSourceAccessSnapshot,
  type AgentSourceAdmission,
  type AgentSourceAdmissionSnapshot,
  type AgentSourceAvailability,
  type AgentSourceBackgroundEligibility,
  type AgentSourceCursorBinding,
  type AgentSourceCursors,
  type AgentSourceDescriptor,
  type AgentSourceIntegrationRegistration,
  backgroundSafeAgentSourceOperations,
  parseAgentSourceRegistration
} from '../../../../packages/device-protocol/agent-sources'
import {
  agentSourceSweepEvidence,
  type AgentSourceSweepOutcome,
  agentSourceSweepSnapshot,
  type AgentSourceSweepSnapshot,
  type AgentSourceSweepStatus
} from '../../../shared/src/agent-source-sweep'
import {
  FOLLOWUP_SWEEP_BOUNDS,
  followupSweepEvidence,
  type FollowupSweepEvidenceInput,
  type FollowupSweepEvidenceSnapshot,
  followupSweepSnapshot,
  type FollowupSweepSourceStatus,
  type FollowupSweepSourceWatermarks
} from '../../../shared/src/followup-sweep'

export const NATIVE_AGENT_SOURCE_OPERATIONS = Object.freeze({
  chats: 'matrix.list_chats',
  cloudChats: 'matrix.list_owner_rooms',
  scopedRoom: 'matrix.read_scoped_room',
  conversation: 'matrix.read_conversation',
  googleMail: 'google.search_mail',
  googleCalendar: 'google.agenda',
  googleDrive: 'google.search_drive',
  memory: 'agent.read_memory',
  cloudMemory: 'home.read_memory',
  macFiles: 'mac.list_recent_files',
  macMessages: 'mac.list_message_conversations',
  macBrowser: 'mac.list_browser_history',
  macLocation: 'mac.read_city_location',
  legacyCalendarDrive: 'legacy.google.calendar-drive',
  legacyMemoryFiles: 'legacy.home.read-memory-files'
} as const)

export interface BackgroundSweepSourceRead {
  status: Exclude<AgentSourceSweepStatus, 'budget_skipped' | 'policy_unsupported'>
  cursor?: string
  /** Optional contiguous frontier after each entry, in the same order as entries. */
  entryCursors?: string[]
  entries?: FollowupSweepEvidenceInput[]
}

export interface BackgroundSweepSourceContext {
  admission: AgentSourceAdmission
  priorCursor?: string
  capturedAt: number
  ownerTimeZone: string
  remainingEvidence: number
  warmup: boolean
  signal: AbortSignal
  current(): boolean
}

export type BackgroundSweepSourceHandler = (
  context: BackgroundSweepSourceContext
) => Promise<BackgroundSweepSourceRead>

const SUPPORTED_POLICY_TAGS = new Set(['google-limited-use-v1', 'owner-only'])
const CURSOR = /^[ -~]{1,2048}$/u

function sourceOutcome(
  admission: AgentSourceAdmission,
  status: Exclude<AgentSourceSweepStatus, 'policy_unsupported'>,
  evidenceIds: string[] = []
): AgentSourceSweepOutcome {
  const common = {
    sourceId: admission.descriptor.id,
    binding: admission.binding,
    provenanceTags: admission.descriptor.provenanceTags,
    policyTags: admission.descriptor.policyTags
  }

  return status === 'ok' || status === 'partial'
    ? { ...common, status, evidenceIds }
    : { ...common, status, evidenceIds: [] }
}

/** Trusted operation registry. Source IDs and app slugs never route native code. */
export class BackgroundSweepSourceRegistry {
  private readonly handlers = new Map<string, BackgroundSweepSourceHandler>()

  register(operationRef: string, handler: BackgroundSweepSourceHandler): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(operationRef) || this.handlers.has(operationRef)) {
      throw new Error('matrix_background_sweep_source_handler_invalid')
    }
    this.handlers.set(operationRef, handler)
  }

  operations(): ReadonlySet<string> {
    return new Set(this.handlers.keys())
  }

  handler(operationRef: string): BackgroundSweepSourceHandler | undefined {
    return this.handlers.get(operationRef)
  }
}

export interface BackgroundSweepCollectionInput {
  ownerTimeZone: string
  admittedSources: AgentSourceAdmissionSnapshot
  sourceCursors: AgentSourceCursors
  registry: BackgroundSweepSourceRegistry
  gateEnabled(gate: string): boolean
  current(): boolean
  signal: AbortSignal
  warmup?: boolean
  now?(): number
}

/**
 * Descriptor-driven native `/2` collection. Authority comes from the claim; the Mac rechecks its
 * live opt-out and handler reachability before each read and again before retaining its result.
 */
export async function collectBackgroundSweepSources(
  input: BackgroundSweepCollectionInput
): Promise<AgentSourceSweepSnapshot> {
  const admissions = [...input.admittedSources.sources]
    .sort((left, right) => left.descriptor.id.localeCompare(right.descriptor.id))
  const entries: AgentSourceSweepSnapshot['entries'] = []
  const sources: AgentSourceSweepSnapshot['sources'] = []
  const cursorDeltas: AgentSourceCursors = {}
  const retained = new Set<string>()
  const capturedAt = input.now?.() ?? Date.now()

  for (const admission of admissions) {
    const descriptor = admission.descriptor
    const unsupported = descriptor.policyTags.filter(tag => !SUPPORTED_POLICY_TAGS.has(tag))

    if (unsupported.length > 0) {
      sources.push({ sourceId: descriptor.id, binding: admission.binding, status: 'policy_unsupported',
        evidenceIds: [], provenanceTags: descriptor.provenanceTags, policyTags: descriptor.policyTags,
        unsupportedPolicyTags: unsupported })
      continue
    }
    if (descriptor.optOutGate !== null && !input.gateEnabled(descriptor.optOutGate)) {
      sources.push(sourceOutcome(admission, 'not_authorized'))
      continue
    }
    const scan = descriptor.scan
    const allowed = backgroundSafeAgentSourceOperations(descriptor)
    const handler = scan?.cursorSemantics === 'opaque-v1' && allowed.has(scan.operationRef)
      ? input.registry.handler(scan.operationRef)
      : undefined

    if (!scan || !handler) {
      sources.push(sourceOutcome(admission, 'unavailable'))
      continue
    }
    if (!input.current()) {
      sources.push(sourceOutcome(admission, 'not_authorized'))
      continue
    }
    const remainingEvidence = Math.max(0, FOLLOWUP_SWEEP_BOUNDS.maxEvidenceEntries - entries.length)
    if (remainingEvidence === 0) {
      sources.push(sourceOutcome(admission, 'budget_skipped'))
      continue
    }

    let read: BackgroundSweepSourceRead
    try {
      read = await handler({ admission, priorCursor: input.sourceCursors[descriptor.id], capturedAt,
        ownerTimeZone: input.ownerTimeZone, remainingEvidence, warmup: input.warmup === true,
        signal: input.signal, current: input.current })
    } catch {
      read = { status: input.current() ? 'failed' : 'not_authorized' }
    }
    input.signal.throwIfAborted()
    if (!input.current()) {
      read = { status: 'not_authorized' }
    }
    if (descriptor.optOutGate !== null && !input.gateEnabled(descriptor.optOutGate)) {
      read = { status: 'not_authorized' }
    }
    if (read.status !== 'ok' && read.status !== 'partial') {
      sources.push(sourceOutcome(admission, read.status))
      continue
    }
    const drafts = read.entries ?? []
    const included = drafts.slice(0, remainingEvidence)
    const truncated = included.length < drafts.length
    if (read.status === 'partial' && included.length === 0 ||
        read.cursor !== undefined && !CURSOR.test(read.cursor) ||
        read.entryCursors !== undefined && read.entryCursors.length !== drafts.length) {
      sources.push(sourceOutcome(admission, 'failed'))
      continue
    }

    const sourceEntries: AgentSourceSweepSnapshot['entries'] = []
    try {
      for (const draft of included) {
        const dedupe = descriptor.provenanceTags.includes('matrix-derived')
          ? `matrix:${draft.anchorId}`
          : JSON.stringify([draft.scope, draft.objectId, draft.anchorId, draft.dueAt])
        if (retained.has(dedupe)) {
          continue
        }
        const { source: _legacySource, ...evidence } = draft
        const entry = await agentSourceSweepEvidence({ ...evidence, sourceId: descriptor.id,
          provenanceTags: descriptor.provenanceTags, policyTags: descriptor.policyTags })
        retained.add(dedupe)
        sourceEntries.push(entry)
      }
    } catch {
      sources.push(sourceOutcome(admission, 'failed'))
      continue
    }

    entries.push(...sourceEntries)
    const status = truncated ? 'partial' : read.status === 'partial' && sourceEntries.length === 0 ? 'ok' : read.status
    sources.push(sourceOutcome(admission, status, sourceEntries.map(entry => entry.id)))

    const nextCursor = truncated && included.length > 0 && read.entryCursors
      ? read.entryCursors[included.length - 1]
      : truncated ? undefined : read.cursor
    if (nextCursor !== undefined && nextCursor !== input.sourceCursors[descriptor.id]) {
      cursorDeltas[descriptor.id] = nextCursor
    }
  }

  return agentSourceSweepSnapshot({ capturedAt, ownerTimeZone: input.ownerTimeZone,
    sourceSnapshotDigest: input.admittedSources.snapshotDigest, cursorDeltas, sources, entries })
}

export interface AgentSourceHostProjectionEntry {
  descriptor: AgentSourceDescriptor
  availability: AgentSourceAvailability
  backgroundEligibility: AgentSourceBackgroundEligibility
  binding: AgentSourceCursorBinding | null
  authorized: boolean
  reachable: boolean
}

/** Authorization and host reachability are separate facts for status UI and collection. */
export function projectAgentSourceAccessForHost(
  snapshot: AgentSourceAccessSnapshot,
  operations: ReadonlySet<string>,
  gateEnabled: (gate: string) => boolean
): AgentSourceHostProjectionEntry[] {
  return snapshot.sources.map(source => {
    const gateOpen = source.descriptor.optOutGate === null || gateEnabled(source.descriptor.optOutGate)
    const authorized = source.availability === 'available' && source.binding !== null && gateOpen
    const scan = source.descriptor.scan
    const reachable = authorized && source.backgroundEligibility === 'eligible' && scan !== null &&
      scan.cursorSemantics === 'opaque-v1' &&
      backgroundSafeAgentSourceOperations(source.descriptor).has(scan.operationRef) && operations.has(scan.operationRef)

    return { ...source, authorized, reachable }
  })
}

/** Registration data for operations that exist only on a reachable Mac home. */
export function nativeMacAgentSourceRegistration(input: {
  connectionRef: string
  scopeRef: string
  revision: number
}): AgentSourceIntegrationRegistration {
  const descriptor = (source: Pick<AgentSourceDescriptor, 'id' | 'kind' | 'optOutGate' | 'scan'>) => ({
    ...source,
    connectionRef: input.connectionRef,
    scopeRef: input.scopeRef,
    revision: input.revision,
    readCapabilities: [{ operationRef: source.scan!.operationRef, backgroundSafe: true }],
    provenanceTags: ['device-derived'],
    policyTags: ['owner-only']
  })

  return parseAgentSourceRegistration({
    profile: AGENT_SOURCES_PROFILE,
    integrationRef: 'builtin.mac-sources',
    integrationRevision: input.revision,
    sources: [
      descriptor({ id: 'mac_browser_history', kind: 'mac.browser-history', optOutGate: 'browser',
        scan: { operationRef: NATIVE_AGENT_SOURCE_OPERATIONS.macBrowser, cursorSemantics: 'opaque-v1' } }),
      descriptor({ id: 'mac_files', kind: 'mac.files', optOutGate: 'folders',
        scan: { operationRef: NATIVE_AGENT_SOURCE_OPERATIONS.macFiles, cursorSemantics: 'opaque-v1' } }),
      descriptor({ id: 'mac_location', kind: 'mac.location', optOutGate: 'location',
        scan: { operationRef: NATIVE_AGENT_SOURCE_OPERATIONS.macLocation, cursorSemantics: 'opaque-v1' } }),
      descriptor({ id: 'mac_messages', kind: 'mac.message-metadata', optOutGate: 'messages',
        scan: { operationRef: NATIVE_AGENT_SOURCE_OPERATIONS.macMessages, cursorSemantics: 'opaque-v1' } })
    ]
  })
}

interface LegacySourceDescriptor {
  descriptor: AgentSourceDescriptor
  watermarkKey: keyof FollowupSweepSourceWatermarks
}

/** Fixed only at the frozen compatibility boundary; collection itself still routes descriptors. */
const LEGACY_SOURCES: readonly LegacySourceDescriptor[] = Object.freeze([
  ['google_mail', 'google.mail', 'google', NATIVE_AGENT_SOURCE_OPERATIONS.googleMail, 'googleMail'],
  ['google_calendar', 'google.calendar-drive', 'google', NATIVE_AGENT_SOURCE_OPERATIONS.legacyCalendarDrive,
    'googleCalendar'],
  ['atum_chats', 'matrix.chats', 'team_spaces', NATIVE_AGENT_SOURCE_OPERATIONS.chats, 'atumChats'],
  ['conversation', 'matrix.conversation', null, NATIVE_AGENT_SOURCE_OPERATIONS.conversation, 'conversation'],
  ['memory', 'agent.memory-files', null, NATIVE_AGENT_SOURCE_OPERATIONS.legacyMemoryFiles, 'memory']
].map(([id, kind, optOutGate, operationRef, watermarkKey]) => ({
  watermarkKey: watermarkKey as keyof FollowupSweepSourceWatermarks,
  descriptor: {
    id: id as string,
    kind: kind as string,
    connectionRef: 'legacy:native',
    optOutGate: optOutGate as string | null,
    revision: 1,
    scopeRef: 'legacy:native',
    readCapabilities: [{ operationRef: operationRef as string, backgroundSafe: true }],
    scan: { operationRef: operationRef as string, cursorSemantics: 'opaque-v1' },
    provenanceTags: id === 'google_mail' || id === 'google_calendar' ? ['google-derived'] : [],
    policyTags: id === 'google_mail' || id === 'google_calendar'
      ? ['google-limited-use-v1', 'owner-only'] : ['owner-only']
  }
})))

export interface LegacyBackgroundSweepCollectionInput {
  ownerTimeZone: string
  prior: FollowupSweepSourceWatermarks
  registry: BackgroundSweepSourceRegistry
  gateEnabled(gate: string): boolean
  current?(): boolean
  signal: AbortSignal
  warmup?: boolean
  now?(): number
}

/** Exact five-key compatibility projection for old homes, driven by descriptor operation data. */
export async function collectLegacyBackgroundSweepSources(
  input: LegacyBackgroundSweepCollectionInput
): Promise<FollowupSweepEvidenceSnapshot> {
  const capturedAt = input.now?.() ?? Date.now()
  const watermarks = { ...input.prior }
  const entries: FollowupSweepEvidenceSnapshot['entries'] = []
  const sources: FollowupSweepEvidenceSnapshot['sources'] = []

  for (const source of LEGACY_SOURCES) {
    const descriptor = source.descriptor
    const handler = descriptor.scan ? input.registry.handler(descriptor.scan.operationRef) : undefined
    let read: BackgroundSweepSourceRead

    if (descriptor.optOutGate !== null && !input.gateEnabled(descriptor.optOutGate)) {
      read = { status: 'not_authorized' }
    } else if (input.current && !input.current()) {
      read = { status: 'not_authorized' }
    } else if (!handler) {
      read = { status: 'unavailable' }
    } else {
      const binding = { connectionRef: descriptor.connectionRef, scopeRef: descriptor.scopeRef,
        descriptorRevision: descriptor.revision, authorityRevision: 1 }
      try {
        read = await handler({ admission: { descriptor, binding },
          priorCursor: input.prior[source.watermarkKey] ?? undefined, capturedAt,
          ownerTimeZone: input.ownerTimeZone,
          remainingEvidence: Math.max(0, FOLLOWUP_SWEEP_BOUNDS.maxEvidenceEntries - entries.length),
          warmup: input.warmup === true, signal: input.signal, current: input.current ?? (() => true) })
      } catch {
        read = { status: 'failed' }
      }
    }

    input.signal.throwIfAborted()
    if (input.current && !input.current() ||
        descriptor.optOutGate !== null && !input.gateEnabled(descriptor.optOutGate)) {
      read = { status: 'not_authorized' }
    }
    const drafts = read.entries ?? []
    const remaining = Math.max(0, FOLLOWUP_SWEEP_BOUNDS.maxEvidenceEntries - entries.length)
    const included = drafts.slice(0, remaining)
    for (const draft of included) {
      entries.push(await followupSweepEvidence(draft))
    }

    if (read.status === 'ok' && read.cursor !== undefined) {
      const cursor = included.length < drafts.length && included.length > 0 && read.entryCursors
        ? read.entryCursors[included.length - 1]
        : included.length === drafts.length ? read.cursor : undefined
      if (cursor !== undefined) {
        watermarks[source.watermarkKey] = cursor
      }
    }
    sources.push({ source: descriptor.id, status: read.status as FollowupSweepSourceStatus })
  }

  return followupSweepSnapshot({ capturedAt, ownerTimeZone: input.ownerTimeZone, watermarks, sources, entries })
}
