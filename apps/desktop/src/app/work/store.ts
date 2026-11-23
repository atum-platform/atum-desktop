import type { WorkRelayPlan } from '../../../shared/matrix-work-relay'
import { atom } from 'nanostores'

import type { MatrixWorkBridge, MatrixWorkProjection } from '../../../shared/matrix-work'
import type { WorkRelayRoomView } from '../../../shared/matrix-work-relay'

/** Main's projection of Work on this Mac. `undefined`: not read yet; `null`: no Work for this account here. */
export const $work = atom<MatrixWorkProjection | null | undefined>(undefined)

/** The Work page is the rail's current place. */
export const $workRelayRooms = atom<Record<string, WorkRelayRoomView>>({})

export const $workActive = atom(false)

/** The assistants band under the title is open. */
export const $workBandOpen = atom(false)

/** "Not now" on the enrollment card, remembered on this Mac for this profile. */
export const $workEnrollmentDeferred = atom(false)

const DEFERRED_KEY = 'atum.work.enrollment.deferred.v1'

/**
 * Relay R1: how a held relay turn's Stop reaches the gate. The coordinator's data wiring sets it; while it is null, a held line
 * shows no Stop (never a button that does nothing). The stop is recorded and holds until the Mac confirms (plan §3.6).
 */
export const $workRelayStop = atom<((roomId: string, eventId: string) => void) | null>(null)

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function loadWorkEnrollmentDeferred(): void {
  try {
    $workEnrollmentDeferred.set(storage()?.getItem(DEFERRED_KEY) === '1')
  } catch {
    $workEnrollmentDeferred.set(false)
  }
}

export function deferWorkEnrollment(): void {
  $workEnrollmentDeferred.set(true)
  $workBandOpen.set(false)

  try {
    storage()?.setItem(DEFERRED_KEY, '1')
  } catch {
    // A convenience only: the card comes back next time.
  }
}

/**
 * Follow main's projection. Returns the unsubscribe. A bridge that is missing or whose read fails means
 * Work is not on this build: the rail draws no entry (gated like the other rail places).
 */
export function connectWorkBridge(bridge: MatrixWorkBridge | undefined): () => void {
  if (!bridge) {
    $work.set(null)

    return () => {}
  }

  let live = true
  $workRelayRooms.set({})
  $workRelayStop.set(bridge.stopRelay ? (roomId, eventId) => { void bridge.stopRelay!(roomId, eventId).catch(() => undefined) } : null)

  const unsubscribe = bridge.subscribe(projection => {
    if (live) {
      $work.set(projection)
    }
  })

  bridge.read().then(
    projection => {
      if (live) {
        $work.set(projection)
      }
    },
    () => {
      if (live) {
        $work.set(null)
      }
    }
  )

  return () => {
    live = false
    $workRelayRooms.set({})
    $workRelayStop.set(null)
    unsubscribe()
  }
}

/** Leaving Work for another rail place, or Work going away: the page closes and the view leaves the window. */
export function setWorkActive(active: boolean): void {
  $workActive.set(active)

  if (!active) {
    $workBandOpen.set(false)
  }
}

/** The rail draws Work only while main says this account has it. */
export function workOnRail(projection: MatrixWorkProjection | null | undefined): boolean {
  return Boolean(projection)
}

export function resetWorkStoreForTests(): void {
  $workRelayStop.set(null)
  $work.set(undefined)
  $workActive.set(false)
  $workBandOpen.set(false)
  $workEnrollmentDeferred.set(false)
}
