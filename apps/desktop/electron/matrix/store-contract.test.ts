import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  storeCatalog,
  storeEntitlement,
  storeIntent,
  storeItem,
  storeList,
  storeOwnership,
  storePurchase,
  storeResult
} from './store-contract'

const packRoot = fileURLToPath(new URL('../../contracts/atum-store-v1/', import.meta.url))
const read = (file: string) => JSON.parse(fs.readFileSync(path.join(packRoot, file), 'utf8'))

// The published listings (atum-platform catalog/store/hub-*.yaml), as the Shell sends them here.
const hubListings = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL('./__fixtures__/store-hub-listings.json', import.meta.url)), 'utf8')
) as { items: Record<string, unknown>[] }

const pack = read('contract.json') as {
  pack_files: string[]
  fixtures: { file: string; message?: string; expect: 'accept' | 'reject' }[]
}

const consumers: Record<string, (value: unknown) => unknown> = {
  'catalog.response': storeCatalog,
  'entitlements.response': value => storeList(value, 'entitlements', storeEntitlement),
  'purchases.response': value => storeList(value, 'purchases', storePurchase),
  'purchase.request': storeIntent,
  'purchase.result': storeResult,
  'cancel.result': storeEntitlement
}

describe('frozen Store v1.1 desktop consumer', () => {
  it('verifies the manifest bytes against the published framed digest', () => {
    const hash = createHash('sha256')

    for (const file of pack.pack_files) {
      const name = Buffer.from(file)
      const body = fs.readFileSync(path.join(packRoot, file))
      const nameLength = Buffer.alloc(4)
      const bodyLength = Buffer.alloc(8)
      nameLength.writeUInt32BE(name.length)
      bodyLength.writeBigUInt64BE(BigInt(body.length))
      hash.update(nameLength).update(name).update(bodyLength).update(body)
    }

    const published = 'cfe71ed14f620085b038b5a2f735d758534dd9df8d8be038b3bcef5ab715424c'
    expect(fs.readFileSync(path.join(packRoot, 'PINNED-SHA256'), 'utf8').trim()).toBe(published)
    expect(hash.digest('hex')).toBe(published)
  })

  it.each(pack.fixtures.filter(fixture => fixture.message && consumers[fixture.message]))(
    '$file ($expect)',
    fixture => {
      const consume = () => consumers[fixture.message!]!(read(fixture.file))

      if (fixture.expect === 'accept') {
        expect(consume).not.toThrow()
      } else {
        expect(consume).toThrow('matrix_store_invalid')
      }
    }
  )

  it('preserves the legacy shape and the complete new metadata', () => {
    const old = read('fixtures/catalog-pet.json').items[0]
    expect(storeItem(old)).toEqual(old)
    const gift = read('fixtures/v11-catalog-gift-owned.json').items[0]
    expect(storeItem(gift)).toEqual(gift)
    const oldGrant = read('fixtures/entitlements-pet.json').entitlements[0]
    expect(storeEntitlement(oldGrant)).toEqual(oldGrant)
    const giftGrant = read('fixtures/v11-entitlement-gift.json').entitlements[0]
    expect(storeEntitlement(giftGrant)).toEqual(giftGrant)
    const hub = read('fixtures/v11-catalog-hub-skill.json').items[0]
    expect(storeItem(hub)).toEqual(hub)
  })

  it('accepts all five desktop card languages using the Store-compatible zh-TW key', () => {
    const item = read('fixtures/catalog-monthly-agent.json').items[0]

    const title = {
      vi: 'Phân tích dữ liệu',
      en: 'Data analyst',
      ja: 'データアナリスト',
      zh: '数据分析师',
      'zh-TW': '資料分析師'
    }

    expect(storeItem({ ...item, title }).title).toEqual(title)
  })

  it.each([
    null,
    { state: 'available', source: null, assistantIds: [] },
    { state: 'available', source: 'purchase', assistantIds: [], until: null },
    { state: 'owned', source: 'visit', assistantIds: [], until: null },
    { state: 'owned', source: 'gift', assistantIds: ['not-a-uuid'], until: null },
    { state: 'owned', source: 'gift', assistantIds: [], until: 'not-a-date' },
    { state: 'owned', source: 'gift', assistantIds: [], until: null, scope: 'account' },
    { state: 'visiting', source: 'visit', assistantIds: [], until: null }
  ])('rejects malformed metadata without falling back to an empty inventory: %j', ownership => {
    const item = read('fixtures/catalog-pet.json').items[0]
    expect(() => storeList({ items: [item, { ...item, ownership }] }, 'items', storeItem)).toThrow(
      'matrix_store_invalid'
    )
  })

  it('rejects wrong scope, duplicate assistants, invalid source and non-boolean readiness', () => {
    const id = '00000000-0000-4000-8000-cb3c7031a0b0'
    expect(() => storeOwnership({ state: 'owned', source: 'gift', assistantIds: [id], until: null }, 'pet')).toThrow()
    expect(() => storeOwnership({ state: 'owned', source: 'gift', assistantIds: [], until: null }, 'skill')).toThrow()
    expect(() =>
      storeOwnership({ state: 'owned', source: 'gift', assistantIds: [id, id], until: null }, 'agent')
    ).toThrow()
    expect(() =>
      storeOwnership({ state: 'visiting', source: 'visit', assistantIds: [], until: '2026-10-13T00:00:00Z' }, 'skill')
    ).toThrow()
    const item = read('fixtures/catalog-pet.json').items[0]
    expect(() => storeItem({ ...item, deliverable: 'yes' })).toThrow()
    const entitlement = read('fixtures/entitlements-pet.json').entitlements[0]

    for (const source of [null, undefined, 'visit', 'redeem_code']) {
      expect(() => storeEntitlement({ ...entitlement, source })).toThrow()
    }
  })

  it.each(['2026-10-13T00:00:00', '2026-10-13T00:00Z', '2026-10-13T00:00:00Z trailing', '2026-19-13T00:00:00Z'])(
    'rejects a visit timestamp outside the frozen contract: %s',
    until => {
      expect(() => storeOwnership({ state: 'visiting', source: 'visit', assistantIds: [], until }, 'pet')).toThrow()
    }
  )

  it.each(['2026-10-13T00:00:00Z', '2026-10-13T07:00:00.123456+07:00'])(
    'preserves a valid zoned visit timestamp: %s',
    until => {
      expect(storeOwnership({ state: 'visiting', source: 'visit', assistantIds: [], until }, 'pet').until).toBe(until)
    }
  )

  describe('free official Hub skills (skills.hub.1)', () => {
    const listings = hubListings.items
    const [listing] = listings

    it('keeps every published listing with its install, free and unpriced', () => {
      const items = storeCatalog({ items: listings })

      expect(items).toEqual(listings)
      expect(items.length).toBeGreaterThan(20)

      for (const item of items) {
        expect(item.offer).toBeNull()
        expect(item.install?.source).toBe('hermes_hub')
        expect(item.itemId).toBe(`skill/${item.install?.id}`)
      }
    })

    it('reads install: null as no install, exactly like a row without one', () => {
      const pet = read('fixtures/catalog-pet.json').items[0]

      expect(storeItem({ ...pet, install: null })).toEqual(storeItem(pet))
      expect('install' in storeItem({ ...pet, install: null })).toBe(false)
    })

    it.each([
      ['another source', { install: { source: 'clawhub', id: 'official/creative/pixel-art' } }],
      ['a community identifier', { install: { source: 'hermes_hub', id: 'community/creative/pixel-art' } }],
      ['an identifier that is not the item', { install: { source: 'hermes_hub', id: 'official/creative/stocks' } }],
      ['an unknown install field', { install: { ...(listing.install as object), version: 2 } }],
      ['an install that is not an object', { install: 'official/creative/pixel-art' }],
      [
        'a priced Hub skill',
        {
          offer: {
            id: '00000000-0000-4000-8000-471568220011',
            version: 1,
            priceMicroProtons: 1,
            scope: 'agent',
            billingInterval: 'one_time',
            delivery: 'bundled'
          }
        }
      ]
    ])('leaves out a row offering %s and still loads the rest of the catalog', (_case, change) => {
      const others = listings.slice(1)

      expect(storeCatalog({ items: [{ ...listing, ...change }, ...others] })).toEqual(others)
      // Nothing else accepts that row either: only the catalog chooses to skip it.
      expect(() => storeItem({ ...listing, ...change })).toThrow('matrix_store_invalid')
    })

    it('leaves out a pet that names a Hub install, keeping every other row', () => {
      const pet = read('fixtures/catalog-pet.json').items[0]

      expect(storeCatalog({ items: [{ ...pet, install: listing.install }, ...listings] })).toEqual(listings)
    })

    it('still rejects a catalog with a malformed row that has nothing to do with Hub installs', () => {
      expect(() => storeCatalog({ items: [...listings, { ...listing, install: null, accent: 'red' }] })).toThrow(
        'matrix_store_invalid'
      )
    })
  })
})
