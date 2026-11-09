import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const LOCAL_BRAIN_SOURCE = path.join(desktop, 'vendor/local-brain')
export const LOCAL_BRAIN_LOCK = path.join(desktop, 'vendor/local-brain-source.json')
export const LOCAL_BRAIN_SIGNED_RECEIPT = 'SIGNED-BINARY.json'
const bad = () => new Error('local_brain_package_invalid')
const json = async file => JSON.parse(await readFile(file, 'utf8'))

async function digest(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function tree(root, { source = false } = {}) {
  const files = []
  async function walk(dir, prefix = '') {
    if (!(await lstat(dir)).isDirectory() || (await lstat(dir)).isSymbolicLink()) throw bad()
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      // These are the upstream builder's disposable outputs, never package input.
      if (source && !prefix && ['.cache', 'dist'].includes(entry.name)) continue
      const relative = prefix + entry.name
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative + '/')
      else if (entry.isFile()) files.push(relative)
      else throw bad()
    }
  }
  await walk(root)
  return files.sort()
}

async function verifyFiles(root, expected, options) {
  const actual = await tree(root, options)
  const names = Object.keys(expected).sort()
  if (JSON.stringify(actual) !== JSON.stringify(names)) throw bad()
  for (const name of names) {
    if (!name || name.startsWith('/') || name.split('/').some(part => ['.', '..', ''].includes(part))) throw bad()
    const info = await lstat(path.join(root, name))
    const pin = expected[name]
    if (!Number.isSafeInteger(pin.bytes) || !/^[a-f0-9]{64}$/.test(pin.sha256) || info.size !== pin.bytes || await digest(path.join(root, name)) !== pin.sha256) throw bad()
  }
}

/** Check all vendored bytes before importing the provider's packaging code. */
export async function verifyLocalBrainSource({ sourceRoot = LOCAL_BRAIN_SOURCE, lockPath = LOCAL_BRAIN_LOCK } = {}) {
  const lock = await json(lockPath)
  const publicProjection = lock.schema === 'atum.local-brain.public-source/1'
  if (publicProjection) {
    if (lock.publicationStatus !== 'sanitised-public-source' || lock.commit !== undefined
      || lock.artifacts !== undefined || lock.artifactProducer !== undefined) throw bad()
  } else if (lock.schema !== 'atum.local-brain.source/1' || !/^[a-f0-9]{40}$/.test(lock.commit)) throw bad()
  await verifyFiles(sourceRoot, lock.files, { source: true })
  return lock
}

function key(platform, arch) {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  throw new Error('local_brain_platform_unsupported')
}

function validDigest(value) {
  return value && Number.isSafeInteger(value.bytes) && value.bytes > 0 && /^[a-f0-9]{64}$/.test(value.sha256)
}

/**
 * Record the final executable bytes after nested code signing. The receipt
 * retains the immutable source/archive pin rather than rewriting it with the
 * signing mutation. The outer application signature is the trust boundary for
 * this receipt and its paired binary.
 */
export async function writeSignedLocalBrainReceipt({ targetRoot, platform = process.platform, arch = process.arch, sourceRoot = LOCAL_BRAIN_SOURCE, lockPath = LOCAL_BRAIN_LOCK } = {}) {
  if (!path.isAbsolute(targetRoot ?? '')) throw bad()
  const lock = await verifyLocalBrainSource({ sourceRoot, lockPath })
  const target = key(platform, arch)
  const artifact = lock.artifacts?.[target]
  const sourcePin = lock.files?.['pin.json']
  if (!validDigest(artifact) || !validDigest(sourcePin) || typeof artifact.name !== 'string' || !artifact.name
    || typeof lock.repository !== 'string' || !lock.repository || typeof lock.path !== 'string' || !lock.path) throw bad()

  const pinPath = path.join(targetRoot, 'pin.json')
  const manifestPath = path.join(targetRoot, 'MANIFEST.json')
  const binaryPath = path.join(targetRoot, 'bin', 'gbrain')
  const pinInfo = await lstat(pinPath)
  const binaryInfo = await lstat(binaryPath)
  const manifestInfo = await lstat(manifestPath)
  if (!pinInfo.isFile() || pinInfo.isSymbolicLink() || !binaryInfo.isFile() || binaryInfo.isSymbolicLink()
    || !manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw bad()
  const pin = await json(pinPath)
  const manifest = await json(manifestPath)
  const asset = pin?.gbrain?.assets?.[target]
  const original = asset && { bytes: asset.size, sha256: asset.sha256 }
  if (!validDigest(original) || manifest?.format !== 'atum.local-brain.package/1' || manifest.platform !== target
    || manifest.entry !== 'src/cli.mjs' || manifest.gbrain?.bytes !== original.bytes || manifest.gbrain?.sha256 !== original.sha256
    || pinInfo.size !== sourcePin.bytes || await digest(pinPath) !== sourcePin.sha256) throw bad()

  const receipt = {
    format: 'atum.local-brain.signed-binary/1',
    platform: target,
    sourceLock: {
      schema: lock.schema,
      repository: lock.repository,
      commit: lock.commit,
      path: lock.path,
      pin: sourcePin,
      archive: { name: artifact.name, bytes: artifact.bytes, sha256: artifact.sha256 }
    },
    original: { bytes: original.bytes, sha256: original.sha256 },
    signed: { bytes: binaryInfo.size, sha256: await digest(binaryPath) }
  }
  await writeFile(path.join(targetRoot, LOCAL_BRAIN_SIGNED_RECEIPT), `${JSON.stringify(receipt)}\n`, { mode: 0o644 })
  return receipt
}

/** Read-only verification after the outer seal; never rewrites signed resources. */
export async function verifySignedLocalBrainReceipt({ targetRoot } = {}) {
  if (!path.isAbsolute(targetRoot ?? '')) throw bad()
  const receiptPath = path.join(targetRoot, LOCAL_BRAIN_SIGNED_RECEIPT)
  const binaryPath = path.join(targetRoot, 'bin', 'gbrain')
  const [receiptInfo, binaryInfo] = await Promise.all([lstat(receiptPath), lstat(binaryPath)])
  if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink() || !binaryInfo.isFile() || binaryInfo.isSymbolicLink()) throw bad()
  const receipt = await json(receiptPath)
  if (receipt?.format !== 'atum.local-brain.signed-binary/1' || !validDigest(receipt.signed)
    || receipt.signed.bytes !== binaryInfo.size || receipt.signed.sha256 !== await digest(binaryPath)) throw bad()
  return receipt
}

/** Explicit build preparation only. The running app never calls this or downloads. */
export async function prepareLocalBrain({ platform = process.platform, arch = process.arch } = {}) {
  const lock = await verifyLocalBrainSource()
  if (lock.schema === 'atum.local-brain.public-source/1') throw new Error('local_brain_public_projection_not_release_artifact')
  if (process.versions.node !== lock.artifactProducer.node || process.versions.zlib !== lock.artifactProducer.zlib) {
    throw new Error('local_brain_artifact_producer_mismatch')
  }
  const target = key(platform, arch)
  const { fetchGbrain } = await import(pathToFileURL(path.join(LOCAL_BRAIN_SOURCE, 'scripts/fetch-gbrain.mjs')).href)
  await fetchGbrain({ platform: target })
  const { buildTarball } = await import(pathToFileURL(path.join(LOCAL_BRAIN_SOURCE, 'scripts/build-tarball.mjs')).href)
  const result = await buildTarball({ platform: target, outDir: path.join(desktop, 'build/local-brain-artifacts') })
  const expected = lock.artifacts?.[target]
  if (!expected || result.sha256 !== expected.sha256 || result.bytes !== expected.bytes) throw bad()
  return result.tarball
}

/** Consume an immutable tarball by its checked-in SHA, then attest every extracted file. */
export async function stageLocalBrain({ targetRoot, platform = process.platform, arch = process.arch, artifact, sourceRoot = LOCAL_BRAIN_SOURCE, lockPath = LOCAL_BRAIN_LOCK } = {}) {
  if (!path.isAbsolute(targetRoot ?? '')) throw bad()
  const lock = await verifyLocalBrainSource({ sourceRoot, lockPath })
  const target = key(platform, arch)
  const expected = lock.artifacts?.[target]
  if (!expected || !/^[a-f0-9]{64}$/.test(expected.sha256) || !Number.isSafeInteger(expected.bytes)) throw bad()
  artifact ??= path.join(desktop, 'build/local-brain-artifacts', expected.name)
  const info = await lstat(artifact)
  if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.bytes || await digest(artifact) !== expected.sha256) throw bad()
  const pin = await json(path.join(sourceRoot, 'pin.json'))
  const pkg = await json(path.join(sourceRoot, 'package.json'))
  const binary = pin.gbrain.assets[target]
  const { extractArchive } = await import(pathToFileURL(path.join(LOCAL_BRAIN_SOURCE, 'src/tar.mjs')).href)
  const temporary = `${targetRoot}.staging-${process.pid}`
  await mkdir(path.dirname(targetRoot), { recursive: true })
  try {
    await extractArchive(artifact, temporary, { maxBytes: binary.size + 4 * 1024 * 1024, maxEntries: 1000 })
    const prefix = `local-brain-${pkg.version}-${target}`
    if (JSON.stringify(await readdir(temporary)) !== JSON.stringify([prefix])) throw bad()
    const root = path.join(temporary, prefix)
    const manifest = await json(path.join(root, 'MANIFEST.json'))
    if (manifest.format !== 'atum.local-brain.package/1' || manifest.platform !== target || manifest.entry !== 'src/cli.mjs' || manifest.gbrain?.sha256 !== binary.sha256 || manifest.gbrain?.bytes !== binary.size) throw bad()
    const files = Object.fromEntries(Object.entries(lock.files).filter(([name]) => ['package.json', 'pin.json', 'README.md'].includes(name) || /^(src|contract|licenses)\//.test(name)))
    files['bin/gbrain'] = { bytes: binary.size, sha256: binary.sha256 }
    if (JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(Object.keys(manifest.files ?? {}).sort())) throw bad()
    for (const [name, file] of Object.entries(files)) {
      if (manifest.files[name]?.sha256 !== file.sha256 || manifest.files[name]?.bytes !== file.bytes) throw bad()
    }
    await verifyFiles(root, { ...files, 'MANIFEST.json': { bytes: (await lstat(path.join(root, 'MANIFEST.json'))).size, sha256: await digest(path.join(root, 'MANIFEST.json')) } })
    await chmod(path.join(root, 'bin/gbrain'), 0o755)
    // Development staging keeps the original unsigned digest; release signing
    // replaces this receipt with the final signed bytes before the outer seal.
    await writeSignedLocalBrainReceipt({ targetRoot: root, platform, arch, sourceRoot, lockPath })
    // Validate fully before replacing our build output; no account state ever lives here.
    await rm(targetRoot, { recursive: true, force: true })
    await rename(root, targetRoot)
    return manifest
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const target = args.find(value => /^(darwin-arm64|linux-x64)$/.test(value)) ?? key(process.platform, process.arch)
  const [platform, arch] = target.split('-')
  const result = args.includes('--prepare')
    ? await prepareLocalBrain({ platform, arch })
    : await stageLocalBrain({ platform, arch, targetRoot: path.join(desktop, 'build/local-brain', target) })
  console.log(JSON.stringify(typeof result === 'string' ? { artifact: result } : { platform: result.platform, files: Object.keys(result.files).length }))
}
