import { atom } from 'nanostores'

import type { MatrixCompanyBridge } from '../../../shared/matrix-company'
import type { CompanyChannelBrowse16Response, CompanyInviteReadiness } from '../../../shared/matrix-company-team-space'

import { LEGACY_DISCOVERY, type TeamSpaceDiscovery, teamSpaceProfile } from './abilities'
import { requestTeamSpace, type TeamSpaceResult } from './request'

/**
 * What the server says Team Space can do, for the signed-in account. It is one question per
 * account, asked on entry and again with the workspace's quiet refresh, never per control.
 *
 * - The server's own answer is kept, and replaced only by a newer answer.
 * - A 404/400 means a server that predates discovery: C1/C2 are off, exactly the 1.1 client.
 * - Any other failure keeps what was known (a refresh that fails must not take features away
 *   mid-sentence, nor invent them); before a first answer it reads as "unknown", which gates like
 *   legacy and is asked again.
 */
export interface TeamSpaceDiscoveryState {
  accountKey: string
  discovery: TeamSpaceDiscovery
}

export const $teamSpaceDiscovery = atom<TeamSpaceDiscoveryState | undefined>(undefined)

/**
 * Which invite methods the server is configured for (company-invites/1, 2 or 3), asked once per account beside discovery.
 * `unsupported` is an older server: the invite sheet keeps today's methods (handle, directory, link for admins).
 */
export type TeamSpaceInviteReadiness = { state: 'unknown' } | { state: 'unsupported' } | { state: 'ready'; value: CompanyInviteReadiness }

/** The newest readiness profile first: 3 (direct add), 2 (mail delivery state), then 1. */
const READINESS_PROFILES = ['3', '2', undefined] as const
type ReadinessProfile = (typeof READINESS_PROFILES)[number]

export interface TeamSpaceInviteReadinessState {
  accountKey: string
  readiness: TeamSpaceInviteReadiness
}

export const $teamSpaceInviteReadiness = atom<TeamSpaceInviteReadinessState | undefined>(undefined)

const inflight = new Map<string, Promise<TeamSpaceDiscovery>>()
const readinessInflight = new Map<string, Promise<TeamSpaceInviteReadiness>>()
/**
 * Per account, the newest readiness profile its server has not refused. A 400 steps down one profile; the step is
 * forgotten after a while, so a server upgraded under a running app (a deploy) is seen without a restart.
 */
const readinessProfile = new Map<string, { profile: ReadinessProfile; at: number }>()
export const READINESS_PROFILE_RECHECK_MS = 10 * 60_000
const joinableBrowse = new Map<string, CompanyChannelBrowse16Response>()
const joinableBrowseInflight = new Map<string, Promise<TeamSpaceResult<'browse-joinable-channels'>>>()
let latestAccountKey: string | undefined
let joinableBrowseEpoch = 0

function browseKey(accountKey: string, companyId: string): string {
  return `${accountKey}\u0000${companyId}`
}

/** The current answer for this account; unknown when it was never asked or belongs to another account. */
export function currentTeamSpaceDiscovery(accountKey: string): TeamSpaceDiscovery {
  const state = $teamSpaceDiscovery.get()

  return state?.accountKey === accountKey ? state.discovery : { state: 'unknown' }
}

export function currentTeamSpaceProfile(accountKey: string) {
  return teamSpaceProfile(currentTeamSpaceDiscovery(accountKey))
}

export function loadTeamSpaceDiscovery(
  bridge: MatrixCompanyBridge,
  accountKey: string,
  options: { force?: boolean } = {}
): Promise<TeamSpaceDiscovery> {
  if (latestAccountKey !== undefined && latestAccountKey !== accountKey) {
    joinableBrowse.clear()
    joinableBrowseInflight.clear()
    joinableBrowseEpoch += 1
  }

  latestAccountKey = accountKey

  const known = $teamSpaceDiscovery.get()

  if (!options.force && known?.accountKey === accountKey && known.discovery.state !== 'unknown') {
    return Promise.resolve(known.discovery)
  }

  const pending = inflight.get(accountKey)

  if (pending) {
    return pending
  }

  const run = (async () => {
    const result = await requestTeamSpace(bridge, { action: 'capabilities' })
    const previous = currentTeamSpaceDiscovery(accountKey)

    const next: TeamSpaceDiscovery = result.ok
      ? { state: 'discovered', capabilities: result.value }
      : result.error === 'missing' || result.error === 'invalid'
        ? LEGACY_DISCOVERY
        : previous

    // A late answer for an account that has since been replaced is not for this window.
    if (latestAccountKey === accountKey) {
      $teamSpaceDiscovery.set({ accountKey, discovery: next })
    }

    return next
  })().finally(() => inflight.delete(accountKey))

  inflight.set(accountKey, run)

  return run
}

export function currentTeamSpaceInviteReadiness(accountKey: string): TeamSpaceInviteReadiness {
  const state = $teamSpaceInviteReadiness.get()

  return state?.accountKey === accountKey ? state.readiness : { state: 'unknown' }
}

/**
 * Reads invite readiness for this account. A refusal (400/404) or the plain 1.3 capabilities (an older server ignores
 * the profile header) is `unsupported`; a failure, a malformed answer included, keeps what was known. A late answer for a replaced account is dropped.
 */
export function loadTeamSpaceInviteReadiness(
  bridge: MatrixCompanyBridge,
  accountKey: string,
  options: { force?: boolean } = {}
): Promise<TeamSpaceInviteReadiness> {
  const known = currentTeamSpaceInviteReadiness(accountKey)

  if (!options.force && known.state !== 'unknown') {
    return Promise.resolve(known)
  }

  const pending = readinessInflight.get(accountKey)

  if (pending) {
    return pending
  }

  const run = (async () => {
    // A server that predates a profile refuses its header (400, `invalid`): ask the next older one, and remember it.
    const remembered = readinessProfile.get(accountKey)
    let profile: ReadinessProfile = remembered && Date.now() - remembered.at < READINESS_PROFILE_RECHECK_MS
      ? remembered.profile
      : READINESS_PROFILES[0]
    let result = await requestTeamSpace(bridge, { action: 'invite-readiness', ...(profile ? { profile } : {}) })

    while (!result.ok && result.error === 'invalid' && profile !== undefined) {
      profile = READINESS_PROFILES[READINESS_PROFILES.indexOf(profile) + 1]
      readinessProfile.set(accountKey, { profile, at: Date.now() })
      result = await requestTeamSpace(bridge, { action: 'invite-readiness', ...(profile ? { profile } : {}) })
    }

    // A plain 1.3 capabilities answer (the profile header ignored) is an older server, the same as a refusal.
    const next: TeamSpaceInviteReadiness = result.ok
      ? result.value.schemaVersion !== 4 ? { state: 'ready', value: result.value as CompanyInviteReadiness } : { state: 'unsupported' }
      : result.error === 'missing' || result.error === 'invalid'
        ? { state: 'unsupported' }
        : currentTeamSpaceInviteReadiness(accountKey)

    if (latestAccountKey === undefined || latestAccountKey === accountKey) {
      $teamSpaceInviteReadiness.set({ accountKey, readiness: next })
    }

    return next
  })().finally(() => readinessInflight.delete(accountKey))

  readinessInflight.set(accountKey, run)

  return run
}

/**
 * Direct-probes the additive 1.6 public-channel browse. It is intentionally separate from the
 * ordered capability prefix: older platforms answer missing/invalid and the dialog falls back to
 * the read-only 1.4 list. `force` is used immediately before Join so the command never relies on a
 * generation that was painted when the sheet first opened.
 */
export function loadJoinableChannelBrowse(
  bridge: MatrixCompanyBridge,
  accountKey: string,
  companyId: string,
  options: { force?: boolean } = {}
): Promise<TeamSpaceResult<'browse-joinable-channels'>> {
  const key = browseKey(accountKey, companyId)
  const known = joinableBrowse.get(key)

  if (!options.force && known) {
    return Promise.resolve({ ok: true, value: known })
  }

  const pending = joinableBrowseInflight.get(key)

  if (pending) {
    return pending
  }

  const epoch = joinableBrowseEpoch

  const run = requestTeamSpace(bridge, { action: 'browse-joinable-channels', companyId })
    .then(result => {
      if (result.ok && joinableBrowseEpoch === epoch) {
        joinableBrowse.set(key, result.value)
      }

      return result
    })
    .finally(() => joinableBrowseInflight.delete(key))

  joinableBrowseInflight.set(key, run)

  return run
}

/** Sign-out or account change: nothing discovered for one account is shown for another. */
export function clearTeamSpaceDiscovery(): void {
  latestAccountKey = undefined
  inflight.clear()
  readinessInflight.clear()
  readinessProfile.clear()
  $teamSpaceInviteReadiness.set(undefined)
  joinableBrowse.clear()
  joinableBrowseInflight.clear()
  joinableBrowseEpoch += 1
  $teamSpaceDiscovery.set(undefined)
}
