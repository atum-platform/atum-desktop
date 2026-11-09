import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import path from 'node:path'

import { ownedBackgroundChildren } from '../owned-background-children'

export interface MatrixDriveEngine {
  binary: string
  origin: string
  issuer: string
}

/** Includes every library/resource and contained symlink, not just the launcher. */
export function matrixDriveBundleHash(bundle: string): string {
  try {
    return bundleHash(bundle)
  } catch {
    throw new Error('matrix_drive_engine_invalid')
  }
}

function bundleHash(bundle: string): string {
  const root = realpathSync(bundle)

  if (lstatSync(bundle).isSymbolicLink() || root !== bundle) {
    throw new Error('matrix_drive_engine_invalid')
  }
  const hash = createHash('sha256')
  let count = 0
  let bytes = 0

  const walk = (folder: string) => {
    for (const name of readdirSync(folder).sort()) {
      if (++count > 10_000) {
        throw new Error('matrix_drive_engine_invalid')
      }
      const file = path.join(folder, name)
      const stat = lstatSync(file)
      const relative = path.relative(root, file)

      if (stat.isSymbolicLink()) {
        if (!realpathSync(file).startsWith(root + path.sep)) {
          throw new Error('matrix_drive_engine_invalid')
        }
        hash.update(JSON.stringify([relative, 'link', readlinkSync(file)]) + '\n')
      } else if (stat.isDirectory()) {
        walk(file)
      } else if (stat.isFile()) {
        bytes += stat.size

        if (bytes > 1_073_741_824) {
          throw new Error('matrix_drive_engine_invalid')
        }
        hash.update(
          JSON.stringify([relative, 'file', createHash('sha256').update(readFileSync(file)).digest('hex')]) + '\n'
        )
      } else {
        throw new Error('matrix_drive_engine_invalid')
      }
    }
  }

  walk(root)

  return hash.digest('hex')
}

/** Fixed packaged artifact or an explicit development manifest; never PATH discovery. */
export function selectMatrixDriveEngine(manifestFile: string, issuer: string): MatrixDriveEngine {
  try {
    return selectEngine(manifestFile, issuer)
  } catch {
    throw new Error('matrix_drive_engine_invalid')
  }
}

function selectEngine(manifestFile: string, issuer: string): MatrixDriveEngine {
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
    protocol?: unknown
    binary?: unknown
    sha256?: unknown
    bundleSha256?: unknown
    origin?: unknown
    issuer?: unknown
  }

  if (
    manifest.protocol !== 1 ||
    manifest.issuer !== issuer ||
    typeof manifest.binary !== 'string' ||
    path.isAbsolute(manifest.binary) ||
    manifest.binary.split(/[\\/]/).some(part => !part || part === '..' || part === '.') ||
    typeof manifest.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    typeof manifest.bundleSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest.bundleSha256) ||
    typeof manifest.origin !== 'string'
  ) {
    throw new Error('matrix_drive_engine_invalid')
  }

  const origin = new URL(manifest.origin)

  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/'
  ) {
    throw new Error('matrix_drive_engine_invalid')
  }

  const root = realpathSync(path.dirname(manifestFile))
  const binary = path.join(root, manifest.binary)

  if (
    lstatSync(binary).isSymbolicLink() ||
    !lstatSync(binary).isFile() ||
    !realpathSync(binary).startsWith(root + path.sep) ||
    createHash('sha256').update(readFileSync(binary)).digest('hex') !== manifest.sha256
  ) {
    throw new Error('matrix_drive_engine_invalid')
  }

  const bundle = path.join(root, manifest.binary.split('/')[0])

  if (!bundle.endsWith('.app') || matrixDriveBundleHash(bundle) !== manifest.bundleSha256) {
    throw new Error('matrix_drive_engine_invalid')
  }

  return { binary, origin: origin.origin, issuer }
}

export function spawnMatrixDriveEngine(engine: MatrixDriveEngine): ChildProcessWithoutNullStreams {
  return ownedBackgroundChildren.track(spawn(engine.binary, ['--atum-engine'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, USER: process.env.USER },
    windowsHide: true
  }))
}
