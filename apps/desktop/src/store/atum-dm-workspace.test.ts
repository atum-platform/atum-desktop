import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const artifact = vi.fn()
vi.mock('@/lib/atum-messaging-client', () => ({ atumMessagingClient: () => ({ artifact }) }))

import {
  $atumDmArtifactByConversation,
  $atumDmAttentionByConversation,
  $atumDmPreviewByConversation,
  activateAtumDmArtifact,
  activateAtumDmLauncher,
  atumDmWorkspaceTabs,
  clearAtumDmWorkspace,
  closeAtumDmArtifact,
  closeAtumDmLauncher,
  moveAtumDmArtifact,
  moveAtumDmLauncher,
  openAtumDmLauncher,
  reopenLastClosedAtumDmArtifact,
  resolveAtumDmArtifact,
  selectAtumDmArtifact,
  setAtumDmConversationPreviewTarget,
  setAtumDmForegroundConversation,
  setAtumDmWorkspaceAccount
} from './atum-dm-workspace'
import { $workspaceOpen, setWorkspaceOpen } from './atum-shell'
import { $visibleWorkbenchTabs, $workbenchTabs, openWorkbenchSingleton, setWorkbenchScope } from './workbench-tabs'

function artifactState(conversationId: string, resourceId?: string) {
  const workspace = $atumDmArtifactByConversation.get()[conversationId]
  const selected = resourceId ?? workspace?.activeResourceId

  return workspace?.tabs.find(tab => tab.ref.resourceId === selected)?.state
}

const moonTarget = {
  kind: 'url' as const,
  label: 'Lá số',
  source: 'https://deployment.example.invalid/resources/moon',
  url: 'https://deployment.example.invalid/resources/moon'
}

const andyTarget = {
  kind: 'url' as const,
  label: 'Hồ sơ tâm lý',
  source: 'https://deployment.example.invalid/resources/andy',
  url: 'https://deployment.example.invalid/resources/andy'
}

beforeEach(() => {
  clearAtumDmWorkspace()
  setAtumDmForegroundConversation(null)
  setWorkspaceOpen(true)
  artifact.mockReset()
})

afterEach(() => vi.restoreAllMocks())

describe('hosted-DM workspace state', () => {
  it('keeps Moon and Andy targets under their originating conversations', () => {
    setAtumDmConversationPreviewTarget('moon-conversation', moonTarget)
    setAtumDmConversationPreviewTarget('andy-conversation', andyTarget)

    expect($atumDmPreviewByConversation.get()).toEqual({
      'andy-conversation': andyTarget,
      'moon-conversation': moonTarget
    })
  })

  it('does not accept an unscoped target', () => {
    setAtumDmConversationPreviewTarget('   ', moonTarget)

    expect($atumDmPreviewByConversation.get()).toEqual({})
  })

  it('drops every target at the account boundary', () => {
    setAtumDmWorkspaceAccount('account-a')
    setAtumDmConversationPreviewTarget('moon-conversation', moonTarget)

    expect($workbenchTabs.get()).toHaveLength(1)

    clearAtumDmWorkspace()

    expect($atumDmPreviewByConversation.get()).toEqual({})
    expect($workbenchTabs.get()).toEqual([])
  })

  it('persists background completion on its originating row and tab until that exact tab activates', async () => {
    let finish!: (value: unknown) => void
    artifact.mockReturnValue(
      new Promise(resolve => {
        finish = resolve
      })
    )

    const ref = {
      kind: 'artifact' as const,
      resourceId: 'moon.laso:completion',
      type: 'reading',
      title: 'Lá số',
      status: 'ready' as const
    }

    setAtumDmWorkspaceAccount('completion-account')
    setAtumDmForegroundConversation('andy-conversation')
    selectAtumDmArtifact('moon-conversation', ref)
    finish({
      state: 'ready',
      artifact: {
        artifactId: ref.resourceId,
        type: ref.type,
        title: ref.title,
        status: 'ready',
        url: 'https://moon.test/private-authority'
      }
    })
    await vi.waitFor(() => expect(artifactState('moon-conversation')).toBe('ready'))

    expect($atumDmArtifactByConversation.get()['moon-conversation']?.tabs[0]?.attention).toBe('complete')
    expect($atumDmAttentionByConversation.get()).toEqual({ 'moon-conversation': 'complete' })
    const stored = localStorage.getItem('hermes.desktop.atum.dmArtifactRefs.v1')!
    expect(stored).toContain('"attention":{"moon.laso:completion":"complete"}')
    expect(stored).not.toContain('https://moon.test')

    clearAtumDmWorkspace()
    setAtumDmWorkspaceAccount('completion-account')
    setAtumDmForegroundConversation('moon-conversation')
    await resolveAtumDmArtifact('moon-conversation')
    expect($atumDmAttentionByConversation.get()).toEqual({ 'moon-conversation': 'complete' })

    openAtumDmLauncher('moon-conversation')
    expect($atumDmAttentionByConversation.get()).toEqual({ 'moon-conversation': 'complete' })

    activateAtumDmArtifact('moon-conversation', ref.resourceId)
    expect($atumDmArtifactByConversation.get()['moon-conversation']?.tabs[0]?.attention).toBeNull()
    expect($atumDmAttentionByConversation.get()).toEqual({})
  })

  it('does not badge a terminal result already visible in the originating conversation and tab', async () => {
    artifact.mockResolvedValue({
      state: 'ready',
      artifact: {
        artifactId: 'andy.receipt:visible',
        type: 'receipt',
        title: 'Receipt',
        status: 'ready',
        url: 'https://andy.test/receipt'
      }
    })
    setAtumDmForegroundConversation('andy-conversation')
    clearAtumDmWorkspace()
    setAtumDmWorkspaceAccount('visible-account')
    selectAtumDmArtifact('andy-conversation', {
      kind: 'artifact',
      resourceId: 'andy.receipt:visible',
      type: 'receipt',
      title: 'Receipt',
      status: 'ready'
    })
    await vi.waitFor(() => expect(artifactState('andy-conversation')).toBe('ready'))

    expect($atumDmAttentionByConversation.get()).toEqual({})
    expect($atumDmArtifactByConversation.get()['andy-conversation']?.tabs[0]?.attention).toBeNull()
  })

  it('badges a background terminal failure distinctly and preserves sibling attention on activation', async () => {
    artifact.mockImplementation(async (_conversationId: string, resourceId: string) =>
      resourceId === 'andy.receipt:failed'
        ? { state: 'denied', artifact: null }
        : {
            state: 'ready',
            artifact: {
              artifactId: resourceId,
              type: 'reading',
              title: 'Lá số',
              status: 'ready',
              url: 'https://moon.test/ready'
            }
          }
    )
    setAtumDmWorkspaceAccount('mixed-attention-account')
    setAtumDmForegroundConversation('other-conversation')
    selectAtumDmArtifact('shared-conversation', {
      kind: 'artifact',
      resourceId: 'moon.laso:complete',
      type: 'reading',
      title: 'Lá số',
      status: 'ready'
    })
    selectAtumDmArtifact('shared-conversation', {
      kind: 'artifact',
      resourceId: 'andy.receipt:failed',
      type: 'receipt',
      title: 'Receipt',
      status: 'ready'
    })
    await vi.waitFor(() => expect(artifactState('shared-conversation', 'andy.receipt:failed')).toBe('denied'))
    await vi.waitFor(() => expect(artifactState('shared-conversation', 'moon.laso:complete')).toBe('ready'))

    expect($atumDmAttentionByConversation.get()).toEqual({ 'shared-conversation': 'failed' })
    activateAtumDmArtifact('shared-conversation', 'andy.receipt:failed')
    expect($atumDmAttentionByConversation.get()).toEqual({ 'shared-conversation': 'complete' })
    const sharedWorkspace = $atumDmArtifactByConversation.get()['shared-conversation']
    expect(sharedWorkspace?.tabs.find(tab => tab.ref.resourceId === 'moon.laso:complete')?.attention).toBe('complete')
  })

  it('updates a stale visible failure to completion without consuming the badge', async () => {
    const ref = {
      kind: 'artifact' as const,
      resourceId: 'andy.receipt:recovered',
      type: 'receipt',
      title: 'Receipt',
      status: 'ready' as const
    }

    artifact.mockResolvedValueOnce({ state: 'denied', artifact: null })
    setAtumDmWorkspaceAccount('recovery-attention-account')
    setAtumDmForegroundConversation('other-conversation')
    selectAtumDmArtifact('andy-conversation', ref)
    await vi.waitFor(() => expect(artifactState('andy-conversation')).toBe('denied'))
    expect($atumDmAttentionByConversation.get()).toEqual({ 'andy-conversation': 'failed' })

    artifact.mockResolvedValueOnce({
      state: 'ready',
      artifact: {
        artifactId: ref.resourceId,
        type: ref.type,
        title: ref.title,
        status: 'ready',
        url: 'https://andy.test/recovered'
      }
    })
    setAtumDmForegroundConversation('andy-conversation')
    await resolveAtumDmArtifact('andy-conversation', ref.resourceId)

    expect($atumDmAttentionByConversation.get()).toEqual({ 'andy-conversation': 'complete' })
  })

  it('treats an explicitly revealed resource pane as visible and clears attention on close-driven promotion', async () => {
    artifact.mockImplementation(async (_conversationId: string, resourceId: string) => ({
      state: 'ready',
      artifact: {
        artifactId: resourceId,
        type: 'document',
        title: resourceId,
        status: 'ready',
        url: `https://atum.test/${resourceId}`
      }
    }))
    setAtumDmWorkspaceAccount('visibility-account')
    setAtumDmForegroundConversation('visibility-conversation')
    setWorkspaceOpen(false)
    selectAtumDmArtifact('visibility-conversation', {
      kind: 'artifact',
      resourceId: 'artifact:panel-closed',
      type: 'document',
      title: 'Panel closed',
      status: 'ready'
    })
    await vi.waitFor(() => expect(artifactState('visibility-conversation')).toBe('ready'))
    expect($atumDmAttentionByConversation.get()).toEqual({})
    expect($atumDmArtifactByConversation.get()['visibility-conversation']?.activeSurface).toBe('artifact')

    setWorkspaceOpen(true)
    openWorkbenchSingleton('files')
    selectAtumDmArtifact('visibility-conversation', {
      kind: 'artifact',
      resourceId: 'artifact:files-pane',
      type: 'document',
      title: 'Files pane',
      status: 'ready'
    })
    await vi.waitFor(() => expect(artifactState('visibility-conversation', 'artifact:files-pane')).toBe('ready'))
    expect($atumDmArtifactByConversation.get()['visibility-conversation']?.tabs.at(-1)?.attention).toBeNull()
    expect($workspaceOpen.get()).toBe(true)

    closeAtumDmArtifact('visibility-conversation', 'artifact:files-pane')
    expect($atumDmArtifactByConversation.get()['visibility-conversation']).toMatchObject({
      activeResourceId: 'artifact:panel-closed',
      tabs: [{ attention: null, ref: { resourceId: 'artifact:panel-closed' } }]
    })
    expect($atumDmAttentionByConversation.get()).toEqual({})
  })

  it('persists only the URL-free ref and resolves fresh for the same account and conversation', async () => {
    artifact.mockResolvedValue({
      state: 'ready',
      artifact: {
        artifactId: 'moon.laso:42',
        type: 'reading',
        title: 'Lá số',
        status: 'ready',
        url: 'https://moon.test/artifact/42'
      }
    })

    const ref = {
      kind: 'artifact' as const,
      resourceId: 'moon.laso:42',
      type: 'reading',
      title: 'Lá số',
      status: 'ready' as const
    }

    setAtumDmWorkspaceAccount('account-a')
    selectAtumDmArtifact('moon-conversation', ref)
    await vi.waitFor(() => expect(artifactState('moon-conversation')).toBe('ready'))

    const stored = localStorage.getItem('hermes.desktop.atum.dmArtifactRefs.v1')!
    expect(stored).toContain('moon.laso:42')
    expect(stored).not.toContain('https://moon.test')

    clearAtumDmWorkspace()
    setAtumDmWorkspaceAccount('account-a')
    expect($atumDmArtifactByConversation.get()['moon-conversation']).toMatchObject({
      activeResourceId: ref.resourceId,
      tabs: [{ ref, state: 'idle', target: null }]
    })
    await resolveAtumDmArtifact('moon-conversation')
    expect(artifact).toHaveBeenLastCalledWith('moon-conversation', 'moon.laso:42')
  })

  it('does not restore or apply a result across an account boundary', async () => {
    let finish!: (value: unknown) => void
    artifact.mockReturnValue(
      new Promise(resolve => {
        finish = resolve
      })
    )
    setAtumDmWorkspaceAccount('account-a')
    selectAtumDmArtifact('moon-conversation', {
      kind: 'artifact',
      resourceId: 'moon.laso:42',
      type: 'reading',
      title: 'Lá số',
      status: 'ready'
    })
    setAtumDmWorkspaceAccount('account-b')
    finish({
      state: 'ready',
      artifact: {
        artifactId: 'moon.laso:42',
        type: 'reading',
        title: 'Lá số',
        status: 'ready',
        url: 'https://moon.test/private'
      }
    })
    await Promise.resolve()

    expect($atumDmPreviewByConversation.get()).toEqual({})
    expect($atumDmArtifactByConversation.get()).toEqual({})
  })

  it('uses one account-aware conversation scope and clears every DM surface at the account boundary', () => {
    artifact.mockResolvedValue({ state: 'offline', artifact: null })
    setAtumDmWorkspaceAccount('account-a')
    selectAtumDmArtifact('shared-conversation', {
      kind: 'artifact',
      resourceId: 'shared-resource',
      type: 'reading',
      title: 'Shared resource',
      status: 'ready'
    })
    setAtumDmConversationPreviewTarget('shared-conversation', moonTarget)

    expect($workbenchTabs.get().filter(tab => tab.scopeKey === 'atum-dm:account-a:shared-conversation').map(tab => tab.scopeKey)).toEqual([
      'atum-dm:account-a:shared-conversation',
      'atum-dm:account-a:shared-conversation'
    ])
    setWorkbenchScope('atum-dm:account-a:shared-conversation')
    expect($visibleWorkbenchTabs.get().map(tab => tab.surface.kind)).toEqual(['artifact', 'preview'])

    setAtumDmWorkspaceAccount('account-b')
    expect($workbenchTabs.get().filter(tab => tab.scopeKey.startsWith('atum-dm:account-a:'))).toEqual([])
  })

  it('lets sibling conversations resolve concurrently without sharing state', async () => {
    const finishes = new Map<string, (value: unknown) => void>()
    artifact.mockImplementation(
      (conversationId: string) => new Promise(resolve => finishes.set(conversationId, resolve))
    )
    setAtumDmWorkspaceAccount('account-a')
    selectAtumDmArtifact('moon-conversation', {
      kind: 'artifact',
      resourceId: 'moon.laso:42',
      type: 'reading',
      title: 'Lá số',
      status: 'ready'
    })
    selectAtumDmArtifact('andy-conversation', {
      kind: 'artifact',
      resourceId: 'andy.receipt:9',
      type: 'receipt',
      title: 'Receipt',
      status: 'ready'
    })

    finishes.get('andy-conversation')!({
      state: 'ready',
      artifact: {
        artifactId: 'andy.receipt:9',
        type: 'receipt',
        title: 'Receipt',
        status: 'ready',
        url: 'https://andy.test/receipt/9'
      }
    })
    finishes.get('moon-conversation')!({
      state: 'ready',
      artifact: {
        artifactId: 'moon.laso:42',
        type: 'reading',
        title: 'Lá số',
        status: 'ready',
        url: 'https://moon.test/laso/42'
      }
    })
    await vi.waitFor(() => expect(Object.keys($atumDmPreviewByConversation.get())).toHaveLength(2))

    expect($atumDmPreviewByConversation.get()['moon-conversation']?.url).toContain('moon.test')
    expect($atumDmPreviewByConversation.get()['andy-conversation']?.url).toContain('andy.test')
  })

  it('keeps a generating artifact in an honest waiting state without opening its URL', async () => {
    artifact.mockResolvedValue({
      state: 'ready',
      artifact: {
        artifactId: 'moon.laso:43',
        type: 'reading',
        title: 'Lá số',
        status: 'generating',
        url: 'https://moon.test/unfinished'
      }
    })
    setAtumDmWorkspaceAccount('account-a')
    selectAtumDmArtifact('generating-conversation', {
      kind: 'artifact',
      resourceId: 'moon.laso:43',
      type: 'reading',
      title: 'Lá số',
      status: 'generating'
    })
    await vi.waitFor(() => expect(artifactState('generating-conversation')).toBe('waiting'))

    expect($atumDmPreviewByConversation.get()['generating-conversation']).toBeUndefined()
  })

  it('ignores an expired embed and clears a stale ready target before re-resolution', async () => {
    const ref = {
      kind: 'artifact' as const,
      resourceId: 'andy.receipt:10',
      type: 'receipt',
      title: 'Receipt',
      status: 'ready' as const
    }

    artifact.mockResolvedValueOnce({
      state: 'ready',
      artifact: {
        artifactId: ref.resourceId,
        type: ref.type,
        title: ref.title,
        status: 'ready',
        url: 'https://andy.test/current',
        embed: { url: 'https://andy.test/expired', kind: 'document', expiresAt: '2020-01-01T00:00:00Z' }
      }
    })
    setAtumDmWorkspaceAccount('account-a')
    selectAtumDmArtifact('andy-expiry', ref)
    await vi.waitFor(() =>
      expect($atumDmPreviewByConversation.get()['andy-expiry']?.url).toBe('https://andy.test/current')
    )

    let deny!: (value: unknown) => void
    artifact.mockReturnValueOnce(
      new Promise(resolve => {
        deny = resolve
      })
    )
    selectAtumDmArtifact('andy-expiry', ref)
    expect($atumDmPreviewByConversation.get()['andy-expiry']).toBeUndefined()
    deny({ state: 'denied', artifact: null })
    await vi.waitFor(() => expect(artifactState('andy-expiry')).toBe('denied'))
    expect($atumDmPreviewByConversation.get()['andy-expiry']).toBeUndefined()
  })

  it('keeps multiple Moon and Andy artifact tabs in one conversation and restores the exact active ref', async () => {
    artifact.mockImplementation(async (_conversationId: string, resourceId: string) => ({
      state: 'ready',
      artifact: {
        artifactId: resourceId,
        type: resourceId.startsWith('moon.') ? 'reading' : 'document',
        title: resourceId.startsWith('moon.') ? 'Lá số' : 'Phiếu tổng kết',
        status: 'ready',
        url: `https://atum.test/artifacts/${encodeURIComponent(resourceId)}`
      }
    }))
    setAtumDmWorkspaceAccount('multi-artifact-account')
    selectAtumDmArtifact('shared-conversation', {
      kind: 'artifact',
      resourceId: 'moon.laso:77',
      type: 'reading',
      title: 'Lá số',
      status: 'ready'
    })
    selectAtumDmArtifact('shared-conversation', {
      kind: 'artifact',
      resourceId: 'andy.receipt:77',
      type: 'document',
      title: 'Phiếu tổng kết',
      status: 'ready'
    })
    await vi.waitFor(() => expect(artifactState('shared-conversation', 'andy.receipt:77')).toBe('ready'))

    activateAtumDmArtifact('shared-conversation', 'moon.laso:77')
    selectAtumDmArtifact('shared-conversation', {
      kind: 'artifact',
      resourceId: 'moon.laso:77',
      type: 'reading',
      title: 'Lá số mới',
      status: 'ready'
    })
    await vi.waitFor(() => expect(artifactState('shared-conversation', 'moon.laso:77')).toBe('ready'))
    const beforeRestart = $atumDmArtifactByConversation.get()['shared-conversation']!
    expect(beforeRestart.tabs.map(tab => tab.ref.resourceId)).toEqual(['moon.laso:77', 'andy.receipt:77'])
    expect(beforeRestart.tabs[0]?.ref.title).toBe('Lá số mới')
    expect(beforeRestart.activeResourceId).toBe('moon.laso:77')
    expect($atumDmPreviewByConversation.get()['shared-conversation']?.url).toContain('moon.laso%3A77')

    clearAtumDmWorkspace()
    artifact.mockClear()
    setAtumDmWorkspaceAccount('multi-artifact-account')
    const restored = $atumDmArtifactByConversation.get()['shared-conversation']!
    expect(restored.activeResourceId).toBe('moon.laso:77')
    expect(restored.tabs).toHaveLength(2)
    expect(restored.tabs.every(tab => tab.state === 'idle' && tab.target === null)).toBe(true)

    await resolveAtumDmArtifact('shared-conversation')
    expect(artifact).toHaveBeenCalledTimes(1)
    expect(artifact).toHaveBeenCalledWith('shared-conversation', 'moon.laso:77')

    closeAtumDmArtifact('shared-conversation', 'moon.laso:77')
    expect($atumDmArtifactByConversation.get()['shared-conversation']).toMatchObject({
      activeResourceId: 'andy.receipt:77',
      tabs: [{ ref: { resourceId: 'andy.receipt:77' } }]
    })
  })

  it('cannot apply an old response after a tab is closed and the same opaque ref is reopened', async () => {
    const finishes: Array<(value: unknown) => void> = []
    artifact.mockImplementation(
      () =>
        new Promise(resolve => {
          finishes.push(resolve)
        })
    )

    const ref = {
      kind: 'artifact' as const,
      resourceId: 'moon.laso:race',
      type: 'reading',
      title: 'Lá số',
      status: 'ready' as const
    }

    setAtumDmWorkspaceAccount('race-account')
    selectAtumDmArtifact('race-conversation', ref)
    closeAtumDmArtifact('race-conversation', ref.resourceId)
    selectAtumDmArtifact('race-conversation', ref)

    finishes[0]!({
      state: 'ready',
      artifact: {
        artifactId: ref.resourceId,
        type: ref.type,
        title: ref.title,
        status: 'ready',
        url: 'https://old.test'
      }
    })
    await Promise.resolve()
    expect(artifactState('race-conversation')).toBe('loading')
    expect($atumDmPreviewByConversation.get()['race-conversation']).toBeUndefined()

    finishes[1]!({
      state: 'ready',
      artifact: {
        artifactId: ref.resourceId,
        type: ref.type,
        title: ref.title,
        status: 'ready',
        url: 'https://new.test'
      }
    })
    await vi.waitFor(() =>
      expect($atumDmPreviewByConversation.get()['race-conversation']?.url).toBe('https://new.test')
    )
  })

  it('bounds one conversation to the newest 16 URL-free artifact tabs', () => {
    artifact.mockResolvedValue({ state: 'offline', artifact: null })
    setAtumDmWorkspaceAccount('bounded-account')

    for (let index = 1; index <= 17; index += 1) {
      selectAtumDmArtifact('bounded-conversation', {
        kind: 'artifact',
        resourceId: `future.artifact:${index}`,
        type: 'document',
        title: `Artifact ${index}`,
        status: 'ready'
      })
    }

    const workspace = $atumDmArtifactByConversation.get()['bounded-conversation']!
    expect(workspace.tabs).toHaveLength(16)
    expect(workspace.tabs[0]?.ref.resourceId).toBe('future.artifact:2')
    expect(workspace.tabs.at(-1)?.ref.resourceId).toBe('future.artifact:17')
    expect(workspace.activeResourceId).toBe('future.artifact:17')
    expect(workspace.closedRefs.map(ref => ref.resourceId)).toEqual(['future.artifact:1'])
  })

  it('re-resolves an expired signed embed when its tab is activated again', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    artifact.mockImplementation(async (_conversationId: string, resourceId: string) => ({
      state: 'ready',
      artifact: {
        artifactId: resourceId,
        type: 'reading',
        title: resourceId,
        status: 'ready',
        url: `https://atum.test/fallback/${resourceId}`,
        ...(resourceId === 'moon.laso:expiring'
          ? {
              embed: {
                expiresAt: new Date(Date.now() < 2_000 ? 2_000 : 5_000).toISOString(),
                kind: 'interactive_view',
                url: `https://atum.test/embed/${Date.now() < 2_000 ? 'old' : 'fresh'}`
              }
            }
          : {})
      }
    }))
    setAtumDmWorkspaceAccount('expiry-account')
    selectAtumDmArtifact('expiry-conversation', {
      kind: 'artifact',
      resourceId: 'moon.laso:expiring',
      type: 'reading',
      title: 'Lá số',
      status: 'ready'
    })
    await vi.waitFor(() =>
      expect($atumDmPreviewByConversation.get()['expiry-conversation']?.url).toBe('https://atum.test/embed/old')
    )
    selectAtumDmArtifact('expiry-conversation', {
      kind: 'artifact',
      resourceId: 'andy.document:current',
      type: 'document',
      title: 'Phiếu tổng kết',
      status: 'ready'
    })
    await vi.waitFor(() => expect(artifactState('expiry-conversation', 'andy.document:current')).toBe('ready'))

    now.mockReturnValue(3_000)
    artifact.mockClear()
    activateAtumDmArtifact('expiry-conversation', 'moon.laso:expiring')
    expect($atumDmPreviewByConversation.get()['expiry-conversation']).toBeUndefined()
    await vi.waitFor(() =>
      expect($atumDmPreviewByConversation.get()['expiry-conversation']?.url).toBe('https://atum.test/embed/fresh')
    )
    expect(artifact).toHaveBeenCalledWith('expiry-conversation', 'moon.laso:expiring')
    now.mockRestore()
  })

  it('re-resolves an expired sibling when closing the active tab promotes it', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    artifact.mockImplementation(async (_conversationId: string, resourceId: string) => ({
      state: 'ready',
      artifact: {
        artifactId: resourceId,
        type: 'document',
        title: resourceId,
        status: 'ready',
        url: `https://atum.test/fallback/${resourceId}`,
        ...(resourceId === 'andy.document:expiring'
          ? {
              embed: {
                expiresAt: new Date(Date.now() < 2_000 ? 2_000 : 5_000).toISOString(),
                kind: 'document',
                url: `https://atum.test/embed/${Date.now() < 2_000 ? 'old-document' : 'fresh-document'}`
              }
            }
          : {})
      }
    }))
    setAtumDmWorkspaceAccount('close-expiry-account')
    selectAtumDmArtifact('close-expiry-conversation', {
      kind: 'artifact',
      resourceId: 'andy.document:expiring',
      type: 'document',
      title: 'Phiếu tổng kết',
      status: 'ready'
    })
    await vi.waitFor(() => expect(artifactState('close-expiry-conversation')).toBe('ready'))
    selectAtumDmArtifact('close-expiry-conversation', {
      kind: 'artifact',
      resourceId: 'moon.laso:current',
      type: 'reading',
      title: 'Lá số',
      status: 'ready'
    })
    await vi.waitFor(() => expect(artifactState('close-expiry-conversation')).toBe('ready'))

    now.mockReturnValue(3_000)
    artifact.mockClear()
    closeAtumDmArtifact('close-expiry-conversation', 'moon.laso:current')
    expect($atumDmPreviewByConversation.get()['close-expiry-conversation']).toBeUndefined()
    await vi.waitFor(() =>
      expect($atumDmPreviewByConversation.get()['close-expiry-conversation']?.url).toBe(
        'https://atum.test/embed/fresh-document'
      )
    )
    expect(artifact).toHaveBeenCalledWith('close-expiry-conversation', 'andy.document:expiring')
    now.mockRestore()
  })

  it('reuses valid authority and refreshes expired authority when closing the launcher', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    artifact.mockImplementation(async (_conversationId: string, resourceId: string) => ({
      state: 'ready',
      artifact: {
        artifactId: resourceId,
        type: 'document',
        title: resourceId,
        status: 'ready',
        url: `https://atum.test/fallback/${resourceId}`,
        embed: {
          expiresAt: new Date(Date.now() < 2_000 ? 2_000 : 5_000).toISOString(),
          kind: 'document',
          url: `https://atum.test/embed/${Date.now() < 2_000 ? 'cached' : 'fresh'}`
        }
      }
    }))
    setAtumDmWorkspaceAccount('launcher-authority-account')
    selectAtumDmArtifact('launcher-authority-conversation', {
      kind: 'artifact',
      resourceId: 'andy.document:launcher-authority',
      type: 'document',
      title: 'Phiếu tổng kết',
      status: 'ready'
    })
    await vi.waitFor(() => expect(artifactState('launcher-authority-conversation')).toBe('ready'))
    expect($atumDmAttentionByConversation.get()).toEqual({ 'launcher-authority-conversation': 'complete' })

    openAtumDmLauncher('launcher-authority-conversation')
    artifact.mockClear()
    closeAtumDmLauncher('launcher-authority-conversation')
    expect($atumDmAttentionByConversation.get()).toEqual({})
    expect($atumDmPreviewByConversation.get()['launcher-authority-conversation']?.url).toBe(
      'https://atum.test/embed/cached'
    )
    expect(artifact).not.toHaveBeenCalled()

    openAtumDmLauncher('launcher-authority-conversation')
    now.mockReturnValue(3_000)
    closeAtumDmLauncher('launcher-authority-conversation')
    expect($atumDmPreviewByConversation.get()['launcher-authority-conversation']).toBeUndefined()
    await vi.waitFor(() =>
      expect($atumDmPreviewByConversation.get()['launcher-authority-conversation']?.url).toBe(
        'https://atum.test/embed/fresh'
      )
    )
    expect(artifact).toHaveBeenCalledWith('launcher-authority-conversation', 'andy.document:launcher-authority')
    now.mockRestore()
  })

  it('keeps only bounded URL-free history when the final tab closes and reopens it with fresh authority', async () => {
    artifact.mockResolvedValue({ state: 'offline', artifact: null })
    setAtumDmWorkspaceAccount('last-tab-account')
    selectAtumDmArtifact('last-tab-conversation', {
      kind: 'artifact',
      resourceId: 'future.artifact:last',
      type: 'document',
      title: 'Last artifact',
      status: 'ready'
    })

    closeAtumDmArtifact('last-tab-conversation', 'future.artifact:last')

    expect($atumDmArtifactByConversation.get()['last-tab-conversation']).toMatchObject({
      activeResourceId: null,
      closedRefs: [{ resourceId: 'future.artifact:last' }],
      tabs: []
    })
    expect($atumDmPreviewByConversation.get()['last-tab-conversation']).toBeUndefined()

    const stored = JSON.parse(localStorage.getItem('hermes.desktop.atum.dmArtifactRefs.v1') ?? '{}') as Record<
      string,
      Record<string, unknown>
    >

    expect(stored['last-tab-account']?.['last-tab-conversation']).toMatchObject({
      activeResourceId: null,
      closedRefs: [{ resourceId: 'future.artifact:last' }],
      refs: []
    })
    expect(localStorage.getItem('hermes.desktop.atum.dmArtifactRefs.v1')).not.toContain('https://')

    clearAtumDmWorkspace()
    setAtumDmWorkspaceAccount('last-tab-account')
    expect($atumDmArtifactByConversation.get()['last-tab-conversation']).toMatchObject({
      activeResourceId: null,
      closedRefs: [{ resourceId: 'future.artifact:last' }],
      tabs: []
    })

    artifact.mockClear()
    expect(reopenLastClosedAtumDmArtifact('last-tab-conversation')).toBe('future.artifact:last')
    expect($atumDmArtifactByConversation.get()['last-tab-conversation']).toMatchObject({
      activeResourceId: 'future.artifact:last',
      closedRefs: [],
      tabs: [{ ref: { resourceId: 'future.artifact:last' }, state: 'loading', target: null }]
    })
    await vi.waitFor(() => expect(artifactState('last-tab-conversation')).toBe('offline'))
    expect(artifact).toHaveBeenCalledWith('last-tab-conversation', 'future.artifact:last')
  })

  it('reorders tabs without resolving and restores the exact order after relaunch', () => {
    artifact.mockResolvedValue({ state: 'offline', artifact: null })
    setAtumDmWorkspaceAccount('reorder-account')

    for (const resourceId of ['artifact:one', 'artifact:two', 'artifact:three']) {
      selectAtumDmArtifact('reorder-conversation', {
        kind: 'artifact',
        resourceId,
        type: 'document',
        title: resourceId,
        status: 'ready'
      })
    }

    artifact.mockClear()
    moveAtumDmArtifact('reorder-conversation', 'artifact:three', 0)
    expect($atumDmArtifactByConversation.get()['reorder-conversation']?.tabs.map(tab => tab.ref.resourceId)).toEqual([
      'artifact:three',
      'artifact:one',
      'artifact:two'
    ])
    expect(artifact).not.toHaveBeenCalled()

    clearAtumDmWorkspace()
    setAtumDmWorkspaceAccount('reorder-account')
    expect($atumDmArtifactByConversation.get()['reorder-conversation']?.tabs.map(tab => tab.ref.resourceId)).toEqual([
      'artifact:three',
      'artifact:one',
      'artifact:two'
    ])
    expect($atumDmArtifactByConversation.get()['reorder-conversation']?.activeResourceId).toBe('artifact:three')
  })

  it('restores a launcher in exact mixed order without consuming it when an artifact opens', () => {
    artifact.mockResolvedValue({ state: 'offline', artifact: null })
    setAtumDmWorkspaceAccount('launcher-account')

    openAtumDmLauncher('moon-conversation')
    selectAtumDmArtifact('moon-conversation', {
      kind: 'artifact',
      resourceId: 'moon.laso:launcher-proof',
      type: 'reading',
      title: 'Lá số',
      status: 'ready'
    })

    let workspace = $atumDmArtifactByConversation.get()['moon-conversation']!
    expect(workspace.launcherOpen).toBe(true)
    expect(workspace.activeSurface).toBe('artifact')
    expect(atumDmWorkspaceTabs(workspace)).toEqual([
      { kind: 'launcher' },
      { kind: 'artifact', resourceId: 'moon.laso:launcher-proof' }
    ])

    moveAtumDmLauncher('moon-conversation', 1)
    activateAtumDmLauncher('moon-conversation')
    workspace = $atumDmArtifactByConversation.get()['moon-conversation']!
    expect(workspace.activeResourceId).toBeNull()
    expect(workspace.activeSurface).toBe('launcher')
    expect(atumDmWorkspaceTabs(workspace)).toEqual([
      { kind: 'artifact', resourceId: 'moon.laso:launcher-proof' },
      { kind: 'launcher' }
    ])
    expect($atumDmPreviewByConversation.get()['moon-conversation']).toBeUndefined()

    const stored = localStorage.getItem('hermes.desktop.atum.dmArtifactRefs.v1')!
    expect(stored).toContain('"launcherOpen":true')
    expect(stored).not.toContain('https://')
    expect($atumDmArtifactByConversation.get()['andy-conversation']).toBeUndefined()

    clearAtumDmWorkspace()
    setAtumDmWorkspaceAccount('launcher-account')
    workspace = $atumDmArtifactByConversation.get()['moon-conversation']!
    expect(workspace.activeSurface).toBe('launcher')
    expect(atumDmWorkspaceTabs(workspace)).toEqual([
      { kind: 'artifact', resourceId: 'moon.laso:launcher-proof' },
      { kind: 'launcher' }
    ])

    expect(closeAtumDmLauncher('moon-conversation')).toBe('moon.laso:launcher-proof')
    expect($atumDmArtifactByConversation.get()['moon-conversation']).toMatchObject({
      activeResourceId: 'moon.laso:launcher-proof',
      activeSurface: 'artifact',
      launcherOpen: false
    })
  })

  it('bounds launcher reorder input without resolving artifacts', () => {
    artifact.mockResolvedValue({ state: 'offline', artifact: null })
    setAtumDmWorkspaceAccount('launcher-bounds-account')
    openAtumDmLauncher('launcher-bounds-conversation')

    for (const resourceId of ['artifact:one', 'artifact:two']) {
      selectAtumDmArtifact('launcher-bounds-conversation', {
        kind: 'artifact',
        resourceId,
        type: 'document',
        title: resourceId,
        status: 'ready'
      })
    }

    artifact.mockClear()
    moveAtumDmLauncher('launcher-bounds-conversation', Number.NaN)
    expect(atumDmWorkspaceTabs($atumDmArtifactByConversation.get()['launcher-bounds-conversation']!)[0]).toEqual({
      kind: 'launcher'
    })
    moveAtumDmLauncher('launcher-bounds-conversation', 200)
    expect(atumDmWorkspaceTabs($atumDmArtifactByConversation.get()['launcher-bounds-conversation']!).at(-1)).toEqual(
      { kind: 'launcher' }
    )
    moveAtumDmLauncher('launcher-bounds-conversation', -20)
    expect(atumDmWorkspaceTabs($atumDmArtifactByConversation.get()['launcher-bounds-conversation']!)[0]).toEqual({
      kind: 'launcher'
    })
    expect(artifact).not.toHaveBeenCalled()
  })

  it('moves an artifact across the launcher without resolving or leaking the opaque ref into drag state', () => {
    artifact.mockResolvedValue({ state: 'offline', artifact: null })
    setAtumDmWorkspaceAccount('mixed-order-account')
    openAtumDmLauncher('mixed-order-conversation')

    for (const resourceId of ['artifact:one', 'artifact:two']) {
      selectAtumDmArtifact('mixed-order-conversation', {
        kind: 'artifact',
        resourceId,
        type: 'document',
        title: resourceId,
        status: 'ready'
      })
    }

    artifact.mockClear()
    moveAtumDmArtifact('mixed-order-conversation', 'artifact:two', 0)
    expect(atumDmWorkspaceTabs($atumDmArtifactByConversation.get()['mixed-order-conversation']!)).toEqual([
      { kind: 'artifact', resourceId: 'artifact:two' },
      { kind: 'launcher' },
      { kind: 'artifact', resourceId: 'artifact:one' }
    ])
    expect(artifact).not.toHaveBeenCalled()
  })

  it('bounds closed history to the newest 16 refs within its account and conversation', () => {
    artifact.mockResolvedValue({ state: 'offline', artifact: null })
    setAtumDmWorkspaceAccount('history-account')

    for (let index = 1; index <= 17; index += 1) {
      const resourceId = `history.artifact:${index}`
      selectAtumDmArtifact('history-conversation', {
        kind: 'artifact',
        resourceId,
        type: 'document',
        title: `History ${index}`,
        status: 'ready'
      })
      closeAtumDmArtifact('history-conversation', resourceId)
    }

    const history = $atumDmArtifactByConversation.get()['history-conversation']?.closedRefs ?? []
    expect(history).toHaveLength(16)
    expect(history[0]?.resourceId).toBe('history.artifact:2')
    expect(history.at(-1)?.resourceId).toBe('history.artifact:17')

    setAtumDmWorkspaceAccount('other-account')
    expect($atumDmArtifactByConversation.get()).toEqual({})
  })

  it('deduplicates a history ref selected at the live cap and fences the evicted request', async () => {
    let finishEvicted!: (value: unknown) => void
    artifact.mockImplementation((_conversationId: string, resourceId: string) =>
      resourceId === 'artifact:evicted'
        ? new Promise(resolve => {
            finishEvicted = resolve
          })
        : Promise.resolve({ state: 'offline', artifact: null })
    )
    setAtumDmWorkspaceAccount('eviction-account')

    selectAtumDmArtifact('eviction-conversation', {
      kind: 'artifact',
      resourceId: 'artifact:history',
      type: 'document',
      title: 'History',
      status: 'ready'
    })
    closeAtumDmArtifact('eviction-conversation', 'artifact:history')

    for (let index = 0; index < 16; index += 1) {
      selectAtumDmArtifact('eviction-conversation', {
        kind: 'artifact',
        resourceId: index === 0 ? 'artifact:evicted' : `artifact:live-${index}`,
        type: 'document',
        title: `Live ${index}`,
        status: 'ready'
      })
    }

    selectAtumDmArtifact('eviction-conversation', {
      kind: 'artifact',
      resourceId: 'artifact:history',
      type: 'document',
      title: 'History',
      status: 'ready'
    })

    const workspace = $atumDmArtifactByConversation.get()['eviction-conversation']!
    expect(workspace.tabs.map(tab => tab.ref.resourceId)).not.toContain('artifact:evicted')
    expect(workspace.closedRefs.map(ref => ref.resourceId)).toEqual(['artifact:evicted'])
    expect(workspace.closedRefs.map(ref => ref.resourceId)).not.toContain('artifact:history')

    finishEvicted({
      state: 'ready',
      artifact: {
        artifactId: 'artifact:evicted',
        type: 'document',
        title: 'Evicted',
        status: 'ready',
        url: 'https://atum.test/private-evicted'
      }
    })
    await Promise.resolve()
    expect($atumDmPreviewByConversation.get()['eviction-conversation']?.url).not.toBe(
      'https://atum.test/private-evicted'
    )

    closeAtumDmArtifact('eviction-conversation', 'artifact:live-1')
    expect(reopenLastClosedAtumDmArtifact('eviction-conversation')).toBe('artifact:live-1')
    expect(
      new Set($atumDmArtifactByConversation.get()['eviction-conversation']!.tabs.map(tab => tab.ref.resourceId)).size
    ).toBe(16)
  })

  it('rejects reopen boundaries and safely bounds reorder indices', () => {
    artifact.mockResolvedValue({ state: 'offline', artifact: null })
    setAtumDmWorkspaceAccount('boundary-account')

    expect(reopenLastClosedAtumDmArtifact('missing-conversation')).toBeNull()

    for (let index = 0; index < 16; index += 1) {
      selectAtumDmArtifact('boundary-conversation', {
        kind: 'artifact',
        resourceId: `artifact:${index}`,
        type: 'document',
        title: `Artifact ${index}`,
        status: 'ready'
      })
    }

    closeAtumDmArtifact('boundary-conversation', 'artifact:15')
    selectAtumDmArtifact('boundary-conversation', {
      kind: 'artifact',
      resourceId: 'artifact:replacement',
      type: 'document',
      title: 'Replacement',
      status: 'ready'
    })
    expect(reopenLastClosedAtumDmArtifact('boundary-conversation')).toBeNull()

    moveAtumDmArtifact('boundary-conversation', 'artifact:replacement', Number.NaN)
    moveAtumDmArtifact('boundary-conversation', 'artifact:replacement', -20)
    expect($atumDmArtifactByConversation.get()['boundary-conversation']?.tabs[0]?.ref.resourceId).toBe(
      'artifact:replacement'
    )
    moveAtumDmArtifact('boundary-conversation', 'artifact:replacement', 200)
    expect($atumDmArtifactByConversation.get()['boundary-conversation']?.tabs.at(-1)?.ref.resourceId).toBe(
      'artifact:replacement'
    )
  })
})
