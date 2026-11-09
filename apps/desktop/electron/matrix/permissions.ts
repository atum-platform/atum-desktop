import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  MATRIX_PERMISSIONS_IPC,
  type MatrixPermission,
  type MatrixPermissionsSnapshot,
  type MatrixPermissionStatus
} from '../../shared/matrix-permissions'

const settingsUrls: Readonly<Record<MatrixPermission, string>> = Object.freeze({
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  files: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
  fullDisk: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  location: 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices'
})

export interface MatrixPermissionsDependencies {
  assertTrusted(event: IpcMainInvokeEvent): void
  platform: NodeJS.Platform
  isTrustedAccessibilityClient(prompt: boolean): boolean
  getMediaAccessStatus(type: 'screen' | 'microphone'): string
  getFullDiskAccessStatus(): MatrixPermissionStatus
  getLocationAccessStatus(): MatrixPermissionStatus
  openExternal(url: string): Promise<unknown>
  relaunch(): void
}

function unknownSnapshot(): MatrixPermissionsSnapshot {
  return {
    platform: 'unsupported',
    permissions: {
      accessibility: 'unknown',
      screen: 'unknown',
      microphone: 'unknown',
      automation: 'unknown',
      files: 'unknown',
      fullDisk: 'unknown',
      location: 'unknown'
    }
  }
}

function mediaStatus(value: string): MatrixPermissionStatus {
  switch (value) {
    case 'not-determined':

    case 'granted':

    case 'denied':

    case 'restricted':
      return value

    default:
      return 'unknown'
  }
}

function knownPermission(value: unknown): value is MatrixPermission {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(settingsUrls, value)
}

function status(deps: MatrixPermissionsDependencies): MatrixPermissionsSnapshot {
  if (deps.platform !== 'darwin') {
    return unknownSnapshot()
  }

  let accessibility: MatrixPermissionStatus = 'unknown'
  let screen: MatrixPermissionStatus = 'unknown'
  let microphone: MatrixPermissionStatus = 'unknown'
  let fullDisk: MatrixPermissionStatus = 'unknown'
  let location: MatrixPermissionStatus = 'unknown'

  try {
    accessibility = deps.isTrustedAccessibilityClient(false) ? 'granted' : 'not-granted'
  } catch {
    accessibility = 'unknown'
  }

  try {
    screen = mediaStatus(deps.getMediaAccessStatus('screen'))
  } catch {
    screen = 'unknown'
  }

  try {
    microphone = mediaStatus(deps.getMediaAccessStatus('microphone'))
  } catch {
    microphone = 'unknown'
  }

  try {
    fullDisk = deps.getFullDiskAccessStatus()
  } catch {
    fullDisk = 'unknown'
  }

  try {
    location = deps.getLocationAccessStatus()
  } catch {
    location = 'unknown'
  }

  return {
    platform: 'macos',
    permissions: {
      accessibility,
      screen,
      microphone,
      automation: 'manual-check',
      files: 'manual-check',
      fullDisk,
      location
    }
  }
}

/** Registers the passive Matrix permission facts and fixed-pane launcher. */
export function registerMatrixPermissions(ipc: Pick<IpcMain, 'handle'>, deps: MatrixPermissionsDependencies): void {
  ipc.handle(MATRIX_PERMISSIONS_IPC.status, (event, ...args: unknown[]) => {
    deps.assertTrusted(event)

    if (args.length !== 0) {
      throw new Error('matrix_permissions_invalid_request')
    }

    return status(deps)
  })
  ipc.handle(MATRIX_PERMISSIONS_IPC.settings, async (event, permission: unknown, ...args: unknown[]) => {
    deps.assertTrusted(event)

    if (args.length !== 0 || !knownPermission(permission)) {
      throw new Error('matrix_permissions_invalid_request')
    }

    if (deps.platform !== 'darwin') {
      throw new Error('matrix_permissions_unsupported')
    }

    try {
      await deps.openExternal(settingsUrls[permission])
    } catch {
      throw new Error('matrix_permissions_open_failed')
    }

    deps.assertTrusted(event)
  })
  ipc.handle(MATRIX_PERMISSIONS_IPC.relaunch, (event, ...args: unknown[]) => {
    deps.assertTrusted(event)

    if (args.length !== 0 || deps.platform !== 'darwin') {
      throw new Error('matrix_permissions_invalid_request')
    }

    deps.relaunch()
  })
}

export const MATRIX_PERMISSION_SETTINGS_URLS = settingsUrls
