import { describe, expect, it, vi } from 'vitest'
import { Arch } from 'electron-builder'
import { RUNTIME_LICENSE_INVENTORY_SCHEMA, assertRuntimeLicensePolicy } from './audit-runtime-licenses.mjs'
import matrixAfterPack, { matrixServicesConfig } from './matrix-after-pack.mjs'

const commit = '1'.repeat(40)
const context = {
  electronPlatformName: 'darwin',
  arch: Arch.arm64,
  appOutDir: '/fixture/output',
  packager: { appInfo: { productFilename: 'Atum Matrix Candidate' }, config: { electronVersion: '40.10.2' } }
}
const bundled = [{ name: 'matrix-js-sdk', version: '42.4.0' }]
const dependencies = () => ({
  readStamp: vi.fn(() => ({ commit, dirty: false })),
  stage: vi.fn(() => ({ identity: { runtimeCommit: commit }, hermes: { dirtyCheckoutIgnored: false } })),
  stageBrain: vi.fn(async () => ({})),
  stageDrive: vi.fn(() => ({})),
  auditRuntime: vi.fn(async () => ({ issues: [] })),
  assertRuntimePolicy: vi.fn(),
  servicesConfig: vi.fn(() => ({ schemaVersion: 1, observability: { environment: 'test' } })),
  writeServicesConfig: vi.fn(),
  localizeName: vi.fn(() => ['en', 'vi']),
  checkUsageDescriptions: vi.fn(),
  stagePublicConfig: vi.fn(() => ({ path: '/fixture', sha256: 'a'.repeat(64) })),
  readBundled: vi.fn(() => bundled),
  writeNotices: vi.fn(() => ({})),
  assertNotices: vi.fn(() => ({})),
  stageDisclaimLauncher: vi.fn(),
  applyFuses: vi.fn(async () => {})
})
describe('Matrix-only runtime staging', () => {
  it('reuses the existing stager inside this bundle and binds it to the actual ASAR stamp', async () => {
    const deps = dependencies()
    await matrixAfterPack(context, deps)
    expect(deps.readStamp).toHaveBeenCalledWith('/fixture/output/Atum Matrix Candidate.app/Contents/Resources')
    expect(deps.stage).toHaveBeenCalledWith({
      targetRoot: '/fixture/output/Atum Matrix Candidate.app/Contents/Resources/runtime',
      platform: 'darwin',
      arch: 'arm64'
    })
    expect(deps.auditRuntime).toHaveBeenCalledWith({
      runtimeRoot: '/fixture/output/Atum Matrix Candidate.app/Contents/Resources/runtime'
    })
    expect(deps.writeServicesConfig).toHaveBeenCalledWith({
      environment: process.env,
      outputPath: '/fixture/output/Atum Matrix Candidate.app/Contents/Resources/atum-desktop-services.json'
    })
    expect(deps.stageBrain).toHaveBeenCalledWith({
      targetRoot: '/fixture/output/Atum Matrix Candidate.app/Contents/Resources/local-brain',
      platform: 'darwin',
      arch: 'arm64'
    })
    // A fresh install opens on the production endpoints carried in Resources (AC1).
    expect(deps.stagePublicConfig).toHaveBeenCalledWith({
      resources: '/fixture/output/Atum Matrix Candidate.app/Contents/Resources'
    })
  })
  it('refuses a bundle without a valid public configuration before recording service configuration', async () => {
    const deps = dependencies()
    deps.stagePublicConfig.mockImplementation(() => {
      throw new Error('matrix_public_config_invalid:unknown_field:token')
    })
    await expect(matrixAfterPack(context, deps)).rejects.toThrow('matrix_public_config_invalid')
    expect(deps.writeServicesConfig).not.toHaveBeenCalled()
  })
  it('writes the open-source notice for what it staged, from the bundle evidence, then checks it', async () => {
    const deps = dependencies()
    const resources = '/fixture/output/Atum Matrix Candidate.app/Contents/Resources'
    await matrixAfterPack(context, deps)
    expect(deps.readBundled).toHaveBeenCalledWith(resources)
    expect(deps.writeNotices).toHaveBeenCalledWith({ resources, electronVersion: '40.10.2', bundled })
    expect(deps.assertNotices).toHaveBeenCalledWith({ resources })
    // After the engine and the local brain are staged, so the notice covers them.
    expect(deps.writeNotices.mock.invocationCallOrder[0]).toBeGreaterThan(deps.stageDrive.mock.invocationCallOrder[0])
    expect(deps.writeNotices.mock.invocationCallOrder[0]).toBeGreaterThan(deps.stageBrain.mock.invocationCallOrder[0])
    expect(deps.assertNotices.mock.invocationCallOrder[0]).toBeGreaterThan(deps.writeNotices.mock.invocationCallOrder[0])
  })
  it('refuses a bundle whose notice is missing or incomplete before recording service configuration', async () => {
    const deps = dependencies()
    deps.assertNotices.mockImplementation(() => {
      throw new Error('third_party_notices_invalid:notice_missing')
    })
    await expect(matrixAfterPack(context, deps)).rejects.toThrow('third_party_notices_invalid:notice_missing')
    expect(deps.stagePublicConfig).not.toHaveBeenCalled()
    expect(deps.writeServicesConfig).not.toHaveBeenCalled()
  })
  it('refuses a build without its bundled-package evidence', async () => {
    const deps = dependencies()
    deps.readBundled.mockImplementation(() => {
      throw new Error('third_party_notices_invalid:bundled_packages_unreadable')
    })
    await expect(matrixAfterPack(context, deps)).rejects.toThrow('bundled_packages_unreadable')
    expect(deps.writeNotices).not.toHaveBeenCalled()
  })
  it('names the app Atum in every language of the bundle it packed, before signing', async () => {
    const deps = dependencies()
    await matrixAfterPack(context, deps)
    expect(deps.localizeName).toHaveBeenCalledWith('/fixture/output/Atum Matrix Candidate.app/Contents/Resources')
  })
  it('checks every permission sentence of the packed bundle after naming it, and refuses a bundle without them', async () => {
    const deps = dependencies()
    await matrixAfterPack(context, deps)
    expect(deps.checkUsageDescriptions).toHaveBeenCalledWith('/fixture/output/Atum Matrix Candidate.app')
    expect(deps.localizeName.mock.invocationCallOrder[0]).toBeLessThan(deps.checkUsageDescriptions.mock.invocationCallOrder[0])

    const refused = dependencies()
    refused.checkUsageDescriptions.mockImplementation(() => {
      throw new Error('matrix_usage_descriptions_invalid:base_unusable:NSCameraUsageDescription')
    })
    await expect(matrixAfterPack(context, refused)).rejects.toThrow('matrix_usage_descriptions_invalid')
    expect(refused.stage).not.toHaveBeenCalled()
  })

  it('stages the disclaim launcher into Resources and flips the device-runtime fuses on the app bundle', async () => {
    const deps = dependencies()
    await matrixAfterPack(context, deps)
    expect(deps.stageDisclaimLauncher).toHaveBeenCalledWith({
      platform: 'darwin',
      arch: 'arm64',
      output: '/fixture/output/Atum Matrix Candidate.app/Contents/Resources/atum-disclaim-launcher'
    })
    expect(deps.applyFuses).toHaveBeenCalledWith('/fixture/output/Atum Matrix Candidate.app')
  })

  it('disables Electron Node mode along with injection routes before signing', async () => {
    const { applyDeviceRuntimeFuses } = await import('./matrix-after-pack.mjs')
    const fuses = await import('@electron/fuses')
    const flip = vi.fn(async () => {})
    await applyDeviceRuntimeFuses('/x/App.app', { flip })
    const config = flip.mock.calls[0][1]
    expect(config.resetAdHocDarwinSignature).toBe(true)
    expect(config[fuses.FuseV1Options.RunAsNode]).toBe(false)
    expect(config[fuses.FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(false)
    expect(config[fuses.FuseV1Options.EnableNodeCliInspectArguments]).toBe(false)
    expect(config[fuses.FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(true)
    expect(config[fuses.FuseV1Options.OnlyLoadAppFromAsar]).toBe(true)
  })
  it('refuses a runtime-less Drive package before recording service configuration', async () => {
    const deps = dependencies()
    deps.stageDrive.mockImplementation(() => {
      throw new Error('drive_engine_package_invalid')
    })
    await expect(matrixAfterPack(context, deps)).rejects.toThrow('drive_engine_package_invalid')
    expect(deps.writeServicesConfig).not.toHaveBeenCalled()
  })
  it('refuses packaging when the pinned local-brain resource cannot be staged', async () => {
    const deps = dependencies()
    deps.stageBrain.mockRejectedValue(new Error('local_brain_package_invalid'))
    await expect(matrixAfterPack(context, deps)).rejects.toThrow('local_brain_package_invalid')
    expect(deps.writeServicesConfig).not.toHaveBeenCalled()
  })
  it('refuses a staged restricted runtime before local-brain staging or signing can continue', async () => {
    const deps = dependencies()
    const inventory = {
      schema: RUNTIME_LICENSE_INVENTORY_SCHEMA,
      issues: [{ code: 'packaged_restricted_skill', path: 'hermes-agent/skills/productivity/docx' }]
    }
    deps.auditRuntime.mockResolvedValue(inventory)
    deps.assertRuntimePolicy = assertRuntimeLicensePolicy

    await expect(matrixAfterPack(context, deps)).rejects.toThrow('packaged_restricted_skill')
    expect(deps.stage).toHaveBeenCalledTimes(1)
    expect(deps.stageDrive).not.toHaveBeenCalled()
    expect(deps.stageBrain).not.toHaveBeenCalled()
    expect(deps.writeServicesConfig).not.toHaveBeenCalled()
  })
  it.each([
    { commit, dirty: true },
    { commit: '0'.repeat(40), dirty: false },
    {},
    { commit: 'not-a-commit', dirty: false }
  ])('refuses an unattested source before staging', async stamp => {
    const deps = dependencies()
    deps.readStamp.mockReturnValue(stamp)
    await expect(matrixAfterPack(context, deps)).rejects.toThrow('Commit the candidate')
    expect(deps.stage).not.toHaveBeenCalled()
    expect(deps.localizeName).not.toHaveBeenCalled()
  })
  it.each([
    { identity: { runtimeCommit: '2'.repeat(40) }, hermes: { dirtyCheckoutIgnored: false } },
    { identity: { runtimeCommit: commit }, hermes: { dirtyCheckoutIgnored: true } }
  ])('refuses drift between renderer build and backend staging', async manifest => {
    const deps = dependencies()
    deps.stage.mockReturnValue(manifest)
    await expect(matrixAfterPack(context, deps)).rejects.toThrow('same clean commit')
  })
  it('does not silently produce an unsupported or runtime-less artifact', async () => {
    const deps = dependencies()
    await expect(matrixAfterPack({ ...context, arch: Arch.x64 }, deps)).rejects.toThrow('only macOS arm64')
    await expect(matrixAfterPack({ ...context, electronPlatformName: 'linux' }, deps)).rejects.toThrow('only macOS arm64')
    expect(deps.stage).not.toHaveBeenCalled()
  })
  it('accepts production reporting for the public build, and still a test configuration locally (PO1)', () => {
    const reporting = {
      ATUM_PUBLIC_POSTHOG_KEY: 'phc_productionKey123',
      ATUM_PUBLIC_POSTHOG_HOST: 'https://us.i.posthog.com',
      ATUM_PUBLIC_SENTRY_DSN: 'https://public@o1.ingest.us.sentry.io/2'
    }
    for (const environment of ['production', 'test']) {
      expect(
        matrixServicesConfig({ ...reporting, ATUM_PUBLIC_REPORTING_ENVIRONMENT: environment }).observability.environment
      ).toBe(environment)
    }
    expect(() => matrixServicesConfig({ ...reporting, ATUM_PUBLIC_REPORTING_ENVIRONMENT: 'staging' })).toThrow(
      'Invalid reporting environment'
    )
  })
})
