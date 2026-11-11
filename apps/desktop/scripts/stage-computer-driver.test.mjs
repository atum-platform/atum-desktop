import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { stageComputerDriver } from './stage-bundled-runtime.mjs'

it('stages the PM-pinned app into signed resources and removes extraction data', () => {
  const resources = mkdtempSync(join(tmpdir(), 'atum-driver-fixture-'))
  try {
    stageComputerDriver({ resources, arch: 'arm64', download: ({ url, sha256 }) => {
      expect(url).toContain('cua-driver-rs-v0.21.0')
      expect(sha256).toMatch(/^[a-f0-9]{64}$/)
    }, extract: (_archive, destination) => {
      const bin = join(destination, 'CuaDriver.app/Contents/MacOS')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, 'cua-driver'), 'fixture driver')
    } })
    expect(readFileSync(join(resources, 'CuaDriver.app/Contents/MacOS/cua-driver'), 'utf8')).toBe('fixture driver')
    expect(readFileSync(join(resources, 'CuaDriver-LICENSE.txt'), 'utf8')).toContain('Copyright (c) 2025 Cua AI, Inc.')
    expect(readFileSync(join(resources, 'cua-cursor-theme-NOTICES.txt'), 'utf8')).toContain('cursor-theme-cli')
    expect(existsSync(join(resources, '.cua-stage'))).toBe(false)
  } finally { rmSync(resources, { recursive: true, force: true }) }
})
