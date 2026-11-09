import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type * as FsModule from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it, vi } from 'vitest'

import { EncryptedStore } from './encrypted-store'
import { migrateMatrixWorkspaceLayout } from './matrix/workspace-layout'
import { workspaceProcessProofPython } from './matrix/workspace-process.test-support'
import { readMatrixWorkspaceDriveRoots } from './matrix/workspace-root-facts'

// The real file system, with a write that can be made to fail the way a full disk does.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof FsModule>()

  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) }
})

// Test-only safeStorage, never consults the OS Keychain.
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString()
}

it('writes several entries in one file write, and none if one cannot be encrypted', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'encrypted-store-')), 'vault.json')
  const store = new EncryptedStore(path, safeStorage)
  store.setItem('kept', 'before')
  store.setItems({ a: '1', b: '2' })
  expect([store.getItem('a'), store.getItem('b'), store.getItem('kept')]).toEqual(['1', '2', 'before'])

  const failing = new EncryptedStore(path, {
    ...safeStorage,
    encryptString: (value: string) => {
      if (value === 'boom') {
        throw new Error('encrypt')
      }

      return Buffer.from(value)
    }
  })

  const before = readFileSync(path, 'utf8')
  expect(() => failing.setItems({ c: '3', d: 'boom' })).toThrow('auth_storage_encrypt_failed')
  expect(readFileSync(path, 'utf8')).toBe(before)
  expect(store.getItem('c')).toBeNull()
})

it("keeps a scope's entries apart and clears only them", () => {
  const path = join(mkdtempSync(join(tmpdir(), 'encrypted-store-')), 'vault.json')
  const root = new EncryptedStore(path, safeStorage)
  const alfred = root.scope('agent:alfred:')
  const bea = root.scope('agent:bea:')

  root.setItem('matrix-local-turns', 'default')
  alfred.setItem('matrix-local-turns', 'alfred')
  alfred.setItems({ 'matrix-outcome-1': 'a1', 'matrix-cron-pending': 'a2' })
  bea.setItem('matrix-local-turns', 'bea')

  // The same key, three separate entries; a view never reads another's.
  expect([root.getItem('matrix-local-turns'), alfred.getItem('matrix-local-turns'), bea.getItem('matrix-local-turns')]).toEqual([
    'default',
    'alfred',
    'bea'
  ])
  expect(root.getItem('matrix-outcome-1')).toBeNull()
  expect(bea.getItem('matrix-outcome-1')).toBeNull()

  // A scope's removeItem and clear touch only its own entries.
  bea.removeItem('matrix-outcome-1')
  expect(alfred.getItem('matrix-outcome-1')).toBe('a1')
  alfred.clear()
  expect([alfred.getItem('matrix-local-turns'), alfred.getItem('matrix-outcome-1'), alfred.getItem('matrix-cron-pending')]).toEqual([
    null,
    null,
    null
  ])
  expect([root.getItem('matrix-local-turns'), bea.getItem('matrix-local-turns')]).toEqual(['default', 'bea'])

  // Removing the default agent keeps every other agent's scope and the records named to keep.
  root.setItem('matrix-outcome-2', 'default outcome')
  root.setItem('matrix-agent-creations', '[]')
  root.clear('agent:')
  expect([root.getItem('matrix-local-turns'), root.getItem('matrix-outcome-2'), bea.getItem('matrix-local-turns')]).toEqual([
    null,
    null,
    'bea'
  ])
  root.setItem('matrix-agent-creations', '[1]')
  root.setItem('matrix-outcome-3', 'x')
  root.clear(['agent:', 'matrix-agent-creations'])
  expect([root.getItem('matrix-agent-creations'), root.getItem('matrix-outcome-3'), bea.getItem('matrix-local-turns')]).toEqual([
    '[1]',
    null,
    'bea'
  ])

  // The root's clear is sign-out: every scope goes with it.
  root.clear()
  expect(bea.getItem('matrix-local-turns')).toBeNull()
  expect(() => root.scope('')).toThrow('auth_storage_namespace_invalid')
})

it.each([
  ['ENOSPC', 'auth_storage_disk_full'],
  ['EDQUOT', 'auth_storage_disk_full'],
  ['EACCES', 'auth_storage_write_failed'],
  ['EIO', 'auth_storage_write_failed']
])('names a write that fails with %s %s, keeping what was saved', (errno, failure) => {
  const path = join(mkdtempSync(join(tmpdir(), 'encrypted-store-')), 'vault.json')
  const store = new EncryptedStore(path, safeStorage)
  store.setItem('kept', 'before')

  for (const write of [() => store.setItem('new', 'value'), () => store.setItems({ new: 'value' })]) {
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error(errno), { code: errno })
    })

    expect(write).toThrow(failure)
    expect(store.failureCode()).toBe(failure)
  }

  expect(store.getItem('kept')).toBe('before')
  expect(store.getItem('new')).toBeNull()
})

it('keys stay within a namespace, honor the prefix and neither decrypt nor write', () => {
  const folder = mkdtempSync(join(tmpdir(), 'encrypted-index-'))

  try {
    const file = join(folder, 'vault.json')
    const initial = new EncryptedStore(file, safeStorage)
    initial.setItems({ 'drive-root:default': 'one', unrelated: 'two', 'agent:one:drive-root:saved': 'three', 'agent:two:drive-root:saved': 'four' })
    const before = readFileSync(file)
    const decrypt = vi.fn(() => { throw new Error('must not decrypt') })
    const store = new EncryptedStore(file, { ...safeStorage, isEncryptionAvailable: () => false, decryptString: decrypt })
    expect(store.keys('drive-root:')).toEqual(['drive-root:default'])
    expect(store.scope('agent:one:').keys('drive-root:')).toEqual(['drive-root:saved'])
    expect(store.scope('agent:one:').keys()).toEqual(['drive-root:saved'])
    expect(decrypt).not.toHaveBeenCalled()
    expect(readFileSync(file)).toEqual(before)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

it('a missing key index is empty without writing; a corrupt one throws with a retained failure', () => {
  const folder = mkdtempSync(join(tmpdir(), 'encrypted-index-'))

  try {
    const file = join(folder, 'vault.json')
    const store = new EncryptedStore(file, safeStorage)
    expect(store.keys('drive-root:')).toEqual([])
    expect(store.failureCode()).toBeNull()
    expect(existsSync(file)).toBe(false)
    writeFileSync(file, '{synthetic invalid index')
    expect(() => store.keys('drive-root:')).toThrow(/^auth_storage_corrupt$/)
    expect(store.failureCode()).toBe('auth_storage_corrupt')
    expect(readFileSync(file, 'utf8')).toBe('{synthetic invalid index')
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('first upgrade protects every sealed Drive binding before identity/device hydration', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-first-upgrade-')))

  try {
    const legacy = join(home, 'Atum')
    const roots = [join(legacy, 'Old Account', 'Custom Drive'), join(legacy, 'Other Account', 'Files')]
    const userData = join(home, 'user-data')
    const sealedPath = join(userData, 'drive.json')
    const historyPath = join(userData, 'device', 'drive-roots.json')
    const store = new EncryptedStore(sealedPath, safeStorage)

    for (const [index, root] of roots.entries()) {
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, 'kept.txt'), `binding-${index}`)
      const stat = statSync(root)
      store.setItem(`drive-root:inactive-${index}`, JSON.stringify({ root, dev: stat.dev, ino: stat.ino }))
    }

    store.setItem('drive-root:disconnected', '')
    store.setItem('drive-auth:inactive', 'synthetic-unrelated-value')
    writeFileSync(join(legacy, 'work.txt'), 'ordinary-work')
    const before = readFileSync(sealedPath)
    const decrypt = vi.fn((value: Buffer) => value.toString())
    const bindingStore = new EncryptedStore(sealedPath, { ...safeStorage, decryptString: decrypt })
    const known = readMatrixWorkspaceDriveRoots(new EncryptedStore(historyPath, safeStorage), bindingStore)
    expect(new Set(known)).toEqual(new Set(roots))
    expect(decrypt.mock.calls.some(([value]) => value.toString() === 'synthetic-unrelated-value')).toBe(false)
    const python = execFileSync('python3', ['-I', '-B', '-S', '-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()

    const result = await migrateMatrixWorkspaceLayout({
      home, userData, python: workspaceProcessProofPython({ python, home }), quiescent: true, knownDriveRoots: known
    })

    expect(result.status).toBe('completed')

    for (const [index, root] of roots.entries()) {
      expect(readFileSync(join(root, 'kept.txt'), 'utf8')).toBe(`binding-${index}`)
      expect(existsSync(join(legacy, 'Workspace', index === 0 ? 'Old Account' : 'Other Account'))).toBe(false)
    }

    expect(readFileSync(join(legacy, 'Workspace', 'work.txt'), 'utf8')).toBe('ordinary-work')
    expect(readFileSync(sealedPath)).toEqual(before)
    expect(existsSync(historyPath)).toBe(false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

it.each(['corrupt-index', 'corrupt-binding', 'locked-binding'])('a first-upgrade %s defers before any migration and retains original bytes', async mode => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-first-upgrade-')))

  try {
    const legacy = join(home, 'Atum')
    const userData = join(home, 'user-data')
    const file = join(userData, 'drive.json')
    mkdirSync(legacy)
    writeFileSync(join(legacy, 'work.txt'), 'ordinary-work')
    const store = new EncryptedStore(file, safeStorage)
    store.setItem('drive-root:inactive', mode === 'corrupt-binding' ? '{private malformed binding' : JSON.stringify({ root: join(legacy, 'Custom Drive'), dev: 1, ino: 2 }))

    if (mode === 'corrupt-index') { writeFileSync(file, '{private malformed index') }
    const before = readFileSync(file)
    const reader = mode === 'locked-binding' ? new EncryptedStore(file, { ...safeStorage, decryptString: () => { throw new Error('keychain refused') } }) : store
    const migrate = vi.fn()
    await expect((async () => {
      const known = readMatrixWorkspaceDriveRoots(new EncryptedStore(join(userData, 'device', 'drive-roots.json'), safeStorage), reader)
      await migrate(known)
    })()).rejects.toThrow(/^workspace_layout_deferred$/)
    expect(migrate).not.toHaveBeenCalled()
    expect(readFileSync(join(legacy, 'work.txt'), 'utf8')).toBe('ordinary-work')
    expect(existsSync(join(legacy, 'Workspace'))).toBe(false)
    expect(existsSync(join(userData, 'workspace-layout.json'))).toBe(false)
    expect(readFileSync(file)).toEqual(before)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
