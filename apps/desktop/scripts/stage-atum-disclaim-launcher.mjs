import { mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isMain } from './utils.mjs'

/**
 * Build the native TCC disclaim launcher (WS-4, S1 build plan §4; source reused from the G0 probe at
 * `native/atum-disclaim-launcher/`). The device host is spawned through this binary so agent commands
 * never inherit Atum's Accessibility/Automation grants. Built with the Mac's Xcode `swiftc`, like the
 * other native helpers; the packager signs it with the app.
 */
export function stageAtumDisclaimLauncher({ platform = process.platform, arch = process.arch, output } = {}) {
  if (platform !== 'darwin') return
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) {
    throw new Error('disclaim_launcher_requires_macos_build_host')
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  output ??= path.join(root, 'dist/atum-disclaim-launcher')
  mkdirSync(path.dirname(output), { recursive: true })
  const result = spawnSync(
    'xcrun',
    [
      'swiftc',
      '-O',
      '-target',
      `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macosx14.0`,
      path.join(root, 'native/atum-disclaim-launcher/main.swift'),
      '-o',
      output
    ],
    { encoding: 'utf8' }
  )
  if (result.status !== 0) throw new Error(`disclaim_launcher_build_failed: ${result.stderr}`)
  return output
}

if (isMain(import.meta.url)) stageAtumDisclaimLauncher()
