import { expect, it, vi } from 'vitest'

it('restores text for the exact owner, discards stored automatic bytes, and requires an explicit recovery choice', async () => {
  vi.resetModules()
  localStorage.clear()
  const owner = { version: 1 as const, backend_id: crypto.randomUUID(), agent_id: crypto.randomUUID(), accountId: 'account-a', connectionId: 'connection', profile: 'default', submission_dedup: true }
  const owners = await import('./action-panel-owner')
  const key = owners.panelOwnerKey(owner)
  localStorage.setItem('hermes.desktop.composerQueue.v2', JSON.stringify({ [key]: { chat: [{ id: 'entry', text: 'review', queuedAt: 1, attachments: [], frozenContext: { payload: { text: 'must not hydrate' } } }, { corrupt: true }] }, broken: ['invalid'] }))
  const queue = await import('./composer-queue')
  owners.$actionPanelOwner.set({ ...owner, accountId: 'account-b' })
  expect(queue.getQueuedPrompts('chat')).toEqual([])
  owners.$actionPanelOwner.set(owner)
  const [entry] = queue.getQueuedPrompts('chat')
  expect(entry).toMatchObject({ text: 'review', contextUnavailable: true })
  expect(entry?.frozenContext).toBeUndefined()
  expect(queue.getQueuedPrompts('chat')).toHaveLength(1)
  // Legacy entries have no original target. Recovery cannot attach whatever
  // happens to be open now; only an explicit no-document send is available.
  await queue.recoverQueuedContext('entry', false)
  expect(queue.getQueuedPrompts('chat')[0]?.contextUnavailable).toBe(true)
  await queue.recoverQueuedContext('entry', true)
  expect(queue.getQueuedPrompts('chat')[0]).toMatchObject({ text: 'review', frozenContext: null, contextUnavailable: false })
  expect(queue.isQueueParked('chat')).toBe(true)
  owners.$actionPanelOwner.set(null); localStorage.clear()
})
