import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { Run } from './stage'
import { ATUM_BUNDLE_ID, ATUM_TEAM_ID } from './state'

const execute = promisify(execFile)

/** Disposable roots for tests. Always call `cleanup` in afterEach. */
export function temporaryRoots() {
  const roots: string[] = []

  return {
    async make(prefix = 'atum-staged-') {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))

      roots.push(root)

      return root
    },
    async cleanup() {
      for (const root of roots.splice(0)) {await fs.rm(root, { recursive: true, force: true })}
    }
  }
}

const plist = (version: string, integrity: boolean) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${ATUM_BUNDLE_ID}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
${integrity ? '<key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><dict><key>algorithm</key><string>SHA256</string></dict></dict>' : ''}
</dict></plist>
`

/** A tiny app-shaped directory: an Info.plist, a script, a nested file and a framework-style link. */
export async function writeBundle(bundle: string, version: string, integrity = true): Promise<void> {
  await fs.mkdir(path.join(bundle, 'Contents', 'Resources'), { recursive: true })
  await fs.mkdir(path.join(bundle, 'Contents', 'MacOS'), { recursive: true })
  await fs.writeFile(path.join(bundle, 'Contents', 'Info.plist'), plist(version, integrity))
  await fs.writeFile(path.join(bundle, 'Contents', 'Resources', 'runtime.py'), `print("${version}")\n`)
  await fs.writeFile(path.join(bundle, 'Contents', 'MacOS', 'Atum'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await fs.symlink('Resources/runtime.py', path.join(bundle, 'Contents', 'runtime-link'))
}

/** ditto-built ZIP of a one-app archive, like the release ZIP. */
export async function writeZip(directory: string, version: string, name = 'Atum.app', integrity = true): Promise<string> {
  const source = await fs.mkdtemp(path.join(directory, 'zip-source-'))

  await writeBundle(path.join(source, name), version, integrity)
  const zip = path.join(directory, `update-${version}.zip`)

  await execute('/usr/bin/ditto', ['-c', '-k', '--keepParent', path.join(source, name), zip])
  await fs.rm(source, { recursive: true, force: true })

  return zip
}

export interface FakeSystem {
  /** Real unzip/ditto/plutil/du/xattr, fake codesign/spctl/gktool. */
  run: Run
  calls: string[]
  /** Runs when `codesign --verify` is called: lets a test tamper during verification. */
  onVerify?: (bundle: string) => Promise<void>
  notarized: boolean
  team: string
}

export function fakeSystem(overrides: Partial<Pick<FakeSystem, 'notarized' | 'team' | 'onVerify'>> = {}): FakeSystem {
  const system: FakeSystem = { calls: [], notarized: true, team: ATUM_TEAM_ID, ...overrides, run: async () => ({ stdout: '', stderr: '' }) }

  system.run = async (executable, args) => {
    const name = path.basename(executable)

    system.calls.push([name, args[0]].join(' '))

    if (name === 'codesign') {
      if (args[0] === '-d' && args[1] === '-r-') {return { stdout: '', stderr: `designated => anchor apple generic and identifier "${ATUM_BUNDLE_ID}"\n` }}

      if (args[0] === '-dv') {return { stdout: '', stderr: `flags=0x10000(runtime)\nTeamIdentifier=${system.team}\n` }}

      await system.onVerify?.(args[args.length - 1])

      return { stdout: '', stderr: '' }
    }

    if (name === 'spctl') {
      return { stdout: '', stderr: system.notarized ? 'accepted\nsource=Notarized Developer ID\n' : 'accepted\nsource=Developer ID\n' }
    }

    if (name === 'gktool') {return { stdout: '', stderr: '' }}

    return execute(executable, args, { maxBuffer: 4 * 1024 ** 2 })
  }

  return system
}
