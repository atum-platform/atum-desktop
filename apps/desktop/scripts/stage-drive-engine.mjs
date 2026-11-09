import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import path from 'node:path'

function bundleHash(bundle) {
  const root = realpathSync(bundle)
  if (root !== bundle || lstatSync(bundle).isSymbolicLink()) throw new Error('Drive engine bundle is not canonical')
  const hash = createHash('sha256')
  let count = 0
  let bytes = 0
  const walk = folder => {
    for (const name of readdirSync(folder).sort()) {
      if (++count > 10_000) throw new Error('Drive engine bundle is too large')
      const file = path.join(folder, name)
      const stat = lstatSync(file)
      const relative = path.relative(root, file)
      if (stat.isSymbolicLink()) {
        if (!realpathSync(file).startsWith(root + path.sep)) throw new Error('Drive engine symlink escapes bundle')
        hash.update(JSON.stringify([relative, 'link', readlinkSync(file)]) + '\n')
      } else if (stat.isDirectory()) walk(file)
      else if (stat.isFile()) {
        bytes += stat.size
        if (bytes > 1_073_741_824) throw new Error('Drive engine bundle is too large')
        hash.update(
          JSON.stringify([relative, 'file', createHash('sha256').update(readFileSync(file)).digest('hex')]) + '\n'
        )
      } else throw new Error('Drive engine bundle contains a special file')
    }
  }
  walk(root)
  return hash.digest('hex')
}

/** Internal resource of the one Atum installer; never a second product or launch item. */
export function stageDriveEngine({ manifestFile, targetRoot, requireDeveloperId = false }) {
  const source = realpathSync(path.dirname(manifestFile))
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  if (
    manifest.protocol !== 1 ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceCommit ?? '') ||
    typeof manifest.binary !== 'string' ||
    !/^[^/]+\.app\/Contents\/MacOS\/[^/]+$/.test(manifest.binary) ||
    manifest.binary.includes('..') ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(manifest.bundleSha256 ?? '')
  )
    throw new Error('A pinned Drive engine manifest is required')
  const origin = new URL(manifest.origin)
  const issuer = new URL(manifest.issuer)
  for (const endpoint of [origin, issuer]) {
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== '/'
    )
      throw new Error('Drive engine endpoints are invalid')
  }
  const bundleName = manifest.binary.split('/')[0]
  const bundle = path.join(source, bundleName)
  const binary = path.join(source, manifest.binary)
  if (
    lstatSync(binary).isSymbolicLink() ||
    !realpathSync(binary).startsWith(bundle + path.sep) ||
    createHash('sha256').update(readFileSync(binary)).digest('hex') !== manifest.sha256 ||
    bundleHash(bundle) !== manifest.bundleSha256
  )
    throw new Error('Drive engine artifact does not match its manifest')
  const background = execFileSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :LSUIElement', path.join(bundle, 'Contents/Info.plist')],
    { encoding: 'utf8' }
  ).trim()
  if (background !== 'true') throw new Error('Drive engine must be background-only')
  execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'pipe' })
  if (requireDeveloperId) {
    const signed = spawnSync('codesign', ['--display', '--verbose=4', bundle], { encoding: 'utf8' })
    if (
      signed.status !== 0 ||
      !/^Authority=Developer ID Application:/m.test(signed.stderr) ||
      !/^TeamIdentifier=[A-Z0-9]{10}$/m.test(signed.stderr)
    )
      throw new Error('A Developer ID signed Drive engine is required for release')
  }
  mkdirSync(targetRoot, { recursive: true })
  cpSync(bundle, path.join(targetRoot, bundleName), {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false
  })
  cpSync(manifestFile, path.join(targetRoot, 'manifest.json'), { errorOnExist: true, force: false })
  if (bundleHash(path.join(targetRoot, bundleName)) !== manifest.bundleSha256)
    throw new Error('Drive engine changed while packaging')
  return { sourceCommit: manifest.sourceCommit, bundleSha256: manifest.bundleSha256 }
}
