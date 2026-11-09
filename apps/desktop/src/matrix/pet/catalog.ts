import type { MatrixPetCatalog, MatrixPetCatalogItem, MatrixPetHatchQuote } from '../../../shared/matrix-pet'

export function petChoices(catalog: MatrixPetCatalog | undefined) {
  const bundledChoices = catalog?.items.filter(item => item.access === 'owned' || item.access === 'visiting') ?? []

  // Personal pets are an account library, not one of the four catalog items.
  // Reconstruct their typed reference here so a paid pet restored on another
  // Mac is immediately selectable for this agent.
  const personalChoices: MatrixPetCatalogItem[] =
    catalog?.personal
      .filter(item => item.deleted_at === null)
      .map(item => ({
        ref: { kind: 'personal', pet_id: item.pet_id },
        slug: `personal-${item.pet_id}`,
        name: item.display_name,
        access: 'owned',
        offer: null
      })) ?? []

  const choices = [...bundledChoices, ...personalChoices]
  const available = catalog?.items.filter(item => item.access === 'available' && item.offer?.scope === 'account') ?? []

  return { choices, available }
}

export function petHatchQuote(catalog: MatrixPetCatalog | undefined): MatrixPetHatchQuote | undefined {
  return catalog?.hatch.creditEntitlementId
    ? { kind: 'credit', entitlementId: catalog.hatch.creditEntitlementId }
    : catalog?.hatch.offer
      ? {
          kind: 'offer',
          id: catalog.hatch.offer.id,
          version: catalog.hatch.offer.version,
          priceMicroProtons: catalog.hatch.offer.priceMicroProtons
        }
      : undefined
}
