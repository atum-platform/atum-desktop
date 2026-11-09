import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/atum-messaging-client', () => ({ atumMessagingClient: () => ({ artifact: vi.fn() }) }))

const STORAGE_KEY = 'hermes.desktop.atum.dmArtifactRefs.v1'

beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

describe('hosted-DM artifact workspace persistence migration', () => {
  it('upgrades the resolver checkpoint one-ref shape into an exact one-tab workspace', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        'legacy-account': {
          'moon-conversation': {
            kind: 'artifact',
            resourceId: 'moon.laso:legacy',
            status: 'ready',
            title: 'Lá số cũ',
            type: 'reading'
          }
        }
      })
    )

    const store = await import('./atum-dm-workspace')
    store.setAtumDmWorkspaceAccount('legacy-account')

    expect(store.$atumDmArtifactByConversation.get()['moon-conversation']).toEqual({
      activeResourceId: 'moon.laso:legacy',
      activeSurface: 'artifact',
      closedRefs: [],
      launcherIndex: null,
      launcherOpen: false,
      tabs: [
        {
          attention: null,
          ref: {
            kind: 'artifact',
            resourceId: 'moon.laso:legacy',
            status: 'ready',
            title: 'Lá số cũ',
            type: 'reading'
          },
          state: 'idle',
          target: null,
          targetExpiresAt: null
        }
      ]
    })

    const migrated = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, Record<string, unknown>>
    expect(migrated['legacy-account']?.['moon-conversation']).toMatchObject({
      activeResourceId: 'moon.laso:legacy',
      closedRefs: [],
      refs: [{ resourceId: 'moon.laso:legacy' }]
    })
  })

  it('decodes the prior multi-ref shape with empty closed history', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        'multi-account': {
          'andy-conversation': {
            activeResourceId: 'andy.receipt:2',
            refs: [
              {
                kind: 'artifact',
                resourceId: 'moon.laso:1',
                status: 'ready',
                title: 'Lá số',
                type: 'reading'
              },
              {
                kind: 'artifact',
                resourceId: 'andy.receipt:2',
                status: 'ready',
                title: 'Receipt',
                type: 'receipt'
              }
            ]
          }
        }
      })
    )

    const store = await import('./atum-dm-workspace')
    store.setAtumDmWorkspaceAccount('multi-account')

    expect(store.$atumDmArtifactByConversation.get()['andy-conversation']).toMatchObject({
      activeResourceId: 'andy.receipt:2',
      closedRefs: [],
      tabs: [{ ref: { resourceId: 'moon.laso:1' } }, { ref: { resourceId: 'andy.receipt:2' } }]
    })
  })

  it('recovers a dangling active ref to the first validated tab', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        'recovery-account': {
          'future-conversation': {
            activeResourceId: 'artifact:missing',
            refs: [
              {
                kind: 'artifact',
                resourceId: 'artifact:recoverable',
                status: 'ready',
                title: 'Recoverable',
                type: 'document'
              }
            ]
          }
        }
      })
    )

    const store = await import('./atum-dm-workspace')
    store.setAtumDmWorkspaceAccount('recovery-account')

    expect(store.$atumDmArtifactByConversation.get()['future-conversation']).toMatchObject({
      activeResourceId: 'artifact:recoverable',
      activeSurface: 'artifact',
      tabs: [{ ref: { resourceId: 'artifact:recoverable' } }]
    })
  })

  it('clamps persisted launcher position and ignores launcher activation when it is closed', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        'launcher-account': {
          'open-conversation': {
            activeResourceId: null,
            activeSurface: 'launcher',
            launcherIndex: 99,
            launcherOpen: true,
            refs: []
          },
          'closed-conversation': {
            activeResourceId: 'artifact:ready',
            activeSurface: 'launcher',
            launcherIndex: 0,
            launcherOpen: false,
            refs: [
              {
                kind: 'artifact',
                resourceId: 'artifact:ready',
                status: 'ready',
                title: 'Ready',
                type: 'document'
              }
            ]
          }
        }
      })
    )

    const store = await import('./atum-dm-workspace')
    store.setAtumDmWorkspaceAccount('launcher-account')

    expect(store.$atumDmArtifactByConversation.get()['open-conversation']).toMatchObject({
      activeResourceId: null,
      activeSurface: 'launcher',
      launcherIndex: 0,
      launcherOpen: true
    })
    expect(store.$atumDmArtifactByConversation.get()['closed-conversation']).toMatchObject({
      activeResourceId: 'artifact:ready',
      activeSurface: 'artifact',
      launcherIndex: null,
      launcherOpen: false
    })
  })

  it('re-decodes a history-only workspace after a real module reload', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        'history-account': {
          'future-conversation': {
            activeResourceId: null,
            closedRefs: [
              {
                kind: 'artifact',
                resourceId: 'future.document:closed',
                status: 'ready',
                title: 'Closed document',
                type: 'document'
              }
            ],
            refs: []
          }
        }
      })
    )

    const store = await import('./atum-dm-workspace')
    store.setAtumDmWorkspaceAccount('history-account')

    expect(store.$atumDmArtifactByConversation.get()['future-conversation']).toEqual({
      activeResourceId: null,
      activeSurface: null,
      closedRefs: [
        {
          kind: 'artifact',
          resourceId: 'future.document:closed',
          status: 'ready',
          title: 'Closed document',
          type: 'document'
        }
      ],
      launcherIndex: null,
      launcherOpen: false,
      tabs: []
    })
  })

  it('fails closed when persisted history carries an authority-bearing field', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        'hostile-account': {
          'moon-conversation': {
            activeResourceId: null,
            closedRefs: [
              {
                kind: 'artifact',
                resourceId: 'moon.laso:hostile',
                status: 'ready',
                title: 'Hostile',
                type: 'reading',
                url: 'https://authority.example/private'
              }
            ],
            refs: []
          }
        }
      })
    )

    const store = await import('./atum-dm-workspace')
    store.setAtumDmWorkspaceAccount('hostile-account')

    expect(store.$atumDmArtifactByConversation.get()).toEqual({})
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('authority.example')
  })

  it('restores attention only for validated open refs and allowed terminal values', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        'attention-account': {
          'moon-conversation': {
            activeResourceId: 'moon.laso:valid',
            attention: {
              'moon.laso:valid': 'complete',
              'missing.ref': 'failed',
              'moon.laso:hostile': 'https://authority.example/private'
            },
            refs: [
              {
                kind: 'artifact',
                resourceId: 'moon.laso:valid',
                status: 'ready',
                title: 'Lá số',
                type: 'reading'
              }
            ]
          }
        }
      })
    )

    const store = await import('./atum-dm-workspace')
    store.setAtumDmWorkspaceAccount('attention-account')

    expect(store.$atumDmArtifactByConversation.get()['moon-conversation']?.tabs).toMatchObject([
      { attention: 'complete', ref: { resourceId: 'moon.laso:valid' } }
    ])
    expect(store.$atumDmAttentionByConversation.get()).toEqual({ 'moon-conversation': 'complete' })
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('authority.example')
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('missing.ref')
  })
})
