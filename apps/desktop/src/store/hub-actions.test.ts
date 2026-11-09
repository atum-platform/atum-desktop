import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hermes = vi.hoisted(() => ({
  getActionStatus: vi.fn(),
  installSkillFromHub: vi.fn(),
  uninstallSkillFromHub: vi.fn(),
  updateSkillsFromHub: vi.fn()
}))

vi.mock('@/hermes', () => hermes)
vi.mock('@/lib/query-client', () => ({ queryClient: { invalidateQueries: vi.fn() } }))
vi.mock('@/store/activity', () => ({ upsertDesktopActionTask: vi.fn() }))
vi.mock('@/store/profile', async () => {
  const { atom } = await import('nanostores')

  return {
    $activeGatewayProfile: atom('default'),
    normalizeProfileKey: (value: null | string | undefined) => value?.trim() || 'default'
  }
})

import { $activeGatewayProfile } from '@/store/profile'

import {
  $hubActions,
  $hubInstalledOverride,
  hubTargetKey,
  installHubSkill,
  installHubSkillFor,
  uninstallHubSkillFor,
  withHubIdentifierLock
} from './hub-actions'

describe('hub actions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    hermes.installSkillFromHub.mockReset()
    hermes.getActionStatus.mockReset()
    $hubActions.set({})
    $hubInstalledOverride.set({})
    $activeGatewayProfile.set('default')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps explicit-target actions and clears legacy actions on a gateway profile switch', async () => {
    const pendingPolls: Array<(value: unknown) => void> = []

    hermes.installSkillFromHub
      .mockResolvedValueOnce({ name: 'legacy-action' })
      .mockResolvedValueOnce({ name: 'target-action' })
    hermes.getActionStatus.mockImplementation(
      () =>
        new Promise(resolvePromise => {
          pendingPolls.push(resolvePromise)
        })
    )

    const legacy = installHubSkill('official/creative/pixel-art')
    const target = installHubSkillFor({ profile: 'atum-alfred' }, 'official/finance/stocks')
    await vi.waitFor(() => expect(hermes.getActionStatus).toHaveBeenCalledTimes(2))

    $activeGatewayProfile.set('mkt-taylor')

    expect($hubActions.get()['official/creative/pixel-art']).toBeUndefined()
    expect($hubActions.get()[hubTargetKey('atum-alfred', 'official/finance/stocks')]?.running).toBe(true)

    // Drain both polls: the per-identifier queues are module state, and a
    // poll left pending here would block every later test on these skills.
    for (const resolvePromise of pendingPolls) {
      resolvePromise({ exit_code: 0, lines: ['done'], name: 'drained', pid: null, running: false })
    }

    await Promise.allSettled([legacy, target])
  })

  it('polls explicit actions on their spawning target and records the exit code', async () => {
    const target = { profile: 'atum-alfred' }
    const identifier = 'official/finance/stocks'
    hermes.installSkillFromHub.mockResolvedValue({ name: 'install-stocks' })
    hermes.getActionStatus.mockResolvedValue({
      exit_code: 0,
      lines: ['done'],
      name: 'install-stocks',
      pid: null,
      running: false
    })

    await installHubSkillFor(target, identifier)

    expect(hermes.getActionStatus).toHaveBeenCalledWith('install-stocks', 200, target)
    expect($hubActions.get()[hubTargetKey(target.profile, identifier)]?.exitCode).toBe(0)
  })

  it('does not mark a failed install as installed', async () => {
    const target = { profile: null }
    const identifier = 'official/creative/concept-diagrams'
    hermes.installSkillFromHub.mockResolvedValue({ name: 'install-diagram' })
    hermes.getActionStatus.mockResolvedValue({
      exit_code: 2,
      lines: ['installation failed'],
      name: 'install-diagram',
      pid: null,
      running: false
    })

    await installHubSkillFor(target, identifier)

    expect($hubInstalledOverride.get()[hubTargetKey(target.profile, identifier)]).toBeUndefined()
    expect($hubActions.get()[hubTargetKey(target.profile, identifier)]?.exitCode).toBe(2)
  })
  it('records a spawn failure for explicit targets so the row can show it', async () => {
    const target = { profile: 'atum-alfred' }
    const identifier = 'official/creative/pixel-art'
    hermes.installSkillFromHub.mockRejectedValue(new Error('backend offline'))

    await expect(installHubSkillFor(target, identifier)).rejects.toThrow('backend offline')

    const action = $hubActions.get()[hubTargetKey(target.profile, identifier)]
    expect(action?.running).toBe(false)
    expect(action?.exitCode).toBe(1)
    expect(action?.lines.at(-1)).toBe('backend offline')
  })

  it('leaves a legacy spawn failure to the caller, as before', async () => {
    hermes.installSkillFromHub.mockRejectedValue(new Error('backend offline'))

    await expect(installHubSkill('official/creative/pixel-art')).rejects.toThrow('backend offline')

    const action = $hubActions.get()['official/creative/pixel-art']
    expect(action?.running).toBe(false)
    expect(action?.exitCode).toBeNull()
  })
  it('queues a legacy hub install and an Atum install of the same identifier behind each other', async () => {
    const identifier = 'official/creative/pixel-art'
    let finishFirst: ((value: unknown) => void) | undefined

    const firstStatus = new Promise(resolvePromise => {
      finishFirst = resolvePromise
    })

    hermes.installSkillFromHub.mockResolvedValueOnce({ name: 'legacy' }).mockResolvedValueOnce({ name: 'atum' })
    hermes.getActionStatus
      .mockImplementationOnce(() => firstStatus)
      .mockResolvedValueOnce({ exit_code: 0, lines: ['done'], name: 'atum', pid: null, running: false })

    const legacy = installHubSkill(identifier)
    const atum = installHubSkillFor({ profile: 'atum-alfred' }, identifier)
    await vi.waitFor(() => expect(hermes.installSkillFromHub).toHaveBeenCalledTimes(1))

    for (let tick = 0; tick < 5; tick += 1) {
      await Promise.resolve()
    }

    // The Atum install must not have spawned while the legacy one runs.
    expect(hermes.installSkillFromHub).toHaveBeenCalledTimes(1)

    finishFirst!({ exit_code: 0, lines: ['done'], name: 'legacy', pid: null, running: false })
    await Promise.all([legacy, atum])

    expect(hermes.installSkillFromHub).toHaveBeenCalledTimes(2)
  })

  it('releases the identifier turn when a queued task rejects, and resolves uninstall names inside the turn', async () => {
    const identifier = 'official/finance/stocks'
    const order: string[] = []

    await expect(
      withHubIdentifierLock(identifier, async () => {
        order.push('first')
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    hermes.uninstallSkillFromHub.mockResolvedValue({ name: 'remove-stocks' })
    hermes.getActionStatus.mockResolvedValue({ exit_code: 0, lines: ['done'], name: 'remove-stocks', pid: null, running: false })

    await uninstallHubSkillFor({ profile: 'atum-alfred' }, identifier, async () => {
      order.push('resolve-name')

      return 'stocks-fresh-name'
    })

    expect(order).toEqual(['first', 'resolve-name'])
    expect(hermes.uninstallSkillFromHub).toHaveBeenCalledWith('stocks-fresh-name', { profile: 'atum-alfred' })
  })
})
