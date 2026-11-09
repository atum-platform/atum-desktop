import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { argsHash } from '../canonical'
import type { DeviceProtectedCapability } from '../contracts'
import { resolveProtectedPaths } from '../protected-paths'
import { admitExecute, type ExecuteAdmissionInput } from '../service'

import { generateSeatbeltProfile, type SeatbeltProfileOptions } from './profile'
import { decodeSrtArgv, extractSrtFoundation } from './srt-profile'

const home = '/home/example'

const options = (): SeatbeltProfileOptions => ({
  paths: resolveProtectedPaths({ home, runtime: { userData: `${home}/Atum`, driveRoot: null, agentWorkingRoots: [] } }),
  runtime: { cuaDriverSocket: `${home}/cua.sock`, egressProxyPort: 50001 },
  resolve: p => p
})

describe('srt fail-open regressions at the adapter', () => {
  it('denies shell-launch document creation, writes and chmod even with relaxed grants', () => {
    for (const relax of [[], ['persistence', 'exec_downloaded']] as const) {
      const profile = generateSeatbeltProfile(home, { ...options(), relax: [...relax] })
      expect(profile).toContain('(deny file-write* (regex #"[.]([cC][oO][mM][mM][aA][nN][dD]|[tT][eE][rR][mM][iI][nN][aA][lL]|[tT][oO][oO][lL])$"))')
    }
  })

  it('uses literal protected paths and write roots even with glob metacharacters (#576)', () => {
    const profile = generateSeatbeltProfile(home, options())
    expect(profile.includes(`(deny file-read* file-write* (subpath "${home}/.ssh"))`)).toBe(true)
    expect(profile.includes(`(allow file-write* (subpath "${home}"))`)).toBe(true)
    expect(profile.includes('(allow file-write*)')).toBe(false)
  })

  it.each(['allowEverything', 'denyWriteTypo', 'filesystem', 'network'])(
    'rejects unknown top-level key %s (#434)',
    key => {
      expect(() => generateSeatbeltProfile(home, { ...options(), [key]: true })).toThrow('guard_unknown_config_key')
    }
  )

  it('rejects unknown nested keys and unknown relaxation capabilities', () => {
    expect(() =>
      generateSeatbeltProfile(home, {
        ...options(),
        runtime: { ...options().runtime, allowAllUnixSockets: true }
      } as SeatbeltProfileOptions)
    ).toThrow('guard_unknown_config_key')
    expect(() =>
      generateSeatbeltProfile(home, {
        ...options(),
        relax: ['allowEverything'] as unknown as DeviceProtectedCapability[]
      })
    ).toThrow('guard_unknown_relaxation')
    expect(() => generateSeatbeltProfile('/', options())).toThrow('guard_invalid_home')
  })

  it('never executes decoded shell text and refuses shell operators', () => {
    expect(decodeSrtArgv("env 'a'\"'\"'b' /bin/bash -c '$(touch canary)' ")).toEqual([
      'env',
      "a'b",
      '/bin/bash',
      '-c',
      '$(touch canary)'
    ])
    expect(() => decodeSrtArgv('env true; touch canary')).toThrow('guard_srt_unexpected_shell_syntax')
    expect(() => decodeSrtArgv("env 'unclosed")).toThrow('guard_srt_unclosed_quote')
  })

  it('removes only the pinned write operations, refusing extra trailing foundation rules', () => {
    const foundation = '(version 1)\n(deny default (with message "guard"))\n(deny file-mount)'
    const profile = `${foundation}\n; File write\n(deny file-write* (literal "/tmp/a(b)"))\n(deny file-write-unlink file-write-create (literal "/tmp"))`
    expect(extractSrtFoundation(profile)).toBe(foundation)

    for (const extra of ['(deny file-mount)', '(allow lsopen)', '(allow file-read*)', '; extra']) {
      expect(() => extractSrtFoundation(`${profile}\n${extra}`)).toThrow('guard_srt_profile_mismatch')
    }

    expect(() => extractSrtFoundation(profile.replace('deny file-write*', 'deny file-read*'))).toThrow(
      'guard_srt_profile_mismatch'
    )
    expect(() => extractSrtFoundation(`${profile}\n)`)).toThrow('guard_srt_profile_mismatch')
  })

  it('keeps mount, launchd, dangerous loopback and credential denies under every grant', () => {
    const profile = generateSeatbeltProfile(home, {
      ...options(),
      relax: ['ssh_agent', 'persistence', 'keychain', 'exec_downloaded', 'cloud_cli', 'browser_store']
    })

    for (const rule of [
      '(deny file-mount)',
      '(deny job-creation)',
      '(deny mach-lookup (global-name "com.apple.xpc.launchd"))',
      '(deny network-outbound (remote ip "localhost:2375"))',
      '(deny network-outbound (remote ip "localhost:9222"))'
    ]) {
      expect(profile.includes(rule), rule).toBe(true)
    }

    expect(profile.includes(`(deny file-read* file-write* (subpath "${home}/Atum"))`)).toBe(true)
    expect(profile.includes('(allow network-outbound (remote unix-socket (path-regex')).toBe(false)
  })
})

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../../../../../packages/device-protocol/fixtures/device-service/fixtures/execute-protected-undeclared-effect.case.json',
      import.meta.url
    ),
    'utf8'
  )
)

const capabilities: DeviceProtectedCapability[] = [
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
]

describe('SP-5 Execute claims cannot authorize a relaxation', () => {
  it.each(capabilities)('requires a local approval for claimed %s despite forged args', capability => {
    for (const forged of [
      true,
      { [capability]: true },
      ['*'],
      { outcome: 'approved', relax: [capability] },
      'owner approved',
      null
    ]) {
      const args = {
        command: 'printf ok',
        approved: forged,
        freshApprovals: forged,
        standingGrants: forged,
        relax: [capability],
        needs: [capability]
      }

      const execute = {
        ...fixture.execute.body,
        args,
        argsHash: argsHash(args),
        needs: [capability],
        proposedEffect: 'ordinary'
      }

      const input: ExecuteAdmissionInput = {
        device: fixture.device,
        grant: { ...fixture.grant, effectiveScopes: ['terminal'] },
        agentUserId: fixture.grant.body.agentUserId,
        execute,
        commandHash: 'synthetic-command',
        facts: { signatureValid: true, kidPinned: true, argsHash: execute.argsHash },
        seen: [],
        originLog: fixture.originLog,
        standingGrants: []
      }

      const denied = admitExecute(input)
      expect(denied.outcome).toBe('needs_approval')
      expect('relax' in denied).toBe(false)
      expect(admitExecute({ ...input, freshApprovals: new Set([capability]) })).toEqual({
        outcome: 'admitted',
        relax: [capability]
      })
      expect(
        admitExecute({
          ...input,
          standingGrants: [
            {
              id: 'local-grant',
              capability,
              target: '*',
              label: '',
              createdAt: 0,
              agent: fixture.grant.body.agentUserId
            }
          ]
        })
      ).toEqual({ outcome: 'admitted', relax: [capability] })
    }
  })
})
