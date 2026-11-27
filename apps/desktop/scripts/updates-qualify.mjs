import { execFileSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
if (process.platform !== 'darwin' || args.length !== 3) {
  console.error('Usage on an isolated Mac: node apps/desktop/scripts/updates-qualify.mjs LEGACY.app BRIDGE.app NEXT.app')
  process.exit(2)
}

const command = (program, args) => execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const read = (bundle, key) => command('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(bundle, 'Contents/Info.plist')])
const verify = candidate => {
  const bundle = realpathSync(candidate)
  if (!bundle.endsWith('.app') || !statSync(bundle).isDirectory()) {throw new Error('Expected an application bundle.')}
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
  command('/usr/sbin/spctl', ['--assess', '--type', 'execute', bundle])
  const id = read(bundle, 'CFBundleIdentifier')
  const version = read(bundle, 'CFBundleShortVersionString')
  if (id !== 'com.atum.matrix-candidate' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('Unexpected signed Atum bundle identity.')
  }
  command('/usr/bin/lipo', ['-verify_arch', 'arm64', path.join(bundle, 'Contents/MacOS', read(bundle, 'CFBundleExecutable'))])

  return version
}
try {
  const versions = args.map(verify)
  const [legacy, bridge, next] = versions
  const compare = (left, right) => left.localeCompare(right, undefined, { numeric: true })
  if (compare(legacy, bridge) >= 0 || compare(bridge, next) >= 0) {throw new Error('Expected increasing release versions.')}
  console.log(`Signed inputs verified for the isolated update matrix: ${versions.join(' → ')}`)
  console.log('Use the transition, fault, and timing checklist in docs/desktop-update-graft-2026-11-27.md.')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
