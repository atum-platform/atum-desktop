import type { MatrixRoom } from '../../shared/matrix'

export interface MatrixChatTitleCopy {
  locale: string
  /** A chat with no name of its own (Matrix found none). */
  untitled: string
  /** A history named by its date. */
  chatOn(date: string): string
}

/** A date the way the person's language writes a day: "4/10" in Vietnamese, "Oct 4" in
 * English, "10月4日" in Japanese and Chinese; with the year when it is not this year. */
export function matrixChatDate(at: number, locale: string, now = Date.now()): string {
  const date = new Date(at)
  const thisYear = date.getFullYear() === new Date(now).getFullYear()

  const options: Intl.DateTimeFormatOptions =
    locale === 'vi'
      ? { day: 'numeric', month: 'numeric', ...(thisYear ? {} : { year: 'numeric' }) }
      : { day: 'numeric', month: 'short', ...(thisYear ? {} : { year: 'numeric' }) }

  return new Intl.DateTimeFormat(locale, options).format(date)
}

/**
 * The name a chat goes by on screen (launch night). Your own name for it first. An
 * assistant's history — whose room name is only the assistant's — is titled by your first
 * message in it, else by the day it began, so histories never all read the same. Any other
 * chat keeps the name the room knows it by.
 */
export function matrixChatTitle(room: MatrixRoom, copy: MatrixChatTitleCopy, now = Date.now()): string {
  if (room.title?.trim()) {
    return room.title.trim()
  }

  if (room.assistant) {
    const started = room.createdAt ?? room.lastActiveAt

    return room.firstLine?.trim() || (started !== undefined ? copy.chatOn(matrixChatDate(started, copy.locale, now)) : copy.untitled)
  }

  return room.name.trim() || copy.untitled
}
