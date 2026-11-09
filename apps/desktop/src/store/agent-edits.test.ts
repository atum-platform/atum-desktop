import { beforeEach, describe, expect, it } from 'vitest'

import {
  $reviewsByScope,
  hasOpenReview,
  openReviewFor,
  recordAgentEdit,
  resetAgentEditReviews,
  settleTurn
} from './agent-edits'

const edit = (sessionId: string, turnId: string, diff: string) => ({
  sessionId,
  turnId,
  restorePath: 'docs/note.md',
  checkpoint: { hash: `hash-${turnId}`, working_dir: '/workspace' },
  diff,
  diffTruncated: false,
  restoreAvailable: true
})

describe('agent edit reviews', () => {
  beforeEach(resetAgentEditReviews)

  it('keeps the same path independent across chat scopes', () => {
    recordAgentEdit('chat:a', edit('session-a', 'turn-1', 'diff a'))
    recordAgentEdit('chat:b', edit('session-b', 'turn-1', 'diff b'))

    expect(openReviewFor('chat:a', 'docs/note.md')?.diff).toBe('diff a')
    expect(openReviewFor('chat:b', 'docs/note.md')?.diff).toBe('diff b')
  })

  it('folds same-turn writes and keeps different turns distinct', () => {
    recordAgentEdit('chat:a', edit('session-a', 'turn-1', 'first'))
    recordAgentEdit('chat:a', edit('session-a', 'turn-1', 'latest'))
    recordAgentEdit('chat:a', edit('session-a', 'turn-2', 'next turn'))

    expect(Object.keys($reviewsByScope.get()['chat:a'] ?? {})).toHaveLength(2)
    expect(openReviewFor('chat:a', 'docs/note.md')?.diff).toBe('next turn')
    expect(Object.values($reviewsByScope.get()['chat:a'] ?? {}).find(review => review.turnId === 'turn-1')?.diff).toBe(
      'latest'
    )
  })

  it('settles only matching session and turn ids', () => {
    recordAgentEdit('chat:a', edit('session-a', 'turn-1', 'a'))
    recordAgentEdit('chat:b', edit('session-b', 'turn-1', 'b'))
    recordAgentEdit('chat:a', edit('session-a', 'turn-2', 'c'))

    settleTurn('session-a', 'turn-1')

    expect(
      Object.values($reviewsByScope.get()['chat:a'] ?? {}).find(review => review.turnId === 'turn-1')?.settled
    ).toBe(true)
    expect(
      Object.values($reviewsByScope.get()['chat:a'] ?? {}).find(review => review.turnId === 'turn-2')?.settled
    ).toBe(false)
    expect(openReviewFor('chat:b', 'docs/note.md')?.settled).toBe(false)
  })
})

describe('scope fallback', () => {
  it('finds a review keyed by a runtime session id once the session row resolves to its chat', async () => {
    const { $sessions } = await import('./session')
    const { assistantChatWorkbenchScopeKey } = await import('./workbench-tabs')
    resetAgentEditReviews()
    // Recorded before $sessions knew the row: keyed by the runtime id.
    recordAgentEdit(assistantChatWorkbenchScopeKey('runtime-9'), {
      sessionId: 'runtime-9',
      turnId: 'turn-9',
      restorePath: 'Tài liệu 1.md',
      checkpoint: { hash: 'h', working_dir: '/ws' },
      diff: null,
      diffTruncated: false,
      restoreAvailable: true
    })
    const chatScope = assistantChatWorkbenchScopeKey('root-1')
    expect(openReviewFor(chatScope, 'Tài liệu 1.md')).toBeNull()

    $sessions.set([{ _lineage_root_id: 'root-1', id: 'runtime-9' } as never])
    expect(openReviewFor(chatScope, 'Tài liệu 1.md')?.turnId).toBe('turn-9')
    expect(hasOpenReview($reviewsByScope.get(), chatScope, 'Tài liệu 1.md')).toBe(true)
    expect(openReviewFor(assistantChatWorkbenchScopeKey('root-2'), 'Tài liệu 1.md')).toBeNull()
    $sessions.set([])
  })
})

it('cannot rehome an old agent review into the current agent when runtime ids collide', async () => {
  const { $sessions } = await import('./session')
  const { $actionPanelOwner } = await import('./action-panel-owner')
  const { assistantChatWorkbenchScopeKey } = await import('./workbench-tabs')
  const owner = { version: 1 as const, backend_id: crypto.randomUUID(), agent_id: crypto.randomUUID(), accountId: 'a', connectionId: 'c', profile: 'alpha', submission_dedup: true }
  $actionPanelOwner.set(owner)
  const oldScope = assistantChatWorkbenchScopeKey('runtime')
  recordAgentEdit(oldScope, { ...edit('runtime', 'turn', 'alpha only'), profile: 'alpha' })
  $actionPanelOwner.set({ ...owner, agent_id: crypto.randomUUID(), profile: 'beta' })
  $sessions.set([{ id: 'runtime', profile: 'beta', _lineage_root_id: 'beta-root' }, { id: 'runtime', profile: 'alpha', _lineage_root_id: 'alpha-root' }] as never)
  expect(openReviewFor(assistantChatWorkbenchScopeKey('beta-root'), 'docs/note.md')).toBeNull()
  $actionPanelOwner.set(owner)
  expect(openReviewFor(assistantChatWorkbenchScopeKey('alpha-root'), 'docs/note.md')?.diff).toBe('alpha only')
  $actionPanelOwner.set(null); $sessions.set([]); resetAgentEditReviews()
})
