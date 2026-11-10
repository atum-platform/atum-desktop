import { expect, it } from 'vitest'

import { type MatrixAgentSourcesView, safeMatrixAgentSourceIconDataUrl } from '../../shared/matrix-agent-sources'

import { projectMatrixKnowledgeSourceRows } from './knowledge-source-projection'

const gates = {
  google: true,
  folders: true,
  messages: true,
  browser: true,
  location: true,
  team_spaces: true
}

function source(
  kind: string,
  optOutGate: string,
  input: Partial<MatrixAgentSourcesView['sources'][number]> = {}
): MatrixAgentSourcesView['sources'][number] {
  return {
    kind,
    optOutGate,
    availability: 'available',
    status: 'ready',
    grantable: true,
    ...input
  }
}

it('keeps an unknown descriptor kind visible with the generic presentation', () => {
  const rows = projectMatrixKnowledgeSourceRows({
    macs: [],
    gates,
    sources: [source('future.private-journal', 'messages')]
  })

  expect(rows).toEqual([
    expect.objectContaining({
      gate: 'messages',
      kind: 'unknown',
      kinds: ['future.private-journal'],
      checked: true,
      disabled: false
    })
  ])
})

it('prefers trusted connection presentation without depending on a source id', () => {
  const presentation = {
    label: 'Travel app',
    description: 'Trips used in your chats.',
    iconDataUrl: 'data:image/png;base64,cHJlc2VudGF0aW9u'
  }
  const rows = projectMatrixKnowledgeSourceRows({
    macs: [],
    gates,
    sources: [source('future.travel', 'team_spaces', { presentation })]
  })

  expect(rows[0]).toMatchObject({ kind: 'unknown', presentation })
})

it('combines descriptors sharing a gate into one switch reporting the most useful status', () => {
  const rows = projectMatrixKnowledgeSourceRows({
    macs: [],
    gates,
    sources: [
      source('google.mail', 'google', { status: 'not_connected', availability: 'not_configured' }),
      source('google.calendar', 'google'),
      source('google.drive', 'google', { status: 'unavailable', availability: 'unavailable' })
    ]
  })

  expect(rows).toEqual([
    expect.objectContaining({
      gate: 'google',
      kind: 'google',
      sourceCount: 3,
      status: 'ready',
      checked: true
    })
  ])
})

it.each([
  ['ready', true],
  ['held_off_by_older_mac', true],
  ['mac_offline', true],
  ['update_mac', true],
  ['this_mac_disconnected', true],
  ['needs_permission', true],
  ['not_connected', true],
  ['needs_mac', false],
  ['unavailable', false]
] as const)('keeps the saved switch while the source is %s', (status, grantable) => {
  for (const saved of [true, false]) {
    const row = projectMatrixKnowledgeSourceRows({
      macs: [],
      gates: { ...gates, messages: saved },
      sources: [source('mac.message-metadata', 'messages', { status, grantable })]
    })[0]!

    // The switch is the account choice, never the availability.
    expect(row).toMatchObject({ status, checked: saved, disabled: !grantable, switchable: true })
  }
})

it('carries the macOS pane only for a source that needs permission', () => {
  const needs = projectMatrixKnowledgeSourceRows({
    macs: [],
    gates,
    sources: [source('mac.browser-history', 'browser', { status: 'needs_permission', permission: 'fullDisk' })]
  })[0]!
  const ready = projectMatrixKnowledgeSourceRows({
    macs: [],
    gates,
    sources: [source('mac.browser-history', 'browser', { status: 'ready', permission: 'fullDisk' })]
  })[0]!

  expect(needs.permission).toBe('fullDisk')
  expect(ready).not.toHaveProperty('permission')
})

it('treats a source with no status fact as unavailable without touching the switch', () => {
  const row = projectMatrixKnowledgeSourceRows({
    macs: [],
    gates,
    sources: [{ kind: 'future.thing', optOutGate: 'folders', availability: 'available', grantable: true } as never]
  })[0]!

  expect(row).toMatchObject({ status: 'unavailable', checked: true })
})

it.each([
  'data:image/png;base64,QUJDRA==', 'data:image/jpeg;base64,QUJDRA==',
  'data:image/webp;base64,QUJDRA==', 'data:image/gif;base64,QUJDRA==', 'https://apps.example/icon.png'
])('allows a safe source icon URL: %s', value => {
  expect(safeMatrixAgentSourceIconDataUrl(value)).toBe(value)
})

it.each([
  'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PGgxPkJvb208L2gxPg==',
  'http://apps.example/icon.png', 'javascript:alert(1)', 'file:///tmp/icon.png',
  'data:image/png;base64,not valid', 'https://user@apps.example/icon.png',
  'https://user:password@apps.example/icon.png', `data:image/png;base64,${'A'.repeat(16_384)}`
])('rejects an unsafe source icon URL: %s', value => {
  expect(safeMatrixAgentSourceIconDataUrl(value)).toBeUndefined()
})
