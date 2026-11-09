import { map } from 'nanostores'

import type { MatrixRoom } from '../../../shared/matrix'
import type { MatrixCompanyBridge, MatrixCompanyErrorCode } from '../../../shared/matrix-company'
import { readJson, writeJson } from '../../lib/storage'

import type { TeamSpaceProfile } from './abilities'
import { teamSpaceKey } from './keys'
import { requestTeamSpace } from './request'
import { channelViewFrom14, channelViewFromLegacy, type CompanyChannelView } from './views'

/**
 * Each company's channel directory as the platform admits this person: the 1.4 admitted
 * directory (public and private) when channel admission is active, the 1.1 company-wide one
 * otherwise. The wire a directory was read on is part of it, so a screen never mixes the two.
 *
 * Shared on purpose: the sidebar, the open channel's header and banner, the channel menu and
 * the palette all read the same directory, and none of them re-asks the platform.
 */
export interface CompanyChannelsState {
  wire?: '1.1' | '1.4'
  channels: readonly CompanyChannelView[]
  loading: boolean
  error?: MatrixCompanyErrorCode
  /** Last good rows kept for reading after a transient refresh failure; never authority. */
  stale?: true
  /** Wall-clock time of the last authoritative directory response. */
  lastSuccessAt?: number
}

const DEFINITIVE: ReadonlySet<MatrixCompanyErrorCode> = new Set(['authentication', 'denied', 'invalid', 'missing'])

export function channelAuthority(state: CompanyChannelsState | undefined): state is CompanyChannelsState {
  return Boolean(state) && !state?.error && !state?.stale
}

export const $companyChannels = map<Record<string, CompanyChannelsState>>({})

const storageKey = (accountKey: string) => `atum.team-space.channels.v1:${accountKey}`

export function discardStoredCompanyChannels(accountKey: string): void {
  writeJson(storageKey(accountKey), null)
}

function persistChannels(accountKey: string, companyId: string, state?: CompanyChannelsState): void {
  const value = readJson<Record<string, CompanyChannelsState>>(storageKey(accountKey))
  const saved = value && typeof value === 'object' && !Array.isArray(value) ? value : {}

  if (state) {saved[companyId] = state} else {delete saved[companyId]}
  writeJson(storageKey(accountKey), saved)
}

/** Restored rows can be read, but cannot grant admission or channel actions. */
function restoreChannels(accountKey: string, companyId: string): CompanyChannelsState | undefined {
  const key = teamSpaceKey(accountKey, companyId)
  const held = $companyChannels.get()[key]

  if (held) {return held}
  const saved = readJson<Record<string, CompanyChannelsState>>(storageKey(accountKey))?.[companyId]

  if (!saved || !['1.1', '1.4'].includes(saved.wire ?? '') || !Array.isArray(saved.channels) ||
    !saved.channels.every(channel => channel && channel.companyId === companyId &&
      typeof channel.id === 'string' && typeof channel.displayName === 'string' &&
      channel.wire === saved.wire && ['public', 'private'].includes(channel.visibility) && channel.room &&
      typeof channel.room.state === 'string')) {return undefined}

  const restored: CompanyChannelsState = {
    wire: saved.wire, channels: saved.channels, lastSuccessAt: saved.lastSuccessAt, loading: false, stale: true
  }

  $companyChannels.setKey(key, restored)

  return restored
}

// One sequence for every key, so an attempt number is never reused after a clear.
let sequence = 0
const attempts = new Map<string, number>()

export function clearCompanyChannels(accountKey: string, companyId?: string): void {
  if (companyId) {persistChannels(accountKey, companyId)}

  const doomed = (key: string) =>
    companyId ? key === teamSpaceKey(accountKey, companyId) : key.startsWith(`${accountKey}\n`)

  for (const key of attempts.keys()) {
    if (doomed(key)) {
      attempts.delete(key)
    }
  }

  $companyChannels.set(Object.fromEntries(Object.entries($companyChannels.get()).filter(([key]) => !doomed(key))))
}

/** The directory is about to be read: show the loader at once, keeping whatever list is on screen. */
export function markCompanyChannelsLoading(accountKey: string, companyId: string): void {
  const key = teamSpaceKey(accountKey, companyId)
  const before = restoreChannels(accountKey, companyId)

  if (!before?.loading) {
    $companyChannels.setKey(key, {
      channels: before?.channels ?? [],
      ...(before?.wire ? { wire: before.wire } : {}),
      ...(before?.lastSuccessAt !== undefined ? { lastSuccessAt: before.lastSuccessAt } : {}),
      ...(before?.stale || before?.error ? { stale: true as const } : {}),
      loading: true
    })
  }
}

/** The company is gone or refused: no list, and the reason. */
export function failCompanyChannels(accountKey: string, companyId: string, error: MatrixCompanyErrorCode): void {
  const key = teamSpaceKey(accountKey, companyId)
  const before = restoreChannels(accountKey, companyId)
  attempts.delete(key)
  persistChannels(accountKey, companyId)
  $companyChannels.setKey(key, {
    channels: [],
    loading: false,
    error,
    ...(before?.lastSuccessAt !== undefined ? { lastSuccessAt: before.lastSuccessAt } : {})
  })
}

/**
 * Read one company's directory on the wire the discovered profile selects. A newer read supersedes
 * an older one. A transient failure keeps the last good list visibly stale; an authoritative refusal clears it. Privacy never widens: a directory is replaced wholesale by the next one, never
 * merged, so a private channel that left the answer leaves the screen.
 */
export async function loadCompanyChannels(
  bridge: MatrixCompanyBridge,
  accountKey: string,
  companyId: string,
  profile: Pick<TeamSpaceProfile, 'channels'>,
  options: { quiet?: boolean; now?: () => number } = {}
): Promise<CompanyChannelsState> {
  const key = teamSpaceKey(accountKey, companyId)
  const attempt = ++sequence
  attempts.set(key, attempt)
  const before = restoreChannels(accountKey, companyId)

  if (!options.quiet) {
    $companyChannels.setKey(key, {
      channels: before?.channels ?? [],
      ...(before?.wire ? { wire: before.wire } : {}),
      ...(before?.lastSuccessAt !== undefined ? { lastSuccessAt: before.lastSuccessAt } : {}),
      ...(before?.stale || before?.error ? { stale: true as const } : {}),
      loading: true
    })
  }

  let next: CompanyChannelsState

  if (profile.channels) {
    const result = await requestTeamSpace(bridge, { action: 'admitted-channels', companyId })

    next = result.ok
      ? { wire: '1.4', channels: result.value.channels.map(channelViewFrom14), loading: false, lastSuccessAt: options.now?.() ?? Date.now() }
      : { channels: [], loading: false, error: result.error }
  } else {
    let result: Awaited<ReturnType<MatrixCompanyBridge['request']>>

    try {
      result = await bridge.request({ action: 'list-channels', companyId })
    } catch {
      result = { ok: false, error: 'unavailable' }
    }

    next = result.ok && 'channels' in result.value
      ? { wire: '1.1', channels: result.value.channels.filter(isLegacyItem).map(channelViewFromLegacy), loading: false, lastSuccessAt: options.now?.() ?? Date.now() }
      : { channels: [], loading: false, error: result.ok ? 'invalid' : result.error }
  }

  if (attempts.get(key) !== attempt) {
    return $companyChannels.get()[key] ?? next
  }

  const failed = next.error !== undefined

  if (failed && before?.lastSuccessAt !== undefined) {
    next = { ...next, lastSuccessAt: before.lastSuccessAt }
  }

  if (failed && before && !DEFINITIVE.has(next.error!)) {
    const kept: CompanyChannelsState = { ...before, loading: false, stale: true }
    $companyChannels.setKey(key, kept)

    return kept
  }

  persistChannels(accountKey, companyId, failed ? undefined : next)
  $companyChannels.setKey(key, next)

  return next
}

const isLegacyItem = (item: unknown): item is Parameters<typeof channelViewFromLegacy>[0] =>
  Boolean(item) && typeof item === 'object' && 'channel' in (item as object) && 'room' in (item as object)

export function channelViewForRoom(
  state: CompanyChannelsState | undefined,
  room: Pick<MatrixRoom, 'companyChannel'> | null | undefined
): CompanyChannelView | undefined {
  const channelId = room?.companyChannel?.channelId

  return channelId && channelAuthority(state)
    ? state.channels.find(channel => channel.id === channelId)
    : undefined
}
