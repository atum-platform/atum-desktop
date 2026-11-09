import type { MatrixIdentity, MatrixSdkCommand } from '../../shared/matrix'

export interface OwnerReaderTrustEnrollment {
  executorId: string
  enrollmentId: string
  kind: 'owner_reader'
  ownerPrincipal: string
  ownerUserId: string
  agentPrincipal?: undefined
  agentUserId?: undefined
  deviceId: string
  enrollmentState: 'awaiting_trust'
  trust: 'pending'
  disclosureVersion: number
  ownerDevice: string
  handoffUntil: number
}

/** The human Matrix host can sign but never accepts a renderer-selected reader target. */
export interface MatrixOwnerReaderTrustPort {
  identity: MatrixIdentity
  command(value: Extract<MatrixSdkCommand, { kind: 'ownerReaderCrossSignDevice' | 'ownerReaderVerificationPrepare' | 'ownerReaderVerificationRead' | 'ownerReaderVerificationRespond' }>): Promise<unknown>
}

export interface OwnerReaderVerification {
  flowId: string
  ownerDevice: string
  deviceId: string
  decimal: [number,number,number]
  expiresAt: number
  state: 'pending' | 'confirmed' | 'cancelled' | 'expired'
}

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
const mxid = (value: unknown): value is string => typeof value === 'string' && /^@[^:\s]+:[^\s]+$/.test(value)
const device = (value: unknown): value is string => typeof value === 'string' && /^[!-~]{1,255}$/.test(value)

function valid(value: OwnerReaderTrustEnrollment, owner: MatrixIdentity, now: number): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    UUID.test(value.executorId) &&
    UUID.test(value.enrollmentId) &&
    UUID.test(value.ownerPrincipal) &&
    value.kind === 'owner_reader' &&
    mxid(value.ownerUserId) &&
    value.ownerUserId === owner.userId &&
    value.agentPrincipal === undefined &&
    value.agentUserId === undefined &&
    value.deviceId === `ATUM_COMPANION_${value.executorId}` &&
    device(value.deviceId) &&
    value.enrollmentState === 'awaiting_trust' &&
    value.trust === 'pending' &&
    Number.isSafeInteger(value.disclosureVersion) &&
    value.disclosureVersion >= 1 &&
    value.ownerDevice === owner.deviceId &&
    device(value.ownerDevice) &&
    Number.isSafeInteger(value.handoffUntil) &&
    value.handoffUntil > now
  )
}

function same(left: OwnerReaderTrustEnrollment, right: OwnerReaderTrustEnrollment): boolean {
  return [
    'executorId', 'enrollmentId', 'kind', 'ownerPrincipal', 'ownerUserId', 'deviceId', 'enrollmentState',
    'trust', 'disclosureVersion', 'ownerDevice', 'handoffUntil'
  ].every(key => left[key as keyof OwnerReaderTrustEnrollment] === right[key as keyof OwnerReaderTrustEnrollment]) &&
    left.agentPrincipal === right.agentPrincipal && left.agentUserId === right.agentUserId
}

/**
 * Executes the native half of the owner-reader handoff. `current()` is a fresh
 * server enrollment read supplied by the main lifecycle; it is called before and
 * after signing so stale, revoked, replaced, or expired handoffs cannot advance.
 * This deliberately does not mark provider trust or move secrets: the reader
 * requests its backup through standard own-user Matrix secret sharing afterward.
 */
export async function crossSignCurrentOwnerReader(input: {
  owner: MatrixOwnerReaderTrustPort
  current(): Promise<OwnerReaderTrustEnrollment>
  now?: () => number
}): Promise<{ executorId: string; enrollmentId: string; deviceId: string }> {
  const now = input.now ?? Date.now
  const before = await input.current()

  if (!valid(before, input.owner.identity, now())) {
    throw new Error('matrix_owner_reader_handoff_invalid')
  }

  await input.owner.command({ kind: 'ownerReaderCrossSignDevice', deviceId: before.deviceId })

  const after = await input.current()

  if (!valid(after, input.owner.identity, now()) || !same(before, after)) {
    throw new Error('matrix_owner_reader_handoff_stale')
  }

  return { executorId: before.executorId, enrollmentId: before.enrollmentId, deviceId: before.deviceId }
}

/** Compare the actual two SDK tuples through the authenticated domain. The
 * comparison receipt is followed by the SDK's own standard MAC exchange. */
export async function compareCurrentOwnerReader(input: {
  owner: MatrixOwnerReaderTrustPort
  current(): Promise<OwnerReaderTrustEnrollment>
  verification(body?: {flowId:string;ownerDevice:string;decimal:[number,number,number]}): Promise<OwnerReaderVerification | null>
  now?: () => number
}): Promise<void> {
  const now=input.now ?? Date.now
  const before=await input.current()

  if (!valid(before,input.owner.identity,now())) {throw Error('matrix_owner_reader_handoff_invalid')}
  await input.owner.command({kind:'ownerReaderVerificationPrepare',deviceId:before.deviceId,expiresAt:before.handoffUntil})
  const remote=await input.verification()

  if (!remote || remote.state !== 'pending') {return}

  if (remote.deviceId !== before.deviceId || remote.ownerDevice !== before.ownerDevice || !/^[!-~]{1,255}$/.test(remote.flowId) ||
    !Number.isSafeInteger(remote.expiresAt) || remote.expiresAt<=now() || remote.expiresAt>now()+120000 ||
    remote.expiresAt>before.handoffUntil || !Array.isArray(remote.decimal) || remote.decimal.length!==3 ||
    !remote.decimal.every(n=>Number.isSafeInteger(n) && n>=1000 && n<=9191)) {throw Error('matrix_owner_reader_invalid')}

  const local=await input.owner.command({kind:'ownerReaderVerificationRead',deviceId:before.deviceId}) as {flowId:string;decimal:[number,number,number]} | null

  if (!local) {return}

  if (local.flowId !== remote.flowId || !Array.isArray(local.decimal) || local.decimal.length!==3 ||
    !local.decimal.every(n=>Number.isSafeInteger(n) && n>=1000 && n<=9191)) {throw Error('matrix_owner_reader_stale')}

  const fresh=await input.current()

  if (!valid(fresh,input.owner.identity,now()) || !same(before,fresh) || remote.expiresAt<=now()) {throw Error('matrix_owner_reader_stale')}
  const matches=local.decimal.every((n,i)=>n === remote.decimal[i])
  const result=await input.verification({flowId:local.flowId,ownerDevice:before.ownerDevice,decimal:local.decimal})
  const after=await input.current()

  if (!valid(after,input.owner.identity,now()) || !same(before,after) || remote.expiresAt<=now() ||
    !result || result.flowId !== remote.flowId || result.ownerDevice !== before.ownerDevice || result.deviceId !== before.deviceId ||
    result.expiresAt !== remote.expiresAt || result.state !== (matches ? 'confirmed' : 'cancelled')) {throw Error('matrix_owner_reader_stale')}

  await input.owner.command({kind:'ownerReaderVerificationRespond',deviceId:before.deviceId,flowId:local.flowId,
    decimal:local.decimal,action:matches ? 'confirm' : 'mismatch'})
}
