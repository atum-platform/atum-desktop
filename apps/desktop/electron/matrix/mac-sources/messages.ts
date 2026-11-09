import { DatabaseSync } from 'node:sqlite'

import {
  MAC_MESSAGE_USAGE,
  type MacMessage,
  type MacMessageConversation,
  type MacSourcesResult
} from './contract'
import {
  isOtpLike,
  privateContactLabel,
  safeConversationTitle,
  sanitizeMessageText
} from './privacy'

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1)
const DAY_MS = 86_400_000

type OpenDatabase = (file: string) => DatabaseSync

export interface MessagesReaderOptions {
  databasePath: string
  now?: () => number
  open?: OpenDatabase
}

export class MacMessagesReadError extends Error {
  constructor(readonly code: 'permission_needed' | 'unavailable') {
    super(`matrix_mac_messages_${code}`)
  }
}

interface ConversationRow {
  id: number
  title: string | null
  lastAppleMs: number
  messageCount: number
  fromMeShare: number
  participantCount: number
}

interface ParticipantRow {
  id: string
}

interface MessageRow {
  fromMe: number
  sender: string | null
  appleMs: number
  text: string | null
  attributed: Uint8Array | null
  attachmentCount: number
  imageCount: number
}

function openReadOnly(file: string): DatabaseSync {
  return new DatabaseSync(file, { readOnly: true })
}

function sqlitePermissionFailure(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code ?? '')
  const message = String((error as { message?: unknown } | null)?.message ?? '')

  return (
    ['EACCES', 'EPERM', 'SQLITE_CANTOPEN'].some(value => code.includes(value)) ||
    /(?:authorization denied|not permitted|permission denied|unable to open database)/iu.test(message)
  )
}

function withMessagesDatabase<T>(options: MessagesReaderOptions, read: (db: DatabaseSync) => T): T {
  let database: DatabaseSync | undefined

  try {
    database = (options.open ?? openReadOnly)(options.databasePath)

    return read(database)
  } catch (error) {
    if (error instanceof MacMessagesReadError) {
      throw error
    }

    throw new MacMessagesReadError(sqlitePermissionFailure(error) ? 'permission_needed' : 'unavailable')
  } finally {
    try {
      database?.close()
    } catch {
      // The read already has its closed result.
    }
  }
}

function boundedInt(value: number, low: number, high: number): number {
  if (!Number.isSafeInteger(value) || value < low || value > high) {
    throw new MacMessagesReadError('unavailable')
  }

  return value
}

function cutoffAppleNanoseconds(now: number, days: number): bigint {
  return BigInt(Math.max(0, Math.trunc(now - days * DAY_MS - APPLE_EPOCH_MS))) * 1_000_000n
}

function appleMsToIso(value: number): string {
  const date = new Date(APPLE_EPOCH_MS + value)

  if (!Number.isFinite(value) || Number.isNaN(date.valueOf())) {
    throw new MacMessagesReadError('unavailable')
  }

  return date.toISOString()
}

function conversationParticipants(db: DatabaseSync, chatId: number): Array<{ handle: string }> {
  const rows = db
    .prepare(
      `SELECT h.id AS id
         FROM chat_handle_join AS chj
         JOIN handle AS h ON h.ROWID = chj.handle_id
        WHERE chj.chat_id = ?
        ORDER BY h.ROWID
        LIMIT 20`
    )
    .all(chatId) as unknown as ParticipantRow[]

  return rows.map(row => ({ handle: privateContactLabel(String(row.id ?? '')) }))
}

/** Recent relationship metadata only; no message body is selected by this operation. */
export function readMessageConversations(
  input: { days: number; limit: number },
  options: MessagesReaderOptions
): Extract<MacSourcesResult, { conversations: MacMessageConversation[] }> {
  const days = boundedInt(input.days, 1, 365)
  const limit = boundedInt(input.limit, 1, 40)
  const now = (options.now ?? Date.now)()

  return withMessagesDatabase(options, db => {
    const rows = db
      .prepare(
        `SELECT c.ROWID AS id,
                c.display_name AS title,
                CAST(MAX(m.date) / 1000000 AS INTEGER) AS lastAppleMs,
                COUNT(DISTINCT m.ROWID) AS messageCount,
                AVG(CASE WHEN m.is_from_me = 1 THEN 1.0 ELSE 0.0 END) AS fromMeShare,
                COUNT(DISTINCT chj.handle_id) AS participantCount
           FROM chat AS c
           JOIN chat_message_join AS cmj ON cmj.chat_id = c.ROWID
           JOIN message AS m ON m.ROWID = cmj.message_id
      LEFT JOIN chat_handle_join AS chj ON chj.chat_id = c.ROWID
          WHERE m.date >= ?
       GROUP BY c.ROWID
       ORDER BY MAX(m.date) DESC
          LIMIT ?`
      )
      .all(cutoffAppleNanoseconds(now, days), limit) as unknown as ConversationRow[]

    const conversations = rows.map(row => {
      const participants = conversationParticipants(db, row.id)
      const fallback = `Conversation ${row.id}`
      const title = safeConversationTitle(row.title, fallback)

      return {
        id: String(row.id),
        title,
        participants,
        isGroup: Number(row.participantCount) > 1,
        lastActivity: appleMsToIso(Number(row.lastAppleMs)),
        messageCount: Math.min(1_000_000, Math.max(0, Number(row.messageCount))),
        fromMeShare: Math.max(0, Math.min(1, Number(row.fromMeShare) || 0))
      }
    })

    return { conversations, usage: MAC_MESSAGE_USAGE }
  })
}

function messageText(row: MessageRow): string | null {
  if (typeof row.text === 'string' && row.text.trim()) {
    if (isOtpLike(row.text)) {
      return null
    }

    const sanitized = sanitizeMessageText(row.text)

    return !sanitized ? null : [...sanitized].slice(0, 500).join('')
  }

  if (Number(row.attachmentCount) > 0) {
    return Number(row.imageCount) > 0 ? 'Photo' : 'Attachment'
  }

  return null
}

/** Recent message text for theme extraction. Attributed bodies are counted and omitted honestly. */
export function readMessages(
  input: { id: string; days: number; limit: number },
  options: MessagesReaderOptions
): Extract<MacSourcesResult, { messages: MacMessage[] }> {
  const days = boundedInt(input.days, 1, 90)
  const limit = boundedInt(input.limit, 1, 60)

  if (!/^\d{1,18}$/u.test(input.id)) {
    throw new MacMessagesReadError('unavailable')
  }

  const chatId = Number(input.id)
  const now = (options.now ?? Date.now)()

  return withMessagesDatabase(options, db => {
    const rows = db
      .prepare(
        `SELECT m.is_from_me AS fromMe,
                h.id AS sender,
                CAST(m.date / 1000000 AS INTEGER) AS appleMs,
                m.text AS text,
                m.attributedBody AS attributed,
                COUNT(DISTINCT a.ROWID) AS attachmentCount,
                SUM(CASE WHEN a.mime_type LIKE 'image/%' THEN 1 ELSE 0 END) AS imageCount
           FROM chat_message_join AS cmj
           JOIN message AS m ON m.ROWID = cmj.message_id
      LEFT JOIN handle AS h ON h.ROWID = m.handle_id
      LEFT JOIN message_attachment_join AS maj ON maj.message_id = m.ROWID
      LEFT JOIN attachment AS a ON a.ROWID = maj.attachment_id
          WHERE cmj.chat_id = ? AND m.date >= ?
       GROUP BY m.ROWID
       ORDER BY m.date DESC
          LIMIT ?`
      )
      .all(chatId, cutoffAppleNanoseconds(now, days), limit) as unknown as MessageRow[]

    let omittedAttributedBodies = 0
    const messages: MacMessage[] = []

    for (const row of rows) {
      const text = messageText(row)

      if (!text) {
        if (!row.text && row.attributed) {
          omittedAttributedBodies += 1
        }
        continue
      }

      const fromMe = Number(row.fromMe) === 1
      messages.push({
        fromMe,
        sender: fromMe ? 'You' : privateContactLabel(String(row.sender ?? 'unknown')),
        at: appleMsToIso(Number(row.appleMs)),
        text
      })
    }

    return { messages, usage: MAC_MESSAGE_USAGE, omittedAttributedBodies }
  })
}
