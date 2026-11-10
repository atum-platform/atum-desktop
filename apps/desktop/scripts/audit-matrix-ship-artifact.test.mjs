import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { finished } from 'node:stream/promises'

import { createPackage } from '@electron/asar'
import { afterEach, expect, it } from 'vitest'

import { REQUIRED_RUNTIME_COMPONENTS } from './audit-runtime-licenses.mjs'
import { auditMatrixShipArtifact, MODULE_MANIFESTS, SHIPPED_CONTRACT_MODULES } from './audit-matrix-ship-artifact.mjs'
import { writeNoticesFixture } from './third-party-notices.fixture.mjs'

const directories = []
afterEach(async () => Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))))

const commit = 'a'.repeat(40)
const baseline = {
  upstreamHermesCommit: 'b'.repeat(40),
  atumOverlayCommit: 'c'.repeat(40),
  atumOverlayTree: 'd'.repeat(40)
}
const servicesConfig = {
  schemaVersion: 1,
  updateFeedUrl: 'https://updates.example/matrix',
  observability: {
    posthogKey: 'phc_12345678',
    posthogHost: 'https://us.i.posthog.com',
    sentryDsn: 'https://public@o1.ingest.sentry.io/1',
    environment: 'production'
  }
}
const expected = {
  sourceCommit: commit,
  runtimeBaseline: baseline,
  bundleIdentifier: 'com.atum.matrix',
  publicConfig: {
    issuer: 'https://issuer.example/',
    server: 'https://matrix.example/',
    nativeClientId: 'matrix-native',
    appWorkspace: true,
    domain: { nativeClientId: 'domain-native', resource: 'https://domain.example/' },
    reporting: { environment: 'production', providerIds: { posthog: 'phc_12345678', sentry: 'o1' } }
  },
  servicesConfig
}
const googleDesktopClient = JSON.stringify({ installed: { client_id: 'matrix.apps.googleusercontent.com', client_secret: 'desktop-public-client-configuration' } })

async function fixture({ module = 'electron/matrix/main.ts', service = servicesConfig, mainSource = '', archiveOverrides = {}, missingArchiveFiles = [], notices = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atum-matrix-ship-audit-'))
  directories.push(root)
  const app = path.join(root, 'Atum Matrix.app')
  const resources = path.join(app, 'Contents', 'Resources')
  const input = path.join(root, 'asar-input')
  await mkdir(resources, { recursive: true })
  await mkdir(input, { recursive: true })
  const archiveFiles = {
    'package.json': JSON.stringify({ name: 'atum-matrix', version: '1.0.0', main: 'matrix-main.mjs' }),
    'matrix-build-stamp.json': JSON.stringify({ commit, dirty: false, source: 'git' }),
    'matrix-main.mjs': mainSource, 'matrix-ui-preload.js': '', 'matrix-sdk-preload.js': '', 'matrix-pages-preload.js': '', 'matrix-sdk.js': '', 'matrix-sdk.html': '', 'matrix.html': '',
    'matrix-main-modules.json': JSON.stringify([module]),
    'matrix-ui-preload-modules.json': JSON.stringify(['electron/matrix/preload.ts']),
    'matrix-sdk-preload-modules.json': JSON.stringify(['electron/matrix/sdk-preload.ts']),
    'matrix-pages-preload-modules.json': JSON.stringify(['electron/matrix/pages-preload.ts']),
    'matrix-renderer-modules.json': JSON.stringify(['src/matrix/app.tsx']),
    'matrix-pet.html': '', 'matrix-pet-preload.js': '',
    'matrix-pet-preload-modules.json': JSON.stringify(['electron/matrix/pet-overlay-preload.ts', 'shared/matrix-pet-overlay.ts']),
    'matrix-pet-modules.json': JSON.stringify(['src/matrix/pet/overlay-root.tsx', 'shared/pet.ts']),
    'assets/google-desktop-client.json': googleDesktopClient,
    'pages/matrix-pages-modules.json': JSON.stringify(['src/matrix/pages.tsx']),
    'matrix-bundled-packages.json': JSON.stringify([{ name: 'dev-sdk', version: '3.0.0' }])
  }
  Object.assign(archiveFiles, archiveOverrides)
  for (const name of missingArchiveFiles) delete archiveFiles[name]
  for (const [name, content] of Object.entries(archiveFiles)) {
    const file = path.join(input, name)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  await finished(await createPackage(input, path.join(resources, 'app.asar')))
  await writeFile(path.join(resources, 'atum-desktop-services.json'), JSON.stringify(service))
  await writeFile(path.join(app, 'Contents', 'Info.plist'), '<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>com.atum.matrix</string></dict></plist>')
  const runtime = path.join(resources, 'runtime')
  await writeFile(path.join(runtime, 'runtime-manifest.json'), JSON.stringify({
    target: { platform: 'darwin', arch: 'arm64' },
    hermes: { dirtyCheckoutIgnored: false },
    identity: { runtimeCommit: commit, ...baseline, runtimeTree: 'e'.repeat(40) }
  }), { recursive: true }).catch(async error => {
    if (error.code !== 'ENOENT') throw error
    await mkdir(runtime, { recursive: true })
    await writeFile(path.join(runtime, 'runtime-manifest.json'), JSON.stringify({ target: { platform: 'darwin', arch: 'arm64' }, hermes: { dirtyCheckoutIgnored: false }, identity: { runtimeCommit: commit, ...baseline, runtimeTree: 'e'.repeat(40) } }))
  })
  for (const component of REQUIRED_RUNTIME_COMPONENTS) for (const license of component.licenses) {
    const file = path.join(runtime, license)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `license:${license}\n`)
  }
  await mkdir(path.join(runtime, 'browser', 'bin'), { recursive: true })
  await mkdir(path.join(runtime, 'browser', 'chromium'), { recursive: true })
  await writeFile(path.join(runtime, 'browser', 'bin', 'agent-browser'), '#!/bin/sh\n')
  await writeFile(path.join(runtime, 'browser', 'chromium', 'LICENSE.headless_shell'), 'chromium\n')
  if (notices) writeNoticesFixture(path.join(root, 'notices'), { resources })
  return app
}

it('audits a bounded Matrix ASAR and keeps inventory readiness separate from legal review', async () => {
  const app = await fixture()
  const receipt = await auditMatrixShipArtifact({ appRoot: app, expected, observedPublicConfig: expected.publicConfig })

  expect(receipt.observed.asar.entryCount).toBeGreaterThan(10)
  expect(receipt.observed.moduleManifests).toHaveLength(MODULE_MANIFESTS.length)
  expect(receipt.issues).toEqual([])
  expect(receipt.blocked).toEqual([{ code: 'runtime_license_legal_review_required', count: expect.any(Number) }])
  expect(receipt.blocked[0].count).toBeGreaterThan(0)
  expect(receipt.result).toBe('fail')
})

it('fails closed for a legacy module and mismatched source commit', async () => {
  const app = await fixture({ module: 'electron/main.ts' })
  const receipt = await auditMatrixShipArtifact({ appRoot: app, expected: { ...expected, sourceCommit: 'f'.repeat(40) }, observedPublicConfig: expected.publicConfig })

  expect(receipt.issues).toContainEqual({ code: 'legacy_or_fixture_module_packaged', path: 'matrix-main-modules.json', count: 1 })
  expect(receipt.issues).toContainEqual({ code: 'expected_source_commit_mismatch' })
})

// 0.19.0's main bundle ships the device-protocol contract packs (the cloud and device-service code
// imports them as data). They sit beside their pinned test fixtures, and the fixture rule flagged
// them as test fixtures: a release that was right failed its own audit. Each later pack the
// contract-packs module imports is added here by its exact path.
const OBSERVED_0215_CONTRACT_MODULES = [
  '../../packages/device-protocol/fixtures/agent-home/contract.json',
  '../../packages/device-protocol/fixtures/agent-home-v1.7/contract.json',
  '../../packages/device-protocol/fixtures/agent-sweep/contract.json',
  '../../packages/device-protocol/fixtures/agent-sweep-v1.1/contract.json',
  '../../packages/device-protocol/fixtures/cloud-execution-v1.11/contract.json'
]

it('ships the device-protocol contract packs the cloud code imports, and nothing else from a fixtures tree', async () => {
  for (const module of OBSERVED_0215_CONTRACT_MODULES) expect(SHIPPED_CONTRACT_MODULES).toContain(module)
  const shipped = JSON.stringify(['electron/matrix/main.ts', ...SHIPPED_CONTRACT_MODULES])
  const app = await fixture({ archiveOverrides: { 'matrix-main-modules.json': shipped } })
  const receipt = await auditMatrixShipArtifact({ appRoot: app, expected, observedPublicConfig: expected.publicConfig })

  expect(receipt.issues).toEqual([])
})

it.each([
  ['a test fixture beside a shipped pack', '../../packages/device-protocol/fixtures/device-service/fixtures/device-service.response.json'],
  ['a test fixture beside the cloud-execution pack', '../../packages/device-protocol/fixtures/cloud-execution/fixtures/managed-lineup-default.response.json'],
  ['a test fixture beside the agent-home pack', '../../packages/device-protocol/fixtures/agent-home/fixtures/answer.body.json'],
  ['a test fixture beside the agent-home 1.7 pack', '../../packages/device-protocol/fixtures/agent-home-v1.7/fixtures/answer-524289.body.json'],
  ['a test fixture beside the cloud-execution 1.11 pack', '../../packages/device-protocol/fixtures/cloud-execution-v1.11/fixtures/managed-admission-refusal-at-cap.response.json'],
  ['a pack the release does not ship', '../../packages/device-protocol/fixtures/workspace-transactions/contract.json'],
  ['a look-alike of a shipped pack', '../../packages/device-protocol/fixtures/device-service/contract.json.ts'],
  ['a pack at another root', 'packages/device-protocol/fixtures/device-service/contract.json'],
  ['a renderer fixture', 'src/matrix/playground/fixtures.ts']
])('still refuses %s', async (_label, module) => {
  const app = await fixture({
    archiveOverrides: { 'matrix-main-modules.json': JSON.stringify([...SHIPPED_CONTRACT_MODULES, module]) }
  })
  const receipt = await auditMatrixShipArtifact({ appRoot: app, expected, observedPublicConfig: expected.publicConfig })

  expect(receipt.issues).toContainEqual({ code: 'legacy_or_fixture_module_packaged', path: 'matrix-main-modules.json', count: 1 })
})

it('refuses a contract pack copied into the ASAR as a file, even one the main bundle may import', async () => {
  const app = await fixture({
    archiveOverrides: { 'packages/device-protocol/fixtures/device-service/contract.json': '{}' }
  })
  const receipt = await auditMatrixShipArtifact({ appRoot: app, expected, observedPublicConfig: expected.publicConfig })

  expect(receipt.issues).toContainEqual({
    code: 'legacy_or_fixture_asar_entry',
    path: 'packages/device-protocol/fixtures/device-service/contract.json'
  })
})

it('requires exact production inputs rather than treating a candidate or test config as production', async () => {
  const app = await fixture({ service: { ...servicesConfig, observability: { ...servicesConfig.observability, environment: 'test' } } })
  const receipt = await auditMatrixShipArtifact({ appRoot: app })

  expect(receipt.issues).toContainEqual({ code: 'expected_production_inputs_missing' })
  expect(receipt.issues).toContainEqual({ code: 'services_not_production' })
  expect(receipt.blocked).toContainEqual({ code: 'runtime_public_config_unobserved' })
})


it('binds the receipt to ASAR bytes, not just its unchanged entry index', async () => {
  const firstApp = await fixture({ mainSource: 'first bytes' })
  const secondApp = await fixture({ mainSource: 'second bytes' })
  const first = await auditMatrixShipArtifact({ appRoot: firstApp, expected, observedPublicConfig: expected.publicConfig })
  const second = await auditMatrixShipArtifact({ appRoot: secondApp, expected, observedPublicConfig: expected.publicConfig })

  expect(second.observed.asar.entryIndexSha256).toBe(first.observed.asar.entryIndexSha256)
  expect(second.observed.asar.sha256).not.toBe(first.observed.asar.sha256)
})

it('does not treat caller-supplied expected public config as observed runtime configuration', async () => {
  const app = await fixture()
  const receipt = await auditMatrixShipArtifact({ appRoot: app, expected })

  expect(receipt.observed.runtimePublicConfig).toBeUndefined()
  expect(receipt.blocked).toContainEqual({ code: 'runtime_public_config_unobserved' })
})

it.each([
  ['missing', { missingArchiveFiles: ['assets/google-desktop-client.json'] }],
  ['malformed', { archiveOverrides: { 'assets/google-desktop-client.json': '{' } }],
  ['invalid client shape', { archiveOverrides: { 'assets/google-desktop-client.json': JSON.stringify({ installed: { client_id: 'not-a-google-client' } }) } }]
])('fails artifact readiness for a %s Google desktop client without exposing its contents', async (_label, options) => {
  const app = await fixture(options)
  const receipt = await auditMatrixShipArtifact({ appRoot: app, expected, observedPublicConfig: expected.publicConfig })

  expect(receipt.issues).toContainEqual({ code: 'google_desktop_client_missing_or_invalid' })
  expect(JSON.stringify(receipt)).not.toContain('desktop-public-client-configuration')
})

it.each([
  ['package JSON', { archiveOverrides: { 'package.json': '{' } }, { code: 'package_json_unreadable' }],
  ['missing package JSON', { missingArchiveFiles: ['package.json'] }, { code: 'package_json_unreadable' }],
  ['build stamp JSON', { archiveOverrides: { 'matrix-build-stamp.json': '{' } }, { code: 'matrix_stamp_unreadable' }],
  ['missing build stamp JSON', { missingArchiveFiles: ['matrix-build-stamp.json'] }, { code: 'matrix_stamp_unreadable' }],
  ['module manifest JSON', { archiveOverrides: { 'matrix-main-modules.json': '{' } }, { code: 'matrix_module_manifest_unreadable', path: 'matrix-main-modules.json' }],
  ['missing module manifest JSON', { missingArchiveFiles: ['matrix-main-modules.json'] }, { code: 'matrix_module_manifest_unreadable', path: 'matrix-main-modules.json' }]
])('returns a bounded receipt for unreadable %s', async (_label, options, expectedIssue) => {
  const app = await fixture(options)
  const receipt = await auditMatrixShipArtifact({ appRoot: app, expected, observedPublicConfig: expected.publicConfig })

  expect(receipt.schema).toBe('atum.matrix-ship-artifact-receipt/1')
  expect(receipt.result).toBe('fail')
  expect(receipt.issues).toContainEqual(expectedIssue)
})

it('fails a package without its open-source notice (FD3)', async () => {
  const app = await fixture({ notices: false })
  const receipt = await auditMatrixShipArtifact({ appRoot: app, expected, observedPublicConfig: expected.publicConfig })

  expect(receipt.result).toBe('fail')
  expect(receipt.issues).toContainEqual({ code: 'third_party_notices_invalid', detail: 'notice_missing' })
  expect(receipt.issues).toContainEqual({ code: 'third_party_notices_invalid', detail: 'engine_manifest_missing' })
  expect(receipt.observed.thirdPartyNotices).toBeNull()
})

it('records the notice it checked, and requires the bundled-package evidence in app.asar', async () => {
  const app = await fixture({ missingArchiveFiles: ['matrix-bundled-packages.json'] })
  const receipt = await auditMatrixShipArtifact({ appRoot: app, expected, observedPublicConfig: expected.publicConfig })

  expect(receipt.observed.thirdPartyNotices).toMatchObject({ npmPackages: 5, engineComponents: 4, electronVersion: '40.10.2' })
  expect(receipt.issues).toContainEqual({ code: 'matrix_required_asar_entry_missing', path: 'matrix-bundled-packages.json' })
  expect(receipt.issues.filter(issue => issue.code === 'third_party_notices_invalid')).toEqual([])
})

it('returns one bounded unreadable-ASAR issue instead of throwing', async () => {
  const app = await fixture()
  await writeFile(path.join(app, 'Contents', 'Resources', 'app.asar'), 'not an ASAR archive\n')

  const receipt = await auditMatrixShipArtifact({ appRoot: app, expected, observedPublicConfig: expected.publicConfig })

  expect(receipt.schema).toBe('atum.matrix-ship-artifact-receipt/1')
  expect(receipt.result).toBe('fail')
  expect(receipt.issues.filter(issue => issue.code === 'asar_unreadable')).toEqual([{ code: 'asar_unreadable' }])
  expect(receipt.observed.asar).toMatchObject({ entryCount: 0, entryIndexSha256: null })
})

it.each(['matrix-pet.html', 'matrix-pet-preload.js'])('requires the overlay %s in the actual archive', async file => {
  const app = await fixture({ missingArchiveFiles: [file] })
  const receipt = await auditMatrixShipArtifact({ appRoot: app, expected, observedPublicConfig: expected.publicConfig })
  expect(receipt.issues).toContainEqual({ code: 'matrix_required_asar_entry_missing', path: file })
})
it.each([
  ['matrix-pet-modules.json', ['shared/matrix.ts'], 'matrix_pet_renderer_composition_invalid'],
  ['matrix-pet-preload-modules.json', ['electron/matrix/ui-preload.ts'], 'matrix_pet_preload_composition_invalid']
])('rejects a widened overlay graph in %s', async (file, modules, code) => {
  const app = await fixture({ archiveOverrides: { [file]: JSON.stringify(modules) } })
  const receipt = await auditMatrixShipArtifact({ appRoot: app, expected, observedPublicConfig: expected.publicConfig })
  expect(receipt.issues).toContainEqual({ code, path: file })
})

// Keep the allow-list synchronized with what contract-packs.ts actually bundles. Model the build
// and require every imported fixture to be an explicitly allowed shipped pack.
it('allows every contract pack the contract-packs module bundles', async () => {
  const { build } = await import('esbuild')
  const desktop = path.resolve(import.meta.dirname, '..')
  const result = await build({
    absWorkingDir: desktop,
    bundle: true,
    entryPoints: ['../../packages/device-protocol/contract-packs.ts'],
    metafile: true,
    platform: 'node',
    write: false,
    logLevel: 'silent'
  })
  const packs = Object.keys(result.metafile.inputs).filter(input => /\/fixtures\/[^/]+\/contract\.json$/u.test(input))

  expect(packs.length).toBeGreaterThan(0)
  for (const pack of packs) expect(SHIPPED_CONTRACT_MODULES).toContain(pack)
})
