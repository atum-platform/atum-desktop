import { describe, expect, it } from 'vitest'

import acmeSubmission from './__fixtures__/look-pack-v1/fixtures/acme.submission.json'
import moonFixture from './__fixtures__/look-pack-v1/fixtures/moon.published.json'
import { decodeLookGallery, decodeLookPack, decodeLookRoomAccountData, lookPackAssets, preferredLookVariant } from './look-pack'

describe('the frozen look-pack consumer boundary', () => {
  it('decodes the pinned Moon pack and selects its sanitised vector for desktop', () => {
    const pack = decodeLookPack(moonFixture)

    expect(pack).toMatchObject({
      profile: 'atum.look-pack/1',
      pack_id: '00000000-0000-4000-8000-177920da9661',
      chat: {
        background: {
          light: { tone: 'dark', base: '#0E1D60', layers: [{ fit: 'cover', opacity: 0.38 }] },
          dark: null
        },
        tokens: { fonts: { ui: 'be-vietnam-pro', body: 'literata' } }
      }
    })
    expect(preferredLookVariant(pack!.chat!.background!.light.layers[0]!.asset)).toMatchObject({
      mime: 'image/svg+xml',
      sha256: '7b6e946ecb9cbbe0dd1fe6ea799150b2394694f608f5350223265509d34c62dc'
    })
  })

  it('strips additive fields and degrades only an invalid layer or token set', () => {
    const raw = structuredClone(moonFixture) as unknown as Record<string, any>
    raw.future_root = true
    raw.chat.background.light.future_ground = true
    raw.chat.background.light.layers[0].future_layer = true
    raw.chat.tokens.fonts.body = 'future-font'

    const pack = decodeLookPack(raw)

    expect(pack?.chat?.background?.light).toMatchObject({ base: '#0E1D60', layers: [expect.any(Object)] })
    expect(pack?.chat?.tokens).toBeNull()

    raw.chat.background.light.layers[0].opacity = 4
    expect(decodeLookPack(raw)?.chat?.background?.light).toEqual({ tone: 'dark', base: '#0E1D60', layers: [] })
  })

  it('accepts an unknown app pack without naming its slug in product code', () => {
    const submission = structuredClone(acmeSubmission)
    const published = {
      ...submission,
      pack_id: '00000000-0000-4000-8000-6d00a0a7b337',
      version: 1,
      digest: 'a'.repeat(64),
      publisher: { kind: 'app', app_id: '00000000-0000-4000-8000-4b2f94c54b02' },
      derived: {
        light: {
          worst: '#F1F5F4', ink: '#151515FF', ink_soft: '#151515F2', ink_muted: '#151515E6',
          ink_faint: '#151515B3', line: '#151515A6', scrim: '#F1F5F4'
        },
        dark: {
          worst: '#172421', ink: '#FFFFFFFF', ink_soft: '#FFFFFFF2', ink_muted: '#FFFFFFE6',
          ink_faint: '#FFFFFFB3', line: '#FFFFFFA6', scrim: '#172421'
        }
      }
    }

    expect(decodeLookPack(published)).toMatchObject({
      name: { en: 'Acme' },
      chat: { background: { light: { base: '#F1F5F4' }, dark: { base: '#172421' } }, tokens: null }
    })
  })

  it('drops invalid gallery entries without losing valid packs', () => {
    expect(
      decodeLookGallery({ profile: 'atum.look-gallery/1', items: [{ profile: 'future' }, moonFixture, moonFixture] })
    ).toHaveLength(1)
    expect(decodeLookGallery({ profile: 'future', items: [] })).toBeNull()
  })
})

describe('room look account data', () => {
  it('reads every v1 selection and defaults unknown data without rewriting it', () => {
    expect(decodeLookRoomAccountData({ v: 1, background: { kind: 'default' } })).toEqual({
      v: 1,
      background: { kind: 'default' }
    })
    expect(decodeLookRoomAccountData({ v: 1, background: { kind: 'none' } })).toEqual({
      v: 1,
      background: { kind: 'none' }
    })
    expect(
      decodeLookRoomAccountData({
        v: 1,
        background: { kind: 'pack', pack_id: '00000000-0000-4000-8000-177920DA9661' }
      })
    ).toEqual({ v: 1, background: { kind: 'pack', pack_id: '00000000-0000-4000-8000-177920da9661' } })

    for (const value of [undefined, { v: 2, background: { kind: 'pack', pack_id: '00000000-0000-4000-8000-177920da9661' } }, { v: 1, background: { kind: 'future' } }]) {
      expect(decodeLookRoomAccountData(value)).toEqual({ v: 1, background: { kind: 'default' } })
    }
  })
})

it('decodes panel art and derived contrast independently and authorizes its declared assets', () => {
  const chat = decodeLookPack(moonFixture)!
  const original = chat.chat!.background!.light
  const panelGround = { ...original, base: '#102030', layers: original.layers.map(layer => ({
    ...layer, asset: { ...layer.asset, sha256: 'a'.repeat(64), variants: layer.asset.variants.map(variant => ({ ...variant, sha256: 'b'.repeat(64) })) }
  })) }
  const pack = decodeLookPack({ ...moonFixture, panel: { background: { light: panelGround, dark: null }, derived: chat.derived } })!
  expect(pack.chat).toEqual(chat.chat)
  expect(pack.panel?.background?.light.base).toBe('#102030')
  expect(pack.panel?.derived).toEqual(chat.derived)
  expect(lookPackAssets(pack).map(asset => asset.sha256)).toContain('a'.repeat(64))
  expect(lookPackAssets(chat).map(asset => asset.sha256)).not.toContain('a'.repeat(64))
})

it('decodes v1.2 chrome, ramps and opaque page bases and inventories chrome-only assets', () => {
  const original = decodeLookPack(moonFixture)!
  const ground = original.chat!.background!.light
  const raw = { ...moonFixture, panel: { chrome: { light: ground, dark: null }, chrome_derived: original.derived, page_base: { light: '#F7F6F2', dark: null } } }
  const pack = decodeLookPack(raw)!
  expect(pack.panel?.chrome?.light).toEqual(ground)
  expect(pack.panel?.chrome_derived).toEqual(original.derived)
  expect(pack.panel?.page_base).toEqual(raw.panel.page_base)
  expect(lookPackAssets({ ...pack, chat: null, start_card: null })).toEqual(lookPackAssets(original))
  expect(decodeLookPack({ ...raw, panel: { ...raw.panel, page_base: { light: '#fff', dark: null } } })!.panel?.page_base).toBeNull()
})
