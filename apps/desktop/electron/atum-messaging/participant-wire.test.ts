import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'vitest'

import { parseParticipantSnapshot } from '../../shared/atum-participants'

import { AtumMessagingStore } from './store'
import { parseCanonicalMessage } from './wire'

const fixture = JSON.parse(readFileSync(new URL('../../../../spec/participants/v1/fixtures.json', import.meta.url), 'utf8'))

test('flat participant bytes survive wire → SQLite restart → renderer without authority material', () => {
  const directory = mkdtempSync(join(tmpdir(), 'atum-participants-'))
  const databasePath = join(directory, 'messages.sqlite')
  let store = new AtumMessagingStore({ accountId: fixture.refs[0].id, databasePath })

  try {
    const metadata = process.env.ATUM_PARTICIPANT_SQL_PROJECTION
      ? JSON.parse(readFileSync(process.env.ATUM_PARTICIPANT_SQL_PROJECTION, 'utf8'))
      : { participant: { ...fixture.snapshots.aliceMoon, app_installation_id: fixture.refs[2].app_installation_id,
          subject: 'private', link_epoch: 7, ref: fixture.refs[2] } }

    const raw = JSON.parse(JSON.stringify({ id: 'message-1', conversation_id: 'conversation-1', sender: { type: 'specialist', id: 'moon' },
      content: 'Hello', kind: 'text', attachments: [], metadata, reply_to_message_id: null, forwarded_from: null,
      reactions: [], version: 1, created_at: '2026-09-07T00:00:00.000Z', edited_at: null, recalled_at: null, delivery: 'sent' }))

    store.upsertConversation({ id: 'conversation-1', kind: 'specialist', title: 'Moon', participantIds: ['moon'], updatedAt: raw.created_at, lastMessageAt: null, payload: { specialist: 'moon' } })
    store.canonicalizeMessage({ message: parseCanonicalMessage(raw) })
    store.close()
    store = new AtumMessagingStore({ accountId: fixture.refs[0].id, databasePath })
    const message = store.listMessages('conversation-1')[0]
    expect(message.metadata?.participant).toEqual(fixture.snapshots.aliceMoon)
    expect(parseParticipantSnapshot(JSON.parse(JSON.stringify(message.metadata)).participant)).toEqual(parseParticipantSnapshot(fixture.snapshots.aliceMoon))

    for (const key of ['app_installation_id', 'link_epoch', 'subject', 'ref']) {expect(message.metadata?.participant).not.toHaveProperty(key)}
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }) }
})
