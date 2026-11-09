/** Protected home folders the assistant may read only when a real task needs them. */
export const MATRIX_JUST_IN_TIME_FOLDERS = [
  { name: 'Desktop', usage: 'NSDesktopFolderUsageDescription' },
  { name: 'Documents', usage: 'NSDocumentsFolderUsageDescription' },
  { name: 'Downloads', usage: 'NSDownloadsFolderUsageDescription' }
] as const

const PROTECTED_FOLDER = /(?:^|[\\/])(?:Desktop|Documents|Downloads)(?:[\\/]|$|["'\s])/iu
const PERMISSION_DENIAL = /(?:operation not permitted|permission denied|not authori[sz]ed|\bEACCES\b|\bEPERM\b)/iu

/** Native-only classification: raw tool arguments and results never cross into the renderer. */
export function matrixJustInTimeFolderDenied(tool: string, payload: unknown): boolean {
  if (tool !== 'read_file' && tool !== 'search_files') {
    return false
  }

  let text = ''

  try {
    text = JSON.stringify(payload).slice(0, 16_384)
  } catch {
    return false
  }

  return PROTECTED_FOLDER.test(text) && PERMISSION_DENIAL.test(text)
}
