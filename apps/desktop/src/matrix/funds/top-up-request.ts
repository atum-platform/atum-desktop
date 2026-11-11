import { atom } from 'nanostores'

/** What a funds surface asks of the top-up: optionally how many whole Protons it is short of. */
export interface FundsTopUpRequest {
  needProtons?: number
  /** Changes on every ask, so asking again while open re-reads the packs. */
  nonce: number
}

/**
 * The one in-place top-up, asked for from any funds line (a chat notice, a band, a hire, a renewal,
 * a company fund). The window's host (`FundsTopUpHost`) answers it: the Store's checkout in a sheet
 * over the current view, or Atum's payments page in a build without that checkout.
 */
export const $fundsTopUp = atom<FundsTopUpRequest | null>(null)

let asks = 0
let hosts = 0

/** The window's host says it is there; a surface drawn before it (the launch screen) falls back. */
export function registerFundsTopUpHost(): () => void {
  hosts += 1

  return () => {
    hosts -= 1
  }
}

/** Asks for the top-up; false when no host is mounted yet, so the caller keeps its own path. */
export function openFundsTopUp(needProtons?: number): boolean {
  if (!hosts) {
    return false
  }

  asks += 1
  $fundsTopUp.set({ ...(needProtons !== undefined ? { needProtons } : {}), nonce: asks })

  return true
}

export function closeFundsTopUp(): void {
  $fundsTopUp.set(null)
}
