import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  MATRIX_MAC_KNOWLEDGE_SOURCES,
  MATRIX_MAC_SOURCES_IPC,
  type MatrixMacKnowledgeSource,
  type MatrixMacSourcesConsent
} from '../../../shared/matrix-mac-sources'

const SOURCES = new Set<string>(MATRIX_MAC_KNOWLEDGE_SOURCES)

export interface MatrixMacSourcesIpcDependencies {
  assertTrusted(event: IpcMainInvokeEvent): void
  read(): MatrixMacSourcesConsent
  set(source: MatrixMacKnowledgeSource, enabled: boolean): MatrixMacSourcesConsent
}

/** Trusted UI only; SDK hosts and apps never receive account source controls. */
export function registerMatrixMacSourcesIpc(
  ipc: Pick<IpcMain, 'handle'>,
  dependencies: MatrixMacSourcesIpcDependencies
): void {
  ipc.handle(MATRIX_MAC_SOURCES_IPC.read, (event, ...args: unknown[]) => {
    dependencies.assertTrusted(event)

    if (args.length !== 0) {
      throw new Error('matrix_mac_sources_invalid_request')
    }

    return dependencies.read()
  })

  ipc.handle(
    MATRIX_MAC_SOURCES_IPC.set,
    (event, source: unknown, enabled: unknown, ...args: unknown[]) => {
      dependencies.assertTrusted(event)

      if (args.length !== 0 || typeof source !== 'string' || !SOURCES.has(source) || typeof enabled !== 'boolean') {
        throw new Error('matrix_mac_sources_invalid_request')
      }

      return dependencies.set(source as MatrixMacKnowledgeSource, enabled)
    }
  )
}
