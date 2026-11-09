import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import {
  matrixDriveChosenRoot,
  matrixDriveFolderIssue,
  matrixDriveFolderProblem,
  matrixDriveFolderPrompt,
  matrixDrivePrepareFolder,
  matrixDriveResolveDirectory,
  matrixDriveRootEnrolled
} from './drive-folder'

// A path replaced by another directory between two of the checks on it is made real here: the hook
// runs just before the real `realpathSync` answers, on the path the test names.
const fsHooks = vi.hoisted(() => ({ beforeRealpath: undefined as ((target: unknown) => void) | undefined }))

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof NodeFs>()

  const realpathSync = Object.assign(
    (...args: unknown[]) => {
      fsHooks.beforeRealpath?.(args[0])

      return (actual.realpathSync as (...values: unknown[]) => unknown)(...args)
    },
    { native: actual.realpathSync.native }
  ) as typeof actual.realpathSync

  return { ...actual, realpathSync }
})

const identity = { issuer: 'https://auth.test/', subject: 'owner-a', origin: 'https://drive.test' }
const fixtures: string[] = []

afterEach(() => {
  fsHooks.beforeRealpath = undefined

  for (const fixture of fixtures.splice(0)) {
    chmodSync(fixture, 0o700)
    rmSync(fixture, { recursive: true, force: true })
  }
})

function sandbox() {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'atum-drive-folder-')))
  fixtures.push(base)
  const home = path.join(base, 'Users', 'owner')
  mkdirSync(home, { recursive: true })

  const folder = (...parts: string[]) => {
    const value = path.join(home, ...parts)
    mkdirSync(value, { recursive: true })

    return value
  }

  const bind = (root: string, overrides: Record<string, unknown> = {}) =>
    writeFileSync(
      path.join(root, '.atum-drive-binding.json'),
      JSON.stringify({
        version: 1,
        canonicalRoot: root,
        ...identity,
        journal: '.atum-drive-journal.db',
        space: 'storage$personal',
        ...overrides
      })
    )

  return { base, home, folder, bind }
}

it('accepts an empty folder, also with only Finder’s or the engine’s own bookkeeping in it', () => {
  const s = sandbox()
  const root = s.folder('Atum Drive')
  expect(matrixDriveFolderProblem(root, identity, s.home)).toBeUndefined()
  writeFileSync(path.join(root, '.DS_Store'), '')
  writeFileSync(path.join(root, '.atum-drive-owner.lock'), '')
  expect(matrixDriveFolderProblem(root, identity, s.home)).toBeUndefined()
})

it('refuses a folder with any file in it, hidden ones included', () => {
  const s = sandbox()
  const visible = s.folder('Documents')
  writeFileSync(path.join(visible, 'report.docx'), 'x')
  expect(matrixDriveFolderProblem(visible, identity, s.home)).toBe('folder_not_empty')
  const hidden = s.folder('Notes')
  writeFileSync(path.join(hidden, '.secret'), 'x')
  expect(matrixDriveFolderProblem(hidden, identity, s.home)).toBe('folder_not_empty')
  const nested = s.folder('Projects', 'empty child')
  expect(matrixDriveFolderProblem(path.dirname(nested), identity, s.home)).toBe('folder_not_empty')
})

it('refuses the home folder, anything that contains it, and the disk', () => {
  const s = sandbox()
  expect(matrixDriveFolderProblem(s.home, identity, s.home)).toBe('folder_home')
  expect(matrixDriveFolderProblem(path.dirname(s.home), identity, s.home)).toBe('folder_home')
  expect(matrixDriveFolderProblem(path.parse(s.home).root, identity, s.home)).toBe('folder_home')
})

it('refuses folders inside managed runtime and credential folders, whatever their case', () => {
  const s = sandbox()
  expect(matrixDriveFolderProblem(s.folder('.hermes', 'files'), identity, s.home)).toBe('folder_protected')
  expect(matrixDriveFolderProblem(s.folder('code', 'Node_Modules', 'x'), identity, s.home)).toBe('folder_protected')
  expect(matrixDriveFolderProblem(s.folder('.SSH'), identity, s.home)).toBe('folder_protected')
})

it('refuses a folder inside another Drive folder, and a Drive folder of another account', () => {
  const s = sandbox()
  const outer = s.folder('Atum Drive')
  s.bind(outer)
  expect(matrixDriveFolderProblem(s.folder('Atum Drive', 'Inner'), identity, s.home)).toBe('folder_in_drive')
  const foreign = s.folder('Their Drive')
  s.bind(foreign, { subject: 'owner-b' })
  expect(matrixDriveFolderProblem(foreign, identity, s.home)).toBe('folder_other_drive')
  expect(matrixDriveRootEnrolled(foreign, identity)).toBe(false)
})

it('accepts this owner’s own Drive folder with files, as it is after enrollment', () => {
  const s = sandbox()
  const root = s.folder('Atum Drive')
  s.bind(root)
  writeFileSync(path.join(root, 'synced.txt'), 'x')
  expect(matrixDriveRootEnrolled(root, identity)).toBe(true)
  expect(matrixDriveFolderProblem(root, identity, s.home)).toBeUndefined()
  // A copy elsewhere is not the bound root.
  expect(matrixDriveRootEnrolled(root, { ...identity, origin: 'https://other.test' })).toBe(false)
})

it('calls a missing, linked or read-only folder unavailable', () => {
  const s = sandbox()
  expect(matrixDriveFolderProblem(path.join(s.home, 'missing'), identity, s.home)).toBe('folder_unavailable')
  const target = s.folder('Target')
  const link = path.join(s.home, 'Link')
  symlinkSync(target, link)
  expect(matrixDriveFolderProblem(link, identity, s.home)).toBe('folder_unavailable')
  const locked = s.folder('Locked')
  chmodSync(locked, 0o500)
  expect(matrixDriveFolderProblem(locked, identity, s.home)).toBe('folder_unavailable')
  chmodSync(locked, 0o700)
})

it('treats only folder codes as fixed by choosing another folder', () => {
  expect(matrixDriveFolderIssue('folder_not_empty')).toBe(true)
  expect(matrixDriveFolderIssue('folder_refused')).toBe(true)
  expect(matrixDriveFolderIssue('folder_changed')).toBe(false)
  expect(matrixDriveFolderIssue('network')).toBe(false)
  expect(matrixDriveFolderIssue(undefined)).toBe(false)
})

it('asks where Drive lives in the window’s language, Vietnamese when none is set', () => {
  for (const locale of ['en', 'vi', 'ja', 'zh', 'zh-hant']) {
    expect(matrixDriveFolderPrompt(locale)).toContain('Atum Drive')
  }

  expect(matrixDriveFolderPrompt(undefined)).toBe(matrixDriveFolderPrompt('vi'))
  expect(matrixDriveFolderPrompt('fr')).toBe(matrixDriveFolderPrompt('vi'))
  expect(new Set(['en', 'vi', 'ja', 'zh', 'zh-hant'].map(matrixDriveFolderPrompt)).size).toBe(5)
})

it('accepts the default ~/Atum/Drive beside the assistant’s files in ~/Atum, never ~/Atum itself once used', () => {
  const { home, folder } = sandbox()
  const atum = folder('Atum')
  writeFileSync(path.join(atum, 'notes from the assistant.md'), 'assistant work')
  const drive = folder('Atum', 'Drive')

  expect(matrixDriveFolderProblem(drive, identity, home)).toBeUndefined()
  expect(matrixDriveFolderProblem(atum, identity, home)).toBe('folder_not_empty')
  writeFileSync(path.join(drive, 'Tokenomics.pdf'), 'a file')
  expect(matrixDriveFolderProblem(drive, identity, home)).toBe('folder_not_empty')
})

// ── The person's own choice: "Choose another folder…" ────────────────────────────────────────

it('uses a chosen empty folder as it is, and makes nothing inside it', () => {
  const s = sandbox()
  const empty = s.folder('Sync')
  expect(matrixDriveChosenRoot(empty, identity, { home: s.home })).toEqual({ root: empty })
  expect(readdirSync(empty)).toEqual([])
})

it('makes a private “Atum Drive” inside a chosen folder that already has files, and never touches those files', () => {
  const s = sandbox()
  const documents = s.folder('Documents')
  writeFileSync(path.join(documents, 'report.docx'), 'x')
  const nested = path.join(documents, 'Atum Drive')
  expect(matrixDriveChosenRoot(documents, identity, { home: s.home })).toEqual({ root: nested })
  expect(lstatSync(nested).mode & 0o777).toBe(0o700)
  expect(readdirSync(documents).sort()).toEqual(['Atum Drive', 'report.docx'])
})

it('reuses an “Atum Drive” there that is empty or already this owner’s Drive', () => {
  const s = sandbox()
  const documents = s.folder('Documents')
  writeFileSync(path.join(documents, 'report.docx'), 'x')
  const nested = s.folder('Documents', 'Atum Drive')
  writeFileSync(path.join(nested, '.DS_Store'), '')
  expect(matrixDriveChosenRoot(documents, identity, { home: s.home })).toEqual({ root: nested })
  s.bind(nested)
  writeFileSync(path.join(nested, 'synced.txt'), 'x')
  expect(matrixDriveChosenRoot(documents, identity, { home: s.home })).toEqual({ root: nested })
})

it('refuses an “Atum Drive” there with other files, another account’s Drive or a link, and never numbers a second one', () => {
  const s = sandbox()
  const documents = s.folder('Documents')
  writeFileSync(path.join(documents, 'report.docx'), 'x')
  const nested = s.folder('Documents', 'Atum Drive')
  writeFileSync(path.join(nested, 'old.txt'), 'x')
  expect(matrixDriveChosenRoot(documents, identity, { home: s.home })).toEqual({ problem: 'folder_nested_taken' })
  expect(readdirSync(documents).sort()).toEqual(['Atum Drive', 'report.docx'])

  rmSync(path.join(nested, 'old.txt'))
  s.bind(nested, { subject: 'owner-b' })
  expect(matrixDriveChosenRoot(documents, identity, { home: s.home })).toEqual({ problem: 'folder_nested_taken' })

  const linked = s.folder('Linked')
  writeFileSync(path.join(linked, 'report.docx'), 'x')
  symlinkSync(s.folder('Elsewhere'), path.join(linked, 'Atum Drive'))
  expect(matrixDriveChosenRoot(linked, identity, { home: s.home })).toEqual({ problem: 'folder_nested_taken' })
  expect(readdirSync(linked).sort()).toEqual(['Atum Drive', 'report.docx'])
})

it('the home folder itself gets “Atum Drive” inside it; what contains home, and the disk, stay refused', () => {
  const s = sandbox()
  writeFileSync(path.join(s.home, '.zshrc'), 'x')
  expect(matrixDriveChosenRoot(s.home, identity, { home: s.home })).toEqual({ root: path.join(s.home, 'Atum Drive') })
  expect(matrixDriveChosenRoot(path.dirname(s.home), identity, { home: s.home })).toEqual({ problem: 'folder_home' })
  expect(matrixDriveChosenRoot(path.parse(s.home).root, identity, { home: s.home })).toEqual({ problem: 'folder_home' })
})

it('choosing ~/Atum (the assistant’s folder) means ~/Atum/Drive, made when missing', () => {
  const s = sandbox()
  const atum = s.folder('Atum')
  writeFileSync(path.join(atum, 'notes from the assistant.md'), 'assistant work')
  const defaultFolder = path.join(atum, 'Drive')
  expect(matrixDriveChosenRoot(atum, identity, { home: s.home, defaultFolder })).toEqual({ root: defaultFolder })
  expect(readdirSync(atum).sort()).toEqual(['Drive', 'notes from the assistant.md'])
  writeFileSync(path.join(defaultFolder, 'stray.txt'), 'x')
  expect(matrixDriveChosenRoot(atum, identity, { home: s.home, defaultFolder })).toEqual({ problem: 'folder_nested_taken' })
})

it('keeps refusing app folders, folders inside a Drive, another account’s Drive and links when chosen', () => {
  const s = sandbox()
  const protectedFolder = s.folder('.hermes', 'files')
  writeFileSync(path.join(protectedFolder, 'state.db'), 'x')
  expect(matrixDriveChosenRoot(protectedFolder, identity, { home: s.home })).toEqual({ problem: 'folder_protected' })
  expect(readdirSync(protectedFolder)).toEqual(['state.db'])

  const outer = s.folder('Atum Drive')
  s.bind(outer)
  const inner = s.folder('Atum Drive', 'Inner')
  writeFileSync(path.join(inner, 'x.txt'), 'x')
  expect(matrixDriveChosenRoot(inner, identity, { home: s.home })).toEqual({ problem: 'folder_in_drive' })

  const foreign = s.folder('Their Drive')
  s.bind(foreign, { subject: 'owner-b' })
  expect(matrixDriveChosenRoot(foreign, identity, { home: s.home })).toEqual({ problem: 'folder_other_drive' })

  const link = path.join(s.home, 'Link')
  symlinkSync(s.folder('Target'), link)
  expect(matrixDriveChosenRoot(link, identity, { home: s.home })).toEqual({ problem: 'folder_unavailable' })
})

it('a chosen folder Atum cannot write into is unavailable, and nothing is left behind', () => {
  const s = sandbox()
  const locked = s.folder('Locked')
  writeFileSync(path.join(locked, 'report.docx'), 'x')
  chmodSync(locked, 0o500)
  expect(matrixDriveChosenRoot(locked, identity, { home: s.home })).toEqual({ problem: 'folder_unavailable' })
  chmodSync(locked, 0o700)
  expect(readdirSync(locked)).toEqual(['report.docx'])
})

it('prepares the default folder private, parents included, and removes one it made but cannot use', () => {
  const s = sandbox()
  const folder = path.join(s.home, 'Atum', 'Drive')
  expect(matrixDrivePrepareFolder(folder, identity, { home: s.home, parents: true })).toEqual({ root: folder, created: true })
  expect(lstatSync(folder).mode & 0o777).toBe(0o700)
  expect(matrixDrivePrepareFolder(folder, identity, { home: s.home })).toEqual({ root: folder })

  const inside = path.join(s.home, '.hermes', 'Drive')
  mkdirSync(path.dirname(inside))
  expect(matrixDrivePrepareFolder(inside, identity, { home: s.home })).toEqual({ problem: 'folder_protected' })
  expect(readdirSync(path.dirname(inside))).toEqual([])
})

/** A FIFO at `file`; false where `mkfifo` does not exist, and the caller skips with that reason. */
function makeFifo(file: string): boolean {
  try {
    execFileSync('mkfifo', [file])

    return true
  } catch {
    return false
  }
}

/**
 * If the code under test blocks opening a FIFO for reading (the bug), this opens its other end
 * after `seconds`, so a regression is a failed assertion on the time taken instead of a hung run.
 * The returned function stops the helper.
 */
function releaseFifoAfter(file: string, seconds: number): () => void {
  const helper = spawn('sh', ['-c', 'sleep "$1"; exec 3>"$2"; sleep 30', 'sh', String(seconds), file], {
    stdio: 'ignore'
  })

  return () => void helper.kill('SIGKILL')
}

it('a FIFO named like the owner marker is no binding and never blocks the folder checks', ctx => {
  const s = sandbox()
  const root = s.folder('Atum Drive')

  if (!makeFifo(path.join(root, '.atum-drive-binding.json'))) {
    ctx.skip('mkfifo is not available on this platform')
  }

  const stop = releaseFifoAfter(path.join(root, '.atum-drive-binding.json'), 2)

  try {
    const started = Date.now()
    expect(matrixDriveRootEnrolled(root, identity)).toBe(false)
    expect(matrixDriveFolderProblem(root, identity, s.home)).toBe('folder_other_drive')
    expect(matrixDriveChosenRoot(root, identity, { home: s.home })).toEqual({ problem: 'folder_other_drive' })
    // Nothing waited for the other end: a reader that blocked here would only return after 2 s.
    expect(Date.now() - started).toBeLessThan(1500)
  } finally {
    stop()
  }

  // The folder and the FIFO in it are left exactly as they were.
  expect(lstatSync(path.join(root, '.atum-drive-binding.json')).isFIFO()).toBe(true)
})

it('a marker that is a link or a directory is not a binding either, and is never opened', () => {
  const s = sandbox()
  const linked = s.folder('Linked')
  const target = path.join(s.home, 'elsewhere.json')
  s.bind(linked)
  writeFileSync(target, readFileSync(path.join(linked, '.atum-drive-binding.json')))
  rmSync(path.join(linked, '.atum-drive-binding.json'))
  symlinkSync(target, path.join(linked, '.atum-drive-binding.json'))
  expect(matrixDriveRootEnrolled(linked, identity)).toBe(false)
  const directory = s.folder('Directory')
  mkdirSync(path.join(directory, '.atum-drive-binding.json'))
  expect(matrixDriveRootEnrolled(directory, identity)).toBe(false)
  expect(matrixDriveFolderProblem(directory, identity, s.home)).toBe('folder_other_drive')
})

it('names the real directory with its own identity, and nothing that is a link, a file or gone', () => {
  const s = sandbox()
  const root = s.folder('Atum Drive')
  const stat = lstatSync(root)
  expect(matrixDriveResolveDirectory(root)).toEqual({ root, dev: stat.dev, ino: stat.ino })
  const link = path.join(s.home, 'Link')
  symlinkSync(root, link)
  expect(matrixDriveResolveDirectory(link)).toBeUndefined()
  const file = path.join(s.home, 'file.txt')
  writeFileSync(file, 'x')
  expect(matrixDriveResolveDirectory(file)).toBeUndefined()
  expect(matrixDriveResolveDirectory(path.join(s.home, 'gone'))).toBeUndefined()
})

it.each([
  ['the identity check', (root: string) => matrixDriveResolveDirectory(root), undefined],
  [
    'the folder check',
    (root: string, home: string) => matrixDriveFolderProblem(root, identity, home),
    'folder_unavailable'
  ],
  [
    'a picked folder',
    (root: string, home: string) => matrixDriveChosenRoot(root, identity, { home }),
    { problem: 'folder_unavailable' }
  ],
  [
    'a prepared folder',
    (root: string, home: string) => matrixDrivePrepareFolder(root, identity, { home }),
    { problem: 'folder_unavailable' }
  ]
])(
  '%s refuses a folder swapped for another between its steps, and leaves both folders alone',
  (_name, check, expected) => {
    const s = sandbox()
    const root = s.folder('Atum Drive')
    writeFileSync(path.join(root, 'keep.txt'), 'original files stay put')
    const original = lstatSync(root)
    let swapped = 0

    fsHooks.beforeRealpath = target => {
      if (target === root && !swapped++) {
        // Between the folder being looked at and being resolved, another empty folder takes its place.
        renameSync(root, root + '-old')
        mkdirSync(root)
      }
    }

    expect(check(root, s.home)).toEqual(expected)
    expect(swapped).toBe(1)
    fsHooks.beforeRealpath = undefined
    expect(readFileSync(path.join(root + '-old', 'keep.txt'), 'utf8')).toBe('original files stay put')
    expect(lstatSync(root + '-old').ino).toBe(original.ino)
    expect(readdirSync(root)).toEqual([])
  }
)
