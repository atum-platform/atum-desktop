#!/usr/bin/env node
/**
 * The open-source notices of the Matrix app (FD3): one generated file,
 * Contents/Resources/licenses/THIRD-PARTY-NOTICES.txt, for exactly what a package ships.
 *
 * - The Atum Drive engine: every item of the staged AtumDriveEngine.app (its frameworks,
 *   libraries and plugins) is mapped to a component of third-party/engine-components.json,
 *   which is pinned to the engine's sourceCommit. An unlisted library, a pattern that matches
 *   nothing, or a different engine revision refuses the package until the catalog (and the
 *   public source offer it names) is reviewed.
 * - Electron, Chromium and Node.js: Electron's own licence and LICENSES.chromium.html, from the
 *   installed electron package of the exact version being packaged (electron-builder deletes
 *   both from a macOS app).
 * - npm packages: the production dependency closure of apps/desktop in package-lock.json,
 *   together with every package the Matrix build proves it bundled (matrix-bundled-packages.json
 *   in app.asar), with each package's own licence files from node_modules.
 * - The rest of the app, from third-party/app-components.json: Hermes Agent (the base of the app
 *   and the agent), every entry of Contents/Frameworks (each must match exactly one listed
 *   framework), the Rust crates compiled into a shipped package, and the bundles under Resources
 *   (runtime, local-brain), whose recorded versions must match the catalog.
 *
 * The full licence texts (third-party/licenses, packaged by electron-builder extraResources to
 * Resources/licenses) are appended to the notice, except the long per-crate Rust notices, which
 * the notice names. All of them are recorded with their digests in third-party-notices.json,
 * which auditThirdPartyNotices checks against the bundle.
 */

import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { extractFile } from '@electron/asar'

const DESKTOP_ROOT = path.resolve(import.meta.dirname, '..')
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..', '..')

/** Contents/Resources/<NOTICES_DIRECTORY>: the licence texts, the notice and its inventory. */
export const NOTICES_DIRECTORY = 'licenses'
export const NOTICE_FILE = 'THIRD-PARTY-NOTICES.txt'
export const NOTICE_INVENTORY_FILE = 'third-party-notices.json'
export const NOTICE_INVENTORY_SCHEMA = 'atum.third-party-notices/2'
/** The packager's inventory of the npm packages in app.asar. */
export const BUNDLED_PACKAGES_FILE = 'matrix-bundled-packages.json'
export const ENGINE_CATALOG_SCHEMA = 'atum.engine-components/1'
export const APP_CATALOG_SCHEMA = 'atum.app-components/1'
export const LICENSES_SOURCE = path.join(DESKTOP_ROOT, 'third-party', 'licenses')
export const ENGINE_CATALOG = path.join(DESKTOP_ROOT, 'third-party', 'engine-components.json')
export const APP_CATALOG = path.join(DESKTOP_ROOT, 'third-party', 'app-components.json')
/** Electron's notices inside the licences folder, and the file of the electron package each is. */
export const ELECTRON_NOTICE_FILES = Object.freeze({
  'electron/LICENSE.electron.txt': 'LICENSE',
  'electron/LICENSES.chromium.html': 'LICENSES.chromium.html'
})
/** The texts every Matrix package must carry whatever the catalog says: the engine is GPL and
 * its Qt, GLib and libintl are LGPL (LGPL-3.0 incorporates GPL-3.0). */
export const REQUIRED_LICENSE_TEXTS = Object.freeze([
  'texts/GPL-2.0.txt',
  'texts/GPL-3.0.txt',
  'texts/LGPL-2.1.txt',
  'texts/LGPL-3.0.txt',
  'texts/Apache-2.0.txt'
])
export const COMPANY = 'Anka Ventures Vietnam Company Limited'
export const SUPPORT_MAILBOX = 'support@atumplatform.com'
/** The standard texts a package that ships no licence file of its own may rely on: licences whose
 * text names no copyright holder. Any other licence without a licence file refuses the package. */
export const STANDARD_LICENSE_TEXTS = Object.freeze({
  MIT: 'texts/MIT.txt',
  'Apache-2.0': 'texts/Apache-2.0.txt',
  'MPL-2.0': 'texts/MPL-2.0.txt',
  'CC0-1.0': 'texts/CC0-1.0.txt'
})

const IGNORED_ENGINE_ENTRIES = new Set(['Info.plist', 'PkgInfo', 'CodeResources', '_CodeSignature'])
const LICENSE_FILE = /^(?:licen[cs]e|copying|notice|unlicense)(?:[.\-_].*)?$/iu
const MAX_LICENSE_FILE_BYTES = 512 * 1024
const PACKAGE_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/iu
const SHA1 = /^[a-f0-9]{40}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const TEXT_REFERENCE = /\btexts\/[\w.-]+\.txt\b/gu
/** The notice opens with a byte-order mark, so a viewer that has no charset reads it as UTF-8. */
const BOM = '﻿'
const RULE = '='.repeat(78)
const LINE = '-'.repeat(78)

function invalid(detail) {
  return new Error(`third_party_notices_invalid:${detail}`)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function readJson(file, code) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw invalid(code)
  }
}

function isFile(file) {
  try {
    const stat = lstatSync(file)

    return stat.isFile()
  } catch {
    return false
  }
}

function isDirectory(file) {
  try {
    return statSync(file).isDirectory()
  } catch {
    return false
  }
}

/** A relative path inside the licences folder: no absolute path, no `..`, forward slashes. */
function licensePath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    value.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    throw invalid(`license_path:${value}`)
  }

  return value
}

function https(value, code) {
  let url

  try {
    url = new URL(value)
  } catch {
    throw invalid(code)
  }

  if (url.protocol !== 'https:' || url.username || url.password) {
    throw invalid(code)
  }

  return url.href
}

function text(value, code) {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalid(code)
  }

  return value
}

/** A list of non-empty strings; `required` refuses an empty or missing one. */
function lines(value, code, { required = false } = {}) {
  if (value === undefined && !required) {
    return []
  }

  if (!Array.isArray(value) || (required && !value.length)) {
    throw invalid(code)
  }

  for (const line of value) {
    text(line, code)
  }

  return value
}

/** Licence files of the licences folder that must exist there. */
function existingLicenseFiles(value, licensesRoot, code, { required = false } = {}) {
  for (const file of lines(value, code, { required })) {
    if (!isFile(path.join(licensesRoot, licensePath(file)))) {
      throw invalid(`${code}:${file}`)
    }
  }

  return value ?? []
}

function readCatalogFile(file, schema, code) {
  const catalog = readJson(file, `${code}_unreadable`)

  if (catalog?.schema !== schema) {
    throw invalid(`${code}_schema`)
  }

  return catalog
}

// ---------------------------------------------------------------------------------------------
// The Atum Drive engine

/** The catalog of the engine's components, checked against the licence texts it names. */
export function readEngineCatalog({ catalogFile = ENGINE_CATALOG, licensesRoot = LICENSES_SOURCE } = {}) {
  const catalog = readCatalogFile(catalogFile, ENGINE_CATALOG_SCHEMA, 'engine_catalog')

  if (!catalog.engine || !Array.isArray(catalog.components)) {
    throw invalid('engine_catalog_schema')
  }

  if (!SHA1.test(catalog.engine.sourceCommit ?? '')) {
    throw invalid('engine_catalog_source_commit')
  }

  https(catalog.engine.sourceUrl, 'engine_catalog_source_url')
  https(catalog.engine.buildingUrl, 'engine_catalog_building_url')

  // The public tag can be named and pinned to its commit, with the living instructions and the
  // release that holds the exact LGPL sources next to it.
  if (catalog.engine.sourceTagCommit !== undefined && !SHA1.test(catalog.engine.sourceTagCommit)) {
    throw invalid('engine_catalog_source_tag_commit')
  }

  for (const field of ['instructionsUrl', 'releaseUrl']) {
    if (catalog.engine[field] !== undefined) {
      https(catalog.engine[field], `engine_catalog_${field}`)
    }
  }

  const ids = new Set()

  for (const component of catalog.components) {
    const id = component?.id

    if (typeof id !== 'string' || !/^[a-z0-9-]+$/u.test(id) || ids.has(id)) {
      throw invalid(`engine_catalog_component:${id}`)
    }

    ids.add(id)

    for (const field of ['name', 'version', 'license']) {
      if (typeof component[field] !== 'string' || !component[field].trim()) {
        throw invalid(`engine_catalog_${field}:${id}`)
      }
    }

    if (
      !Array.isArray(component.copyright) ||
      !component.copyright.length ||
      component.copyright.some(line => typeof line !== 'string' || !line.trim())
    ) {
      throw invalid(`engine_catalog_copyright:${id}`)
    }

    if (component.source !== 'engine') {
      https(component.source, `engine_catalog_source:${id}`)
    }

    if (!Array.isArray(component.files) || !component.files.length) {
      throw invalid(`engine_catalog_files:${id}`)
    }

    for (const pattern of component.files) {
      if (typeof pattern !== 'string' || !/^[\w.*+-]+(?:\/[\w.*+-]+)*$/u.test(pattern)) {
        throw invalid(`engine_catalog_pattern:${id}:${pattern}`)
      }
    }

    if (!Array.isArray(component.licenseFiles) || !component.licenseFiles.length) {
      throw invalid(`engine_catalog_license_files:${id}`)
    }

    existingLicenseFiles(component.licenseFiles, licensesRoot, `engine_catalog_license_missing:${id}`)
    lines(component.notes, `engine_catalog_notes:${id}`)

    // The exact source archives (for a modified or LGPL library), each with its SHA-256.
    if (component.sourceArchives !== undefined) {
      if (!Array.isArray(component.sourceArchives) || !component.sourceArchives.length) {
        throw invalid(`engine_catalog_source_archives:${id}`)
      }

      for (const archive of component.sourceArchives) {
        https(archive?.url, `engine_catalog_source_archive:${id}`)

        if (!SHA256.test(archive.sha256 ?? '')) {
          throw invalid(`engine_catalog_source_archive_sha256:${id}`)
        }
      }
    }

    // Third-party code compiled into the component's own binaries.
    if (component.includes !== undefined && !Array.isArray(component.includes)) {
      throw invalid(`engine_catalog_includes:${id}`)
    }

    for (const included of component.includes ?? []) {
      for (const field of ['name', 'version', 'license', 'where']) {
        text(included?.[field], `engine_catalog_include_${field}:${id}`)
      }

      lines(included.copyright, `engine_catalog_include_copyright:${id}`, { required: true })
      existingLicenseFiles(included.licenseFiles, licensesRoot, `engine_catalog_license_missing:${id}`, {
        required: true
      })
    }
  }

  return catalog
}

/**
 * What an engine bundle ships, relative to its Contents: every entry of MacOS, Frameworks and
 * Resources, and every file under PlugIns. Bundle metadata (Info.plist, PkgInfo, the code
 * signature) is not a component.
 */
export function listEngineItems(bundle) {
  const contents = path.join(bundle, 'Contents')

  if (!isDirectory(contents)) {
    throw invalid('engine_bundle_missing')
  }

  const items = []

  const walk = (folder, prefix) => {
    for (const name of readdirSync(folder).sort(compare)) {
      const file = path.join(folder, name)
      const relative = `${prefix}/${name}`
      const stat = lstatSync(file)

      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        walk(file, relative)
      } else {
        items.push(relative)
      }
    }
  }

  for (const name of readdirSync(contents).sort(compare)) {
    if (IGNORED_ENGINE_ENTRIES.has(name)) {
      continue
    }

    const folder = path.join(contents, name)
    const stat = lstatSync(folder)

    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      items.push(name)
    } else if (name === 'PlugIns') {
      walk(folder, name)
    } else {
      for (const entry of readdirSync(folder).sort(compare)) {
        items.push(`${name}/${entry}`)
      }
    }
  }

  return items
}

function patternExpression(pattern) {
  return new RegExp(`^${pattern.replace(/[.+()]/gu, character => `\\${character}`).replace(/\*/gu, '[^/]*')}$`, 'u')
}

/** Each item belongs to exactly one component, and every pattern matches something, so the
 * notice neither misses nor invents a library. `code` prefixes the refusal (engine, app_framework). */
function mapItems(components, items, code) {
  const patterns = components.flatMap(component =>
    component.files.map(pattern => ({ component, pattern, expression: patternExpression(pattern), used: false }))
  )

  const files = new Map(components.map(component => [component.id, []]))

  for (const item of items) {
    const owners = patterns.filter(entry => entry.expression.test(item))
    const ids = new Set(owners.map(entry => entry.component.id))

    if (!ids.size) {
      throw invalid(`${code}_item_unlisted:${item}`)
    }

    if (ids.size > 1) {
      throw invalid(`${code}_item_ambiguous:${item}`)
    }

    for (const owner of owners) {
      owner.used = true
    }

    files.get(owners[0].component.id).push(item)
  }

  const unused = patterns.find(entry => !entry.used)

  if (unused) {
    throw invalid(`${code}_pattern_unmatched:${unused.component.id}:${unused.pattern}`)
  }

  return components.map(component => ({ ...component, shipped: files.get(component.id) }))
}

/** Each shipped engine item belongs to exactly one catalog component, and every pattern of the
 * catalog matches something. */
export function mapEngineComponents(catalog, items) {
  return mapItems(catalog.components, items, 'engine')
}

/** The staged engine and its manifest: Resources/drive-engine (stage-drive-engine.mjs). */
export function readStagedEngine(engineRoot) {
  const manifest = readJson(path.join(engineRoot, 'manifest.json'), 'engine_manifest_unreadable')

  if (!SHA1.test(manifest?.sourceCommit ?? '') || typeof manifest.binary !== 'string') {
    throw invalid('engine_manifest_invalid')
  }

  const bundleName = manifest.binary.split('/')[0]

  if (!/^[^/]+\.app$/u.test(bundleName)) {
    throw invalid('engine_manifest_invalid')
  }

  return { sourceCommit: manifest.sourceCommit, bundleName, bundle: path.join(engineRoot, bundleName) }
}

// ---------------------------------------------------------------------------------------------
// The rest of the app: its base, Contents/Frameworks, Rust code and the Resources bundles

/** A listed component: name, licence, https source, and licence files that exist; a version
 * unless `versionOptional`. */
function checkLicensed(entry, licensesRoot, kind, id, { versionOptional = false } = {}) {
  for (const field of ['name', 'license']) {
    text(entry?.[field], `${kind}_${field}:${id}`)
  }

  if (!versionOptional || entry.version !== undefined) {
    text(entry.version, `${kind}_version:${id}`)
  }

  https(entry.source, `${kind}_source:${id}`)
  lines(entry.copyright, `${kind}_copyright:${id}`)
  lines(entry.notes, `${kind}_notes:${id}`)
  existingLicenseFiles(entry.licenseFiles, licensesRoot, `${kind}_license_missing:${id}`)
  existingLicenseFiles(entry.attachedFiles, licensesRoot, `${kind}_license_missing:${id}`)

  for (const file of [
    ...lines(entry.shippedFiles, `${kind}_shipped_files:${id}`),
    ...lines(entry.files, `${kind}_files:${id}`)
  ]) {
    licensePath(file)
  }
}

/** The catalog of the rest of the app, checked against the licence texts it names. */
export function readAppCatalog({ catalogFile = APP_CATALOG, licensesRoot = LICENSES_SOURCE } = {}) {
  const catalog = readCatalogFile(catalogFile, APP_CATALOG_SCHEMA, 'app_catalog')
  const { base, electron } = catalog

  for (const field of ['name', 'license', 'text']) {
    text(base?.[field], `app_catalog_base_${field}`)
  }

  https(base.source, 'app_catalog_base_source')
  lines(base.copyright, 'app_catalog_base_copyright', { required: true })
  existingLicenseFiles(base.licenseFiles, licensesRoot, 'app_catalog_license_missing:base', { required: true })

  if (!Array.isArray(base.includes)) {
    throw invalid('app_catalog_base_includes')
  }

  const baseIncludeIds = new Set()

  for (const included of base.includes) {
    const id = included?.id

    if (typeof id !== 'string' || !/^[a-z0-9-]+$/u.test(id) || baseIncludeIds.has(id)) {
      throw invalid(`app_catalog_base_include:${id}`)
    }

    baseIncludeIds.add(id)
    checkLicensed(included, licensesRoot, 'app_catalog_base_include', id)
  }

  text(electron?.version, 'app_catalog_electron_version')
  text(electron.chromiumVersion, 'app_catalog_electron_chromium')

  for (const field of ['source', 'chromiumSource', 'ffmpegSource']) {
    https(electron[field], `app_catalog_electron_${field}`)
  }

  if (!Array.isArray(catalog.frameworks) || !catalog.frameworks.length) {
    throw invalid('app_catalog_frameworks')
  }

  const ids = new Set()

  for (const framework of catalog.frameworks) {
    const id = framework?.id

    if (typeof id !== 'string' || !/^[a-z0-9-]+$/u.test(id) || ids.has(id)) {
      throw invalid(`app_catalog_framework:${id}`)
    }

    ids.add(id)

    if (
      !Array.isArray(framework.files) ||
      !framework.files.length ||
      framework.files.some(pattern => typeof pattern !== 'string' || !/^[\w .()*+-]+$/u.test(pattern))
    ) {
      throw invalid(`app_catalog_framework_files:${id}`)
    }

    if (framework.coveredBy === 'electron') {
      text(framework.name, `app_catalog_framework_name:${id}`)
    } else {
      checkLicensed(framework, licensesRoot, 'app_catalog_framework', id)
      lines(framework.licenseFiles, `app_catalog_framework_license_files:${id}`, { required: true })
    }
  }

  for (const rust of catalog.rust ?? []) {
    if (typeof rust?.package !== 'string' || !PACKAGE_NAME.test(rust.package)) {
      throw invalid(`app_catalog_rust:${rust?.package}`)
    }

    text(rust.version, `app_catalog_rust_version:${rust.package}`)
    text(rust.what, `app_catalog_rust_what:${rust.package}`)
    existingLicenseFiles([rust.file], licensesRoot, `app_catalog_rust_missing:${rust.package}`)
  }

  const folders = new Set()

  for (const bundle of catalog.bundles ?? []) {
    const id = bundle?.id

    if (typeof id !== 'string' || !/^[a-z0-9-]+$/u.test(id)) {
      throw invalid(`app_catalog_bundle:${id}`)
    }

    if (typeof bundle.folder !== 'string' || !/^[\w.-]+$/u.test(bundle.folder) || folders.has(bundle.folder)) {
      throw invalid(`app_catalog_bundle_folder:${id}`)
    }

    folders.add(bundle.folder)
    text(bundle.title, `app_catalog_bundle_title:${id}`)

    for (const pin of bundle.pins ?? []) {
      licensePath(pin?.file)
      text(pin.key, `app_catalog_bundle_pin:${id}`)
      text(pin.value, `app_catalog_bundle_pin:${id}`)
    }

    if (!Array.isArray(bundle.components) || !bundle.components.length) {
      throw invalid(`app_catalog_bundle_components:${id}`)
    }

    for (const component of bundle.components) {
      checkLicensed(component, licensesRoot, 'app_catalog_bundle', id, { versionOptional: true })

      if (!component.licenseFiles?.length && !component.shippedFiles?.length) {
        throw invalid(`app_catalog_bundle_unlicensed:${id}:${component.name}`)
      }
    }
  }

  return catalog
}

/** Every entry of the app's Contents/Frameworks. */
export function listAppFrameworks(frameworksRoot) {
  if (!isDirectory(frameworksRoot)) {
    throw invalid('app_frameworks_missing')
  }

  return readdirSync(frameworksRoot).sort(compare)
}

/** Each entry of Contents/Frameworks belongs to exactly one framework of the catalog, and every
 * pattern matches something. */
export function mapAppFrameworks(catalog, items) {
  return mapItems(catalog.frameworks, items, 'app_framework')
}

function jsonKey(value, key) {
  return key
    .split('.')
    .reduce((current, part) => (current && typeof current === 'object' ? current[part] : undefined), value)
}

/**
 * The catalog bundles this package ships (their folder exists under Resources): each recorded
 * version (`pins`) must match what was staged, and each licence file that ships beside a
 * component must be there, or the notice would describe a different runtime.
 */
export function presentBundles(catalog, bundlesRoot) {
  const present = []

  for (const bundle of catalog.bundles ?? []) {
    if (!isDirectory(path.join(bundlesRoot, bundle.folder))) {
      continue
    }

    for (const pin of bundle.pins ?? []) {
      const actual = jsonKey(
        readJson(path.join(bundlesRoot, pin.file), `bundle_pin_unreadable:${bundle.id}:${pin.file}`),
        pin.key
      )

      if (actual !== pin.value) {
        throw invalid(`bundle_pin_changed:${bundle.id}:${pin.key}:${actual}`)
      }
    }

    for (const component of bundle.components) {
      for (const file of [...(component.shippedFiles ?? []), ...(component.files ?? [])]) {
        if (!isFile(path.join(bundlesRoot, file))) {
          throw invalid(`bundle_file_missing:${bundle.id}:${file}`)
        }
      }
    }

    present.push(bundle)
  }

  return present
}

/** The Rust notices for the npm packages shipped: a listed package at another version than its
 * notice refuses, so the crate list always belongs to the build that ships. */
export function rustNotices(catalog, npm) {
  const notices = []

  for (const rust of catalog.rust ?? []) {
    const shipped = npm.filter(item => item.name === rust.package)

    for (const item of shipped) {
      if (item.version !== rust.version) {
        throw invalid(`rust_notice_version:${item.name}@${item.version}`)
      }
    }

    if (shipped.length) {
      notices.push(rust)
    }
  }

  return notices
}

// ---------------------------------------------------------------------------------------------
// npm packages

function lockName(lockPath, entry) {
  if (typeof entry?.name === 'string') {
    return entry.name
  }

  const index = lockPath.lastIndexOf('node_modules/')

  return index === -1 ? null : lockPath.slice(index + 'node_modules/'.length)
}

function resolveLockPath(packages, from, name) {
  let base = from

  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`

    if (Object.hasOwn(packages, candidate)) {
      return candidate
    }

    if (!base) {
      return null
    }

    const index = base.lastIndexOf('/node_modules/')
    base = index === -1 ? '' : base.slice(0, index)
  }
}

/**
 * The production dependency closure of a workspace in a lockfile (v2/v3 `packages`): its
 * dependencies and optional dependencies, transitively, resolved the way Node resolves them.
 * Workspace links are followed into the linked package but are first-party, so not listed.
 */
export function productionClosure(lock, workspace = 'apps/desktop') {
  const packages = lock?.packages

  if (!packages || typeof packages !== 'object' || !packages[workspace]) {
    throw invalid(`lock_workspace_missing:${workspace}`)
  }

  const listed = new Set()
  const visited = new Set()
  const pending = [workspace]

  while (pending.length) {
    const current = pending.pop()

    if (visited.has(current)) {
      continue
    }

    visited.add(current)
    const entry = packages[current]

    if (entry?.link) {
      if (typeof entry.resolved === 'string' && packages[entry.resolved]) {
        pending.push(entry.resolved)
      }

      continue
    }

    if (current !== workspace && current.includes('node_modules/')) {
      listed.add(current)
    }

    const optional = entry?.optionalDependencies ?? {}

    for (const name of Object.keys({ ...entry?.dependencies, ...optional })) {
      const resolved = resolveLockPath(packages, current, name)

      if (resolved) {
        pending.push(resolved)
      } else if (!Object.hasOwn(optional, name)) {
        throw invalid(`lock_dependency_unresolved:${current}:${name}`)
      }
    }
  }

  return listed
}

function licenseId(manifest, entry) {
  if (typeof manifest.license === 'string' && manifest.license.trim()) {
    return manifest.license.trim()
  }

  if (manifest.license && typeof manifest.license.type === 'string') {
    return manifest.license.type
  }

  if (Array.isArray(manifest.licenses)) {
    const types = manifest.licenses.map(item => (typeof item === 'string' ? item : item?.type)).filter(Boolean)

    if (types.length) {
      return types.join(' OR ')
    }
  }

  return typeof entry?.license === 'string' ? entry.license : null
}

/**
 * The standard licence texts that cover an SPDX expression for a package with no licence file:
 * for `A OR B` the first alternative whose every licence has a standard text, for `A AND B` all
 * of them. Empty when no alternative is covered.
 */
export function standardTextsFor(license) {
  if (typeof license !== 'string') {
    return []
  }

  for (const alternative of license.replace(/[()]/gu, ' ').split(/\s+OR\s+/u)) {
    const ids = alternative.trim().split(/\s+AND\s+/u)
    const texts = ids.map(id => STANDARD_LICENSE_TEXTS[id.trim()])

    if (ids.length && texts.every(Boolean)) {
      return [...new Set(texts)]
    }
  }

  return []
}

function person(value) {
  if (typeof value === 'string') {
    return (
      value
        .replace(/\s*<[^>]*>/gu, '')
        .replace(/\s*\([^)]*\)/gu, '')
        .trim() || null
    )
  }

  return typeof value?.name === 'string' ? value.name.trim() || null : null
}

function repository(manifest) {
  const value = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url

  if (typeof value === 'string' && value) {
    return value.replace(/^git\+/u, '').replace(/\.git$/u, '')
  }

  return typeof manifest.homepage === 'string' ? manifest.homepage : null
}

function packageLicenseFiles(directory) {
  return readdirSync(directory)
    .filter(name => LICENSE_FILE.test(name))
    .sort(compare)
    .flatMap(name => {
      const file = path.join(directory, name)
      const stat = lstatSync(file)

      if (!stat.isFile()) {
        return []
      }

      if (stat.size > MAX_LICENSE_FILE_BYTES) {
        throw invalid(`license_file_too_large:${file}`)
      }

      return [{ name, text: readFileSync(file, 'utf8') }]
    })
}

/**
 * The npm packages the app ships: the production closure of `workspace` plus every package the
 * build bundled (`bundled`, from matrix-bundled-packages.json), read from the lockfile and the
 * installed node_modules. Platform packages that are not installed are optional dependencies for
 * another OS and are skipped; any other missing, mismatched or unexplained package refuses.
 */
export function collectNpmPackages({ repoRoot = REPO_ROOT, workspace = 'apps/desktop', bundled = [], licenseChoices = {} } = {}) {
  const lock = readJson(path.join(repoRoot, 'package-lock.json'), 'lock_unreadable')
  const packages = lock.packages ?? {}
  const selected = productionClosure(lock, workspace)
  const byIdentity = new Map()

  for (const [lockPath, entry] of Object.entries(packages)) {
    if (!lockPath.includes('node_modules/') || entry?.link) {
      continue
    }

    const key = `${lockName(lockPath, entry)}@${entry.version}`
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), lockPath])
  }

  for (const item of bundled) {
    const candidates = byIdentity.get(`${item.name}@${item.version}`) ?? []
    const installed = candidates.find(candidate => isDirectory(path.join(repoRoot, candidate)))

    if (!installed) {
      throw invalid(`bundled_package_unlocked:${item.name}@${item.version}`)
    }

    selected.add(installed)
  }

  const shipped = new Map()

  for (const lockPath of [...selected].sort(compare)) {
    const entry = packages[lockPath]
    const directory = path.join(repoRoot, lockPath)

    if (!isDirectory(directory)) {
      if (entry?.optional || entry?.devOptional) {
        continue
      }

      throw invalid(`package_not_installed:${lockPath}`)
    }

    const manifest = readJson(path.join(directory, 'package.json'), `package_json_unreadable:${lockPath}`)
    const name = lockName(lockPath, entry)

    if (manifest.version !== entry.version) {
      throw invalid(`package_version_mismatch:${lockPath}:${manifest.version}:${entry.version}`)
    }

    const key = `${name}@${entry.version}`

    if (shipped.has(key)) {
      continue
    }

    const declaredLicense = licenseId(manifest, entry)
    const choice = licenseChoices[name]
    if (choice !== undefined && (typeof choice !== 'string' || !declaredLicense?.replace(/[()]/gu, '').split(/\s+OR\s+/u).map(value => value.trim()).includes(choice))) {
      throw invalid(`package_license_choice_invalid:${key}`)
    }
    const license = choice ?? declaredLicense
    const licenseFiles = packageLicenseFiles(directory)

    if (!license && !licenseFiles.length) {
      throw invalid(`package_license_unknown:${key}`)
    }

    // A package without a licence file of its own can rely only on a standard text that names no
    // copyright holder (MIT, Apache-2.0, ...); an ISC or BSD package without one refuses.
    const standardTexts = licenseFiles.length ? [] : standardTextsFor(license)

    if (!licenseFiles.length && !standardTexts.length) {
      throw invalid(`package_license_text_missing:${key}:${license}`)
    }

    shipped.set(key, {
      name,
      version: entry.version,
      license: license ?? 'see the licence text',
      ...(choice ? { declaredLicense } : {}),
      author: person(manifest.author),
      repository: repository(manifest),
      licenseFiles,
      standardTexts
    })
  }

  return [...shipped.values()].sort(
    (left, right) => compare(left.name, right.name) || compare(left.version, right.version)
  )
}

/**
 * The npm packages behind a set of bundler module ids (absolute paths): each id under a
 * node_modules folder belongs to the package at that folder, whose package.json names it.
 */
export function bundledPackagesFromModuleIds(
  ids,
  readPackage = root => JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
) {
  const roots = new Map()

  for (const raw of ids) {
    if (typeof raw !== 'string') {
      continue
    }

    const id = raw.replace(/^\0+/u, '').split('?')[0].replace(/\\/gu, '/')
    const index = id.lastIndexOf('/node_modules/')

    if (index === -1 || !path.posix.isAbsolute(id.replace(/^[A-Za-z]:/u, ''))) {
      continue
    }

    const rest = id.slice(index + '/node_modules/'.length).split('/')
    const name = rest[0]?.startsWith('@') ? `${rest[0]}/${rest[1] ?? ''}` : rest[0]

    if (!name || !PACKAGE_NAME.test(name)) {
      continue
    }

    const root = `${id.slice(0, index)}/node_modules/${name}`

    if (!roots.has(root)) {
      roots.set(root, name)
    }
  }

  const found = new Map()

  for (const root of roots.keys()) {
    const manifest = readPackage(root)

    if (typeof manifest?.name !== 'string' || typeof manifest.version !== 'string') {
      throw invalid(`bundled_package_json:${root}`)
    }

    found.set(`${manifest.name}@${manifest.version}`, { name: manifest.name, version: manifest.version })
  }

  return [...found.values()].sort(
    (left, right) => compare(left.name, right.name) || compare(left.version, right.version)
  )
}

/**
 * Collects the module ids of the Matrix build: a Vite plugin for both renderer builds (every
 * module that passes through the pipeline, CSS included, and every module of every chunk) and
 * the esbuild metafiles of the native bundles.
 */
export function createBundledPackagesCollector({ cwd = process.cwd() } = {}) {
  const ids = new Set()

  return {
    plugin: () => ({
      name: 'matrix-bundled-packages',
      enforce: 'pre',
      transform(_code, id) {
        ids.add(id)

        return null
      },
      generateBundle(_options, output) {
        for (const file of Object.values(output)) {
          for (const id of Object.keys(file?.modules ?? {})) {
            ids.add(id)
          }
        }
      }
    }),
    addMetafile(metafile) {
      for (const input of Object.keys(metafile?.inputs ?? {})) {
        ids.add(path.resolve(cwd, input))
      }
    },
    packages(readPackage) {
      return bundledPackagesFromModuleIds([...ids], readPackage)
    }
  }
}

/** The bundled-package evidence of a packaged app, from its app.asar. */
export function readBundledPackagesFromAsar(resources) {
  let value

  try {
    value = JSON.parse(extractFile(path.join(resources, 'app.asar'), BUNDLED_PACKAGES_FILE).toString('utf8'))
  } catch {
    throw invalid('bundled_packages_unreadable')
  }

  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some(
      item =>
        typeof item?.name !== 'string' ||
        !PACKAGE_NAME.test(item.name) ||
        typeof item.version !== 'string' ||
        !/^\d+\.\d+\.\d+[\w.+-]*$/u.test(item.version)
    )
  ) {
    throw invalid('bundled_packages_invalid')
  }

  return value.map(item => ({ name: item.name, version: item.version }))
}

// ---------------------------------------------------------------------------------------------
// Electron

/** Electron's licence and Chromium's credits from the installed electron package, refused unless
 * it is the Electron version the app is packaged with. */
export function electronNoticeSources({ electronVersion, requireFrom = DESKTOP_ROOT } = {}) {
  if (typeof electronVersion !== 'string' || !electronVersion) {
    throw invalid('electron_version_unknown')
  }

  const require = createRequire(path.join(requireFrom, 'package.json'))
  let manifestFile

  try {
    manifestFile = require.resolve('electron/package.json')
  } catch {
    throw invalid('electron_package_missing')
  }

  const manifest = readJson(manifestFile, 'electron_package_missing')

  if (manifest.version !== electronVersion) {
    throw invalid(`electron_version_mismatch:${manifest.version}:${electronVersion}`)
  }

  const dist = path.join(path.dirname(manifestFile), 'dist')
  const files = Object.fromEntries(
    Object.entries(ELECTRON_NOTICE_FILES).map(([target, source]) => [target, path.join(dist, source)])
  )

  for (const [target, file] of Object.entries(files)) {
    if (!isFile(file) || statSync(file).size === 0) {
      throw invalid(`electron_notice_missing:${target}`)
    }
  }

  return { version: manifest.version, files }
}

// ---------------------------------------------------------------------------------------------
// The notice

function heading(value, rule) {
  return `${value}\n${rule.slice(0, Math.max(value.length, 3))}\n`
}

/** Wraps at `width`; the first line starts with `first`, the others with `rest`. */
function wrap(value, width = 78, first = '', rest = first) {
  const out = []
  let line = first
  let fresh = true

  for (const word of value.split(/\s+/u).filter(Boolean)) {
    if (!fresh && line.length + 1 + word.length > width) {
      out.push(line)
      line = rest + word
    } else {
      line = fresh ? line + word : `${line} ${word}`
    }

    fresh = false
  }

  if (!fresh) {
    out.push(line)
  }

  return out.join('\n')
}

/** "a", "a and b", "a, b and c". */
function listing(values) {
  return values.length > 1 ? `${values.slice(0, -1).join(', ')} and ${values.at(-1)}` : (values[0] ?? '')
}

function normalizeText(value) {
  return value.replace(/\r\n?/gu, '\n').replace(/\s+$/u, '')
}

/** Where a component's source is, with the SHA-256 of each exact archive. */
function sourceLines(component, fallback) {
  const out = [`  Source: ${component.source === 'engine' ? fallback : component.source}\n`]

  for (const archive of component.sourceArchives ?? []) {
    out.push(`    ${archive.url}\n      SHA-256 ${archive.sha256}\n`)
  }

  return out.join('')
}

/** The steps that let a person run the engine with their own build of an LGPL library. */
function relinkSteps(bundleName) {
  return [
    `Replace the library in Resources/drive-engine/${bundleName}/Contents/Frameworks.`,
    `Re-sign the engine ad hoc: codesign --force --deep --sign - <path of ${bundleName}>`,
    `In Resources/drive-engine/manifest.json, set "sha256" to the SHA-256 of the engine executable (the "binary" path in that file), and "bundleSha256" to the SHA-256 of the engine's file list. That list has one line per file or symbolic link in ${bundleName}, visiting the bundle depth first with the entries of each folder in sorted order: the compact JSON array [path,"file",<SHA-256 of the file>] or [path,"link",<link target>], with the path relative to ${bundleName}, then a newline.`,
    'Re-sign Atum ad hoc: codesign --force --deep --sign - <path of the Atum app>'
  ]
}

/**
 * The notice itself: deterministic plain text, the same for the same inputs.
 *
 * `texts` maps each licence file (relative to the licences folder) to its content; each is
 * appended once at the end. `attached` names the licence files that ship in the folder but are
 * too long to repeat (the per-crate Rust notices).
 */
export function renderThirdPartyNotices({
  catalog,
  engine,
  npm,
  electron,
  texts,
  attached = [],
  app,
  frameworks,
  bundles = [],
  rust = []
}) {
  const out = []
  const push = (...parts) => out.push(...parts)
  const paragraph = value => push(wrap(value), '\n\n')

  push(heading('Atum: open-source software notices', RULE), '\n')
  paragraph(
    `Atum is made by ${COMPANY}. It includes the free and open-source software listed below. Each component keeps its own licence. The full licence texts follow at the end of this file, and each is also a file in the folder that holds this one: Contents/Resources/licenses inside the Atum app.`
  )
  paragraph(
    `Written offer. For at least three years after we last distribute this version of Atum, ${COMPANY} will give anyone who asks a complete, machine-readable copy of the corresponding source code of every component below whose licence requires it (among them the Atum Drive engine, Qt, GLib, libintl, FFmpeg and JavaScriptCore), on a medium customarily used for software interchange, for a charge no more than our cost of physically performing the distribution. Write to ${SUPPORT_MAILBOX}. The same source is available now, at no charge, from the locations given below.`
  )
  paragraph(`Questions: ${SUPPORT_MAILBOX}`)
  push('Contents\n')
  push('  1. Atum Drive engine\n  2. Electron, Chromium and Node.js\n  3. The Atum app and its JavaScript packages\n')
  push('  4. Other bundled components\n  5. Licence texts\n\n')

  // 1. The engine.
  const { engine: about } = catalog
  const tag = about.sourceTag
    ? ` (tag ${about.sourceTag}${about.sourceTagCommit ? `, commit ${about.sourceTagCommit}` : ''})`
    : ''

  push(heading('1. Atum Drive engine', LINE), '\n')
  paragraph(
    `The Atum Drive sync engine (Resources/drive-engine/${engine.bundleName}) is a modified version of OpenCloud Desktop. Its source is licensed under the GNU General Public License, version 2 or (at your option) any later version. The engine links Qt (LGPL-3.0) and OpenSSL 3 (Apache-2.0), which are compatible with version 3 of the GPL but not with version 2, so Atum distributes this engine binary under the GNU General Public License, version 3.`
  )
  paragraph(`The complete corresponding source of the engine in this copy of Atum (revision ${engine.sourceCommit}):`)
  push(`  Source${tag}:\n    ${about.sourceUrl}\n`)
  push(`  Build instructions in that source:\n    ${about.buildingUrl}\n`)

  if (about.instructionsUrl) {
    push(`  Current instructions, including how to replace the LGPL libraries:\n    ${about.instructionsUrl}\n`)
  }

  if (about.releaseUrl) {
    push(
      `  Exact sources of the LGPL libraries, with the recipes and patches that built them:\n    ${about.releaseUrl}\n`
    )
  }

  push('\n')

  const lgpl = engine.components.filter(component => /^LGPL/u.test(component.license))

  if (lgpl.length) {
    paragraph(
      `${listing(lgpl.map(component => component.name))} ${lgpl.length > 1 ? 'are' : 'is'} licensed under the GNU Lesser General Public License and dynamically linked as separate libraries inside the engine bundle. How each was built, and where its exact source is, is listed with it below. You may replace them with your own interface-compatible builds. Atum checks the engine before it starts it, so after replacing a library:`
    )
    relinkSteps(engine.bundleName).forEach((step, index) => push(wrap(step, 78, `  ${index + 1}. `, '     '), '\n'))
    push('\n')
    paragraph(
      'The current instructions above give these steps as commands, with a script for step 3. A copy changed this way is no longer signed by Atum, so macOS may ask again before Atum or the engine can read their keychain items, and Atum’s automatic updates may not install over it.'
    )
  }

  push('The engine bundle contains:\n')

  for (const component of engine.components) {
    push('\n', `* ${component.name} ${component.version}\n`)
    push(`  Licence: ${component.license}\n`)

    for (const line of component.copyright) {
      push(wrap(line, 78, '  '), '\n')
    }

    for (const note of component.notes ?? []) {
      push(wrap(note, 78, '  '), '\n')
    }

    push(sourceLines(component, about.sourceUrl))
    push(wrap(`Files: ${component.shipped.join(', ')}`, 78, '  '), '\n')
    push(wrap(`Licence text: ${component.licenseFiles.join(', ')}`, 78, '  '), '\n')

    for (const included of component.includes ?? []) {
      push(
        wrap(
          `Includes ${included.name} ${included.version}, ${included.where}: ${included.license}. ${included.copyright.join('. ')}. Licence text: ${included.licenseFiles.join(', ')}`,
          78,
          '  - ',
          '    '
        ),
        '\n'
      )
    }
  }

  push('\n')

  // 2. Electron and the rest of Contents/Frameworks.
  push(heading('2. Electron, Chromium and Node.js', LINE), '\n')
  paragraph(
    `Atum runs on Electron ${electron.version}, which includes Chromium ${app.electron.chromiumVersion} and Node.js. Electron's licence follows. The notices of Chromium, Node.js, FFmpeg and their third-party components are in electron/LICENSES.chromium.html in this folder.`
  )
  push(`  Electron source:\n    ${app.electron.source}\n  Chromium source:\n    ${app.electron.chromiumSource}\n\n`)
  paragraph(
    `Electron includes FFmpeg (Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib), built by Chromium and licensed under the GNU Lesser General Public License, version 2.1 or later (texts/LGPL-2.1.txt). Its source is at the revision Chromium ${app.electron.chromiumVersion} pins:`
  )
  push(`    ${app.electron.ffmpegSource}\n\n`)
  push('Contents/Frameworks of the Atum app contains:\n')

  for (const framework of frameworks) {
    if (framework.coveredBy === 'electron') {
      push('\n', wrap(`${framework.name}: Electron's licence below and the Chromium notices.`, 78, '* ', '  '), '\n')
    } else {
      push(
        '\n',
        wrap(`${framework.name} ${framework.version}`, 78, '* ', '  '),
        '\n',
        `  Licence: ${framework.license}\n`
      )

      for (const line of framework.copyright ?? []) {
        push(wrap(line, 78, '  '), '\n')
      }

      push(`  Source: ${framework.source}\n`)
      push(wrap(`Licence text: ${framework.licenseFiles.join(', ')}`, 78, '  '), '\n')
    }

    push(wrap(`Files: ${framework.shipped.join(', ')}`, 78, '  '), '\n')
  }

  push('\n', normalizeText(electron.license), '\n\n')

  // 3. The app and its npm packages.
  push(heading('3. The Atum app and its JavaScript packages', LINE), '\n')
  paragraph(
    `${app.base.text} ${app.base.name} is licensed under the ${app.base.license} licence: ${app.base.copyright.join('. ')}. Source: ${app.base.source}. Licence text: ${app.base.licenseFiles.join(', ')}.`
  )
  for (const included of app.base.includes) {
    paragraph(
      `The app includes ${included.name} ${included.version}, licensed under ${included.license}. Source: ${included.source}. Licence and notice text: ${included.licenseFiles.join(', ')}.${included.notes?.length ? ` ${included.notes.join(' ')}` : ''}`
    )
  }
  paragraph(
    `The Atum app (Resources/app.asar) is built from these ${npm.length} npm packages: its production dependencies and every package its build bundled. Each licence text follows the list once, with the packages it covers.`
  )

  for (const item of npm) {
    push(`  ${item.name} ${item.version} (${item.license})\n`)
    if (item.declaredLicense) push(`    Atum selects ${item.license} from ${item.declaredLicense}.\n`)
  }

  for (const notice of rust) {
    push(
      '\n',
      wrap(
        `${notice.package} ${notice.version} contains ${notice.what}. The licences of the Rust crates in its build are in ${notice.file} in this folder.`
      ),
      '\n'
    )
  }

  const groups = new Map()

  for (const item of npm) {
    const content = item.licenseFiles.length
      ? item.licenseFiles.map(file => normalizeText(file.text)).join('\n\n')
      : null

    const key = content ? sha256(content.replace(/\s+/gu, ' ')) : `standard:${item.license}:${item.author ?? ''}`
    const group = groups.get(key) ?? { text: content, item, members: [] }
    group.members.push(item)
    groups.set(key, group)
  }

  for (const group of [...groups.values()].sort((left, right) =>
    compare(
      `${left.members[0].name}@${left.members[0].version}`,
      `${right.members[0].name}@${right.members[0].version}`
    )
  )) {
    push('\n', LINE, '\n')
    push(wrap(`For: ${group.members.map(member => `${member.name} ${member.version}`).join(', ')}`), '\n')

    if (group.text) {
      push('\n', group.text, '\n')
    } else {
      const author = group.item.author ? `Author (package.json): ${group.item.author}. ` : ''
      push(
        '\n',
        wrap(
          `${author}The package ships no licence file. Its package.json declares the ${group.item.license} licence, whose standard text is ${group.item.standardTexts.join(' and ')} (appended below)${group.item.repository ? `; source: ${group.item.repository}` : ''}.`
        ),
        '\n'
      )
    }
  }

  push('\n')

  // 4. The bundles under Resources.
  push(heading('4. Other bundled components', LINE), '\n')

  if (!bundles.length) {
    push('None.\n')
  }

  for (const bundle of bundles) {
    push(wrap(`${bundle.title}:`), '\n')

    for (const component of bundle.components) {
      push('\n', wrap(`${component.name}${component.version ? ` ${component.version}` : ''}`, 78, '* ', '  '), '\n')
      push(wrap(`Licence: ${component.license}`, 78, '  ', '    '), '\n')

      for (const line of component.copyright ?? []) {
        push(wrap(line, 78, '  '), '\n')
      }

      for (const note of component.notes ?? []) {
        push(wrap(note, 78, '  '), '\n')
      }

      push(`  Source: ${component.source}\n`)

      if (component.files?.length) {
        push(wrap(`Files: ${component.files.map(file => `Contents/Resources/${file}`).join(', ')}`, 78, '  '), '\n')
      }

      if (component.shippedFiles?.length) {
        push(
          wrap(
            `Licence files shipped with it: ${component.shippedFiles.map(file => `Contents/Resources/${file}`).join(', ')}`,
            78,
            '  '
          ),
          '\n'
        )
      }

      if (component.licenseFiles?.length) {
        push(wrap(`Licence text: ${component.licenseFiles.join(', ')}`, 78, '  '), '\n')
      }

      if (component.attachedFiles?.length) {
        push(wrap(`Also in this folder: ${component.attachedFiles.join(', ')}`, 78, '  '), '\n')
      }
    }

    push('\n')
  }

  push('\n')

  // 5. Licence texts.
  push(heading('5. Licence texts', LINE), '\n')
  push(wrap('The licence texts the components above refer to, each also a file in this folder.'), '\n')

  if (attached.length) {
    push(wrap(`Not repeated here, because of their length: ${attached.join(', ')}.`), '\n')
  }

  for (const [file, content] of [...texts.entries()].sort(([left], [right]) => compare(left, right))) {
    push('\n', RULE, '\n', file, '\n', RULE, '\n\n', normalizeText(content), '\n')
  }

  return BOM + out.join('')
}

/**
 * The licence files the notice uses, relative to the licences folder: `appended` (printed in
 * full) and `attached` (named only). Any `texts/<id>.txt` that one of them refers to is appended
 * too, so a reference in a licence file always resolves.
 */
function referencedTexts({ catalog, app, frameworks, bundles, npm, rust, read }) {
  const appended = new Set([
    ...REQUIRED_LICENSE_TEXTS,
    ...catalog.components.flatMap(component => [
      ...component.licenseFiles,
      ...(component.includes ?? []).flatMap(included => included.licenseFiles)
    ]),
    ...app.base.licenseFiles,
    ...app.base.includes.flatMap(component => component.licenseFiles),
    ...frameworks.flatMap(framework => framework.licenseFiles ?? []),
    ...bundles.flatMap(bundle => bundle.components.flatMap(component => component.licenseFiles ?? [])),
    ...npm.flatMap(item => item.standardTexts ?? [])
  ])

  const attached = new Set([
    ...rust.map(notice => notice.file),
    ...bundles.flatMap(bundle => bundle.components.flatMap(component => component.attachedFiles ?? []))
  ])

  for (const file of [...appended, ...attached]) {
    for (const reference of read(file).match(TEXT_REFERENCE) ?? []) {
      appended.add(reference)
    }
  }

  return {
    appended: [...appended].map(licensePath).sort(compare),
    attached: [...attached]
      .filter(file => !appended.has(file))
      .map(licensePath)
      .sort(compare)
  }
}

/**
 * Writes the notice into a package's Resources: Resources/licenses/THIRD-PARTY-NOTICES.txt for
 * the engine staged at Resources/drive-engine, Electron's notices from the installed electron
 * package, Contents/Frameworks, the npm packages of the lockfile and of the build evidence, and
 * the bundles under Resources. The licence texts must already be in Resources/licenses
 * (extraResources).
 */
export function writeThirdPartyNotices({
  resources,
  electronVersion,
  bundled = [],
  catalogFile = ENGINE_CATALOG,
  appCatalogFile = APP_CATALOG,
  repoRoot = REPO_ROOT,
  workspace = 'apps/desktop',
  engineRoot = path.join(resources, 'drive-engine'),
  frameworksRoot = path.join(resources, '..', 'Frameworks'),
  bundlesRoot = resources,
  requireFrom = DESKTOP_ROOT
} = {}) {
  if (typeof resources !== 'string' || !resources) {
    throw invalid('resources')
  }

  const target = path.join(resources, NOTICES_DIRECTORY)

  if (!isDirectory(target)) {
    throw invalid('license_texts_not_packaged')
  }

  const catalog = readEngineCatalog({ catalogFile, licensesRoot: target })
  const app = readAppCatalog({ catalogFile: appCatalogFile, licensesRoot: target })
  const staged = readStagedEngine(engineRoot)

  if (staged.sourceCommit !== catalog.engine.sourceCommit) {
    throw invalid(`engine_source_unlisted:${staged.sourceCommit}`)
  }

  const items = listEngineItems(staged.bundle)
  const components = mapEngineComponents(catalog, items)
  const frameworkItems = listAppFrameworks(frameworksRoot)
  const frameworks = mapAppFrameworks(app, frameworkItems)
  const bundles = presentBundles(app, bundlesRoot)
  const npm = collectNpmPackages({ repoRoot, workspace, bundled, licenseChoices: app.npmLicenseChoices ?? {} })
  const rust = rustNotices(app, npm)
  const electronSources = electronNoticeSources({ electronVersion, requireFrom })

  // The Chromium and FFmpeg sources the notice names belong to one Electron release.
  if (app.electron.version !== electronSources.version) {
    throw invalid(`app_catalog_electron_version:${app.electron.version}:${electronSources.version}`)
  }

  mkdirSync(path.join(target, 'electron'), { recursive: true })

  for (const [relative, source] of Object.entries(electronSources.files)) {
    copyFileSync(source, path.join(target, relative))
  }

  const read = file => {
    const absolute = path.join(target, licensePath(file))

    if (!isFile(absolute)) {
      throw invalid(`license_text_not_packaged:${file}`)
    }

    return readFileSync(absolute, 'utf8')
  }

  const { appended, attached } = referencedTexts({ catalog, app, frameworks, bundles, npm, rust, read })
  const texts = new Map(appended.map(file => [file, read(file)]))
  const notice = renderThirdPartyNotices({
    catalog,
    engine: { sourceCommit: staged.sourceCommit, bundleName: staged.bundleName, components },
    npm,
    electron: {
      version: electronSources.version,
      license: readFileSync(path.join(target, 'electron/LICENSE.electron.txt'), 'utf8')
    },
    texts,
    attached,
    app,
    frameworks,
    bundles,
    rust
  })

  writeFileSync(path.join(target, NOTICE_FILE), notice)

  const digest = file => sha256(readFileSync(path.join(target, file)))

  const inventory = {
    schema: NOTICE_INVENTORY_SCHEMA,
    notice: { path: NOTICE_FILE, bytes: Buffer.byteLength(notice), sha256: sha256(notice) },
    engine: {
      sourceCommit: staged.sourceCommit,
      bundle: staged.bundleName,
      items,
      components: components.map(component => ({
        id: component.id,
        name: component.name,
        version: component.version,
        license: component.license,
        files: component.shipped
      }))
    },
    frameworks: {
      items: frameworkItems,
      components: frameworks.map(framework => ({ id: framework.id, files: framework.shipped }))
    },
    bundles: bundles.map(bundle => ({
      id: bundle.id,
      folder: bundle.folder,
      shippedFiles: bundle.components
        .flatMap(component => [...(component.shippedFiles ?? []), ...(component.files ?? [])])
        .sort(compare)
    })),
    electron: {
      version: electronSources.version,
      files: Object.keys(ELECTRON_NOTICE_FILES).map(file => ({ path: file, sha256: digest(file) }))
    },
    npm: npm.map(item => ({ name: item.name, version: item.version, license: item.license,
      ...(item.declaredLicense ? { declaredLicense: item.declaredLicense } : {}) })),
    texts: [
      ...appended.map(file => ({ path: file, sha256: digest(file) })),
      ...attached.map(file => ({ path: file, sha256: digest(file), attached: true }))
    ]
  }

  writeFileSync(path.join(target, NOTICE_INVENTORY_FILE), `${JSON.stringify(inventory, null, 2)}\n`)

  return inventory
}

// ---------------------------------------------------------------------------------------------
// The check

/**
 * Checks a package's notice against what the package ships, reading files only: the notice and
 * every licence text match the inventory's digests, the required texts and Electron's notices are
 * there, the inventory names exactly the engine items and revision that are staged and the
 * entries of Contents/Frameworks, and the licence files the bundles ship are in place.
 */
export function auditThirdPartyNotices({ resources }) {
  if (typeof resources !== 'string' || !path.isAbsolute(resources)) {
    return { issues: ['resources'], observed: null }
  }

  const issues = []
  const target = path.join(resources, NOTICES_DIRECTORY)
  const fileSha = file => (isFile(file) ? sha256(readFileSync(file)) : null)
  let inventory = null

  try {
    inventory = JSON.parse(readFileSync(path.join(target, NOTICE_INVENTORY_FILE), 'utf8'))
  } catch {
    issues.push('inventory_missing')
  }

  if (inventory && inventory.schema !== NOTICE_INVENTORY_SCHEMA) {
    issues.push('inventory_schema')
    inventory = null
  }

  const notice = path.join(target, NOTICE_FILE)

  if (!isFile(notice) || statSync(notice).size === 0) {
    issues.push('notice_missing')
  } else if (inventory && fileSha(notice) !== inventory.notice?.sha256) {
    issues.push('notice_changed')
  }

  const texts = Array.isArray(inventory?.texts) ? inventory.texts : []

  for (const required of REQUIRED_LICENSE_TEXTS) {
    if (!isFile(path.join(target, required)) || !texts.some(entry => entry?.path === required)) {
      issues.push(`license_text_missing:${required}`)
    }
  }

  for (const entry of texts) {
    let relative

    try {
      relative = licensePath(entry?.path)
    } catch {
      issues.push('inventory_text_path')
      continue
    }

    if (fileSha(path.join(target, relative)) !== entry.sha256) {
      issues.push(`license_text_changed:${relative}`)
    }
  }

  const electronFiles = Array.isArray(inventory?.electron?.files) ? inventory.electron.files : []

  for (const file of Object.keys(ELECTRON_NOTICE_FILES)) {
    const recorded = electronFiles.find(entry => entry?.path === file)
    const absolute = path.join(target, file)

    if (!isFile(absolute) || statSync(absolute).size === 0 || !recorded || fileSha(absolute) !== recorded.sha256) {
      issues.push(`electron_notice_missing:${file}`)
    }
  }

  if (inventory && (!Array.isArray(inventory.npm) || !inventory.npm.length)) {
    issues.push('npm_packages_missing')
  }

  const engineRoot = path.join(resources, 'drive-engine')

  if (!isFile(path.join(engineRoot, 'manifest.json'))) {
    issues.push('engine_manifest_missing')
  } else if (inventory) {
    try {
      const staged = readStagedEngine(engineRoot)
      const items = listEngineItems(staged.bundle)
      const covered = new Set((inventory.engine?.components ?? []).flatMap(component => component?.files ?? []))

      if (staged.sourceCommit !== inventory.engine?.sourceCommit) {
        issues.push('engine_revision_changed')
      }

      if (JSON.stringify(items) !== JSON.stringify(inventory.engine?.items)) {
        issues.push('engine_items_changed')
      }

      for (const item of items) {
        if (!covered.has(item)) {
          issues.push(`engine_item_uncovered:${item}`)
        }
      }
    } catch {
      issues.push('engine_unreadable')
    }
  }

  if (inventory) {
    // Every entry of Contents/Frameworks, the way the engine's items are checked.
    let frameworkItems = null

    try {
      frameworkItems = listAppFrameworks(path.join(resources, '..', 'Frameworks'))
    } catch {
      issues.push('app_frameworks_missing')
    }

    if (frameworkItems) {
      const covered = new Set((inventory.frameworks?.components ?? []).flatMap(framework => framework?.files ?? []))

      if (JSON.stringify(frameworkItems) !== JSON.stringify(inventory.frameworks?.items)) {
        issues.push('app_frameworks_changed')
      }

      for (const item of frameworkItems) {
        if (!covered.has(item)) {
          issues.push(`app_framework_uncovered:${item}`)
        }
      }
    }

    for (const bundle of Array.isArray(inventory.bundles) ? inventory.bundles : []) {
      for (const file of Array.isArray(bundle?.shippedFiles) ? bundle.shippedFiles : []) {
        let relative

        try {
          relative = licensePath(file)
        } catch {
          issues.push('inventory_bundle_path')
          continue
        }

        if (!isFile(path.join(resources, relative))) {
          issues.push(`bundle_file_missing:${bundle.id}:${relative}`)
        }
      }
    }
  }

  return {
    issues: [...new Set(issues)].sort(compare),
    observed: inventory
      ? {
          noticeSha256: inventory.notice?.sha256 ?? null,
          engineSourceCommit: inventory.engine?.sourceCommit ?? null,
          engineComponents: inventory.engine?.components?.length ?? 0,
          frameworks: inventory.frameworks?.items?.length ?? 0,
          bundles: (inventory.bundles ?? []).map(bundle => bundle?.id),
          npmPackages: inventory.npm?.length ?? 0,
          electronVersion: inventory.electron?.version ?? null,
          licenseTexts: texts.length
        }
      : null
  }
}

/** Refuses a package whose notice is missing, stale or incomplete. */
export function assertThirdPartyNotices({ resources }) {
  const { issues, observed } = auditThirdPartyNotices({ resources })

  if (issues.length) {
    throw invalid(issues.join(','))
  }

  return observed
}

// ---------------------------------------------------------------------------------------------
// CLI: check an app, or preview the notice for an app (and optionally another engine) without
// packaging.

function usage() {
  return [
    'Usage:',
    '  third-party-notices.mjs --audit APP.app',
    '  third-party-notices.mjs --preview OUT_DIR --app APP.app [--engine DRIVE_ENGINE_DIR] [--bundled BUNDLED.json] [--electron-version X.Y.Z]'
  ].join('\n')
}

function flag(args, name) {
  const index = args.indexOf(name)

  return index === -1 ? undefined : args[index + 1]
}

async function main(args = process.argv.slice(2)) {
  const audit = flag(args, '--audit')

  if (audit) {
    const result = auditThirdPartyNotices({ resources: path.join(path.resolve(audit), 'Contents', 'Resources') })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

    if (result.issues.length) {
      process.exitCode = 1
    }

    return
  }

  const preview = flag(args, '--preview')
  const appBundle = flag(args, '--app')

  if (!preview || !appBundle) {
    throw new Error(usage())
  }

  // The preview reads the app (its engine, Contents/Frameworks and Resources bundles) and writes
  // only into OUT_DIR/licenses.
  const contents = path.join(path.resolve(appBundle), 'Contents')
  const resources = path.resolve(preview)
  const target = path.join(resources, NOTICES_DIRECTORY)
  mkdirSync(target, { recursive: true })
  cpSync(LICENSES_SOURCE, target, { recursive: true })

  const engine = flag(args, '--engine')
  const bundledFile = flag(args, '--bundled')
  const builder = readJson(path.join(DESKTOP_ROOT, 'matrix-release-builder.json'), 'builder_config_unreadable')
  const inventory = writeThirdPartyNotices({
    resources,
    engineRoot: engine ? path.resolve(engine) : path.join(contents, 'Resources', 'drive-engine'),
    frameworksRoot: path.join(contents, 'Frameworks'),
    bundlesRoot: path.join(contents, 'Resources'),
    electronVersion: flag(args, '--electron-version') ?? builder.electronVersion,
    bundled: bundledFile ? readJson(path.resolve(bundledFile), 'bundled_packages_unreadable') : []
  })

  process.stdout.write(
    `${JSON.stringify(
      {
        notice: path.join(target, NOTICE_FILE),
        bytes: inventory.notice.bytes,
        engineComponents: inventory.engine.components.length,
        frameworks: inventory.frameworks.items.length,
        bundles: inventory.bundles.map(bundle => bundle.id),
        npmPackages: inventory.npm.length,
        licenseTexts: inventory.texts.length
      },
      null,
      2
    )}\n`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[third-party-notices] ${error.message}`)
    process.exitCode = 1
  })
}
