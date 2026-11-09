import { expect, it, vi } from 'vitest'

import { agentAppsDiscovery, agentStoreDiscovery } from '../../shared/agent-discovery'

const row = {
  itemId: 'agent/focus',
  kind: 'agent',
  title: { vi: 'Tập trung', en: 'Focus' },
  summary: { vi: 'Nghiên cứu' },
  description: { vi: 'Trợ lý nghiên cứu' },
  tryPrompt: { vi: 'Nghiên cứu giúp tôi' },
  needs: ['internet'],
  glyph: '✦',
  accent: '#123456',
  featured: false,
  sortOrder: 1,
  deliverable: true,
  offer: {
    id: '00000000-0000-4000-8000-993224b4fe85',
    version: 2,
    priceMicroProtons: 100,
    renewalPriceMicroProtons: 120,
    scope: 'agent',
    billingInterval: 'month',
    delivery: 'cloud'
  },
  ownership: { state: 'owned', source: 'purchase', assistantIds: ['00000000-0000-4000-8000-008bf60b9309'], until: null }
}
const app = {
  app: 'river',
  app_id: '00000000-0000-4000-8000-11e594f48195',
  app_version_id: '00000000-0000-4000-8000-e79acd97ac88',
  name: { en: 'River' },
  subtitle: null,
  description: { en: 'Explore the current.' },
  icon: null,
  accent: null,
  affiliation: 'partner',
  verified: false,
  availability: 'available',
  roster_default: false,
  roster_order: 0,
  supported_modes: ['direct'],
  has_surface: true,
  link: { mode: 'none', state: 'never_linked' }
}
const apps = () => ({ profile: 'atum.app-catalog/1', apps: [app] })

it('reads fresh Store bytes and retains current terms/ownership without an acquisition port', async () => {
  const read = vi.fn(async () => ({ items: [row] }))
  const result = await agentStoreDiscovery({
    payload: { operation: 'inspect', itemId: row.itemId },
    read,
    current: () => true
  })
  expect(result).toMatchObject({
    outcome: 'ok',
    items: [
      {
        itemId: row.itemId,
        offer: row.offer,
        ownership: row.ownership,
        destination: { surface: 'discover', shelf: 'agents', itemId: row.itemId }
      }
    ]
  })
  expect(read).toHaveBeenCalledTimes(1)
})

it('never exposes old-account catalogs, malformed data, or caller-selected authority', async () => {
  let current = true
  const read = vi.fn(async () => {
    current = false
    return { items: [row] }
  })
  const input = { payload: { operation: 'search' }, read, current: () => current }
  expect(await agentStoreDiscovery(input)).toHaveProperty('error')
  expect(
    await agentStoreDiscovery({ ...input, current: () => true, payload: { operation: 'search', owner: 'forged' } })
  ).toHaveProperty('error')
  expect(read).toHaveBeenCalledTimes(1)
  expect(
    await agentStoreDiscovery({ ...input, current: () => true, read: async () => ({ items: [{}] }) })
  ).toHaveProperty('error')
  expect(await agentStoreDiscovery({ ...input, current: () => true, read: async () => ({ items: [] }) })).toMatchObject(
    { outcome: 'ok', items: [] }
  )
})

it('returns public Apps metadata, and a cloud destination is not an opened receipt', async () => {
  expect(
    await agentAppsDiscovery({
      read: async () => ({ ...apps(), apps: [{ ...app, privateContent: 'secret' }] }),
      current: () => true
    })
  ).toMatchObject({ apps: [{ id: 'river', name: 'River' }] })
  const cloud = await agentAppsDiscovery({ read: async () => apps(), current: () => true, appId: 'river' })
  expect(cloud).toMatchObject({
    switched: false,
    destination: { surface: 'discover', shelf: 'apps', appId: app.app_id }
  })
  expect(JSON.stringify(cloud)).not.toContain('privateContent')
})

it('only confirms a Mac switch after the existing navigation port completes in the same account', async () => {
  let current = true
  const open = vi.fn(async () => {})
  const input = { read: async () => apps(), current: () => current, open, appId: ' River ' }
  expect(await agentAppsDiscovery(input)).toMatchObject({ switched: true })
  expect(open).toHaveBeenCalledExactlyOnceWith(app.app_id)
  open.mockImplementation(async () => {
    current = false
  })
  expect(await agentAppsDiscovery(input)).toMatchObject({ switched: false, error: expect.any(String) })
  expect(await agentAppsDiscovery({ ...input, current: () => true, appId: 'unknown' })).toMatchObject({
    switched: false,
    error: expect.any(String)
  })
  expect(open).toHaveBeenCalledTimes(2)
})
