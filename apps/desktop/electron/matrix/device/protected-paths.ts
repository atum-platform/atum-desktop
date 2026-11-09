/**
 * The one source list of device-protected paths (S1 build plan §4, WS-4 "Protected paths and the
 * Seatbelt profile"). `seatbelt.ts` generates the sandbox profile from these; nothing else encodes a
 * protected path. Keep this list honest — every entry here is a trust boundary a cloud-mode agent's
 * device commands must not cross without a grant.
 *
 * Paths are expressed relative to the real `$HOME` (`~`) or absolute. The Seatbelt generator resolves
 * each to a realpath before emitting a rule (G0 finding F5: Seatbelt path predicates only match the
 * symlink-resolved path). This module itself does no I/O so it is trivially unit-testable.
 */

export interface ProtectedPathLists {
  /** Credential and secret stores denied for BOTH read and write. */
  readonly readWriteDenied: readonly string[]
  /** Persistence / policy surfaces denied for write only (reading them is harmless). */
  readonly writeDenied: readonly string[]
  /** Exec of these programs is denied (by basename or absolute path). */
  readonly execDenied: readonly string[]
  /** Directories under which exec of anything is denied (downloaded / synced code). */
  readonly execDeniedUnder: readonly string[]
  /** Executable names of Atum's own binaries, denied wherever a copy of the bundle sits. */
  readonly appExecutableNames?: readonly string[]
  /** Roots whose own grant copy may be carved out; credential denies never are. */
  readonly workingCopyRoots?: readonly string[]
  /**
   * The owner's CURRENT Drive roots, already verified by the caller (bound to the signed-in
   * account, same directory as when learned: `DriveWorkspaceCopies.writableDriveRoots`). Writable
   * like any folder of the owner's (owner decision 2026-10-24: "cloud is just another computer");
   * the Seatbelt generator pins each root and its ancestors in place and denies writes to the
   * engine's own bookkeeping files ({@link DRIVE_ENGINE_STATE_PREFIX}). Every OTHER learned root
   * (a past account's, one whose identity changed) is in `writeDenied`, as before.
   */
  readonly writableDriveRoots?: readonly string[]
  /**
   * The Mac folders the owner kept closed (`folder-access.ts`): denied for read and write, except
   * the folders in `closedFolderExceptions` that lie inside one of them (a folder the owner added
   * inside a closed one). The exception never lifts any other deny, such as a credential store.
   */
  readonly closedFolders?: readonly string[]
  readonly closedFolderExceptions?: readonly string[]
}

/**
 * Name prefix of the Drive engine's bookkeeping files at a Drive root (`.atum-drive-binding.json`,
 * `.atum-drive-journal.db` and its WAL/SHM, `.atum-drive-owner.lock`). They are the engine's own
 * state, not the owner's files: a command that wrote them could rebind the folder to another
 * account or corrupt the journal that tells clean files from edited ones.
 */
export const DRIVE_ENGINE_STATE_PREFIX = '.atum-drive'

/**
 * The runtime roots the generator needs beyond the static list: Atum's own userData (vault, device
 * keys, origin log, other agents' homes, policy, audit), the Drive root, and other agents' working
 * copies. These are only known at runtime, so `ProtectedRoots` (contracts.ts) supplies them and the
 * generator folds them in.
 */
export interface ProtectedRuntimeRoots {
  /** Atum's Electron `userData` directory — always denied (read and write). */
  readonly userData: string
  /** The latest Atum Drive root learned, or null when Drive is not mounted (never writable by itself). */
  readonly driveRoot: string | null
  /** Every Drive root ever learned: exec-denied, and write-denied unless also in `writableDriveRoots`. */
  readonly driveRoots?: readonly string[]
  /**
   * The roots a command may write: the current account's Drive, identity-verified when the
   * profile is built. Absent or empty means no Drive root is writable (fail closed).
   */
  readonly writableDriveRoots?: readonly string[]
  /** False until a synced root is known: only an own working copy may be written. */
  readonly writeOutsideWorkingRoot?: boolean
  /** Other agents' task working copies this agent may not write. */
  readonly agentWorkingRoots: readonly string[]
  /**
   * The Mac folders the owner kept closed to their assistants (`folder-access.ts`), read for every
   * command so a change applies to the next one. Denied for read and write like a credential store.
   */
  readonly closedFolders?: readonly string[]
  /** Folders the owner shared inside a closed one: reachable, unlike the rest of that folder. */
  readonly sharedInsideClosedFolders?: readonly string[]
  /** The agent's OWN task working copy, which it may write (carved out of a broader deny). */
  readonly ownWorkingRoot?: string | null
  /**
   * The running Atum executable (`process.execPath`, `…/Atum.app/Contents/MacOS/Atum`). The app's
   * binaries are exec-denied and its bundle write-denied: executed by a device command, Atum's own
   * signed binary would answer to TCC as Atum and regain the grants the disclaim launcher strips.
   */
  readonly appExecutable?: string | null
}

/**
 * Credentials of cloud and deployment CLIs that can spend money or reach production. Denied by default;
 * one `cloud_cli` approval (Touch ID, once per task window) re-opens them for that command.
 *
 * Package-registry credentials (`~/.npmrc`, `~/.pypirc`, cargo, gem, pip/uv/poetry config) are NOT in
 * this list: owner decision 2026-10-20 (a package install forced ~15 consecutive Touch ID prompts) moved
 * them out of `cloud_cli`, so they are readable inside the sandbox without a prompt. See
 * {@link REGISTRY_CREDENTIALS}.
 */
export const CLOUD_CLI_CREDENTIALS: readonly string[] = [
  '~/.aws',
  '~/.config/gcloud',
  '~/.kube',
  '~/.azure',
  '~/.config/doctl',
  '~/.config/op',
  '~/.config/infisical',
  '~/.cloudflared',
  '~/.wrangler',
  '~/.config/.wrangler',
  '~/.supabase',
  '~/.fly',
  '~/.vault-token',
  '~/.terraform.d',
  '~/Library/Application Support/com.vercel.cli'
]

/**
 * Package-registry credentials, deliberately NOT denied (owner decision 2026-10-20, overriding the G0
 * "every protected action asks" design): installing a package is routine work and must never prompt.
 * The command still runs sandboxed, its egress is audited, and Stop still ends it. Listed here so the
 * boundary tests and the next engineer can see exactly what was opened.
 */
export const REGISTRY_CREDENTIALS: readonly string[] = [
  '~/.npmrc',
  '~/.yarnrc',
  '~/.yarnrc.yml',
  '~/.pypirc',
  '~/.config/pip',
  '~/.pip',
  '~/.config/uv',
  '~/.config/pypoetry',
  '~/.cargo/credentials',
  '~/.cargo/credentials.toml',
  '~/.gem/credentials',
  // Everyday developer logins, not money (coordinator call 2026-10-20 under the owner's rule): GitHub and Docker registries.
  '~/.config/gh',
  '~/.config/hub',
  '~/.docker/config.json'
]

/**
 * Credential and secret stores: denied for read AND write. Reading a credential is the first half of
 * stealing it, so the floor denies the read, not just the use (Astra #2: "credential use, not only
 * reading"). † in the plan's table = verified in the G0 probes.
 */
export const CREDENTIAL_READ_WRITE_DENIED: readonly string[] = [
  '~/.ssh', // † SSH keys and known_hosts
  '~/Library/Keychains', // login + iCloud keychains
  // Browser cookie / login / session stores
  '~/Library/Cookies',
  '~/Library/Application Support/Google/Chrome',
  '~/Library/Application Support/Chromium',
  '~/Library/Application Support/Arc',
  '~/Library/Application Support/BraveSoftware',
  '~/Library/Application Support/Microsoft Edge',
  '~/Library/Application Support/Firefox',
  '~/Library/Safari',
  '~/Library/Containers/com.apple.Safari',
  '~/Library/HTTPStorages',
  // Cloud / registry / dev credentials (the `cloud_cli` grant re-opens these, see seatbelt.ts)
  ...CLOUD_CLI_CREDENTIALS,
  '~/.gnupg',
  '~/.netrc',
  '~/.git-credentials',
  // Other agents' and assistants' keys and homes
  '~/.codex',
  '~/.claude',
  '~/.claude.json',
  '~/.config/claude',
  '~/.hermes'
]

/**
 * Persistence and policy surfaces: write-denied. An agent reading `~/.zshrc` is fine; writing it to
 * gain a login-time foothold is not (Astra #2 "persistence and policy"). The home-relative shell
 * startup files and crontab spool are listed explicitly; LaunchAgents and the app bundle are absolute.
 */
export const PERSISTENCE_WRITE_DENIED: readonly string[] = [
  // † shell startup files (every file a login or interactive shell of the owner's sources)
  '~/.zshrc',
  '~/.zprofile',
  '~/.zshenv',
  '~/.zlogin',
  '~/.zlogout',
  '~/.bashrc',
  '~/.bash_profile',
  '~/.bash_login',
  '~/.bash_logout',
  '~/.profile',
  '~/.config/fish',
  '~/.config/zsh',
  // git config runs code in the owner's own later git commands (core.fsmonitor, core.pager, hooksPath)
  '~/.gitconfig',
  '~/.config/git',
  // login items
  '~/Library/Application Support/com.apple.backgroundtaskmanagementagent',
  // every app's preferences: a Terminal profile's CommandString, say, runs outside the sandbox in the
  // owner's next window (B2, 2026-10-05). cfprefsd writes these for the command, so its mach service is
  // denied as well (PREFERENCES_MACH_DENIED); this is the direct-file half.
  '~/Library/Preferences',
  // launch agents / daemons
  '~/Library/LaunchAgents',
  '/Library/LaunchAgents',
  '/Library/LaunchDaemons',
  // crontab spool
  '/usr/lib/cron',
  '/var/at/tabs',
  // the app itself
  '/Applications/Atum.app'
]

/**
 * Programs whose exec is denied (G0 F4 keeps these as defence in depth behind the disclaim launcher).
 * Matched by basename so `/usr/bin/osascript` and a copy both fail; the generator also emits absolute
 * rules for the ones with fixed paths. `cua-driver` and `atum-device-key` are denied so a shell
 * command can neither drive the GUI broker directly nor forge an approval signature; the disclaim
 * launcher is Atum's own. `sudo`/`su` cannot run setuid inside any sandbox (device-local sudo has its
 * own approved path). `osascript`, `osacompile`, `automator` and `shortcuts` hand work to an app
 * OUTSIDE the sandbox: Seatbelt cannot block Apple Events (re-proved 2026-10-20: `osascript -e 'tell
 * application "Finder" …'` answered from inside the profile, mach deny and all), so this exec deny is the
 * only thing between a shell command and `tell application "Terminal" to do script`. They are Atum's
 * LaunchServices-class self-protection and stay.
 *
 * Owner decision 2026-10-20 ("no artificially conservative limits"): `launchctl`, `crontab`, `at` and
 * `atrun` are no longer exec-denied. They add nothing the profile does not already close: job
 * submission stays denied by `(deny job-creation)` and the launchd mach service (kernel boundaries,
 * proved on a renamed launchctl in sp5.boundary), and the cron spool is write-denied.
 */
export const EXEC_DENIED: readonly string[] = [
  'sudo',
  'su',
  'osascript',
  'osacompile',
  'automator',
  'shortcuts',
  'cua-driver',
  'atum-device-key',
  'atum-disclaim-launcher'
]

/**
 * What every device command may do for the owner's own agents without being asked (owner decision
 * 2026-10-20: "give agents far more default access to machines"): run a downloaded program, write shell
 * startup files / git config / LaunchAgents / preferences, and build under `/opt/homebrew` and
 * `/usr/local`. These were `SILENT_CAPABILITIES` that lifted only for a command classified as naming
 * them, so an ordinary `git clone` (it writes `.git/config` and `.git/hooks`) or `defaults write` failed
 * until the brain retried with `needs`. Now they are open by default; the host merges this into every
 * profile. Never opened: Atum's own app, its userData and keys, LaunchServices and Apple Events, the
 * credential stores, Drive roots, and the permanent kernel boundaries.
 */
export const OWNER_DEFAULT_RELAXATIONS = ['persistence', 'exec_downloaded'] as const

/** Directories under which exec of ANY file is denied: downloaded / synced code (Astra #2). */
export const EXEC_DENIED_UNDER: readonly string[] = ['~/Downloads']

/** Keychain / SSH-agent / DNS mach and socket surfaces, all † (verified in G0). */
export const SECURITY_MACH_DENIED: readonly string[] = [
  'com.apple.SecurityServer',
  'com.apple.securityd',
  'com.apple.securityd.xpc',
  'com.apple.secariousd'
]

/**
 * LaunchServices and Apple Events, never relaxed (finding F9, 2026-10-05). A command that can reach
 * these asks launchd to start an app **outside** the sandbox — `open x.command` runs a script in
 * Terminal, `open -n Atum.app` starts Atum itself — and that app reads every protected path. It is also
 * the route around the exec deny of Atum's binary (the `RunAsNode` fuse stays on in S1). Both
 * LaunchServices names are needed: with only `launchservicesd` denied, `open` still launches through
 * the quarantine resolver (verified on macOS 26.6.2). Apple Events would let a command ask Finder to
 * open the same things. Agents drive apps through the GUI broker, never from a shell command.
 */
export const LAUNCH_MACH_DENIED: readonly string[] = [
  'com.apple.coreservices.launchservicesd',
  'com.apple.coreservices.quarantine-resolver',
  'com.apple.coreservices.appleevents'
]

/**
 * LaunchServices' database services, denied by prefix (`global-name-regex`), never relaxed (F9 follow-up
 * B1, 2026-10-05). With only the names above denied, `open -g -a Calculator` and `open -n -a Atum.app`
 * still started a signed, registered app outside the sandbox (`open` exits 1 with -13056, but the app
 * runs). Denying `com.apple.lsd.mapdb` alone was enough in the bisect; the whole `com.apple.lsd.` family
 * is denied so a sibling service cannot reopen it. `python3`, `git`, `node`, `swift` and `xcrun` still run.
 */
export const LAUNCH_MACH_DENIED_PREFIXES: readonly string[] = ['com.apple.lsd.']

/**
 * The per-user preferences daemon (B2, 2026-10-05): `defaults write <domain> …` from inside the sandbox
 * wrote the owner's real `~/Library/Preferences` through cfprefsd, whatever the file denies say, and even
 * with HOME redirected. `(deny user-preference-write)` does not stop it; both the agent and daemon
 * services are required for a durable read-back. A `persistence` grant lifts this together with the
 * `~/Library/Preferences` write deny.
 */
export const PREFERENCES_MACH_DENIED: readonly string[] = ['com.apple.cfprefsd.agent', 'com.apple.cfprefsd.daemon']

/** The real `$HOME` the `~` entries resolve against. Captured once; the generator passes it in. */
export interface ProtectedPathContext {
  readonly home: string
  readonly runtime: ProtectedRuntimeRoots
}

/** Expand a leading `~` against the given home. Absolute paths pass through unchanged. */
export function expandHome(path: string, home: string): string {
  if (path === '~') {
    return home
  }

  if (path.startsWith('~/')) {
    return `${home.replace(/\/$/, '')}/${path.slice(2)}`
  }

  return path
}

/**
 * Resolve the full protected-path lists for a device at runtime. Pure: it only string-joins the
 * static lists with the runtime roots and expands `~`. The Seatbelt generator realpaths each entry
 * (so a symlinked `~/.ssh` is still covered) — this function does not touch the filesystem so it can
 * be tested without one.
 */
export function resolveProtectedPaths(context: ProtectedPathContext): ProtectedPathLists {
  const { home, runtime } = context
  const expand = (p: string) => expandHome(p, home)

  const readWriteDenied = [
    ...CREDENTIAL_READ_WRITE_DENIED.map(expand),
    runtime.userData,
    ...runtime.agentWorkingRoots
  ]

  const writeDenied = [...PERSISTENCE_WRITE_DENIED.map(expand)]

  // The CURRENT Drive root is writable by device commands, as it is by the owner on this Mac: the
  // engine syncs a local edit like any other. Every learned root stays exec-denied (synced code) and
  // pinned in place; a HISTORICAL root (past account, identity changed, Drive signed out) is
  // write-denied, so replacing one with a symlink never makes the link's target writable.
  const writableDriveRoots = [...new Set(runtime.writableDriveRoots ?? [])]

  const driveRoots = [
    ...new Set([...(runtime.driveRoots ?? []), ...(runtime.driveRoot ? [runtime.driveRoot] : []), ...writableDriveRoots])
  ]

  writeDenied.push(...driveRoots.filter(root => !writableDriveRoots.includes(root)))

  const app = runtime.appExecutable ? appBundleOf(runtime.appExecutable) : null

  if (app) {
    writeDenied.push(app.bundle)
  }

  const execDeniedUnder = [...EXEC_DENIED_UNDER.map(expand)]

  execDeniedUnder.push(...driveRoots)

  const execDenied = [...EXEC_DENIED]

  if (app) {
    // The app's own binary and its Electron helpers, in place.
    execDeniedUnder.push(`${app.bundle}/Contents/MacOS`, `${app.bundle}/Contents/Frameworks`)
  }

  return {
    readWriteDenied,
    writeDenied,
    execDenied,
    execDeniedUnder,
    workingCopyRoots: runtime.agentWorkingRoots,
    writableDriveRoots,
    closedFolders: [...(runtime.closedFolders ?? [])],
    closedFolderExceptions: [...(runtime.sharedInsideClosedFolders ?? [])],
    // ... and by name, so a copy of the bundle (which keeps its signature) is denied too.
    ...(app ? { appExecutableNames: [app.executable] } : {})
  }
}

/** The `.app` bundle and executable name of a macOS app executable, or null for a bare binary. */
export function appBundleOf(executable: string): { bundle: string; executable: string } | null {
  const match = executable.match(/^(.*?\.app)\/Contents\/MacOS\/([^/]+)$/)

  return match ? { bundle: match[1], executable: match[2] } : null
}
