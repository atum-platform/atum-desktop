import { atom } from 'nanostores'

import { type PetInfo, petProfile } from '@/store/pet'
import type { GatewayRequest } from '@/store/pet-gallery'

/**
 * Sprite sheets for pets nobody has adopted yet — what makes a store card move.
 *
 * `pet.sheet` builds the same payload `pet.info` does for a pet this profile
 * has installed, one bundled with the app, or a petdex entry (fetched once by
 * the gateway and cached on disk). Each is a few hundred KB of base64, so the
 * renderer keeps them once per slug and does not ask twice while one is held:
 * a second card for the same pet, or the Meet stage opening on one, reads the
 * cache.
 *
 * Held, not hoarded: whoever is drawing a sheet holds it (`holdPetSheet`) —
 * a card while it is near, the Meet stage while it is open. The cache keeps
 * `SHEET_BUDGET` sheets, dropping the least recently used that nobody holds;
 * a held sheet is never dropped, so a viewport wider than the budget grows
 * the cache to what is on screen and never thrashes, and a card that scrolls
 * back to a dropped sheet asks again and the gateway answers from disk. A
 * long browse through a thousand-pet catalog never grows the renderer beyond
 * what is visible or the budget, whichever is larger.
 *
 * Nothing here installs anything. A sheet is a picture of a pet, not a pet.
 */
export const $petSheets = atom<Record<string, PetInfo>>({})

/** More than a viewport of cards plus the Meet stage, less than a catalog. */
export const SHEET_BUDGET = 24

const inflight = new Map<string, Promise<null | PetInfo>>()
/** Slugs by last use, most recent last. */
let recent: string[] = []
/** Consumers currently drawing each sheet. */
const holds = new Map<string, number>()

/**
 * Keep `slug`'s sheet in the cache while the returned release has not been
 * called. Holds nest; the sheet is droppable once the last holder lets go.
 */
export function holdPetSheet(slug: string): () => void {
  holds.set(slug, (holds.get(slug) ?? 0) + 1)
  touch(slug)
  let released = false

  return () => {
    if (released) {
      return
    }

    released = true
    const left = (holds.get(slug) ?? 1) - 1

    if (left > 0) {
      holds.set(slug, left)
    } else {
      holds.delete(slug)
    }
  }
}

/** Tests: is anyone holding this sheet? */
export function isPetSheetHeld(slug: string): boolean {
  return (holds.get(slug) ?? 0) > 0
}

function remember(slug: string, info: PetInfo): void {
  touch(slug)
  const next = { ...$petSheets.get(), [slug]: info }
  const droppable = recent.filter(s => s !== slug && !holds.has(s))

  // Over budget: drop the least recently used sheets nobody is drawing.
  for (let over = recent.length - SHEET_BUDGET; over > 0 && droppable.length > 0; over -= 1) {
    const evicted = droppable.shift()!
    recent = recent.filter(s => s !== evicted)
    delete next[evicted]
  }

  $petSheets.set(next)
}

function touch(slug: string): void {
  recent = [...recent.filter(s => s !== slug), slug]
}

export function loadPetSheet(
  request: GatewayRequest,
  slug: string,
  { displayName = '', url = '' }: { displayName?: string; url?: string } = {}
): Promise<null | PetInfo> {
  const have = $petSheets.get()[slug]

  if (have) {
    touch(slug)

    return Promise.resolve(have)
  }

  let pending = inflight.get(slug)

  if (!pending) {
    pending = request<{ ok: boolean } & PetInfo>('pet.sheet', { displayName, profile: petProfile(), slug, url })
      .then(result => {
        if (!result?.ok || !result.spritesheetBase64) {
          return null
        }

        const info: PetInfo = { ...result, enabled: true }
        remember(slug, info)

        return info
      })
      .catch(() => null)
      .finally(() => inflight.delete(slug))
    inflight.set(slug, pending)
  }

  return pending
}

/** Tests and profile switches: a sheet fetched for one profile is still a sheet. */
export function resetPetSheets(): void {
  $petSheets.set({})
  inflight.clear()
  recent = []
  holds.clear()
}
