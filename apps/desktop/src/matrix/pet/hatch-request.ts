import { atom } from 'nanostores'

/**
 * A hatch another surface asked for: the Store's Hatch card. The companion in that chat
 * opens its picker on the hatch panel, with the description and photo ready, and takes
 * the request once. Nothing here buys or charges anything: the hatch panel quotes and
 * charges exactly as it does when it is opened from the paw.
 */
export const $matrixPetHatchRequest = atom<{ roomId: string; choosePhoto?: true } | null>(null)
