/**
 * The Settings › Device bridge (WS-4): one IPC channel, main-validated requests. Shared by the main
 * handler (`bootstrap.ts`) and the preload (`bridge-preload.ts`); the renderer section
 * (`src/app/settings/device-settings.tsx`) declares the same shapes on its side.
 *
 * Enrollment is not here: it is WS-3b's, and the plan puts it next to #401's SAS trust under one
 * Settings area (A-2). This bridge only reads status and manages this Mac's own standing grants.
 */
export const MATRIX_DEVICE_IPC = 'matrix:device'

export type MatrixDeviceAction =
  | { action: 'status' }
  | { action: 'addGrant'; capability: string; agentUserId: string }
  | { action: 'revokeGrant'; id: string }
  | { action: 'stop' }

export type { MatrixDeviceBridge } from '../../../shared/matrix-device'

const MAX_FIELD = 256

function field(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD ? value : null
}

/** Main's parse of a renderer request: only the four actions, only bounded string fields, nothing
 * else carried through. Returns null for anything that is not exactly one of them. */
export function parseMatrixDeviceAction(input: unknown): MatrixDeviceAction | null {
  if (!input || typeof input !== 'object') {
    return null
  }

  const request = input as Record<string, unknown>

  switch (request.action) {
    case 'status':
      return { action: 'status' }

    case 'stop':
      return { action: 'stop' }
    case 'revokeGrant': {
      const id = field(request.id)

      return id ? { action: 'revokeGrant', id } : null
    }

    case 'addGrant': {
      const capability = field(request.capability)
      const agentUserId = field(request.agentUserId)

      return capability && agentUserId ? { action: 'addGrant', capability, agentUserId } : null
    }

    default:
      return null
  }
}
