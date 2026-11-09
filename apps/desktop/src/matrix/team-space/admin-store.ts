import { map } from 'nanostores'

import type { MatrixCompanyBridge, MatrixCompanyErrorCode } from '../../../shared/matrix-company'
import {
  type CompanyAdminSnapshot13Response,
  companyInvitationPolicy,
  companyPolicy3
} from '../../../shared/matrix-company-team-space'

import { teamSpaceKey } from './keys'
import { requestTeamSpace, type TeamSpaceResult } from './request'

/**
 * The 1.3 administration snapshot of each company: the viewer's role, the single owner, member
 * roles and admission epochs, pending invitations and the channel-creation policy. It is the
 * authority for who may do what; the 1.1 snapshot supplies only names and photos.
 */
export interface CompanyAdminState {
  snapshot?: CompanyAdminSnapshot13Response
  error?: MatrixCompanyErrorCode
  loading: boolean
}

export const $companyAdmin = map<Record<string, CompanyAdminState>>({})

// One sequence for every key, so an attempt number is never reused after a clear.
let sequence = 0
const attempts = new Map<string, number>()
/**
 * The administration read each account uses: policy 1.3 (who may add directly), 1.2 (who may invite) or the plain 1.3
 * snapshot. A server that refuses or ignores a profile steps the account down one read; the step is forgotten after a
 * while, so a server upgraded under a running app is read with the newer profile without a restart.
 */
type PolicyRead = '1.3' | '1.2' | 'plain'
const POLICY_READS: readonly PolicyRead[] = ['1.3', '1.2', 'plain']
const policyReads = new Map<string, { read: PolicyRead; at: number }>()
export const POLICY_READ_RECHECK_MS = 10 * 60_000

function policyReadFor(accountKey: string): PolicyRead {
  const remembered = policyReads.get(accountKey)

  return remembered && Date.now() - remembered.at < POLICY_READ_RECHECK_MS ? remembered.read : '1.3'
}

function stepDown(accountKey: string, from: PolicyRead): PolicyRead {
  const read = POLICY_READS[Math.min(POLICY_READS.indexOf(from) + 1, POLICY_READS.length - 1)]!

  policyReads.set(accountKey, { read, at: Date.now() })

  return read
}

function readAdministration(bridge: MatrixCompanyBridge, companyId: string, read: PolicyRead) {
  return read === 'plain'
    ? requestTeamSpace(bridge, { action: 'administration', companyId })
    : requestTeamSpace(bridge, { action: 'administration-policy', companyId, ...(read === '1.3' ? { profile: '1.3' as const } : {}) })
}

export function clearCompanyAdmin(accountKey: string, companyId?: string): void {
  if (!companyId) {
    policyReads.delete(accountKey)
  }

  const doomed = (key: string) =>
    companyId ? key === teamSpaceKey(accountKey, companyId) : key.startsWith(`${accountKey}\n`)

  for (const key of attempts.keys()) {
    if (doomed(key)) {
      attempts.delete(key)
    }
  }

  $companyAdmin.set(Object.fromEntries(Object.entries($companyAdmin.get()).filter(([key]) => !doomed(key))))
}

/**
 * Read one company's administration snapshot. A newer read for the same company supersedes an
 * older one (a stale answer never overwrites newer intent). A quiet read keeps what is shown
 * through a failure; losing access (denied or gone) clears it either way.
 */
export async function loadCompanyAdmin(
  bridge: MatrixCompanyBridge,
  accountKey: string,
  companyId: string,
  options: { quiet?: boolean } = {}
): Promise<CompanyAdminSnapshot13Response | undefined> {
  const key = teamSpaceKey(accountKey, companyId)
  const attempt = ++sequence
  attempts.set(key, attempt)
  const before = $companyAdmin.get()[key]

  if (!options.quiet) {
    $companyAdmin.setKey(key, { ...before, loading: true })
  }

  // Policy 1.3 / 1.2 are the same snapshot plus who may add / invite. A server without a profile either refuses it (400,
  // `invalid`: ask again one read older) or ignores the header and answers an older snapshot, which main accepts as is.
  // Either way that account steps down, and with the plain read only owners and admins invite. A genuine failure (503, a
  // malformed answer: `unavailable`) is not an older server and never switches the read.
  let read = policyReadFor(accountKey)
  let result: TeamSpaceResult<'administration'> | TeamSpaceResult<'administration-policy'> = await readAdministration(bridge, companyId, read)

  while (!result.ok && result.error === 'invalid' && read !== 'plain' && attempts.get(key) === attempt) {
    read = stepDown(accountKey, read)
    result = await readAdministration(bridge, companyId, read)
  }

  if (attempts.get(key) !== attempt) {
    return undefined
  }

  if (result.ok) {
    // An answer older than the read asked for (the header ignored) steps the account down to what it answered.
    const answered: PolicyRead = companyPolicy3(result.value) ? '1.3' : companyInvitationPolicy(result.value) ? '1.2' : 'plain'

    if (POLICY_READS.indexOf(answered) > POLICY_READS.indexOf(read)) {
      policyReads.set(accountKey, { read: answered, at: Date.now() })
    }

    $companyAdmin.setKey(key, { snapshot: result.value, loading: false })

    return result.value
  }

  const lost = result.error === 'denied' || result.error === 'missing'
  const current = $companyAdmin.get()[key]

  $companyAdmin.setKey(key, {
    ...(lost ? {} : current?.snapshot ? { snapshot: current.snapshot } : {}),
    ...(options.quiet && !lost ? {} : { error: result.error }),
    loading: false
  })

  return undefined
}
