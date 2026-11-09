import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseSlashCommand } from '@/lib/chat-runtime'
import { $actionPanelEpoch, $actionPanelOwner, type ActionPanelOwner, panelOwnerKey } from '@/store/action-panel-owner'
import { $workbenchScope, assistantChatWorkbenchScopeKey } from '@/store/workbench-tabs'

import { insertComposerText } from '../focus'

import { scopedComposerInsertMatches } from './use-composer-draft'

const OWNER: ActionPanelOwner = {
  accountId: 'account-a',
  agent_id: '00000000-0000-4000-8000-303617b97302',
  backend_id: '00000000-0000-4000-8000-00f765af1c54',
  connectionId: 'connection-a',
  profile: 'marketing',
  submission_dedup: true,
  version: 1
}

describe('scoped composer inserts', () => {
  it('prepares an executable skill command while retaining the complete existing draft', () => {
    const draft = 'Summarize the attached report.\nKeep the original tables.'
    const text = insertComposerText(draft, '/brief', 'prefix')
    expect(parseSlashCommand(text)).toEqual({ name: 'brief', arg: draft })
    expect(text.endsWith(draft)).toBe(true)
  })
  beforeEach(() => {
    $actionPanelOwner.set(OWNER)
    $actionPanelEpoch.set(7)
    $workbenchScope.set(assistantChatWorkbenchScopeKey('chat-a', OWNER))
  })

  afterEach(() => {
    $actionPanelOwner.set(null)
    $actionPanelEpoch.set(0)
    $workbenchScope.set('session')
  })

  it('keeps existing unscoped insert callers compatible', () => {
    expect(scopedComposerInsertMatches(undefined)).toBe(true)
  })

  it('refuses a deferred insertion after its conversation changes', () => {
    const scope = {
      epoch: $actionPanelEpoch.get(),
      ownerKey: panelOwnerKey(),
      scopeKey: $workbenchScope.get()
    }

    expect(scopedComposerInsertMatches(scope)).toBe(true)
    $workbenchScope.set(assistantChatWorkbenchScopeKey('chat-b', OWNER))
    expect(scopedComposerInsertMatches(scope)).toBe(false)
  })

  it('refuses a deferred insertion after its owner or owner epoch changes', () => {
    const scope = {
      epoch: $actionPanelEpoch.get(),
      ownerKey: panelOwnerKey(),
      scopeKey: $workbenchScope.get()
    }

    $actionPanelEpoch.set(8)
    expect(scopedComposerInsertMatches(scope)).toBe(false)

    $actionPanelEpoch.set(7)
    $actionPanelOwner.set({ ...OWNER, accountId: 'account-b' })
    expect(scopedComposerInsertMatches(scope)).toBe(false)
  })
})


it('keeps one skill invocation when the app and its file are prepared repeatedly', () => {
  const draft = '/powerpoint Review these slides.'
  expect(insertComposerText(insertComposerText(draft, '/powerpoint', 'prefix'), '/powerpoint', 'prefix')).toBe(draft)
  expect(insertComposerText('/powerpoint-other text', '/powerpoint', 'prefix')).toBe('/powerpoint\n\n/powerpoint-other text')
})
