import { mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMain } from './utils.mjs'

export function stageAtumAppWindow({ platform = process.platform, arch = process.arch, output } = {}) {
  if (platform !== 'darwin') return
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) throw new Error('app_window_requires_macos_build_host')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  output ??= path.join(root, 'dist/atum-app-window')
  mkdirSync(path.dirname(output), { recursive: true })
  const result = spawnSync('xcrun', ['swiftc', '-O', '-target', `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macosx14.0`,
    path.join(root, 'native/atum-app-window/main.swift'), '-o', output], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`app_window_build_failed: ${result.stderr}`)
}

if (isMain(import.meta.url)) stageAtumAppWindow()
