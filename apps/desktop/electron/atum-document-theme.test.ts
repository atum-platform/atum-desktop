import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, test } from 'vitest'

import { normalizeDocumentKey } from '../shared/atum-office/document-identity'

import { AtumDocumentThemeStore, migrateStoredDocumentThemeFile } from './atum-document-theme'
import { AccountRootAuthority } from './atum-messaging'

const ACCOUNT_A = '00000000-0000-4000-8000-bd7662a5eeb4'
const ACCOUNT_B = '00000000-0000-4000-8000-b454f82c5857'

const cleanups: string[] = []
afterEach(() => {
  for (const value of cleanups.splice(0)) {
    rmSync(value, { force: true, recursive: true })
  }
})

/** The store creates its directory lazily, so seeding a file needs the parent. */
function seed(documentThemes: string, body: string): void {
  mkdirSync(dirname(documentThemes), { recursive: true })
  writeFileSync(documentThemes, body)
}

function harness(generation = 3) {
  const root = mkdtempSync(join(tmpdir(), 'atum-theme-'))
  cleanups.push(root)
  const roots = new AccountRootAuthority(root)
  const paths = roots.prepare(ACCOUNT_A)
  roots.commit(ACCOUNT_A, generation)
  const store = new AtumDocumentThemeStore()
  store.activateAccount({ accountId: ACCOUNT_A, generation, paths })

  return { account: { accountGeneration: generation, accountId: ACCOUNT_A }, paths, root, roots, store }
}

test('an unthemed document resolves to the default without writing anything', () => {
  const { account, paths, store } = harness()

  const resolved = store.resolveFor({ account, workspaceRelativePath: 'notes/plan.md' })

  assert.equal(resolved.id, 'manuscript')
  assert.equal(resolved.isDefault, true)
  assert.equal(resolved.revision, 0)
  // Defaults are inferred, never materialised.
  assert.throws(() => statSync(paths.documentThemes))
})

test('persists an explicit choice and advances its revision on every write', () => {
  const { account, store } = harness()
  const target = { account, workspaceRelativePath: 'notes/plan.md' }

  const first = store.setFor(target, { themeId: 'report' })
  assert.equal(first.id, 'report')
  assert.equal(first.revision, 1)
  assert.equal(first.isDefault, false)

  assert.equal(store.resolveFor(target).id, 'report')
  assert.equal(store.resolveFor(target).revision, 1)

  const second = store.setFor(target, { overrides: { pageSize: 'letter' }, themeId: 'report' })
  assert.equal(second.revision, 2)
  assert.equal(store.resolveFor(target).pageSize, 'letter')
})

test('survives a restart and stays private on disk', () => {
  const { account, paths, store } = harness()
  store.setFor({ account, workspaceRelativePath: 'notes/plan.md' }, { themeId: 'book' })

  const reopened = new AtumDocumentThemeStore()
  reopened.activateAccount({ accountId: ACCOUNT_A, generation: 3, paths })

  assert.equal(reopened.resolveFor({ account, workspaceRelativePath: 'notes/plan.md' }).id, 'book')
  assert.equal(statSync(paths.documentThemes).mode & 0o777, 0o600)
  assert.equal(statSync(join(paths.root, 'office')).mode & 0o777, 0o700)
})

test('keeps a person’s themes across a sign-out and sign-in at a new generation', () => {
  // Generation is a revocation epoch that increments on every sign-in. If it
  // were part of identity, signing back in would silently reset every theme.
  const { account, paths, store } = harness(3)
  store.setFor({ account, workspaceRelativePath: 'notes/plan.md' }, { themeId: 'modern' })

  store.revokeAccount(account)
  store.activateAccount({ accountId: ACCOUNT_A, generation: 4, paths })

  const resolved = store.resolveFor({
    account: { accountGeneration: 4, accountId: ACCOUNT_A },
    workspaceRelativePath: 'notes/plan.md'
  })

  assert.equal(resolved.id, 'modern')
})

test('finds one document however the caller spelled its path', () => {
  const { account, store } = harness()
  store.setFor({ account, workspaceRelativePath: 'Tài liệu/Kế hoạch.md' }, { themeId: 'note' })

  for (const spelling of [
    'Tài liệu/Kế hoạch.md',
    'Tài liệu\\Kế hoạch.md',
    './Tài liệu//Kế hoạch.md',
    'Tài liệu/Kế hoạch.md'.normalize('NFD')
  ]) {
    assert.equal(store.resolveFor({ account, workspaceRelativePath: spelling }).id, 'note', spelling)
  }
})

test('isolates accounts through their own account-private files', () => {
  const { account, root, store } = harness()
  store.setFor({ account, workspaceRelativePath: 'notes/plan.md' }, { themeId: 'book' })

  const roots = new AccountRootAuthority(root)
  const pathsB = roots.prepare(ACCOUNT_B)
  roots.commit(ACCOUNT_B, 1)
  const storeB = new AtumDocumentThemeStore()
  storeB.activateAccount({ accountId: ACCOUNT_B, generation: 1, paths: pathsB })

  const accountB = { accountGeneration: 1, accountId: ACCOUNT_B }
  assert.equal(storeB.resolveFor({ account: accountB, workspaceRelativePath: 'notes/plan.md' }).isDefault, true)
  assert.notEqual(pathsB.documentThemes, harness().paths.documentThemes)
})

test('refuses to serve or store another account’s themes through a live store', () => {
  const { account, store } = harness()
  store.setFor({ account, workspaceRelativePath: 'notes/plan.md' }, { themeId: 'book' })

  const foreign = { accountGeneration: 3, accountId: ACCOUNT_B }

  // A read degrades rather than throwing, because reads sit in a render path.
  assert.equal(store.resolveFor({ account: foreign, workspaceRelativePath: 'notes/plan.md' }).isDefault, true)
  assert.throws(
    () => store.setFor({ account: foreign, workspaceRelativePath: 'notes/plan.md' }, { themeId: 'note' }),
    /DOCUMENT_THEME_FOREIGN_ACCOUNT/u
  )
})

test('falls back to the default when the store is corrupt, and says why', () => {
  const { account, paths, store } = harness()
  store.setFor({ account, workspaceRelativePath: 'notes/plan.md' }, { themeId: 'book' })

  for (const body of ['not json at all', '[]', '{"version":1}', '{"version":1,"entries":[]}', 'null']) {
    writeFileSync(paths.documentThemes, body)
    const reopened = new AtumDocumentThemeStore()
    reopened.activateAccount({ accountId: ACCOUNT_A, generation: 3, paths })

    const resolved = reopened.resolveFor({ account, workspaceRelativePath: 'notes/plan.md' })
    assert.equal(resolved.isDefault, true, body)
    assert.equal(reopened.lastFailureCode, 'DOCUMENT_THEME_CORRUPT', body)
  }
})

test('a damaged current-version store repairs itself on the next write', () => {
  const { account, paths } = harness()
  seed(paths.documentThemes, 'not json at all')
  const store = new AtumDocumentThemeStore()
  store.activateAccount({ accountId: ACCOUNT_A, generation: 3, paths })

  const resolved = store.setFor({ account, workspaceRelativePath: 'notes/plan.md' }, { themeId: 'modern' })

  assert.equal(resolved.id, 'modern')
  assert.equal(store.lastFailureCode, null)
  assert.equal(JSON.parse(readFileSync(paths.documentThemes, 'utf8')).version, 1)
})

test('a stored theme that has left the catalogue degrades to the default', () => {
  const { account, paths } = harness()
  seed(
    paths.documentThemes,
    JSON.stringify({ entries: { 'notes/plan.md': { revision: 2, themeId: 'retired-theme' } }, version: 1 })
  )
  const store = new AtumDocumentThemeStore()
  store.activateAccount({ accountId: ACCOUNT_A, generation: 3, paths })

  assert.equal(store.resolveFor({ account, workspaceRelativePath: 'notes/plan.md' }).isDefault, true)
})

test('follows a rename, including a whole renamed folder', () => {
  const { account, store } = harness()
  store.setFor({ account, workspaceRelativePath: 'notes/plan.md' }, { themeId: 'book' })
  store.setFor({ account, workspaceRelativePath: 'notes/deep/spec.md' }, { themeId: 'report' })

  store.noteRename({ account, from: 'notes', to: 'archive/2026' })

  assert.equal(store.resolveFor({ account, workspaceRelativePath: 'archive/2026/plan.md' }).id, 'book')
  assert.equal(store.resolveFor({ account, workspaceRelativePath: 'archive/2026/deep/spec.md' }).id, 'report')
  assert.equal(store.resolveFor({ account, workspaceRelativePath: 'notes/plan.md' }).isDefault, true)
})

test('a rename does not overwrite a choice already made at the destination', () => {
  const { account, store } = harness()
  store.setFor({ account, workspaceRelativePath: 'draft.md' }, { themeId: 'note' })
  store.setFor({ account, workspaceRelativePath: 'final.md' }, { themeId: 'report' })

  store.noteRename({ account, from: 'draft.md', to: 'final.md' })

  assert.equal(store.resolveFor({ account, workspaceRelativePath: 'final.md' }).id, 'report')
})

test('forgets a deleted document and everything beneath it', () => {
  const { account, store } = harness()
  store.setFor({ account, workspaceRelativePath: 'notes/plan.md' }, { themeId: 'book' })
  store.setFor({ account, workspaceRelativePath: 'keep.md' }, { themeId: 'modern' })

  store.noteDelete({ account, workspaceRelativePath: 'notes' })

  assert.equal(store.resolveFor({ account, workspaceRelativePath: 'notes/plan.md' }).isDefault, true)
  assert.equal(store.resolveFor({ account, workspaceRelativePath: 'keep.md' }).id, 'modern')
})

test('clearing a choice returns the document to the inferred default', () => {
  const { account, store } = harness()
  const target = { account, workspaceRelativePath: 'notes/plan.md' }
  store.setFor(target, { themeId: 'book' })

  store.clearFor(target)

  assert.equal(store.resolveFor(target).isDefault, true)
  // Revisions never restart: a reissued number could not be told apart from the
  // one an in-flight export already pinned.
  assert.ok(store.setFor(target, { themeId: 'note' }).revision > 1)
})

test('a document with no durable identity is readable but not storable', () => {
  const { account, store } = harness()

  assert.equal(store.resolveFor({ account, workspaceRelativePath: '/etc/passwd' }).isDefault, true)
  assert.throws(
    () => store.setFor({ account, workspaceRelativePath: '../outside.md' }, { themeId: 'note' }),
    /DOCUMENT_THEME_NO_IDENTITY/u
  )
})

test('revocation is idempotent and never blocks a sign-out', () => {
  const { account, store } = harness()

  store.revokeAccount({ accountGeneration: 3, accountId: ACCOUNT_B })
  store.revokeAccount(account)
  store.revokeAccount(account)

  assert.equal(store.resolveFor({ account, workspaceRelativePath: 'notes/plan.md' }).isDefault, true)
  assert.throws(() => store.setFor({ account, workspaceRelativePath: 'a.md' }, { themeId: 'note' }), /NO_ACCOUNT/u)
})

test('persists a document whose name collides with an Object prototype key', () => {
  // On a plain object `entries['__proto__'] = …` hits the Object.prototype
  // setter instead of creating an own property, so the row would serialise away
  // and the person's choice would be silently unrecoverable.
  const { account, paths, store } = harness()

  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    store.setFor({ account, workspaceRelativePath: name }, { themeId: 'book' })
  }

  const reopened = new AtumDocumentThemeStore()
  reopened.activateAccount({ accountId: ACCOUNT_A, generation: 3, paths })

  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(reopened.resolveFor({ account, workspaceRelativePath: name }).id, 'book', name)
  }
})

test('a hostile store cannot re-prototype the entry map it is parsed into', () => {
  const migrated = migrateStoredDocumentThemeFile({
    entries: JSON.parse('{"__proto__":{"themeId":"book","revision":3},"real.md":{"themeId":"note","revision":1}}'),
    version: 1
  })

  assert.equal(migrated.kind, 'ok')
  const entries = migrated.kind === 'ok' ? migrated.file.entries : {}
  assert.equal(Object.getPrototypeOf(entries), null)
  assert.equal(entries['real.md']!.themeId, 'note')
  assert.equal(Object.hasOwn(entries, '__proto__'), true)
})

test('clearing a document that was never themed writes nothing', () => {
  // `key in entries` is true for inherited names, which would take the write
  // branch and materialise a file for a document that has no row.
  const { account, paths, store } = harness()

  store.clearFor({ account, workspaceRelativePath: 'constructor' })
  store.clearFor({ account, workspaceRelativePath: 'never-themed.md' })

  assert.throws(() => statSync(paths.documentThemes))
})

test('a failed write keeps the choice for the session but reports the lost durability', () => {
  const { account, paths, store } = harness()
  // A file where the store wants its directory: mkdir fails, so the write does.
  writeFileSync(join(paths.root, 'office'), 'not a directory')

  const resolved = store.setFor({ account, workspaceRelativePath: 'notes/plan.md' }, { themeId: 'report' })

  assert.equal(resolved.id, 'report')
  assert.equal(store.lastFailureCode, 'DOCUMENT_THEME_WRITE_FAILED')
  // The in-session choice still applies; only durability was lost.
  assert.equal(store.resolveFor({ account, workspaceRelativePath: 'notes/plan.md' }).id, 'report')

  const reopened = new AtumDocumentThemeStore()
  reopened.activateAccount({ accountId: ACCOUNT_A, generation: 3, paths })
  assert.equal(reopened.resolveFor({ account, workspaceRelativePath: 'notes/plan.md' }).isDefault, true)
})

test('the migration seam accepts version 1, repairs damage, and preserves a newer version', () => {
  const empty = migrateStoredDocumentThemeFile({ entries: {}, version: 1 })
  assert.equal(empty.kind, 'ok')
  assert.equal(empty.kind === 'ok' ? empty.file.version : 0, 1)
  assert.deepEqual(empty.kind === 'ok' ? Object.keys(empty.file.entries) : ['unreachable'], [])
  // Null-prototype, so a document named `__proto__` gets a real own property.
  assert.equal(empty.kind === 'ok' ? Object.getPrototypeOf(empty.file.entries) : 'unreachable', null)

  for (const value of [
    null,
    undefined,
    42,
    [],
    {},
    { entries: {}, version: 1.5 },
    { version: 1 },
    { entries: [], version: 1 }
  ]) {
    assert.equal(migrateStoredDocumentThemeFile(value).kind, 'corrupt', JSON.stringify(value))
  }

  // A version we recognise as a version but cannot read is preserved, not damage.
  for (const value of [
    { entries: {}, version: 2 },
    { entries: {}, version: 99 }
  ]) {
    assert.equal(migrateStoredDocumentThemeFile(value).kind, 'unsupported-version', JSON.stringify(value))
  }
})

test('the migration seam re-normalises keys and drops unusable rows', () => {
  const migrated = migrateStoredDocumentThemeFile({
    entries: {
      '../escape.md': { revision: 1, themeId: 'book' },
      'Notes\\Plan.md': { revision: 2, themeId: 'book' },
      'bad-row.md': 'not an object',
      'no-theme.md': { revision: 1 }
    },
    version: 1
  })

  assert.ok(migrated)
  const key = normalizeDocumentKey('Notes\\Plan.md')!
  assert.deepEqual(Object.keys(migrated.kind === 'ok' ? migrated.file.entries : {}), [key])
  assert.equal(migrated.kind === 'ok' ? migrated.file.entries[key]!.revision : -1, 2)
})

test('a store written by a newer build is never overwritten', () => {
  // Overwriting would destroy metadata this build cannot even read.
  const { account, paths } = harness()
  const future = JSON.stringify({ entries: { 'notes/plan.md': { revision: 9, themeId: 'future' } }, version: 2 })
  seed(paths.documentThemes, future)
  const store = new AtumDocumentThemeStore()
  store.activateAccount({ accountId: ACCOUNT_A, generation: 3, paths })

  const resolved = store.setFor({ account, workspaceRelativePath: 'notes/plan.md' }, { themeId: 'modern' })

  assert.equal(resolved.id, 'modern')
  assert.equal(store.lastFailureCode, 'DOCUMENT_THEME_UNSUPPORTED_VERSION')
  assert.equal(readFileSync(paths.documentThemes, 'utf8'), future)
})

test('revisions are monotonic across clear and reselect', () => {
  // set book, clear, set note must not mint revision 1 twice, or an export that
  // pinned the first cannot tell the theme changed underneath it.
  const { account, store } = harness()
  const target = { account, workspaceRelativePath: 'notes/plan.md' }

  const first = store.setFor(target, { themeId: 'book' })
  store.clearFor(target)
  const second = store.setFor(target, { themeId: 'note' })

  assert.ok(second.revision > first.revision, `${second.revision} must exceed ${first.revision}`)
})

test('the revision counter is unique per write and survives a reopen', () => {
  const { account, paths, store } = harness()
  const a = store.setFor({ account, workspaceRelativePath: 'a.md' }, { themeId: 'book' })
  const b = store.setFor({ account, workspaceRelativePath: 'b.md' }, { themeId: 'note' })
  assert.notEqual(a.revision, b.revision)

  const reopened = new AtumDocumentThemeStore()
  reopened.activateAccount({ accountId: ACCOUNT_A, generation: 3, paths })
  const c = reopened.setFor({ account, workspaceRelativePath: 'c.md' }, { themeId: 'modern' })

  assert.ok(c.revision > b.revision, 'the counter must survive a restart')
})

test('a hand-edited revision cannot break the counter', () => {
  const { account, paths } = harness()
  seed(
    paths.documentThemes,
    JSON.stringify({
      entries: { 'a.md': { revision: Number.MAX_VALUE, themeId: 'book' }, 'b.md': { revision: -4, themeId: 'note' } },
      version: 1
    })
  )
  const store = new AtumDocumentThemeStore()
  store.activateAccount({ accountId: ACCOUNT_A, generation: 3, paths })

  const next = store.setFor({ account, workspaceRelativePath: 'c.md' }, { themeId: 'modern' })

  assert.ok(Number.isSafeInteger(next.revision) && next.revision > 0)
})
