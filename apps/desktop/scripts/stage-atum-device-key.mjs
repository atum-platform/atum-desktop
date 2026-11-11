import { mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { isMain } from './utils.mjs'

// Compile the Secure Enclave device-key helper (S1 WS-3b, native/atum-device-key) next to
// the Matrix bundle, where the builder keeps it outside the archive (asarUnpack), like
// atum-app-window. The Info.plist is embedded so the LocalAuthentication prompt is
// attributed to Atum. The release signs it Developer ID with the hardened runtime along with
// the other unpacked native helpers; G0-SE proved the Secure Enclave needs no entitlement.
export function stageAtumDeviceKey({ platform = process.platform, arch = process.arch, output } = {}) {
  if (platform !== 'darwin') return
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) throw new Error('device_key_requires_macos_build_host')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const source = path.join(root, 'native/atum-device-key')
  output ??= path.join(root, 'dist/atum-device-key')
  mkdirSync(path.dirname(output), { recursive: true })
  const result = spawnSync('xcrun', ['swiftc', '-O', '-target', `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macosx14.0`,
    '-framework', 'CryptoKit', '-framework', 'LocalAuthentication',
    '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', path.join(source, 'Info.plist'),
    path.join(source, 'main.swift'), '-o', output], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`device_key_build_failed: ${result.stderr}`)
  return output
}

// The device hub compiled into the Matrix main bundle as `process.env.ATUM_DEVICE_HUB_URL`
// (electron/matrix/device/connection.ts deviceHubUrl). Empty, the default: only the production
// hub, wss://devices.atumplatform.com/v1. A dev build for the SSM port-forward fallback (before
// the Cloudflare tunnel exists) may compile a loopback hub, ws://127.0.0.1:<port>/v1; a release
// (Developer ID signing, release-matrix-mac.mjs) never may, so it fails the build instead.
export function deviceHubDefine(environment = process.env) {
  const value = String(environment.ATUM_DEVICE_HUB_URL ?? '').trim()
  if (!value) return JSON.stringify('')
  if (String(environment.ATUM_MATRIX_SIGNING_IDENTITY ?? '').trim()) throw new Error('device_hub_override_in_release')
  if (!/^ws:\/\/(?:127\.0\.0\.1|localhost):[1-9][0-9]{0,4}\/v1$/.test(value)) throw new Error('device_hub_override_not_loopback')
  return JSON.stringify(value)
}

if (isMain(import.meta.url)) {
  const index = process.argv.indexOf('--output')
  stageAtumDeviceKey(index > 0 ? { output: path.resolve(process.argv[index + 1]) } : {})
}
