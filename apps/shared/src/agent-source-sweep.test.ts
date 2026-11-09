import { describe, expect, it } from 'vitest'

import {
  agentSourceSnapshotHasTag,
  agentSourceSweepEvidence,
  agentSourceSweepSnapshot,
  fitAgentSourceSweepSnapshot
} from './agent-source-sweep'
import { followupSweepFindingIdentity, followupSweepPrompt } from './followup-sweep'

const binding = { connectionRef: 'google_connection_owner_01', scopeRef: 'google_account_01',
  descriptorRevision: 3, authorityRevision: 9 }

describe('shared open-source sweep evidence', () => {
  it('preserves migrated finding hashes while using generic path-safe evidence IDs', async () => {
    const identity = { source: 'google_mail' as const, scope: 'google:gmail', objectId: 'thread-1',
      anchorId: 'message-1', dueAt: null }

    const legacy = await followupSweepFindingIdentity(identity)

    const open = await agentSourceSweepEvidence({ sourceId: identity.source, scope: identity.scope,
      objectId: identity.objectId, anchorId: identity.anchorId, dueAt: null, observedAt: 1,
      text: 'Mail evidence', fresh: true, provenanceTags: ['google-derived'],
      policyTags: ['google-limited-use-v1', 'owner-only'] })

    expect(open.findingHash).toBe(legacy.findingHash)
    expect(open.id).toMatch(/^src:[A-Za-z0-9_-]+$/u)
    expect(open.id).not.toBe(legacy.id)
  })

  it('keeps unknown source IDs and inherited policy tags through prompt fitting', async () => {
    const sourceId = 'app:00000000-0000-4000-8000-a3a9e1ed9732:chat'

    const entry = await agentSourceSweepEvidence({ sourceId, scope: 'room_unknown_app_01',
      objectId: 'event-1', anchorId: 'event-1', dueAt: null, observedAt: 2,
      text: 'x'.repeat(1_200), fresh: true, provenanceTags: ['app-declared', 'matrix-derived'],
      policyTags: ['owner-only'] })

    const snapshot = await agentSourceSweepSnapshot({ capturedAt: 2, ownerTimeZone: 'Asia/Ho_Chi_Minh',
      sourceSnapshotDigest: 'a'.repeat(64), cursorDeltas: { [sourceId]: 'opaque:event-1' },
      sources: [{ sourceId, binding: { ...binding, connectionRef: 'matrix_connection_owner_01',
        scopeRef: 'room_unknown_app_01', descriptorRevision: 7 }, status: 'ok', evidenceIds: [entry.id],
        provenanceTags: entry.provenanceTags, policyTags: entry.policyTags }], entries: [entry] })

    const fitted = await fitAgentSourceSweepSnapshot(snapshot)
    expect(fitted.entries).toHaveLength(1)
    expect(fitted.entries[0]).toMatchObject({ sourceId, policyTags: ['owner-only'] })
    expect(followupSweepPrompt(fitted)).toContain(sourceId)
  })

  it('taints an output whenever any exposed context carries Google provenance', async () => {
    const entry = await agentSourceSweepEvidence({ sourceId: 'google_drive', scope: 'google:drive',
      objectId: 'file-1', anchorId: 'file-1:1', dueAt: null, observedAt: 3,
      text: 'Drive metadata', fresh: true, provenanceTags: ['google-derived'],
      policyTags: ['google-limited-use-v1', 'owner-only'] })

    const snapshot = await agentSourceSweepSnapshot({ capturedAt: 3, ownerTimeZone: 'Asia/Ho_Chi_Minh',
      sourceSnapshotDigest: 'b'.repeat(64), cursorDeltas: { google_drive: 'opaque:file-1' },
      sources: [{ sourceId: 'google_drive', binding, status: 'ok', evidenceIds: [entry.id],
        provenanceTags: entry.provenanceTags, policyTags: entry.policyTags }], entries: [entry] })

    expect(agentSourceSnapshotHasTag(snapshot, 'google-derived')).toBe(true)
    expect(agentSourceSnapshotHasTag(snapshot, 'future-tag')).toBe(false)
  })
})
