#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import RUNTIME_BASELINE from '../runtime-baseline.json' with { type: 'json' }
import BROWSER_RUNTIME from '../browser-runtime.json' with { type: 'json' }
import RUNTIME_TOOLS from '../runtime-tools.json' with { type: 'json' }
import { RESTRICTED_RUNTIME_SOURCE_PATHS } from './restricted-runtime-skills.mjs'
import { pruneGooglePreviewDiscoveryDocuments, pruneNonRuntimeSource, runIsolatedImportProbe } from './slim-runtime.mjs'
import { isMain } from './utils.mjs'

export const BUNDLED_PYTHON_VERSION = '3.14.7'
export const BUNDLED_RUNTIME_SCHEMA_VERSION = 3
export { RESTRICTED_PRODUCTIVITY_SKILL_SOURCE_PATHS, RESTRICTED_RUNTIME_SOURCE_PATHS } from './restricted-runtime-skills.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, '..')
const defaultRepoRoot = resolve(desktopRoot, '../..')

const TARGETS = Object.freeze({
  arm64: {
    pythonInstallKey: `cpython-${BUNDLED_PYTHON_VERSION}-macos-aarch64-none`,
    pythonPlatform: 'aarch64-apple-darwin'
  },
  x64: {
    pythonInstallKey: `cpython-${BUNDLED_PYTHON_VERSION}-macos-x86_64-none`,
    pythonPlatform: 'x86_64-apple-darwin'
  }
})

function targetConfig(platform, arch) {
  if (platform !== 'darwin') {
    throw new Error(`bundled runtime currently supports macOS only (got ${platform}-${arch})`)
  }

  const config = TARGETS[arch]

  if (!config) {
    throw new Error(`unsupported macOS bundled-runtime architecture: ${arch}`)
  }

  return config
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function validateBrowserRuntime(config = BROWSER_RUNTIME) {
  const sha256 = /^[0-9a-f]{64}$/u

  if (
    config?.schemaVersion !== 1 ||
    config.target?.platform !== RUNTIME_BASELINE.acceptedArtifact.platform ||
    config.target?.arch !== RUNTIME_BASELINE.acceptedArtifact.arch ||
    config.node?.version !== '22.22.0' ||
    !config.node?.url?.startsWith('https://nodejs.org/dist/v22.22.0/') ||
    !sha256.test(config.node?.sha256 || '') ||
    !sha256.test(config.node?.executableSha256 || '') ||
    config.agentBrowser?.version !== '0.26.0' ||
    !String(config.agentBrowser?.packageIntegrity || '').startsWith('sha512-') ||
    !sha256.test(config.agentBrowser?.sha256 || '') ||
    config.chromium?.name !== 'chromium-headless-shell' ||
    config.chromium?.playwrightVersion !== '1.58.2' ||
    config.chromium?.revision !== '1208' ||
    !config.chromium?.url?.startsWith('https://cdn.playwright.dev/builds/cft/') ||
    !sha256.test(config.chromium?.sha256 || '') ||
    !sha256.test(config.chromium?.executableSha256 || '')
  ) {
    throw new Error('invalid committed browser runtime lock')
  }

  return config
}

function browserRuntimeConfig(platform, arch, config = BROWSER_RUNTIME) {
  const locked = validateBrowserRuntime(config)

  return platform === locked.target.platform && arch === locked.target.arch ? locked : null
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    maxBuffer: 16 * 1024 * 1024
  })

  if (result.error) {
    throw new Error(`${command} could not start: ${result.error.message}`)
  }

  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}${detail ? `:\n${detail}` : ''}`)
  }

  return options.capture ? String(result.stdout || '').trim() : ''
}

function gitValue(repoRoot, revision) {
  return run('git', ['-C', repoRoot, 'rev-parse', revision], { capture: true })
}

function isCommit(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value)
}

function validateRuntimeBaseline(baseline = RUNTIME_BASELINE) {
  if (
    baseline?.schemaVersion !== 1 ||
    !isCommit(baseline.upstreamHermesCommit) ||
    !isCommit(baseline.atumOverlayCommit) ||
    !isCommit(baseline.atumOverlayTree) ||
    baseline.historyRef !== 'atum-main' ||
    baseline.acceptedArtifact?.platform !== 'darwin' ||
    baseline.acceptedArtifact?.arch !== 'arm64' ||
    baseline.acceptedArtifact?.format !== 'dmg'
  ) {
    throw new Error('invalid committed Hermes runtime baseline')
  }

  return baseline
}

function gitCommandSucceeds(repoRoot, args) {
  try {
    run('git', ['-C', repoRoot, ...args], { capture: true })

    return true
  } catch {
    return false
  }
}

function hasRuntimeBaselineHistory(repoRoot, baseline) {
  return (
    gitCommandSucceeds(repoRoot, ['cat-file', '-e', `${baseline.atumOverlayCommit}^{commit}`]) &&
    gitCommandSucceeds(repoRoot, ['cat-file', '-e', `${baseline.upstreamHermesCommit}^{commit}`]) &&
    gitCommandSucceeds(repoRoot, [
      'merge-base',
      '--is-ancestor',
      baseline.upstreamHermesCommit,
      baseline.atumOverlayCommit
    ]) &&
    gitCommandSucceeds(repoRoot, ['merge-base', '--is-ancestor', baseline.atumOverlayCommit, 'HEAD'])
  )
}

function ensureRuntimeBaselineHistory(repoRoot, baseline) {
  if (hasRuntimeBaselineHistory(repoRoot, baseline)) {
    return false
  }

  if (gitValue(repoRoot, '--is-shallow-repository') !== 'true') {
    throw new Error('pinned Hermes runtime history is missing from a non-shallow package checkout')
  }

  // Hosted pull-request jobs intentionally start from a one-commit checkout.
  // Hydrate only the canonical authority branch, without tags or file blobs,
  // then perform the same ancestry and tree checks used by a full checkout.
  run(
    'git',
    ['-C', repoRoot, 'fetch', '--no-tags', '--filter=blob:none', '--unshallow', 'origin', baseline.historyRef],
    { capture: true }
  )

  if (!hasRuntimeBaselineHistory(repoRoot, baseline)) {
    throw new Error(`pinned Hermes runtime history is absent after hydrating ${baseline.historyRef} from origin`)
  }

  return true
}

function assertRuntimeBaselineInRepo(repoRoot, baseline = RUNTIME_BASELINE) {
  const validated = validateRuntimeBaseline(baseline)
  ensureRuntimeBaselineHistory(repoRoot, validated)
  const actualOverlayTree = gitValue(repoRoot, `${validated.atumOverlayCommit}^{tree}`)

  if (actualOverlayTree !== validated.atumOverlayTree) {
    throw new Error(`Atum overlay tree mismatch: pinned ${validated.atumOverlayTree}, actual ${actualOverlayTree}`)
  }

  run('git', [
    '-C',
    repoRoot,
    'merge-base',
    '--is-ancestor',
    validated.upstreamHermesCommit,
    validated.atumOverlayCommit
  ])
  run('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', validated.atumOverlayCommit, 'HEAD'])

  return validated
}

function assertSafeRuntimeTarget(targetRoot) {
  const resolvedTarget = resolve(targetRoot)

  if (resolvedTarget === '/' || !['runtime', 'runtime-test'].includes(resolvedTarget.split('/').at(-1))) {
    throw new Error(`refusing unsafe bundled-runtime target: ${resolvedTarget}`)
  }

  return resolvedTarget
}

function assertCleanPackageSource(status, allowDirty = process.env.ATUM_ALLOW_DIRTY_BUNDLED_RUNTIME === '1') {
  const dirty = String(status || '').trim().length > 0

  if (dirty && !allowDirty) {
    throw new Error(
      'refusing to package a split renderer/backend tree: commit tracked changes first, or set ATUM_ALLOW_DIRTY_BUNDLED_RUNTIME=1 for an explicitly non-reproducible development artifact'
    )
  }

  return dirty
}

function archiveHermesSource({ repoRoot, commit, destination, scratchRoot }) {
  const archivePath = join(scratchRoot, 'hermes-agent.tar')
  mkdirSync(destination, { recursive: true })
  run('git', ['-C', repoRoot, 'archive', '--format=tar', '--output', archivePath, commit])
  run('tar', ['-xf', archivePath, '-C', destination])
  rmSync(archivePath, { force: true })
}

/** Remove only known non-redistributable source paths from an archived runtime tree. */
export function excludeRestrictedStagedSkills(stagedSourceRoot) {
  const sourceRoot = resolve(stagedSourceRoot)

  for (const sourcePath of RESTRICTED_RUNTIME_SOURCE_PATHS) {
    const stagedPath = resolve(sourceRoot, sourcePath)

    if (relative(sourceRoot, stagedPath).startsWith(`..${sep}`) || relative(sourceRoot, stagedPath) === '..') {
      throw new Error(`restricted staged skill path escapes source root: ${sourcePath}`)
    }
    rmSync(stagedPath, { recursive: true, force: true })
  }

  return [...RESTRICTED_RUNTIME_SOURCE_PATHS]
}

/**
 * Where a pinned archive may be fetched from, when the canonical host cannot be
 * reached from here.
 *
 * `cdn.playwright.dev/builds/cft/...` redirects to Google's
 * `chrome-for-testing-public` bucket, which answers some regions with
 * `AccessDenied: this service is not available in your location`. That is a
 * hard 403 for every version, so a contributor in one of those regions cannot
 * build the app at all — while CI, on US runners, never sees it.
 *
 * This does NOT relax the integrity guarantee, which is the whole reason it is
 * safe: the archive is still verified against the sha256 pinned in
 * `browser-runtime.json`, so a mirror can only supply the exact bytes the
 * canonical host would have. A mirror serving anything else fails the same way
 * a corrupted download does.
 *
 * Only the origin and any path prefix are substituted; the version, platform
 * and filename continue to come from the pinned config, so the variable cannot
 * be aimed at an unrelated file.
 *
 * Applies to the Chrome for Testing archive ONLY. Node comes from nodejs.org,
 * which is not geo-blocked, and rewriting it through a Chrome mirror would ask
 * for a path that does not exist there.
 *
 * Usage — the npm mirror carries Chrome for Testing verbatim:
 *
 *   ATUM_BROWSER_RUNTIME_MIRROR=https://cdn.npmmirror.com/binaries/chrome-for-testing \
 *     npm run pack:prod --workspace apps/desktop
 */
function mirroredArchiveUrl(url, mirror = process.env.ATUM_BROWSER_RUNTIME_MIRROR) {
  const base = (mirror ?? '').trim().replace(/\/+$/u, '')

  if (!base) {
    return url
  }

  if (!base.startsWith('https://')) {
    throw new Error('ATUM_BROWSER_RUNTIME_MIRROR must be an https URL')
  }

  // Keep everything that identifies WHICH artifact this is — the trailing
  // `<version>/<platform>/<file>` — and replace only where it is served from.
  const tail = new URL(url).pathname.split('/').filter(Boolean).slice(-3).join('/')

  return `${base}/${tail}`
}

function downloadVerifiedArchive({ url, sha256, destination, mirror = null }) {
  run('curl', [
    '--fail',
    '--location',
    '--proto',
    '=https',
    '--proto-redir',
    '=https',
    '--silent',
    '--show-error',
    '--output',
    destination,
    mirror === null ? url : mirroredArchiveUrl(url, mirror)
  ])
  const actual = sha256File(destination)

  if (actual !== sha256) {
    throw new Error(`downloaded runtime archive digest mismatch: expected ${sha256}, got ${actual}`)
  }
}

function assertLockedBrowserDependencies(repoRoot, config = BROWSER_RUNTIME) {
  const locked = validateBrowserRuntime(config)
  const packageLock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'))
  const agentBrowserPackage = packageLock.packages?.['node_modules/agent-browser']
  // npm may hoist the same pinned version when another workspace uses Playwright.
  const playwrightPackage =
    packageLock.packages?.['apps/desktop/node_modules/playwright-core'] ??
    packageLock.packages?.['node_modules/playwright-core']

  if (
    packageLock.packages?.['']?.dependencies?.['agent-browser'] !== locked.agentBrowser.version ||
    agentBrowserPackage?.version !== locked.agentBrowser.version ||
    agentBrowserPackage?.integrity !== locked.agentBrowser.packageIntegrity ||
    playwrightPackage?.version !== locked.chromium.playwrightVersion
  ) {
    throw new Error('browser runtime lock does not match package-lock.json')
  }

  const agentBrowserSource = join(repoRoot, locked.agentBrowser.source)
  const agentBrowserLicense = join(repoRoot, 'node_modules', 'agent-browser', 'LICENSE')

  if (!existsSync(agentBrowserSource) || !existsSync(agentBrowserLicense)) {
    throw new Error('locked agent-browser package is missing; run npm ci before packaging')
  }
  if (sha256File(agentBrowserSource) !== locked.agentBrowser.sha256) {
    throw new Error('installed agent-browser binary does not match the committed browser runtime lock')
  }

  return { agentBrowserLicense, agentBrowserSource, locked }
}

function stageNodeRuntime({ extractedRoot, browserRoot, config }) {
  const sourceRoot = join(extractedRoot, config.node.root)
  const nodeRoot = join(browserRoot, 'node')
  const node = join(nodeRoot, config.node.executable)
  const npmSource = join(sourceRoot, 'lib', 'node_modules', 'npm')

  mkdirSync(dirname(node), { recursive: true })
  cpSync(join(sourceRoot, config.node.executable), node)
  chmodSync(node, 0o755)
  cpSync(join(sourceRoot, 'LICENSE'), join(nodeRoot, 'LICENSE'))

  // npm and npx from the same pinned, checksum-verified archive (FR18): most MCP servers and
  // many skills run through npx, and a fresh Mac has neither. Pure JavaScript, run by this
  // node (first on the assistant's PATH); global installs go to the agent's home, never here.
  if (!existsSync(join(npmSource, 'package.json'))) {
    throw new Error('pinned Node archive does not carry npm')
  }

  cpSync(npmSource, join(nodeRoot, 'lib', 'node_modules', 'npm'), { recursive: true, verbatimSymlinks: true })

  for (const [name, script] of [
    ['npm', 'npm-cli.js'],
    ['npx', 'npx-cli.js']
  ]) {
    symlinkSync(`../lib/node_modules/npm/bin/${script}`, join(nodeRoot, 'bin', name))
  }

  return node
}

const RUNTIME_TOOL_HOSTS = ['https://github.com/', 'https://raw.githubusercontent.com/']

/** The committed pins for the assistant's command-line tools (uv/uvx). */
function validateRuntimeTools(config = RUNTIME_TOOLS) {
  const sha256 = /^[0-9a-f]{64}$/u
  const pinned = url => typeof url === 'string' && RUNTIME_TOOL_HOSTS.some(host => url.startsWith(host))
  const name = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)

  const tool = entry =>
    /^\d+\.\d+\.\d+$/u.test(entry?.version || '') &&
    name(entry.archive) &&
    pinned(entry.url) &&
    entry.url.includes(entry.version) &&
    entry.url.endsWith(`/${entry.archive}`) &&
    sha256.test(entry.sha256 || '') &&
    (entry.root === '.' || name(entry.root)) &&
    Array.isArray(entry.executables) &&
    entry.executables.length > 0 &&
    entry.executables.every(executable => name(executable?.name) && sha256.test(executable.sha256 || '')) &&
    typeof entry.license === 'string' &&
    Array.isArray(entry.licenses) &&
    entry.licenses.length > 0 &&
    entry.licenses.every(license => name(license?.name) && pinned(license.url) && sha256.test(license.sha256 || ''))

  if (
    config?.schemaVersion !== 1 ||
    config.target?.platform !== RUNTIME_BASELINE.acceptedArtifact.platform ||
    config.target?.arch !== RUNTIME_BASELINE.acceptedArtifact.arch ||
    !tool(config.uv)
  ) {
    throw new Error('invalid committed runtime tools lock')
  }

  return config
}

function runtimeToolsConfig(platform, arch, config = RUNTIME_TOOLS) {
  const locked = validateRuntimeTools(config)

  return platform === locked.target.platform && arch === locked.target.arch ? locked : null
}

/**
 * The assistant's command-line tools, pinned and verified like the browser payload (FR18):
 * uv and uvx (Python tools and MCP servers). Each tool lands in `tools/<name>/bin` beside its
 * licence texts. tirith (the command scanner) is not bundled: it is AGPL-3.0, and shipping
 * it would need a licence sign-off on every publish, so Hermes downloads it into the agent
 * home on first use as before. `download` is injectable so the layout is testable without
 * the network.
 */
function stageRuntimeTools({
  scratchRoot,
  platform,
  arch,
  config: lock = RUNTIME_TOOLS,
  download = downloadVerifiedArchive,
  extract = (archive, destination) => run('tar', ['-xzf', archive, '-C', destination]),
  // Identity is the pinned digest; this only refuses a binary for another architecture.
  probe = executables => {
    const identity = run('file', executables, { capture: true })

    if (!identity.split('\n').every(line => line.includes(arch))) {
      throw new Error(`staged runtime tools contain a non-${arch} executable:\n${identity}`)
    }
  }
}) {
  const config = runtimeToolsConfig(platform, arch, lock)

  if (!config) return null

  const toolsRoot = join(scratchRoot, 'tools')
  const downloadRoot = join(scratchRoot, '.tools-downloads')
  const staged = {}

  mkdirSync(downloadRoot, { recursive: true })

  try {
    for (const id of ['uv']) {
      const entry = config[id]
      const archive = join(downloadRoot, entry.archive)
      const extracted = join(downloadRoot, id)
      const toolRoot = join(toolsRoot, id)

      download({ url: entry.url, sha256: entry.sha256, destination: archive })
      mkdirSync(extracted, { recursive: true })
      extract(archive, extracted)
      mkdirSync(join(toolRoot, 'bin'), { recursive: true })

      for (const executable of entry.executables) {
        const source = join(extracted, entry.root, executable.name)
        const target = join(toolRoot, 'bin', executable.name)

        if (sha256File(source) !== executable.sha256) {
          throw new Error(`staged ${executable.name} does not match the committed runtime tools lock`)
        }

        cpSync(source, target)
        chmodSync(target, 0o755)
      }

      for (const license of entry.licenses) {
        download({ url: license.url, sha256: license.sha256, destination: join(toolRoot, license.name) })
      }

      probe(entry.executables.map(executable => join(toolRoot, 'bin', executable.name)))

      staged[id] = {
        version: entry.version,
        license: entry.license,
        archiveSha256: entry.sha256,
        executables: entry.executables.map(executable => ({
          path: `tools/${id}/bin/${executable.name}`,
          sha256: executable.sha256
        }))
      }
    }
  } finally {
    rmSync(downloadRoot, { recursive: true, force: true })
  }

  return { schemaVersion: config.schemaVersion, ...staged }
}

function probeStagedBrowserRuntime({ browserRoot, config, expectedArch }) {
  const node = join(browserRoot, 'node', config.node.executable)
  const agentBrowser = join(browserRoot, 'bin', 'agent-browser')
  const chromium = join(browserRoot, 'chromium', config.chromium.root, config.chromium.executable)
  const binaryIdentity = run('file', [node, agentBrowser, chromium], { capture: true })

  if (!binaryIdentity.split('\n').every(line => line.includes('arm64'))) {
    throw new Error(`staged browser runtime contains a non-arm64 executable:\n${binaryIdentity}`)
  }
  if (expectedArch !== process.arch) {
    console.warn(
      `[stage-bundled-runtime] staged browser runtime ${expectedArch} on ${process.arch}; skipping executable version probes`
    )
    return
  }

  const nodeVersion = run(node, ['--version'], { capture: true })
  const agentBrowserVersion = run(agentBrowser, ['--version'], { capture: true })
  const chromiumVersion = run(chromium, ['--version'], { capture: true })

  if (nodeVersion !== `v${config.node.version}`) throw new Error(`unexpected staged Node version: ${nodeVersion}`)
  if (!agentBrowserVersion.includes(config.agentBrowser.version)) {
    throw new Error(`unexpected staged agent-browser version: ${agentBrowserVersion}`)
  }
  if (!chromiumVersion.includes(config.chromium.browserVersion)) {
    throw new Error(`unexpected staged Chromium version: ${chromiumVersion}`)
  }
}

function stageBrowserRuntime({ repoRoot, scratchRoot, platform, arch }) {
  const config = browserRuntimeConfig(platform, arch)

  if (!config) return null

  const { agentBrowserLicense, agentBrowserSource } = assertLockedBrowserDependencies(repoRoot, config)
  const browserRoot = join(scratchRoot, 'browser')
  const downloadRoot = join(scratchRoot, '.browser-downloads')
  const nodeArchive = join(downloadRoot, config.node.archive)
  const chromiumArchive = join(downloadRoot, config.chromium.archive)
  const nodeExtractRoot = join(downloadRoot, 'node')
  const chromiumRoot = join(browserRoot, 'chromium')
  const agentBrowser = join(browserRoot, 'bin', 'agent-browser')

  mkdirSync(nodeExtractRoot, { recursive: true })
  mkdirSync(chromiumRoot, { recursive: true })
  mkdirSync(dirname(agentBrowser), { recursive: true })
  mkdirSync(join(browserRoot, 'licenses'), { recursive: true })

  downloadVerifiedArchive({ url: config.node.url, sha256: config.node.sha256, destination: nodeArchive })
  run('tar', ['-xzf', nodeArchive, '-C', nodeExtractRoot])
  stageNodeRuntime({ extractedRoot: nodeExtractRoot, browserRoot, config })

  cpSync(agentBrowserSource, agentBrowser)
  chmodSync(agentBrowser, 0o755)
  cpSync(agentBrowserLicense, join(browserRoot, 'licenses', 'agent-browser-LICENSE'))

  downloadVerifiedArchive({
    url: config.chromium.url,
    sha256: config.chromium.sha256,
    destination: chromiumArchive,
    // Only this artifact is geo-blocked; the digest pin below is unchanged, so
    // a mirror can supply nothing but the exact canonical bytes.
    mirror: process.env.ATUM_BROWSER_RUNTIME_MIRROR ?? ''
  })
  run('ditto', ['-x', '-k', chromiumArchive, chromiumRoot])
  rmSync(downloadRoot, { recursive: true, force: true })

  probeStagedBrowserRuntime({ browserRoot, config, expectedArch: arch })

  const node = join(browserRoot, 'node', config.node.executable)
  const chromium = join(chromiumRoot, config.chromium.root, config.chromium.executable)

  if (sha256File(node) !== config.node.executableSha256) {
    throw new Error('staged Node executable does not match the committed browser runtime lock')
  }
  if (sha256File(chromium) !== config.chromium.executableSha256) {
    throw new Error('staged Chromium executable does not match the committed browser runtime lock')
  }
  if (sha256File(agentBrowser) !== config.agentBrowser.sha256) {
    throw new Error('staged agent-browser executable does not match the committed browser runtime lock')
  }

  return {
    schemaVersion: config.schemaVersion,
    node: {
      version: config.node.version,
      archiveSha256: config.node.sha256,
      executable: `browser/node/${config.node.executable}`,
      executableSha256: config.node.executableSha256
    },
    agentBrowser: {
      version: config.agentBrowser.version,
      packageIntegrity: config.agentBrowser.packageIntegrity,
      executable: 'browser/bin/agent-browser',
      executableSha256: config.agentBrowser.sha256
    },
    chromium: {
      name: config.chromium.name,
      browserVersion: config.chromium.browserVersion,
      playwrightVersion: config.chromium.playwrightVersion,
      revision: config.chromium.revision,
      archiveSha256: config.chromium.sha256,
      executable: `browser/chromium/${config.chromium.root}/${config.chromium.executable}`,
      executableSha256: config.chromium.executableSha256
    }
  }
}

function rewriteInternalAbsoluteSymlinks(root, copiedFrom) {
  let rewritten = 0

  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name)

      if (entry.isDirectory()) {
        visit(entryPath)
        continue
      }

      if (!entry.isSymbolicLink()) continue
      const linkTarget = readlinkSync(entryPath)
      if (!isAbsolute(linkTarget)) continue

      const sourcePrefix = `${copiedFrom}${sep}`
      if (linkTarget !== copiedFrom && !linkTarget.startsWith(sourcePrefix)) continue

      const bundledTarget = join(root, relative(copiedFrom, linkTarget))
      const relativeTarget = relative(dirname(entryPath), bundledTarget) || '.'
      unlinkSync(entryPath)
      symlinkSync(relativeTarget, entryPath)
      rewritten += 1
    }
  }

  visit(root)
  return rewritten
}

function removeBytecodeCaches(root) {
  let removed = 0

  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name)

      if (entry.isDirectory()) {
        if (entry.name === '__pycache__') {
          rmSync(entryPath, { recursive: true, force: true })
          removed += 1
          continue
        }
        visit(entryPath)
        continue
      }

      if (entry.isFile() && (entry.name.endsWith('.pyc') || entry.name.endsWith('.pyo'))) {
        rmSync(entryPath, { force: true })
        removed += 1
      }
    }
  }

  visit(root)
  return removed
}

function compileRelocatableBytecode({ pythonRoot, sourceRoots = [] }) {
  const python = join(pythonRoot, 'bin', 'python3.14')
  run(python, ['-B', '-m', 'compileall', '--invalidation-mode', 'unchecked-hash', '-q', pythonRoot, ...sourceRoots], {
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1'
    }
  })
}

/**
 * uv gives libpython the install name of the folder it installed into, a path on the build
 * machine (with its user name) that would otherwise ship inside Atum.app. Nothing loads libpython
 * by that name: python3.14 uses @executable_path. Name it @rpath/libpython3.14.dylib instead and
 * re-sign it ad hoc, since an arm64 binary must stay signed to load; electron-builder signs it
 * again with the app.
 */
function pythonInstallNameCommands(pythonRoot) {
  const library = join(pythonRoot, 'lib', 'libpython3.14.dylib')

  return [
    ['install_name_tool', ['-id', '@rpath/libpython3.14.dylib', library]],
    ['codesign', ['--force', '--sign', '-', library]]
  ]
}

function installPython({ uv, scratchRoot, destination, pythonInstallKey }) {
  const installRoot = join(scratchRoot, 'python-install')
  run(uv, ['python', 'install', pythonInstallKey, '--install-dir', installRoot, '--no-bin', '--no-config'])

  const installedRoot = join(installRoot, pythonInstallKey)

  if (!existsSync(join(installedRoot, 'bin', 'python3.14'))) {
    throw new Error(`uv did not produce the expected Python runtime at ${installedRoot}`)
  }

  cpSync(installedRoot, destination, { recursive: true })
  rewriteInternalAbsoluteSymlinks(destination, installedRoot)

  for (const [command, args] of pythonInstallNameCommands(destination)) {
    run(command, args)
  }

  rmSync(installRoot, { recursive: true, force: true })
}

function installLockedDependencies({ uv, repoRoot, scratchRoot, pythonRoot, pythonPlatform }) {
  const requirements = join(scratchRoot, 'requirements.locked.txt')
  const sitePackages = join(pythonRoot, 'lib', 'python3.14', 'site-packages')

  run(
    uv,
    [
      'export',
      '--frozen',
      '--no-dev',
      '--extra',
      'all',
      '--no-emit-project',
      '--format',
      'requirements-txt',
      '--output-file',
      requirements,
      '--no-config'
    ],
    // uv writes the exported requirements to stdout even with --output-file;
    // capture that duplicate stream so package logs remain useful.
    { cwd: repoRoot, capture: true }
  )

  run(uv, [
    'pip',
    'install',
    '--requirements',
    requirements,
    '--require-hashes',
    // The export is the complete locked closure, including audited uv overrides.
    // Re-resolving wheel metadata would reject the deliberate Pillow/crypto overrides.
    '--no-deps',
    '--only-binary',
    ':all:',
    '--python-version',
    BUNDLED_PYTHON_VERSION,
    '--python-platform',
    pythonPlatform,
    '--target',
    sitePackages,
    '--compile-bytecode',
    '--no-config'
  ])
}

/** RPC names desktop startup calls (apps/desktop/shared/setup-methods.ts); the staged gateway must register them. */
export function requiredSetupMethods(setupMethodsPath = join(desktopRoot, 'shared', 'setup-methods.ts')) {
  const names = [...readFileSync(setupMethodsPath, 'utf8').matchAll(/'([a-z_]+\.[a-z_]+)'/gu)].map(match => match[1])

  if (names.length === 0) {
    throw new Error(`no setup RPC methods found in ${setupMethodsPath}`)
  }

  return [...new Set(names)]
}

function probeStagedRuntime({ pythonRoot, sourceRoot, expectedArch }) {
  if (expectedArch !== process.arch) {
    console.warn(
      `[stage-bundled-runtime] staged ${expectedArch} on ${process.arch}; skipping executable probe (package audit must run on target hardware)`
    )
    return
  }

  const python = join(pythonRoot, 'bin', 'python3.14')
  // The tree was pruned of tests, docs and app sources first, so prove the gateway the desktop
  // talks to still imports from it and still serves every RPC startup setup depends on. The probe
  // is isolated (python -I, scratch cwd, only the staged tree on sys.path) and asserts every Hermes
  // module resolved INSIDE the staged tree, so a runtime file the prune removed cannot be masked
  // by the full checkout this script runs from.
  const parsed = runIsolatedImportProbe({
    python,
    sourceRoot,
    expectedPythonRoot: pythonRoot,
    inside: ['hermes_cli', 'hermes_cli.config', 'tui_gateway', 'tui_gateway.server'],
    other: ['yaml', 'dotenv'],
    methods: requiredSetupMethods()
  })

  if (!String(parsed.python).startsWith('3.14.')) {
    throw new Error(`staged runtime probe returned unexpected Python ${parsed.python}`)
  }
}

/** Stage the committed runtime tools before Python so the build itself uses the same verified uv
 * that will ship. UV remains an explicit operator override for recovery and diagnostics. */
function stageRuntimeToolchain({
  scratchRoot,
  platform,
  arch,
  uvOverride = process.env.UV,
  stage = stageRuntimeTools
}) {
  const tools = stage({ scratchRoot, platform, arch })
  const bundledUv = tools?.uv ? join(scratchRoot, 'tools', 'uv', 'bin', 'uv') : null

  return {
    tools,
    uv: uvOverride || bundledUv || 'uv'
  }
}

/**
 * Build the immutable payload that is copied to
 * Contents/Resources/runtime before electron-builder signs the app.
 */
export function stageBundledRuntime({
  targetRoot,
  platform = process.platform,
  arch = process.arch,
  repoRoot = defaultRepoRoot,
  uv = process.env.UV
}) {
  const target = assertSafeRuntimeTarget(targetRoot)
  const targetSpec = targetConfig(platform, arch)
  const scratchRoot = `${target}.staging-${process.pid}`
  const pythonRoot = join(scratchRoot, 'python')
  const sourceRoot = join(scratchRoot, 'hermes-agent')
  const commit = gitValue(repoRoot, 'HEAD')
  const tree = gitValue(repoRoot, `${commit}^{tree}`)
  const baseline = assertRuntimeBaselineInRepo(repoRoot)
  const dirty = assertCleanPackageSource(
    run('git', ['-C', repoRoot, 'status', '--porcelain', '--untracked-files=no'], { capture: true })
  )

  rmSync(scratchRoot, { recursive: true, force: true })
  mkdirSync(scratchRoot, { recursive: true })

  try {
    const toolchain = stageRuntimeToolchain({ scratchRoot, platform, arch, uvOverride: uv })
    installPython({
      uv: toolchain.uv,
      scratchRoot,
      destination: pythonRoot,
      pythonInstallKey: targetSpec.pythonInstallKey
    })
    installLockedDependencies({
      uv: toolchain.uv,
      repoRoot,
      scratchRoot,
      pythonRoot,
      pythonPlatform: targetSpec.pythonPlatform
    })
    archiveHermesSource({ repoRoot, commit, destination: sourceRoot, scratchRoot })
    const excludedSourcePaths = excludeRestrictedStagedSkills(sourceRoot)
    // Ship only what runs: tests, internal docs, the app's own source and the website generator
    // used to ride along (~440 MB), and macOS verifies every byte on each update.
    const slimmedSource = pruneNonRuntimeSource(sourceRoot)
    const prunedGoogleDocuments = pruneGooglePreviewDiscoveryDocuments(pythonRoot)
    const browser = stageBrowserRuntime({ repoRoot, scratchRoot, platform, arch })
    const tools = toolchain.tools
    // Dependency installation may compile bytecode using the temporary staging
    // prefix. Relocating those caches into Atum.app makes Python refresh a small
    // subset on first launch, which mutates the sealed bundle even though the
    // managed backend itself runs with PYTHONDONTWRITEBYTECODE=1. Remove those
    // caches before producing one relocation-safe set below.
    removeBytecodeCaches(pythonRoot)
    probeStagedRuntime({ pythonRoot, sourceRoot, expectedArch: arch })
    // Some Hermes helper processes intentionally sanitize inherited env before
    // re-executing this interpreter. Precompile hash-based bytecode after every
    // source/copy/probe step so those helpers consume sealed, relocation-safe
    // caches instead of creating timestamp caches inside Atum.app.
    compileRelocatableBytecode({ pythonRoot, sourceRoots: [sourceRoot] })

    const manifest = {
      schemaVersion: BUNDLED_RUNTIME_SCHEMA_VERSION,
      builtAt: new Date().toISOString(),
      target: { platform, arch },
      python: {
        implementation: 'cpython',
        version: BUNDLED_PYTHON_VERSION,
        installKey: targetSpec.pythonInstallKey,
        build: readFileSync(join(pythonRoot, 'BUILD'), 'utf8').trim()
      },
      identity: {
        upstreamHermesCommit: baseline.upstreamHermesCommit,
        atumOverlayCommit: baseline.atumOverlayCommit,
        atumOverlayTree: baseline.atumOverlayTree,
        runtimeCommit: commit,
        runtimeTree: tree
      },
      hermes: {
        source: 'git-archive',
        excludedSourcePaths,
        prunedSourcePaths: slimmedSource.removed,
        keptWithinPrunedPaths: slimmedSource.kept,
        prunedGooglePreviewDocuments: prunedGoogleDocuments,
        dirtyCheckoutIgnored: dirty
      },
      lock: {
        file: 'uv.lock',
        sha256: sha256File(join(repoRoot, 'uv.lock')),
        profile: 'all-no-dev'
      },
      browser,
      tools
    }

    writeFileSync(join(scratchRoot, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    rmSync(target, { recursive: true, force: true })
    renameSync(scratchRoot, target)
    console.log(
      `[stage-bundled-runtime] staged Python ${BUNDLED_PYTHON_VERSION} + Hermes ${commit.slice(0, 12)} for ${platform}-${arch} at ${target}`
    )
    return manifest
  } catch (error) {
    rmSync(scratchRoot, { recursive: true, force: true })
    throw error
  }
}

export {
  pythonInstallNameCommands,
  assertCleanPackageSource,
  assertLockedBrowserDependencies,
  assertRuntimeBaselineInRepo,
  assertSafeRuntimeTarget,
  browserRuntimeConfig,
  mirroredArchiveUrl,
  compileRelocatableBytecode,
  ensureRuntimeBaselineHistory,
  hasRuntimeBaselineHistory,
  removeBytecodeCaches,
  rewriteInternalAbsoluteSymlinks,
  runtimeToolsConfig,
  stageBrowserRuntime,
  stageNodeRuntime,
  stageRuntimeToolchain,
  stageRuntimeTools,
  targetConfig,
  validateBrowserRuntime,
  validateRuntimeBaseline,
  validateRuntimeTools
}

if (isMain(import.meta.url)) {
  const targetRoot = process.argv[2]

  if (!targetRoot) {
    console.error('Usage: node scripts/stage-bundled-runtime.mjs /absolute/path/to/runtime [arch]')
    process.exit(2)
  }

  stageBundledRuntime({ targetRoot, arch: process.argv[3] || process.arch })
}
