import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import path from 'node:path'

/**
 * The Seatbelt (`sandbox-exec`) profile generator for cloud-mode agent device commands
 * (S1 build plan §4, WS-4). It composes srt's deny-default foundation with Atum's
 * enforcement floor: `policy.ts` classifies for a prompt, but **Seatbelt is what actually stops** an
 * unclassified command that reaches the protected set (the result just tells the brain to retry with
 * `needs`).
 *
 * Every rule marked † in the plan's table was verified in the G0 probes
 * (). Three G0 corrections are baked in here:
 *  - **F1:** DNS is closed with the mDNSResponder **unix-socket** deny, not the `com.apple.dnssd`
 *    mach deny (which no longer closes DNS on macOS 26).
 *  - **F5:** every path predicate is symlink-resolved; a unix-socket connect is mediated by
 *    `network-outbound (remote unix-socket …)`, not `file-write*`; `remote ip "localhost:*"` keeps the
 *    device egress proxy reachable.
 *  - Seatbelt cannot block Apple Events, so that channel is closed by the disclaim launcher
 *    (`launcher.ts`) plus the exec denies on the `osascript` family here — belt and braces.
 *
 * Paths default to best-effort realpath. The host passes only locally approved
 * relaxations; declarations in the Execute body are not approval authority.
 */
import { DANGEROUS_FILES, getDangerousDirectories } from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js'

import type { DeviceProtectedCapability } from '../contracts'
import {
  CLOUD_CLI_CREDENTIALS,
  DRIVE_ENGINE_STATE_PREFIX,
  expandHome,
  LAUNCH_MACH_DENIED,
  LAUNCH_MACH_DENIED_PREFIXES,
  PREFERENCES_MACH_DENIED,
  type ProtectedPathLists
} from '../protected-paths'

import { srtMacFoundation } from './srt-profile'

/** The runtime sockets and the egress-proxy port the profile must account for. */
export interface SeatbeltRuntime {
  /** The CuaDriver broker control socket (`~/Library/Caches/cua-driver/cua-driver.sock`). */
  readonly cuaDriverSocket: string
  /** The device proxy's loopback port; ordinary loopback remains allowed per the coordinator. */
  readonly egressProxyPort: number
  /** The agent's own Drive working copy, which it MAY write (carved out of the tasks-root deny). */
  readonly ownWorkingRoot?: string | null
  readonly writeOutsideWorkingRoot?: boolean
  /** Trusted host socket, enabled only for a locally approved ssh_agent command. */
  readonly sshAgentSocket?: string
}

export interface SeatbeltProfileOptions {
  readonly paths: ProtectedPathLists
  readonly runtime: SeatbeltRuntime
  /** Granted/approved capabilities whose matching denies this one command may drop. */
  readonly relax?: readonly DeviceProtectedCapability[]
  /** Symlink resolver; defaults to native best-effort realpath. Tests can inject identity. */
  readonly resolve?: (path: string) => string
  /** Compatibility option; the command host owns the Stop marker, not this SBPL profile. */
  readonly operationId?: string
}

const S = (value: string): string => JSON.stringify(value).slice(1, -1)

/** The launchd SSH-agent listener socket, matched by the stable suffix of its per-boot path. */
const SSH_AGENT_LISTENER_REGEX = '/com\\.apple\\.launchd\\.[^/]+/Listeners$'
/** The resolver socket that closes DNS inside the sandbox (G0 F1). */
const MDNS_RESPONDER_SOCKET = '/var/run/mDNSResponder'
const DARWIN_FOLDER_IDENTIFIER = '[A-Za-z0-9_-]+'

const DARWIN_USER_TEMP_DIRECTORY = new RegExp(
  `^/(?:private/)?var/folders/${DARWIN_FOLDER_IDENTIFIER}/${DARWIN_FOLDER_IDENTIFIER}/T/?$`
)

const CANONICAL_DARWIN_USER_TEMP_DIRECTORY = new RegExp(
  `^/private/var/folders/${DARWIN_FOLDER_IDENTIFIER}/${DARWIN_FOLDER_IDENTIFIER}/T$`
)

/** The exact per-user Darwin T root. Never grant its parent or C/0 siblings. */
export function isDarwinUserTemporaryDirectory(value: string): boolean {
  return DARWIN_USER_TEMP_DIRECTORY.test(value)
}

/**
 * `os.tmpdir` follows a caller's TMPDIR. macOS programs such as git and mktemp use the login
 * session's Darwin T directory, so obtain and validate that narrow root through getconf instead.
 */
function darwinUserTemporaryDirectory(resolve: (path: string) => string): string | null {
  if (process.platform !== 'darwin') {
    return null
  }

  try {
    const temp = execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000
    }).trim()

    if (!isDarwinUserTemporaryDirectory(temp)) {
      return null
    }

    const canonical = resolve(temp)

    return CANONICAL_DARWIN_USER_TEMP_DIRECTORY.test(canonical) ? canonical : null
  } catch {
    return null
  }
}

/** The denies a granted capability lifts for one command. Anything not listed is never lifted. */
interface Relaxation {
  /** Credential/secret paths (read+write denies) this cap re-opens. */
  readonly openReadWrite?: readonly string[]
  /** Persistence/policy paths (write denies) this cap re-opens. */
  readonly openWrite?: readonly string[]
  /** Keychain/securityd mach services this cap re-opens. */
  readonly openMach?: readonly string[]
  /** Lift the SSH-agent listener socket deny. */
  readonly openSshAgent?: boolean
  /** Direct outbound IP ports to allow (`*:22` for ssh, say) in addition to the loopback proxy. */
  readonly openOutboundPorts?: readonly number[]
  /** Lift the exec-under-Downloads deny (running a just-downloaded binary, once approved). */
  readonly openExecDownloads?: boolean
  /** Lift the DNS deny for this one command (it dials hosts by name directly, not via the proxy). */
  readonly openDns?: boolean
}

/**
 * The per-capability relaxation map. Each is the narrowest lift that lets the approved operation run:
 * an `ssh_agent` approval opens only SSH config/known_hosts, the agent socket, name resolution and `*:22` (plain `ssh
 * host` resolves the host itself; git over ssh goes through the proxy's ProxyCommand instead), and
 * nothing else.
 *
 * Caps with no file/socket mapping lift nothing here and are enforced elsewhere:
 * - `network_new_host`: any public host is reached through the egress proxy, which no longer asks
 *   (owner decision 2026-10-20; it audits each new host and still refuses private, loopback and metadata
 *   destinations). The sandbox never opens direct egress for it.
 * - `sudo`: macOS refuses to exec a setuid binary from inside any Seatbelt sandbox (verified on macOS
 *   26: `sudo`, `ps`, `top` fail with EPERM even under `(allow default)`), so device-local sudo runs the
 *   approved exact command outside the profile (`sudo.ts`), after Touch ID and the owner's password.
 * - `gui_upload` (the GUI broker), `other_agent_write` and `bulk_destructive` (approval only).
 */
const RELAXATIONS: Partial<Record<DeviceProtectedCapability, (home: string) => Relaxation>> = {
  ssh_agent: home => ({
    openSshAgent: true,
    openOutboundPorts: [22],
    openDns: true
  }),
  keychain: () => ({
    openReadWrite: ['~KEYCHAINS~'],
    openMach: ['com.apple.SecurityServer', 'com.apple.securityd', 'com.apple.securityd.xpc']
  }),
  browser_store: home => ({
    openReadWrite: [
      `${home}/Library/Cookies`,
      `${home}/Library/Application Support/Google/Chrome`,
      `${home}/Library/Application Support/Chromium`,
      `${home}/Library/Application Support/Arc`,
      `${home}/Library/Application Support/BraveSoftware`,
      `${home}/Library/Application Support/Microsoft Edge`,
      `${home}/Library/Application Support/Firefox`,
      `${home}/Library/Safari`,
      `${home}/Library/Containers/com.apple.Safari`,
      `${home}/Library/HTTPStorages`
    ]
  }),
  cloud_cli: home => ({
    openReadWrite: CLOUD_CLI_CREDENTIALS.map(path => expandHome(path, home))
  }),
  persistence: home => ({
    openWrite: [
      `${home}/.zshrc`,
      `${home}/.zprofile`,
      `${home}/.zshenv`,
      `${home}/.zlogin`,
      `${home}/.zlogout`,
      `${home}/.bashrc`,
      `${home}/.bash_profile`,
      `${home}/.bash_login`,
      `${home}/.bash_logout`,
      `${home}/.profile`,
      `${home}/.config/fish`,
      `${home}/.config/zsh`,
      `${home}/.gitconfig`,
      `${home}/.config/git`,
      `${home}/Library/LaunchAgents`,
      `${home}/Library/Preferences`
    ],
    openMach: [...PREFERENCES_MACH_DENIED]
  }),
  exec_downloaded: () => ({ openExecDownloads: true })
}

/** Best-effort realpath: resolve the longest existing prefix, keep the rest. Never throws. */
export function makeBestEffortResolver(realpath: (p: string) => string): (p: string) => string {
  return (path: string) => {
    let prefix = path
    const tail: string[] = []

    while (prefix && prefix !== '/') {
      try {
        const resolved = realpath(prefix)

        return tail.length ? `${resolved}/${tail.reverse().join('/')}` : resolved
      } catch {
        const slash = prefix.lastIndexOf('/')

        if (slash <= 0) {
          break
        }

        tail.push(prefix.slice(slash + 1))
        prefix = prefix.slice(0, slash)
      }
    }

    return path
  }
}

function collectRelaxations(
  relax: readonly DeviceProtectedCapability[],
  home: string
): {
  openReadWrite: Set<string>
  openWrite: Set<string>
  openMach: Set<string>
  openSshAgent: boolean
  openOutboundPorts: Set<number>
  openExecDownloads: boolean
  openDns: boolean
} {
  const openReadWrite = new Set<string>()
  const openWrite = new Set<string>()
  const openMach = new Set<string>()
  const openOutboundPorts = new Set<number>()
  let openSshAgent = false
  let openExecDownloads = false
  let openDns = false

  for (const cap of relax) {
    const make = RELAXATIONS[cap]

    if (!make) {
      continue
    }

    const r = make(home)
    r.openReadWrite?.forEach(p => openReadWrite.add(p))
    r.openWrite?.forEach(p => openWrite.add(p))
    r.openMach?.forEach(m => openMach.add(m))
    r.openOutboundPorts?.forEach(p => openOutboundPorts.add(p))
    openSshAgent ||= Boolean(r.openSshAgent)
    openExecDownloads ||= Boolean(r.openExecDownloads)
    openDns ||= Boolean(r.openDns)
  }

  return { openReadWrite, openWrite, openMach, openSshAgent, openOutboundPorts, openExecDownloads, openDns }
}

/** The capabilities whose grant changes the profile at all (the rest are enforced elsewhere). */
export function relaxesProfile(cap: DeviceProtectedCapability): boolean {
  return RELAXATIONS[cap] !== undefined
}

const regexLiteral = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/"]/g, '\\$&')

/**
 * Generate the Seatbelt profile text for one command. With no `relax`, it is the full floor used for
 * ordinary work. With granted `needs`, exactly their denies are lifted.
 *
 * `home` and protected paths come from the trusted host. The relaxation map's
 * home-relative lists match the canonical paths, independent of the Execute body.
 */
export function generateSeatbeltProfile(home: string, options: SeatbeltProfileOptions): string {
  assertKnownKeys(options, ['paths', 'runtime', 'relax', 'resolve', 'operationId'])
  assertKnownKeys(options.runtime, ['cuaDriverSocket', 'egressProxyPort', 'ownWorkingRoot', 'sshAgentSocket', 'writeOutsideWorkingRoot'])

  if (options.runtime.writeOutsideWorkingRoot !== undefined && typeof options.runtime.writeOutsideWorkingRoot !== 'boolean') {
    throw new Error('guard_invalid_write_scope')
  }

  assertKnownKeys(options.paths, [
    'readWriteDenied',
    'writeDenied',
    'execDenied',
    'execDeniedUnder',
    'appExecutableNames',
    'workingCopyRoots',
    'writableDriveRoots',
    'closedFolders',
    'closedFolderExceptions'
  ])

  if (
    !Number.isSafeInteger(options.runtime.egressProxyPort) ||
    options.runtime.egressProxyPort < 1 ||
    options.runtime.egressProxyPort > 65535
  ) {
    throw new Error('guard_invalid_proxy_port')
  }

  if ((options.relax ?? []).some(cap => !CAPABILITIES.has(cap))) {
    throw new Error('guard_unknown_relaxation')
  }

  const canonical = options.resolve ?? makeBestEffortResolver(p => realpathSync.native(p))

  const resolve = (p: string): string => {
    if (!path.posix.isAbsolute(p) || p.includes('\0')) {
      throw new Error('guard_invalid_path')
    }

    const resolved = canonical(path.posix.normalize(p))

    if (!path.posix.isAbsolute(resolved) || resolved.includes('\0')) {
      throw new Error('guard_invalid_resolved_path')
    }

    return path.posix.normalize(resolved)
  }

  const resolvedHome = resolve(home)

  if (resolvedHome === '/') {
    throw new Error('guard_invalid_home')
  }

  const relax = collectRelaxations(options.relax ?? [], home)
  const { paths, runtime } = options
  // Copy lookup returns a canonical local path. A daemon swapping it for a link
  // must not turn another copy into this grant's carve-out during generation.
  const own = runtime.ownWorkingRoot ? resolve(runtime.ownWorkingRoot) : null

  if (own && own !== path.posix.normalize(runtime.ownWorkingRoot!)) {
    throw new Error('guard_working_copy_changed')
  }

  // The keychain relaxation can't name the per-home Keychains path from the static map, so it uses a
  // sentinel the generator recognises and expands here.
  const keychainsPath = `${home}/Library/Keychains`

  const openReadWrite = new Set(
    [...relax.openReadWrite].map(p => (p === '~KEYCHAINS~' ? keychainsPath : p)).map(resolve)
  )

  const openWrite = new Set([...relax.openWrite].map(resolve))

  const lines: string[] = [srtMacFoundation(runtime.egressProxyPort)]

  for (const service of relax.openMach) {
    lines.push(`(allow mach-lookup (global-name "${S(service)}"))`)
  }

  if ((options.relax ?? []).includes('persistence')) {
    lines.push('(allow user-preference-write)')
  }

  lines.push('', '; -- Atum literal write roots, canonicalized before SBPL (srt #576 / #596) --')
  const roots = runtime.writeOutsideWorkingRoot === false ? [] : [resolvedHome, '/private/tmp']

  if (runtime.writeOutsideWorkingRoot !== false) {
    const temp = darwinUserTemporaryDirectory(resolve)

    if (temp) {
      roots.push(temp)
    }
  }

  if (runtime.ownWorkingRoot) {
    roots.push(own!)
  }

  // The owner's CURRENT Drive is written like any folder of theirs, even when it sits outside HOME.
  for (const raw of paths.writableDriveRoots ?? []) {
    roots.push(resolve(raw))
  }

  if (runtime.writeOutsideWorkingRoot !== false && (options.relax ?? []).includes('persistence')) {
    roots.push('/opt/homebrew', '/usr/local')
  }

  for (const root of new Set(roots)) {
    lines.push(`(allow file-write* (subpath "${S(root)}"))`)
  }

  for (const device of ['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/tty', '/dev/fd']) {
    lines.push(`(allow file-write* (subpath "${S(resolve(device))}"))`)
  }

  // A future owner command can load these files outside this sandbox. HOME is
  // an explicit trust-handoff anchor, independent of the packaged app's cwd.
  if (!(options.relax ?? []).includes('persistence')) {
    for (const name of [...DANGEROUS_FILES, ...getDangerousDirectories(), '.git/hooks', '.git/config']) {
      lines.push(`(deny file-write* (subpath "${S(resolve(`${home}/${name}`))}"))`)
      lines.push(`(deny file-write* (regex #"^${regexLiteral(resolvedHome)}/(.*/)?${regexLiteral(name)}(/.*)?$"))`)
      // Pin relative parents (.git, .claude, .local), so renaming the
      // enclosing directory cannot turn a denied child into an ordinary file.
      const parent = path.posix.dirname(name)

      if (parent !== '.') {
        lines.push(
          `(deny file-write-unlink file-write-create (regex #"^${regexLiteral(resolvedHome)}/(.*/)?${regexLiteral(parent)}$"))`
        )
      }
    }

    for (const name of ['bin', '.local/bin']) {
      lines.push(`(deny file-write* (subpath "${S(resolve(`${home}/${name}`))}"))`)
    }
  }

  lines.push('', '; -- credential and secret stores: no read, no write (Astra #2) --')

  for (const raw of paths.readWriteDenied) {
    const path = resolve(raw)

    if (openReadWrite.has(path)) {
      continue
    }

    const working = (paths.workingCopyRoots ?? []).some(root => resolve(root) === path)

    const filter = working && own && own.startsWith(`${path}/`)
      ? `(require-all (subpath "${S(path)}") (require-not (subpath "${S(own)}")))`
      : `(subpath "${S(path)}")`

    lines.push(`(deny file-read* file-write* ${filter})`)
    // Keep a denied directory and its ancestors in place: otherwise rename
    // the whole tree and read the credential through an unprotected spelling.
    // These are exact literal pins, never subpath denies: ordinary sibling
    // creation/removal stays available beneath each pinned ancestor.
    let ancestor = path

    while (ancestor !== '/') {
      lines.push(`(deny file-write-unlink file-write-create (literal "${S(ancestor)}"))`)
      ancestor = pathModuleDirname(ancestor)
    }
  }

  lines.push('', '; -- Mac folders the owner kept closed: no read, no write, except a folder shared inside --')
  const exceptions = [...new Set((paths.closedFolderExceptions ?? []).map(resolve))]

  for (const raw of paths.closedFolders ?? []) {
    const closed = resolve(raw)
    const inside = exceptions.filter(shared => shared.startsWith(`${closed}/`))
    const filter = inside.length
      ? `(require-all (subpath "${S(closed)}") ${inside.map(shared => `(require-not (subpath "${S(shared)}"))`).join(' ')})`
      : `(subpath "${S(closed)}")`

    lines.push(`(deny file-read* file-write* ${filter})`)
    // Pinned in place like a credential store, so a rename can't give it an unprotected spelling.
    let ancestor = closed

    while (ancestor !== '/') {
      lines.push(`(deny file-write-unlink file-write-create (literal "${S(ancestor)}"))`)
      ancestor = pathModuleDirname(ancestor)
    }
  }

  if ((options.relax ?? []).includes('ssh_agent')) {
    // Keep private keys and directory replacement denied. Resolve dotfile-manager links only
    // within HOME. Never allow a client file to alias another protected SSH credential.
    for (const name of ['config', 'known_hosts']) {
      const sshRoot = resolve(`${home}/.ssh`)
      const literal = resolve(`${home}/.ssh/${name}`)

      if (!literal.startsWith(`${resolvedHome}/`) ||
          (literal.startsWith(`${sshRoot}/`) && literal !== `${sshRoot}/${name}`)) {
        console.warn(`[guard] skipping SSH ${name}: target outside HOME or aliases a protected SSH file`)

        continue
      }

      // Seatbelt also mediates traversal of the symlink itself beneath the SSH deny.
      lines.push(`(allow file-read* (literal "${S(literal)}"))`)

      if (literal !== `${sshRoot}/${name}`) {
        lines.push(`(allow file-read* (literal "${S(`${sshRoot}/${name}`)}"))`)
      }

      if (name === 'known_hosts') {
        lines.push(`(allow file-write* (literal "${S(literal)}"))`)
      } else {
        lines.push(`(deny file-write* (literal "${S(literal)}"))`)
      }
    }
  }

  lines.push('', '; -- persistence and policy surfaces: no write --')

  for (const raw of paths.writeDenied) {
    const path = resolve(raw)

    if (openWrite.has(path)) {
      continue
    }

    lines.push(`(deny file-write* (subpath "${S(path)}"))`)
    let ancestor = path

    while (ancestor !== '/') {
      lines.push(`(deny file-write-unlink file-write-create (literal "${S(ancestor)}"))`)
      ancestor = pathModuleDirname(ancestor)
    }
  }

  lines.push('', "; -- the owner's Drive: writable, but pinned in place and the engine's own state untouched --")

  for (const raw of paths.writableDriveRoots ?? []) {
    const root = resolve(raw)
    let ancestor = root

    // Moving or removing the root (or a parent) would unbind the folder the engine syncs.
    while (ancestor !== '/') {
      lines.push(`(deny file-write-unlink file-write-create (literal "${S(ancestor)}"))`)
      ancestor = pathModuleDirname(ancestor)
    }

    lines.push(`(deny file-write* (regex #"^${regexLiteral(root)}/${regexLiteral(DRIVE_ENGINE_STATE_PREFIX)}[^/]*(/.*)?$"))`)
  }

  // The agent's own Drive working copy is carved back IN — it is denied as part of the Drive root but
  // is where this agent's task commands legitimately write.
  // Carve-outs above affect only the enclosing write deny; they never override
  // credential or trust-handoff denies with a late broad allow.

  // Finder can launch these documents outside Seatbelt. file-write* also denies chmod
  // (file-write-mode), creation and rename into these extensions. Owner decision pending.
  lines.push('', '; -- no staging shell-launch documents outside the sandbox --')
  lines.push('(deny file-write* (regex #"[.]([cC][oO][mM][mM][aA][nN][dD]|[tT][eE][rR][mM][iI][nN][aA][lL]|[tT][oO][oO][lL])$"))')

  lines.push('', '; -- exec denies: osascript family, privilege and scheduling tools, our own helpers --')

  for (const program of paths.execDenied) {
    if (program.includes('/')) {
      lines.push(`(deny process-exec* (literal "${S(resolve(program))}"))`)
    } else {
      lines.push(`(deny process-exec* (regex #"/${program.replace(/[.\\]/g, '\\$&')}$"))`)
    }
  }

  for (const name of paths.appExecutableNames ?? []) {
    // A copy of Atum's bundle keeps its signature, so its binary is denied by name wherever it sits.
    lines.push(`(deny process-exec* (regex #"/Contents/MacOS/${regexLiteral(name)}$"))`)
    lines.push(`(deny process-exec* (regex #"/${regexLiteral(name)} Helper[^/]*$"))`)
  }

  // Scope of this deny, precisely: it blocks `execve` of a file under the Drive (a binary, a script
  // with a shebang, `./run.sh`). It does NOT stop an interpreter the sandbox may run from reading a
  // Drive file as DATA: `python Drive/job.py`, `node Drive/x.js`, `sh Drive/x.sh` run, because the
  // kernel only sees `/usr/bin/python3` being executed. That is intended: an agent may run the
  // scripts it is working on, and what they can do is bounded by this same profile (no credentials,
  // no persistence surfaces, no engine state). The deny exists so a synced binary is never run as
  // a program by path.
  lines.push('', '; -- exec denies: downloaded / synced code (direct execve only), the app bundle --')

  for (const raw of paths.execDeniedUnder) {
    if (relax.openExecDownloads && /\/Downloads$/.test(raw)) {
      continue
    }

    lines.push(`(deny process-exec* (subpath "${S(resolve(raw))}"))`)
  }

  lines.push('', '; -- keychain and securityd († G0) --')
  const machDenied = ['com.apple.SecurityServer', 'com.apple.securityd', 'com.apple.securityd.xpc']

  for (const name of machDenied) {
    if (relax.openMach.has(name)) {
      continue
    }

    lines.push(`(deny mach-lookup (global-name "${S(name)}"))`)
  }

  lines.push('', '; -- no app launches outside the sandbox: LaunchServices and Apple Events (F9), never relaxed --')

  for (const name of LAUNCH_MACH_DENIED) {
    lines.push(`(deny mach-lookup (global-name "${S(name)}"))`)
  }

  for (const prefix of LAUNCH_MACH_DENIED_PREFIXES) {
    lines.push(`(deny mach-lookup (global-name-regex #"^${regexLiteral(prefix)}"))`)
  }

  lines.push('', '; -- no preference writes through cfprefsd (B2); a persistence grant lifts it --')

  for (const name of PREFERENCES_MACH_DENIED) {
    if (relax.openMach.has(name)) {
      lines.push(`(allow mach-lookup (global-name "${S(name)}"))`)

      continue
    }

    lines.push(`(deny mach-lookup (global-name "${S(name)}"))`)
  }

  lines.push('', '; -- SSH agent listener socket († G0) --')

  if (!relax.openSshAgent) {
    lines.push(`(deny network-outbound (remote unix-socket (path-regex #"${SSH_AGENT_LISTENER_REGEX}")))`)
  }

  if (relax.openSshAgent) {
    lines.push('(allow system-socket (socket-domain AF_UNIX))')

    if (runtime.sshAgentSocket) {
      lines.push(`(allow network-outbound (remote unix-socket (path-literal "${S(resolve(runtime.sshAgentSocket))}")))`)
    }

    lines.push(`(allow network-outbound (remote unix-socket (path-literal "${S(resolve(MDNS_RESPONDER_SOCKET))}")))`)
  }

  lines.push('', '; -- DNS closed inside the sandbox via the mDNSResponder socket (G0 F1) --')

  if (!relax.openDns) {
    lines.push(`(deny network-outbound (remote unix-socket (path-literal "${S(resolve(MDNS_RESPONDER_SOCKET))}")))`)
  }

  lines.push('', '; -- egress: deny all IP, allow loopback for the device proxy; granted ports direct --')
  lines.push('(deny network-outbound (remote ip "*:*"))')
  lines.push('(allow network-outbound (remote ip "localhost:*"))')

  for (const port of [...relax.openOutboundPorts].sort((a, b) => a - b)) {
    lines.push(`(allow network-outbound (remote ip "*:${port}"))`)
  }

  for (const port of [2375, 2376, 9222, 9229, 9230]) {
    lines.push(`(deny network-outbound (remote ip "localhost:${port}"))`)
  }

  lines.push('', '; -- permanent kernel boundaries, including copied launchctl / Pillar devfs --')
  lines.push('(deny file-mount)')
  lines.push('(deny job-creation)')
  lines.push('(deny mach-lookup (global-name "com.apple.xpc.launchd"))')

  lines.push('', '; -- GUI broker: no direct CuaDriver socket from a shell command († G0) --')
  lines.push(`(deny network-outbound (remote unix-socket (path-literal "${S(resolve(runtime.cuaDriverSocket))}")))`)

  lines.push('', '; -- no signalling or inspecting other processes --')
  lines.push('(deny signal (target others))')
  lines.push('(deny process-info* (target others))')

  return `${lines.join('\n')}\n`
}

const pathModuleDirname = (p: string): string => path.posix.dirname(p)

const CAPABILITIES = new Set([
  'ssh_agent',
  'keychain',
  'browser_store',
  'cloud_cli',
  'persistence',
  'exec_downloaded',
  'network_new_host',
  'sudo',
  'gui_upload',
  'other_agent_write',
  'bulk_destructive'
])

function assertKnownKeys(value: object, known: readonly string[]): void {
  if (!value || Object.keys(value).some(key => !known.includes(key))) {
    throw new Error('guard_unknown_config_key')
  }
}
