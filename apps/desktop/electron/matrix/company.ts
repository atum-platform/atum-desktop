import type {
  MatrixCompany,
  MatrixCompanyChannel,
  MatrixCompanyChannel11,
  MatrixCompanyChannelDirectory,
  MatrixCompanyChannelDirectory11,
  MatrixCompanyChannelSnapshot,
  MatrixCompanyChannelSnapshot11,
  MatrixCompanyDirectory11,
  MatrixCompanyErrorCode,
  MatrixCompanyInvitation,
  MatrixCompanyInvitation11,
  MatrixCompanyLeave11,
  MatrixCompanyMember11,
  MatrixCompanyMemberState,
  MatrixCompanyMutation,
  MatrixCompanyProject11,
  MatrixCompanyProjectReaderGapCode,
  MatrixCompanyProjectReaderSource,
  MatrixCompanyProjectReaderStatus,
  MatrixCompanyProjectSource,
  MatrixCompanyProjectSources,
  MatrixCompanyRemoval11,
  MatrixCompanyRequest,
  MatrixCompanySnapshot,
  MatrixCompanySnapshot11,
  MatrixCompanyValue,
  MatrixCompanyWallet
} from '../../shared/matrix-company'
import { matrixCompanyFileRef } from '../../shared/matrix-company-files'
import {
  isTeamSpaceAction,
  isTeamSpaceEphemeral,
  isTeamSpaceRead,
  type MatrixCompanyRefusalFamily,
  matrixCompanyRefusalFamily,
  type MatrixCompanyRefusalReason,
  parseMatrixCompanyRefusal,
  type TeamSpaceRequest
} from '../../shared/matrix-company-team-space'

import type { NativeGrant } from './authorization'
import { parseTeamSpaceRequest, parseTeamSpaceResponse, teamSpaceRoute } from './company-team-space'
import { readDomainJson } from './domain'

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
const sourceGeneration = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0

const timestamp = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v))

const name = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 120 &&
  v.trim() === v && [...v].every(c => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127) && Buffer.from(v, 'utf8').toString('utf8') === v

const channelName = (v: unknown): v is string => typeof v === 'string' && [...v].length > 0 && [...v].length <= 80 &&
  v.trim() === v && [...v].every(c => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127) && Buffer.from(v, 'utf8').toString('utf8') === v

const role = (v: unknown): v is 'admin' | 'member' => v === 'admin' || v === 'member'
const memberRef = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v)
const handle = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9_]{2,31}$/.test(v)

const handleInput = (v: unknown): v is string => typeof v === 'string' && Buffer.byteLength(v, 'utf8') <= 33 &&
  /^@?[A-Za-z][A-Za-z0-9_]{2,31}$/.test(v)

const avatarUri = (v: unknown): v is string => typeof v === 'string' &&
  /^mxc:\/\/[A-Za-z0-9._-]{1,255}\/[A-Za-z0-9_-]{1,255}$/.test(v)

const roomId = (v: unknown): v is string => typeof v === 'string' && /^![!-9;-~]{1,255}:[!-~]{1,255}$/.test(v)

const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).length === expected.length &&
  expected.every(key => Object.hasOwn(v, key))

export class MatrixCompanyError extends Error {
  constructor(readonly code: MatrixCompanyErrorCode, readonly retryAfterSeconds?: number,
    readonly reason?: MatrixCompanyRefusalReason) {
    super(`matrix_company_${code}`)
  }
}

const LEGACY_READ_ACTIONS: ReadonlySet<string> = new Set(['list', 'read', 'wallet', 'list-channels', 'read-channel',
  'project-sources', 'project-reader'])

/** One answer for every caller: a read is retried freely, anything else is a journalled intent. */
export function isMatrixCompanyRead(action: string): boolean {
  return LEGACY_READ_ACTIONS.has(action) || isTeamSpaceRead(action)
}

export function isMatrixCompanyMutation(input: MatrixCompanyRequest): input is MatrixCompanyMutation {
  return !isMatrixCompanyRead(input.action) && !isTeamSpaceEphemeral(input.action)
}

function invalid(): never { throw new MatrixCompanyError('invalid') }

/** Closed IPC vocabulary: no URL, token, actor, owner or payer from the renderer. */
export function parseMatrixCompanyRequest(v: unknown): MatrixCompanyRequest {
  if (!object(v)) { invalid() }

  // Team Space C1/C2 (1.2 / 1.3 / 1.4): strict zod schemas, one closed vocabulary.
  if (isTeamSpaceAction(v.action)) { return parseTeamSpaceRequest(v) ?? invalid() }

  switch (v.action) {
    case 'list':
      if (!keys(v, ['action'])) { invalid() }

      return { action: 'list' }

    case 'read':

    case 'wallet':

    case 'list-channels':
      if (!keys(v, ['action', 'companyId']) || !uuid(v.companyId)) { invalid() }

      return { action: v.action, companyId: v.companyId }

    case 'read-channel':
      if (!keys(v, ['action', 'companyId', 'channelId']) || !uuid(v.companyId) || !uuid(v.channelId)) { invalid() }

      return { action: 'read-channel', companyId: v.companyId, channelId: v.channelId }

    case 'project-sources':

    case 'project-reader':
      if (!keys(v, ['action', 'companyId', 'projectId']) || !uuid(v.companyId) || !uuid(v.projectId)) { invalid() }

      return { action: v.action, companyId: v.companyId, projectId: v.projectId }

    case 'create-channel':
      if (!keys(v, v.projectId === undefined ? ['action', 'companyId', 'requestId', 'displayName'] :
        ['action', 'companyId', 'requestId', 'displayName', 'projectId']) || !uuid(v.companyId) || !uuid(v.requestId) ||
        !channelName(v.displayName) || (v.projectId !== undefined && !uuid(v.projectId))) { invalid() }

      return { action: 'create-channel', companyId: v.companyId, requestId: v.requestId,
        displayName: v.displayName, ...(typeof v.projectId === 'string' ? { projectId: v.projectId } : {}) }

    case 'archive-channel':

    case 'restore-channel':
      if (!keys(v, ['action', 'companyId', 'channelId', 'requestId']) || !uuid(v.companyId) || !uuid(v.channelId)
        || !uuid(v.requestId)) { invalid() }

      return { action: v.action, companyId: v.companyId, channelId: v.channelId, requestId: v.requestId }

    case 'include-project-channel-source':
      if (!keys(v, ['action', 'companyId', 'projectId', 'requestId', 'channelId', 'expectedSourceGeneration']) ||
        !uuid(v.companyId) || !uuid(v.projectId) || !uuid(v.requestId) || !uuid(v.channelId) ||
        !sourceGeneration(v.expectedSourceGeneration)) { invalid() }

      return { action: v.action, companyId: v.companyId, projectId: v.projectId, requestId: v.requestId,
        channelId: v.channelId, expectedSourceGeneration: v.expectedSourceGeneration }

    case 'include-project-file-source':
      if (!keys(v, ['action', 'companyId', 'projectId', 'requestId', 'fileId', 'revision', 'expectedSourceGeneration']) ||
        !uuid(v.companyId) || !uuid(v.projectId) || !uuid(v.requestId) || !uuid(v.fileId) || v.revision !== 1 ||
        !sourceGeneration(v.expectedSourceGeneration)) { invalid() }

      return { action: v.action, companyId: v.companyId, projectId: v.projectId, requestId: v.requestId,
        fileId: v.fileId, revision: 1, expectedSourceGeneration: v.expectedSourceGeneration }

    case 'withdraw-project-source':
      if (!keys(v, ['action', 'companyId', 'projectId', 'requestId', 'sourceId', 'expectedSourceGeneration']) ||
        !uuid(v.companyId) || !uuid(v.projectId) || !uuid(v.requestId) || !uuid(v.sourceId) ||
        !sourceGeneration(v.expectedSourceGeneration)) { invalid() }

      return { action: v.action, companyId: v.companyId, projectId: v.projectId, requestId: v.requestId,
        sourceId: v.sourceId, expectedSourceGeneration: v.expectedSourceGeneration }

    case 'funding':
      if (!keys(v, ['action', 'companyId', 'requestId', 'enabled', 'taskLimit']) || !uuid(v.companyId) ||
        !uuid(v.requestId) || typeof v.enabled !== 'boolean' || !Number.isSafeInteger(v.taskLimit) || (v.taskLimit as number) < 1) { invalid() }

      return { action: 'funding', companyId: v.companyId, requestId: v.requestId, enabled: v.enabled, taskLimit: v.taskLimit as number }

    case 'create':
      if (!keys(v, ['action', 'requestId', 'displayName']) || !uuid(v.requestId) || !name(v.displayName)) { invalid() }

      return { action: 'create', requestId: v.requestId, displayName: v.displayName }

    case 'accept':
      if (!keys(v, ['action', 'companyId', 'requestId', 'invitationId']) || !uuid(v.companyId) ||
        !uuid(v.requestId) || !uuid(v.invitationId)) { invalid() }

      return { action: 'accept', companyId: v.companyId, requestId: v.requestId, invitationId: v.invitationId }

    case 'create-project':
      if (!keys(v, ['action', 'companyId', 'requestId', 'displayName']) || !uuid(v.companyId) ||
        !uuid(v.requestId) || !name(v.displayName)) { invalid() }

      return { action: 'create-project', companyId: v.companyId, requestId: v.requestId, displayName: v.displayName }

    case 'invite':
      if (!keys(v, ['action', 'companyId', 'requestId', 'memberHandle', 'role']) || !uuid(v.companyId) ||
        !uuid(v.requestId) || !handleInput(v.memberHandle) || !role(v.role)) { invalid() }

      return { action: 'invite', companyId: v.companyId, requestId: v.requestId,
        memberHandle: v.memberHandle, role: v.role }

    case 'remove-member':
      if (!keys(v, ['action', 'companyId', 'requestId', 'memberRef']) || !uuid(v.companyId) ||
        !uuid(v.requestId) || !memberRef(v.memberRef)) { invalid() }

      return { action: 'remove-member', companyId: v.companyId, requestId: v.requestId, memberRef: v.memberRef }

    case 'leave':
      if (!keys(v, ['action', 'companyId', 'requestId']) || !uuid(v.companyId) || !uuid(v.requestId)) { invalid() }

      return { action: 'leave', companyId: v.companyId, requestId: v.requestId }

    default: invalid()
  }
}

function company(v: unknown): MatrixCompany {
  if (!object(v) || !keys(v, ['id', 'displayName', 'role', 'authorityGeneration']) ||
    !uuid(v.id) || !name(v.displayName) || !role(v.role) || !Number.isSafeInteger(v.authorityGeneration) ||
    (v.authorityGeneration as number) < 1) { invalid() }

  return { id: v.id, displayName: v.displayName, role: v.role, authorityGeneration: v.authorityGeneration as number }
}

function invitation(v: unknown): MatrixCompanyInvitation {
  if (!object(v) || !keys(v, ['id', 'companyId', 'displayName', 'role']) || !uuid(v.id) ||
    !uuid(v.companyId) || !name(v.displayName) || !role(v.role)) { invalid() }

  return { id: v.id, companyId: v.companyId, displayName: v.displayName, role: v.role }
}

function channel(v: unknown, companyId: string): MatrixCompanyChannel {
  if (!object(v) || !keys(v, ['id', 'companyId', 'displayName', 'visibility', 'state', 'projectId',
    'authorityGeneration', 'channelGeneration']) || !uuid(v.id) || v.companyId !== companyId || !channelName(v.displayName)
    || v.visibility !== 'company'
    || !['provisioning', 'active', 'archived'].includes(String(v.state))
    || (v.projectId !== null && !uuid(v.projectId)) || !Number.isSafeInteger(v.authorityGeneration)
    || (v.authorityGeneration as number) < 1 || !Number.isSafeInteger(v.channelGeneration)
    || (v.channelGeneration as number) < 1) { invalid() }

  return v as unknown as MatrixCompanyChannel
}

function channelSnapshot(v: unknown, companyId: string, channelId?: string): MatrixCompanyChannelSnapshot {
  if (!object(v) || !keys(v, ['schemaVersion', 'channel', 'memberPrincipals', 'room']) || v.schemaVersion !== 1
    || !object(v.room) || !keys(v.room, ['state', 'roomId'])) { invalid() }

  const current = channel(v.channel, companyId)

  if (channelId !== undefined && current.id !== channelId) { invalid() }

  const memberPrincipals = bounded(v.memberPrincipals, value => { if (!uuid(value)) { invalid() };

 return value })

  if (memberPrincipals.length < 1) { invalid() }
  unique(memberPrincipals)

  const room = v.room.state === 'ready'
    ? typeof v.room.roomId === 'string' && /^![!-9;-~]{1,255}:[!-~]{1,255}$/.test(v.room.roomId)
      ? { state: 'ready' as const, roomId: v.room.roomId }
      : invalid()
    : ['not_provisioned', 'provisioning', 'reconciling', 'failed'].includes(String(v.room.state)) && v.room.roomId === null
      ? { state: v.room.state as 'not_provisioned' | 'provisioning' | 'reconciling' | 'failed', roomId: null }
      : invalid()

  return { schemaVersion: 1, channel: current, memberPrincipals, room }
}

function bounded<T>(v: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(v) || v.length > 100) { invalid() }

  return v.map(parse)
}

function unique(values: string[]): void { if (new Set(values).size !== values.length) { invalid() } }

function projectSources(v: Record<string, unknown>, companyId: string, projectId: string): MatrixCompanyProjectSources {
  if (!keys(v, ['schemaVersion', 'companyId', 'projectId', 'authorityGeneration', 'sourceGeneration',
    'eligibleChannels', 'eligibleFiles', 'sources', 'coverage']) || v.companyId !== companyId || v.projectId !== projectId ||
    !Number.isSafeInteger(v.authorityGeneration) || Number(v.authorityGeneration) < 1 || !sourceGeneration(v.sourceGeneration) ||
    !object(v.coverage) || !keys(v.coverage, ['state']) || !['empty', 'pending'].includes(String(v.coverage.state))) { invalid() }

  const eligibleChannels = bounded(v.eligibleChannels, value => {
    if (!object(value) || !keys(value, ['channelId', 'displayName', 'state']) || !uuid(value.channelId) ||
      !channelName(value.displayName) || value.state !== 'ready') { invalid() }

    return { channelId: value.channelId, displayName: value.displayName, state: 'ready' as const }
  })

  const eligibleFiles = bounded(v.eligibleFiles, value => {
    if (!object(value) || !keys(value, ['file', 'channelId', 'eventId', 'publishedAt']) || !uuid(value.channelId) ||
      typeof value.eventId !== 'string' || !/^\$[!-~]{1,511}$/.test(value.eventId) || !timestamp(value.publishedAt)) { invalid() }

    const file = matrixCompanyFileRef(value.file, { companyId, target: { kind: 'channel', channelId: value.channelId } })

    if (!file) { invalid() }

    return { file, channelId: value.channelId, eventId: value.eventId, publishedAt: value.publishedAt }
  })

  const sources = bounded(v.sources, value => {
    if (!object(value) || !uuid(value.id) || !uuid(value.channelId) ||
      !['active', 'withdrawn'].includes(String(value.state)) || !timestamp(value.enrolledAt) ||
      (value.withdrawnAt !== null && !timestamp(value.withdrawnAt)) ||
      (value.state === 'active') !== (value.withdrawnAt === null)) { invalid() }

    const common = { id: value.id, state: value.state as 'active' | 'withdrawn', channelId: value.channelId,
      enrolledAt: value.enrolledAt, withdrawnAt: value.withdrawnAt as string | null }

    if (value.kind === 'channel') {
      if (!keys(value, ['id', 'kind', 'state', 'channelId', 'enrolledAt', 'withdrawnAt'])) { invalid() }

      return { ...common, kind: 'channel' as const }
    }

    if (value.kind !== 'company_file' ||
      !keys(value, ['id', 'kind', 'state', 'channelId', 'file', 'enrolledAt', 'withdrawnAt'])) { invalid() }

    const file = matrixCompanyFileRef(value.file, { companyId, target: { kind: 'channel', channelId: value.channelId } })

    if (!file) { invalid() }

    return { ...common, kind: 'company_file' as const, file }
  }) satisfies MatrixCompanyProjectSource[]

  const active = sources.filter(source => source.state === 'active')

  unique(eligibleChannels.map(channel => channel.channelId))
  unique(eligibleFiles.map(file => file.file.file_id))
  unique(sources.map(source => source.id))

  if (active.filter(source => source.kind === 'channel').length > 1 ||
    active.filter(source => source.kind === 'company_file').length > 1 ||
    (v.sourceGeneration === 0) !== (sources.length === 0) ||
    (v.coverage.state === 'empty') !== (active.length === 0)) { invalid() }

  return { schemaVersion: 1, companyId, projectId, authorityGeneration: v.authorityGeneration as number,
    sourceGeneration: v.sourceGeneration, eligibleChannels, eligibleFiles, sources,
    coverage: { state: v.coverage.state as 'empty' | 'pending' } }
}

const projectReaderGap = (v: unknown): v is MatrixCompanyProjectReaderGapCode => [
  'assignment_unavailable', 'lease_contention', 'roster_unresolved', 'backfill_pending', 'history_gap',
  'join_changed', 'file_unavailable', 'receipt_pending', 'reader_unavailable'
].includes(String(v))

function projectReaderStatus(v: Record<string, unknown>, companyId: string,
  projectId: string): MatrixCompanyProjectReaderStatus {
  if (!keys(v, ['schemaVersion', 'companyId', 'projectId', 'authorityGeneration', 'sourceGeneration',
    'coverage', 'sources']) || v.schemaVersion !== 2 || v.companyId !== companyId || v.projectId !== projectId ||
    !Number.isSafeInteger(v.authorityGeneration) || Number(v.authorityGeneration) < 1 ||
    !sourceGeneration(v.sourceGeneration) || !object(v.coverage) || !Array.isArray(v.sources) || v.sources.length > 100) { invalid() }

  const coverage = v.coverage
  let parsedCoverage: MatrixCompanyProjectReaderStatus['coverage']

  if (coverage.state === 'empty' || coverage.state === 'pending') {
    if (!keys(coverage, ['state'])) { invalid() }
    parsedCoverage = { state: coverage.state }
  } else if (coverage.state === 'live') {
    if (!keys(coverage, ['state', 'lastIngestedAt']) || !timestamp(coverage.lastIngestedAt)) { invalid() }
    parsedCoverage = { state: 'live', lastIngestedAt: coverage.lastIngestedAt }
  } else if (coverage.state === 'paused' || coverage.state === 'attention') {
    const hasLast = coverage.lastIngestedAt !== undefined

    if (!keys(coverage, hasLast ? ['state', 'gapCode', 'lastIngestedAt'] : ['state', 'gapCode']) ||
      !projectReaderGap(coverage.gapCode) || hasLast && !timestamp(coverage.lastIngestedAt)) { invalid() }

    parsedCoverage = { state: coverage.state, gapCode: coverage.gapCode,
      ...(hasLast ? { lastIngestedAt: coverage.lastIngestedAt as string } : {}) }
  } else { invalid() }

  const sources = bounded(v.sources, value => {
    if (!object(value) || !uuid(value.sourceId) || !uuid(value.channelId) ||
      !['channel', 'company_file'].includes(String(value.kind)) || !['active', 'withdrawn'].includes(String(value.state)) ||
      !['none', 'live', 'paused', 'attention', 'stale'].includes(String(value.receiptState))) { invalid() }

    const hasFile = value.file !== undefined, hasLast = value.lastIngestedAt !== undefined, hasGap = value.gapCode !== undefined

    const expected = ['sourceId', 'kind', 'state', 'channelId', 'receiptState',
      ...(hasFile ? ['file'] : []), ...(hasLast ? ['lastIngestedAt'] : []), ...(hasGap ? ['gapCode'] : [])]

    if (!keys(value, expected) || (value.kind === 'company_file') !== hasFile || hasLast && !timestamp(value.lastIngestedAt) ||
      hasGap && !projectReaderGap(value.gapCode) || value.receiptState === 'live' && !hasLast ||
      value.receiptState === 'none' && (hasLast || hasGap)) { invalid() }

    const file = hasFile ? matrixCompanyFileRef(value.file, {
      companyId,
      target: { kind: 'channel', channelId: value.channelId as string }
    }) : undefined

    if (hasFile && !file) { invalid() }

    return { sourceId: value.sourceId, kind: value.kind, state: value.state, channelId: value.channelId,
      receiptState: value.receiptState, ...(file ? { file } : {}),
      ...(hasLast ? { lastIngestedAt: value.lastIngestedAt as string } : {}),
      ...(hasGap ? { gapCode: value.gapCode as MatrixCompanyProjectReaderGapCode } : {})
    } as MatrixCompanyProjectReaderSource
  })

  unique(sources.map(source => source.sourceId))
  const active = sources.filter(source => source.state === 'active')

  if ((parsedCoverage.state === 'empty') !== (active.length === 0) ||
      parsedCoverage.state === 'live' && (active.length === 0 || active.some(source => source.receiptState !== 'live')) ||
      parsedCoverage.state === 'pending' && active.length === 0) { invalid() }

  return { schemaVersion: 2, companyId, projectId, authorityGeneration: v.authorityGeneration as number,
    sourceGeneration: v.sourceGeneration as number, coverage: parsedCoverage, sources }
}

function wallet(v: Record<string, unknown>, companyId: string): MatrixCompanyWallet {
  if (!keys(v, ['schemaVersion', 'companyId', 'unit', 'balances', 'checkoutOpen', 'funding']) ||
    v.companyId !== companyId || v.unit !== 'micro_proton' || v.checkoutOpen !== false || !object(v.balances) || !object(v.funding)) { invalid() }

  const b = v.balances

  if (!keys(b, ['paid', 'earned', 'promo', 'held', 'available']) ||
    !Object.values(b).every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
    b.available !== (b.paid as number) + (b.earned as number) + (b.promo as number)) { invalid() }

  const policy = v.funding

  if (!keys(policy, ['enabled', 'taskLimit', 'revision']) || typeof policy.enabled !== 'boolean' ||
    !Number.isSafeInteger(policy.revision) || (policy.revision as number) < 0 ||
    (policy.revision === 0 ? policy.enabled || policy.taskLimit !== null :
      !Number.isSafeInteger(policy.taskLimit) || (policy.taskLimit as number) < 1)) { invalid() }

  return { schemaVersion: 1, companyId, unit: 'micro_proton', checkoutOpen: false,
    balances: { paid: b.paid as number, earned: b.earned as number, promo: b.promo as number, held: b.held as number, available: b.available as number },
    funding: { enabled: policy.enabled, taskLimit: policy.taskLimit as number | null, revision: policy.revision as number } }
}


const MEMBER_STATE = ['invited', 'active', 'revoking', 'removed'] as const

function inviter11(v: unknown): { handle: string | null; displayName: string | null } {
  if (!object(v) || !keys(v, ['handle', 'displayName']) ||
    (v.handle !== null && !handle(v.handle)) || (v.displayName !== null && !name(v.displayName))) { invalid() }

  return { handle: v.handle as string | null, displayName: v.displayName as string | null }
}

function invitation11(v: unknown): MatrixCompanyInvitation11 {
  if (!object(v) || !keys(v, ['id', 'companyId', 'displayName', 'role', 'inviter']) || !uuid(v.id) ||
    !uuid(v.companyId) || !name(v.displayName) || !role(v.role)) { invalid() }

  return { id: v.id, companyId: v.companyId, displayName: v.displayName, role: v.role,
    inviter: inviter11(v.inviter) }
}

function member11(v: unknown): MatrixCompanyMember11 {
  if (!object(v) || !memberRef(v.memberRef) || !role(v.role) ||
    !MEMBER_STATE.includes(v.state as typeof MEMBER_STATE[number]) || typeof v.self !== 'boolean') { invalid() }

  const hasAvatar = v.avatarUri !== undefined
  const expected = ['memberRef', 'role', 'state', 'self', 'handle', 'displayName', ...(hasAvatar ? ['avatarUri'] : [])]

  if (!keys(v, expected) || (hasAvatar && !avatarUri(v.avatarUri))) { invalid() }

  if (v.state === 'removed') {
    if (v.handle !== null || v.displayName !== null || v.self !== false || hasAvatar) { invalid() }
  } else if ((v.handle !== null && !handle(v.handle)) || (v.displayName !== null && !name(v.displayName))) {
    invalid()
  }

  return {
    memberRef: v.memberRef,
    role: v.role,
    state: v.state as MatrixCompanyMemberState,
    self: v.self,
    handle: v.handle as string | null,
    displayName: v.displayName as string | null,
    ...(hasAvatar ? { avatarUri: v.avatarUri as string } : {})
  }
}

function project11(v: unknown, active: Set<string>): MatrixCompanyProject11 {
  if (!object(v) || !keys(v, ['id', 'displayName', 'memberRefs', 'collaboration']) || !uuid(v.id) ||
    !name(v.displayName) || v.collaboration !== 'not_provisioned') { invalid() }

  const memberRefs = bounded(v.memberRefs, value => {
    if (!memberRef(value) || !active.has(value)) { invalid() }

    return value
  })

  unique(memberRefs)

  return { id: v.id, displayName: v.displayName, memberRefs, collaboration: 'not_provisioned' }
}

function snapshot11(v: Record<string, unknown>, companyId?: string): MatrixCompanySnapshot11 {
  if (!keys(v, ['schemaVersion', 'company', 'members', 'projects', 'defaultChannelId']) || v.schemaVersion !== 2) { invalid() }
  const current = company(v.company)

  if (companyId !== undefined && current.id !== companyId) { invalid() }

  if (v.defaultChannelId !== null && !uuid(v.defaultChannelId)) { invalid() }

  if (!Array.isArray(v.members) || v.members.length < 1 || v.members.length > 100) { invalid() }
  const members = v.members.map(member11)

  unique(members.map(member => member.memberRef))

  if (current.role === 'member' && members.some(member => member.state !== 'active')) { invalid() }
  const active = new Set(members.filter(member => member.state === 'active').map(member => member.memberRef))
  const projects = bounded(v.projects, entry => project11(entry, active))

  unique(projects.map(project => project.id))

  return { schemaVersion: 2, company: current, members, projects, defaultChannelId: v.defaultChannelId as string | null }
}

function channel11(v: unknown, companyId: string, channelId?: string): MatrixCompanyChannel11 {
  if (!object(v) || (v.systemKey !== undefined && v.systemKey !== 'default')) { invalid() }
  const hasSystemKey = v.systemKey !== undefined

  const expected = ['id', 'companyId', 'displayName', 'visibility', 'state', 'projectId', 'authorityGeneration',
    'channelGeneration', ...(hasSystemKey ? ['systemKey'] : [])]

  if (!keys(v, expected) || !uuid(v.id) || v.companyId !== companyId || !channelName(v.displayName) ||
    v.visibility !== 'company' || !['provisioning', 'active', 'archived'].includes(String(v.state)) ||
    (v.projectId !== null && !uuid(v.projectId)) || !Number.isSafeInteger(v.authorityGeneration) ||
    (v.authorityGeneration as number) < 1 || !Number.isSafeInteger(v.channelGeneration) ||
    (v.channelGeneration as number) < 1 || (channelId !== undefined && v.id !== channelId)) { invalid() }

  return v as unknown as MatrixCompanyChannel11
}

function channelSnapshot11(v: unknown, companyId: string, channelId?: string): MatrixCompanyChannelSnapshot11 {
  if (!object(v) || !keys(v, ['schemaVersion', 'channel', 'memberCount', 'room']) || v.schemaVersion !== 2 ||
    !Number.isSafeInteger(v.memberCount) || (v.memberCount as number) < 1 || (v.memberCount as number) > 100 ||
    !object(v.room) || !keys(v.room, ['state', 'roomId'])) { invalid() }

  const current = channel11(v.channel, companyId, channelId)

  const room = v.room.state === 'ready'
    ? roomId(v.room.roomId) ? { state: 'ready' as const, roomId: v.room.roomId } : invalid()
    : ['not_provisioned', 'provisioning', 'reconciling', 'failed'].includes(String(v.room.state)) && v.room.roomId === null
      ? { state: v.room.state as 'not_provisioned' | 'provisioning' | 'reconciling' | 'failed', roomId: null }
      : invalid()

  return { schemaVersion: 2, channel: current, memberCount: v.memberCount as number, room }
}

function removal11(v: Record<string, unknown>, input: Extract<MatrixCompanyRequest, { action: 'remove-member' }>): MatrixCompanyRemoval11 {
  if (!keys(v, ['schemaVersion', 'companyId', 'memberRef', 'state', 'authorityGeneration']) || v.schemaVersion !== 2 ||
    v.companyId !== input.companyId || v.memberRef !== input.memberRef ||
    !['revoking', 'removed'].includes(String(v.state)) || !Number.isSafeInteger(v.authorityGeneration) ||
    (v.authorityGeneration as number) < 1) { invalid() }

  return { schemaVersion: 2, companyId: v.companyId, memberRef: v.memberRef,
    state: v.state as 'revoking' | 'removed', authorityGeneration: v.authorityGeneration as number }
}

function leave11(v: Record<string, unknown>, input: Extract<MatrixCompanyRequest, { action: 'leave' }>): MatrixCompanyLeave11 {
  if (!keys(v, ['schemaVersion', 'companyId', 'state', 'retired', 'authorityGeneration']) || v.schemaVersion !== 2 ||
    v.companyId !== input.companyId || !['revoking', 'removed'].includes(String(v.state)) ||
    typeof v.retired !== 'boolean' || !Number.isSafeInteger(v.authorityGeneration) ||
    (v.authorityGeneration as number) < 1) { invalid() }

  return { schemaVersion: 2, companyId: v.companyId, state: v.state as 'revoking' | 'removed',
    retired: v.retired, authorityGeneration: v.authorityGeneration as number }
}

/** Exact 1.1 parser. The v1 parser above never widens for these shapes. */
function parseCompanyResponse11(v: Record<string, unknown>, input: MatrixCompanyRequest): MatrixCompanyValue {
  if (input.action === 'list') {
    if (!keys(v, ['schemaVersion', 'companies', 'invitations', 'canCreate']) || v.schemaVersion !== 2 ||
      typeof v.canCreate !== 'boolean') { invalid() }

    const companies = bounded(v.companies, company)
    const invitations = bounded(v.invitations, invitation11)

    unique(companies.map(entry => entry.id))
    unique(invitations.map(entry => entry.id))

    return { schemaVersion: 2, companies, invitations, canCreate: v.canCreate } satisfies MatrixCompanyDirectory11
  }

  if (input.action === 'list-channels') {
    if (!keys(v, ['schemaVersion', 'channels']) || v.schemaVersion !== 2) { invalid() }
    const channels = bounded(v.channels, value => channelSnapshot11(value, input.companyId))

    unique(channels.map(entry => entry.channel.id))

    return { schemaVersion: 2, channels } satisfies MatrixCompanyChannelDirectory11
  }

  if (input.action === 'read-channel' || input.action === 'create-channel'
    || input.action === 'archive-channel' || input.action === 'restore-channel') {
    return channelSnapshot11(v, input.companyId, 'channelId' in input ? input.channelId : undefined)
  }

  if (input.action === 'remove-member') { return removal11(v, input) }

  if (input.action === 'leave') { return leave11(v, input) }

  if (input.action === 'create') { return snapshot11(v) }

  if (input.action === 'invite' || input.action === 'accept') { return snapshot11(v, input.companyId) }

  if (input.action === 'read') { return snapshot11(v, input.companyId) }

  invalid()
}

export function parseMatrixCompanyResponse(v: unknown, input: MatrixCompanyRequest): MatrixCompanyValue {
  if (!object(v)) { invalid() }

  if (isTeamSpaceAction(input.action)) { return parseTeamSpaceResponse(input as TeamSpaceRequest, v) ?? invalid() }

  if (input.action === 'project-reader') { return projectReaderStatus(v, input.companyId, input.projectId) }

  if (v.schemaVersion === 2) { return parseCompanyResponse11(v, input) }

  if (v.schemaVersion !== 1) { invalid() }

  if (input.action === 'wallet' || input.action === 'funding') { return wallet(v, input.companyId) }

  if (input.action === 'project-sources' || input.action === 'include-project-channel-source' ||
    input.action === 'include-project-file-source' || input.action === 'withdraw-project-source') {
    return projectSources(v, input.companyId, input.projectId)
  }

  if (input.action === 'list-channels') {
    if (!keys(v, ['schemaVersion', 'channels'])) { invalid() }
    const channels = bounded(v.channels, value => channelSnapshot(value, input.companyId))

    unique(channels.map(value => value.channel.id))

    return { schemaVersion: 1, channels } satisfies MatrixCompanyChannelDirectory
  }

  if (input.action === 'read-channel' || input.action === 'create-channel'
    || input.action === 'archive-channel' || input.action === 'restore-channel') {
    return channelSnapshot(v, input.companyId, 'channelId' in input ? input.channelId : undefined)
  }

  if (input.action === 'list') {
    if (!keys(v, ['schemaVersion', 'companies', 'invitations'])) { invalid() }
    const companies = bounded(v.companies, company)
    const invitations = bounded(v.invitations, invitation)
    unique(companies.map(c => c.id))
    unique(invitations.map(i => i.id))

    return { schemaVersion: 1, companies, invitations }
  }

  if (!keys(v, ['schemaVersion', 'company', 'members', 'projects'])) { invalid() }
  const current = company(v.company)

  if ('companyId' in input && current.id !== input.companyId) { invalid() }

  const members = bounded(v.members, entry => {
    if (!object(entry) || !keys(entry, ['principal', 'role', 'state']) || !uuid(entry.principal) || !role(entry.role) ||
      !['active', 'invited', 'revoking', 'removed'].includes(entry.state as string) ||
      (current.role === 'member' && entry.state !== 'active')) { invalid() }

    return { principal: entry.principal, role: entry.role, state: entry.state as MatrixCompanySnapshot['members'][number]['state'] }
  })

  unique(members.map(m => m.principal))
  const active = new Set(members.filter(m => m.state === 'active').map(m => m.principal))

  const projects = bounded(v.projects, entry => {
    if (!object(entry) || !keys(entry, ['id', 'displayName', 'memberPrincipals', 'collaboration']) ||
      !uuid(entry.id) || !name(entry.displayName) || entry.collaboration !== 'not_provisioned') { invalid() }

    const memberPrincipals = bounded(entry.memberPrincipals, p => { if (!uuid(p) || !active.has(p)) { invalid() };

 return p })

    unique(memberPrincipals)

    return { id: entry.id, displayName: entry.displayName, memberPrincipals, collaboration: 'not_provisioned' as const }
  })

  unique(projects.map(p => p.id))

  return { schemaVersion: 1, company: current, members, projects }
}

interface CompanyRoute {
  method: 'GET' | 'POST'
  path: string
  /** The `Atum-Company-Wire` value this message family selects. */
  wire: string
  /** An additive command profile the request also names, in its own header (company channel command 1.1). */
  profile?: { header: string; value: string }
  body?: unknown
}

type LegacyCompanyRequest = Exclude<MatrixCompanyRequest, TeamSpaceRequest>

function isTeamSpaceRequest(input: MatrixCompanyRequest): input is TeamSpaceRequest {
  return isTeamSpaceAction(input.action)
}

function legacyRoute(input: LegacyCompanyRequest): CompanyRoute {
  const projectSource = input.action === 'project-sources' || input.action === 'include-project-channel-source'
    || input.action === 'include-project-file-source' || input.action === 'withdraw-project-source'

  const path = input.action === 'list' || input.action === 'create' ? '/companies'
    : input.action === 'project-reader' ? `/companies/${input.companyId}/projects/${input.projectId}/reader`
    : projectSource ? `/companies/${input.companyId}/projects/${input.projectId}/sources`
    : input.action === 'list-channels' || input.action === 'create-channel' ? `/companies/${input.companyId}/channels`
    : input.action === 'read-channel' ? `/companies/${input.companyId}/channels/${input.channelId}`
    : input.action === 'archive-channel' || input.action === 'restore-channel'
      ? `/companies/${input.companyId}/channels/${input.channelId}/${input.action === 'archive-channel' ? 'archive' : 'restore'}`
      : `/companies/${input.companyId}${input.action === 'read' ? '' : `/${input.action}`}`

  const body = input.action === 'include-project-channel-source'
    ? { requestId: input.requestId, operation: 'include_channel', channelId: input.channelId,
        expectedSourceGeneration: input.expectedSourceGeneration }
    : input.action === 'include-project-file-source'
      ? { requestId: input.requestId, operation: 'include_file', fileId: input.fileId, revision: input.revision,
          expectedSourceGeneration: input.expectedSourceGeneration }
      : input.action === 'withdraw-project-source'
        ? { requestId: input.requestId, operation: 'withdraw', sourceId: input.sourceId,
            expectedSourceGeneration: input.expectedSourceGeneration }
        : (() => {
            const { action: _action, ...fields } = input
            const { companyId: _companyId, channelId: _channelId, projectId: _projectId, ...rest } = fields as Record<string, unknown>

            return rest
          })()

  // Only leave reselects 1.11 for its additive named refusal. Every other legacy route stays on
  // 1.1; successful leave bytes remain the same schemaVersion 2 answer.
  return { method: isMatrixCompanyRead(input.action) ? 'GET' : 'POST', path,
    wire: input.action === 'leave' ? '1.11' : '1.1', body }
}

/** Leave selects 1.11, earlier actions keep 1.1, and every Team Space action carries its own family's. */
export function matrixCompanyRoute(input: MatrixCompanyRequest): CompanyRoute {
  return isTeamSpaceRequest(input) ? teamSpaceRoute(input) : legacyRoute(input)
}

const REFUSAL_STATUS: Readonly<Record<number, MatrixCompanyErrorCode>> = {
  400: 'invalid', 401: 'authentication', 403: 'denied', 404: 'missing', 409: 'conflict', 429: 'limit'
}

/**
 * The typed reason of a refusal, when the platform named one the contract defines for that very
 * status. A body that is not a closed refusal says nothing: the status code stands alone.
 */
async function refusalReason(response: Response, family: MatrixCompanyRefusalFamily): Promise<MatrixCompanyRefusalReason | undefined> {
  if (!response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()

    return undefined
  }

  try {
    const refusal = parseMatrixCompanyRefusal(await readDomainJson(response, 4096), family)

    return refusal && refusal.error === `matrix_${response.status}` ? refusal.reason : undefined
  } catch {
    return undefined
  }
}

/** The configured native domain resource only; redirects cannot move a bearer token. */
export async function requestMatrixCompany(
  resource: string, grant: NativeGrant, value: MatrixCompanyRequest, signal: AbortSignal
): Promise<MatrixCompanyValue> {
  const input = parseMatrixCompanyRequest(value)
  const route = matrixCompanyRoute(input)
  const read = route.method === 'GET'

  signal.throwIfAborted()

  const response = await fetch(`${resource}${route.path}`, {
    method: route.method,
    headers: { Authorization: `Bearer ${grant.accessToken}`, Accept: 'application/json',
      'Atum-Company-Wire': route.wire,
      ...(route.profile ? { [route.profile.header]: route.profile.value } : {}),
      ...(!read ? { 'Content-Type': 'application/json' } : {}) },
    ...(!read ? { body: JSON.stringify(route.body) } : {}),
    redirect: 'error', credentials: 'omit', cache: 'no-store', signal
  })

  if (response.status !== 200) {
    const code: MatrixCompanyErrorCode = REFUSAL_STATUS[response.status] ?? 'unavailable'
    const retry = response.headers.get('Retry-After')
    const seconds = retry !== null && /^\d+$/.test(retry) && Number(retry) >= 1 && Number(retry) <= 86400 ? Number(retry) : undefined
    const reason = await refusalReason(response, matrixCompanyRefusalFamily(input.action))
    throw new MatrixCompanyError(code, code === 'limit' ? seconds : undefined, reason)
  }

  if (!response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()
    throw new MatrixCompanyError('unavailable')
  }

  try {
    const data = await readDomainJson(response, 2 * 1024 * 1024)
    signal.throwIfAborted()

    return parseMatrixCompanyResponse(data, input)
  } catch {
    // A 200 may represent a committed mutation. An unreadable projection must
    // preserve the request as an uncertain outcome, not invite a fresh UUID.
    throw new MatrixCompanyError('unavailable')
  }
}
