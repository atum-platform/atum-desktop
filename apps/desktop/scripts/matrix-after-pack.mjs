import path from 'node:path'
import { extractFile } from '@electron/asar'
import { Arch } from 'electron-builder'

import { assertRuntimeLicensePolicy, auditRuntimeLicenses } from './audit-runtime-licenses.mjs'
import { writeMatrixLocalizedName } from './matrix-app-name.mjs'
import { assertMatrixUsageDescriptions } from './matrix-usage-descriptions.mjs'
import { stageAtumDisclaimLauncher } from './stage-atum-disclaim-launcher.mjs'
import { stageBundledRuntime, stageComputerDriver } from './stage-bundled-runtime.mjs'
import { stageDriveEngine } from './stage-drive-engine.mjs'
import { stageLocalBrain } from './stage-local-brain.mjs'
import { stageMatrixPublicConfig } from './stage-matrix-public-config.mjs'
import { assertThirdPartyNotices, readBundledPackagesFromAsar, writeThirdPartyNotices } from './third-party-notices.mjs'
import { desktopServicesConfigFromEnvironment, writeDesktopServicesConfig } from './write-desktop-services-config.mjs'

/**
 * Electron fuses for the device-runtime hardening (WS-4, S1 build plan §4). Flipped right before the
 * packager's signing pass so the signature covers them.
 *
 * - `EnableNodeOptionsEnvironmentVariable` / `EnableNodeCliInspectArguments` OFF: a device command
 *   cannot inject `NODE_OPTIONS` or `--inspect` to escape into a debugged Node (the device host builds a
 *   clean env already; this closes the binary-level door too).
 * - `EnableEmbeddedAsarIntegrityValidation` ON + `OnlyLoadAppFromAsar` ON: the app only runs its signed
 *   `app.asar`, so a tampered or substituted bundle will not load.
 *
 * `RunAsNode` OFF: the local-brain supervisor uses the bundle's existing verified
 * browser Node payload, preserving its detached process-group cleanup. No extra
 * runtime or changed provider transport is needed.
 */
export async function applyDeviceRuntimeFuses(appPath, { flip } = {}) {
  const fuses = await import('@electron/fuses')
  const flipFuses = flip ?? fuses.flipFuses
  await flipFuses(appPath, {
    version: fuses.FuseVersion.V1,
    resetAdHocDarwinSignature: true,
    [fuses.FuseV1Options.RunAsNode]: false,
    [fuses.FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [fuses.FuseV1Options.EnableNodeCliInspectArguments]: false,
    [fuses.FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [fuses.FuseV1Options.OnlyLoadAppFromAsar]: true
  })
}

/** Reporting and update-feed settings for the bundle. A public release reports to the
 * production projects (PO1); which one a release may use is checked by the release
 * environment (release-matrix-mac.mjs), not here, so a local package can still use test. */
export function matrixServicesConfig(environment) {
  return desktopServicesConfigFromEnvironment(environment)
}

export default async function matrixAfterPack(
  context,
  {
    stage = stageBundledRuntime,
    stageBrain = stageLocalBrain,
    stageComputer = stageComputerDriver,
    stageDrive = stageDriveEngine,
    auditRuntime = auditRuntimeLicenses,
    assertRuntimePolicy = assertRuntimeLicensePolicy,
    readStamp = resources => JSON.parse(extractFile(path.join(resources, 'app.asar'), 'matrix-build-stamp.json')),
    servicesConfig = matrixServicesConfig,
    writeServicesConfig = writeDesktopServicesConfig,
    localizeName = writeMatrixLocalizedName,
    checkUsageDescriptions = assertMatrixUsageDescriptions,
    stagePublicConfig = stageMatrixPublicConfig,
    readBundled = readBundledPackagesFromAsar,
    writeNotices = writeThirdPartyNotices,
    assertNotices = assertThirdPartyNotices,
    stageDisclaimLauncher = stageAtumDisclaimLauncher,
    applyFuses = applyDeviceRuntimeFuses,
    environment = process.env
  } = {}
) {
  const arch = Arch[context.arch]
  if (context.electronPlatformName !== 'darwin' || arch !== 'arm64') {
    throw new Error('The Matrix candidate currently accepts only macOS arm64 bundles')
  }
  const product = context.packager.appInfo.productFilename
  const resources = path.join(context.appOutDir, `${product}.app`, 'Contents', 'Resources')
  const stamp = readStamp(resources)
  if (stamp?.dirty !== false || !/^[a-f0-9]{40}$/.test(stamp?.commit ?? '') || /^0+$/.test(stamp.commit)) {
    throw new Error('Commit the candidate source and rebuild before packaging')
  }
  // Finder, the Dock and Launchpad say "Atum" while the bundle keeps its file name
  // (matrix-app-name.mjs); written before signing seals the bundle.
  localizeName(resources)
  // Every permission prompt says why, Vietnamese first, never Electron's developer text
  // (FR3, matrix-usage-descriptions.mjs). Checked on the packed bundle, before signing.
  checkUsageDescriptions(path.join(context.appOutDir, `${product}.app`))
  // Reuse the existing lock/hash/ancestry/relocation-aware packager, not legacy
  // afterPack: that hook also configures the old production auth plane and UI.
  const manifest = stage({ targetRoot: path.join(resources, 'runtime'), platform: 'darwin', arch })
  if (manifest.hermes?.dirtyCheckoutIgnored !== false || manifest.identity?.runtimeCommit !== stamp.commit) {
    throw new Error('Candidate UI and bundled Hermes must come from the same clean commit')
  }
  stageComputer({ resources, arch })
  const inventory = await auditRuntime({ runtimeRoot: path.join(resources, 'runtime') })
  assertRuntimePolicy(inventory)
  // Matrix deliberately does not package the legacy public config because it
  // carries the old account/auth plane. This file contains only the public
  // reporting and updater-feed settings consumed by the Matrix composition.
  servicesConfig(environment)
  stageDrive({
    manifestFile: environment.ATUM_DRIVE_ENGINE_MANIFEST ?? path.resolve('build/drive-engine/manifest.json'),
    targetRoot: path.join(resources, 'drive-engine'),
    requireDeveloperId: context.packager.config?.forceCodeSigning === true
  })
  await stageBrain({ targetRoot: path.join(resources, 'local-brain'), platform: 'darwin', arch })
  // The open-source notices (FD3) for exactly what is now staged: extraResources put the licence
  // texts in Resources/licenses; this adds THIRD-PARTY-NOTICES.txt for the engine above, Electron
  // and the npm packages this build bundled, then refuses a bundle whose notice is incomplete.
  writeNotices({
    resources,
    electronVersion: context.packager.config?.electronVersion,
    bundled: readBundled(resources)
  })
  assertNotices({ resources })
  // The production endpoints a fresh install opens with (AC1); an operator file in
  // Application Support still wins (electron/matrix/launch-config.ts).
  stagePublicConfig({ resources })
  // The device host (WS-4) is spawned through this signed launcher so agent commands never inherit
  // Atum's TCC grants. It lives in Resources next to local-brain and is signed with the app.
  stageDisclaimLauncher({ platform: 'darwin', arch, output: path.join(resources, 'atum-disclaim-launcher') })
  writeServicesConfig({ environment, outputPath: path.join(resources, 'atum-desktop-services.json') })
  // Flip the device-runtime fuses just before the packager signs the bundle.
  await applyFuses(path.join(context.appOutDir, `${product}.app`))
}
