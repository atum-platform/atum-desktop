import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import { AtumFilesystemCapabilityAuthority, type FilesystemAccountEnvelope } from '../atum-filesystem-capability'
import { AccountRootAuthority } from '../atum-messaging'

import { matrixDocumentRecoveryRoot } from './document-recovery-root'
import { MatrixTextDocument, type MatrixTextDocumentScope } from './text-document'

const ACCOUNT_A = '00000000-0000-4000-8000-bd7662a5eeb4'
const ACCOUNT_B = '00000000-0000-4000-8000-b454f82c5857'
const cleanups: string[] = []

afterEach(() => {
  for (const directory of cleanups.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function fixture() {
  const userData = mkdtempSync(join(tmpdir(), 'atum-matrix-text-document-'))
  cleanups.push(userData)
  const roots = new AccountRootAuthority(userData)
  const pathsA = roots.prepare(ACCOUNT_A)
  roots.commit(ACCOUNT_A, 7)
  const authority = new AtumFilesystemCapabilityAuthority()
  authority.activateAccount({ accountId: ACCOUNT_A, generation: 7, paths: pathsA })

  let scope: MatrixTextDocumentScope = {
    account: { accountId: ACCOUNT_A, accountGeneration: 7 }, deviceId: 'DEVICE', roomId: '!room:test', userId: '@owner:test'
  }

  const confine = (requested: string) => {
    const canonical = requested
    const root = roots.pathsForAccount(scope.account.accountId).workspaceRoot

    if (!canonical.startsWith(`${root}/`)) {
      throw new Error('outside')
    }

    return canonical
  }

  let online = true
  const document = () => new MatrixTextDocument(scope, {
    authority,
    currentScope: () => scope,
    available: () => online,
    confine,
    journalRootFor: account => matrixDocumentRecoveryRoot(userData, account.accountId, scope.deviceId, scope.roomId)
  })

  return {
    authority,
    document,
    pathsA,
    roots,
    setOnline(next: boolean) {online = next},
    setScope(next: Partial<MatrixTextDocumentScope>) {scope = { ...scope, ...next, account: next.account ?? scope.account }},
    scope: () => scope,
    userData
  }
}

function recoveryInput(expectedDraftRevision: string | null, baseRevision: string, text = 'unsaved draft') {
  return { expectedDraftRevision, baseRevision, editorRevision: 'editor-1', text }
}

test('uses an opaque room-bound lease for real anchored reads, revision-CAS writes, and current capture', async () => {
  const f = fixture()
  const target = join(f.pathsA.workspaceRoot, 'notes.md')
  writeFileSync(target, 'one')
  const document = f.document()
  const descriptor = document.open(target)

  assert.equal(descriptor.name, 'notes.md')
  assert.equal(descriptor.recovery, 'available')
  assert.equal(JSON.stringify(descriptor).includes(target), false)
  const first = await document.read()
  const saved = await document.write({ expectedRevision: first.revision, text: 'two' })
  assert.equal(saved.text, 'two')
  assert.equal(readFileSync(target, 'utf8'), 'two')
  assert.deepEqual(await document.capture(), { bytes: Buffer.from('two'), name: 'notes.md', revision: saved.revision })

  writeFileSync(target, 'external')
  await assert.rejects(document.write({ expectedRevision: saved.revision, text: 'lost' }), /WORKSPACE_CONFLICT/u)
  assert.equal(readFileSync(target, 'utf8'), 'external')
})

test('confines selection, rejects unsupported extensions, and makes text-only recovery explicit', async () => {
  const f = fixture()
  const outside = join(f.userData, 'outside.md')
  const text = join(f.pathsA.workspaceRoot, 'plain.txt')
  const binary = join(f.pathsA.workspaceRoot, 'report.pdf')
  writeFileSync(outside, 'private')
  writeFileSync(text, 'plain')
  writeFileSync(binary, 'not text')

  await assert.rejects(Promise.resolve().then(() => f.document().open(outside)), /MATRIX_TEXT_DOCUMENT_UNAVAILABLE/u)
  await assert.rejects(Promise.resolve().then(() => f.document().open(binary)), /MATRIX_TEXT_DOCUMENT_UNSUPPORTED/u)
  const document = f.document()
  assert.equal(document.open(text).recovery, 'unsupported')
  await assert.rejects(document.recoveryRead(), /MATRIX_TEXT_DOCUMENT_RECOVERY_UNSUPPORTED/u)
  const first = await document.read()
  assert.equal((await document.write({ expectedRevision: first.revision, text: 'saved text' })).text, 'saved text')
})

test('scope loss and release revoke the original selection before a later room can use it', async () => {
  const f = fixture()
  const target = join(f.pathsA.workspaceRoot, 'room.md')
  writeFileSync(target, 'one')
  const document = f.document()
  document.open(target)
  f.setScope({ roomId: '!other:test' })
  await assert.rejects(document.read(), /MATRIX_TEXT_DOCUMENT_UNAVAILABLE/u)
  f.setScope({ roomId: '!room:test' })
  await assert.rejects(document.capture(), /MATRIX_TEXT_DOCUMENT_UNAVAILABLE/u)

  const reopened = f.document()
  reopened.open(target)
  await reopened.release()
  await assert.rejects(reopened.read(), /MATRIX_TEXT_DOCUMENT_UNAVAILABLE/u)
})

test('recovery is account-private, revision-checked, and remains discoverable across the wrapper recreation', async () => {
  const f = fixture()
  const target = join(f.pathsA.workspaceRoot, 'draft.md')
  writeFileSync(target, 'base')
  let document = f.document()
  document.open(target)
  const base = await document.read()
  const saved = await document.recoveryWrite(recoveryInput(null, base.revision))
  assert.equal(saved.outcome, 'saved')

  if (saved.outcome !== 'saved') { throw new Error('expected recovery save') }

  const replayed = await document.recoveryWrite(recoveryInput(null, base.revision, 'replayed'))
  assert.equal(replayed.outcome, 'stale')

  if (replayed.outcome === 'stale') {
    assert.equal(replayed.record.text, 'unsaved draft')
  }

  await document.release()

  document = f.document()
  document.open(target)
  const recovered = await document.recoveryRead()
  assert.equal(recovered.outcome, 'present')

  if (recovered.outcome === 'present') {
    assert.equal(recovered.record.text, 'unsaved draft')
    assert.equal(recovered.record.workspaceRelativePath.includes(target), false)
  }

  const pathsB = f.roots.prepare(ACCOUNT_B)
  f.roots.commit(ACCOUNT_B, 8)
  f.authority.activateAccount({ accountId: ACCOUNT_B, generation: 8, paths: pathsB })
  f.setScope({ account: { accountId: ACCOUNT_B, accountGeneration: 8 } satisfies FilesystemAccountEnvelope })
  const targetB = join(pathsB.workspaceRoot, 'draft.md')
  writeFileSync(targetB, 'other account')
  const other = f.document()
  other.open(targetB)
  assert.deepEqual(await other.recoveryRead(), { outcome: 'absent', record: null })
  await assert.rejects(document.recoveryRead(), /MATRIX_TEXT_DOCUMENT_UNAVAILABLE/u)
})

test('an external replacement cannot be confused with the selected file after an anchored write', async () => {
  const f = fixture()
  const target = join(f.pathsA.workspaceRoot, 'replace.md')
  const replacement = join(f.pathsA.workspaceRoot, 'replacement.md')
  writeFileSync(target, 'base')
  writeFileSync(replacement, 'different inode')
  const document = f.document()
  document.open(target)
  const base = await document.read()
  renameSync(replacement, target)
  await assert.rejects(document.write({ expectedRevision: base.revision, text: 'must not write' }), /WORKSPACE_CONFLICT|CAPABILITY_SCOPE_ESCAPE/u)
  assert.equal(readFileSync(target, 'utf8'), 'different inode')
})

test('preserves uniform CRLF bytes while exposing normalized editor text and exact capture', async () => {
  const f = fixture()
  const target = join(f.pathsA.workspaceRoot, 'windows.txt')
  writeFileSync(target, 'first\r\nsecond\r\n')
  const document = f.document()
  document.open(target)
  const base = await document.read()
  assert.equal(base.text, 'first\nsecond\n')
  assert.equal((await document.capture()).bytes.toString(), 'first\r\nsecond\r\n')
  const saved = await document.write({ expectedRevision: base.revision, text: 'changed\nsecond\n' })
  assert.equal(saved.text, 'changed\nsecond\n')
  assert.equal(readFileSync(target, 'utf8'), 'changed\r\nsecond\r\n')
  assert.equal((await document.capture()).bytes.toString(), 'changed\r\nsecond\r\n')
})

test('rejects lossy encoding, NUL and mixed line endings before editing without changing the original bytes', async () => {
  const f = fixture()
  const target = join(f.pathsA.workspaceRoot, 'encoding.txt')

  for (const bytes of [Buffer.from([0xe9, 0x0a]), Buffer.from('hello\0text'), Buffer.from('one\r\ntwo\n'), Buffer.from('\uFEFFtext')]) {
    writeFileSync(target, bytes)
    const document = f.document()
    document.open(target)
    await assert.rejects(document.read(), /MATRIX_TEXT_DOCUMENT_UNSUPPORTED/u)
    assert.deepEqual(readFileSync(target), bytes)
    await document.release()
  }
})

test('same-byte external inode replacement revokes reads, capture and writes', async () => {
  const f = fixture()
  const target = join(f.pathsA.workspaceRoot, 'identity.md')
  const replacement = join(f.pathsA.workspaceRoot, 'foreign.md')
  writeFileSync(target, 'same bytes')
  writeFileSync(replacement, 'same bytes')
  const document = f.document()
  document.open(target)
  const base = await document.read()
  renameSync(replacement, target)
  await assert.rejects(document.read(), /WORKSPACE_CONFLICT/u)
  await assert.rejects(document.capture(), /WORKSPACE_CONFLICT/u)
  await assert.rejects(document.write({ expectedRevision: base.revision, text: 'overwrite' }), /WORKSPACE_CONFLICT/u)
  assert.equal(readFileSync(target, 'utf8'), 'same bytes')
})

test('native IO errors contain fixed codes without exposing a renamed parent directory', async () => {
  const f = fixture()
  const target = join(f.pathsA.workspaceRoot, 'private-name.md')
  writeFileSync(target, 'original')
  const document = f.document()
  document.open(target)
  const base = await document.read()
  renameSync(f.pathsA.workspaceRoot, `${f.pathsA.workspaceRoot}-renamed`)

  for (const operation of [() => document.read(), () => document.capture(), () => document.write({ expectedRevision: base.revision, text: 'edit' })]) {
    await assert.rejects(operation(), error => {
      assert.equal((error as Error).message, 'WORKSPACE_IO_FAILED')
      assert.equal((error as Error).message.includes(f.userData), false)

      return true
    })
  }
})

test('recovery drafts for the same file cannot cross the original device or room', async () => {
  const f = fixture()
  const target = join(f.pathsA.workspaceRoot, 'scope.md')
  writeFileSync(target, 'base')
  const original = f.document()
  original.open(target)
  const base = await original.read()
  await original.recoveryWrite(recoveryInput(null, base.revision))
  await original.release()

  for (const scope of [{ roomId: '!other:test' }, { roomId: '!room:test', deviceId: 'OTHER' }]) {
    f.setScope(scope)
    const next = f.document()
    next.open(target)
    assert.deepEqual(await next.recoveryRead(), { outcome: 'absent', record: null })
    await next.release()
  }
})

test('temporary offline suspends native IO without losing same-scope custody', async () => {
  const f = fixture()
  const target = join(f.pathsA.workspaceRoot, 'offline.txt')
  writeFileSync(target, 'original')
  const document = f.document()
  document.open(target)
  const base = await document.read()
  f.setOnline(false)
  await assert.rejects(document.read(), /MATRIX_TEXT_DOCUMENT_OFFLINE/u)
  await assert.rejects(document.write({ expectedRevision: base.revision, text: 'must wait' }), /MATRIX_TEXT_DOCUMENT_OFFLINE/u)
  assert.equal(readFileSync(target, 'utf8'), 'original')
  f.setOnline(true)
  assert.equal((await document.write({ expectedRevision: base.revision, text: 'now saved' })).text, 'now saved')
  f.setOnline(false)
  f.setScope({ roomId: '!foreign:test' })
  await assert.rejects(document.read(), /MATRIX_TEXT_DOCUMENT_UNAVAILABLE/u)
  f.setOnline(true)
  f.setScope({ roomId: '!room:test' })
  await assert.rejects(document.capture(), /MATRIX_TEXT_DOCUMENT_UNAVAILABLE/u)
})
