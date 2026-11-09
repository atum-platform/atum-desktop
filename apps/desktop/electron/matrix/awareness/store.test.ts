import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { expect, test } from 'vitest'

import { awarenessFileStore } from './store'

const maxStoreBytes = 16 * 1024 * 1024
const unixTest = process.platform === 'win32' ? test.skip : test

async function inPrivateTemporaryDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'atum-awareness-store-'))

  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

unixTest('returns null for a fresh missing store and creates a private directory', async () => {
  await inPrivateTemporaryDirectory(async root => {
    const file = path.join(root, 'account', 'awareness.json')

    await expect(awarenessFileStore(file).read()).resolves.toBeNull()
    expect((await lstat(path.dirname(file))).mode & 0o777).toBe(0o700)
  })
})

unixTest('atomically replaces metadata and retains a 0600 store file', async () => {
  await inPrivateTemporaryDirectory(async root => {
    const file = path.join(root, 'account', 'awareness.json')
    const store = awarenessFileStore(file)

    await store.write({ receipt: 'first' })
    await store.write({ receipt: 'replacement' })

    await expect(store.read()).resolves.toEqual({ receipt: 'replacement' })
    expect((await lstat(file)).mode & 0o777).toBe(0o600)
    expect(await readdir(path.dirname(file))).toEqual(['awareness.json'])
  })
})

unixTest('rejects corrupted JSON instead of resetting the metadata', async () => {
  await inPrivateTemporaryDirectory(async root => {
    const directory = path.join(root, 'account')
    const file = path.join(directory, 'awareness.json')
    await mkdir(directory, { mode: 0o700 })
    await writeFile(file, '{ definitely not json', { mode: 0o600 })

    await expect(awarenessFileStore(file).read()).rejects.toThrow('awareness_store_invalid')
    await expect(readFile(file, 'utf8')).resolves.toBe('{ definitely not json')
  })
})

unixTest('refuses a broadly readable store file', async () => {
  await inPrivateTemporaryDirectory(async root => {
    const directory = path.join(root, 'account')
    const file = path.join(directory, 'awareness.json')
    await mkdir(directory, { mode: 0o700 })
    await writeFile(file, '{"receipt":"private"}', { mode: 0o600 })
    await chmod(file, 0o644)

    await expect(awarenessFileStore(file).read()).rejects.toThrow('awareness_store_invalid')
  })
})

unixTest('refuses a broadly accessible directory without changing its mode', async () => {
  await inPrivateTemporaryDirectory(async root => {
    const directory = path.join(root, 'shared-account')
    const file = path.join(directory, 'awareness.json')
    await mkdir(directory, { mode: 0o755 })
    await chmod(directory, 0o755)

    await expect(awarenessFileStore(file).read()).rejects.toThrow('awareness_store_directory_not_private')
    expect((await lstat(directory)).mode & 0o777).toBe(0o755)
  })
})

unixTest('refuses a symlink on read and replaces it on write without modifying its target', async () => {
  await inPrivateTemporaryDirectory(async root => {
    const directory = path.join(root, 'account')
    const file = path.join(directory, 'awareness.json')
    const target = path.join(root, 'outside.json')
    await mkdir(directory, { mode: 0o700 })
    await writeFile(target, '{"outside":true}', { mode: 0o600 })
    await symlink(target, file)
    const store = awarenessFileStore(file)

    await expect(store.read()).rejects.toThrow('awareness_store_unavailable')
    await store.write({ receipt: 'owned' })

    await expect(readFile(target, 'utf8')).resolves.toBe('{"outside":true}')
    expect((await lstat(file)).isSymbolicLink()).toBe(false)
    await expect(store.read()).resolves.toEqual({ receipt: 'owned' })
  })
})

unixTest('refuses a symlinked store directory', async () => {
  await inPrivateTemporaryDirectory(async root => {
    const target = path.join(root, 'target-directory')
    const directory = path.join(root, 'linked-directory')
    await mkdir(target, { mode: 0o700 })
    await symlink(target, directory, 'dir')

    await expect(awarenessFileStore(path.join(directory, 'awareness.json')).read()).rejects.toThrow(
      'awareness_store_directory_not_private'
    )
  })
})

test('refuses a relative store path', () => {
  expect(() => awarenessFileStore('account/awareness.json')).toThrow('awareness_store_invalid')
})

unixTest('bounds oversized reads without creating a large file payload', async () => {
  await inPrivateTemporaryDirectory(async root => {
    const directory = path.join(root, 'account')
    const file = path.join(directory, 'awareness.json')
    await mkdir(directory, { mode: 0o700 })
    const handle = await open(file, constants.O_CREAT | constants.O_WRONLY, 0o600)

    try {
      await handle.truncate(maxStoreBytes + 1)
    } finally {
      await handle.close()
    }

    expect((await lstat(file)).size).toBe(maxStoreBytes + 1)
    await expect(awarenessFileStore(file).read()).rejects.toThrow('awareness_store_invalid')
  })
})

unixTest('bounds oversized writes before creating the destination file', async () => {
  await inPrivateTemporaryDirectory(async root => {
    const file = path.join(root, 'account', 'awareness.json')
    const value = { receipt: 'x'.repeat(maxStoreBytes) }

    await expect(awarenessFileStore(file).write(value)).rejects.toThrow('awareness_store_full')
    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

unixTest('does not select an interrupted temporary file as the store', async () => {
  await inPrivateTemporaryDirectory(async root => {
    const file = path.join(root, 'account', 'awareness.json')
    const store = awarenessFileStore(file)
    await store.write({ receipt: 'durable' })
    const interrupted = path.join(path.dirname(file), '.awareness.json.interrupted.tmp')
    await writeFile(interrupted, '{ incomplete', { mode: 0o600 })

    await expect(store.read()).resolves.toEqual({ receipt: 'durable' })
    await expect(readFile(interrupted, 'utf8')).resolves.toBe('{ incomplete')
  })
})
