import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { matrixDriveBundleHash, selectMatrixDriveEngine } from './drive-engine'

const fixtures: string[] = []
afterEach(() => {
  for (const file of fixtures.splice(0)) {
    rmSync(file, { recursive: true, force: true })
  }
})

function fixture() {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'atum-drive-artifact-')))
  fixtures.push(home)
  const bundle = path.join(home, 'Engine.app')
  mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(path.join(bundle, 'Contents', 'Frameworks'))
  const binary = path.join(bundle, 'Contents', 'MacOS', 'engine')
  const library = path.join(bundle, 'Contents', 'Frameworks', 'sync.dylib')
  writeFileSync(binary, 'launcher')
  writeFileSync(library, 'sync library')
  const manifest = path.join(home, 'manifest.json')
  const value = {
    protocol: 1,
    binary: 'Engine.app/Contents/MacOS/engine',
    issuer: 'https://auth.test/',
    origin: 'https://drive.test',
    sha256: createHash('sha256').update('launcher').digest('hex'),
    bundleSha256: matrixDriveBundleHash(bundle)
  }
  writeFileSync(manifest, JSON.stringify(value))

  return { home, bundle, binary, library, manifest, value }
}

it('checks dependency bytes as well as the launcher before selecting an engine', () => {
  const f = fixture()
  expect(selectMatrixDriveEngine(f.manifest, f.value.issuer).binary).toBe(f.binary)
  writeFileSync(f.library, 'replaced library')
  expect(() => selectMatrixDriveEngine(f.manifest, f.value.issuer)).toThrow('matrix_drive_engine_invalid')
})

it('rejects an escaping library symlink and a foreign issuer', () => {
  const f = fixture()
  expect(() => selectMatrixDriveEngine(f.manifest, 'https://foreign.test/')).toThrow()
  const outside = path.join(f.home, 'outside')
  writeFileSync(outside, 'external library')
  symlinkSync(outside, path.join(f.bundle, 'Contents', 'Frameworks', 'escaped.dylib'))
  expect(() => matrixDriveBundleHash(f.bundle)).toThrow('matrix_drive_engine_invalid')
})

it('reports malformed manifests and dangling libraries with the bounded engine failure code', () => {
  const f = fixture()
  writeFileSync(f.manifest, JSON.stringify({ ...f.value, origin: 'not a url' }))
  expect(() => selectMatrixDriveEngine(f.manifest, f.value.issuer)).toThrow('matrix_drive_engine_invalid')
  writeFileSync(f.manifest, 'broken json')
  expect(() => selectMatrixDriveEngine(f.manifest, f.value.issuer)).toThrow('matrix_drive_engine_invalid')
  symlinkSync(path.join(f.home, 'missing'), path.join(f.bundle, 'Contents', 'Frameworks', 'dangling.dylib'))
  expect(() => matrixDriveBundleHash(f.bundle)).toThrow('matrix_drive_engine_invalid')
})
