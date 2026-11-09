import bailey from '@/assets/pets/bailey-preview.webp'
import cookie from '@/assets/pets/cookie-preview.webp'
import gigi from '@/assets/pets/gigi-preview.webp'
import mochi from '@/assets/pets/mochi-preview.webp'

/** Still portraits of the four house dogs, rendered from their voxel models by
 * `python -m scripts.pets.preview`. Store items name a house dog by item id; any
 * other item (a hatch credit, an agent, a skill) keeps the listing's glyph. */
const PREVIEWS: Readonly<Record<string, string>> = {
  'pet/bailey': bailey,
  'pet/cookie': cookie,
  'pet/gigi': gigi,
  'pet/mochi': mochi
}

export function storePetPreview(itemId: string | undefined): string | undefined {
  return itemId && Object.hasOwn(PREVIEWS, itemId) ? PREVIEWS[itemId] : undefined
}
