import assert from 'node:assert/strict'
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import {
  AtumDocumentRecoveryJournal,
  DOCUMENT_RECOVERY_MAX_RECORD_BYTES,
  type DocumentRecoveryLease
} from './atum-document-recovery'
import { AtumFilesystemCapabilityAuthority } from './atum-filesystem-capability'
import { AccountRootAuthority } from './atum-messaging'
import { WorkspaceTextFileLeaseProvider } from './workspace-text-file-lease'

const ACCOUNT_A = '00000000-0000-4000-8000-bd7662a5eeb4'
const ACCOUNT_B = '00000000-0000-4000-8000-b454f82c5857'
const cleanups: string[] = []

afterEach(() => {
  for (const directory of cleanups.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function setup() {
  const userData = mkdtempSync(join(tmpdir(), 'atum-document-recovery-'))
  cleanups.push(userData)
  const roots = new AccountRootAuthority(userData)
  const paths = roots.prepare(ACCOUNT_A)
  roots.commit(ACCOUNT_A, 3)
  const authority = new AtumFilesystemCapabilityAuthority()
  authority.activateAccount({ accountId: ACCOUNT_A, generation: 3, paths })
  const leases = new Map<string, DocumentRecoveryLease>()

  const addLease = (fileRef: string, documentId: string, workspaceRelativePath = `${documentId}.md`) => {
    const account = authority.currentAuthority()!.account
    leases.set(fileRef, { account, fileIdentity: documentId, workspaceRelativePath })
  }

  addLease('lease-one', 'doc-one', 'notes/one.md')
  addLease('lease-two', 'doc-two', 'notes/two.md')

  const journal = new AtumDocumentRecoveryJournal(
    authority,
    fileRef => {
      const lease = leases.get(fileRef)

      if (!lease) {
        throw new Error('lease_missing')
      }

      return lease
    },
    { journalRootFor: account => join(roots.pathsForAccount(account.accountId).root, 'document-recovery') }
  )

  return { addLease, authority, journal, leases, paths, roots, userData }
}

function writeInput(expectedDraftRevision: string | null, text = 'unsaved text') {
  return { baseRevision: 'sha256:disk-base', editorRevision: 'editor-1', expectedDraftRevision, text }
}

test('writes one private atomic draft and recovers it only through its live lease', async () => {
  const { journal, paths } = setup()
  const saved = await journal.write('lease-one', writeInput(null, 'Bản nháp chưa lưu'))
  assert.equal(saved.outcome, 'saved')

  if (saved.outcome !== 'saved') {
    return
  }

  assert.equal(saved.record.baseRevision, 'sha256:disk-base')
  assert.equal(saved.record.workspaceRelativePath, 'notes/one.md')
  assert.equal((await journal.read('lease-one')).outcome, 'present')
  const recovered = await journal.read('lease-one')
  assert.deepEqual(recovered, { outcome: 'present', record: saved.record })

  const directory = join(paths.root, 'document-recovery')
  const names = readdirSync(directory)
  assert.equal(names.length, 1)
  assert.match(names[0], /^[a-f0-9]{64}\.json$/u)
  assert.equal(statSync(directory).mode & 0o777, 0o700)
  assert.equal(statSync(join(directory, names[0])).mode & 0o777, 0o600)
})

test('a delayed save acknowledgement cannot discard a newer draft, and duplicate windows are compare-and-swap fenced', async () => {
  const { journal } = setup()
  const first = await journal.write('lease-one', writeInput(null, 'first'))
  assert.equal(first.outcome, 'saved')

  if (first.outcome !== 'saved') {
    return
  }

  const newer = await journal.write('lease-one', writeInput(first.record.draftRevision, 'newer'))
  assert.equal(newer.outcome, 'saved')

  if (newer.outcome !== 'saved') {
    return
  }

  assert.equal(newer.record.baseRevision, 'sha256:disk-base')
  const lateAck = await journal.discard('lease-one', first.record.draftRevision)
  assert.deepEqual(lateAck, { outcome: 'stale', record: newer.record })

  const staleWriter = await journal.write('lease-one', writeInput(first.record.draftRevision, 'clobber attempt'))
  assert.deepEqual(staleWriter, { outcome: 'stale', record: newer.record })
  assert.deepEqual(await journal.read('lease-one'), { outcome: 'present', record: newer.record })
})

test('account switch blocks recovery and writes, while reauthentication to the original stable account recovers its private draft', async () => {
  const { addLease, authority, journal, roots } = setup()
  const saved = await journal.write('lease-one', writeInput(null))
  assert.equal(saved.outcome, 'saved')

  const pathsB = roots.prepare(ACCOUNT_B)
  roots.commit(ACCOUNT_B, 4)
  authority.activateAccount({ accountId: ACCOUNT_B, generation: 4, paths: pathsB })
  await assert.rejects(journal.read('lease-one'), /DOCUMENT_RECOVERY_ACCESS_REVOKED/u)
  await assert.rejects(journal.write('lease-one', writeInput(null)), /DOCUMENT_RECOVERY_ACCESS_REVOKED/u)

  const pathsA = roots.prepare(ACCOUNT_A)
  roots.commit(ACCOUNT_A, 5)
  authority.activateAccount({ accountId: ACCOUNT_A, generation: 5, paths: pathsA })
  addLease('lease-one-reopened', 'doc-one', 'notes/one.md')
  const recovered = await journal.read('lease-one-reopened')
  assert.equal(recovered.outcome, 'present')

  if (recovered.outcome === 'present') {
    assert.equal(recovered.record.text, 'unsaved text')
  }
})

test('fails closed for a symlinked journal root and never follows a record symlink', async () => {
  const { journal, paths, userData } = setup()
  await journal.write('lease-one', writeInput(null))
  const directory = join(paths.root, 'document-recovery')
  const recordPath = join(directory, readdirSync(directory)[0])
  const outside = join(userData, 'outside.json')
  writeFileSync(outside, '{"outside":true}')
  unlinkSync(recordPath)
  symlinkSync(outside, recordPath)
  await assert.rejects(journal.read('lease-one'), /DOCUMENT_RECOVERY_CORRUPT/u)

  rmSync(directory, { force: true, recursive: true })
  symlinkSync(userData, directory)
  await assert.rejects(journal.write('lease-one', writeInput(null)), /DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE/u)
  assert.equal(lstatSync(outside).isFile(), true)
})

test('corruption and bounded byte/file quotas preserve the acknowledged draft without automatic eviction', async () => {
  const { authority, journal, paths, roots } = setup()
  const first = await journal.write('lease-one', writeInput(null, 'keep this recovery copy'))
  assert.equal(first.outcome, 'saved')
  const root = join(paths.root, 'document-recovery')
  const recordPath = join(root, readdirSync(root)[0])
  writeFileSync(recordPath, '{not-json')
  await assert.rejects(journal.read('lease-one'), /DOCUMENT_RECOVERY_CORRUPT/u)

  // A clean journal with a one-record quota refuses a second document and
  // leaves the acknowledged first record intact for recovery.
  const quotaRoot = join(paths.root, 'quota-recovery')

  const quota = new AtumDocumentRecoveryJournal(
    authority,
    fileRef => ({
      account: authority.currentAuthority()!.account,
      fileIdentity: fileRef,
      workspaceRelativePath: `${fileRef}.md`
    }),
    { journalRootFor: () => quotaRoot, maxRecords: 1, maxTotalBytes: DOCUMENT_RECOVERY_MAX_RECORD_BYTES }
  )

  const quotaFirst = await quota.write('quota-one', writeInput(null, 'sole draft'))
  assert.equal(quotaFirst.outcome, 'saved')
  await assert.rejects(
    quota.write('quota-two', writeInput(null, 'must not evict')),
    /DOCUMENT_RECOVERY_QUOTA_EXCEEDED/u
  )
  assert.equal((await quota.read('quota-one')).outcome, 'present')

  const tooSmall = new AtumDocumentRecoveryJournal(
    authority,
    fileRef => ({
      account: authority.currentAuthority()!.account,
      fileIdentity: fileRef,
      workspaceRelativePath: `${fileRef}.md`
    }),
    { journalRootFor: () => join(roots.pathsForAccount(ACCOUNT_A).root, 'small-recovery'), maxRecordBytes: 64 }
  )

  await assert.rejects(tooSmall.write('tiny', writeInput(null, 'x'.repeat(100))), /DOCUMENT_RECOVERY_RECORD_TOO_LARGE/u)
})

// Exercise actual filesystem identity across services recreated as at restart.
test('real files retain one opaque draft through rename and atomic save; path reuse cannot inherit it', async () => {
  const { authority, paths } = setup()

  const makeServices = () => {
    const provider = new WorkspaceTextFileLeaseProvider(authority, {
      prepareFileReplacement: (ref, identity) => recovery.prepareFileReplacement(ref, identity)
    })

    const recovery = new AtumDocumentRecoveryJournal(authority, ref => provider.resolveDocumentRecoveryLease(ref), {
      journalRootFor: () => join(paths.root, 'real-recovery')
    })

    return { provider, recovery }
  }

  let { provider, recovery } = makeServices()
  const a = join(paths.workspaceRoot, 'a.md')
  const b = join(paths.workspaceRoot, 'b.md')
  writeFileSync(a, 'base')
  let ref = provider.openLocal(a, { workspaceRelativePath: 'a.md' }).fileRef
  const base = await provider.read(ref)
  const saved = await recovery.write(ref, { ...writeInput(null, 'unsaved work'), baseRevision: base.revision })

  if (saved.outcome !== 'saved') {
    throw new Error('expected save')
  }

  const identity = saved.record.documentId
  renameSync(a, b)
  writeFileSync(a, 'unrelated new file')
  ;({ provider, recovery } = makeServices())
  assert.equal(
    (await recovery.read(provider.openLocal(a, { workspaceRelativePath: 'a.md' }).fileRef)).outcome,
    'absent'
  )
  ref = provider.openLocal(b, { workspaceRelativePath: 'b.md' }).fileRef
  const renamed = await recovery.read(ref)
  assert.equal(renamed.record?.documentId, identity)
  assert.equal(renamed.record?.workspaceRelativePath, 'b.md')
  assert.equal(renamed.record?.text, 'unsaved work')
  const disk = await provider.read(ref)
  await provider.write(ref, { expectedRevision: disk.revision, text: 'unsaved work' })
  assert.equal(provider.resolveLocalWorkspaceExportSource(ref).workspaceRelativePath, 'b.md')
  ;({ provider, recovery } = makeServices())
  ref = provider.openLocal(b, { workspaceRelativePath: 'b.md' }).fileRef
  const afterSave = await recovery.read(ref)
  assert.equal(afterSave.record?.documentId, identity)
  assert.equal(afterSave.record?.draftRevision, saved.record.draftRevision)
  await recovery.discard(ref, saved.record.draftRevision)
  assert.equal((await recovery.read(ref)).outcome, 'absent')
  assert.equal(readdirSync(join(paths.root, 'real-recovery')).length, 0)
})

test('interrupted atomic publication leaves the same draft discoverable on either file identity', async () => {
  const { journal, addLease } = setup()
  const saved = await journal.write('lease-one', writeInput(null))

  if (saved.outcome !== 'saved') {
    throw new Error('expected save')
  }

  journal.prepareFileReplacement('lease-one', 'prepared-new-inode')
  assert.equal((await journal.read('lease-one')).record?.draftRevision, saved.record.draftRevision)
  addLease('new-ref', 'prepared-new-inode', 'notes/renamed.md')
  const after = await journal.read('new-ref')
  assert.equal(after.record?.documentId, saved.record.documentId)
  assert.equal(after.record?.text, 'unsaved text')
  await journal.discard('new-ref', saved.record.draftRevision)
  assert.equal((await journal.read('lease-one')).outcome, 'absent')
})

test('a corrupt journal remains untouched without trapping normal explicit saving', async () => {
  const { authority, paths } = setup()

  const provider = new WorkspaceTextFileLeaseProvider(authority, {
    prepareFileReplacement: (ref, identity) => recovery.prepareFileReplacement(ref, identity)
  })

  const root = join(paths.root, 'corrupt-recovery')

  const recovery = new AtumDocumentRecoveryJournal(authority, ref => provider.resolveDocumentRecoveryLease(ref), {
    journalRootFor: () => root
  })

  const target = join(paths.workspaceRoot, 'draft.md')
  writeFileSync(target, 'original')
  const ref = provider.openLocal(target, { workspaceRelativePath: 'draft.md' }).fileRef
  const base = await provider.read(ref)
  await recovery.write(ref, { ...writeInput(null), baseRevision: base.revision })
  const broken = join(root, readdirSync(root)[0])
  writeFileSync(broken, 'broken journal bytes')
  await assert.rejects(recovery.read(ref), /DOCUMENT_RECOVERY_CORRUPT/)
  await assert.rejects(recovery.write(ref, writeInput(null)), /DOCUMENT_RECOVERY_CORRUPT/)
  await provider.write(ref, { expectedRevision: base.revision, text: 'explicitly saved live buffer' })
  assert.equal(readFileSync(target, 'utf8'), 'explicitly saved live buffer')
  assert.equal(readFileSync(broken, 'utf8'), 'broken journal bytes')
})

test('record permission failures are classified as unavailable and explicit file saving remains usable', async () => {
  const { authority, paths } = setup()

  const provider = new WorkspaceTextFileLeaseProvider(authority, {
    prepareFileReplacement: (ref, identity) => recovery.prepareFileReplacement(ref, identity)
  })

  const root = join(paths.root, 'permission-recovery')

  const recovery = new AtumDocumentRecoveryJournal(authority, ref => provider.resolveDocumentRecoveryLease(ref), {
    journalRootFor: () => root
  })

  const target = join(paths.workspaceRoot, 'draft.md')
  writeFileSync(target, 'base')
  const ref = provider.openLocal(target, { workspaceRelativePath: 'draft.md' }).fileRef
  const base = await provider.read(ref)
  await recovery.write(ref, { ...writeInput(null, 'retain this draft'), baseRevision: base.revision })
  const record = join(root, readdirSync(root)[0])
  const bytes = readFileSync(record)
  chmodSync(record, 0)

  try {
    // Root bypasses POSIX permission bits; normal desktop owners cannot.
    if (process.getuid?.() !== 0 && process.platform !== 'win32') {
      await assert.rejects(recovery.read(ref), /DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE/)
      await assert.rejects(recovery.write(ref, writeInput(null)), /DOCUMENT_RECOVERY_STORAGE_UNAVAILABLE/)
    }

    await provider.write(ref, { expectedRevision: base.revision, text: 'explicit file save' })
    assert.equal(readFileSync(target, 'utf8'), 'explicit file save')
  } finally {
    chmodSync(record, 0o600)
  }

  if (process.getuid?.() !== 0 && process.platform !== 'win32') {assert.deepEqual(readFileSync(record), bytes)}
})
