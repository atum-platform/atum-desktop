import { contextBridge, ipcRenderer } from 'electron'

import { exposeMatrixDesktopServices } from './desktop-services-preload'

exposeMatrixDesktopServices(false)

import { MATRIX_PAGES_IPC, type MatrixHermesPagesBridge } from '../../shared/matrix-pages'

/** Native IPC failures are values at the main boundary so a compromised guest
 * cannot observe implementation errors. Convert only the stable vocabulary to
 * rejected promises for the bundled page's normal async API. */
async function unwrap<T>(promise: Promise<T | { error: unknown }>): Promise<T> {
  const value = await promise

  if (value && typeof value === 'object' && 'error' in value) {
    const error = value.error

    const code = typeof error === 'string' && (error === 'provider_terms_blocked' || /^matrix_pages_[a-z_]+$/u.test(error))
      ? error : 'matrix_pages_failed'

    throw new Error(code)
  }

  return value as T
}

/** The only API available to the bundled Hermes management-page renderer. */
const bridge: MatrixHermesPagesBridge = {
  context: () => ipcRenderer.invoke(MATRIX_PAGES_IPC.context),
  navigateConnections: page => unwrap(ipcRenderer.invoke(MATRIX_PAGES_IPC.navigateConnections, page)),
  api: request => unwrap(ipcRenderer.invoke(MATRIX_PAGES_IPC.api, request)),
  close: () => unwrap(ipcRenderer.invoke(MATRIX_PAGES_IPC.dismiss)),
  openExternal: url => unwrap(ipcRenderer.invoke(MATRIX_PAGES_IPC.external, url)),
  readMedia: path => unwrap(ipcRenderer.invoke(MATRIX_PAGES_IPC.media, path))
}

contextBridge.exposeInMainWorld('atumHermesPages', bridge)
