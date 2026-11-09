/**
 * Who owns a board card, as one change.
 *
 * The platform authority (`atum.company_board_command`, migration 0324) replaces a card's whole
 * membership in one step and refuses a patch that does not carry `owners`, `primaryOwner` and
 * `participants` together. So an ownership edit always sends all three: the owners the person chose,
 * a primary owner who is one of them, and the participants exactly as they were. Picking one owner
 * never drops the others, and the participants never change from the owner picker.
 *
 * The same authority lets an owner or admin name anyone, but a member only themselves: a member's
 * patch may hold no owner other than the member. `companyBoardOwnerChoice` mirrors that, so the
 * picker never offers a change the platform would refuse.
 */
export const COMPANY_BOARD_MAX_OWNERS = 20

export interface CompanyBoardOwnership {
  owners: string[]
  primaryOwner: string | null
  participants: string[]
}

type OwnedCard = Readonly<{ owners: readonly string[]; primaryOwner: string | null; participants: readonly string[] }>

/** The complete ownership patch for `owners`: the primary stays when still an owner, else the first. */
export function companyBoardOwnershipPatch(card: OwnedCard, owners: readonly string[]): CompanyBoardOwnership {
  const next = [...new Set(owners)]

  return {
    owners: next,
    primaryOwner: card.primaryOwner !== null && next.includes(card.primaryOwner) ? card.primaryOwner : (next[0] ?? null),
    participants: [...card.participants]
  }
}

/** Adds `memberRef` as an owner, or removes them; everyone else keeps their place. */
export function toggleCompanyBoardOwner(card: OwnedCard, memberRef: string): CompanyBoardOwnership {
  return companyBoardOwnershipPatch(
    card,
    card.owners.includes(memberRef) ? card.owners.filter(owner => owner !== memberRef) : [...card.owners, memberRef]
  )
}

/**
 * Which owners this viewer may switch on or off. Owners and admins (and a viewer whose role is not
 * known yet, left to the platform) may change anyone; a member may claim or release a card only while
 * nobody else owns it, since any patch naming another owner is refused for them.
 */
export function companyBoardOwnerChoice(
  card: OwnedCard,
  viewer: { memberRef?: string; manages?: boolean }
): (memberRef: string) => boolean {
  const full = card.owners.length >= COMPANY_BOARD_MAX_OWNERS

  if (viewer.manages !== false) {
    return memberRef => card.owners.includes(memberRef) || !full
  }

  const self = viewer.memberRef
  const onlySelf = Boolean(self) && card.owners.every(owner => owner === self)

  return memberRef => onlySelf && memberRef === self
}

/** Returns why an ownership patch is not one the platform accepts, or undefined when it is. */
export function companyBoardOwnershipIssue(patch: {
  owners?: readonly string[]
  primaryOwner?: string | null
  participants?: readonly string[]
}): string | undefined {
  const present = [patch.owners, patch.primaryOwner, patch.participants].filter(value => value !== undefined).length

  if (present === 0) {
    return undefined
  }

  if (present !== 3) {
    return 'owners, primaryOwner and participants change together'
  }

  if (new Set(patch.owners).size !== patch.owners!.length || new Set(patch.participants).size !== patch.participants!.length) {
    return 'member references must be unique'
  }

  if (patch.primaryOwner !== null && !patch.owners!.includes(patch.primaryOwner!)) {
    return 'primary owner must be an owner'
  }

  return undefined
}
