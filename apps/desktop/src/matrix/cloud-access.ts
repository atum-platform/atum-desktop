/**
 * The account's cloud access, read once for every surface that needs it. The access fact is
 * account-wide (`GET /cloud/status` → `access`), so both the chat band and the roster rows
 * subscribe to this one read instead of asking the platform per agent. It refreshes every ten
 * minutes and whenever the window comes back to the front; an unknown answer never replaces the
 * last confirmed fact, so the window stays quiet rather than guessing.
 */
import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useEffect } from 'react'

import type { MatrixAgentView, MatrixCloudAccess } from '../../shared/matrix'
import { isMatrixCloudAccessReason } from '../../shared/matrix-cloud-access'

export const MATRIX_CLOUD_ACCESS_REFRESH_MS = 10 * 60_000

export const $matrixCloudAccess = atom<MatrixCloudAccess | undefined>(undefined)

let consumers = 0
let generation = 0
/** The generation whose read is in flight; a stale read never blocks a fresh one. */
let runningGeneration: number | undefined
let timer: number | undefined

function isCloudAccess(value: unknown): value is MatrixCloudAccess {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const access = value as Partial<MatrixCloudAccess>

  return (
    access.effective === 'trial' ||
    access.effective === 'paid' ||
    (access.effective === 'none' &&
      (access.reason === undefined || isMatrixCloudAccessReason(access.reason)))
  )
}

async function refresh(): Promise<void> {
  if (runningGeneration === generation) {
    return
  }

  const read = window.atumMatrix?.cloudAgent

  if (!read) {
    return
  }

  const asked = generation
  runningGeneration = asked

  try {
    const access = await read({ action: 'cloudAccess' })

    if (asked === generation && isCloudAccess(access)) {
      $matrixCloudAccess.set(access)
    }
  } catch {
    // Unknown access is not "no access": keep the last confirmed fact, or say nothing.
  } finally {
    if (runningGeneration === asked) {
      runningGeneration = undefined
    }
  }
}

/**
 * The current access while `enabled`; the first enabled subscriber owns the poll and the focus
 * listener, and the last one clears them. `enabled` is false for a Mac-run assistant, whose chat
 * and row never speak about cloud access.
 */
export function useMatrixCloudAccess(enabled: boolean): MatrixCloudAccess | undefined {
  const access = useStore($matrixCloudAccess)

  useEffect(() => {
    if (!enabled) {
      return
    }

    consumers++

    if (consumers === 1) {
      void refresh()
      timer = window.setInterval(() => void refresh(), MATRIX_CLOUD_ACCESS_REFRESH_MS)
      window.addEventListener('focus', refresh)
    }

    return () => {
      consumers--

      if (consumers === 0) {
        generation++

        if (timer !== undefined) {
          window.clearInterval(timer)
        }

        timer = undefined
        window.removeEventListener('focus', refresh)
        $matrixCloudAccess.set(undefined)
      }
    }
  }, [enabled])

  return enabled ? access : undefined
}

/** Whether this agent's answers are the cloud's and the account currently has no access. */
export function matrixAgentAccessEnded(agent: MatrixAgentView, access: MatrixCloudAccess | undefined): boolean {
  return access?.effective === 'none' && agent.answering === 'cloud' && agent.macRole !== 'answering'
}
