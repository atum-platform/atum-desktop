/**
 * Shared E2E fixtures for the Hermes desktop Playwright suite.
 *
 * Two fixture modes:
 *
 *  1. `mockBackend` — starts a mock inference server, writes a config.yaml
 *     that points at it, and launches the desktop app so the full chain
 *     (electron → hermes serve → provider → inference → renderer) is
 *     exercised with a real backend but a fake LLM.
 *
 *  2. `noProvider` — launches the app with an empty config (no provider
 *     configured). The onboarding overlay should appear. Used to test the
 *     first-run flow without real credentials.
 *
 * Both modes launch the *dev* Electron app (`electron .` against the built
 * `dist/`), not the packaged binary. This avoids the multi-minute
 * `electron-builder --dir` step and matches `hermes desktop --source`. The
 * packaged-binary path is already covered by `launch.spec.ts`.
 *
 * Prerequisite: `npm run build:e2e` must have run so dist/ has a source-mode
 * main process. The production bundle requires an attested packaged runtime.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'

import { _electron, type ElectronApplication, type Page } from '@playwright/test'

import { UTILITY_IPC } from '../shared/atum-utilities'

import { type MockServerOptions, startMockServer } from './mock-server'
import { installErrorBannerGuard } from './test'

const DESKTOP_ROOT = path.resolve(import.meta.dirname, '..')
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..', '..')
const RELEASE_ROOT = path.join(DESKTOP_ROOT, 'release')
const PACKAGED_PRODUCT_NAME = 'Atum'

// ─── Credential stripping (matches launch.spec.ts) ──────────────────────

const CREDENTIAL_SUFFIXES: string[] = [
  '_API_KEY',
  '_TOKEN',
  '_SECRET',
  '_PASSWORD',
  '_CREDENTIALS',
  '_ACCESS_KEY',
  '_PRIVATE_KEY',
  '_OAUTH_TOKEN'
]

const CREDENTIAL_NAMES = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'CUSTOM_API_KEY',
  'GEMINI_BASE_URL',
  'OPENAI_BASE_URL',
  'OPENROUTER_BASE_URL',
  'OLLAMA_BASE_URL',
  'GROQ_BASE_URL',
  'XAI_BASE_URL'
])

function isCredentialEnvVar(name: string): boolean {
  if (CREDENTIAL_NAMES.has(name)) {
    return true
  }

  return CREDENTIAL_SUFFIXES.some(suffix => name.endsWith(suffix))
}

function isInheritedHermesRuntimeVar(name: string): boolean {
  return name.startsWith('HERMES_') && !name.startsWith('HERMES_DESKTOP_') && !name.startsWith('HERMES_E2E_')
}

function stripCredentials(env: Record<string, string | undefined>): Record<string, string> {
  const clean: Record<string, string> = {}

  for (const [key, value] of Object.entries(env)) {
    if (!value) {
      continue
    }

    if (isCredentialEnvVar(key) || isInheritedHermesRuntimeVar(key)) {
      continue
    }

    clean[key] = value
  }

  return clean
}

// ─── Sandbox creation ──────────────────────────────────────────────────

export interface Sandbox {
  root: string
  hermesHome: string
  userDataDir: string
  cleanup: () => void
}

export function createSandbox(prefix: string): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `hermes-e2e-${prefix}-${Math.random()}`)))
  const hermesHome = path.join(root, 'hermes-home')
  const userDataDir = path.join(root, 'electron-user-data')

  fs.mkdirSync(hermesHome, { recursive: true })
  fs.mkdirSync(userDataDir, { recursive: true })

  // Write a fixed window-state.json so the Electron window opens at a
  // consistent size — helps with visual regression screenshots.  The
  // exact size is also enforced right before each screenshot (see
  // expectVisualSnapshot in visual-snapshot.ts) because window managers
  // may resize after launch.
  fs.writeFileSync(
    path.join(userDataDir, 'window-state.json'),
    JSON.stringify({ x: 0, y: 0, width: 1220, height: 800, isMaximized: false }, null, 2),
    'utf8'
  )
  fs.writeFileSync(
    path.join(userDataDir, 'zoom-state.json'),
    JSON.stringify({ zoomLevel: 0 }, null, 2),
    'utf8'
  )

  return {
    root,
    hermesHome,
    userDataDir,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    }
  }
}

// ─── Config writing ─────────────────────────────────────────────────────

/**
 * Write a config.yaml that pre-configures a mock provider pointing at the
 * mock inference server. The provider is set as the active model provider so
 * the desktop app skips onboarding and boots straight to the chat UI.
 *
 * @param extraDisplayConfig optional YAML lines appended to the `display:`
 *   section, used by the interim-message e2e test.
 * @param extraConfig optional top-level YAML sections for a test scenario.
 * @param modelContextLength optional primary-model context limit.
 */
export function writeMockProviderConfig(
  hermesHome: string,
  mockUrl: string,
  extraDisplayConfig?: string,
  extraConfig?: string,
  modelContextLength?: number
): void {
  const configPath = path.join(hermesHome, 'config.yaml')

  const displaySection = extraDisplayConfig ? `\ndisplay:\n${extraDisplayConfig}\n` : ''

  const config = `# Auto-generated by E2E test fixtures
model:
  default: mock-model
  provider: mock
${modelContextLength ? `  context_length: ${modelContextLength}\n` : ''}providers:
  mock:
    api: ${mockUrl}/v1
    name: Mock
    api_mode: chat_completions
    key_env: MOCK_API_KEY
    models:
      mock-model: {}
    context_length: 64000
${displaySection}${extraConfig ? `\n${extraConfig.trim()}\n` : ''}`

  fs.writeFileSync(configPath, config, 'utf8')
}

/**
 * Write a minimal .env with the mock API key. The key_env in config.yaml
 * references MOCK_API_KEY, so the backend resolves credentials from here.
 */
export function writeEnvFile(hermesHome: string, apiKey = 'e2e-mock-key'): void {
  const envPath = path.join(hermesHome, '.env')
  fs.writeFileSync(envPath, `MOCK_API_KEY=${apiKey}\n`, 'utf8')
}

/**
 * Write an empty config (no providers). The desktop app should show the
 * onboarding overlay because no inference provider is configured.
 */
function writeEmptyConfig(hermesHome: string): void {
  const configPath = path.join(hermesHome, 'config.yaml')
  fs.writeFileSync(configPath, '# Auto-generated by E2E test fixtures — no providers configured\n', 'utf8')
}

// ─── Env building ──────────────────────────────────────────────────────

/**
 * Build the environment for the Electron app process.
 *
 * Key env vars:
 *  - HERMES_HOME → sandbox hermes-home (isolated config/sessions)
 *  - HERMES_DESKTOP_USER_DATA_DIR → sandbox electron-user-data
 *  - HERMES_DESKTOP_IGNORE_EXISTING=1 → don't pick up `hermes` from PATH
 *    (we want the dev checkout at REPO_ROOT)
 *  - HERMES_DESKTOP_HERMES_ROOT → REPO_ROOT (dev checkout resolution)
 *    The app spawns the REAL Hermes backend from that root, so the root must
 *    carry a `.venv` (or `venv`) with Hermes' Python deps. A git worktree has
 *    none: `ln -s <main checkout>/.venv <worktree>/.venv` before running e2e,
 *    or every spec boots into the boot-failure overlay.
 *  - HERMES_DESKTOP_APP_NAME → unique-ish per test (avoids single-instance lock)
 *  - XDG_RUNTIME_DIR → ensure Electron has a writable runtime dir on Linux
 */
export function buildAppEnv(sandbox: Sandbox, extra: Record<string, string> = {}): Record<string, string> {
  const clean = stripCredentials(process.env)

  // XDG_RUNTIME_DIR is needed for Electron on Linux when running in a
  // headless/CI context — without it the zygote may fail to initialize.
  if (!clean.XDG_RUNTIME_DIR && process.env.XDG_RUNTIME_DIR) {
    clean.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR
  }

  // DISPLAY — needed for Electron to open a window.
  if (!clean.DISPLAY && process.env.DISPLAY) {
    clean.DISPLAY = process.env.DISPLAY
  }

  return {
    ...clean,
    HERMES_HOME: sandbox.hermesHome,
    HERMES_DESKTOP_USER_DATA_DIR: sandbox.userDataDir,
    HERMES_DESKTOP_IGNORE_EXISTING: '1',
    HERMES_DESKTOP_ISOLATED_BACKEND: '1',
    HOME: sandbox.root,
    HERMES_DESKTOP_HERMES_ROOT: REPO_ROOT,
    HERMES_DESKTOP_APP_NAME: `HermesE2E-${Date.now()}`,
    HERMES_DESKTOP_SKIP_QUIT_CONFIRM: '1',
    HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION: '1',
    // Clear dev-server override — we want the built dist/, not a vite server.
    // The dev-server check in main.ts looks for this env var; if it's set,
    // it loads from the vite URL instead of the local file.
    ...extra
  }
}

// ─── Electron launch ────────────────────────────────────────────────────

/**
 * Verify that the desktop app has been built (dist/ exists). Playwright
 * tests can't run without it — the Electron main process loads
 * dist/electron-main.mjs and the renderer loads dist/index.html.
 */
function assertDistBuilt(): void {
  const distDir = path.join(DESKTOP_ROOT, 'dist')
  const electronMain = path.join(distDir, 'electron-main.mjs')
  const indexHtml = path.join(distDir, 'index.html')

  if (!fs.existsSync(electronMain)) {
    throw new Error(
      `Desktop dist not built. Run 'cd apps/desktop && npm run build' first.\n` + `Missing: ${electronMain}`
    )
  }

  if (!fs.existsSync(indexHtml)) {
    throw new Error(
      `Desktop dist/index.html not found. Run 'cd apps/desktop && npm run build' first.\n` + `Missing: ${indexHtml}`
    )
  }
}

/**
 * Find the Electron binary. In the nix devshell, `electron` is on PATH.
 * As a fallback, use the node_modules/.bin/electron from the desktop package.
 */
export function findElectron(): string {
  // In dev mode, we use the `electron` binary directly (not the packaged app).
  // The dev:electron script in package.json does exactly this: `electron .`
  // after building. We replicate that here.
  // The package resolves Electron.app on macOS and electron.exe on Windows.
  // Assuming dist/electron made a valid macOS installation look missing.
  try {
    const localElectron: unknown = createRequire(import.meta.url)('electron')

    if (typeof localElectron === 'string' && fs.existsSync(localElectron)) {
      return localElectron
    }
  } catch { /* An incomplete local install may still have Electron on PATH. */ }

  // Fall back to PATH
  const result = spawnSync('which', ['electron'], {
    encoding: 'utf8'
  })

  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim()
  }

  throw new Error('Electron binary not found. Run "npm install" from the repo root to install devDependencies.')
}

/**
 * Launch the desktop app in dev mode.
 *
 * @param sandbox  - isolated HERMES_HOME + userData
 * @param env      - the process environment (already has HERMES_HOME etc.)
 * @returns the ElectronApplication + first Page
 */
export async function launchDesktop(env: Record<string, string>, options: { productionFlags?: boolean; packaged?: boolean } = {}): Promise<{ app: ElectronApplication; page: Page }> {
  assertDistBuilt()

  const electronBin = options.packaged ? PACKAGED_BINARY_PATH : findElectron()

  // `electron .` loads from the package.json `main` field
  // (dist/electron-main.mjs after build).
  const app = await _electron.launch({
    executablePath: electronBin,
    args: [
      ...(options.packaged ? [] : [DESKTOP_ROOT]), // Packaged apps already know their entrypoint.
      ...(options.productionFlags ? [] : ['--disable-gpu', '--no-sandbox'])
    ],
    env,
    cwd: DESKTOP_ROOT
  })

  const page = await app.firstWindow()

  // Install the error-banner guard so any [role="alert"] that appears
  // during a test is collected and surfaced in afterEach.
  installErrorBannerGuard(page)

  return { app, page }
}

// ─── Public fixtures ────────────────────────────────────────────────────

export interface MockBackendFixture {
  app: ElectronApplication
  page: Page
  mock: Awaited<ReturnType<typeof startMockServer>>
  mockUrl: string
  sandbox: Sandbox
  cleanup: () => Promise<void>
}

export interface MockBackendOptions {
  /**
   * Optional YAML lines to inject under the `display:` section of the
   * generated config.yaml. Used by the interim-message e2e test to toggle
   * `display.interim_assistant_messages`.
   */
  extraDisplayConfig?: string
  /** Additional top-level config.yaml sections for an E2E scenario. */
  extraConfig?: string
  /** Override the mock model's context window for compression scenarios. */
  modelContextLength?: number
  /** Exercise Hermes session/sidebar contracts in the retained legacy chrome. */
  legacyShell?: boolean
  /**
   * Launch with production process flags: no `--disable-gpu`, no `--no-sandbox`.
   * Native views composite differently under those flags (the PDF viewer
   * painted nothing in production while every harness run passed), so a spec
   * that measures what the window actually shows must run this way. macOS only
   * in practice; CI Linux needs both flags.
   */
  productionFlags?: boolean
  /** Qualify the built app and its bundled runtime against the same test provider. */
  packaged?: boolean
  /** Synthetic account identity at the native auth boundary; no hosted credentials. */
  accountId?: string
}

/**
 * Set up a full mock-backend E2E environment:
 *   1. Start the mock inference server
 *   2. Create a sandbox with config.yaml pointing at it
 *   3. Launch the desktop app
 *   4. Return handles for test interaction
 */
export interface MockBackendOptions {
  mockServer?: MockServerOptions
}

/**
 * Select the retained Hermes chrome before readiness assertions run.
 *
 * The Atum roster intentionally presents one local assistant conversation
 * plus hosted DMs; it does not expose Hermes' stored-session tree, tabs, or
 * background-session dots. Tests for those retained engine contracts must use
 * the recovery/debug shell that owns those controls instead of searching for
 * legacy selectors in the Atum product surface.
 */
export async function useLegacyShell(page: Page): Promise<void> {
  await page.locator('#root').waitFor({ state: 'attached', timeout: 30_000 })
  await page.evaluate(() => localStorage.setItem('hermes.desktop.atum.shell', 'false'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-slot="sidebar"]').waitFor({ state: 'visible', timeout: 30_000 })
}

export async function setupMockBackend(options: MockBackendOptions = {}): Promise<MockBackendFixture> {
  // 1. Start mock server
  const mock = await startMockServer(options.mockServer)

  // 2. Create sandbox + write config
  const sandbox = createSandbox('mock')
  writeMockProviderConfig(
    sandbox.hermesHome,
    mock.url,
    options.extraDisplayConfig,
    options.extraConfig,
    options.modelContextLength
  )
  writeEnvFile(sandbox.hermesHome)

  // 3. Build env + launch
  const env = buildAppEnv(sandbox)
  const packaged = options.packaged ?? (process.env.ATUM_E2E_PACKAGED === '1')
  const { app, page } = await launchDesktop(env, { productionFlags: options.productionFlags ?? (packaged && process.platform === 'darwin'), packaged })
  const accountId = options.accountId ?? (packaged ? 'e2e-packaged-account' : undefined)

  if (accountId) {
    const status = {
      state: 'signed_in', configured: true, account: { id: accountId },
      current: { authority: 'supabase', accountId, sessionGeneration: 1, expiresAt: 4_102_444_800 },
      errorCode: null, providers: { google: false, password: false }
    }

    await app.evaluate(({ ipcMain }, { status, utilitiesStatus }) => {
      ipcMain.removeHandler('atum:account:status')
      ipcMain.handle('atum:account:status', () => status)
      // This renderer-only identity does not sign native authority in or
      // authorize providers. Keep the unrelated read-only utility status
      // coherent and unavailable; real utility specs replace this handler.
      ipcMain.removeHandler(utilitiesStatus)
      ipcMain.handle(utilitiesStatus, () => ({ status: {
        accountId: status.current.accountId,
        generation: status.current.sessionGeneration,
        sources: [],
        available: { google: false, 'apple-calendar': false }
      } }))
    }, { status, utilitiesStatus: UTILITY_IPC.status })
    await page.reload({ waitUntil: 'domcontentloaded' })
  }

  if (options.legacyShell) {
    await useLegacyShell(page)
  }

  return {
    app,
    page,
    mock,
    mockUrl: mock.url,
    sandbox,
    cleanup: async () => {
      await app.close().catch(() => undefined)
      await mock.close()
      sandbox.cleanup()
    }
  }
}

export interface NoProviderFixture {
  app: ElectronApplication
  page: Page
  sandbox: Sandbox
  cleanup: () => Promise<void>
}

/**
 * Launch the app with no provider configured. The onboarding overlay should
 * appear because there's no inference provider in config.yaml.
 */
export async function setupNoProvider(): Promise<NoProviderFixture> {
  const sandbox = createSandbox('noprovider')
  writeEmptyConfig(sandbox.hermesHome)

  const env = buildAppEnv(sandbox)
  const { app, page } = await launchDesktop(env)

  return {
    app,
    page,
    sandbox,
    cleanup: async () => {
      await app.close().catch(() => undefined)
      sandbox.cleanup()
    }
  }
}

export interface DeadBackendFixture {
  app: ElectronApplication
  page: Page
  sandbox: Sandbox
  cleanup: () => Promise<void>
}

export interface DeadBackendOptions {
  /**
   * When true, inject a fake boot error via HERMES_DESKTOP_BOOT_FAKE_ERROR
   * so the backend resolution itself "fails" with a controlled error message.
   * This is the only reliable way to trigger BootFailureOverlay in dev mode
   * (the real backend always resolves via SOURCE_REPO_ROOT).
   */
  fakeError?: boolean
}

/**
 * Launch the app with a provider pointing at a dead endpoint (port 1, which
 * nothing listens on). By default the backend still boots (`hermes serve`
 * starts fine — the dead endpoint only matters at chat time). Pass
 * `{ fakeError: true }` to inject a fake boot failure, triggering the
 * BootFailureOverlay.
 */
export async function setupDeadBackend(options: DeadBackendOptions = {}): Promise<DeadBackendFixture> {
  const sandbox = createSandbox('dead')
  const configPath = path.join(sandbox.hermesHome, 'config.yaml')
  fs.writeFileSync(
    configPath,
    `# Auto-generated by E2E test fixtures — dead provider
model:
  default: mock-model
  provider: mock
providers:
  mock:
    api: http://127.0.0.1:1/v1
    name: Mock
    api_mode: chat_completions
    key_env: MOCK_API_KEY
    models:
      mock-model: {}
    context_length: 64000
`,
    'utf8'
  )
  writeEnvFile(sandbox.hermesHome)

  const env = buildAppEnv(
    sandbox,
    options.fakeError
      ? { HERMES_DESKTOP_BOOT_FAKE_ERROR: 'Failed to connect to Hermes backend: connection refused' }
      : {}
  )

  const { app, page } = await launchDesktop(env)

  return {
    app,
    page,
    sandbox,
    cleanup: async () => {
      await app.close().catch(() => undefined)
      sandbox.cleanup()
    }
  }
}

// ─── Packaged-binary fixture ───────────────────────────────────────────

/**
 * Resolve the packaged Electron binary path, per-platform, matching
 * electron-builder's output layout under release/.
 */
function resolvePackagedBinaryPath(): string {
  if (process.platform === 'win32') {
    return path.join(RELEASE_ROOT, 'win-unpacked', `${PACKAGED_PRODUCT_NAME}.exe`)
  }

  if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'

    return path.join(
      RELEASE_ROOT,
      `mac-${arch}`,
      `${PACKAGED_PRODUCT_NAME}.app`,
      'Contents',
      'MacOS',
      PACKAGED_PRODUCT_NAME
    )
  }

  return path.join(RELEASE_ROOT, 'linux-unpacked', PACKAGED_PRODUCT_NAME)
}

export const PACKAGED_BINARY_PATH = resolvePackagedBinaryPath()

export function packagedBinaryExists(): boolean {
  return fs.existsSync(PACKAGED_BINARY_PATH)
}

export interface PackagedAppFixture {
  app: ElectronApplication
  page: Page
  sandbox: Sandbox
  cleanup: () => Promise<void>
}

/**
 * Launch the *packaged* Electron binary (from `npm run pack` →
 * `electron-builder --dir`) with `BOOT_FAKE=1` so it simulates boot
 * progress without spawning a real Hermes backend.
 *
 * Uses the same sandbox isolation (credential stripping, isolated
 * HERMES_HOME + userData, unique app name) as the dev-mode fixtures.
 *
 * Skips if the packaged binary doesn't exist — run `npm run pack` first.
 */
export async function setupPackagedApp(): Promise<PackagedAppFixture> {
  if (!packagedBinaryExists()) {
    throw new Error(`Built app binary not found: ${PACKAGED_BINARY_PATH}. Run 'npm run pack' first.`)
  }

  const sandbox = createSandbox('packaged')

  // Build the sandbox env using the shared helpers, then add the
  // packaged-binary-specific overrides.
  const env = buildAppEnv(sandbox, {
    // Fake boot: simulates progress steps without spawning the real backend.
    HERMES_DESKTOP_BOOT_FAKE: '1',
    HERMES_DESKTOP_BOOT_FAKE_STEP_MS: '120'
  })

  // Clear dev-server + hermes-root overrides — the packaged binary
  // should use its own bundled renderer, not the dev checkout.
  delete (env as Record<string, string | undefined>).HERMES_DESKTOP_DEV_SERVER
  delete (env as Record<string, string | undefined>).HERMES_DESKTOP_HERMES
  delete (env as Record<string, string | undefined>).HERMES_DESKTOP_HERMES_ROOT

  const app = await _electron.launch({
    executablePath: PACKAGED_BINARY_PATH,
    args: ['--disable-gpu', '--no-sandbox'],
    env
  })

  const page = await app.firstWindow()
  installErrorBannerGuard(page)

  return {
    app,
    page,
    sandbox,
    cleanup: async () => {
      await app.close().catch(() => undefined)
      sandbox.cleanup()
    }
  }
}

// ─── Wait helpers ──────────────────────────────────────────────────────

/**
 * Wait for the desktop app to finish booting and show the main chat UI.
 *
 * The boot overlay disappears when `completeDesktopBoot()` fires in the
 * renderer — at that point the gateway is open, config is loaded, and
 * sessions are loaded. We detect this by waiting for the boot/connecting
 * overlay to become invisible and the main app shell to be present.
 *
 * Two things must both be true before we return:
 *  1. The composer (chat input) is visible — it's disabled until the
 *     gateway is open.
 *  2. No full-screen overlay (onboarding Preparing, connecting overlay,
 *     boot-failure) covers the viewport center. The composer can be
 *     "visible" in Playwright's eyes (non-zero bounding box, not
 *     display:none) even when a z-1300+ overlay is painted on top of it,
 *     so checking the composer alone catches the app mid-boot at ~92%
 *     with the loading bar still showing.
 */
export interface AppReadyOptions {
  preserveWorkspace?: boolean
}

/**
 * Close the Atum workspace through its real UI authority and wait until both
 * the rendered surface and persistent atom agree that it is closed.
 *
 * The workspace chunk is lazy and its drawer fallback is intentionally null,
 * so a one-shot visibility check can run before the panel mounts. Waiting for
 * either a closeable panel or the fully closed invariant removes that race.
 * The eager Atum shell gate keeps retained-Hermes-shell tests on their existing
 * path without waiting for an Atum-only surface.
 */
export async function normalizeWorkspaceClosed(page: Page, timeoutMs = 60_000): Promise<void> {
  if ((await page.locator('main.atum-shell').count()) === 0) {
    return
  }

  const outcomeHandle = await page.waitForFunction(
    () => {
      const workspace = document.querySelector('[data-atum-workspace]')
      const loading = document.querySelector('[data-atum-workspace-loading]')
      const persisted = localStorage.getItem('hermes.desktop.atum.workspaceOpenV3')

      // A fresh profile has no persisted value. A closed workspace may be
      // absent or retained hidden/inert so its open tabs can survive.
      if (
        !loading && persisted !== 'true' &&
        (!workspace || (workspace.hasAttribute('inert') && getComputedStyle(workspace).display === 'none'))
      ) {
        return 'closed'
      }

      if (workspace) {
        const styles = getComputedStyle(workspace)
        const bounds = workspace.getBoundingClientRect()

        if (styles.visibility !== 'hidden' && styles.display !== 'none' && bounds.width > 0 && bounds.height > 0) {
          return 'visible'
        }
      }

      return false
    },
    undefined,
    { timeout: timeoutMs }
  )

  const outcome = await outcomeHandle.jsonValue()
  await outcomeHandle.dispose()

  if (outcome === 'visible') {
    await page.locator('[data-atum-workspace]').getByTestId('atum-workspace-close').click()
  }

  await page.waitForFunction(
    () => {
      const workspace = document.querySelector('[data-atum-workspace]')

      return !document.querySelector('[data-atum-workspace-loading]') &&
        localStorage.getItem('hermes.desktop.atum.workspaceOpenV3') !== 'true' &&
        (!workspace || (workspace.hasAttribute('inert') && getComputedStyle(workspace).display === 'none'))
    },
    undefined,
    { timeout: timeoutMs }
  )
}

export async function waitForAppReady(
  fixture: MockBackendFixture | NoProviderFixture | DeadBackendFixture,
  timeoutMs = 60_000,
  options: AppReadyOptions = {}
): Promise<void> {
  const { page, app } = fixture

  // A visible rich composer becomes editable once the renderer can accept
  // input. The full-viewport overlay check below remains the authoritative
  // guard against treating a connecting or failed shell as ready.
  await page.waitForSelector('[data-slot="composer-rich-input"][contenteditable="true"]', {
    state: 'visible',
    timeout: timeoutMs
  })

  // Now poll until no full-screen overlay covers the viewport center.
  // elementFromPoint returns the topmost element at a point — if it's part
  // of a fixed inset-0 overlay (onboarding/connecting/boot-failure), the
  // app isn't ready yet.
  await page.waitForFunction(
    () => {
      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)

      if (!el) {
        return false
      }

      // Walk up to the nearest positioned ancestor — overlays are
      // `position: fixed; inset: 0`. If the hit element or an ancestor
      // is a full-viewport fixed overlay, we're still covered.
      let node: Element | null = el

      while (node) {
        const cs = window.getComputedStyle(node)

        if (cs.position === 'fixed') {
          const rect = node.getBoundingClientRect()

          if (rect.left <= 0 && rect.top <= 0 && rect.right >= window.innerWidth && rect.bottom >= window.innerHeight) {
            return false
          }
        }

        node = node.parentElement
      }

      return true
    },
    undefined,
    { timeout: timeoutMs }
  )

  // On Electron 40.x, ready-to-show may never fire (electron/electron#51972)
  // and the window stays hidden even though the DOM is rendered. The main
  // process has a TEST_WORKER_INDEX-gated fallback that force-shows the
  // window, but the DOM can be ready before that fires. Poll until the
  // window is actually visible so interactions (click, screenshot) don't
  // hit a hidden surface.
  if (app) {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const visible = await app
        .evaluate(({ BrowserWindow }) => {
          const w = BrowserWindow.getAllWindows()[0]

          return w ? w.isVisible() : false
        })
        .catch(() => false)

      if (visible) {
        break
      }

      await page.waitForTimeout(500)
    }
  }

  // Atum intentionally opens the workspace on a fresh profile. At the E2E
  // fixture's 1220px window it is a right-edge drawer and can cover the chat
  // composer even though the gateway itself is ready. Most tests exercise the
  // chat surface, so normalize that presentation state after boot. The shell
  // and document-workspace contracts opt out and verify the open workspace.
  if (!options.preserveWorkspace) {
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]

      if (window) {
        window.unmaximize()
        window.setMinimumSize(1220, 800)
        window.setSize(1220, 800, false)
      }
    })
    await page.waitForFunction(() => window.innerWidth < 1280, undefined, { timeout: timeoutMs })

    await normalizeWorkspaceClosed(page, timeoutMs)
  }
}

/**
 * Wait for the onboarding overlay to appear (no provider configured).
 */
export async function waitForOnboarding(page: Page, timeoutMs = 60_000): Promise<void> {
  // The onboarding overlay contains a heading with "Choose your provider"
  // or similar text. We look for any text that indicates the picker.
  await page.waitForFunction(
    () => {
      const root = document.getElementById('root')

      if (!root) {
        return false
      }

      const text = root.textContent ?? ''

      return (
        text.includes('provider') ||
        text.includes('Provider') ||
        text.includes('Choose') ||
        text.includes('API key') ||
        text.includes('Sign in')
      )
    },
    undefined,
    { timeout: timeoutMs }
  )
}

/**
 * Wait for the boot failure overlay to appear.
 */
export async function waitForBootFailure(page: Page, timeoutMs = 60_000): Promise<void> {
  // Atum is Vietnamese-first and may be switched to any supported locale, so
  // a boot-state assertion must not depend on English recovery copy.
  await page.locator('[data-testid="boot-failure-overlay"]').waitFor({
    state: 'visible',
    timeout: timeoutMs
  })
}
