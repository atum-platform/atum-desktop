import assert from 'node:assert/strict'

import { expect, test } from 'vitest'

import { AppSurfaceError, parseAppLaunchIssue, parseAppManifestResponse, parseBotPanelStatus, requiresPlatformConnection } from './protocol'

const origin = 'https://moon.atumplatform.com'

const manifest = {
  profile: 'atum.remote-app-manifest/1',
  manifest_version: '1.0.0',
  app: {
    id: '00000000-0000-4000-8000-e79acd97ac88',
    slug: 'moon',
    app_version_id: '00000000-0000-4000-8000-a9703d75e616',
    name: { vi: 'Moon', en: 'Moon' },
    verified: true,
    availability: 'available'
  },
  link: { mode: 'external_account', state: 'linked' },
  launch: { profile: 'atum.app-launch/1', path: '/atum/launch' },
  routes: [
    {
      id: 'readings',
      label: { vi: 'Lá số', en: 'Readings' },
      icon: 'moon',
      path: '/readings',
      placements: ['menu'],
      session: 'required'
    }
  ]
}

test('the shared manifest and launch parsers are transport-neutral and fail closed', () => {
  expect(parseAppManifestResponse({ manifest, web_origin: origin })).toMatchObject({
    web_origin: origin,
    manifest: { app: { slug: 'moon' }, routes: [{ id: 'readings' }] }
  })
  expect(
    parseAppLaunchIssue(
      { launch_url: `${origin}/atum/launch?code=${'Q'.repeat(43)}`, expires_at: '2026-09-23T00:00:00.000Z' },
      {
        webOrigin: origin,
        launchPath: '/atum/launch'
      }
    )
  ).toMatchObject({ expiresAt: Date.parse('2026-09-23T00:00:00.000Z') })

  assert.throws(
    () => parseAppManifestResponse({ manifest, web_origin: 'http://moon.atumplatform.com' }),
    AppSurfaceError
  )
  assert.throws(
    () =>
      parseAppLaunchIssue(
        { launch_url: `${origin}/atum/launch?code=short`, expires_at: '2026-09-23T00:00:00.000Z' },
        {
          webOrigin: origin,
          launchPath: '/atum/launch'
        }
      ),
    AppSurfaceError
  )
})

test('v2 and embed declarations use the frozen shapes for any app', () => {
  const value = parseAppManifestResponse({ web_origin: origin, manifest: { ...manifest,
    app: { ...manifest.app, slug: 'unknown-orchid' },
    launch: { profile: 'atum.app-launch/2', path: '/atum/launch' },
    embed: { profile: 'atum.panel/1', chrome: 'host' }
  } })

  expect(value.manifest.launch?.profile).toBe('atum.app-launch/2')
  expect(value.manifest.embed).toEqual({ profile: 'atum.panel/1', chrome: 'host' })
  expect(requiresPlatformConnection({ mode: 'none', state: 'never_linked' })).toBe(false)
  expect(requiresPlatformConnection({ mode: 'external_account', state: 'never_linked' })).toBe(true)
  expect(parseBotPanelStatus(null)).toBeNull()
  expect(() => parseBotPanelStatus({ profile: 'atum.bot-panel-status/1', attempt_id: 'spoof', state: 'linked', binding_revision: 1 })).toThrow()
})
