import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  checkHermesUpdate,
  getActionStatus,
  getMemoryProviderConfig,
  getMessagingPlatforms,
  getSession,
  getSkills,
  getStatus,
  restartGateway,
  saveMemoryProviderConfig,
  setApiRequestProfile,
  testMessagingPlatform,
  toggleSkill,
  updateHermes,
  updateMessagingPlatform
} from './hermes'

// Contract: every backend-targeted action helper must carry the active gateway
// profile, so a multi-profile / global-remote user's restart, status poll, and
// update hit the backend they're actually on — not the primary/default. The
// System-panel "restart does nothing" bug was these helpers dropping it.
describe('backend action helpers are profile-scoped', () => {
  const api = vi.fn(async (_req: { path: string; profile?: string }) => ({}) as never)

  beforeEach(() => {
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = { api }
    api.mockClear()
  })

  afterEach(() => {
    setApiRequestProfile(null)
    delete (window as { hermesDesktop?: unknown }).hermesDesktop
  })

  const lastProfile = () => api.mock.calls.at(-1)?.[0].profile

  it('omits profile when none is active (single-profile users unaffected)', () => {
    void getStatus()
    expect(lastProfile()).toBeUndefined()
  })

  it('forwards the active profile to memory provider config calls', () => {
    setApiRequestProfile('coder')

    void getMemoryProviderConfig('honcho')
    void saveMemoryProviderConfig('honcho', { workspace: 'w' })

    for (const call of api.mock.calls) {
      expect(call[0].profile).toBe('coder')
    }
  })

  it('forwards the active profile to every backend action', () => {
    setApiRequestProfile('coder')

    void getStatus()
    void restartGateway()
    void updateHermes()
    void checkHermesUpdate()
    void getActionStatus('gateway-restart')
    void getMessagingPlatforms()
    void updateMessagingPlatform('telegram', { enabled: true })
    void testMessagingPlatform('telegram')

    for (const call of api.mock.calls) {
      expect(call[0].profile).toBe('coder')
    }
  })
})

describe('skill helpers can pin an assistant profile', () => {
  const api = vi.fn(async (_req: { path: string; profile?: string }) => ({}) as never)

  beforeEach(() => {
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = { api }
    api.mockClear()
  })

  afterEach(() => {
    setApiRequestProfile(null)
    delete (window as { hermesDesktop?: unknown }).hermesDesktop
  })

  it('uses an explicit skill target instead of whichever profile became active later', () => {
    setApiRequestProfile('new-active-profile')

    void getSkills({ profile: 'captured-assistant' })
    void toggleSkill('writing', true, { profile: 'captured-assistant' })

    for (const call of api.mock.calls) {
      expect(call[0].profile).toBe('captured-assistant')
    }
  })

  it('uses the primary backend when the captured assistant is default', () => {
    setApiRequestProfile('other-profile')
    void getSkills({ profile: null })

    expect(api.mock.calls.at(-1)?.[0].profile).toBeUndefined()
  })
})

// The mirror image of the contract above: a by-id session READ must be scoped
// by QUERY only. A `profile` in the request body routes through ensureBackend,
// which lazily spawns that profile's Python backend — about three seconds each.
// This helper is the probe used to find which agent owns a session, so a body
// field meant opening one chat could start every agent the user has made.
describe('getSession scopes by query, never by a backend-spawning body field', () => {
  const api = vi.fn(async (_req: { path: string; profile?: string }) => ({}) as never)

  beforeEach(() => {
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = { api }
    api.mockClear()
  })

  it('asks another agent by query and sends no profile in the body', async () => {
    await getSession('sess-1', 'marketing')

    const request = api.mock.calls[0]![0]

    expect(request.path).toBe('/api/sessions/sess-1?profile=marketing')
    expect('profile' in request).toBe(false)
  })

  it('sends neither when no agent is named', async () => {
    await getSession('sess-1')

    const request = api.mock.calls[0]![0]

    expect(request.path).toBe('/api/sessions/sess-1')
    expect('profile' in request).toBe(false)
  })
})
