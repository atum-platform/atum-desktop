#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { extractFile, listPackage } from '@electron/asar'

import { auditRuntimeLicenses } from './audit-runtime-licenses.mjs'
import { assertMatrixPetPresentationPaths } from './matrix-pet-composition.mjs'
import { GOOGLE_DESKTOP_CLIENT_ASAR_PATH, parseGoogleClient } from './stage-google-client.mjs'
import { auditThirdPartyNotices, BUNDLED_PACKAGES_FILE } from './third-party-notices.mjs'

export const MATRIX_SHIP_ARTIFACT_RECEIPT_SCHEMA = 'atum.matrix-ship-artifact-receipt/1'

export const REQUIRED_ASAR_FILES = Object.freeze([
  'package.json',
  'matrix-build-stamp.json',
  'matrix-main.mjs',
  'matrix-ui-preload.js',
  'matrix-sdk-preload.js',
  'matrix-pages-preload.js',
  'matrix-sdk.js',
  'matrix-sdk.html',
  'matrix.html',
  'matrix-pet.html',
  'matrix-pet-preload.js',
  'matrix-pet-preload-modules.json',
  'matrix-pet-modules.json',
  'matrix-main-modules.json',
  'matrix-ui-preload-modules.json',
  'matrix-sdk-preload-modules.json',
  'matrix-pages-preload-modules.json',
  'matrix-renderer-modules.json',
  'pages/matrix-pages-modules.json',
  BUNDLED_PACKAGES_FILE,
  GOOGLE_DESKTOP_CLIENT_ASAR_PATH
])

export const MODULE_MANIFESTS = REQUIRED_ASAR_FILES.filter(file => file.endsWith('-modules.json'))
export const FORBIDDEN_MODULE_PATH = /(?:src\/matrix\/playground\/|src\/hermes\.ts$|src\/themes\/context\.tsx$|src\/store\/(?:gateway|profile|session|atum-messaging)(?:\/|$)|electron\/atum-messaging\/|electron\/main\.ts$|(?:^|\/)fixtures?(?:\/|$)|(?:^|\/)legacy(?:\/|$))/iu
/**
 * The production contract packs the device service imports as data
 * (`packages/device-protocol/contract-packs.ts`). Each is vendored beside its own pinned test
 * fixtures under `fixtures/<pack>/`, byte-identical to atum-platform `spec/<pack>/v1`, and the
 * package's checker recomputes that pin there, so the packs keep their path. Exactly the packs
 * that module statically imports (relative to apps/desktop, as the build's module manifests record
 * them) may ship from a fixtures tree: any other fixture module, and any fixture file in the ASAR
 * itself, is refused.
 */
export const SHIPPED_CONTRACT_MODULES = Object.freeze([
  '../../packages/device-protocol/fixtures/agent-home/contract.json',
  '../../packages/device-protocol/fixtures/agent-home-v1.7/contract.json',
  '../../packages/device-protocol/fixtures/agent-home-v1.8/contract.json',
  '../../packages/device-protocol/fixtures/agent-sweep/contract.json',
  '../../packages/device-protocol/fixtures/agent-sweep-v1.1/contract.json',
  '../../packages/device-protocol/fixtures/agent-source-gates/contract.json',
  '../../packages/device-protocol/fixtures/agent-sources/contract.json',
  '../../packages/device-protocol/fixtures/agent-sweep-v2/contract.json',
  '../../packages/device-protocol/fixtures/cloud-answering/contract.json',
  '../../packages/device-protocol/fixtures/cloud-execution/contract.json',
  '../../packages/device-protocol/fixtures/cloud-execution-v1.11/contract.json',
  '../../packages/device-protocol/fixtures/device-service/contract.json',
  '../../packages/device-protocol/fixtures/device-workspace/contract.json',
  '../../packages/device-protocol/fixtures/chatgpt-relay/contract.json',
  '../../packages/device-protocol/fixtures/cloud-execution-v1.13/contract.json',
  '../../packages/device-protocol/fixtures/cloud-execution-v1.14/contract.json',
  '../../packages/device-protocol/fixtures/model-choice-v1.4/contract.json',
  '../../packages/device-protocol/fixtures/model-choice-v1.5/contract.json',
  '../../packages/device-protocol/fixtures/provider-connections/contract.json'
])
/** A bundled module the release must not contain: legacy roots, the playground, test fixtures. */
export function forbiddenModule(module) {
  return FORBIDDEN_MODULE_PATH.test(module) && !SHIPPED_CONTRACT_MODULES.includes(module)
}
const SHA1 = /^[a-f0-9]{40}$/u

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function fileDigest(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function receiptError(code, detail = '') {
  return new Error(`matrix_ship_artifact_invalid:${code}${detail ? `:${detail}` : ''}`)
}

function appFile(appRoot, ...segments) {
  const root = path.resolve(appRoot)
  const candidate = path.resolve(root, ...segments)
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw receiptError('app_path_escape')
  return candidate
}

async function readJson(file, code) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    throw receiptError(code, error instanceof Error ? error.message : String(error))
  }
}

function archiveJson(archive, name) {
  try {
    return JSON.parse(extractFile(archive, name).toString('utf8'))
  } catch {
    return null
  }
}

function archiveText(archive, name) {
  try {
    return extractFile(archive, name).toString('utf8')
  } catch {
    return null
  }
}

function add(results, code, detail = {}) {
  results.push({ code, ...detail })
}

function addOnce(results, code, detail = {}) {
  if (!results.some(issue => issue.code === code)) add(results, code, detail)
}

function jsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function expectedMatrixConfigValid(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const domain = value.domain
  const reporting = value.reporting
  const providerIds = reporting?.providerIds
  return typeof value.issuer === 'string' && value.issuer.length > 0 &&
    typeof value.server === 'string' && value.server.length > 0 &&
    typeof value.nativeClientId === 'string' && value.nativeClientId.length > 0 &&
    typeof value.appWorkspace === 'boolean' &&
    domain && typeof domain === 'object' && typeof domain.nativeClientId === 'string' && typeof domain.resource === 'string' &&
    reporting && typeof reporting === 'object' && reporting.environment === 'production' &&
    providerIds && typeof providerIds === 'object' && !Array.isArray(providerIds) &&
    ['posthog', 'sentry'].every(key => typeof providerIds[key] === 'string' && providerIds[key].length > 0)
}

function expectedBaselineValid(value) {
  return value && typeof value === 'object' && ['upstreamHermesCommit', 'atumOverlayCommit', 'atumOverlayTree'].every(key => SHA1.test(value[key] ?? ''))
}

function normalizeExpected(expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return null
  return expected
}

function publicServiceShape(config) {
  const observability = config?.observability
  return {
    schemaVersion: config?.schemaVersion,
    updateFeedConfigured: typeof config?.updateFeedUrl === 'string' && config.updateFeedUrl.length > 0,
    observability: observability && typeof observability === 'object'
      ? {
          environment: typeof observability.environment === 'string' ? observability.environment : null,
          providerFields: ['posthogKey', 'posthogHost', 'sentryDsn'].filter(key => typeof observability[key] === 'string' && observability[key].length > 0).sort()
        }
      : null
  }
}

function summarizeLicenses(manifest) {
  return {
    policy: manifest.policy,
    legalReview: manifest.legalReview,
    inventorySha256: digest(stable(manifest)),
    componentCount: manifest.components.length,
    discoveredLicenseCount: manifest.discoveredLicenses.length
  }
}

/**
 * Read a packaged Matrix app without loading any application code or using the
 * network. Expected production values are caller supplied; this module never
 * supplies a domain, issuer, workspace, provider id, or release commit.
 */
export async function auditMatrixShipArtifact({ appRoot, expected = null, observedPublicConfig = null } = {}) {
  if (typeof appRoot !== 'string' || !appRoot) throw receiptError('app_root')
  const appInfo = await lstat(appRoot).catch(() => null)
  if (!appInfo?.isDirectory() || appInfo.isSymbolicLink()) throw receiptError('app_root')

  const resources = appFile(appRoot, 'Contents', 'Resources')
  const archive = appFile(resources, 'app.asar')
  const runtimeRoot = appFile(resources, 'runtime')
  const issues = []
  const blocked = []
  const observed = {}
  const expectedInput = normalizeExpected(expected)

  const archiveInfo = await lstat(archive).catch(() => null)
  if (!archiveInfo?.isFile() || archiveInfo.isSymbolicLink()) {
    add(issues, 'asar_missing_or_unsafe')
  } else {
    let entries = null
    try {
      entries = listPackage(archive).map(entry => entry.replace(/^\//u, '')).sort()
    } catch {
      addOnce(issues, 'asar_unreadable')
    }
    let archiveSha256 = null
    try {
      archiveSha256 = await fileDigest(archive)
    } catch {
      addOnce(issues, 'asar_unreadable')
    }
    observed.asar = {
      entryCount: entries?.length ?? 0,
      entryIndexSha256: entries ? digest(entries.join('\n')) : null,
      sha256: archiveSha256
    }
    if (!entries?.length || !archiveSha256) {
      addOnce(issues, 'asar_unreadable')
    } else {
      for (const required of REQUIRED_ASAR_FILES) if (!entries.includes(required)) add(issues, 'matrix_required_asar_entry_missing', { path: required })
      for (const entry of entries) if (FORBIDDEN_MODULE_PATH.test(entry)) add(issues, 'legacy_or_fixture_asar_entry', { path: entry })

      const packageJson = jsonObject(archiveJson(archive, 'package.json'))
      if (!packageJson) {
        add(issues, 'package_json_unreadable')
        observed.package = { name: null, version: null, main: null }
      } else {
        observed.package = { name: packageJson.name ?? null, version: packageJson.version ?? null, main: packageJson.main ?? null }
        if (packageJson.main !== 'matrix-main.mjs') add(issues, 'matrix_entry_mismatch', { observed: packageJson.main ?? null })
        if (String(packageJson.name ?? '').includes('candidate')) add(issues, 'candidate_package_identity', { observed: packageJson.name })
      }

      const stamp = jsonObject(archiveJson(archive, 'matrix-build-stamp.json'))
      if (!stamp) {
        add(issues, 'matrix_stamp_unreadable')
        observed.source = { commit: null, dirty: null, source: null }
      } else {
        observed.source = { commit: stamp.commit ?? null, dirty: stamp.dirty ?? null, source: stamp.source ?? null }
        if (stamp.dirty !== false || !SHA1.test(stamp.commit ?? '') || /^0+$/u.test(stamp.commit ?? '')) add(issues, 'matrix_source_stamp_invalid')
      }

      // This is an installed-app client configuration, not an application
      // secret. Validate the same shape used by the main process, but never
      // record client values in the receipt.
      if (!parseGoogleClient(archiveText(archive, GOOGLE_DESKTOP_CLIENT_ASAR_PATH))) {
        add(issues, 'google_desktop_client_missing_or_invalid')
      }

      const moduleManifests = []
      for (const name of MODULE_MANIFESTS) {
        const modules = archiveJson(archive, name)
        if (modules === null) {
          add(issues, 'matrix_module_manifest_unreadable', { path: name })
          continue
        }
        if (!Array.isArray(modules) || modules.some(module => typeof module !== 'string')) {
          add(issues, 'matrix_module_manifest_invalid', { path: name })
          continue
        }
        if (name === 'matrix-pet-modules.json') {
          try { assertMatrixPetPresentationPaths(modules) }
          catch { add(issues, 'matrix_pet_renderer_composition_invalid', { path: name }) }
        }
        if (name === 'matrix-pet-preload-modules.json' &&
          (modules.length !== 2 || !modules.includes('electron/matrix/pet-overlay-preload.ts') || !modules.includes('shared/matrix-pet-overlay.ts'))) {
          add(issues, 'matrix_pet_preload_composition_invalid', { path: name })
        }
        const forbidden = modules.filter(forbiddenModule)
        if (forbidden.length) add(issues, 'legacy_or_fixture_module_packaged', { path: name, count: forbidden.length })
        moduleManifests.push({ path: name, count: modules.length, sha256: digest(modules.map(module => module.replace(/\/private\/tmp\/[^/]+/gu, '<temp>').replace(/^[A-Za-z]:\\[^\\]+/u, '<host>')).sort().join('\n')) })
      }
      observed.moduleManifests = moduleManifests.sort((a, b) => a.path.localeCompare(b.path, 'en'))
    }
  }

  const runtimeManifestFile = appFile(runtimeRoot, 'runtime-manifest.json')
  const runtimeManifest = await readJson(runtimeManifestFile, 'runtime_manifest_unreadable').catch(() => {
    add(issues, 'runtime_manifest_missing_or_invalid')
    return null
  })
  if (runtimeManifest) {
    const identity = runtimeManifest.identity ?? {}
    observed.runtime = { target: runtimeManifest.target ?? null, runtimeCommit: identity.runtimeCommit ?? null, identity: {
      upstreamHermesCommit: identity.upstreamHermesCommit ?? null,
      atumOverlayCommit: identity.atumOverlayCommit ?? null,
      atumOverlayTree: identity.atumOverlayTree ?? null,
      runtimeTree: identity.runtimeTree ?? null
    }, cleanSource: runtimeManifest.hermes?.dirtyCheckoutIgnored === false }
    if (runtimeManifest.target?.platform !== 'darwin' || runtimeManifest.target?.arch !== 'arm64') add(issues, 'runtime_target_mismatch')
    if (runtimeManifest.hermes?.dirtyCheckoutIgnored !== false) add(issues, 'runtime_dirty_source')
    if (!SHA1.test(identity.runtimeCommit ?? '')) add(issues, 'runtime_commit_invalid')
    if (observed.source?.commit && observed.source.commit !== identity.runtimeCommit) add(issues, 'matrix_runtime_commit_mismatch')
  }

  const serviceConfig = await readJson(appFile(resources, 'atum-desktop-services.json'), 'services_config_unreadable').catch(() => {
    add(issues, 'services_config_missing_or_invalid')
    return null
  })
  if (serviceConfig) {
    observed.services = publicServiceShape(serviceConfig)
    if (serviceConfig?.observability?.environment !== 'production') add(issues, 'services_not_production')
  }

  if (!expectedInput) {
    add(issues, 'expected_production_inputs_missing')
  } else {
    if (!SHA1.test(expectedInput.sourceCommit ?? '')) add(issues, 'expected_source_commit_invalid')
    else if (observed.source?.commit !== expectedInput.sourceCommit) add(issues, 'expected_source_commit_mismatch')
    if (!expectedBaselineValid(expectedInput.runtimeBaseline)) add(issues, 'expected_runtime_baseline_invalid')
    else if (runtimeManifest) {
      for (const key of ['upstreamHermesCommit', 'atumOverlayCommit', 'atumOverlayTree']) {
        if (runtimeManifest.identity?.[key] !== expectedInput.runtimeBaseline[key]) add(issues, 'expected_runtime_baseline_mismatch', { field: key })
      }
    }
    if (typeof expectedInput.bundleIdentifier !== 'string' || !expectedInput.bundleIdentifier) add(issues, 'expected_bundle_identifier_missing')
    // Info.plist is intentionally read as data only. The XML key/value pair is
    // enough for the receipt and avoids executing the app's plist tooling.
    const infoPlist = await readFile(appFile(appRoot, 'Contents', 'Info.plist'), 'utf8').catch(() => '')
    const identifier = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/u.exec(infoPlist)?.[1] ?? null
    observed.bundleIdentifier = identifier
    if (expectedInput.bundleIdentifier && identifier !== expectedInput.bundleIdentifier) add(issues, 'bundle_identifier_mismatch')
    if (!expectedMatrixConfigValid(expectedInput.publicConfig)) add(issues, 'expected_matrix_public_config_invalid')
    if (!expectedInput.servicesConfig || typeof expectedInput.servicesConfig !== 'object' || stable(serviceConfig) !== stable(expectedInput.servicesConfig)) add(issues, 'services_config_mismatch')
  }

  // Matrix launch configuration is app-data owned, not a value recoverable
  // from this candidate ASAR. Caller expectations are never evidence of what
  // a runtime observed. A separate supplied observation must match exactly.
  if (!expectedInput || !expectedMatrixConfigValid(expectedInput.publicConfig) || !observedPublicConfig || typeof observedPublicConfig !== 'object' || Array.isArray(observedPublicConfig)) {
    add(blocked, 'runtime_public_config_unobserved')
  } else if (stable(observedPublicConfig) !== stable(expectedInput.publicConfig)) {
    add(issues, 'runtime_public_config_mismatch')
  } else {
    observed.runtimePublicConfig = { observation: 'external_receipt', sha256: digest(stable(observedPublicConfig)) }
  }

  // The open-source notices (FD3): the notice, every licence text and Electron's notices are in
  // Resources/licenses and match what this bundle ships, the Drive engine included.
  const notices = auditThirdPartyNotices({ resources })
  observed.thirdPartyNotices = notices.observed
  for (const detail of notices.issues) add(issues, 'third_party_notices_invalid', { detail })

  let licenseManifest = null
  try {
    licenseManifest = await auditRuntimeLicenses({ runtimeRoot })
    observed.runtimeLicense = summarizeLicenses(licenseManifest)
    if (licenseManifest.issues.length) add(issues, 'runtime_license_policy_failed', { count: licenseManifest.issues.length })
    if (licenseManifest.advisories.length) add(blocked, 'runtime_license_legal_review_required', { count: licenseManifest.advisories.length })
  } catch {
    add(issues, 'runtime_license_inventory_failed')
  }

  const orderedIssues = issues.sort((a, b) => stable(a).localeCompare(stable(b), 'en'))
  const orderedBlocked = blocked.sort((a, b) => stable(a).localeCompare(stable(b), 'en'))
  return {
    schema: MATRIX_SHIP_ARTIFACT_RECEIPT_SCHEMA,
    result: orderedIssues.length || orderedBlocked.length ? 'fail' : 'pass',
    issues: orderedIssues,
    blocked: orderedBlocked,
    observed,
    ...(licenseManifest ? { runtimeLicenseManifest: licenseManifest } : {})
  }
}

function usage() {
  return 'Usage: audit-matrix-ship-artifact.mjs APP_ROOT [--expected EXPECTED.json] [--observed-public-config OBSERVED.json] [--output RECEIPT.json]'
}

async function main() {
  const args = process.argv.slice(2)
  const appRoot = args[0]
  const expectedIndex = args.indexOf('--expected')
  const observedIndex = args.indexOf('--observed-public-config')
  const outputIndex = args.indexOf('--output')
  if (!appRoot || args.filter(arg => arg === '--expected').length > 1 || args.filter(arg => arg === '--observed-public-config').length > 1 || args.filter(arg => arg === '--output').length > 1 || (expectedIndex !== -1 && !args[expectedIndex + 1]) || (observedIndex !== -1 && !args[observedIndex + 1]) || (outputIndex !== -1 && !args[outputIndex + 1])) throw new Error(usage())
  const expected = expectedIndex === -1 ? null : await readJson(path.resolve(args[expectedIndex + 1]), 'expected_inputs_unreadable')
  const observedPublicConfig = observedIndex === -1 ? null : await readJson(path.resolve(args[observedIndex + 1]), 'observed_public_config_unreadable')
  const receipt = await auditMatrixShipArtifact({ appRoot, expected, observedPublicConfig })
  if (outputIndex !== -1) await writeFile(path.resolve(args[outputIndex + 1]), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
  if (receipt.result !== 'pass') throw receiptError('release_not_ready')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[matrix-ship-artifact-audit] ${error.message}`)
    process.exitCode = 1
  })
}
