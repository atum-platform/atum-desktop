import { beforeEach, describe, expect, it } from 'vitest'

import { $actionPanelOwner, panelOwnerKey } from '@/store/action-panel-owner'

import type { ComposerAttachment } from './composer'
import {
  $parkedQueueSessions,
  $queuedPromptsBySession,
  clearQueuedPrompts,
  dequeueQueuedPrompt,
  enqueueQueuedPrompt,
  getQueuedPrompts,
  isQueueParked,
  migrateQueuedPrompts,
  parkQueuedPrompts,
  promoteQueuedPrompt,
  removeQueuedPrompt,
  shouldAutoDrain,
  unparkQueuedPrompts,
  updateQueuedPrompt,
  updateQueuedPromptText
} from './composer-queue'

const SESSION_KEY = 'session-abc'
const QUEUE_STORAGE_KEY = 'hermes.desktop.composerQueue.v2'

function attachment(id: string, kind: ComposerAttachment['kind'] = 'file'): ComposerAttachment {
  return {
    id,
    kind,
    label: id,
    refText: `@file:${id}`
  }
}

describe('composer queue store', () => {
  beforeEach(() => {
    $actionPanelOwner.set({ version: 1, backend_id: '00000000-0000-4000-8000-bd7662a5eeb4', agent_id: '00000000-0000-4000-8000-b454f82c5857', accountId: 'test', connectionId: 'local', profile: 'default', submission_dedup: true })
    window.localStorage.removeItem(QUEUE_STORAGE_KEY)
    $queuedPromptsBySession.set({})
  })

  it('queues prompts in FIFO order', async () => {
    await enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'first' })
    await enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'second' })

    expect(dequeueQueuedPrompt(SESSION_KEY)?.text).toBe('first')
    expect(dequeueQueuedPrompt(SESSION_KEY)?.text).toBe('second')
    expect(dequeueQueuedPrompt(SESSION_KEY)).toBeNull()
  })

  it('clones attachments when queueing', async () => {
    const source = [attachment('a-1')]
    const queued = await enqueueQueuedPrompt(SESSION_KEY, { attachments: source, text: 'check clones' })

    expect(queued).not.toBeNull()
    expect(getQueuedPrompts(SESSION_KEY)[0]?.attachments[0]).toEqual(source[0])
    expect(getQueuedPrompts(SESSION_KEY)[0]?.attachments[0]).not.toBe(source[0])
  })

  it('discards supplied capture and authority for an explicit no-document queue entry', async () => {
    const queued = await enqueueQueuedPrompt(SESSION_KEY, {
      attachments: [attachment('attachment')], text: 'without document', explicitNoContext: true,
      captureIntent: { mode: 'linked', revision: 'a', wordBindingId: 'A' },
      frozenContext: { ownerKey: panelOwnerKey(), secret: 'old capture' } as never
    })

    expect(queued).toMatchObject({ frozenContext: null, captureIntent: { mode: 'removed' }, explicitNoContext: true })
    expect(queued?.captureIntent?.wordBindingId).toBeUndefined()
    expect(queued?.attachments).toHaveLength(1)
  })

  it('updates and removes queued entries by id', async () => {
    const first = await enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'draft one' })
    const second = await enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'draft two' })

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()

    expect(updateQueuedPromptText(SESSION_KEY, first!.id, 'draft one edited')).toBe(true)
    expect(getQueuedPrompts(SESSION_KEY).map(entry => entry.text)).toEqual(['draft one edited', 'draft two'])

    expect(removeQueuedPrompt(SESSION_KEY, first!.id)).toBe(true)
    expect(getQueuedPrompts(SESSION_KEY).map(entry => entry.text)).toEqual(['draft two'])
  })

  it('promotes a queued entry to the front', async () => {
    const first = await enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'first' })
    const second = await enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'second' })
    const third = await enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'third' })

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(third).not.toBeNull()

    expect(promoteQueuedPrompt(SESSION_KEY, third!.id)).toBe(true)
    expect(getQueuedPrompts(SESSION_KEY).map(entry => entry.text)).toEqual(['third', 'first', 'second'])
    expect(promoteQueuedPrompt(SESSION_KEY, third!.id)).toBe(false)
  })

  it('updates queued text and attachment snapshot', async () => {
    const first = await enqueueQueuedPrompt(SESSION_KEY, { attachments: [attachment('f-1')], text: 'draft one' })
    const editedAttachments = [attachment('f-2'), attachment('f-3', 'image')]

    expect(first).not.toBeNull()
    expect(
      updateQueuedPrompt(SESSION_KEY, first!.id, {
        attachments: editedAttachments,
        text: 'edited text'
      })
    ).toBe(true)

    const queue = getQueuedPrompts(SESSION_KEY)
    expect(queue[0]?.text).toBe('edited text')
    expect(queue[0]?.attachments).toEqual(editedAttachments)
    expect(queue[0]?.attachments[0]).not.toBe(editedAttachments[0])
  })

  it('clears queue state for a session', async () => {
    await enqueueQueuedPrompt(SESSION_KEY, { attachments: [attachment('img-1', 'image')], text: 'queued' })

    clearQueuedPrompts(SESSION_KEY)

    expect(getQueuedPrompts(SESSION_KEY)).toEqual([])
    expect($queuedPromptsBySession.get()[SESSION_KEY]).toBeUndefined()
    expect(JSON.parse(window.localStorage.getItem(QUEUE_STORAGE_KEY) || '{}')[panelOwnerKey()]?.[SESSION_KEY]).toBeUndefined()
  })

  it('persists queue entries into local storage', async () => {
    await enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'persist me' })

    const raw = window.localStorage.getItem(QUEUE_STORAGE_KEY)
    expect(raw).toBeTruthy()

    const parsed = JSON.parse(String(raw))[panelOwnerKey()] as Record<string, { text: string }[]>
    expect(parsed[SESSION_KEY]?.[0]?.text).toBe('persist me')
  })
})

describe('migrateQueuedPrompts', () => {
  beforeEach(() => {
    window.localStorage.removeItem(QUEUE_STORAGE_KEY)
    $queuedPromptsBySession.set({})
  })

  it('moves entries from a dead runtime key onto the live one', async () => {
    await enqueueQueuedPrompt('rt-old', { attachments: [], text: 'stranded' })

    expect(migrateQueuedPrompts('rt-old', 'rt-new')).toBe(true)
    expect(getQueuedPrompts('rt-old')).toEqual([])
    expect(getQueuedPrompts('rt-new').map(e => e.text)).toEqual(['stranded'])
    // The dead key is dropped from the store entirely.
    expect($queuedPromptsBySession.get()['rt-old']).toBeUndefined()
  })

  it('appends after existing target entries (FIFO preserved)', async () => {
    await enqueueQueuedPrompt('rt-new', { attachments: [], text: 'already here' })
    await enqueueQueuedPrompt('rt-old', { attachments: [], text: 'migrated' })

    migrateQueuedPrompts('rt-old', 'rt-new')

    expect(getQueuedPrompts('rt-new').map(e => e.text)).toEqual(['already here', 'migrated'])
  })

  it('is a no-op when source is empty or keys match', async () => {
    expect(migrateQueuedPrompts('rt-old', 'rt-new')).toBe(false)
    expect(migrateQueuedPrompts('rt-x', 'rt-x')).toBe(false)
  })
})

describe('shouldAutoDrain', () => {
  it('drains whenever idle with a non-empty queue', async () => {
    expect(shouldAutoDrain({ isBusy: false, queueLength: 1 })).toBe(true)
  })

  it('drains on mount/reconnect with no observed busy edge', async () => {
    // The whole point of dropping the edge: a remount resets the busy ref, so an
    // edge-gated drain would strand the entry. Idle + non-empty must still fire.
    expect(shouldAutoDrain({ isBusy: false, queueLength: 2 })).toBe(true)
  })

  it('does not drain mid-turn', async () => {
    expect(shouldAutoDrain({ isBusy: true, queueLength: 1 })).toBe(false)
  })

  it('does not drain an empty queue', async () => {
    expect(shouldAutoDrain({ isBusy: false, queueLength: 0 })).toBe(false)
  })

  it('does not drain a parked queue, even when idle', async () => {
    // The Stop/Esc settle edge: busy just flipped false but the user asked to
    // HALT — the park must hold the head back until they resume.
    expect(shouldAutoDrain({ isBusy: false, parked: true, queueLength: 1 })).toBe(false)
  })

  it('drains again once the park is lifted', async () => {
    expect(shouldAutoDrain({ isBusy: false, parked: false, queueLength: 1 })).toBe(true)
  })
})

describe('parked queue sessions', () => {
  beforeEach(() => {
    window.localStorage.removeItem(QUEUE_STORAGE_KEY)
    $queuedPromptsBySession.set({})
    $parkedQueueSessions.set({})
  })

  it('parks only sessions with queued entries', async () => {
    expect(parkQueuedPrompts(SESSION_KEY)).toBe(false)
    expect(isQueueParked(SESSION_KEY)).toBe(false)

    await enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'held back' })

    expect(parkQueuedPrompts(SESSION_KEY)).toBe(true)
    expect(isQueueParked(SESSION_KEY)).toBe(true)
  })

  it('unparks explicitly', async () => {
    await enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'held back' })
    parkQueuedPrompts(SESSION_KEY)

    unparkQueuedPrompts(SESSION_KEY)

    expect(isQueueParked(SESSION_KEY)).toBe(false)
  })

  it('queueing a fresh prompt lifts the park', async () => {
    await enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'held back' })
    parkQueuedPrompts(SESSION_KEY)

    await enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'new intent' })

    expect(isQueueParked(SESSION_KEY)).toBe(false)
  })

  it('emptying the queue drops the park', async () => {
    const entry = await enqueueQueuedPrompt(SESSION_KEY, { attachments: [], text: 'held back' })
    parkQueuedPrompts(SESSION_KEY)

    removeQueuedPrompt(SESSION_KEY, entry!.id)

    expect(isQueueParked(SESSION_KEY)).toBe(false)
  })

  it('a park travels with migrated entries', async () => {
    // A backend bounce right after Stop re-keys the queue; shedding the park
    // there would auto-send the exact prompts the user just halted.
    await enqueueQueuedPrompt('rt-old', { attachments: [], text: 'held back' })
    parkQueuedPrompts('rt-old')

    migrateQueuedPrompts('rt-old', 'rt-new')

    expect(isQueueParked('rt-old')).toBe(false)
    expect(isQueueParked('rt-new')).toBe(true)
  })

  it('migration without a park does not invent one', async () => {
    await enqueueQueuedPrompt('rt-old', { attachments: [], text: 'flowing' })

    migrateQueuedPrompts('rt-old', 'rt-new')

    expect(isQueueParked('rt-new')).toBe(false)
  })
})
