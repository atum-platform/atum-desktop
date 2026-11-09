import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { JsonRpcGatewayClient } from '../../../shared/src/json-rpc-gateway'
import { buildHermesWebSocketUrl } from '../../../shared/src/websocket-url'
import { MATRIX_PET_INTENT_PLAYBACK } from '../../shared/matrix-pet-intent'
import { serveBackendArgs } from '../backend-command'
import { buildDesktopBackendPath } from '../backend-env'
import { waitForDashboardPort } from '../backend-ready'
import { ownedBackgroundChildren } from '../owned-background-children'

import { restoredAuxPython } from './aux-python'
import { createHermesPagesTransport } from './hermes-pages-transport'
import type { MatrixHermesAsk } from './hermes-prompts'
import { MATRIX_HERMES_ENDPOINT } from './hermes-setup'
import { matrixHermesStarts } from './hermes-start-limiter'
import { runMatrixHermesTurn } from './hermes-turn'
import { ensureMatrixWorkspace, matrixWorkspaceChoice } from './workspace-layout'

/** Native/operator configuration, never accepted from a renderer or room. */
export interface MatrixHermesRuntimeConfig {
  python: string
  source: string
  profiles: string
  /** Electron's native home fact, shared by layout, runtime and resumed sessions. */
  workspaceHome?: string
  /** Main's current sealed history, including disconnected Drive roots. Never JSON/IPC input. */
  knownDriveRoots?: () => readonly string[]
  /** Main's one launch barrier; every temporary or persistent executor waits for it. */
  beforeOpen?: () => Promise<void>
  /** Packaged builds: the bundled browser the old app gave Hermes, and the shared
   * subscription-credential folder (bundled-runtime.ts, hermes-home.ts). */
  bundled?: { browserBin: string; nodeBin: string; chromium: string; toolBins?: string[]; sharedAuthDir?: string }
  /** This Mac's name as the owner set it (main reads it natively, `macComputerName`). */
  macName?: () => string
  /** Diagnostic hand-off for an owned backend that exited. Closed values only:
   * status/signal and whether this process stopped it on purpose. */
  onExit?: (exit: { code: number | null; signal: NodeJS.Signals | null; intentional: boolean }) => void
  /** The account's subscription credentials (an OpenCode Go key at present), read fresh for
   * every launch so all of this account's Mac-hosted assistants see the same subscriptions. */
  subscriptionEnv?: () => NodeJS.ProcessEnv
}

/** What an agent calls this Mac when its name cannot be read or has nothing usable left. */
export const MATRIX_MAC_NAME_FALLBACK = 'this Mac'

const MATRIX_MAC_NAME_MAX = 48
const MAC_NAME_KEPT = /[\p{L}\p{M}\p{N}'\u2019\-_.,()&+]/u
const MAC_NAME_SPACE = /[\p{Z}\t\r\n]/u
const MAC_NAME_WORD = /[\p{L}\p{N}]/u

/**
 * This Mac's name for the agent's "Where you run" section (agent/prompt_builder.py
 * `atum_mac_label`, which applies the same rule again): one line of letters, marks, digits,
 * spaces and a little punctuation, at most 48 characters. Quotes, control characters and line
 * breaks never reach the prompt; a name with nothing usable left is "this Mac".
 */
export function matrixHermesMacName(raw: unknown): string {
  if (typeof raw !== 'string') {
    return MATRIX_MAC_NAME_FALLBACK
  }

  const kept = Array.from(raw.normalize('NFC'))
    .map(char => (MAC_NAME_KEPT.test(char) ? char : MAC_NAME_SPACE.test(char) ? ' ' : ''))
    .join('')

  const label = Array.from(kept.split(/\s+/u).filter(Boolean).join(' ')).slice(0, MATRIX_MAC_NAME_MAX).join('').trim()

  return MAC_NAME_WORD.test(label) && label.toLowerCase() !== MATRIX_MAC_NAME_FALLBACK.toLowerCase()
    ? label
    : MATRIX_MAC_NAME_FALLBACK
}

function readMacName(config: MatrixHermesRuntimeConfig): string {
  try {
    return matrixHermesMacName(config.macName?.())
  } catch {
    return MATRIX_MAC_NAME_FALLBACK
  }
}

export function readMatrixHermesRuntime(file: string): MatrixHermesRuntimeConfig {
  const value = JSON.parse(readFileSync(file, 'utf8')) as MatrixHermesRuntimeConfig

  if (
    !value ||
    [value.python, value.source, value.profiles].some(item => typeof item !== 'string' || !path.isAbsolute(item))
  ) {
    throw new Error('matrix_runtime_configuration_invalid')
  }

  return { python: value.python, source: value.source, profiles: value.profiles }
}

/** An executor's own Hermes home. The default agent always runs here; another agent runs in the
 * home bound to it (agent-home.ts), which is this path for its first executor. */
export function matrixHermesHome(
  config: Pick<MatrixHermesRuntimeConfig, 'profiles'>,
  owner: string,
  executorId: string
) {
  return path.join(
    config.profiles,
    createHash('sha256')
      .update(JSON.stringify([owner, executorId]))
      .digest('hex')
  )
}

/**
 * Where one Atum account keeps its ChatGPT plan sign-in on this Mac (MP-4, never-defer).
 *
 * Hermes keeps a Codex sign-in in a "shared" store beside its profiles, which on this Mac
 * would be shared by every Atum account and assistant (and, in a packaged build, by the
 * person's own Hermes CLI). Each account gets its own folder inside the runtime's profiles
 * folder instead, keyed by the account's owner principal: its assistants share one sign-in,
 * another account never sees it, and signing out deletes it (`forgetMatrixAccountCodex`).
 *
 * `codexHome` stands in for the Codex CLI's own folder (`CODEX_HOME`, else `~/.codex`):
 * Hermes adopts the CLI's sign-in from there when its own refresh fails, which could swap in
 * a different ChatGPT account without the person knowing. Atum never points it at
 * `~/.codex`, so nothing is read from or written to the person's Codex CLI.
 *
 * Since 0.18.4 this applies only on a Mac that has held two or more Atum accounts
 * (codex-accounts.ts); with one, assistants keep the sign-in where 0.18.2 did.
 */
export interface MatrixHermesCodexScope {
  authDir: string
  codexHome: string
}

export function matrixAccountCodexScope(
  config: Pick<MatrixHermesRuntimeConfig, 'profiles'>,
  owner: string
): MatrixHermesCodexScope {
  const root = path.join(
    config.profiles,
    'accounts',
    createHash('sha256')
      .update(JSON.stringify(['codex', owner]))
      .digest('hex')
  )

  return { authDir: path.join(root, 'codex-auth'), codexHome: path.join(root, 'codex-home') }
}

/** A launch that belongs to no account (profile import, content helpers, cleanup): a folder
 * inside the home it runs on, so it can never reach another account's sign-in either. */
function homeCodexScope(home: string): MatrixHermesCodexScope {
  return {
    authDir: path.join(home, 'desktop-runtime', 'codex-auth'),
    codexHome: path.join(home, 'desktop-runtime', 'codex-home')
  }
}

/** Where the ChatGPT sign-in Hermes actually reads for this account is kept. One account on
 * this Mac keeps it where 0.18.2 did (`sharedCodex`): packaged builds pin Hermes's shared
 * folder; otherwise Hermes's own default. Two or more accounts keep their own folder. The
 * account-level subscription status reads exactly this file. */
export function matrixCodexSignInFile(
  config: Pick<MatrixHermesRuntimeConfig, 'profiles' | 'bundled'>,
  owner: string,
  sharedCodex: boolean,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir()
): string {
  if (!sharedCodex) {
    return path.join(matrixAccountCodexScope(config, owner).authDir, 'codex_auth.json')
  }

  const shared =
    config.bundled?.sharedAuthDir?.trim() ||
    env.HERMES_CODEX_SHARED_AUTH_DIR?.trim() ||
    env.HERMES_SHARED_AUTH_DIR?.trim() ||
    path.join(homeDir, '.hermes', 'shared')

  return path.join(shared, 'codex_auth.json')
}

/** Disconnecting ChatGPT: remove the sign-in file Hermes reads for this account. Safe to repeat. */
export function forgetMatrixCodexSignIn(
  config: Pick<MatrixHermesRuntimeConfig, 'profiles' | 'bundled'>,
  owner: string,
  sharedCodex: boolean,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir()
): void {
  rmSync(matrixCodexSignInFile(config, owner, sharedCodex, env, homeDir), { force: true })
}

/** Sign-out: the account's ChatGPT sign-in goes with it. Safe to repeat. */
export function forgetMatrixAccountCodex(config: Pick<MatrixHermesRuntimeConfig, 'profiles'>, owner: string): void {
  const scope = matrixAccountCodexScope(config, owner)
  rmSync(path.dirname(scope.authDir), { recursive: true, force: true })
}

/** Disconnecting ChatGPT: the account's stored sign-in, which Hermes's disconnect leaves. */
export function forgetMatrixAccountCodexSignIn(
  config: Pick<MatrixHermesRuntimeConfig, 'profiles'>,
  owner: string
): void {
  rmSync(path.join(matrixAccountCodexScope(config, owner).authDir, 'codex_auth.json'), { force: true })
}

/**
 * Held back from the person's environment, each for a reason; everything else passes, as
 * in the old app:
 * - the old app's own wiring, which needs services this app does not run: its filesystem
 *   broker (`ATUM_FILESYSTEM_*`), its managed-model proxy (`ATUM_MANAGED_MODEL_*`) and its
 *   workspace markers;
 * - what this launch sets itself: the Hermes home, the dashboard token, the ready file;
 * - a toolset pin (`HERMES_TUI_TOOLSETS`): Atum is never narrower than Hermes;
 * - the tool-progress mode (`HERMES_TUI_TOOL_PROGRESS`): the launch pins it, so tool starts stay visible;
 * - `PYTHONHOME`, which would point the bundled interpreter at another Python;
 * - where scheduled jobs post and whether they run here (`MATRIX_HOME_ROOM`,
 *   `HERMES_DESKTOP_CRON`, and the marker that holds the ticker, `HERMES_DESKTOP_CRON_HOLD`): only
 *   the launch decides (`matrixHermesJobsEnvironment`);
 * - the Google tools and fence (`ATUM_GOOGLE_*`): only main grants them, to one agent's
 *   launch (`matrixGoogleHermesEnvironment`), never the person's shell;
 * - where Hermes keeps shared sign-ins (`HERMES_CODEX_SHARED_AUTH_DIR`, read first, and
 *   `HERMES_SHARED_AUTH_DIR`): only the launch decides whose ChatGPT sign-in an assistant uses
 *   (the bundled pin, or the account's own folder), never a stale export in the person's shell.
 *   `CODEX_HOME` still passes on a one-account Mac, as in 0.18.2 (codex-accounts.ts).
 */
const WITHHELD_ENV =
  /^(ATUM_FILESYSTEM_|ATUM_MANAGED_MODEL_|ATUM_GOOGLE_|ATUM_SOURCE_POLICY_FILE$|ATUM_WORKSPACE_ROOT_MARKER$|ATUM_PORTABILITY_TICKETS_ROOT_MARKER$|HERMES_HOME$|HERMES_DASHBOARD_SESSION_TOKEN$|HERMES_DESKTOP_READY_FILE$|HERMES_TUI_TOOLSETS$|HERMES_TUI_TOOL_PROGRESS$|PYTHONHOME$|MATRIX_HOME_ROOM$|HERMES_DESKTOP_CRON$|HERMES_DESKTOP_CRON_HOLD$|HERMES_CODEX_SHARED_AUTH_DIR$|HERMES_SHARED_AUTH_DIR$)/

/**
 * The Google part of one agent's launch (G2-08, G2-19). `fence` is the proxy's address:
 * Hermes then refuses every model call that would go anywhere else (main, helper and
 * memory calls), because the agent may hold Google data. `latched` says its home already
 * holds Google data, so Hermes also refuses, from the start, the tools that hand content
 * to outside services (agent/atum_google_fence.py). `tools` adds the broker's address and
 * this launch's key, which turn on the `atum_google` tool. Fixed for the life of the
 * process, so a conversation's tool list never changes mid-way. `unfencedTools` is the
 * deliberately narrow full-power path: it grants only the broker address and key, without
 * asserting a fence route or a latched home.
 */
export function matrixGoogleHermesEnvironment(input: {
  fence?: string
  latched?: boolean
  tools?: { url: string; key: string }
  unfencedTools?: { url: string; key: string }
}): NodeJS.ProcessEnv {
  const tools = input.fence ? input.tools : input.unfencedTools

  return {
    ...(input.fence ? { ATUM_GOOGLE_FENCE_ROUTE: input.fence } : {}),
    ...(input.fence && input.latched ? { ATUM_GOOGLE_LATCHED: '1' } : {}),
    ...(tools ? { ATUM_GOOGLE_TOOLS_URL: tools.url, ATUM_GOOGLE_TOOLS_TOKEN: tools.key } : {})
  }
}

/** A transport implementation may leave its connection promise pending after close.
 * Runtime ownership is still cancellable: the caller must not remain waiting for
 * a pre-submission connection after its executor/turn signal has ended. */
function awaitAbortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      finish()
      reject(signal.reason ?? new Error('matrix_hermes_runtime_stopped'))
    }

    const finish = () => signal.removeEventListener('abort', abort)

    signal.addEventListener('abort', abort, { once: true })
    void pending.then(
      value => {
        finish()
        resolve(value)
      },
      error => {
        finish()
        reject(error)
      }
    )

    // The transport may synchronously abort while creating its promise. Still
    // attach its rejection handler before settling the caller's cancellation.
    if (signal.aborted) {
      abort()
    }
  })
}

/**
 * A Mac-home Atum agent gets the same fixed Atum base layer as a cloud-home agent.
 * Use Hermes's own round-trip YAML writer so comments, quotes and unrelated settings survive.
 */
function currentAuxPython(config: MatrixHermesRuntimeConfig, home: string): string | null {
  try {
    return restoredAuxPython(readFileSync(path.join(home, 'config.yaml'), 'utf8'), config.python, existsSync)
  } catch { return null }
}

const auxDependencyWarnings = new Set<string>()

export function ensureMatrixAtumInstructions(
  config: MatrixHermesRuntimeConfig,
  home: string,
  signal: AbortSignal,
  atumInstructions = true
): Promise<void> {
  const auxPython = currentAuxPython(config, home)
  return new Promise((resolve, reject) => {
    const child = execFile(
      config.python,
      [
        '-s',
        '-P',
        '-B',
        '-c',
        [
          'import sys',
          'from utils import atomic_roundtrip_yaml_update',
          'if sys.argv[2] == "1": atomic_roundtrip_yaml_update(sys.argv[1], "agent.atum_instructions", True)',
          'if len(sys.argv) > 3:',
          '    atomic_roundtrip_yaml_update(sys.argv[1], "mcp_servers.atum-aux.command", sys.argv[3])',
          '    try: import mcp',
          '    except Exception: print("atum_aux_dependencies_unavailable")'
        ].join('\n'),
        path.join(home, 'config.yaml'),
        atumInstructions ? '1' : '0',
        ...(auxPython ? [auxPython] : [])
      ],
      {
        cwd: config.source,
        env: matrixHermesEnvironment(config, home, matrixHermesWorkspace()),
        timeout: 30_000,
        maxBuffer: 1_048_576,
        signal
      },
      (error, stdout) => {
        if (auxPython && typeof stdout === 'string' && stdout.includes('atum_aux_dependencies_unavailable') &&
          !auxDependencyWarnings.has(config.python)) {
          auxDependencyWarnings.add(config.python)
          console.warn('[Matrix] optional atum-aux dependencies unavailable in the current Python runtime')
        }
        if (error) {reject(new Error('matrix_atum_instructions_unavailable'))} else {resolve()}
      }
    )

    child.stdout?.resume()
    child.stderr?.resume()
  })
}

/**
 * Scheduled jobs (readiness plan §4.5). Hermes posts a job's result to its home room when
 * the job has no other destination, so the agent's own room is that home. The ticker is opt-in:
 * only a launch that says `runJobs: true` has one. A Mac that does not run this agent's jobs
 * (`runJobs` false) starts its backend without it, and so does every launch that says nothing
 * (setup, model checks, sign-in, pet hatching). Those share the agent's Hermes home with its
 * long-lived backend but cannot carry its hold marker, so a ticker of their own would dispatch
 * the agent's jobs on a Mac that is only standing by.
 */
export function matrixHermesJobsEnvironment(input: {
  homeRoom?: string
  runJobs?: boolean
  /** An absolute marker file the host owns: while it exists, the ticker runs but dispatches nothing
   * (hermes_cli/web_server.py `_desktop_cron_can_dispatch`). Lifting the hold needs no restart. */
  cronHold?: string
}): NodeJS.ProcessEnv {
  return {
    HERMES_DESKTOP_CRON: input.runJobs === true ? '1' : '0',
    ...(input.cronHold && path.isAbsolute(input.cronHold) ? { HERMES_DESKTOP_CRON_HOLD: input.cronHold } : {}),
    ...(input.homeRoom && /^!.+/.test(input.homeRoom) ? { MATRIX_HOME_ROOM: input.homeRoom } : {})
  }
}

/**
 * Hermes as the old app's desktop backend runs it. The owner's rule (2026-09-26): Atum is
 * never less capable than Hermes. So the person's own environment and home, the desktop
 * backend's cron ticker and checkpoints (`HERMES_DESKTOP`), Hermes's configured toolsets
 * (no pin), the profile's own `.env` keys, and the bundled browser. Only the app's private
 * variables and the bundled runtime's integrity are held back.
 */
export function matrixHermesEnvironment(
  config: MatrixHermesRuntimeConfig,
  home: string,
  workspace: string,
  inherited: NodeJS.ProcessEnv = process.env,
  /** `null`: a Mac with one Atum account keeps the Codex store as 0.18.2 packaged it
   * (codex-accounts.ts): no override, so Hermes's shared folder (pinned below in a packaged
   * build, Hermes's own default otherwise) holds it. */
  codex: MatrixHermesCodexScope | null = homeCodexScope(home)
): NodeJS.ProcessEnv {
  const bundled = config.bundled

  const own = Object.fromEntries(
    Object.entries(inherited).filter(
      ([key]) => !WITHHELD_ENV.test(key) && !(bundled && key.startsWith('AGENT_BROWSER_'))
    )
  )

  // The old app's PATH (backend-env.ts): Hermes's managed Node and the interpreter's bin
  // ahead of the person's PATH, then the usual system folders (Homebrew, /usr/local),
  // which a Finder launch lacks. The bundled browser comes first in a packaged build.
  const desktopPath = buildDesktopBackendPath({
    hermesHome: home,
    venvRoot: path.dirname(path.dirname(config.python)),
    currentPath: inherited.PATH ?? '',
    platform: process.platform
  })

  // Global npm installs go to the agent's home: the bundled node (and its npm) live in the
  // signed app, which must never change.
  const npmGlobal = bundled ? path.join(home, 'desktop-runtime', 'npm-global') : undefined

  return {
    ...own,
    PATH: [
      bundled?.browserBin,
      bundled?.nodeBin,
      // uv/uvx (runtime-tools.json), so tools work on a Mac without developer tools.
      ...(bundled?.toolBins ?? []),
      npmGlobal && path.join(npmGlobal, 'bin'),
      desktopPath
    ]
      .filter(Boolean)
      .join(path.delimiter),
    HERMES_HOME: home,
    HERMES_DESKTOP: '1',
    // Fixed build gate; each private session additionally requires a native platform binding.
    // Inherited values never activate this product capability.
    ATUM_PET_INTENTS: MATRIX_PET_INTENT_PLAYBACK ? 'reply' : 'off',
    ATUM_WORD_COMPANION: process.platform === 'darwin' ? '1' : '0',
    // Internal bridge, not a setting: tells Hermes it runs on one of the owner's Macs, and
    // which, for the agent's fixed "Where you run" section (agent/system_prompt.py).
    ATUM_MAC_NAME: readMacName(config),
    HERMES_TUI_CHECKPOINTS: '1',
    // Hermes announces a tool's start only when its tool-progress mode is not "off", and the
    // resume decision (turn-effects.ts) reads those announcements: a run that used `terminal` while
    // they were off would look like one that did nothing. Pinned here so neither the person's
    // shell nor a `display.tool_progress: off` in the agent's config.yaml can hide a tool start.
    HERMES_TUI_TOOL_PROGRESS: 'all',
    TERMINAL_CWD: workspace,
    PYTHONPATH: config.source,
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONSAFEPATH: '1',
    HERMES_LAZY_INSTALL_TARGET: path.join(home, 'desktop-runtime', 'lazy-packages'),
    ...(bundled?.sharedAuthDir ? { HERMES_SHARED_AUTH_DIR: bundled.sharedAuthDir } : {}),
    // Internal bridges, not settings (matrixAccountCodexScope): set whenever accounts are kept
    // apart, so neither the person's shell nor the shared store above decides whose ChatGPT
    // sign-in this is.
    ...(codex ? { HERMES_CODEX_SHARED_AUTH_DIR: codex.authDir, CODEX_HOME: codex.codexHome } : {}),
    ...(npmGlobal ? { NPM_CONFIG_PREFIX: npmGlobal } : {}),
    ...(bundled
      ? {
          AGENT_BROWSER_EXECUTABLE_PATH: bundled.chromium,
          AGENT_BROWSER_HOME: path.join(home, 'desktop-runtime', 'agent-browser'),
          PLAYWRIGHT_BROWSERS_PATH: path.join(home, 'desktop-runtime', 'browser-cache')
        }
      : {})
  }
}

/** The native Matrix file-plane parent; the older messaging surface is separate. */
export const MATRIX_ATUM_FOLDER = 'Atum'

/** One workspace projection for startup, watched folders and the process environment. */
export function matrixHermesWorkspace(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  knownDriveRoots: readonly string[] = []
): string {
  return matrixWorkspaceChoice(env, home, knownDriveRoots).workspace
}

const workspaceWarnings = new Set<string>()

function workspaceWarning(reason: string): void {
  if (!workspaceWarnings.has(reason)) {
    workspaceWarnings.add(reason)
    console.warn(`[Matrix] ${reason}`)
  }
}

/** Private default; a file/link collision keeps the legacy folder for this launch. */
function ensureMatrixHermesWorkspace(knownDriveRoots: readonly string[], home: string): string {
  const choice = matrixWorkspaceChoice(process.env, home, knownDriveRoots)

  if (choice.reason) {
    workspaceWarning(choice.reason)
  }

  const workspace = ensureMatrixWorkspace(choice, knownDriveRoots)

  if (workspace !== choice.workspace) {
    workspaceWarning('workspace_layout_blocked')
  }

  return workspace
}

/** Offline Hermes lifecycle; callers must stop and settle this executor first.
 * The home is retained in the native vault before setup, never renderer input.
 * No model, installer, HTTP server or network access is needed to forget a key. */
export async function clearMatrixHermesCredentials(config: MatrixHermesRuntimeConfig, home: string): Promise<void> {
  if (!path.isAbsolute(home)) {
    throw new Error('matrix_local_cleanup_pending')
  }

  await new Promise<void>((resolve, reject) => {
    execFile(
      config.python,
      [
        '-s',
        '-P',
        '-B',
        '-c',
        // The own endpoint's key, then the profile's ChatGPT sign-in (its own copy; the
        // account's shared one goes with forgetMatrixAccountCodex).
        'import sys; from hermes_cli.credential_lifecycle import remove_custom_endpoint_credentials; remove_custom_endpoint_credentials(*sys.argv[1:]); from hermes_cli.auth import clear_provider_auth; clear_provider_auth("openai-codex")',
        MATRIX_HERMES_ENDPOINT.id,
        MATRIX_HERMES_ENDPOINT.name
      ],
      {
        cwd: config.source,
        env: matrixHermesEnvironment(config, home, matrixHermesWorkspace()),
        timeout: 60_000,
        maxBuffer: 1_048_576
      },
      error => (error ? reject(new Error('matrix_local_cleanup_pending')) : resolve())
    )
  })
}

/** Disconnect ChatGPT in the account sign-in home through Hermes's own `clear_provider_auth`:
 * under that store's `auth.lock` (the lock every assistant borrowing it and the sign-in host take),
 * re-read, then only the `openai-codex` singleton, its pool rows and an `active_provider` naming it
 * go. Another provider's rotation landing in the same file is never overwritten. Offline: no model,
 * server or network. A missing store is a no-op. */
export async function clearMatrixAccountChatGpt(config: MatrixHermesRuntimeConfig, accountHome: string): Promise<void> {
  if (!path.isAbsolute(accountHome)) {
    throw new Error('matrix_subscriptions_unavailable')
  }

  if (!existsSync(path.join(accountHome, 'auth.json'))) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    execFile(
      config.python,
      ['-s', '-P', '-B', '-c', 'from hermes_cli.auth import clear_provider_auth; clear_provider_auth("openai-codex")'],
      {
        cwd: config.source,
        env: matrixHermesEnvironment(config, accountHome, matrixHermesWorkspace()),
        timeout: 60_000,
        maxBuffer: 1_048_576
      },
      error => (error ? reject(new Error('matrix_subscriptions_unavailable')) : resolve())
    )
  })
}

/** Own exactly the process launched for this invocation. No legacy main import,
 * provider fallback, second RPC client or extra reasoning/tool engine. */
export async function executeMatrixHermes(
  config: MatrixHermesRuntimeConfig,
  input: {
    owner: string
    executorId: string
    invocationId: string
    text: string
    signal: AbortSignal
    ask?: MatrixHermesAsk
  }
) {
  readFileSync(path.join(matrixHermesHome(config, input.owner, input.executorId), 'config.yaml'))

  return withMatrixHermes(config, input, ({ gateway, workspace, legacyWorkspace }) =>
    runMatrixHermesTurn(gateway, { ...input, workspace, legacyWorkspace })
  )
}

export interface MatrixHermesConnection {
  gateway: JsonRpcGatewayClient
  workspace: string
  /** Native-only old default, never supplied by a turn/renderer. */
  legacyWorkspace?: string
  /** Ends on close, abort, process exit or lost RPC transport. */
  signal: AbortSignal
  api(route: '/api/providers/custom-endpoints' | '/api/config', body: unknown): Promise<void>
  /** Native-only transport for the fixed management-pages allowlist. */
  pages?(input: { path: string; method: string; body?: unknown }): Promise<unknown>
  close(): Promise<void>
}

/** Setup and turns use the same isolated runtime. The native caller owns the
 * lifetime; no URL, bearer or general RPC capability crosses into the renderer.
 * This backend is short-lived (setup, a model check, a sign-in, a pet hatch) and never
 * runs the agent's cron ticker: it cannot carry the host's hold marker, so a ticker of
 * its own would fire the agent's jobs on a Mac that may only be standing by, and a
 * second time beside the long-lived backend on the same home. Only `openAssistantHermes`
 * asks for the ticker, with the hold. */
export async function withMatrixHermes<T>(
  config: MatrixHermesRuntimeConfig,
  input: { owner: string; executorId: string; signal: AbortSignal; home?: string; sharedCodex?: boolean; atumInstructions?: boolean },
  run: (connection: MatrixHermesConnection) => Promise<T>
): Promise<T> {
  const connection = await openMatrixHermes(config, { ...input, runJobs: false, cronHold: undefined })

  try {
    return await run(connection)
  } finally {
    await connection.close()
  }
}

/** `home`: another agent's bound home (agent-home.ts), always a folder directly inside the
 * profiles folder; absent, the executor's own home (the default agent's, as shipped). */
export function matrixHermesRuntimeHome(
  config: Pick<MatrixHermesRuntimeConfig, 'profiles'>,
  input: { owner: string; executorId: string; home?: string }
): string {
  if (input.home === undefined) {
    return matrixHermesHome(config, input.owner, input.executorId)
  }

  if (
    !path.isAbsolute(input.home) ||
    !/^[a-f0-9]{64}$/.test(path.basename(input.home)) ||
    path.resolve(path.dirname(input.home)) !== path.resolve(config.profiles)
  ) {
    throw new Error('matrix_runtime_configuration_invalid')
  }

  return input.home
}

/** One launch's account subscriptions. A broken store is an absent subscription, never a
 * failed launch. */
function subscriptionEnvironment(config: MatrixHermesRuntimeConfig): NodeJS.ProcessEnv {
  try {
    return config.subscriptionEnv?.() ?? {}
  } catch {
    return {}
  }
}

/** Native-only occurrence launch. The parent prepares the job projection in this
 * private home; the normal runtime owns its process group and RPC lifetime. */
export interface MatrixHermesOccurrence {
  executionId: string
  modelBaseUrl: string
  modelKey: string
}

export function matrixHermesOccurrenceHome(config: Pick<MatrixHermesRuntimeConfig, 'profiles'>,
  input: { owner: string; executorId: string; home?: string; occurrence?: MatrixHermesOccurrence }): string {
  const parent = matrixHermesRuntimeHome(config, input)

  if (!input.occurrence) {return parent}
  const { executionId, modelBaseUrl, modelKey } = input.occurrence
  let url: URL

  try { url = new URL(modelBaseUrl) } catch {throw new Error('matrix_occurrence_invalid')}

  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(executionId) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(modelKey) || url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/v1' ||
      url.username || url.password || url.search || url.hash) {throw new Error('matrix_occurrence_invalid')}

  return path.join(parent, 'occurrences', executionId)
}

export async function openMatrixHermes(
  config: MatrixHermesRuntimeConfig,
  input: {
    owner: string
    executorId: string
    signal: AbortSignal
    occurrence?: MatrixHermesOccurrence
    homeRoom?: string
    /** Opt in to the agent's cron ticker (matrixHermesJobsEnvironment): absent or false, none. */
    runJobs?: boolean
    /** The host's hold marker for this agent's ticker (matrixHermesJobsEnvironment). */
    cronHold?: string
    home?: string
    /** Main's grants for this launch only (matrixGoogleHermesEnvironment). */
    google?: NodeJS.ProcessEnv
    /** Account-scoped live source choices; handlers re-read this atomic file per call. */
    sourcePolicy?: string
    /** This Mac has one Atum account (codex-accounts.ts `matrixCodexStoreMode`): the ChatGPT
     * sign-in stays where 0.18.2 kept it. Absent: the account's own folder. */
    sharedCodex?: boolean
    /** This agent's authoritative home is this Mac; enable the fixed Atum base layer before launch. */
    atumInstructions?: boolean
    /** Closed, attempt-scoped subscription diagnostics. No process output or launch input. */
    diagnostics?: {
      exit(exit: { code: number | null; signal: NodeJS.Signals | null; intentional: boolean }): void
      portReady(elapsedMs: number): void
      spawned(): void
    }
  }
): Promise<MatrixHermesConnection> {
  input.signal.throwIfAborted()

  if (config.beforeOpen) {
    await awaitAbortable(config.beforeOpen(), input.signal)
  }

  input.signal.throwIfAborted()

  const home = matrixHermesOccurrenceHome(config, input)
  const workspaceHome = config.workspaceHome ?? os.homedir()

  if (!path.isAbsolute(workspaceHome)) {
    throw new Error('matrix_runtime_configuration_invalid')
  }

  const workspace = ensureMatrixHermesWorkspace(config.knownDriveRoots?.() ?? [], workspaceHome)

  if (input.sourcePolicy !== undefined && !path.isAbsolute(input.sourcePolicy)) {
    throw new Error('matrix_runtime_configuration_invalid')
  }

  mkdirSync(home, { recursive: true, mode: 0o700 })

  if (input.atumInstructions || currentAuxPython(config, home)) {
    await ensureMatrixAtumInstructions(config, home, input.signal, Boolean(input.atumInstructions))
    input.signal.throwIfAborted()
  }

  const token = randomBytes(32).toString('hex')
  const gateway = new JsonRpcGatewayClient()
  const ended = new AbortController()
  const startPermit = matrixHermesStarts.acquire(input.signal)
  const releaseStart = typeof startPermit === 'function' ? startPermit : await startPermit

  const spawnedAt = Date.now()

  const child = (() => {
    try {
      return ownedBackgroundChildren.track(spawn(config.python, ['-s', '-P', '-B', '-m', 'hermes_cli.main', ...serveBackendArgs()], {
        cwd: workspace,
        // A dedicated POSIX process group contains ordinary tool/helper children.
        // Never signal the application's own group or unrelated Hermes processes.
        detached: process.platform !== 'win32',
        env: {
          // The old app's backend environment (matrixHermesEnvironment): the person's own,
          // this account's Hermes home and its .env, the desktop flags and bundled helpers.
          ...matrixHermesEnvironment(
            config,
            home,
            workspace,
            input.occurrence ? { PATH: process.env.PATH, HOME: home, LANG: process.env.LANG } : process.env,
            input.occurrence ? homeCodexScope(home) : input.sharedCodex ? null : matrixAccountCodexScope(config, input.owner)
          ),
          ...matrixHermesJobsEnvironment(input),
          ...(input.occurrence ? {} : input.google),
          ...(input.sourcePolicy ? { ATUM_SOURCE_POLICY_FILE: input.sourcePolicy } : {}),
          ...(input.occurrence ? {
            HERMES_DESKTOP_CRON: '0',
            HERMES_DESKTOP_CRON_HOLD: '',
            HERMES_SHARED_AUTH_DIR: path.join(home, 'auth'),
            ATUM_DESKTOP_JOB_EXECUTION: input.occurrence.executionId,
            ATUM_MANAGED_MODEL_BASE_URL: input.occurrence.modelBaseUrl,
            ATUM_MODEL_KEY: input.occurrence.modelKey
          } : subscriptionEnvironment(config)),
          HERMES_DASHBOARD_SESSION_TOKEN: token
        },
        stdio: ['pipe', 'pipe', 'pipe']
      }), process.platform !== 'win32')
    } catch (error) {
      releaseStart()
      throw error
    }
  })()

  try {
    input.diagnostics?.spawned()
  } catch {
    /* Diagnostics never own execution. */
  }

  // Drain output without exposing prompts, tool output or credentials in logs.
  child.stderr.resume()
  const ready = waitForDashboardPort(child)
  void ready.catch(() => {})
  let killed: ReturnType<typeof setTimeout> | undefined
  let exited = false
  let stopping = false

  const stopped = new Promise<void>(resolve => {
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exited) {
        resolve()

        return
      }

      exited = true

      try {
        input.diagnostics?.exit({ code, signal, intentional: stopping })
      } catch {
        /* Diagnostics never own execution. */
      }

      try {
        config.onExit?.({ code, signal, intentional: stopping })
      } catch {
        /* Diagnostics never own execution. */
      }

      ended.abort()
      clearTimeout(killed)
      resolve()
    }

    child.once('exit', (code, signal) => finish(code, signal))
    child.once('error', () => finish(null, null))
  })

  const terminate = (signal: NodeJS.Signals) => {
    if (process.platform !== 'win32' && child.pid) {
      try {
        process.kill(-child.pid, signal)
      } catch {
        /* Group already exited. */
      }
    } else if (!exited) {
      child.kill(signal)
    }
  }

  const stop = () => {
    ended.abort()
    gateway.close()
    terminate('SIGTERM')

    if (!exited) {
      child.stdin.end()
      killed ??= setTimeout(() => terminate('SIGKILL'), 2_000)
    }
  }

  // Only an owner request makes the exit intentional. A transport that drops
  // first (the backend already dying) must still be reported as a failure.
  const stopOnAbort = () => {
    stopping = true
    stop()
  }

  input.signal.addEventListener('abort', stopOnAbort, { once: true })

  let closing: Promise<void> | undefined

  // A caller closing the connection retires this backend on purpose. The
  // transport dropping on its own is the backend failing, not an owner stop.
  const closeWith = (intentional: boolean) => {
    if (intentional && !exited) {
      stopping = true
    }

    return (closing ??= Promise.resolve().then(async () => {
      input.signal.removeEventListener('abort', stopOnAbort)
      stop()
      await stopped

      if (process.platform !== 'win32' && child.pid) {
        terminate('SIGKILL')
      }
    }))
  }

  const close = () => closeWith(true)

  try {
    input.signal.throwIfAborted()
    const port = await ready

    try {
      input.diagnostics?.portReady(Date.now() - spawnedAt)
    } catch {
      /* Diagnostics never own execution. */
    }

    // The expensive import/bind phase is over. Other agents may cold-start now while this
    // one connects its loopback RPC transport and continues running independently.
    releaseStart()

    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('matrix_hermes_port_invalid')
    }

    input.signal.throwIfAborted()
    await awaitAbortable(
      gateway.connect(
        buildHermesWebSocketUrl({
          path: '/api/ws',
          host: `127.0.0.1:${port}`,
          protocol: 'http:',
          authParam: ['token', token]
        })
      ),
      input.signal
    )
    input.signal.throwIfAborted()
    ended.signal.throwIfAborted()

    // A disconnected transport cannot safely be reattached to a possibly
    // running tool. Retire this owned process; never retry its last prompt.
    const offState = gateway.onState(state => {
      if (state !== 'open') {
        ended.abort()
      }
    })

    ended.signal.addEventListener(
      'abort',
      () => {
        offState()
        void closeWith(false)
      },
      { once: true }
    )

    if (ended.signal.aborted) {
      offState()
      await closeWith(false)
      throw new Error('matrix_hermes_runtime_stopped')
    }

    return {
      gateway,
      workspace,
      legacyWorkspace: path.join(workspaceHome, MATRIX_ATUM_FOLDER),
      signal: ended.signal,
      close,
      pages: createHermesPagesTransport(port, token, home, ended.signal),
      api: async (route, body) => {
        const response = await fetch(`http://127.0.0.1:${port}${route}`, {
          method: route === '/api/config' ? 'PUT' : 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          redirect: 'error',
          // Writing a model or settings can scan providers on a cold profile.
          signal: AbortSignal.any([input.signal, AbortSignal.timeout(60_000)])
        })

        // Responses may contain provider details; never relay/log them.
        if (!response.ok) {
          await response.body?.cancel()
          throw new Error('matrix_setup_failed')
        }

        await response.body?.cancel()
      }
    }
  } catch (error) {
    releaseStart()
    await close()
    throw error
  }
}
