import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import { AtumFilesystemCapabilityAuthority } from '../atum-filesystem-capability'

import { AccountRootAuthority } from './account-roots'

const cleanups: string[] = []
const A = 'account-a'
const B = 'account-b'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'atum-home-base-'))
  cleanups.push(root)
  const home = join(root, 'home')
  const data = join(root, 'private')
  mkdirSync(home)

  return { home, data, roots: new AccountRootAuthority(data, home) }
}

afterEach(() => {for (const path of cleanups.splice(0)) {rmSync(path, { recursive: true, force: true })}})

test('first account gets ~/Atum and only work files move; old chat paths still address the same files', () => {
  const { home, roots } = setup()
  const before = roots.prepare(A)
  mkdirSync(before.workspaceRoot)
  mkdirSync(join(before.workspaceRoot, '.git'))
  writeFileSync(join(before.workspaceRoot, '.git', 'HEAD'), 'checkpoint')
  writeFileSync(join(before.workspaceRoot, 'report.md'), 'original work')
  writeFileSync(before.authStorage, 'private auth')
  const source = statSync(before.workspaceRoot)
  const after = roots.prepareWorkspace(A)

  assert.equal(after.workspaceRoot, join(home, 'Atum'))
  assert.equal(statSync(after.workspaceRoot).ino, source.ino)
  assert.equal(readFileSync(join(after.workspaceRoot, '.git', 'HEAD'), 'utf8'), 'checkpoint')
  assert.equal(lstatSync(before.workspaceRoot).isSymbolicLink(), true)
  assert.equal(realpathSync(before.workspaceRoot), realpathSync(after.workspaceRoot))
  writeFileSync(join(before.workspaceRoot, 'report.md'), 'edit from an old chat')
  assert.equal(readFileSync(join(after.workspaceRoot, 'report.md'), 'utf8'), 'edit from an old chat')
  assert.equal(after.authStorage, before.authStorage)
  assert.equal(after.hermesStateRoot, before.hermesStateRoot)
  assert.equal(existsSync(join(after.workspaceRoot, 'auth')), false)
  assert.equal(readFileSync(after.authStorage, 'utf8'), 'private auth')
  assert.deepEqual(roots.prepareWorkspace(A), after)
})

test('existing home folders and other accounts are never adopted or merged', () => {
  const { home, data, roots } = setup()
  mkdirSync(join(home, 'Atum'))
  writeFileSync(join(home, 'Atum', 'personal.txt'), 'unrelated')
  const a = roots.prepareWorkspace(A)
  const b = roots.prepareWorkspace(B)

  assert.equal(a.workspaceRoot, join(home, 'Atum (2)'))
  assert.equal(b.workspaceRoot, join(home, 'Atum (3)'))
  assert.equal(readFileSync(join(home, 'Atum', 'personal.txt'), 'utf8'), 'unrelated')
  assert.equal(new AccountRootAuthority(data, home).prepareWorkspace(A).workspaceRoot, a.workspaceRoot)
  assert.equal(new AccountRootAuthority(data, home).prepareWorkspace(B).workspaceRoot, b.workspaceRoot)
})

test('restart after persisted intent or rename finishes the same move and compatibility link', () => {
  const { home, data, roots } = setup()
  const before = roots.prepare(A)
  mkdirSync(before.workspaceRoot)
  writeFileSync(join(before.workspaceRoot, 'note.txt'), 'keep')
  const source = statSync(before.workspaceRoot)
  writeFileSync(join(before.root, 'workspace-location.json'), JSON.stringify({ version: 1, name: 'Atum', identity: `${source.dev}:${source.ino}` }))
  const recovered = new AccountRootAuthority(data, home).prepareWorkspace(A)
  assert.equal(readFileSync(join(recovered.workspaceRoot, 'note.txt'), 'utf8'), 'keep')
  unlinkSync(before.workspaceRoot)
  const resumed = new AccountRootAuthority(data, home).prepareWorkspace(A)
  assert.equal(realpathSync(before.workspaceRoot), realpathSync(resumed.workspaceRoot))
})

test('a destination collision after intent preserves both directories and fails visibly', () => {
  const { home, roots } = setup()
  const before = roots.prepare(A)
  mkdirSync(before.workspaceRoot)
  writeFileSync(join(before.workspaceRoot, 'source.txt'), 'source')
  const source = statSync(before.workspaceRoot)
  writeFileSync(join(before.root, 'workspace-location.json'), JSON.stringify({ version: 1, name: 'Atum', identity: `${source.dev}:${source.ino}` }))
  mkdirSync(join(home, 'Atum'))
  writeFileSync(join(home, 'Atum', 'other.txt'), 'other')
  assert.throws(() => roots.prepareWorkspace(A), /workspace_destination_changed/u)
  assert.equal(readFileSync(join(before.workspaceRoot, 'source.txt'), 'utf8'), 'source')
  assert.equal(readFileSync(join(home, 'Atum', 'other.txt'), 'utf8'), 'other')
})

test('missing, replaced, or symlinked destinations never silently acquire a new folder', () => {
  const { home, roots } = setup()
  const paths = roots.prepareWorkspace(A)
  renameSync(paths.workspaceRoot, join(home, 'moved'))
  assert.throws(() => roots.prepareWorkspace(A), /workspace_source_missing/u)
  assert.equal(existsSync(paths.workspaceRoot), false)
  mkdirSync(paths.workspaceRoot)
  assert.throws(() => roots.prepareWorkspace(A), /workspace_destination_changed/u)
  rmSync(paths.workspaceRoot, { recursive: true })
  symlinkSync(join(home, 'moved'), paths.workspaceRoot, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => roots.prepareWorkspace(A), /workspace_destination_changed/u)
})

test('locating a renamed original restores it and allows the same account to activate again', () => {
  const { home, roots } = setup()
  const before = roots.prepareWorkspace(A)
  writeFileSync(join(before.workspaceRoot, 'work.txt'), 'keep my work')
  const moved = join(home, 'Renamed in Finder')
  renameSync(before.workspaceRoot, moved)
  assert.throws(() => roots.prepareWorkspace(A), /workspace_source_missing/u)
  const unrelated = join(home, 'unrelated')
  mkdirSync(unrelated)
  assert.throws(() => roots.restoreWorkspace(A, unrelated), /workspace_restore_wrong_folder/u)
  mkdirSync(before.workspaceRoot)
  assert.throws(() => roots.restoreWorkspace(A, moved), /workspace_restore_destination_occupied/u)
  rmSync(before.workspaceRoot, { recursive: true })
  roots.restoreWorkspace(A, moved)
  const restored = roots.prepareWorkspace(A)
  assert.equal(readFileSync(join(restored.workspaceRoot, 'work.txt'), 'utf8'), 'keep my work')
  assert.equal(realpathSync(join(restored.root, 'workspace')), realpathSync(restored.workspaceRoot))
})

test('explicitly forgetting a destroyed folder permits a fresh workspace without changing account state', () => {
  const { roots } = setup()
  const before = roots.prepareWorkspace(A)
  writeFileSync(before.authStorage, 'keep account')
  rmSync(before.workspaceRoot, { recursive: true })
  assert.throws(() => roots.prepareWorkspace(A), /workspace_source_missing/u)
  roots.forgetWorkspace(A)
  const after = roots.prepareWorkspace(A)
  assert.equal(statSync(after.workspaceRoot).isDirectory(), true)
  assert.equal(readFileSync(after.authStorage, 'utf8'), 'keep account')
  assert.equal(realpathSync(join(after.root, 'workspace')), realpathSync(after.workspaceRoot))
})

test('fresh-start recovery refuses existing work even when its location metadata is corrupt', () => {
  const { roots } = setup()
  const before = roots.prepareWorkspace(A)
  writeFileSync(join(before.workspaceRoot, 'keep.txt'), 'work')
  assert.throws(() => roots.forgetWorkspace(A), /workspace_still_present/u)
  writeFileSync(join(before.root, 'workspace-location.json'), '{')
  assert.throws(() => roots.forgetWorkspace(A), /workspace_still_present/u)
  assert.equal(readFileSync(join(before.workspaceRoot, 'keep.txt'), 'utf8'), 'work')
  rmSync(before.workspaceRoot, { recursive: true })
  roots.forgetWorkspace(A)
  assert.equal(statSync(roots.prepareWorkspace(A).workspaceRoot).isDirectory(), true)
})

test('damaged location metadata leaves private paths readable and repairs from the owned alias', () => {
  const { roots } = setup()
  const before = roots.prepareWorkspace(A)
  writeFileSync(join(before.workspaceRoot, 'work.txt'), 'keep')

  for (const corrupt of ['{', 'null', '{"version":1,"name":"../outside","identity":"1:2"}', null]) {
    if (corrupt === null) {unlinkSync(join(before.root, 'workspace-location.json'))}
    else {writeFileSync(join(before.root, 'workspace-location.json'), corrupt)}

    const paths = roots.prepare(A)
    assert.equal(paths.authStorage, before.authStorage)
    assert.equal(paths.messagingDatabase, before.messagingDatabase)
    assert.equal(roots.prepareWorkspace(A).workspaceRoot, before.workspaceRoot)
    assert.equal(readFileSync(join(before.workspaceRoot, 'work.txt'), 'utf8'), 'keep')
  }
})

test('a visible root swapped for a symlink after preparation cannot receive a grant', () => {
  const { home, roots } = setup()
  const a = roots.prepareWorkspace(A)
  renameSync(a.workspaceRoot, join(home, 'moved'))
  symlinkSync(home, a.workspaceRoot, process.platform === 'win32' ? 'junction' : 'dir')
  const authority = new AtumFilesystemCapabilityAuthority()
  assert.throws(() => authority.activateAccount({ accountId: A, generation: 1, paths: a }), /invalid_account_capability_context/u)
  assert.equal(authority.currentAuthority(), null)
  writeFileSync(join(a.root, 'workspace-location.json'), '{')
  assert.throws(() => roots.prepareWorkspace(A), /workspace_location_invalid/u)
})

test('broker grants use the visible root and reject a different account workspace', () => {
  const { roots } = setup()
  const a = roots.prepareWorkspace(A)
  const b = roots.prepareWorkspace(B)
  writeFileSync(join(a.workspaceRoot, 'report.txt'), 'a')
  writeFileSync(join(b.workspaceRoot, 'report.txt'), 'b')
  const authority = new AtumFilesystemCapabilityAuthority()
  const grant = authority.activateAccount({ accountId: A, generation: 1, paths: a })
  assert.equal(grant.scope.canonicalRoot, realpathSync(a.workspaceRoot))

  const read = (resourcePath: string, operationId: string) => authority.decide({
    account: { accountId: A, accountGeneration: 1 }, actor: { kind: 'personal', personalAgentId: 'atum-personal-assistant' },
    capability: 'filesystem.read', resourcePath, operationId
  })

  assert.equal(read(join(a.workspaceRoot, 'report.txt'), 'new').allowed, true)
  assert.equal(read(join(a.root, 'workspace', 'report.txt'), 'old').allowed, true)
  assert.equal(read(join(b.workspaceRoot, 'report.txt'), 'other-account').allowed, false)
  assert.throws(() => authority.activateAccount({ accountId: A, generation: 1, paths: { ...a, workspaceRoot: b.workspaceRoot } }), /invalid_account_capability_context/u)
})
