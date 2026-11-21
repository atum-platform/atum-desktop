import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, copyFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { work } = require('../runtime-tools.json')
const sidecar = fileURLToPath(new URL('../electron/work/sidecar', import.meta.url))

export async function stageWorkRuntime({ resources, platform, arch, archive }) {
  if (!archive || platform !== 'darwin' || arch !== 'arm64') {
    return
  }

  const hash = createHash('sha256')
  for await (const chunk of createReadStream(archive)) {
    hash.update(chunk)
  }
  if (hash.digest('hex') !== work.sha256) {
    throw new Error('Work archive does not match the pinned SHA-256')
  }

  const target = join(resources, 'work-runtime')
  const scratch = await mkdtemp(join(resources, '.work-runtime-'))

  try {
    execFileSync('/usr/bin/tar', [
      '-xzf', archive, '--no-mac-metadata', '--exclude', '._*', '--strip-components', '1', '-C', scratch
    ], { stdio: 'inherit' })
    await Promise.all(['t3', 'LICENSE', 'licenses', 'client/index.html', 'node_modules', 'resource-monitor']
      .map(path => access(join(scratch, path))))
    execFileSync('/usr/bin/lipo', ['-verify_arch', 'arm64', join(scratch, 't3')])
    await Promise.all(['supervisor.py', 'atum.json'].map(file => copyFile(join(sidecar, file), join(scratch, file))))
    // The pin this build ships, for main's update driver (`readShippedPin`): its version and the digest of the server.
    const server = createHash('sha256')
    for await (const chunk of createReadStream(join(scratch, 't3'))) {
      server.update(chunk)
    }
    await writeFile(join(scratch, 'pin.json'), JSON.stringify({ version: work.version, sha256: server.digest('hex') }))
    await rename(scratch, target)
  } finally {
    await rm(scratch, { force: true, recursive: true })
  }
}
