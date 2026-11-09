import { expect, it } from 'vitest'

import type { SkillInfo } from '@/types/hermes'

import { projectLauncherTiles } from './launcher-capabilities'
import type { LauncherCapabilityState } from './launcher-capability-types'

const ppt = { id: 'ppt', name: 'Microsoft PowerPoint', bundleId: 'com.microsoft.Powerpoint' }
const unknown = { id: 'unknown', name: 'A game', bundleId: 'game.app' }

const skill = (name: string, enabled = true) =>
  ({ name, enabled, description: name, category: 'productivity' }) as SkillInfo

const base: LauncherCapabilityState = {
  scopeKey: 'scope',
  profile: 'default',
  skills: [skill('powerpoint'), skill('xlsx'), skill('research')],
  loading: false,
  error: null,
  busySkill: null,
  support: {
    runtime: { kind: 'local', generation: 'a' },
    commands: { powerpoint: '/powerpoint' },
    bundled: [{ name: 'powerpoint', description: 'Slides', category: 'productivity' }],
    verified_bundled: ['powerpoint'],
    routes: {
      powerpoint: {
        operations: {
          read: { state: 'ready', reasons: [] },
          edit: { state: 'needs-setup', reasons: ['visual-qa-unverified'] }
        }
      }
    }
  }
}

it('keeps only installed apps, highlighting verified PowerPoint ahead of unsupported apps', () => {
  const tiles = projectLauncherTiles([unknown, ppt], base, [])
  expect(tiles.map(tile => [tile.id, tile.status])).toEqual([
    ['app:ppt', 'ready'],
    ['app:unknown', 'unsupported']
  ])
  expect(tiles[0]?.operations.edit?.state).toBe('needs-setup')
  expect(projectLauncherTiles([], base, [])).toEqual([])
  expect(base.skills.map(row => row.name)).toContain('research')
})
it('distinguishes included, disabled, unavailable, and unverified local-name collisions', () => {
  expect(projectLauncherTiles([ppt], { ...base, skills: [] }, [])[0]?.status).toBe('included')
  expect(projectLauncherTiles([ppt], { ...base, skills: [skill('powerpoint', false)] }, [])[0]?.status).toBe('disabled')
  expect(projectLauncherTiles([ppt], { ...base, error: 'offline' }, [])[0]?.status).toBe('unavailable')
  const state = { ...base, support: { ...base.support!, verified_bundled: [] } }
  const tiles = projectLauncherTiles([ppt], state, [])
  expect(tiles[0]?.status).toBe('ambiguous')
  expect(tiles.map(tile => tile.app.id)).toEqual([ppt.id])
})

it('orders successful recent use within readiness groups and falls back to alphabetical order', () => {
  const word = { id: 'word', name: 'Microsoft Word', bundleId: 'com.microsoft.Word' }
  const alpha = { id: 'alpha', name: 'Alpha', bundleId: 'alpha.app' }
  const recentUnknown = { id: 'recent', name: 'Zebra', bundleId: '' }

  const state = {
    ...base,
    skills: [...base.skills, skill('docx')],
    support: {
      ...base.support!,
      verified_bundled: ['docx', 'powerpoint'],
      routes: { ...base.support!.routes, docx: { operations: { read: { state: 'ready' as const, reasons: [] } } } }
    }
  }

  const apps = [recentUnknown, alpha, word, unknown, ppt]
  const history = { [word.bundleId]: 20, [ppt.bundleId]: 10, recent: 1000 }
  const ordered = projectLauncherTiles(apps, state, [], history)
  expect(ordered.map(tile => tile.app.id)).toEqual(['word', 'ppt', 'recent', 'unknown', 'alpha'])
  expect(projectLauncherTiles(apps, state, []).map(tile => tile.app.id)).toEqual(['ppt', 'word', 'unknown', 'alpha', 'recent'])
  expect(apps[0]).toBe(recentUnknown)
})
it('never marks remote or unprobed Office read capability ready', () => {
  const state = {
    ...base,
    support: {
      ...base.support!,
      routes: {
        powerpoint: { operations: { read: { state: 'unknown' as const, reasons: ['remote-runtime-unprobed'] } } }
      }
    }
  }

  expect(projectLauncherTiles([ppt], state, [])[0]?.status).toBe('needs-setup')
  expect(projectLauncherTiles([ppt], { ...base, support: { ...base.support!, routes: {} } }, [])[0]?.status).toBe(
    'needs-setup'
  )
})
