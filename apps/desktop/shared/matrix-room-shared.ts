/**
 * What a chat has shared (photos and videos, files, links), for its conversation info panel.
 *
 * Matrix has no media-gallery or link index. Photos, videos and files come from the room's own
 * history through `/messages` with a standard `RoomEventFilter`: in a room without end-to-end
 * encryption the server filters (`types: ["m.room.message"]` and `contains_url: true`); in an
 * encrypted room the server can see only `m.room.encrypted`, so the SDK pages that stream and
 * decrypts each event on this device. Links are never indexed anywhere: they are read out of
 * message text on this device, from the same bounded pages. Every read is a few pages at most;
 * nothing walks the whole history on open.
 */

export type MatrixRoomSharedSection = 'media' | 'files' | 'links'

export const MATRIX_ROOM_SHARED_SECTIONS: readonly MatrixRoomSharedSection[] = ['media', 'files', 'links']

/** Events per `/messages` page. */
export const MATRIX_ROOM_SHARED_PAGE_EVENTS = 50
/** Pages one read may cross: a panel opening asks for a few items, "See all" for a page more. */
export const MATRIX_ROOM_SHARED_MAX_PAGES = 4
/** The most items one read answers with. */
export const MATRIX_ROOM_SHARED_MAX_ITEMS = 60
/** Links read out of one message, at most. */
export const MATRIX_ROOM_SHARED_LINKS_PER_MESSAGE = 5
export const MATRIX_ROOM_SHARED_URL_MAX = 2048
/** A thumbnail, or the photo itself when the sender attached no thumbnail, at most this big. */
export const MATRIX_ROOM_SHARED_THUMBNAIL_MAX_BYTES = 8 * 1024 * 1024

export interface MatrixRoomSharedItem {
  /** Unique within a room: the event ID, plus `#n` for the n-th link of one message. */
  id: string
  eventId: string
  sender: string
  at: number
  kind: 'image' | 'video' | 'file' | 'audio' | 'link'
  /** A file's name, as its event gives it. */
  name?: string
  mimeType?: string
  size?: number
  /** A link (`kind: 'link'`): the address as written, http(s) only. */
  url?: string
  /** A photo, or a video with a thumbnail of its own: the panel may ask for its picture. */
  preview?: true
}

export interface MatrixRoomSharedPage {
  section: MatrixRoomSharedSection
  items: MatrixRoomSharedItem[]
  /** Where an older page starts (`/messages` `end`); absent once the room's start is reached. */
  next?: string
  /** `server`: the homeserver filtered the history. `device`: the room is encrypted and this
   * device read and decrypted it page by page. */
  source: 'server' | 'device'
  /** Events in the pages read that this device could not decrypt (encrypted rooms only). */
  unreadable: number
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/giu
const TRAILING = /[.,;:!?'"*_~]+$/u

/** Closes a bracket the text opened before the link, never one the address itself opened. */
function trimUnbalanced(value: string): string {
  let url = value.replace(TRAILING, '')

  for (const [open, close] of [
    ['(', ')'],
    ['[', ']'],
    ['{', '}']
  ] as const) {
    while (url.endsWith(close) && url.split(open).length < url.split(close).length) {
      url = url.slice(0, -1).replace(TRAILING, '')
    }
  }

  return url
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u
// A CommonMark code span: a backtick run closed by a run of the same length.
const CODE_SPAN = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/gu

/**
 * Text with its code taken out (CommonMark fenced blocks and inline code spans): an address in
 * code is something being shown, not shared. A fence left open runs to the end, as CommonMark
 * reads it; a lone backtick is plain text.
 */
function withoutCode(text: string): string {
  let fence: { char: string; length: number } | undefined

  const prose = text.split('\n').map(line => {
    const marker = FENCE.exec(line)

    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) {
        fence = undefined
      }

      return ''
    }

    // A backtick fence's info string may not hold a backtick; such a line is inline code instead.
    if (marker && !(marker[1]![0] === '`' && marker[2]!.includes('`'))) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length }

      return ''
    }

    return line
  })

  return prose.join('\n').replace(CODE_SPAN, ' ')
}

/**
 * The web links a message's text holds, as written, in order and without repeats: http(s) only,
 * each one a URL that parses, at most `MATRIX_ROOM_SHARED_LINKS_PER_MESSAGE`. Markdown's
 * `[label](url)` and `<url>` forms are read too, since their address is in the text; addresses
 * inside inline code or a fenced code block are not links.
 */
export function matrixLinksInText(body: string): string[] {
  const found: string[] = []

  for (const match of withoutCode(body).matchAll(URL_IN_TEXT)) {
    const url = trimUnbalanced(match[0])

    if (url.length > MATRIX_ROOM_SHARED_URL_MAX || found.includes(url)) {
      continue
    }

    try {
      const parsed = new URL(url)

      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname) {
        found.push(url)
      }
    } catch {
      continue
    }

    if (found.length >= MATRIX_ROOM_SHARED_LINKS_PER_MESSAGE) {
      break
    }
  }

  return found
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

const MXC = /^mxc:\/\/[^/\s?#]+\/[^/\s?#]+$/u

/** Whether a message's content names its media: an encrypted `file` or, where allowed, a plain `url`. */
function hasMedia(content: Record<string, unknown>, plain: boolean): boolean {
  const file = record(content.file)

  return file
    ? typeof file.url === 'string' && MXC.test(file.url)
    : plain && typeof content.url === 'string' && MXC.test(content.url)
}

function hasThumbnail(content: Record<string, unknown>, plain: boolean): boolean {
  const info = record(content.info)
  const file = record(info?.thumbnail_file)

  return file
    ? typeof file.url === 'string' && MXC.test(file.url)
    : plain && typeof info?.thumbnail_url === 'string' && MXC.test(info.thumbnail_url)
}

/**
 * One message's shared items for a section, from its decrypted content. `plain`: the event came
 * as plaintext in a room without encryption, so a plain media `url` counts; in an encrypted room a
 * file must be an encrypted one (`file`), as Save requires (no downgrade). Edits, replies' quoted
 * text and anything without a body give nothing new: an edit's links are its original's.
 */
export function matrixRoomSharedItems(
  section: MatrixRoomSharedSection,
  event: { eventId: string; sender: string; at: number; content: unknown; plain: boolean }
): MatrixRoomSharedItem[] {
  const content = record(event.content)
  const relation = record(content?.['m.relates_to'])

  if (!content || relation?.rel_type === 'm.replace' || typeof content.msgtype !== 'string') {
    return []
  }

  const base = { eventId: event.eventId, sender: event.sender, at: event.at }
  const msgtype = content.msgtype

  if (section === 'links') {
    if (!['m.text', 'm.notice', 'm.emote'].includes(msgtype) || typeof content.body !== 'string') {
      return []
    }

    // A reply's fallback quotes the message it answers ("> <@a:b> …"); its links are that message's.
    const own = content.body
      .split('\n')
      .filter(
        (line, index, lines) => !(line.startsWith('> ') && lines.slice(0, index).every(each => each.startsWith('> ')))
      )
      .join('\n')

    return matrixLinksInText(own).map((url, index) => ({
      ...base,
      id: index === 0 ? event.eventId : `${event.eventId}#${index}`,
      kind: 'link' as const,
      url
    }))
  }

  const media = msgtype === 'm.image' || msgtype === 'm.video'
  const file = msgtype === 'm.file' || msgtype === 'm.audio'

  if ((section === 'media' ? !media : !file) || !hasMedia(content, event.plain)) {
    return []
  }

  const info = record(content.info)
  const rawName = typeof content.filename === 'string' ? content.filename : content.body
  const name = typeof rawName === 'string' && rawName.trim() && [...rawName].length <= 512 ? rawName.trim() : undefined
  const mimeType = typeof info?.mimetype === 'string' && info.mimetype.length <= 255 ? info.mimetype : undefined
  const size = Number.isSafeInteger(info?.size) && Number(info?.size) >= 0 ? Number(info?.size) : undefined
  const preview = msgtype === 'm.image' || hasThumbnail(content, event.plain)

  return [
    {
      ...base,
      id: event.eventId,
      kind:
        msgtype === 'm.image' ? 'image' : msgtype === 'm.video' ? 'video' : msgtype === 'm.audio' ? 'audio' : 'file',
      ...(name ? { name } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(size === undefined ? {} : { size }),
      ...(preview ? { preview: true as const } : {})
    }
  ]
}

/** The `/messages` timeline filter for one section of a room: what the server can narrow. */
export function matrixRoomSharedFilter(section: MatrixRoomSharedSection, encrypted: boolean): Record<string, unknown> {
  if (encrypted) {
    // The server sees only ciphertext: the type is all it can filter on.
    return { types: ['m.room.encrypted'], lazy_load_members: true }
  }

  return { types: ['m.room.message'], contains_url: section !== 'links', lazy_load_members: true }
}

/** A `/messages` pagination token as the renderer may hand it back: opaque, printable, bounded. */
export function validMatrixRoomSharedToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 4096 && /^[!-~]+$/u.test(value)
}

/** The picture types a thumbnail may be shown as, read from the bytes, never from the event. */
export function matrixRoomSharedImageType(
  bytes: Uint8Array
): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }

  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) {
    return 'image/png'
  }

  if (
    bytes.length >= 12 &&
    [0x52, 0x49, 0x46, 0x46].every((value, index) => bytes[index] === value) &&
    [0x57, 0x45, 0x42, 0x50].every((value, index) => bytes[index + 8] === value)
  ) {
    return 'image/webp'
  }

  if ([0x47, 0x49, 0x46, 0x38].every((value, index) => bytes[index] === value)) {
    return 'image/gif'
  }

  return undefined
}
