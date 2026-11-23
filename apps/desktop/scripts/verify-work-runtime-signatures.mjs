import { execFileSync, spawnSync } from 'node:child_process'
import { closeSync, openSync, readSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const MACH_O = new Set(['cffaedfe', 'feedfacf', 'cafebabe', 'cafebabf'])

function* candidates(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      yield* candidates(path)
    } else if (entry.isFile()) {
      const fd = openSync(path, 'r')
      try {
        const magic = Buffer.alloc(4)
        if (readSync(fd, magic) === 4 && MACH_O.has(magic.toString('hex'))) {
          yield path
        }
      } finally {
        closeSync(fd)
      }
    }
  }
}

function signature(path) {
  const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', path], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`Code signature missing: ${path}`)
  }
  const details = result.stderr
  const team = /^TeamIdentifier=([A-Z0-9]+)$/m.exec(details)?.[1]
  if (!team || !/^Authority=Developer ID Application:/m.test(details) || !/^CodeDirectory .*flags=0x[\da-f]+\([^\n]*\bruntime\b/m.test(details)) {
    throw new Error(`Developer ID Application and hardened runtime required: ${path}`)
  }
  return team
}

export function verifyWorkRuntimeSignatures(appPath) {
  const team = signature(appPath)
  const resources = join(appPath, 'Contents', 'Resources')

  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
  let verified = 0

  for (const root of ['work-runtime', 'runtime/python']) {
    let found = false
    for (const path of candidates(join(resources, root))) {
      // Fat Java class files share Mach-O's magic. The native parser distinguishes them.
      if (spawnSync('/usr/bin/lipo', ['-info', path]).status !== 0) {
        continue
      }

      execFileSync('/usr/bin/lipo', ['-verify_arch', 'arm64', path])
      execFileSync('/usr/bin/codesign', ['--verify', '--strict', path])
      if (signature(path) !== team) {
        throw new Error(`Work runtime team differs from app team: ${path}`)
      }

      verified += 1
      found = true
    }
    if (!found) {
      throw new Error(`No signed native runtime in ${root}`)
    }
  }

  return verified
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const appPath = process.argv[2]
  if (!appPath) {
    throw new Error('Usage: node scripts/verify-work-runtime-signatures.mjs <Atum.app>')
  }

  console.log(`Verified ${verifyWorkRuntimeSignatures(appPath)} Developer ID-signed native files`)
}
