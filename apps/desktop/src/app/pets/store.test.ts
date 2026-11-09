import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PetInfo } from '@/store/pet'

import { $petSheets, loadPetSheet, resetPetSheets, SHEET_BUDGET } from './store'

/** A sheet cache that is held, not hoarded. */

const sheet = (slug: string): PetInfo => ({ displayName: slug, enabled: true, frameH: 208, frameW: 192, slug, spritesheetBase64: 'AA==' })
const request = vi.fn(async (_method: string, params: { slug: string }) => ({ ok: true, ...sheet(params.slug) }))

beforeEach(() => {
  resetPetSheets()
  request.mockClear()
})

describe('the sheet cache', () => {
  it('asks once per slug while a sheet is held', async () => {
    await loadPetSheet(request as never, 'boba')
    await loadPetSheet(request as never, 'boba')

    expect(request).toHaveBeenCalledOnce()
    expect($petSheets.get().boba?.slug).toBe('boba')
  })

  it('drops the least recently used sheet past the budget, and asks again for it', async () => {
    for (let i = 0; i < SHEET_BUDGET; i += 1) {
      await loadPetSheet(request as never, `pet-${i}`)
    }
    // Using pet-0 again makes it recent; pet-1 is now the oldest.
    await loadPetSheet(request as never, 'pet-0')
    await loadPetSheet(request as never, 'one-more')

    const held = Object.keys($petSheets.get())

    expect(held).toHaveLength(SHEET_BUDGET)
    expect(held).toContain('pet-0')
    expect(held).toContain('one-more')
    expect(held).not.toContain('pet-1')

    request.mockClear()
    await loadPetSheet(request as never, 'pet-1')
    expect(request).toHaveBeenCalledOnce()
  })

  it('holds nothing for a sheet the gateway could not produce', async () => {
    const failing = vi.fn(async () => ({ ok: false }))

    expect(await loadPetSheet(failing as never, 'ghost')).toBeNull()
    expect($petSheets.get().ghost).toBeUndefined()
  })
})

describe('holding a sheet', () => {
  it('keeps a held sheet past the budget, and lets it go once released', async () => {
    const { holdPetSheet, isPetSheetHeld } = await import('./store')
    await loadPetSheet(request as never, 'held')
    const release = holdPetSheet('held')

    for (let i = 0; i < SHEET_BUDGET + 5; i += 1) {
      await loadPetSheet(request as never, `pet-${i}`)
    }

    expect($petSheets.get().held).toBeTruthy()
    expect(isPetSheetHeld('held')).toBe(true)
    // Held sheets count toward the budget; they are just never the ones dropped.
    expect(Object.keys($petSheets.get())).toHaveLength(SHEET_BUDGET)

    release()
    await loadPetSheet(request as never, 'one-more')
    expect($petSheets.get().held).toBeUndefined()
  })

  it('grows to what is held rather than cycling it: more holders than budget, one request each', async () => {
    const { holdPetSheet } = await import('./store')
    const slugs = Array.from({ length: SHEET_BUDGET + 10 }, (_, i) => `near-${i}`)
    const releases = slugs.map(slug => holdPetSheet(slug))
    await Promise.all(slugs.map(slug => loadPetSheet(request as never, slug)))

    expect(Object.keys($petSheets.get())).toHaveLength(slugs.length)
    expect(request).toHaveBeenCalledTimes(slugs.length)
    // Nothing was dropped, so nothing is asked for twice.
    await Promise.all(slugs.map(slug => loadPetSheet(request as never, slug)))
    expect(request).toHaveBeenCalledTimes(slugs.length)

    releases.forEach(release => release())
  })

  it('nests: a sheet held twice stays until both let go', async () => {
    const { holdPetSheet, isPetSheetHeld } = await import('./store')
    const a = holdPetSheet('twice')
    const b = holdPetSheet('twice')

    a()
    expect(isPetSheetHeld('twice')).toBe(true)
    b()
    expect(isPetSheetHeld('twice')).toBe(false)
    b()
    expect(isPetSheetHeld('twice')).toBe(false)
  })
})
