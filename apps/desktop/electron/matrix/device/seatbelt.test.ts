import { describe, expect, it, vi } from 'vitest'

import { isDarwinUserTemporaryDirectory } from './guard/profile'
import {
  CLOUD_CLI_CREDENTIALS,
  LAUNCH_MACH_DENIED,
  LAUNCH_MACH_DENIED_PREFIXES,
  OWNER_DEFAULT_RELAXATIONS,
  PREFERENCES_MACH_DENIED,
  REGISTRY_CREDENTIALS,
  resolveProtectedPaths
} from './protected-paths'
import { generateSeatbeltProfile } from './seatbelt'

const HOME = '/Users/fixture'

function profile(
  relax: Parameters<typeof generateSeatbeltProfile>[1]['relax'] = [],
  resolve: (path: string) => string = p => p
) {
  const paths = resolveProtectedPaths({
    home: HOME,
    runtime: {
      userData: '/Users/fixture/Library/Application Support/Atum',
      driveRoot: '/Users/fixture/Atum',
      writableDriveRoots: ['/Users/fixture/Atum'],
      agentWorkingRoots: []
    }
  })

  return generateSeatbeltProfile(HOME, {
    paths,
    runtime: {
      cuaDriverSocket: '/Users/fixture/Library/Caches/cua-driver/cua-driver.sock',
      egressProxyPort: 51515,
      sshAgentSocket: '/private/tmp/test-ssh.sock'
    },
    resolve,
    relax
  })
}

describe('generateSeatbeltProfile — the enforcement floor', () => {
  it('is a deny-default profile with only scoped write allows', () => {
    const p = profile()
    expect(p.startsWith('(version 1)\n(deny default ')).toBe(true)
    expect(p).not.toContain('(allow default)')
    expect(p).not.toContain('(allow file-write*)')
  })

  it('denies reading and writing the credential stores', () => {
    const p = profile()
    expect(p).toContain('(deny file-read* file-write* (subpath "/Users/fixture/.ssh"))')
    expect(p).toContain('(deny file-read* file-write* (subpath "/Users/fixture/Library/Keychains"))')
    expect(p).toContain('(deny file-read* file-write* (subpath "/Users/fixture/.aws"))')
    expect(p).toContain('(deny file-read* file-write* (subpath "/Users/fixture/Library/Application Support/Atum"))')
  })

  it('write-denies persistence surfaces but not reads', () => {
    const p = profile()
    expect(p).toContain('(deny file-write* (subpath "/Users/fixture/.zshrc"))')
    expect(p).toContain('(deny file-write* (subpath "/Users/fixture/Library/LaunchAgents"))')
    expect(p).not.toContain('(deny file-read* file-write* (subpath "/Users/fixture/.zshrc"))')
  })

  it("leaves the owner's Drive writable, pinned in place, with the engine's state and synced code still denied", () => {
    const p = profile()
    expect(p).not.toContain('(deny file-write* (subpath "/Users/fixture/Atum"))')
    expect(p).toContain('(deny file-write-unlink file-write-create (literal "/Users/fixture/Atum"))')
    expect(p).toContain('(deny file-write* (regex #"^\\/Users\\/fixture\\/Atum/\\.atum-drive[^/]*(/.*)?$"))')
    expect(p).toContain('(deny process-exec* (subpath "/Users/fixture/Atum"))')
  })

  it('a Drive root outside HOME gets its own write allow, and it survives every relaxation', () => {
    const paths = resolveProtectedPaths({
      home: HOME,
      runtime: {
        userData: '/Users/fixture/Library/Application Support/Atum',
        driveRoot: '/Volumes/X/Drive',
        writableDriveRoots: ['/Volumes/X/Drive'],
        agentWorkingRoots: []
      }
    })

    const runtime = { cuaDriverSocket: '/Users/fixture/Library/Caches/cua-driver/cua-driver.sock', egressProxyPort: 51515 }
    const p = generateSeatbeltProfile(HOME, { paths, runtime, resolve: x => x, relax: [...OWNER_DEFAULT_RELAXATIONS] })
    expect(p).toContain('(allow file-write* (subpath "/Volumes/X/Drive"))')
    expect(p).toContain('(deny file-write* (regex #"^\\/Volumes\\/X\\/Drive/\\.atum-drive[^/]*(/.*)?$"))')
    expect(p).toContain('(deny file-write-unlink file-write-create (literal "/Volumes/X/Drive"))')
  })

  it('a historical or unverified Drive root is deny-only, never writable', () => {
    const paths = resolveProtectedPaths({
      home: HOME,
      runtime: {
        userData: '/Users/fixture/Library/Application Support/Atum',
        driveRoot: '/Volumes/New/Drive',
        driveRoots: ['/Volumes/Old/Drive', '/Volumes/New/Drive'],
        writableDriveRoots: ['/Volumes/New/Drive'],
        agentWorkingRoots: []
      }
    })

    const runtime = { cuaDriverSocket: '/Users/fixture/Library/Caches/cua-driver/cua-driver.sock', egressProxyPort: 51515 }
    const p = generateSeatbeltProfile(HOME, { paths, runtime, resolve: x => x, relax: [...OWNER_DEFAULT_RELAXATIONS] })
    expect(p).toContain('(allow file-write* (subpath "/Volumes/New/Drive"))')
    expect(p).not.toContain('(allow file-write* (subpath "/Volumes/Old/Drive"))')
    expect(p).toContain('(deny file-write* (subpath "/Volumes/Old/Drive"))')
    expect(p).not.toContain('(deny file-write* (subpath "/Volumes/New/Drive"))')
    expect(p).toContain('(deny process-exec* (subpath "/Volumes/Old/Drive"))')
    expect(p).toContain('(deny process-exec* (subpath "/Volumes/New/Drive"))')

    // Nothing verified: every learned root is deny-only.
    const none = resolveProtectedPaths({
      home: HOME,
      runtime: { userData: '/Users/fixture/Library/Application Support/Atum', driveRoot: '/Volumes/New/Drive', agentWorkingRoots: [] }
    })

    const q = generateSeatbeltProfile(HOME, { paths: none, runtime, resolve: x => x, relax: [] })
    expect(q).toContain('(deny file-write* (subpath "/Volumes/New/Drive"))')
    expect(q).not.toContain('(allow file-write* (subpath "/Volumes/New/Drive"))')
  })

  it('exec-denies privilege tools, the apps that run work outside the sandbox and our own helpers', () => {
    const p = profile()
    expect(p).toContain('(deny process-exec* (regex #"/sudo$"))')
    expect(p).toContain('(deny process-exec* (regex #"/osascript$"))')
    expect(p).toContain('(deny process-exec* (regex #"/shortcuts$"))')
    expect(p).toContain('(deny process-exec* (regex #"/automator$"))')
    expect(p).toContain('(deny process-exec* (regex #"/cua-driver$"))')
    expect(p).toContain('(deny process-exec* (regex #"/atum-device-key$"))')
    expect(p).toContain('(deny process-exec* (subpath "/Users/fixture/Downloads"))')
  })

  it('no longer exec-denies the scheduling tools (owner 2026-10-20); their dangerous half stays closed by the kernel boundary', () => {
    const p = profile()

    for (const program of ['launchctl', 'crontab', 'at', 'atrun']) {
      expect(p, program).not.toContain(`/${program}$`)
    }

    // Job submission stays denied by the kernel boundary, LaunchServices by mach name.
    expect(p).toContain('(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))')
    expect(p).toContain('(deny job-creation)')
    expect(p).toContain('(deny mach-lookup (global-name "com.apple.xpc.launchd"))')
  })

  it("the owner's default-open set lifts Downloads, startup files, git config and preferences, but never Atum's app, LaunchServices or the credential stores", () => {
    const paths = resolveProtectedPaths({
      home: HOME,
      runtime: {
        userData: '/Users/fixture/Library/Application Support/Atum',
        driveRoot: '/Users/fixture/Atum',
        agentWorkingRoots: [],
        appExecutable: '/Applications/Atum.app/Contents/MacOS/Atum'
      }
    })

    const p = generateSeatbeltProfile(HOME, {
      paths,
      runtime: { cuaDriverSocket: '/Users/fixture/Library/Caches/cua-driver/cua-driver.sock', egressProxyPort: 51515 },
      resolve: x => x,
      relax: [...OWNER_DEFAULT_RELAXATIONS]
    })

    expect(p).not.toContain('(deny process-exec* (subpath "/Users/fixture/Downloads"))')
    expect(p).not.toContain('(deny file-write* (subpath "/Users/fixture/.zshrc"))')
    expect(p).not.toContain('(deny file-write* (subpath "/Users/fixture/.gitconfig"))')
    expect(p).not.toContain('(deny file-write* (subpath "/Users/fixture/Library/Preferences"))')
    expect(p).not.toContain('(deny mach-lookup (global-name "com.apple.cfprefsd.agent"))')
    // Self-protection and secrets stay.
    expect(p).toContain('(deny file-write* (subpath "/Applications/Atum.app"))')
    expect(p).toContain('(deny process-exec* (subpath "/Applications/Atum.app/Contents/MacOS"))')
    expect(p).toContain('(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))')
    expect(p).toContain('(deny mach-lookup (global-name-regex #"^com\\.apple\\.lsd\\."))')
    expect(p).toContain('(deny file-read* file-write* (subpath "/Users/fixture/.ssh"))')
    expect(p).toContain('(deny file-read* file-write* (subpath "/Users/fixture/Library/Application Support/Atum"))')
  })

  it('closes DNS via the mDNSResponder socket (G0 F1) and denies all IP egress but loopback', () => {
    const p = profile()
    // Identity resolver in the test leaves the path as /var/run/mDNSResponder; production realpaths it
    // to /private/var/run/mDNSResponder (G0 F5).
    expect(p).toContain('(deny network-outbound (remote unix-socket (path-literal "/var/run/mDNSResponder")))')
    expect(p).toContain('(deny network-outbound (remote ip "*:*"))')
    expect(p).toContain('(allow network-outbound (remote ip "localhost:*"))')
  })

  it('denies the CuaDriver broker socket and signalling other processes', () => {
    const p = profile()
    expect(p).toContain(
      '(deny network-outbound (remote unix-socket (path-literal "/Users/fixture/Library/Caches/cua-driver/cua-driver.sock")))'
    )
    expect(p).toContain('(deny signal (target others))')
    expect(p).toContain('(deny process-info* (target others))')
  })

  it('denies the SSH-agent listener by default and the agent socket + *:22 lift while keys stay denied under an ssh_agent grant', () => {
    const base = profile()
    expect(base).toContain(
      '(deny network-outbound (remote unix-socket (path-regex #"/com\\.apple\\.launchd\\.[^/]+/Listeners$")))'
    )

    const relaxed = profile(['ssh_agent'])
    expect(relaxed).not.toContain(
      '(deny network-outbound (remote unix-socket (path-regex #"/com\\.apple\\.launchd\\.[^/]+/Listeners$")))'
    )
    expect(relaxed).toContain('(deny file-read* file-write* (subpath "/Users/fixture/.ssh"))')
    expect(relaxed).toContain('(allow network-outbound (remote ip "*:22"))')
    expect(relaxed).toContain('(allow file-read* (literal "/Users/fixture/.ssh/config"))')
    expect(relaxed).toContain('(allow file-write* (literal "/Users/fixture/.ssh/known_hosts"))')
    expect(relaxed).not.toContain('(allow file-write* (literal "/Users/fixture/.ssh/config"))')
    // Only the ssh denies are lifted; the keychain deny still stands.
    expect(relaxed).toContain('(deny file-read* file-write* (subpath "/Users/fixture/Library/Keychains"))')
  })

  it('a keychain grant lifts the Keychains path and the SecurityServer mach deny', () => {
    const relaxed = profile(['keychain'])
    expect(relaxed).not.toContain('(deny file-read* file-write* (subpath "/Users/fixture/Library/Keychains"))')
    expect(relaxed).not.toContain('(deny mach-lookup (global-name "com.apple.SecurityServer"))')
    // ~/.ssh still denied — only keychain was granted.
    expect(relaxed).toContain('(deny file-read* file-write* (subpath "/Users/fixture/.ssh"))')
  })

  it('package-registry credentials are readable with no grant; money-spending cloud credentials stay denied (owner decision 2026-10-20)', () => {
    const base = profile()

    for (const file of REGISTRY_CREDENTIALS) {
      const absolute = file.replace('~', HOME)
      expect(base, file).not.toContain(`(subpath "${absolute}")`)
      expect(base, file).not.toContain(`(literal "${absolute}")`)
    }

    for (const file of CLOUD_CLI_CREDENTIALS) {
      const absolute = file.replace('~', HOME)
      expect(base, file).toMatch(new RegExp(`\\((subpath|literal) "${absolute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)`))
    }

    // One cloud_cli approval re-opens the cloud list, and never the Keychain.
    const relaxed = profile(['cloud_cli'])
    expect(relaxed).not.toContain('(subpath "/Users/fixture/.aws")')
    expect(relaxed).toContain('(deny file-read* file-write* (subpath "/Users/fixture/Library/Keychains"))')
  })

  it('an exec_downloaded grant lifts the Downloads exec deny', () => {
    const relaxed = profile(['exec_downloaded'])
    expect(relaxed).not.toContain('(deny process-exec* (subpath "/Users/fixture/Downloads"))')
  })

  it('only an ssh_agent grant reopens name resolution; an unknown host never opens direct egress', () => {
    const dns = '(deny network-outbound (remote unix-socket (path-literal "/var/run/mDNSResponder")))'
    expect(profile(['ssh_agent'])).not.toContain(dns)

    for (const cap of ['keychain', 'persistence', 'exec_downloaded', 'network_new_host', 'sudo'] as const) {
      expect(profile([cap]), cap).toContain(dns)
    }

    const unknownHost = profile(['network_new_host'])
    expect(unknownHost).not.toContain('(allow network-outbound (remote ip "*:443"))')
    expect(unknownHost).not.toContain('(allow network-outbound (remote ip "*:80"))')
  })

  it("denies Atum's own binary and helpers in place and, by name, in a copied bundle", () => {
    const paths = resolveProtectedPaths({
      home: HOME,
      runtime: {
        userData: '/Users/fixture/Library/Application Support/Atum',
        driveRoot: null,
        agentWorkingRoots: [],
        appExecutable: '/Applications/Atum.app/Contents/MacOS/Atum Matrix Candidate'
      }
    })

    const p = generateSeatbeltProfile(HOME, {
      paths,
      runtime: { cuaDriverSocket: '/Users/fixture/Library/Caches/cua-driver/cua-driver.sock', egressProxyPort: 51515 }
    })

    expect(p).toContain('(deny process-exec* (subpath "/Applications/Atum.app/Contents/MacOS"))')
    expect(p).toContain('(deny process-exec* (subpath "/Applications/Atum.app/Contents/Frameworks"))')
    expect(p).toContain('(deny file-write* (subpath "/Applications/Atum.app"))')
    expect(p).toContain('(deny process-exec* (regex #"/Contents/MacOS/Atum Matrix Candidate$"))')
    expect(p).toContain('(deny process-exec* (regex #"/Atum Matrix Candidate Helper[^/]*$"))')
  })
  it('never lets a command launch an app outside the sandbox: LaunchServices and Apple Events stay denied under every grant (F9)', () => {
    const everything = profile([
      'ssh_agent',
      'keychain',
      'cloud_cli',
      'browser_store',
      'persistence',
      'network_new_host',
      'sudo',
      'other_agent_write',
      'exec_downloaded',
      'bulk_destructive',
      'gui_upload'
    ])

    for (const p of [profile(), everything]) {
      for (const name of LAUNCH_MACH_DENIED) {
        expect(p).toContain(`(deny mach-lookup (global-name "${name}"))`)
      }

      // The LaunchServices database family too (B1): a signed, registered app otherwise still starts.
      expect(LAUNCH_MACH_DENIED_PREFIXES).toContain('com.apple.lsd.')
      expect(p).toContain('(deny mach-lookup (global-name-regex #"^com\\.apple\\.lsd\\."))')
    }
  })

  it('denies preference writes (cfprefsd and ~/Library/Preferences); only a persistence grant lifts them (B2)', () => {
    const cfprefsd = PREFERENCES_MACH_DENIED.map(name => `(deny mach-lookup (global-name "${name}"))`)
    const file = '(deny file-write* (subpath "/Users/fixture/Library/Preferences"))'

    for (const cap of [null, 'keychain', 'ssh_agent', 'cloud_cli', 'exec_downloaded', 'browser_store'] as const) {
      const p = cap ? profile([cap]) : profile()

      for (const service of cfprefsd) {
        expect(p, String(cap)).toContain(service)
      }

      expect(p, String(cap)).toContain(file)
    }

    const granted = profile(['persistence'])

    for (const service of cfprefsd) {
      expect(granted).not.toContain(service)
    }

    expect(granted).not.toContain(file)
    // ... and the keychain's mach services stay denied under it.
    expect(granted).toContain('(deny mach-lookup (global-name "com.apple.securityd"))')
  })

  it('recognizes only the exact per-user Darwin temporary T directory', () => {
    expect(isDarwinUserTemporaryDirectory('/private/var/folders/aa/bb/T')).toBe(true)
    expect(isDarwinUserTemporaryDirectory('/var/folders/aa/bb/T/')).toBe(true)

    for (const path of ['/private/var/folders/../bb/T', '/private/var/folders/aa/bb\n/T', '/private/var/folders/aa/bb/C', '/private/tmp']) {
      expect(isDarwinUserTemporaryDirectory(path)).toBe(false)
    }
  })
})


it('resolves SSH client symlinks within HOME and refuses outside or key aliases', () => {
  const linked = profile(['ssh_agent'], p => p === `${HOME}/.ssh/config` ? `${HOME}/dotfiles/ssh-config` :
    p === `${HOME}/.ssh/known_hosts` ? `${HOME}/dotfiles/known_hosts` : p)

  expect(linked).toContain('(allow file-read* (literal "/Users/fixture/dotfiles/ssh-config"))')
  expect(linked).toContain('(deny file-write* (literal "/Users/fixture/dotfiles/ssh-config"))')
  expect(linked).toContain('(allow file-write* (literal "/Users/fixture/dotfiles/known_hosts"))')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  try {
    const refused = profile(['ssh_agent'], p => p === `${HOME}/.ssh/config` ? '/outside/config' :
      p === `${HOME}/.ssh/known_hosts` ? `${HOME}/.ssh/id_rsa` : p)

    expect(refused).not.toContain('(allow file-read* (literal "/outside/config"))')
    expect(refused).not.toContain('(allow file-write* (literal "/Users/fixture/.ssh/id_rsa"))')
    expect(warn).toHaveBeenCalledTimes(2)
  } finally {
    warn.mockRestore()
  }
})
