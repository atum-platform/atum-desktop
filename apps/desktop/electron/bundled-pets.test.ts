import assert from 'node:assert/strict'

import { test } from 'vitest'

import { bundledPetsCandidates, resolveBundledPetsDir, unpackedRoot } from './bundled-pets'

test('a packaged app prefers the unpacked pets, the copy a Python process can read', () => {
  const appRoot = '/Applications/Atum.app/Contents/Resources/app.asar'
  const unpacked = '/Applications/Atum.app/Contents/Resources/app.asar.unpacked/assets/pets'
  const inAsar = '/Applications/Atum.app/Contents/Resources/app.asar/assets/pets'

  assert.deepEqual(bundledPetsCandidates(appRoot), [unpacked, inAsar])
  // Electron says both exist; the unpacked one wins.
  assert.equal(resolveBundledPetsDir(appRoot, () => true), unpacked)
  // Not unpacked: fall back to the asar path (Electron can still seed from it).
  assert.equal(resolveBundledPetsDir(appRoot, candidate => candidate === inAsar), inAsar)
  assert.equal(resolveBundledPetsDir(appRoot, () => false), undefined)
})

test('a dev checkout has one candidate', () => {
  assert.deepEqual(bundledPetsCandidates('/work/apps/desktop'), ['/work/apps/desktop/assets/pets'])
})

test('the archive is the last app.asar segment, not a parent directory named like one', () => {
  assert.equal(unpackedRoot('/home/example/app.asar/Atum.app/Contents/Resources/app.asar'), '/home/example/app.asar/Atum.app/Contents/Resources/app.asar.unpacked')
  assert.equal(unpackedRoot('C:\\apps\\Atum\\resources\\app.asar'), 'C:\\apps\\Atum\\resources\\app.asar.unpacked')
  assert.equal(unpackedRoot('/work/app.asar.unpacked/inner'), '/work/app.asar.unpacked/inner', 'already unpacked stays')
  assert.equal(unpackedRoot('/work/my-app.asar-ish/x'), '/work/my-app.asar-ish/x', 'only a whole segment counts')
})
