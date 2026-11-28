import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { expect, it, vi } from 'vitest'

import { verifyWorkRuntimeSignatures } from './verify-work-runtime-signatures.mjs'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(), spawnSync: vi.fn() }))

it('requires the packaged resvg Mach-O to carry the app team and hardened signature', () => {
  const app = mkdtempSync(join(tmpdir(), 'work-runtime-signatures-'))
  const resources = join(app, 'Contents', 'Resources')
  const resvg = join(resources, 'runtime/work-authoring/resvg/resvg')
  const signature = 'TeamIdentifier=TEAM\nAuthority=Developer ID Application: Test\nCodeDirectory v=1 flags=0x10000(runtime)'

  try {
    for (const path of [join(resources, 'work-runtime/node'), join(resources, 'runtime/python/python'), resvg]) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, Buffer.from('cffaedfe', 'hex'))
    }
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stderr: signature })
    expect(verifyWorkRuntimeSignatures(app)).toBe(3)
    expect(execFileSync).toHaveBeenCalledWith('/usr/bin/lipo', ['-verify_arch', 'arm64', resvg])
    expect(execFileSync).toHaveBeenCalledWith('/usr/bin/codesign', ['--verify', '--strict', resvg])

    vi.mocked(spawnSync).mockImplementation((_program, args) => ({
      status: 0,
      stderr: args[0] === '-dv' && args.at(-1) === resvg ? signature.replace('(runtime)', '(none)') : signature
    }))
    expect(() => verifyWorkRuntimeSignatures(app)).toThrow('Developer ID Application and hardened runtime required: ' + resvg)
  } finally {
    rmSync(app, { recursive: true, force: true })
    vi.resetAllMocks()
  }
})
