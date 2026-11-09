import fs from 'node:fs'
import path from 'node:path'

import BROWSER_RUNTIME from '../browser-runtime.json' with { type: 'json' }
import RUNTIME_BASELINE from '../runtime-baseline.json' with { type: 'json' }

import { buildDesktopBackendEnv } from './backend-env'

const BUNDLED_RUNTIME_SCHEMA_VERSION = 3
const BUNDLED_PYTHON_VERSION = '3.14'
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i

const AGENT_BROWSER_STEERING_ENV_KEYS = Object.freeze([
  'AGENT_BROWSER_ACTION_POLICY',
  'AGENT_BROWSER_ALLOWED_DOMAINS',
  'AGENT_BROWSER_ANNOTATE',
  'AGENT_BROWSER_ARGS',
  'AGENT_BROWSER_AUTO_CONNECT',
  'AGENT_BROWSER_COLOR_SCHEME',
  'AGENT_BROWSER_CONFIG',
  'AGENT_BROWSER_CONFIRM_ACTIONS',
  'AGENT_BROWSER_CONFIRM_INTERACTIVE',
  'AGENT_BROWSER_CONTENT_BOUNDARIES',
  'AGENT_BROWSER_DEFAULT_TIMEOUT',
  'AGENT_BROWSER_DOWNLOAD_PATH',
  'AGENT_BROWSER_ENCRYPTION_KEY',
  'AGENT_BROWSER_ENGINE',
  'AGENT_BROWSER_EXTENSIONS',
  'AGENT_BROWSER_HEADED',
  'AGENT_BROWSER_IDLE_TIMEOUT_MS',
  'AGENT_BROWSER_IOS_DEVICE',
  'AGENT_BROWSER_IOS_UDID',
  'AGENT_BROWSER_MAX_OUTPUT',
  'AGENT_BROWSER_NO_AUTO_DIALOG',
  'AGENT_BROWSER_PROFILE',
  'AGENT_BROWSER_PROVIDER',
  'AGENT_BROWSER_PROXY',
  'AGENT_BROWSER_PROXY_BYPASS',
  'AGENT_BROWSER_SCREENSHOT_DIR',
  'AGENT_BROWSER_SCREENSHOT_FORMAT',
  'AGENT_BROWSER_SCREENSHOT_QUALITY',
  'AGENT_BROWSER_SESSION',
  'AGENT_BROWSER_SESSION_NAME',
  'AGENT_BROWSER_SKILLS_DIR',
  'AGENT_BROWSER_SNAPSHOT_ID',
  'AGENT_BROWSER_STATE',
  'AGENT_BROWSER_STATE_EXPIRE_DAYS',
  'AGENT_BROWSER_STREAM_PORT',
  'AGENT_BROWSER_USER_AGENT'
])

class BundledRuntimeIdentityError extends Error {
  readonly code = 'bundled_runtime_identity_invalid'

  constructor(reason: string) {
    super(`Packaged Atum runtime identity is invalid: ${reason}`)
    this.name = 'BundledRuntimeIdentityError'
  }
}

interface BundledRuntimeManifest {
  schemaVersion: number
  target?: {
    platform?: string
    arch?: string
  }
  python?: {
    version?: string
  }
  identity?: {
    upstreamHermesCommit?: string
    atumOverlayCommit?: string
    atumOverlayTree?: string
    runtimeCommit?: string
    runtimeTree?: string
  }
  hermes?: {
    dirtyCheckoutIgnored?: boolean
  }
  browser?: {
    schemaVersion?: number
    node?: {
      version?: string
      archiveSha256?: string
      executable?: string
      executableSha256?: string
    }
    agentBrowser?: {
      version?: string
      packageIntegrity?: string
      executable?: string
      executableSha256?: string
    }
    chromium?: {
      name?: string
      browserVersion?: string
      playwrightVersion?: string
      revision?: string
      archiveSha256?: string
      executable?: string
      executableSha256?: string
    }
  } | null
}

interface BundledRuntimeLayout {
  runtimeRoot: string
  pythonRoot: string
  python: string
  sourceRoot: string
  browserRoot: string
  browserBin: string
  nodeBin: string
  node: string
  agentBrowser: string
  chromium: string
  /** The assistant's command-line tools (uv/uvx; runtime-tools.json), on its PATH. */
  toolBins: string[]
  manifestPath: string
}

interface BundledRuntimeDeps {
  fileExists?: (candidate: string) => boolean
  directoryExists?: (candidate: string) => boolean
  readFile?: (candidate: string) => string
  executableFile?: (candidate: string) => boolean
  probeRuntime?: (python: string, options: { env: NodeJS.ProcessEnv }) => boolean
}

interface ResolveBundledRuntimeOptions extends BundledRuntimeDeps {
  isPackaged: boolean
  platform?: NodeJS.Platform | string
  arch?: string
  resourcesPath?: string
  backendArgs?: string[]
  hermesHome: string
  currentEnv?: NodeJS.ProcessEnv
  expectedProductCommit?: string | null
  expectedProductDirty?: boolean | null
}

function requiresImmutableBundledRuntime({
  isPackaged,
  platform = process.platform,
  arch = process.arch
}: Pick<ResolveBundledRuntimeOptions, 'isPackaged' | 'platform' | 'arch'>): boolean {
  return (
    isPackaged &&
    platform === RUNTIME_BASELINE.acceptedArtifact.platform &&
    arch === RUNTIME_BASELINE.acceptedArtifact.arch
  )
}

function usesBundledHermesRuntime({
  isPackaged,
  platform = process.platform
}: Pick<ResolveBundledRuntimeOptions, 'isPackaged' | 'platform'>): boolean {
  return isPackaged && platform === 'darwin'
}

function bundledRuntimeLayout(resourcesPath: string): BundledRuntimeLayout {
  const runtimeRoot = path.join(resourcesPath, 'runtime')
  const pythonRoot = path.join(runtimeRoot, 'python')
  const browserRoot = path.join(runtimeRoot, 'browser')
  const browserBin = path.join(browserRoot, 'bin')
  const nodeRoot = path.join(browserRoot, 'node')

  return {
    runtimeRoot,
    pythonRoot,
    python: path.join(pythonRoot, 'bin', 'python3.14'),
    sourceRoot: path.join(runtimeRoot, 'hermes-agent'),
    browserRoot,
    browserBin,
    nodeBin: path.join(nodeRoot, 'bin'),
    node: path.join(nodeRoot, BROWSER_RUNTIME.node.executable),
    agentBrowser: path.join(browserBin, 'agent-browser'),
    chromium: path.join(browserRoot, 'chromium', BROWSER_RUNTIME.chromium.root, BROWSER_RUNTIME.chromium.executable),
    toolBins: ['uv'].map(tool => path.join(runtimeRoot, 'tools', tool, 'bin')),
    manifestPath: path.join(runtimeRoot, 'runtime-manifest.json')
  }
}

function hasExpectedBrowserIdentity(
  manifest: BundledRuntimeManifest,
  expectedTarget: { platform: string; arch: string }
) {
  const acceptedTarget =
    expectedTarget.platform === RUNTIME_BASELINE.acceptedArtifact.platform &&
    expectedTarget.arch === RUNTIME_BASELINE.acceptedArtifact.arch

  if (!acceptedTarget) {
    return true
  }

  return (
    manifest.browser?.schemaVersion === BROWSER_RUNTIME.schemaVersion &&
    manifest.browser.node?.version === BROWSER_RUNTIME.node.version &&
    manifest.browser.node?.archiveSha256 === BROWSER_RUNTIME.node.sha256 &&
    manifest.browser.node?.executable === `browser/node/${BROWSER_RUNTIME.node.executable}` &&
    manifest.browser.node?.executableSha256 === BROWSER_RUNTIME.node.executableSha256 &&
    manifest.browser.agentBrowser?.version === BROWSER_RUNTIME.agentBrowser.version &&
    manifest.browser.agentBrowser?.packageIntegrity === BROWSER_RUNTIME.agentBrowser.packageIntegrity &&
    manifest.browser.agentBrowser?.executable === 'browser/bin/agent-browser' &&
    manifest.browser.agentBrowser?.executableSha256 === BROWSER_RUNTIME.agentBrowser.sha256 &&
    manifest.browser.chromium?.name === BROWSER_RUNTIME.chromium.name &&
    manifest.browser.chromium?.browserVersion === BROWSER_RUNTIME.chromium.browserVersion &&
    manifest.browser.chromium?.playwrightVersion === BROWSER_RUNTIME.chromium.playwrightVersion &&
    manifest.browser.chromium?.revision === BROWSER_RUNTIME.chromium.revision &&
    manifest.browser.chromium?.archiveSha256 === BROWSER_RUNTIME.chromium.sha256 &&
    manifest.browser.chromium?.executableSha256 === BROWSER_RUNTIME.chromium.executableSha256 &&
    manifest.browser.chromium?.executable ===
      `browser/chromium/${BROWSER_RUNTIME.chromium.root}/${BROWSER_RUNTIME.chromium.executable}`
  )
}

function readBundledRuntimeManifest(
  manifestPath: string,
  readFile: (candidate: string) => string = candidate => fs.readFileSync(candidate, 'utf8'),
  expectedTarget: { platform: string; arch: string } = RUNTIME_BASELINE.acceptedArtifact
): BundledRuntimeManifest | null {
  try {
    const parsed = JSON.parse(readFile(manifestPath))

    if (
      !parsed ||
      parsed.schemaVersion !== BUNDLED_RUNTIME_SCHEMA_VERSION ||
      parsed.target?.platform !== expectedTarget.platform ||
      parsed.target?.arch !== expectedTarget.arch ||
      typeof parsed.python?.version !== 'string' ||
      !parsed.python.version.startsWith(`${BUNDLED_PYTHON_VERSION}.`) ||
      parsed.identity?.upstreamHermesCommit !== RUNTIME_BASELINE.upstreamHermesCommit ||
      parsed.identity?.atumOverlayCommit !== RUNTIME_BASELINE.atumOverlayCommit ||
      parsed.identity?.atumOverlayTree !== RUNTIME_BASELINE.atumOverlayTree ||
      !COMMIT_PATTERN.test(parsed.identity?.runtimeCommit || '') ||
      !COMMIT_PATTERN.test(parsed.identity?.runtimeTree || '') ||
      parsed.hermes?.dirtyCheckoutIgnored !== false ||
      !hasExpectedBrowserIdentity(parsed, expectedTarget)
    ) {
      return null
    }

    return parsed
  } catch {
    return null
  }
}

/**
 * Resolve the immutable runtime shipped inside a packaged macOS app.
 *
 * Development and excluded artifacts retain the historical resolver ladder.
 * Packaged macOS x64 still prefers its staged bundled runtime, but remains
 * outside the accepted fail-closed artifact contract.
 * The accepted packaged macOS arm64 artifact is different: its signed bundle
 * is the runtime authority, so missing or mismatched identity throws instead
 * of silently selecting mutable managed, PATH, or system-Python fallbacks.
 */
function resolveBundledHermesRuntime(options: ResolveBundledRuntimeOptions) {
  const {
    isPackaged,
    platform = process.platform,
    arch = process.arch,
    resourcesPath,
    backendArgs = [],
    hermesHome,
    currentEnv = process.env,
    expectedProductCommit,
    expectedProductDirty,
    fileExists = fs.existsSync,
    directoryExists = candidate => {
      try {
        return fs.statSync(candidate).isDirectory()
      } catch {
        return false
      }
    },
    readFile,
    executableFile = candidate => {
      try {
        fs.accessSync(candidate, fs.constants.X_OK)

        return fs.statSync(candidate).isFile()
      } catch {
        return false
      }
    },
    probeRuntime
  } = options

  if (!usesBundledHermesRuntime({ isPackaged, platform })) {
    return null
  }

  const immutableRuntimeRequired = requiresImmutableBundledRuntime({ isPackaged, platform, arch })

  const reject = (reason: string) => {
    if (immutableRuntimeRequired) {
      throw new BundledRuntimeIdentityError(reason)
    }

    return null
  }

  if (!resourcesPath) {
    return reject('resources path is missing')
  }

  if (immutableRuntimeRequired) {
    if (!COMMIT_PATTERN.test(expectedProductCommit || '') || /^0{40}$/u.test(expectedProductCommit || '')) {
      throw new BundledRuntimeIdentityError('product build commit is missing')
    }

    if (expectedProductDirty !== false) {
      throw new BundledRuntimeIdentityError('product build is not attested clean')
    }
  }

  const layout = bundledRuntimeLayout(resourcesPath)
  const manifest = readBundledRuntimeManifest(layout.manifestPath, readFile, { platform, arch })

  if (!manifest) {
    return reject('runtime manifest is missing or mismatched')
  }

  if (immutableRuntimeRequired && manifest.identity?.runtimeCommit !== expectedProductCommit) {
    throw new BundledRuntimeIdentityError('product and bundled runtime commits differ')
  }

  if (!fileExists(layout.python) || !directoryExists(layout.sourceRoot)) {
    return reject('runtime payload is incomplete')
  }

  if (
    immutableRuntimeRequired &&
    ![layout.node, layout.agentBrowser, layout.chromium].every(candidate => executableFile(candidate))
  ) {
    throw new BundledRuntimeIdentityError('browser runtime payload is incomplete or not executable')
  }

  const lazyInstallTarget = path.join(hermesHome, 'desktop-runtime', 'lazy-packages')

  const desktopEnv = buildDesktopBackendEnv({
    hermesHome,
    pythonPathEntries: [layout.sourceRoot],
    venvRoot: layout.pythonRoot,
    currentEnv,
    platform
  })

  const immutableBrowserEnv = immutableRuntimeRequired
    ? Object.fromEntries(AGENT_BROWSER_STEERING_ENV_KEYS.map(key => [key, undefined]))
    : {}

  const env = {
    ...desktopEnv,
    ...immutableBrowserEnv,
    ...(immutableRuntimeRequired
      ? {
          PATH: [layout.browserBin, layout.nodeBin, desktopEnv.PATH]
            .filter(Boolean)
            .join(platform === 'win32' ? ';' : ':'),
          AGENT_BROWSER_EXECUTABLE_PATH: layout.chromium,
          AGENT_BROWSER_HOME: path.join(hermesHome, 'desktop-runtime', 'agent-browser'),
          PLAYWRIGHT_BROWSERS_PATH: path.join(hermesHome, 'desktop-runtime', 'browser-cache')
        }
      : {}),
    // The app bundle is immutable once signed. Hermes' existing durable-target
    // mode keeps optional/lazy plugin dependencies writable without allowing
    // them to shadow the pinned core runtime.
    HERMES_LAZY_INSTALL_TARGET: lazyInstallTarget
  }

  if (!probeRuntime?.(layout.python, { env })) {
    return reject('runtime launch probe failed')
  }

  return {
    kind: 'python',
    label: `bundled Hermes ${manifest.identity?.runtimeCommit?.slice(0, 12)} (Python ${manifest.python?.version})`,
    command: layout.python,
    // `-B` is the interpreter-level immutable-bundle guarantee. Keep the env
    // variable as defense in depth, but do not rely on environment handling
    // alone when Finder/Electron launches the packaged runtime.
    args: ['-B', '-m', 'hermes_cli.main', ...backendArgs],
    env,
    root: layout.sourceRoot,
    bootstrap: false,
    shell: false,
    bundled: true,
    runtimeManifest: manifest
  }
}

export {
  BUNDLED_PYTHON_VERSION,
  BUNDLED_RUNTIME_SCHEMA_VERSION,
  BundledRuntimeIdentityError,
  bundledRuntimeLayout,
  readBundledRuntimeManifest,
  requiresImmutableBundledRuntime,
  resolveBundledHermesRuntime,
  usesBundledHermesRuntime
}
