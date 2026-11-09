/** Machine-local app identities are resolved and authorized by Electron. */
export interface NativeAppEntry {
  id: string
  name: string
  bundleId: string
  icon?: string
}

export interface NativeAppWindowChoice {
  id: number
  title: string
}

/** Read-only Office picker metadata; opaque ids are resolved again at selection. */
export interface NativeOpenDocumentWindow {
  id: string
  app: NativeAppEntry
  title: string
  hasSavedFile: boolean
}

export interface NativeOpenDocumentWindows {
  windows: NativeOpenDocumentWindow[]
  reason?: 'permission' | 'unavailable'
}

export interface NativeAppLaunchRequest {
  appId: string
  requestId: string
  mode: 'beside' | 'normal'
  windowId?: number
  documentPath?: string
}

export interface NativeAppLaunchResult {
  id: string
  app: NativeAppEntry
  status: 'beside' | 'opened' | 'choose-window'
  reason?: 'permission' | 'no-window' | 'unsupported' | 'fullscreen' | 'layout-failed'
  windows?: NativeAppWindowChoice[]
}

export const OFFICE_APPS = {
  word: { bundleId: 'com.microsoft.Word', extensions: ['doc', 'docx'] },
  excel: { bundleId: 'com.microsoft.Excel', extensions: ['xls', 'xlsx', 'xlsm'] },
  powerpoint: { bundleId: 'com.microsoft.Powerpoint', extensions: ['ppt', 'pptx', 'pptm'] }
} as const
export type OfficeAppKind = keyof typeof OFFICE_APPS

export function officeKindForBundle(bundleId: string): OfficeAppKind | undefined {
  return (Object.keys(OFFICE_APPS) as OfficeAppKind[]).find(kind => OFFICE_APPS[kind].bundleId === bundleId)
}

export function officeFileMatches(kind: OfficeAppKind, filePath: string): boolean {
  const extension = filePath.split('.').pop()?.toLowerCase() ?? ''

  return (OFFICE_APPS[kind].extensions as readonly string[]).includes(extension)
}

export function officeKindForPath(filePath: string): OfficeAppKind | undefined {
  return (Object.keys(OFFICE_APPS) as OfficeAppKind[]).find(kind => officeFileMatches(kind, filePath))
}

export interface NativeAppsBridge {
  list(refresh?: boolean): Promise<NativeAppEntry[]>
  launch(request: NativeAppLaunchRequest): Promise<NativeAppLaunchResult>
  end(id: string): Promise<void>
  onEnded(callback: (id: string) => void): () => void
  chooseFile(kind: OfficeAppKind): Promise<string | null>
  openArrangementSettings(permission?: 'accessibility' | 'automation'): Promise<void>
  listOpenDocumentWindows?(): Promise<NativeOpenDocumentWindows>
  resolveOpenDocumentWindow?(id: string): Promise<string | null>
}

export const NATIVE_APPS_CHANNELS = {
  list: 'atum:native-apps:list',
  launch: 'atum:native-apps:launch',
  end: 'atum:native-apps:end',
  ended: 'atum:native-apps:ended',
  chooseFile: 'atum:native-apps:choose-file',
  openArrangementSettings: 'atum:native-apps:arrangement-settings',
  listOpenDocumentWindows: 'atum:native-apps:open-document-windows',
  resolveOpenDocumentWindow: 'atum:native-apps:resolve-document-window'
} as const
