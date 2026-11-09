import { randomUUID } from 'node:crypto'

import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { NATIVE_APPS_CHANNELS, type NativeOpenDocumentWindow, OFFICE_APPS, type OfficeAppKind, officeFileMatches, officeKindForBundle } from '../shared/skills-launcher'

import type { NativeAppInventory } from './native-app-inventory'
import type { NativeOpenDocumentWindowCandidate } from './native-app-window'
import type { NativeAppsController } from './native-apps'

const DOCUMENT_CANDIDATE_TTL_MS = 30 * 60 * 1000

interface OpenDocumentWindows {
  list(): Promise<NativeOpenDocumentWindowCandidate[]>
  resolve(candidate: NativeOpenDocumentWindowCandidate): Promise<string | null>
}

export interface NativeAppsIpcDependencies {
  assertTrusted(event: IpcMainInvokeEvent): void
  authority(): string
  chooseFile(kind: OfficeAppKind): Promise<string | null>
  authorizePath(path: string): string
  openArrangementSettings(permission?: 'accessibility' | 'automation'): Promise<void>
  /** Available on macOS only; intentionally excludes Word's separate adapter. */
  openDocumentWindows?: OpenDocumentWindows
}

export function registerNativeAppsIpc(ipc: IpcMain, controller: NativeAppsController, inventory: NativeAppInventory, deps: NativeAppsIpcDependencies) {
  let documentGeneration = 0

  const documentCandidates = new Map<string, {
    ownerId: number
    authority: string
    generation: number
    issuedAt: number
    candidate: NativeOpenDocumentWindowCandidate
  }>()

  const register = (channel: string, operation: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<unknown>) => ipc.handle(channel, async (event, ...args) => {
    deps.assertTrusted(event)
    const authority = deps.authority()
    const result = await operation(event, ...args)
    deps.assertTrusted(event)

    if (authority !== deps.authority()) {throw new Error('NATIVE_APP_CANCELLED')}

    return result
  })

  register(NATIVE_APPS_CHANNELS.list, (_event, refresh) => inventory.list(refresh === true))
  register(NATIVE_APPS_CHANNELS.launch, (_event, request) => controller.launch(request))
  register(NATIVE_APPS_CHANNELS.end, (_event, id) => controller.end(id))
  register(NATIVE_APPS_CHANNELS.openArrangementSettings, (_event, permission) => deps.openArrangementSettings(permission === 'automation' ? 'automation' : 'accessibility'))
  register(NATIVE_APPS_CHANNELS.chooseFile, async (_event, kind) => {
    if (!Object.hasOwn(OFFICE_APPS, kind)) {throw new Error('NATIVE_APP_INVALID_REQUEST')}
    const selected = await deps.chooseFile(kind)

    if (!selected) {return null}
    const authorized = deps.authorizePath(selected)

    if (!officeFileMatches(kind, authorized)) {throw new Error('NATIVE_APP_INVALID_DOCUMENT')}

    return authorized
  })
  register(NATIVE_APPS_CHANNELS.listOpenDocumentWindows, async event => {
    if (!deps.openDocumentWindows) {return { windows: [], reason: 'unavailable' } as const}

    let listed: NativeOpenDocumentWindowCandidate[]

    try {listed = await deps.openDocumentWindows.list()} catch (error) {
      return {
        windows: [],
        reason: error instanceof Error && error.message === 'permission' ? 'permission' : 'unavailable'
      } as const
    }

    // A refresh creates a new authority generation. Old renderer tokens cannot
    // bind a reused native window after this point, and mappings never probe in
    // the background or outlive the picker interaction.
    const generation = ++documentGeneration
    const authority = deps.authority()
    documentCandidates.clear()

    const windows: NativeOpenDocumentWindow[] = listed.map(candidate => {
      const id = randomUUID()
      documentCandidates.set(id, { ownerId: event.sender.id, authority, generation, issuedAt: Date.now(), candidate })

      return { id, app: candidate.app, title: candidate.title, hasSavedFile: candidate.hasSavedFile }
    })

    return { windows }
  })
  register(NATIVE_APPS_CHANNELS.resolveOpenDocumentWindow, async (event, id) => {
    if (typeof id !== 'string') {return null}
    const record = documentCandidates.get(id)

    if (!record || record.ownerId !== event.sender.id || record.authority !== deps.authority() ||
      record.generation !== documentGeneration || Date.now() - record.issuedAt > DOCUMENT_CANDIDATE_TTL_MS || !deps.openDocumentWindows) {
      return null
    }

    // Resolve against the native process/window/document identity once more;
    // titles and opaque tokens are never file authority. The consumer grant and
    // extension check happen only after that proof succeeds.
    const selected = await deps.openDocumentWindows.resolve(record.candidate)

    if (!selected) {return null}

    try {
      const authorized = deps.authorizePath(selected)
      const kind = officeKindForBundle(record.candidate.app.bundleId)

      return kind && kind !== 'word' && officeFileMatches(kind, authorized) ? authorized : null
    } catch {
      return null
    }
  })
}
