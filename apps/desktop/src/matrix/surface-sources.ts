import { useStore } from '@nanostores/react'
import { useLayoutEffect } from 'react'

import {
  $surfaces,
  activateSurfaceProfile,
  applySurfaceSource,
  type SurfaceEntry,
  type SurfaceId,
  surfacesForProfile
} from '@/store/surfaces'

import type { MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'
import type { MatrixDriveView } from '../../shared/matrix-drive'

type SourceSnapshot = Pick<
  MatrixSnapshot,
  'identity' | 'homeserver' | 'petScope' | 'state' | 'apps' | 'companyWorkspaceEnabled'
>
type SourceBridge = Pick<MatrixUiBridge, 'drive' | 'companies'>

export interface LocalSurfaceFacts {
  apps: boolean
  companyWorkspace: boolean
  companyBridge: boolean
  driveBridge: boolean
  drive?: Pick<MatrixDriveView, 'state'>
}

/**
 * Today's four gates become presentation states, never cloud admission decisions. A place this
 * build cannot open is hidden, never drawn disabled as "Coming soon" or "Update required": on a
 * public launch nobody should meet a placeholder, and every capability here is fixed per build
 * (the public config, the native bridges), so there is no moment a place is "about to" arrive.
 */
export function localSurfaceEntries(facts: LocalSurfaceFacts): SurfaceEntry[] {
  const absent = (id: SurfaceId): SurfaceEntry => ({ id, state: 'hidden', reason: 'not_for_platform' })

  return [
    { id: 'home', state: 'on' },
    // Drive is a permanent destination. A build without the engine still opens its calm
    // unavailable page instead of removing a principal place from the rail.
    { id: 'drive', state: 'on' },
    facts.apps ? { id: 'discover', state: 'on' } : absent('discover'),
    facts.companyWorkspace && facts.companyBridge ? { id: 'teamSpace', state: 'on' } : absent('teamSpace')
  ]
}

/** Stable local Matrix profile; the generation fence is deliberately not a cache key. */
export function surfaceProfile(snapshot: SourceSnapshot): string | null {
  return snapshot.identity
    ? JSON.stringify([snapshot.homeserver ?? '', snapshot.identity.userId, snapshot.identity.deviceId])
    : null
}

/** Read-only Drive adapter. Failed reads retain the cache; newer native revisions win. */
export function attachLocalSurfaceSource(
  profile: string,
  source: Pick<LocalSurfaceFacts, 'apps' | 'companyWorkspace'>,
  bridge: SourceBridge
): () => void {
  const facts = {
    ...source,
    companyBridge: Boolean(bridge.companies),
    driveBridge: Boolean(bridge.drive)
  }

  if (!bridge.drive) {
    applySurfaceSource(profile, localSurfaceEntries(facts))

    return () => {}
  }

  let live = true
  let revision = -1

  const receive = (drive: MatrixDriveView) => {
    if (live && drive.revision >= revision) {
      revision = drive.revision
      applySurfaceSource(profile, localSurfaceEntries({ ...facts, drive }))
    }
  }

  let unsubscribe: () => void

  try {
    unsubscribe = bridge.drive.subscribe(receive)
  } catch {
    return () => {
      live = false
    }
  }
  void (async () => {
    try {
      receive(await bridge.drive!.read())
    } catch {
      /* Keep the last good set. */
    }
  })()

  return () => {
    live = false
    unsubscribe()
  }
}

/** One narrow job: bind the active profile's local presentation source to its atom. */
export function useMatrixSurfaces(snapshot: SourceSnapshot, bridge: SourceBridge = window.atumMatrix) {
  const projection = useStore($surfaces)
  const profile = surfaceProfile(snapshot)
  const state = snapshot.state
  const generation = snapshot.petScope
  const apps = Boolean(snapshot.apps)
  const companyWorkspace = Boolean(snapshot.companyWorkspaceEnabled)
  const { drive, companies } = bridge

  useLayoutEffect(() => {
    activateSurfaceProfile(profile)

    return profile && state === 'ready'
      ? attachLocalSurfaceSource(profile, { apps, companyWorkspace }, { drive, companies })
      : undefined
  }, [profile, state, generation, apps, companyWorkspace, drive, companies])

  return surfacesForProfile(profile, projection)
}
