import { atom } from 'nanostores'

import type { GroupQuotedMessage } from '../../shared/atum-group-conversations'

export interface AtumGroupQuote extends GroupQuotedMessage {
  accountId: string
  conversationId: string
  membershipEpoch: number
  preview: string
}

/**
 * A quote is a deliberate, local send choice.  It never persists with the
 * draft: its membership and account fence make a later room incarnation
 * incapable of inheriting consent from an earlier one.
 */
export const $atumGroupQuote = atom<AtumGroupQuote | null>(null)

export function setAtumGroupQuote(quote: AtumGroupQuote): void {
  $atumGroupQuote.set(quote)
}

export function clearAtumGroupQuote(): void {
  $atumGroupQuote.set(null)
}

export function groupQuoteFor(
  scope: Pick<AtumGroupQuote, 'accountId' | 'conversationId' | 'membershipEpoch'>
): AtumGroupQuote | null {
  const quote = $atumGroupQuote.get()

  return quote &&
    quote.accountId === scope.accountId &&
    quote.conversationId === scope.conversationId &&
    quote.membershipEpoch === scope.membershipEpoch
    ? quote
    : null
}
