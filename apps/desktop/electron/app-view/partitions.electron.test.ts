import { expect, test } from 'vitest'

import { appViewPartition, discoverAppViewPartitions } from './partitions'

/**
 * R4 requires proving that Chromium's on-disk directory for a `persist:`
 * partition is what the sweep translates back to a partition name. That
 * needs a real Electron session (`session.getStoragePath()`), so this test
 * runs only under an Electron-hosted vitest run; under Node it is skipped
 * and the sweep's disk translation stays proven only by the unit fakes.
 */
test.skipIf(!process.versions.electron)('Electron stores an app-view partition where the sweep looks for it', async () => {
  const electron = await import('electron')
  const partition = appViewPartition('a'.repeat(64), 'moon')
  const target = electron.session.fromPartition(partition)
  const storagePath = target.getStoragePath()
  expect(storagePath).toBeTruthy()
  const userDataPath = electron.app.getPath('userData')
  expect(storagePath!.startsWith(`${userDataPath}/Partitions/`)).toBe(true)
  const { readdir } = await import('node:fs/promises')

  const found = await discoverAppViewPartitions({
    userDataPath,
    knownAppIds: [],
    readDirectory: async path => {
      try {
        return (await readdir(path, { withFileTypes: true })).map(entry => ({ name: entry.name, isDirectory: entry.isDirectory(), isSymbolicLink: entry.isSymbolicLink() }))
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') {return null}
        throw error
      }
    }
  })

  expect(found).toContain(partition)
})
