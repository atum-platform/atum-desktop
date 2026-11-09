import { describe, expect, it } from 'vitest'

import {
  followupSweepEvidence,
  followupSweepNeedsModel,
  followupSweepSnapshot,
  type FollowupSweepSourceWatermarks
} from '../../../shared/src/followup-sweep'

import {
  backgroundSweepChatEvidence,
  backgroundSweepConversationEvidence,
  backgroundSweepDriveEvidence,
  backgroundSweepMacFileEvidence,
  backgroundSweepMailEvidence,
  backgroundSweepMemoryEvidence,
  selectBackgroundSweepChats,
  selectBackgroundSweepMail
} from './background-sweep-evidence'

const capturedAt = 1_793_017_200_000
const ownerTimeZone = 'Asia/Ho_Chi_Minh'
const emptyWatermarks: FollowupSweepSourceWatermarks = {
  googleMail: null,
  googleCalendar: null,
  atumChats: null,
  conversation: null,
  memory: null
}

describe('cross-home finding identity', () => {
  it('gives a multi-message thread the cloud controller’s exact single finding identity', async () => {
    const mail = [
      {
        messageId: 'm-old',
        threadId: 't-1',
        sourceId: 'gmail:owner',
        date: '2026-10-25T03:00:00.000Z',
        subject: 'Invoice',
        from: 'Lan',
        snippet: 'Following up'
      },
      {
        messageId: 'm-latest',
        threadId: 't-1',
        sourceId: 'gmail:owner',
        date: '2026-10-26T03:00:00.000Z',
        subject: 'Invoice',
        from: 'Lan',
        snippet: 'Can you confirm?'
      }
    ]
    const selected = selectBackgroundSweepMail(mail, null, capturedAt)

    expect(selected.entries).toHaveLength(1)
    expect(selected.entries[0]!.message.messageId).toBe('m-latest')
    const mac = await followupSweepEvidence(
      backgroundSweepMailEvidence(selected.entries[0]!.message, selected.entries[0]!.observedAt)
    )
    const cloud = await followupSweepEvidence({
      source: 'google_mail',
      scope: 'gmail:owner',
      objectId: 't-1',
      anchorId: 'm-latest',
      dueAt: null,
      observedAt: Date.parse('2026-10-26T03:00:00.000Z'),
      title: 'Invoice',
      text: 'Can you confirm?',
      fresh: true
    })
    const older = await followupSweepEvidence(
      backgroundSweepMailEvidence(mail[0]!, Date.parse(mail[0]!.date))
    )

    expect(mac.id).toBe(cloud.id)
    expect(mac.findingHash).toBe(cloud.findingHash)
    expect(older.id).not.toBe(mac.id)
  })

  it('gives the same chat fixture the cloud controller’s exact finding identity', async () => {
    const message = { eventId: '$latest:example.test', at: capturedAt - 60_000, text: 'Are we still on?' }

    const mac = await followupSweepEvidence(
      backgroundSweepChatEvidence('!room:example.test', message, 'Lan')
    )
    const cloud = await followupSweepEvidence({
      source: 'atum_chats',
      scope: '!room:example.test',
      objectId: '!room:example.test',
      anchorId: '$latest:example.test',
      dueAt: null,
      observedAt: message.at,
      title: 'Lan',
      text: 'Are we still on?',
      fresh: true
    })

    expect(mac.id).toBe(cloud.id)
    expect(mac.findingHash).toBe(cloud.findingHash)
  })
})

describe('the Mac mail frontier', () => {
  it('carries three equal-timestamp threads across two-entry overflow instead of losing the third', () => {
    const date = '2026-10-26T03:00:00.000Z'
    const messages = ['one', 'two', 'three'].map((name, index) => ({
      messageId: `m-${name}`,
      threadId: `t-${name}`,
      sourceId: 'gmail:owner',
      date,
      subject: `Subject ${index}`,
      from: 'Lan',
      snippet: 'Please follow up'
    }))

    const first = selectBackgroundSweepMail(messages, null, capturedAt)
    expect(first.entries.map(entry => entry.message.messageId)).toEqual(['m-one', 'm-two'])

    const second = selectBackgroundSweepMail(messages, first.watermark, capturedAt)
    expect(second.entries.map(entry => entry.message.messageId)).toEqual(['m-three'])

    const third = selectBackgroundSweepMail(messages, second.watermark, capturedAt)
    expect(third.entries).toEqual([])

    const delivered = new Set([
      ...first.entries.map(entry => entry.message.messageId),
      ...second.entries.map(entry => entry.message.messageId)
    ])
    expect([...delivered].sort()).toEqual(['m-one', 'm-three', 'm-two'])
  })
})

describe('context-only sources', () => {
  it('never marks changed memory as fresh evidence or a reason to call the model', async () => {
    const entry = await followupSweepEvidence(
      backgroundSweepMemoryEvidence('00000000-0000-4000-8000-dec97132ebbf', 'SOUL.md\nBe kind.', capturedAt)
    )

    expect(entry.fresh).toBe(false)

    const snapshot = await followupSweepSnapshot({
      capturedAt,
      ownerTimeZone,
      watermarks: emptyWatermarks,
      sources: [{ source: 'memory', status: 'ok' }],
      entries: [entry]
    })
    expect(followupSweepNeedsModel(snapshot)).toBe(false)
  })

  it('keeps conversation context non-fresh with the cadence due moment', async () => {
    const ownerEvent = { eventId: '$owner:example.test', at: capturedAt - 120_000 }
    const entry = backgroundSweepConversationEvidence('!room:example.test', ownerEvent, 7_200_000, 'owner: hello')

    expect(entry.fresh).toBe(false)
    expect(entry.objectId).toBe(ownerEvent.eventId)
    expect(entry.anchorId).toBe(ownerEvent.eventId)
    expect(entry.dueAt).toBe(ownerEvent.at + 7_200_000)
    expect(followupSweepNeedsModel(
      await followupSweepSnapshot({
        capturedAt,
        ownerTimeZone,
        watermarks: emptyWatermarks,
        sources: [{ source: 'conversation', status: 'ok' }],
        entries: [await followupSweepEvidence(entry)]
      })
    )).toBe(false)
  })
})

describe('metadata-only file evidence', () => {
  it('keeps Drive evidence to a name and provider times', async () => {
    const input = backgroundSweepDriveEvidence({
      sourceId: 'google:drive',
      fileId: 'file-1',
      name: 'Launch plan',
      modifiedAt: '2026-10-27T03:00:00.000Z',
      viewedAt: '2026-10-28T02:00:00.000Z'
    }, true)

    expect(input).toMatchObject({
      source: 'google_drive',
      objectId: 'file-1',
      observedAt: Date.parse('2026-10-28T02:00:00.000Z'),
      title: 'Launch plan',
      text: 'Modified 2026-10-27T03:00:00.000Z; Viewed 2026-10-28T02:00:00.000Z',
      fresh: true
    })
    expect((await followupSweepEvidence(input!)).id).toMatch(/^drive:/u)
  })

  it('keeps Mac evidence to a base name and modification time', async () => {
    const input = backgroundSweepMacFileEvidence({
      identity: 'a'.repeat(64), name: 'Roadmap.pages', modifiedAt: capturedAt - 1_000
    }, false)

    expect(input).toEqual({
      source: 'mac_files',
      scope: 'mac',
      objectId: 'a'.repeat(64),
      anchorId: `${'a'.repeat(64)}:${capturedAt - 1_000}`,
      dueAt: null,
      observedAt: capturedAt - 1_000,
      title: 'Roadmap.pages',
      text: `Modified ${new Date(capturedAt - 1_000).toISOString()}`,
      fresh: false
    })
    expect((await followupSweepEvidence(input)).id).toMatch(/^file:/u)
  })
})

describe('background sweep chat selection depth', () => {
  const now = 1_793_017_200_000
  const DAY_MS = 24 * 60 * 60_000

  const room = (id: string, lastAt: number, notifications: number, mine = false) => ({
    id,
    label: id,
    kind: 'person',
    members: [],
    memberCount: 2,
    notifications,
    highlights: 0,
    lastAt,
    last: { eventId: `$${id}:test`, from: 'Lan', mine, text: 'Can you review?' },
    encrypted: false
  })

  it('keeps the unread-only rule for an ordinary sweep', () => {
    const selected = selectBackgroundSweepChats(
      [room('!unread:test', now - 1_000, 1), room('!read:test', now - 1_000, 0)],
      null,
      now
    )

    expect(selected.candidates.map(candidate => candidate.id)).toEqual(['!unread:test'])
  })

  it('includes recent already-read rooms for a warm-up nudge, but not old or agent-sent ones', () => {
    const selected = selectBackgroundSweepChats(
      [
        room('!read:test', now - 1_000, 0),
        room('!old:test', now - 8 * DAY_MS, 0),
        room('!mine:test', now - 1_000, 0, true)
      ],
      null,
      now,
      true
    )

    expect(selected.candidates.map(candidate => candidate.id)).toEqual(['!read:test'])
  })
})
