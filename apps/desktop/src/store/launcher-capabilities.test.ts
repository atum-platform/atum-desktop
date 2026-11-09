import { beforeEach, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getSkills: vi.fn(),
  getLauncherReadiness: vi.fn(),
  addBundledSkill: vi.fn(),
  toggleSkill: vi.fn()
}))

const insert = vi.hoisted(() => vi.fn())
const launch = vi.hoisted(() => vi.fn())
vi.mock('@/hermes', () => api)
vi.mock('@/app/chat/composer/focus', () => ({ requestComposerInsert: insert }))
vi.mock('./native-apps', () => ({ launchNativeApp: launch }))
vi.mock('./atum-messaging', async () => ({ $atumAccountScopeId: (await import('nanostores')).atom('account') }))
vi.mock('./profile', async () => ({
  $gatewaySwapTarget: (await import('nanostores')).atom(null),
  normalizeProfileKey: (key: string) => key || 'default'
}))
vi.mock('./session', async () => ({ $currentCwd: (await import('nanostores')).atom('/work') }))
vi.mock('./workbench-tabs', async () => ({
  $workbenchScope: (await import('nanostores')).atom(''),
  ATUM_CHAT_WORKBENCH_SCOPE_PREFIX: 'atum-chat:'
}))

import { $actionPanelEpoch, $actionPanelOwner, panelOwnerKey } from './action-panel-owner'
import {
  $launcherCapabilities,
  addBundledLauncherSkill,
  enableLauncherSkill,
  launchLauncherApp,
  prepareLauncherSetup,
  prepareLauncherSkill,
  refreshLauncherCapabilities
} from './launcher-capabilities'
import { $workbenchScope } from './workbench-tabs'

const owner = {
  accountId: 'account',
  connectionId: 'connection',
  backend_id: 'backend',
  agent_id: 'agent',
  profile: 'writer',
  version: 1 as const,
  submission_dedup: true
}

let scope: string
const app = { id: 'ppt', name: 'PowerPoint', bundleId: 'com.microsoft.Powerpoint' }

const support = {
  runtime: { kind: 'local', generation: 'r' },
  commands: { 'My Skill_+': '/my-skill' },
  bundled: [{ name: 'powerpoint' }],
  verified_bundled: [],
  routes: {}
}

beforeEach(() => {
  vi.resetAllMocks()
  $actionPanelOwner.set(owner)
  $actionPanelEpoch.set(1)
  scope = `atum-chat:${panelOwnerKey()}:chat`
  $workbenchScope.set(scope)
  api.getSkills.mockResolvedValue([
    { name: 'My Skill_+', enabled: true },
    { name: 'disabled', enabled: false }
  ])
  api.getLauncherReadiness.mockResolvedValue(support)
})

it('uses the backend canonical command and keeps it scoped without sending', async () => {
  await refreshLauncherCapabilities(scope)
  expect(api.getSkills).toHaveBeenCalledWith({ profile: 'writer' })
  expect(prepareLauncherSkill('My Skill_+', scope)).toBe(true)
  expect(insert).toHaveBeenCalledWith(
    '/my-skill',
    expect.objectContaining({ mode: 'prefix', scope: expect.objectContaining({ scopeKey: scope }) })
  )
  expect(prepareLauncherSkill('disabled', scope)).toBe(false)
})
it('ignores late readiness responses after an owner change', async () => {
  let complete!: (value: unknown) => void
  api.getLauncherReadiness.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        complete = resolve
      })
  )
  const pending = refreshLauncherCapabilities(scope)
  $actionPanelEpoch.set(2)
  complete(support)
  await pending
  expect($launcherCapabilities.get().support).toBeNull()
  expect(prepareLauncherSkill('My Skill_+', scope)).toBe(false)
})
it('prepares setup help for an installed skill without installing or sending', async () => {
  await refreshLauncherCapabilities(scope)
  expect(prepareLauncherSetup('My Skill_+', scope, 'Help me set up this skill.')).toBe(true)
  expect(insert).toHaveBeenCalledWith('Help me set up this skill.', expect.objectContaining({ mode: 'prefix' }))
  expect(api.addBundledSkill).not.toHaveBeenCalled()
  expect(prepareLauncherSetup('missing', scope, 'setup')).toBe(false)
  $actionPanelEpoch.set(2)
  expect(prepareLauncherSetup('My Skill_+', scope, 'setup')).toBe(false)
})
it('pins enable and included add to the captured assistant and never automatically launches', async () => {
  await refreshLauncherCapabilities(scope)
  await enableLauncherSkill('disabled', scope)
  expect(api.toggleSkill).toHaveBeenCalledWith('disabled', true, { profile: 'writer' })
  await addBundledLauncherSkill('powerpoint', scope)
  expect(api.addBundledSkill).toHaveBeenCalledWith('powerpoint', { profile: 'writer' })
  expect(insert).not.toHaveBeenCalled()
  expect(launch).not.toHaveBeenCalled()
})
it('prepares only after a completed assisted launch and preserves normal app launching without a handshake', async () => {
  await refreshLauncherCapabilities(scope)
  launch.mockResolvedValueOnce({ id: 'pair', status: 'choose-window', app })
  await launchLauncherApp(app, scope, { skillName: 'My Skill_+' })
  expect(insert).not.toHaveBeenCalled()
  launch.mockResolvedValueOnce({ id: 'pair', status: 'beside', app })
  await launchLauncherApp(app, scope, { windowId: 2, skillName: 'My Skill_+' })
  expect(insert).toHaveBeenCalledTimes(1)
  $actionPanelOwner.set(null)
  launch.mockResolvedValueOnce({ id: 'normal', status: 'opened', app })
  expect(await launchLauncherApp(app, scope, { normal: true })).toMatchObject({ status: 'opened' })
})
