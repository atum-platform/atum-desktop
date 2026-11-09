import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { writeArchive } from '../vendor/local-brain/src/tar.mjs'
import { LOCAL_BRAIN_SIGNED_RECEIPT, prepareLocalBrain, stageLocalBrain, verifyLocalBrainSource, verifySignedLocalBrainReceipt, writeSignedLocalBrainReceipt } from './stage-local-brain.mjs'

const directories = []
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
afterEach(async () => {
  await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture({ extra = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atum-brain-package-'))
  directories.push(root)
  const sourceRoot = path.join(root, 'source')
  const binary = Buffer.from('a pinned fixture binary')
  const files = {
    'package.json': JSON.stringify({ name: '@atum/local-brain', version: '0.1.0' }),
    'pin.json': JSON.stringify({ gbrain: { assets: { 'darwin-arm64': { size: binary.length, sha256: hash(binary) } } } }),
    'README.md': 'fixture',
    'src/cli.mjs': 'process.exit(0)',
    'contract/awareness-v1/contract.json': '{}',
    'licenses/GBRAIN-LICENSE': 'fixture licence'
  }
  const sourceFiles = {}
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text)
    await mkdir(path.dirname(path.join(sourceRoot, name)), { recursive: true })
    await writeFile(path.join(sourceRoot, name), body)
    sourceFiles[name] = { sha256: hash(body), bytes: body.length }
  }
  const manifest = {
    format: 'atum.local-brain.package/1', platform: 'darwin-arm64', entry: 'src/cli.mjs',
    gbrain: { sha256: hash(binary), bytes: binary.length },
    files: { ...sourceFiles, 'bin/gbrain': { sha256: hash(binary), bytes: binary.length } }
  }
  const prefix = 'local-brain-0.1.0-darwin-arm64/'
  const entries = Object.entries(files).map(([name, body]) => ({ path: prefix + name, type: '0', data: Buffer.from(body) }))
  entries.push({ path: prefix + 'bin/gbrain', type: '0', data: binary, mode: 0o755 })
  entries.push({ path: prefix + 'MANIFEST.json', type: '0', data: Buffer.from(JSON.stringify(manifest)) })
  if (extra) entries.push({ path: prefix + 'ledger/ledger.jsonl', type: '0', data: Buffer.from('private') })
  const artifact = path.join(root, 'fixture.tar.gz')
  await writeArchive(entries, artifact)
  const bytes = await readFile(artifact)
  const lock = {
    schema: 'atum.local-brain.source/1', repository: 'https://example.test/atum-platform', commit: 'a'.repeat(40), path: 'packages/local-brain', files: sourceFiles,
    artifacts: { 'darwin-arm64': { name: 'fixture.tar.gz', sha256: hash(bytes), bytes: bytes.length } }
  }
  const lockPath = path.join(root, 'lock.json')
  await writeFile(lockPath, JSON.stringify(lock))
  return { root, sourceRoot, lockPath, artifact, targetRoot: path.join(root, 'staged'), platform: 'darwin', arch: 'arm64' }
}

it('stages an exact archive offline, attesting every resource and no datastore', async () => {
  const input = await fixture()
  const manifest = await stageLocalBrain(input)
  expect(manifest.files['bin/gbrain']).toBeDefined()
  expect(await readFile(path.join(input.targetRoot, 'src/cli.mjs'), 'utf8')).toBe('process.exit(0)')
  await expect(readFile(path.join(input.targetRoot, 'ledger/ledger.jsonl'))).rejects.toThrow()
})

it('records a post-sign binary digest while retaining the original source and archive pin', async () => {
  const input = await fixture()
  await stageLocalBrain(input)
  const signed = Buffer.from('fixture binary after nested signing')
  await writeFile(path.join(input.targetRoot, 'bin', 'gbrain'), signed)
  const receipt = await writeSignedLocalBrainReceipt(input)

  expect(receipt.original).toEqual({ bytes: Buffer.from('a pinned fixture binary').length, sha256: hash(Buffer.from('a pinned fixture binary')) })
  expect(receipt.signed).toEqual({ bytes: signed.length, sha256: hash(signed) })
  expect(receipt.sourceLock).toMatchObject({ commit: 'a'.repeat(40), path: 'packages/local-brain', archive: { name: 'fixture.tar.gz' } })
  expect(JSON.parse(await readFile(path.join(input.targetRoot, LOCAL_BRAIN_SIGNED_RECEIPT), 'utf8'))).toEqual(receipt)
})

it('refuses to receipt a staged package whose installed pin no longer matches the source lock', async () => {
  const input = await fixture()
  await stageLocalBrain(input)
  await writeFile(path.join(input.targetRoot, 'pin.json'), JSON.stringify({ gbrain: { assets: { 'darwin-arm64': { size: 1, sha256: '0'.repeat(64) } } } }))
  await expect(writeSignedLocalBrainReceipt(input)).rejects.toThrow('local_brain_package_invalid')
})

it.each(['source', 'archive', 'extra-source', 'source-link', 'archive-link', 'extra-archive'])('refuses %s drift without replacing a prior build', async mutation => {
  const input = await fixture({ extra: mutation === 'extra-archive' })
  await mkdir(input.targetRoot)
  await writeFile(path.join(input.targetRoot, 'retained'), 'prior')
  if (mutation === 'source') await writeFile(path.join(input.sourceRoot, 'src/cli.mjs'), 'changed')
  if (mutation === 'archive') await writeFile(input.artifact, 'changed')
  if (mutation === 'extra-source') await writeFile(path.join(input.sourceRoot, 'unexpected'), 'extra')
  if (mutation === 'source-link') {
    const cli = path.join(input.sourceRoot, 'src/cli.mjs')
    await rm(cli)
    await symlink(path.join(input.root, 'lock.json'), cli)
  }
  if (mutation === 'archive-link') {
    await rm(input.artifact)
    await symlink(input.lockPath, input.artifact)
  }
  await expect(stageLocalBrain(input)).rejects.toThrow('local_brain_package_invalid')
  expect(await readFile(path.join(input.targetRoot, 'retained'), 'utf8')).toBe('prior')
})

it('fails offline when the pinned artifact is missing', async () => {
  const input = await fixture()
  await rm(input.artifact)
  await expect(stageLocalBrain(input)).rejects.toThrow()
})


it('staging alone supplies a valid unsigned development receipt and detects later drift', async () => {
  const input = await fixture()
  await stageLocalBrain(input)
  const receipt = await verifySignedLocalBrainReceipt(input)
  expect(receipt.signed).toEqual(receipt.original)
  await writeFile(path.join(input.targetRoot, 'bin', 'gbrain'), 'changed after seal')
  await expect(verifySignedLocalBrainReceipt(input)).rejects.toThrow('local_brain_package_invalid')
})

// The public source projection has no historical archive or signing authority.
it('verifies every retained public source member and refuses release preparation', async () => {
  const lock = await verifyLocalBrainSource()
  expect(lock.schema).toBe('atum.local-brain.public-source/1')
  expect(lock.commit).toBeUndefined()
  expect(lock.artifacts).toBeUndefined()
  await expect(prepareLocalBrain()).rejects.toThrow('local_brain_public_projection_not_release_artifact')
})
