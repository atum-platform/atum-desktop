import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HermesConnection } from '@/global'
import type { ProfileInfo } from '@/types/hermes'

// Keep profile.ts's side-effecting imports inert: the gateway socket layer and
// the REST query client must not run for real in a unit test.
const ensureGatewayForProfile = vi.fn(async () => undefined)
const openGatewayForProfile = vi.fn(async (_profile: string) => undefined)
// A live socket. `ensureGatewayProfile`'s fast path tests for an OPEN one,
// not merely for the object's presence, so this carries a state.
const $gateway = atom<unknown>({ connectionState: 'open', id: 'live-socket' })
const resetStarmapGraph = vi.fn()
// The window's own backend. Only a POOLED agent's socket gets the liveness
// test — the primary is reconnected by the gateway boot loop, not here.
const isPrimaryProfile = vi.fn((profile: string) => profile === 'default')

vi.mock('@/store/gateway', () => ({ $gateway, ensureGatewayForProfile, isPrimaryProfile, openGatewayForProfile }))
vi.mock('@/hermes', () => ({
  getProfiles: vi.fn(async () => ({ profiles: [] })),
  setApiRequestProfile: vi.fn()
}))
vi.mock('@/lib/query-client', () => ({ invalidateProfileScopedQueries: vi.fn() }))
vi.mock('@/store/starmap', () => ({ resetStarmapGraph }))

const {
  $activeGatewayProfile,
  $profileAliases,
  $profilePins,
  $profiles,
  ensureGatewayProfile,
  prewarmProfileBackend,
  profileDisplayName,
  refreshProfiles,
  setProfileAlias,
  setProfilePinned,
  sortByProfilePinsAndOrder,
  toggleProfilePinned
} = await import('./profile')

const { $connection } = await import('./session')
const { invalidateProfileScopedQueries } = await import('@/lib/query-client')
const { getProfiles } = await import('@/hermes')
const { $atumAccountStatus, $atumStatus } = await import('@/store/atum-messaging')

const profile = (name: string, isDefault = false): ProfileInfo => ({
  has_env: false,
  is_default: isDefault,
  model: null,
  name,
  path: `/tmp/hermes/${name}`,
  provider: null,
  skill_count: 0
})

const remoteConn = (over: Partial<HermesConnection> = {}): HermesConnection =>
  ({ baseUrl: 'https://host.example.invalid', mode: 'remote', profile: 'vps-remote', ...over }) as HermesConnection

const localConn = (over: Partial<HermesConnection> = {}): HermesConnection =>
  ({ baseUrl: '', mode: 'local', profile: 'default', ...over }) as HermesConnection

const getConnection = vi.fn<(profile?: string | null) => Promise<HermesConnection>>()

function setAtumAccount(accountId: string | null) {
  $atumAccountStatus.set({
    account: accountId ? { displayName: accountId, id: accountId } : null,
    configured: true,
    errorCode: null,
    providers: { google: false, password: false },
    state: accountId ? 'signed_in' : 'signed_out'
  })
  $atumStatus.set(accountId ? ({ accountId, connectivity: 'online' } as never) : null)
}

beforeEach(() => {
  getConnection.mockReset()
  ensureGatewayForProfile.mockClear()
  openGatewayForProfile.mockClear()
  $gateway.set({ connectionState: 'open', id: 'live-socket' })
  $activeGatewayProfile.set('default')
  $profileAliases.set({})
  $profilePins.set([])
  $connection.set(localConn())
  $profiles.set([])
  setAtumAccount(null)
  vi.stubGlobal('window', { hermesDesktop: { getConnection } })
  vi.mocked(invalidateProfileScopedQueries).mockClear()
  resetStarmapGraph.mockClear()
})

afterEach(() => {
  setAtumAccount(null)
  vi.unstubAllGlobals()
  $connection.set(null)
})

describe('ensureGatewayProfile → $connection sync (#46651)', () => {
  it('refreshes $connection to the remote descriptor when activating a remote pool profile', async () => {
    // Regression: the primary window backend is local, so $connection.mode is
    // "local". Activating the remote profile must flip it to "remote" — without
    // this, image attach uses path-based image.attach against the remote
    // gateway ("image not found: C:\\…") instead of image.attach_bytes.
    getConnection.mockResolvedValue(remoteConn())

    await ensureGatewayProfile('vps-remote')

    expect(ensureGatewayForProfile).toHaveBeenCalledWith('vps-remote')
    expect(getConnection).toHaveBeenCalledWith('vps-remote')
    expect($connection.get()?.mode).toBe('remote')
    expect($connection.get()?.profile).toBe('vps-remote')
  })

  it('resyncs $connection back to local when returning to the default profile', async () => {
    $activeGatewayProfile.set('vps-remote')
    $connection.set(remoteConn())
    getConnection.mockResolvedValue(localConn())

    await ensureGatewayProfile('default')

    expect(getConnection).toHaveBeenCalledWith('default')
    expect($connection.get()?.mode).toBe('local')
  })

  it('leaves the prior connection intact when the descriptor fetch fails', async () => {
    getConnection.mockRejectedValue(new Error('backend unreachable'))

    await ensureGatewayProfile('vps-remote')

    // Best-effort: boot/reconnect resyncs later; we must not null it out here.
    expect($connection.get()?.mode).toBe('local')
  })

  it('does not churn $connection when the target is already the active profile', async () => {
    $activeGatewayProfile.set('vps-remote')
    $connection.set(remoteConn())

    await ensureGatewayProfile('vps-remote')

    expect(getConnection).not.toHaveBeenCalled()
    expect(ensureGatewayForProfile).not.toHaveBeenCalled()
    expect($connection.get()?.mode).toBe('remote')
  })

  it('leaves the primary alone when its socket is merely closed', async () => {
    // The gateway boot loop owns the primary's reconnect; ensureGatewayForProfile
    // returns immediately for it. Sending a closed primary into the swap path
    // would raise a "waking up" overlay for a swap that does nothing.
    $activeGatewayProfile.set('default')
    $gateway.set({ connectionState: 'closed', id: 'primary-socket' })

    await ensureGatewayProfile('default')

    expect(ensureGatewayForProfile).not.toHaveBeenCalled()
    expect(getConnection).not.toHaveBeenCalled()
  })

  it('reopens the active profile when its socket is closed, rather than wedging on it', async () => {
    // `ensureGatewayForProfile` activates a profile even when its socket failed
    // to open — it catches, schedules a reconnect, and still calls setActive.
    // So the atom is truthy while pointing at a dead socket. Testing for the
    // object alone made that permanent: every later attempt to open the same
    // agent short-circuited, with no spawn retry and no "waking up" overlay.
    $activeGatewayProfile.set('vps-remote')
    $gateway.set({ connectionState: 'closed', id: 'dead-socket' })

    await ensureGatewayProfile('vps-remote')

    expect(ensureGatewayForProfile).toHaveBeenCalledWith('vps-remote')
  })
})

describe('profile-scoped cache invalidation', () => {
  it('drops the memory graph cache when the active gateway profile changes', () => {
    $activeGatewayProfile.set('coder')

    expect(invalidateProfileScopedQueries).toHaveBeenCalled()
    expect(resetStarmapGraph).toHaveBeenCalledTimes(1)
  })
})

describe('prewarmProfileBackend (hover-intent pool spawn)', () => {
  it('opens the gateway (spawn + connect, no activation) for a non-active profile', () => {
    prewarmProfileBackend('warm-basic')

    expect(openGatewayForProfile).toHaveBeenCalledWith('warm-basic')
    // Pre-warm must never activate — that's the click's job.
    expect(ensureGatewayForProfile).not.toHaveBeenCalled()
  })

  it('skips the profile the gateway is already on', () => {
    $activeGatewayProfile.set('warm-active')

    prewarmProfileBackend('warm-active')

    expect(openGatewayForProfile).not.toHaveBeenCalled()
  })

  it('throttles repeat pre-warms for the same profile within the interval', () => {
    prewarmProfileBackend('warm-throttle-a')
    prewarmProfileBackend('warm-throttle-a')
    prewarmProfileBackend('warm-throttle-b')

    const calls = openGatewayForProfile.mock.calls.map(([name]) => name)
    expect(calls.filter(name => name === 'warm-throttle-a')).toHaveLength(1)
    expect(calls.filter(name => name === 'warm-throttle-b')).toHaveLength(1)
  })

  it('swallows spawn failures — error UX belongs to the real switch', () => {
    openGatewayForProfile.mockRejectedValueOnce(new Error('spawn failed'))

    expect(() => prewarmProfileBackend('warm-failing')).not.toThrow()
  })
})

describe('refreshProfiles shared rail list (#49289)', () => {
  it('removes a deleted profile from the shared $profiles cache after Manage Profiles refreshes', async () => {
    $profiles.set([profile('default', true), profile('test1')])
    vi.mocked(getProfiles).mockResolvedValueOnce({ profiles: [profile('default', true)] })

    await refreshProfiles()

    expect($profiles.get().map(profile => profile.name)).toEqual(['default'])
  })

  it('leaves the shared $profiles cache intact when the refresh fails', async () => {
    $profiles.set([profile('default', true), profile('test1')])
    vi.mocked(getProfiles).mockRejectedValueOnce(new Error('backend unavailable'))

    await expect(refreshProfiles()).rejects.toThrow('backend unavailable')

    expect($profiles.get().map(profile => profile.name)).toEqual(['default', 'test1'])
  })

  it('drops a deferred A response after an A → B → A account re-home', async () => {
    let release!: (value: { profiles: ProfileInfo[] }) => void
    vi.mocked(getProfiles).mockImplementationOnce(() => new Promise(resolve => {
      release = resolve
    }))

    setAtumAccount('account-a')
    const pending = refreshProfiles()
    setAtumAccount('account-b')
    setAtumAccount('account-a')
    release({ profiles: [profile('from-stale-a')] })

    await expect(pending).resolves.toEqual([])
    expect($profiles.get()).toEqual([])
  })
})

describe('profile cosmetic pins and aliases', () => {
  it('sorts pinned profiles first while preserving stored order within each group', () => {
    const profiles = [profile('atum-main'), profile('moon-dev'), profile('atum-moon'), profile('dev-ben')]

    expect(
      sortByProfilePinsAndOrder(profiles, ['atum-main', 'atum-moon'], ['moon-dev', 'atum-moon', 'dev-ben', 'atum-main'])
        .map(profile => profile.name)
    ).toEqual(['atum-moon', 'atum-main', 'moon-dev', 'dev-ben'])
  })

  it('toggles pinned profile keys by canonical name', () => {
    setProfilePinned('atum-main', true)
    setProfilePinned('atum-main', true)
    toggleProfilePinned('atum-main')

    expect($profilePins.get()).toEqual([])
  })

  it('uses cosmetic aliases without changing the underlying profile key', () => {
    setProfileAlias('atum-main', 'Atum')

    expect(profileDisplayName('atum-main', $profileAliases.get())).toBe('Atum')

    setProfileAlias('atum-main', '   ')

    expect(profileDisplayName('atum-main', $profileAliases.get())).toBe('atum-main')
  })
})
