import {
  File,
  FileCode,
  FileMusic,
  FileSpreadsheet,
  FileText,
  FileZip,
  Folder,
  Json,
  Movie,
  Photo,
  Presentation
} from '@/lib/icons'
import { cn } from '@/lib/utils'

export type ConsumerFileKind =
  | 'archive'
  | 'audio'
  | 'code'
  | 'data'
  | 'document'
  | 'folder'
  | 'image'
  | 'markdown'
  | 'pdf'
  | 'presentation'
  | 'spreadsheet'
  | 'text'
  | 'unknown'
  | 'video'

const KIND_BY_EXTENSION: Record<string, ConsumerFileKind> = {
  '.7z': 'archive', '.gz': 'archive', '.rar': 'archive', '.tar': 'archive', '.tgz': 'archive', '.zip': 'archive',
  '.aac': 'audio', '.flac': 'audio', '.m4a': 'audio', '.mp3': 'audio', '.ogg': 'audio', '.wav': 'audio',
  '.c': 'code', '.cpp': 'code', '.cs': 'code', '.css': 'code', '.go': 'code', '.h': 'code', '.html': 'code',
  '.htm': 'code', '.java': 'code', '.js': 'code', '.jsx': 'code', '.kt': 'code', '.mjs': 'code', '.php': 'code',
  '.py': 'code', '.rb': 'code', '.rs': 'code', '.scss': 'code', '.sh': 'code', '.sql': 'code', '.swift': 'code',
  '.ts': 'code', '.tsx': 'code', '.xml': 'code',
  '.csv': 'spreadsheet', '.numbers': 'spreadsheet', '.ods': 'spreadsheet', '.xls': 'spreadsheet', '.xlsx': 'spreadsheet',
  '.json': 'data', '.toml': 'data', '.yaml': 'data', '.yml': 'data',
  '.doc': 'document', '.docx': 'document', '.odt': 'document', '.pages': 'document', '.rtf': 'document',
  '.bmp': 'image', '.gif': 'image', '.heic': 'image', '.jpeg': 'image', '.jpg': 'image', '.png': 'image',
  '.svg': 'image', '.tiff': 'image', '.webp': 'image',
  '.markdown': 'markdown', '.md': 'markdown',
  '.pdf': 'pdf',
  '.key': 'presentation', '.odp': 'presentation', '.ppt': 'presentation', '.pptx': 'presentation',
  '.log': 'text', '.txt': 'text',
  '.avi': 'video', '.m4v': 'video', '.mkv': 'video', '.mov': 'video', '.mp4': 'video', '.webm': 'video'
}

export function consumerFileExtension(name: string): string {
  const dot = name.lastIndexOf('.')

  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

export function consumerFileKind(name: string, isDirectory: boolean): ConsumerFileKind {
  if (isDirectory) {
    return 'folder'
  }

  return KIND_BY_EXTENSION[consumerFileExtension(name)] ?? 'unknown'
}

/**
 * Row-scale glyph (md 16, muted). One outline family, monochrome: the kind is
 * told apart by shape, the exact format by the file name next to it. No status
 * tints — colour is reserved for avatars and errors.
 */
const KIND_ICON: Record<ConsumerFileKind, typeof FileText> = {
  archive: FileZip,
  audio: FileMusic,
  code: FileCode,
  data: Json,
  document: FileText,
  folder: Folder,
  image: Photo,
  markdown: FileText,
  pdf: FileText,
  presentation: Presentation,
  spreadsheet: FileSpreadsheet,
  text: FileText,
  unknown: File,
  video: Movie
}

export function ConsumerFileIcon({
  className,
  isDirectory,
  name
}: {
  className?: string
  isDirectory: boolean
  name: string
}) {
  const kind = consumerFileKind(name, isDirectory)
  const Icon = KIND_ICON[kind]

  return <Icon aria-hidden className={cn('size-4 text-(--atum-ink-muted)', className)} data-file-kind={kind} />
}

/** The type label a page glyph wears: the extension, upper-cased, at most four letters. */
export function consumerFileTypeLabel(name: string): string {
  const extension = consumerFileExtension(name).slice(1).toUpperCase()

  return extension.length > 4 ? extension.slice(0, 4) : extension
}

/**
 * Mock 1a Files grid: a folder is a 72×58 two-tone neutral glyph, a file is a
 * 52×64 white page (r7) with its format printed at the foot in 9/700 caps.
 * Neutral greys only — colour is reserved for avatars.
 */
export function ConsumerFileGlyph({ isDirectory, name }: { isDirectory: boolean; name: string }) {
  if (isDirectory) {
    return (
      <span aria-hidden className="relative block h-[3.625rem] w-[4.5rem]" data-atum-folder-glyph data-file-kind="folder">
        <span className="absolute left-0 top-0 h-4 w-[2.125rem] rounded-t-[0.375rem] bg-(--atum-folder-tab)" />
        <span
          className="absolute inset-x-0 bottom-0 top-2 rounded-[0.5rem] bg-[image:var(--atum-folder-body)] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]"
        />
      </span>
    )
  }

  return (
    <span
      aria-hidden
      className="grid h-16 w-[3.25rem] place-items-end justify-items-center rounded-[0.4375rem] bg-(--atum-page) pb-[7px] text-[0.5625rem] font-bold uppercase leading-none text-(--atum-ink-muted) shadow-(--atum-shadow-tile)"
      data-atum-page-glyph
      data-file-kind={consumerFileKind(name, false)}
    >
      {consumerFileTypeLabel(name)}
    </span>
  )
}
