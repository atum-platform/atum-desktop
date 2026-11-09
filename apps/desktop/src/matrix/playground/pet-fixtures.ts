import type { MatrixPetBridge, MatrixPetCatalog, MatrixPetView } from '../../../shared/matrix-pet'
import { BUNDLED_GIGI } from '../pet/bundled-gigi'

/**
 * The companion on fixture data: an account older than the creation-time seed, with
 * nothing chosen for its assistant and Gigi as the welcome gift, so the window shows
 * her as the stand-in (`standIn`). The sheet is the real bundled atlas; its metadata
 * is what `hermes_cli.atum_pet_sprite` reports for it.
 */
const SERVER_TIME = '2026-10-05T00:00:00.000Z'

export function playgroundPets(): MatrixPetBridge {
  const view = (agent: string): MatrixPetView => ({
    freshness: 'current',
    selection: {
      owner: 'principal',
      agent,
      revision: 1,
      pet: null,
      provenance: null,
      access: null,
      visitEndsAt: null,
      serverTime: SERVER_TIME
    },
    sprite: BUNDLED_GIGI,
    standIn: true
  })

  const catalog = (agent: string): MatrixPetCatalog => ({
    owner: 'principal',
    agent,
    serverTime: SERVER_TIME,
    items: (['gigi', 'cookie', 'mochi', 'bailey'] as const).map(slug => ({
      ref: { kind: 'bundled' as const, slug },
      slug,
      name: slug[0]!.toUpperCase() + slug.slice(1),
      access: slug === 'gigi' ? ('owned' as const) : ('available' as const),
      offer: null
    })),
    personal: [],
    visit: { state: 'owned', startedAt: null, endsAt: null },
    hatch: { offer: null, creditEntitlementId: null, roundsLeft: 3 }
  })

  return {
    // As main does, the read brings the catalog along for the picker.
    read: async ({ agent }) => ({ ...view(agent), catalog: catalog(agent) }),
    write: async ({ agent }, revision, pet) => ({
      ...view(agent),
      selection: { ...view(agent).selection, revision: revision + 1, pet, provenance: 'explicit', access: 'owned' },
      // Drawn at the size the person saved, as main's reader does.
      ...(pet.enabled && pet.ref ? { sprite: { ...BUNDLED_GIGI, scale: pet.scale } } : { sprite: undefined }),
      standIn: undefined
    }),
    catalog: async ({ agent }) => catalog(agent),
    beginVisit: async () => {},
    choosePhoto: async () => null,
    generate: async () => ({ token: 'playground', drafts: [] }),
    hatch: async ({ target }) => view(target.agent),
    adoptPending: async ({ agent }) => view(agent),
    recovery: async () => ({ state: 'none', canDiscard: false }),
    retryPending: async ({ agent }) => view(agent),
    discardPending: async () => {},
    cancel: async () => {},
    onHatchProgress: () => () => {}
  }
}
