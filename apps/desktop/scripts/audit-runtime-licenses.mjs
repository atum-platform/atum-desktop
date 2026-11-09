#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import BROWSER_RUNTIME from '../browser-runtime.json' with { type: 'json' }
import { attributeRuntimeLicenses } from './runtime-license-attribution.mjs'
import {
  RESTRICTED_PRODUCTIVITY_SKILL_SOURCE_PATHS,
  RESTRICTED_RUNTIME_CONTENT_FINGERPRINTS,
  RESTRICTED_RUNTIME_SOURCE_PATHS
} from './restricted-runtime-skills.mjs'

export const RUNTIME_LICENSE_INVENTORY_SCHEMA = 'atum.runtime-license-inventory/1'

const LICENSE_FILE = /^(?:LICENSE|NOTICE|COPYING)(?:[._-][^/]*)?$/iu
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py|rs|go|swift|c|cc|cpp|h|hpp)$/iu

const discoveredLicenseFile = file => LICENSE_FILE.test(path.posix.basename(file.path)) && !SOURCE_FILE.test(file.path)

// These entries describe files the current runtime staging code deliberately
// places in the bundle. The classifications record evidence only; none asserts
// an SPDX identifier, redistribution permission, or legal approval.
export const REQUIRED_RUNTIME_COMPONENTS = Object.freeze([
  { id: 'hermes-core', path: 'hermes-agent', licenses: ['hermes-agent/LICENSE'], disposition: 'license_file_present' },
  { id: 'python-runtime', path: 'python', licenses: ['python/lib/python3.14/LICENSE.txt'], disposition: 'license_file_present' },
  { id: 'node-runtime', path: 'browser/node', licenses: ['browser/node/LICENSE'], disposition: 'license_file_present' },
  { id: 'agent-browser', path: 'browser/bin/agent-browser', licenses: ['browser/licenses/agent-browser-LICENSE'], disposition: 'license_file_present' },
  {
    id: 'chromium-runtime',
    path: 'browser/chromium',
    licenses: [`browser/chromium/${BROWSER_RUNTIME.chromium.root}/LICENSE.headless_shell`],
    disposition: 'license_file_present'
  },
  // npm and npx come from the pinned Node archive (Artistic-2.0; its dependencies carry their own).
  {
    id: 'npm',
    path: 'browser/node/lib/node_modules/npm',
    licenses: ['browser/node/lib/node_modules/npm/LICENSE'],
    disposition: 'license_file_present'
  },
  // tirith is not bundled (AGPL-3.0): Hermes downloads it into the agent home on first use.
  { id: 'uv', path: 'tools/uv', licenses: ['tools/uv/LICENSE-APACHE', 'tools/uv/LICENSE-MIT'], disposition: 'license_file_present' }
])

export const RESTRICTED_STAGED_SKILL_PATHS = Object.freeze(
  RESTRICTED_PRODUCTIVITY_SKILL_SOURCE_PATHS.map(sourcePath => `hermes-agent/${sourcePath}`)
)
export const RESTRICTED_STAGED_SOURCE_PATHS = Object.freeze(
  RESTRICTED_RUNTIME_SOURCE_PATHS.map(sourcePath => `hermes-agent/${sourcePath}`)
)

const invalid = detail => new Error(`runtime_license_inventory_invalid:${detail}`)
const policyFailure = issue => new Error(`runtime_license_policy_failed:${issue.code}:${issue.path || issue.component || 'runtime'}`)
const isMain = importMetaUrl => Boolean(process.argv[1]) && importMetaUrl === pathToFileURL(process.argv[1]).href

function relativePath(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.split(/[\\/]/u).some(part => !part || part === '.' || part === '..')) {
    throw invalid('unsafe_relative_path')
  }
  return value.split(/[\\/]/u).join('/')
}

function inside(root, candidate, { allowRoot = false } = {}) {
  const relative = path.relative(root, candidate)
  return (allowRoot && !relative) || (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function fileDigest(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function lstatInside(root, realRoot, relative) {
  const safe = relativePath(relative)
  const candidate = path.resolve(root, safe)
  if (!inside(root, candidate)) throw invalid('path_escapes_root')
  const linkInfo = await lstat(candidate).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (!linkInfo?.isSymbolicLink()) return { safe, candidate, info: linkInfo, symlink: null }
  const resolved = await realpath(candidate).catch(error => {
    if (error.code === 'ENOENT') throw invalid(`broken_symlink:${safe}`)
    throw error
  })
  if (!inside(realRoot, resolved)) throw invalid(`symlink_escapes_root:${safe}`)
  const info = await stat(candidate)
  if (info.isDirectory()) throw invalid(`symlink_directory:${safe}`)
  return { safe, candidate, info, symlink: path.relative(realRoot, resolved).split(path.sep).join('/') }
}

async function runtimeFiles(runtimeRoot) {
  const root = path.resolve(runtimeRoot)
  const rootInfo = await lstat(root).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw invalid('runtime_root')
  const realRoot = await realpath(root)
  const files = []

  async function visit(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const relative = `${prefix}${entry.name}`
      const { candidate, info, symlink } = await lstatInside(root, realRoot, relative)
      if (!info) throw invalid(`disappeared:${relative}`)
      if (info.isDirectory()) {
        await visit(candidate, `${relative}/`)
      } else if (info.isFile()) {
        files.push({ path: relative, bytes: info.size, sha256: await fileDigest(candidate), ...(symlink ? { symlink } : {}) })
      } else {
        throw invalid(`unsupported_entry:${relative}`)
      }
    }
  }

  await visit(root)
  return { root, realRoot, files }
}

function componentDigest(componentPath, files) {
  const prefix = `${componentPath}/`
  const members = files.filter(file => file.path === componentPath || file.path.startsWith(prefix))
  const hash = createHash('sha256')
  for (const member of members) hash.update(`${member.path}\0${member.bytes}\0${member.sha256}\n`)
  return { fileCount: members.length, sha256: hash.digest('hex') }
}

function validateComponents(components) {
  const ids = new Set()
  const licenseOwners = new Map()
  return components.map(component => {
    if (!component || typeof component.id !== 'string' || !component.id || ids.has(component.id) || typeof component.disposition !== 'string') {
      throw invalid('component_definition')
    }
    ids.add(component.id)
    const normalized = {
      id: component.id,
      path: relativePath(component.path),
      licenses: (component.licenses || []).map(relativePath).sort(),
      disposition: component.disposition
    }
    for (const license of normalized.licenses) {
      if (licenseOwners.has(license)) throw invalid(`duplicate_license_owner:${license}`)
      licenseOwners.set(license, normalized.id)
    }
    return normalized
  }).sort((left, right) => left.id.localeCompare(right.id, 'en'))
}

/**
 * Inventory staged runtime bytes without emitting source or licence bodies.
 * Read bounded installed RECORD/METADATA evidence to attribute Python licences;
 * retain bounded semantic headers and digests, never infer redistribution rights.
 *
 * The returned manifest is deterministic: it has no host paths or timestamps.
 * It reports mechanical policy failures separately from license classification
 * inventory. `assertRuntimeLicenseReleaseReadiness()` requires both to be clear.
 */
export async function auditRuntimeLicenses({ runtimeRoot, components = null } = {}) {
  const { root, realRoot, files } = await runtimeFiles(runtimeRoot)
  const configured = validateComponents(components || REQUIRED_RUNTIME_COMPONENTS)
  const byPath = new Map(files.map(file => [file.path, file]))
  const issues = []
  const advisories = []
  const manifestComponents = []

  for (const restrictedPath of RESTRICTED_STAGED_SOURCE_PATHS) {
    const { info } = await lstatInside(root, realRoot, restrictedPath)
    if (info) issues.push({ code: 'packaged_restricted_skill', path: restrictedPath })
  }

  for (const file of files) {
    if (RESTRICTED_STAGED_SOURCE_PATHS.some(restrictedPath => file.path === restrictedPath || file.path.startsWith(`${restrictedPath}/`))) continue
    for (const fingerprint of RESTRICTED_RUNTIME_CONTENT_FINGERPRINTS) {
      if (file.sha256 === fingerprint.sha256) {
        issues.push({
          code: 'packaged_restricted_skill_content',
          path: file.path,
          skill: fingerprint.id,
          content: fingerprint.kind
        })
      }
    }
  }

  for (const component of configured) {
    const { info } = await lstatInside(root, realRoot, component.path)
    if (!info) issues.push({ code: 'required_component_missing', component: component.id, path: component.path })
    const licenses = []
    for (const licensePath of component.licenses) {
      const license = byPath.get(licensePath)
      if (!license) issues.push({ code: 'required_license_missing', component: component.id, path: licensePath })
      else licenses.push(license)
    }
    if (component.disposition === 'legal_review_required') {
      advisories.push({ code: 'legal_review_required', component: component.id, paths: component.licenses })
    }
    manifestComponents.push({
      ...component,
      content: info ? componentDigest(component.path, files) : null,
      licenses: [...licenses, ...files.filter(file => file.path.startsWith(`${component.path}/`) && discoveredLicenseFile(file) && !component.licenses.includes(file.path))]
    })
  }

  const configuredLicensePaths = new Set(configured.flatMap(component => component.licenses))
  const discoveredLicenses = files.filter(file => configuredLicensePaths.has(file.path) || discoveredLicenseFile(file))
  const unclassifiedLicenses = discoveredLicenses.filter(license => !configuredLicensePaths.has(license.path))
  const licenseAttributions = await attributeRuntimeLicenses({ runtimeRoot: root, files, licenses: unclassifiedLicenses })
  const attributed = new Set(licenseAttributions.filter(license => license.attribution.status === 'attributed').map(license => license.path))
  for (const license of unclassifiedLicenses) {
    advisories.push({ code: attributed.has(license.path) ? 'legal_review_required' : 'unclassified_license_inventory', path: license.path })
  }

  const sortedIssues = issues.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'))
  return {
    schema: RUNTIME_LICENSE_INVENTORY_SCHEMA,
    policy: { outcome: sortedIssues.length === 0 ? 'pass' : 'fail', issueCount: sortedIssues.length },
    legalReview: { outcome: advisories.length === 0 ? 'clear_inventory' : 'review_required', advisoryCount: advisories.length },
    components: manifestComponents,
    discoveredLicenses,
    licenseAttributions,
    advisories: advisories.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en')),
    issues: sortedIssues
  }
}

export function assertRuntimeLicensePolicy(manifest) {
  if (!manifest || manifest.schema !== RUNTIME_LICENSE_INVENTORY_SCHEMA || !Array.isArray(manifest.issues)) throw invalid('manifest_schema')
  if (manifest.issues.length) throw policyFailure(manifest.issues[0])
  return manifest
}

/** A release gate must not treat a complete inventory as legal clearance. */
export function assertRuntimeLicenseReleaseReadiness(manifest) {
  assertRuntimeLicensePolicy(manifest)
  if (!Array.isArray(manifest.advisories)) throw invalid('manifest_schema')
  if (manifest.advisories.length) throw policyFailure(manifest.advisories[0])
  return manifest
}

export async function verifyRuntimeLicenseManifest({ runtimeRoot, manifest } = {}) {
  const expected = typeof manifest === 'string' ? JSON.parse(await readFile(manifest, 'utf8')) : manifest
  const actual = await auditRuntimeLicenses({ runtimeRoot })
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw invalid('stale_manifest')
  return assertRuntimeLicensePolicy(actual)
}

async function main() {
  const args = process.argv.slice(2)
  const runtimeRoot = args[0]
  const outputIndex = args.indexOf('--output')
  if (!runtimeRoot || args.filter(arg => arg === '--output').length > 1 || (outputIndex !== -1 && !args[outputIndex + 1])) {
    throw new Error('Usage: audit-runtime-licenses.mjs RUNTIME_ROOT [--output MANIFEST.json]')
  }
  const manifest = await auditRuntimeLicenses({ runtimeRoot })
  if (outputIndex !== -1) await writeFile(path.resolve(args[outputIndex + 1]), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
  assertRuntimeLicensePolicy(manifest)
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(`[runtime-license-audit] ${error.message}`)
    process.exitCode = 1
  })
}
