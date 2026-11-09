import { expect, it, vi } from 'vitest'

import type { MatrixConversationView } from '../../../shared/agent-conversation/view'

import {
  conversationBackgroundAction,
  conversationNeedsReconciliation,
  ConversationRequestActivity,
  requireConversationSnapshot
} from './activity'

const main = '!main:test'
const earlier = '!earlier:test'
const converged: MatrixConversationView = {
  state: 'marked', main, candidates: [main, earlier], earlier: [earlier], skipped: [], jobs: 0
}

it('skips changes for a converged home and zero moving jobs, including when the local home is not configured', () => {
  expect(conversationNeedsReconciliation(converged, main)).toBe(false)
  expect(conversationNeedsReconciliation(converged, undefined, main)).toBe(false)
  expect(conversationNeedsReconciliation({ ...converged, jobs: 1 }, main)).toBe(true)
  expect(conversationNeedsReconciliation(converged, earlier)).toBe(true)
  expect(conversationNeedsReconciliation(converged)).toBe(true)
})

it('reconciles a converged main the preview found ready to move to a plain room (0.20)', () => {
  expect(conversationNeedsReconciliation({ ...converged, replaceable: true }, main)).toBe(true)

  // An unreadable main's replacement stays the owner's choice: a blocked view never reconciles.
  const blocked: MatrixConversationView = {
    ...converged,
    state: 'blocked',
    replaceable: true,
    reason: 'read_unavailable'
  }

  expect(conversationNeedsReconciliation(blocked, main)).toBe(false)
})

it('reconciles legacy rooms, including several unmarked ones it will pick automatically', () => {
  const legacy: MatrixConversationView = { state: 'legacy', candidates: [main], earlier: [], skipped: [], jobs: 0 }
  expect(conversationNeedsReconciliation(legacy)).toBe(true)
  expect(conversationNeedsReconciliation({ ...legacy, candidates: [main, earlier] })).toBe(true)
  expect(conversationNeedsReconciliation({ ...legacy, skipped: [main] })).toBe(true)
  expect(conversationNeedsReconciliation({ ...legacy, candidates: [] })).toBe(false)
  expect(conversationNeedsReconciliation({ ...converged, earlier: [] }, main)).toBe(true)
  expect(conversationNeedsReconciliation({ ...converged, earlier: [], skipped: [earlier] }, main)).toBe(false)
  expect(conversationNeedsReconciliation({ ...converged, jobs: null }, main)).toBe(false)
  expect(conversationNeedsReconciliation({ ...converged, reason: 'cloud_not_ready' }, main)).toBe(false)
})

it('restores a main to marked rooms that have none, and otherwise picks one automatically', () => {
  const headless: MatrixConversationView = {
    state: 'legacy', proposed: earlier, replaceable: true, candidates: [main, earlier], earlier: [main, earlier], skipped: [], jobs: 0
  }

  expect(conversationNeedsReconciliation(headless)).toBe(true)
  // No plain room the markers name (an agent that left its main, a rolled-back move): the
  // automatic pick handles it too, with no owner prompt.
  expect(conversationNeedsReconciliation({ ...headless, replaceable: undefined })).toBe(true)
  // An uncertain read never repairs.
  expect(conversationNeedsReconciliation({ ...headless, reason: 'read_unavailable' })).toBe(false)
})

it('resumes an unsettled move in the background, and otherwise reconciles only what needs work', () => {
  const unsettled: MatrixConversationView = {
    state: 'retry', main, candidates: [main], earlier: [], skipped: [], jobs: null, reason: 'effects_pending'
  }

  expect(conversationBackgroundAction(unsettled, main)).toBe('resume')
  // A rollback clears markers: it stays the owner's Retry.
  expect(conversationBackgroundAction({ ...unsettled, reason: 'rollback_pending' }, main)).toBeUndefined()
  expect(conversationBackgroundAction(converged, main)).toBeUndefined()
  expect(conversationBackgroundAction(converged, earlier)).toBe('reconcile')
})

it('serializes previews and changes while releasing the barrier after a fence-release failure', async () => {
  const hold = vi.fn()
  const release = vi.fn(async () => { throw new Error('release failed') })
  const activity = new ConversationRequestActivity({ hold, release })
  let complete!: () => void
  const change = activity.run('change', () => new Promise<void>(resolve => { complete = resolve }))
  await expect(activity.run('preview', async () => {})).rejects.toThrow('matrix_conversation_busy')
  expect(activity.changing).toBe(true)
  complete()
  await expect(change).rejects.toThrow('release failed')
  expect(activity.changing).toBe(false)
  expect(activity.busy).toBe(false)
  expect(hold.mock.calls).toEqual([[true], [false]])
  await expect(activity.run('preview', async () => 42)).resolves.toBe(42)
})

it('drains an accepted change and its native fence before a cloud snapshot, while previews do not delay it', async () => {
  const events: string[] = []
  const activity = new ConversationRequestActivity({
    hold: active => { events.push(active ? 'hold' : 'release') },
    release: async () => { events.push('fence-released') }
  })
  let finish!: () => void
  const changing = activity.run('change', () => new Promise<void>(resolve => { finish = resolve }))
  const snapshot = activity.settled().then(() => { events.push('snapshot') })
  await Promise.resolve()
  expect(events).toEqual(['hold'])
  finish()
  await Promise.all([changing, snapshot])
  expect(events).toEqual(['hold', 'fence-released', 'release', 'snapshot'])

  let finishPreview!: () => void
  const preview = activity.run('preview', () => new Promise<void>(resolve => { finishPreview = resolve }))
  await activity.settled()
  expect(activity.busy).toBe(true)
  finishPreview()
  await preview
})

it('refuses a cloud export after an interrupted change leaves its journal pending', async () => {
  let pendingJournal = false
  const activity = new ConversationRequestActivity({ hold: () => {}, release: async () => {} })
  let finish!: () => void
  const change = activity.run('change', () => new Promise<void>(resolve => { finish = resolve }))
  const exported = vi.fn()
  const snapshot = requireConversationSnapshot(activity, () => activity.changing || pendingJournal).then(exported)
  pendingJournal = true
  finish()
  await change
  await expect(snapshot).rejects.toMatchObject({ code: 'matrix_conversation_unavailable' })
  expect(exported).not.toHaveBeenCalled()
  await expect(requireConversationSnapshot(undefined, () => true)).rejects.toThrow('matrix_conversation_unavailable')
  pendingJournal = false
  await requireConversationSnapshot(activity, () => pendingJournal)
})
