/**
 * Which Mac folders the owner shares with their assistants (first run and Settings › Connections).
 *
 * Everything starts ticked (opt-out). macOS has no per-folder Full Disk Access: Desktop,
 * Documents, Downloads and iCloud Drive each have their own one-time system prompt, which fires
 * the first time Atum lists the folder. Main fires those prompts only when the owner presses
 * Continue or turns a folder on, never in the background. A folder the owner picks with
 * "Add a folder…" needs no prompt: choosing it in the Open panel is the consent.
 *
 * Paths never cross this bridge: the renderer sees ids, kinds and an added folder's name only.
 */
export const MATRIX_STANDARD_FOLDERS = ['desktop', 'documents', 'downloads', 'icloud'] as const

export type MatrixStandardFolder = (typeof MATRIX_STANDARD_FOLDERS)[number]
export type MatrixFolderKind = MatrixStandardFolder | 'added'

/**
 * What macOS last said, as seen by main when it listed the folder:
 * `not-asked` until then, `granted`/`denied` after the prompt, `absent` when the folder is missing.
 */
export type MatrixFolderMacState = 'not-asked' | 'granted' | 'denied' | 'absent'

export interface MatrixFolderAccessRow {
  /** A standard folder's kind, or `added:<n>` for a folder the owner picked. */
  id: string
  kind: MatrixFolderKind
  /** Only for added folders: the folder's own name, never its path. */
  name?: string
  shared: boolean
  mac: MatrixFolderMacState
}

export interface MatrixFolderAccessView {
  platform: 'macos' | 'unsupported'
  folders: MatrixFolderAccessRow[]
}

/** Owner choices by row id; rows left out keep their saved choice. */
export type MatrixFolderAccessChoices = Record<string, boolean>

export const MATRIX_FOLDER_ACCESS_IPC = {
  read: 'matrix:folder-access:read',
  apply: 'matrix:folder-access:apply',
  add: 'matrix:folder-access:add',
  remove: 'matrix:folder-access:remove'
} as const

export interface MatrixFolderAccessBridge {
  read(): Promise<MatrixFolderAccessView>
  /** Saves the choices, then asks macOS for each newly shared standard folder, one at a time. */
  apply(choices: MatrixFolderAccessChoices): Promise<MatrixFolderAccessView>
  /** Opens the macOS folder picker; resolves the unchanged view when the owner cancels. */
  add(): Promise<MatrixFolderAccessView>
  remove(id: string): Promise<MatrixFolderAccessView>
}

const ROW_ID = /^(?:desktop|documents|downloads|icloud|added:[0-9]{1,4})$/u

export function isMatrixFolderAccessRowId(value: unknown): value is string {
  return typeof value === 'string' && ROW_ID.test(value)
}

/** The rows the owner has ticked; a row the owner has not touched keeps its saved state. */
export function matrixFolderAccessSelection(view: MatrixFolderAccessView): Set<string> {
  return new Set(view.folders.filter(row => row.shared).map(row => row.id))
}

/** Every row's choice from a selection, for one `apply` call. */
export function matrixFolderAccessChoices(
  view: MatrixFolderAccessView,
  selected: ReadonlySet<string>
): MatrixFolderAccessChoices {
  return Object.fromEntries(view.folders.map(row => [row.id, selected.has(row.id)]))
}
