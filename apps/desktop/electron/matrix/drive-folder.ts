import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  rmdirSync
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import type { MatrixDriveProblem } from '../../shared/matrix-drive'

export interface MatrixDriveFolderIdentity {
  issuer: string
  subject: string
  origin: string
}

const marker = '.atum-drive-binding.json'

// The engine's own allowance in an otherwise empty root (atumrootbinding.cpp emptyForEnrollment).
const ignored = new Set(['.DS_Store', '.atum-drive-owner.lock'])

// Path components the engine never enrolls (atumrootbinding.cpp safeRoot), compared without case.
const managed = new Set(
  ['.ssh', '.aws', '.codex', '.agents', '.hermes', '.atum', '.atum-managed', '.protected-skills', 'node_modules', '.venv'].map(
    name => name.toLowerCase()
  )
)

/**
 * Opens `root`'s owner marker for reading, or returns null when what sits at that name is not a
 * regular file (a directory, a link, a FIFO, a socket). A missing marker throws, as `open` does.
 * Nothing but a regular file is ever opened: a FIFO named like the marker would otherwise block
 * the opener (the main process) until some other process opened its other end. `lstat` rules the
 * name out first; O_NONBLOCK covers the name being swapped for a FIFO after that check, and the
 * handle's own `fstat` is the final word on what was opened.
 */
export function openMatrixDriveMarker(root: string): number | null {
  const file = path.join(root, marker)

  if (!lstatSync(file).isFile()) {
    return null
  }

  const handle = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)

  try {
    if (fstatSync(handle).isFile()) {
      return handle
    }
  } catch {
    // Treated as not a regular file below.
  }

  closeSync(handle)

  return null
}

function readMarker(root: string): Record<string, unknown> | null {
  const handle = openMatrixDriveMarker(root)

  if (handle === null) {
    return null
  }

  try {
    const stat = fstatSync(handle)

    if (!stat.isFile() || stat.size > 16_384) {
      return null
    }

    const bytes = Buffer.alloc(16_385)
    const length = readSync(handle, bytes, 0, bytes.length, 0)
    const value = JSON.parse(bytes.subarray(0, length).toString('utf8')) as unknown

    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  } finally {
    closeSync(handle)
  }
}

export interface MatrixDriveDirectory {
  /** The canonical path of the directory. */
  root: string
  dev: number
  ino: number
}

/**
 * The real directory `folder` names, with its device and inode, read so that the identity belongs
 * to the path that was validated: `lstat` (not a link, a directory), `realpath`, then `lstat` of
 * the result. A path swapped for another directory or a link between those steps shows as a
 * different device/inode and is refused (undefined), so a stale identity is never bound.
 */
export function matrixDriveResolveDirectory(folder: string): MatrixDriveDirectory | undefined {
  try {
    const before = lstatSync(folder)

    if (before.isSymbolicLink() || !before.isDirectory()) {
      return undefined
    }

    const root = realpathSync(folder)
    const after = lstatSync(root)

    if (after.isSymbolicLink() || !after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) {
      return undefined
    }

    return { root, dev: after.dev, ino: after.ino }
  } catch {
    return undefined
  }
}

function hasMarker(folder: string): boolean {
  try {
    lstatSync(path.join(folder, marker))

    return true
  } catch {
    return false
  }
}

/**
 * True when `root` carries this owner's Atum Drive binding, written by the engine on its first
 * successful enrollment. Such a root holds sync state, so the desktop never drops it on its own.
 */
export function matrixDriveRootEnrolled(root: string, identity: MatrixDriveFolderIdentity): boolean {
  try {
    if (!hasMarker(root)) {
      return false
    }

    const binding = readMarker(root)

    return Boolean(
      binding &&
      binding.version === 1 &&
      binding.canonicalRoot === root &&
      binding.issuer === identity.issuer &&
      binding.subject === identity.subject &&
      binding.origin === identity.origin &&
      binding.journal === '.atum-drive-journal.db' &&
      typeof binding.space === 'string' &&
      binding.space.includes('$')
    )
  } catch {
    return false
  }
}

function emptyForEnrollment(root: string): boolean {
  const directory = opendirSync(root)

  try {
    // Stops at the first real entry: a folder of a million files costs one read.
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (!ignored.has(entry.name)) {
        return false
      }
    }

    return true
  } finally {
    directory.closeSync()
  }
}

/**
 * Why the engine would refuse `root` as a new Drive folder, checked before anything is saved or
 * started, mirroring the engine's candidate rules (atumrootbinding.cpp checkCandidate) so a
 * refusal can say what to do. The engine stays the authority: another app's sync-root tags,
 * which this does not read, still come back from the engine as a plain refusal.
 */
export function matrixDriveFolderProblem(
  root: string,
  identity: MatrixDriveFolderIdentity,
  home: string = homedir()
): MatrixDriveProblem | undefined {
  if (matrixDriveResolveDirectory(root)?.root !== root) {
    return 'folder_unavailable'
  }

  let canonicalHome = ''

  try {
    canonicalHome = realpathSync(home)
  } catch {
    canonicalHome = path.resolve(home)
  }

  if (root === canonicalHome || canonicalHome.startsWith(root + path.sep) || path.parse(root).root === root) {
    return 'folder_home'
  }

  if (root.split(path.sep).some(part => managed.has(part.toLowerCase()))) {
    return 'folder_protected'
  }

  try {
    accessSync(root, constants.R_OK | constants.W_OK)
  } catch {
    return 'folder_unavailable'
  }

  for (let parent = path.dirname(root); ; parent = path.dirname(parent)) {
    if (hasMarker(parent)) {
      return 'folder_in_drive'
    }

    if (path.dirname(parent) === parent) {
      break
    }
  }

  try {
    if (hasMarker(root)) {
      return matrixDriveRootEnrolled(root, identity) ? undefined : 'folder_other_drive'
    }

    return emptyForEnrollment(root) ? undefined : 'folder_not_empty'
  } catch {
    return 'folder_unavailable'
  }
}

/** The folder Atum makes inside a chosen folder that already has files. Never numbered: a second
 * parallel Drive folder is exactly what one Atum-owned root avoids. */
export const MATRIX_DRIVE_NESTED_FOLDER = 'Atum Drive'

export type MatrixDriveFolderChoice = { root: string } | { problem: MatrixDriveProblem }

/**
 * `folder` as a new Drive folder: made private (0700) when missing, with every rule of
 * `matrixDriveFolderProblem`; a folder made here and then refused is removed again (rmdir, so only
 * while still empty). `parents` also makes the missing folders above it (the default's `~/Atum`).
 */
export function matrixDrivePrepareFolder(
  folder: string,
  identity: MatrixDriveFolderIdentity,
  options: { home?: string; parents?: boolean } = {}
): MatrixDriveFolderChoice & { created?: boolean } {
  let created = false

  try {
    if (options.parents) {
      mkdirSync(path.dirname(folder), { recursive: true, mode: 0o700 })
    }

    mkdirSync(folder, { mode: 0o700 })
    created = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      return { problem: 'folder_unavailable' }
    }
  }

  try {
    const root = matrixDriveResolveDirectory(folder)?.root

    if (!root) {
      return { problem: 'folder_unavailable' }
    }

    const problem = matrixDriveFolderProblem(root, identity, options.home)

    if (problem) {
      if (created) {
        rmdirSync(folder)
      }

      return { problem }
    }

    return created ? { root, created } : { root }
  } catch {
    return { problem: 'folder_unavailable' }
  }
}

/**
 * The person's own choice in the folder picker. An empty folder (or this owner's own enrolled one)
 * is Drive as it is. One that already has files, or the home folder itself, gets an "Atum Drive"
 * folder inside it, used when it is absent (made), empty, or already this owner's Drive; any other
 * "Atum Drive" there is refused (`folder_nested_taken`), never numbered. `~/Atum` (the assistant's
 * folder) is Drive's own parent: choosing it means `~/Atum/Drive`. Every other refusal stands (a
 * filesystem root, an app's folder, a folder inside a Drive, another account's Drive, a symlink).
 * The engine still checks the result again (atumrootbinding.cpp) before it enrolls anything.
 */
export function matrixDriveChosenRoot(
  selected: string,
  identity: MatrixDriveFolderIdentity,
  options: { defaultFolder?: string; home?: string } = {}
): MatrixDriveFolderChoice {
  const root = matrixDriveResolveDirectory(selected)?.root

  if (!root) {
    return { problem: 'folder_unavailable' }
  }

  if (options.defaultFolder) {
    let parent = path.dirname(options.defaultFolder)

    try {
      parent = realpathSync(parent)
    } catch {
      // Not made yet: nothing chosen can be it.
    }

    if (root === parent) {
      return nested(path.join(root, path.basename(options.defaultFolder)), identity, options.home)
    }
  }

  const problem = matrixDriveFolderProblem(root, identity, options.home)

  if (!problem) {
    return { root }
  }

  let home = ''

  try {
    home = realpathSync(options.home ?? homedir())
  } catch {
    home = path.resolve(options.home ?? homedir())
  }

  if (problem !== 'folder_not_empty' && !(problem === 'folder_home' && root === home)) {
    return { problem }
  }

  return nested(path.join(root, MATRIX_DRIVE_NESTED_FOLDER), identity, options.home)
}

/** A Drive folder inside the chosen one: made when absent, used when empty or already ours. */
function nested(folder: string, identity: MatrixDriveFolderIdentity, home?: string): MatrixDriveFolderChoice {
  try {
    const stat = lstatSync(folder)

    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return { problem: 'folder_nested_taken' }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { problem: 'folder_unavailable' }
    }
  }

  const prepared = matrixDrivePrepareFolder(folder, identity, { home })

  return 'root' in prepared ? { root: prepared.root } : nestedRefusal(prepared.problem)
}

/** A Drive folder there that is already something else (other files, another account's Drive) is
 * said as one plain thing; the other refusals keep their own words. */
function nestedRefusal(problem: MatrixDriveProblem): MatrixDriveFolderChoice {
  return { problem: problem === 'folder_not_empty' || problem === 'folder_other_drive' ? 'folder_nested_taken' : problem }
}

/** True for the problems that come from the chosen folder, which another folder fixes. */
export function matrixDriveFolderIssue(problem: MatrixDriveProblem | undefined): boolean {
  return Boolean(problem?.startsWith('folder_') && problem !== 'folder_changed')
}

const folderPrompt = {
  en: 'Choose where Atum Drive lives. If the folder already has files, Atum makes an “Atum Drive” folder inside it.',
  vi: 'Chọn nơi đặt Atum Drive. Nếu thư mục đã có tệp, Atum sẽ tạo thư mục “Atum Drive” bên trong.',
  ja: 'Atum Drive の場所を選んでください。フォルダーにファイルがある場合は、その中に「Atum Drive」フォルダーを作成します。',
  zh: '选择 Atum Drive 的位置。如果文件夹里已有文件，Atum 会在其中新建“Atum Drive”文件夹。',
  'zh-hant': '選擇 Atum Drive 的位置。如果資料夾裡已有檔案，Atum 會在其中新增「Atum Drive」資料夾。'
} as const

/** The folder picker's line (macOS shows it above the panel), in the window's language;
 * Vietnamese, the default, when none is set. */
export function matrixDriveFolderPrompt(locale: string | undefined): string {
  return Object.hasOwn(folderPrompt, locale ?? '') ? folderPrompt[locale as keyof typeof folderPrompt] : folderPrompt.vi
}
