import assert from 'node:assert/strict'
import type * as NodeFs from 'node:fs'
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test, vi } from 'vitest'

import { AtumFilesystemCapabilityAuthority } from './atum-filesystem-capability'
import { AccountRootAuthority } from './atum-messaging'
import {
  commitAnchoredBinaryPublish,
  commitAnchoredTextWrite,
  fileIdentity,
  prepareAnchoredTextWrite,
  WorkspaceTextFileLeaseProvider,
  type WorkspaceTextFileRemoteTransport
} from './workspace-text-file-lease'

const ACCOUNT_A = '00000000-0000-4000-8000-bd7662a5eeb4'
const ACCOUNT_B = '00000000-0000-4000-8000-b454f82c5857'
const cleanups: string[] = []
const filesystem = vi.hoisted(() => ({ missingBirthtime: false }))

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof NodeFs>()

  return {
    ...fs,
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
      const stat = fs.lstatSync(...args)

      if (filesystem.missingBirthtime) {
        Object.defineProperty(stat, 'birthtimeMs', { value: 0 })
      }

      return stat
    }
  }
})

afterEach(() => {
  filesystem.missingBirthtime = false

  for (const directory of cleanups.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function harness(recovery?: ConstructorParameters<typeof WorkspaceTextFileLeaseProvider>[1]) {
  const userData = mkdtempSync(join(tmpdir(), 'atum-workspace-lease-'))
  cleanups.push(userData)
  const roots = new AccountRootAuthority(userData)
  const paths = roots.prepare(ACCOUNT_A)
  roots.commit(ACCOUNT_A, 7)
  const authority = new AtumFilesystemCapabilityAuthority()
  authority.activateAccount({ accountId: ACCOUNT_A, generation: 7, paths })

  return { authority, paths, provider: new WorkspaceTextFileLeaseProvider(authority, recovery), roots }
}

test('Markdown remains revision-writable when filesystem birth time cannot support recovery', async () => {
  filesystem.missingBirthtime = true
  const prepareFileReplacement = vi.fn()
  const { paths, provider } = harness({ prepareFileReplacement })
  const target = join(paths.workspaceRoot, 'note.md')
  writeFileSync(target, 'original')
  const lease = provider.openLocal(target, { workspaceRelativePath: 'note.md' })
  const first = await provider.read(lease.fileRef)
  assert.throws(() => provider.resolveDocumentRecoveryLease(lease.fileRef), /DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE/u)
  const saved = await provider.write(lease.fileRef, { expectedRevision: first.revision, text: 'explicit save' })
  assert.equal(readFileSync(target, 'utf8'), 'explicit save')
  assert.equal(prepareFileReplacement.mock.calls.length, 0)
  writeFileSync(target, 'external')
  await assert.rejects(provider.write(lease.fileRef, { expectedRevision: saved.revision, text: 'stale' }), /WORKSPACE_CONFLICT/u)
  assert.equal(readFileSync(target, 'utf8'), 'external')
})

test('recovery degradation does not swallow authority failures before publication', async () => {
  const { paths, provider } = harness({ prepareFileReplacement: () => { throw new Error('CAPABILITY_STALE') } })
  const target = join(paths.workspaceRoot, 'note.md')
  writeFileSync(target, 'original')
  const lease = provider.openLocal(target, { workspaceRelativePath: 'note.md' })
  const first = await provider.read(lease.fileRef)
  await assert.rejects(provider.write(lease.fileRef, { expectedRevision: first.revision, text: 'refused' }), /CAPABILITY_STALE/u)
  assert.equal(readFileSync(target, 'utf8'), 'original')
})

test('stable opaque local lease repeats reads and revision-fences atomic writes', async () => {
  const { paths, provider } = harness()
  const target = join(paths.workspaceRoot, 'private.txt')
  writeFileSync(target, 'one')
  const lease = provider.openLocal(target)

  assert.equal(JSON.stringify(lease).includes(target), false)
  const first = await provider.read(lease.fileRef)
  assert.deepEqual(await provider.read(lease.fileRef), first)
  const written = await provider.write(lease.fileRef, { expectedRevision: first.revision, text: 'two' })
  assert.equal((await provider.read(lease.fileRef)).text, 'two')
  assert.notEqual(written.revision, first.revision)

  writeFileSync(target, 'external')
  await assert.rejects(
    provider.write(lease.fileRef, { expectedRevision: written.revision, text: 'lost' }),
    /WORKSPACE_CONFLICT/u
  )
  assert.equal(readFileSync(target, 'utf8'), 'external')
})

test('exclusive create publish maps an EEXIST race to conflict without overwrite', () => {
  const { paths } = harness()
  const target = join(paths.workspaceRoot, 'raced.txt')
  const plan = prepareAnchoredTextWrite(target)

  assert.throws(
    () =>
      commitAnchoredTextWrite(plan, 'assistant', {
        link: (temporary, destination) => {
          writeFileSync(destination, 'racer')
          linkSync(temporary, destination)
        }
      }),
    /WORKSPACE_CONFLICT/u
  )
  assert.equal(readFileSync(target, 'utf8'), 'racer')
})

test('local read rejects oversized content before unbounded allocation', async () => {
  const { paths, provider } = harness()
  const target = join(paths.workspaceRoot, 'large.txt')
  writeFileSync(target, Buffer.alloc(1024 * 1024 + 1, 0x61))
  const lease = provider.openLocal(target)

  await assert.rejects(provider.read(lease.fileRef), /WORKSPACE_FILE_TOO_LARGE/u)
})

test('preserve sibling is exclusive, never overwrites a collision, and accepts a stale observed base', async () => {
  const { paths, provider } = harness()
  const target = join(paths.workspaceRoot, 'draft.md')
  writeFileSync(target, 'base')
  writeFileSync(join(paths.workspaceRoot, 'draft (preserved).md'), 'keep')
  const lease = provider.openLocal(target)
  const base = await provider.read(lease.fileRef)
  writeFileSync(target, 'changed elsewhere')

  const rescue = await provider.preserveSibling(lease.fileRef, {
    expectedRevision: base.revision,
    text: 'my dirty draft'
  })

  assert.equal(rescue.displayName, 'draft (preserved 2).md')
  assert.equal(readFileSync(join(paths.workspaceRoot, 'draft (preserved).md'), 'utf8'), 'keep')
  assert.equal(readFileSync(join(paths.workspaceRoot, rescue.displayName), 'utf8'), 'my dirty draft')
  assert.equal(readFileSync(target, 'utf8'), 'changed elsewhere')
})

test('preserve sibling rejects replacement of its anchored parent directory', async () => {
  const { paths, provider } = harness()
  const parent = join(paths.workspaceRoot, 'anchored')
  mkdirSync(parent)
  const target = join(parent, 'draft.txt')
  writeFileSync(target, 'base')
  const lease = provider.openLocal(target)
  const snapshot = await provider.read(lease.fileRef)
  renameSync(parent, `${parent}-moved`)
  mkdirSync(parent)

  await assert.rejects(
    provider.preserveSibling(lease.fileRef, { expectedRevision: snapshot.revision, text: 'dirty' }),
    /CAPABILITY_SCOPE_ESCAPE/u
  )
})

test('leases fail closed after account rotation, release, path symlink, and unobserved revisions', async () => {
  const { authority, paths, provider, roots } = harness()
  const target = join(paths.workspaceRoot, 'note.txt')
  const outside = join(paths.root, 'outside.txt')
  writeFileSync(target, 'inside')
  writeFileSync(outside, 'outside')
  const lease = provider.openLocal(target)

  await assert.rejects(
    provider.write(lease.fileRef, { expectedRevision: 'sha256:spoofed', text: 'no' }),
    /WORKSPACE_CONFLICT/u
  )
  rmSync(target)
  symlinkSync(outside, target)
  await assert.rejects(provider.read(lease.fileRef), /CAPABILITY_SCOPE_ESCAPE/u)

  rmSync(target)
  writeFileSync(target, 'restored')
  authority.revokeAccount({ accountId: ACCOUNT_A, accountGeneration: 7 })
  const pathsB = roots.prepare(ACCOUNT_B)
  roots.commit(ACCOUNT_B, 8)
  authority.activateAccount({ accountId: ACCOUNT_B, generation: 8, paths: pathsB })
  await assert.rejects(provider.read(lease.fileRef), /CAPABILITY_STALE/u)

  const targetB = join(pathsB.workspaceRoot, 'b.txt')
  writeFileSync(targetB, 'b')
  const leaseB = provider.openLocal(targetB)
  await provider.release(leaseB.fileRef)
  await assert.rejects(provider.read(leaseB.fileRef), /CAPABILITY_REVOKED/u)
})

test('remote custody keeps backend path behind nested opaque ids and forwards fenced operations', async () => {
  const { provider } = harness()
  const calls: Array<{ name: string; value?: unknown }> = []

  const transport: WorkspaceTextFileRemoteTransport = {
    open: async value => {
      calls.push({ name: 'open', value })

      return { leaseId: 'backend-opaque', displayName: 'remote.txt' }
    },
    read: async value => {
      calls.push({ name: 'read', value })

      return { revision: 'sha256:remote-one', text: 'remote', truncated: false }
    },
    write: async (value, input) => {
      calls.push({ name: 'write', value: { input, value } })

      return { revision: 'sha256:remote-two' }
    },
    preserveSibling: async (value, input) => {
      calls.push({ name: 'preserve', value: { input, value } })

      return { displayName: 'remote (preserved).txt' }
    },
    release: async value => {
      calls.push({ name: 'release', value })
    }
  }

  const lease = await provider.openRemote('/remote/secret/path.txt', transport)

  assert.equal(JSON.stringify(lease).includes('/remote/'), false)
  const snapshot = await provider.read(lease.fileRef)
  await provider.write(lease.fileRef, { expectedRevision: snapshot.revision, text: 'next' })
  await provider.preserveSibling(lease.fileRef, { expectedRevision: snapshot.revision, text: 'rescue' })
  await provider.release(lease.fileRef)
  assert.deepEqual(
    calls.map(call => call.name),
    ['open', 'read', 'write', 'preserve', 'release']
  )
})

test('account quiescence releases remote custody and invalidates local leases before reuse', async () => {
  const { provider } = harness()
  let released = false

  const transport: WorkspaceTextFileRemoteTransport = {
    open: async () => ({ leaseId: 'backend-account-bound', displayName: 'remote.txt' }),
    read: async () => ({ revision: 'sha256:r', text: 'x', truncated: false }),
    write: async () => ({ revision: 'sha256:w' }),
    preserveSibling: async () => ({ displayName: 'remote (preserved).txt' }),
    release: async () => {
      released = true
    }
  }

  const lease = await provider.openRemote('/remote/secret.txt', transport)

  await provider.revokeAccount({ accountId: ACCOUNT_A, accountGeneration: 7 })

  assert.equal(released, true)
  await assert.rejects(provider.read(lease.fileRef), /CAPABILITY_REVOKED/u)
})

test('remote results fail closed when account revocation wins an in-flight operation', async () => {
  const { provider } = harness()
  let resolveWrite!: (value: { revision: string }) => void

  const pendingWrite = new Promise<{ revision: string }>(resolve => {
    resolveWrite = resolve
  })

  const transport: WorkspaceTextFileRemoteTransport = {
    open: async () => ({ leaseId: 'backend-account-bound', displayName: 'remote.txt' }),
    read: async () => ({ revision: 'sha256:r', text: 'x', truncated: false }),
    write: async () => pendingWrite,
    preserveSibling: async () => ({ displayName: 'remote (preserved).txt' }),
    release: async () => undefined
  }

  const lease = await provider.openRemote('/remote/secret.txt', transport)
  const snapshot = await provider.read(lease.fileRef)
  const write = provider.write(lease.fileRef, { expectedRevision: snapshot.revision, text: 'next' })
  const revoke = provider.revokeAccount({ accountId: ACCOUNT_A, accountGeneration: 7 })
  resolveWrite({ revision: 'sha256:w' })

  await assert.rejects(write, /CAPABILITY_REVOKED/u)
  await revoke
})

test('export source accepts only a live anchored workspace Markdown lease', async () => {
  const { authority, paths, provider } = harness()
  const markdown = join(paths.workspaceRoot, 'Tài liệu 1.md')
  writeFileSync(markdown, '# Xin chào')
  const workspace = provider.openLocal(markdown, { workspaceRelativePath: 'Tài liệu 1.md' })
  assert.equal(provider.resolveLocalWorkspaceExportSource(workspace.fileRef).displayName, 'Tài liệu 1.md')

  const picker = provider.openLocal(markdown)
  assert.throws(() => provider.resolveLocalWorkspaceExportSource(picker.fileRef), /EXPORT_NOT_WORKSPACE_DOCUMENT/u)
  const textPath = join(paths.workspaceRoot, 'note.txt')
  writeFileSync(textPath, 'x')
  const textLease = provider.openLocal(textPath, { workspaceRelativePath: 'note.txt' })
  assert.throws(() => provider.resolveLocalWorkspaceExportSource(textLease.fileRef), /EXPORT_NOT_WORKSPACE_DOCUMENT/u)

  const remote = await provider.openRemote('/remote/note.md', {
    open: async () => ({ leaseId: 'r', displayName: 'note.md' }),
    read: async () => ({ revision: 'r', text: '', truncated: false }),
    write: async () => ({ revision: 'r' }),
    preserveSibling: async () => ({ displayName: 'x' }),
    release: async () => undefined
  })

  assert.throws(() => provider.resolveLocalWorkspaceExportSource(remote.fileRef), /EXPORT_NOT_WORKSPACE_DOCUMENT/u)
  await provider.release(workspace.fileRef)
  assert.throws(() => provider.resolveLocalWorkspaceExportSource(workspace.fileRef), /CAPABILITY_REVOKED/u)
  authority.revokeAccount({ accountId: ACCOUNT_A, accountGeneration: 7 })
  assert.throws(() => provider.resolveLocalWorkspaceExportSource(textLease.fileRef), /CAPABILITY_STALE/u)
})

test('binary publication is exclusive, collision-numbered, and anchored', () => {
  const { paths } = harness()
  const canonicalParent = realpathSync(paths.workspaceRoot)
  const parent = { canonicalParent, parentIdentity: fileIdentity(statSync(canonicalParent)) }
  writeFileSync(join(paths.workspaceRoot, 'Tài liệu 1.docx'), 'foreign')
  const first = commitAnchoredBinaryPublish(parent, 'Tài liệu 1.docx', new Uint8Array([1, 2]), { maxBytes: 10 })
  const second = commitAnchoredBinaryPublish(parent, 'Tài liệu 1.docx', new Uint8Array([3]), { maxBytes: 10 })
  assert.equal(first.displayName, 'Tài liệu 1 (2).docx')
  assert.equal(second.displayName, 'Tài liệu 1 (3).docx')
  assert.equal(readFileSync(join(paths.workspaceRoot, 'Tài liệu 1.docx'), 'utf8'), 'foreign')

  const moved = `${paths.workspaceRoot}-moved`
  renameSync(paths.workspaceRoot, moved)
  mkdirSync(paths.workspaceRoot)
  assert.throws(
    () => commitAnchoredBinaryPublish(parent, 'x.docx', new Uint8Array([1]), { maxBytes: 10 }),
    /CAPABILITY_SCOPE_ESCAPE/u
  )
})

test('DOCX and PDF remain outside text lease custody and unsafe publication targets fail closed', () => {
  const { paths, provider } = harness()
  const docx = join(paths.workspaceRoot, 'private.docx')
  writeFileSync(docx, 'foreign')
  assert.throws(() => provider.openLocal(docx, { workspaceRelativePath: 'private.docx' }), /CAPABILITY_DENIED/u)
  const pdf = join(paths.workspaceRoot, 'private.pdf')
  writeFileSync(pdf, 'foreign')
  assert.throws(() => provider.openLocal(pdf, { workspaceRelativePath: 'private.pdf' }), /CAPABILITY_DENIED/u)

  const canonicalParent = realpathSync(paths.workspaceRoot)
  const parent = { canonicalParent, parentIdentity: fileIdentity(statSync(canonicalParent)) }
  symlinkSync(join(paths.workspaceRoot, 'private.docx'), join(paths.workspaceRoot, 'linked.docx'))
  assert.throws(
    () => commitAnchoredBinaryPublish(parent, 'linked.docx', new Uint8Array([1]), { maxBytes: 10 }),
    /CAPABILITY_SCOPE_ESCAPE/u
  )
  writeFileSync(join(paths.workspaceRoot, 'full.docx'), 'one')
  assert.throws(
    () => commitAnchoredBinaryPublish(parent, 'full.docx', new Uint8Array([1]), { maxBytes: 10, maxOrdinal: 1 }),
    /EXPORT_PUBLISH_FAILED/u
  )
})
