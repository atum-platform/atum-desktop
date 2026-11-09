import { $surfaces, type SurfaceId, type SurfaceSet } from '@/store/surfaces'

export type { SurfaceId as RailSurfaceId, SurfaceState as RailSurfaceState } from '@/store/surfaces'

/** A selector over the presentation projection; all source gates live in the adapter. */
export function railSurfaceState(id: SurfaceId, places: SurfaceSet = $surfaces.get().places) {
  return places[id].state
}
