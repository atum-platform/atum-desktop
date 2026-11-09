/** Native-owned, bundled Hermes management pages. Chat receives only view controls;
 * the separate pages preload receives the scoped REST capability. */
export const MATRIX_PAGES_IPC = {
  open: 'atum:matrix-pages:open',
  bounds: 'atum:matrix-pages:bounds',
  visibility: 'atum:matrix-pages:visibility',
  focus: 'atum:matrix-pages:focus',
  close: 'atum:matrix-pages:close',
  dismiss: 'atum:matrix-pages:dismiss',
  state: 'atum:matrix-pages:state',
  context: 'atum:matrix-pages:context',
  navigateConnections: 'atum:matrix-pages:navigate-connections',
  api: 'atum:matrix-pages:api',
  external: 'atum:matrix-pages:external',
  media: 'atum:matrix-pages:media'
} as const

export const MATRIX_PAGE_IDS = [
  'scheduled',
  'artifacts',
  'skills',
  'connections',
  'runtime',
  'providers',
  'mcp',
  'command-center',
  'starmap'
] as const
export type MatrixPageId = (typeof MATRIX_PAGE_IDS)[number]
export type MatrixPagesResult<T> = T | { error: string }

export interface MatrixPagesOpenInput {
  page: MatrixPageId
  agentPrincipal?: string
  locale: string
  appearance: 'light' | 'dark'
  /** Skills page only: the official Hub skill the Store sent the person to
   * (`official/<category>/<name>`). The page opens its Hub detail; installing it still
   * takes their click and the native confirmation. */
  hub?: string
}

/** An open request names no Hub skill, or names an official one on the Skills page. */
export function matrixPagesHubAllowed(input: { page?: unknown; hub?: unknown }): boolean {
  return (
    input.hub === undefined ||
    (input.page === 'skills' &&
      typeof input.hub === 'string' &&
      input.hub.length <= 200 &&
      /^official\/[a-z0-9_-]+\/[a-z0-9_-]+$/.test(input.hub))
  )
}

/** The name Hermes installs an official Hub skill under: the identifier's last segment. */
export function matrixHubSkillName(identifier: string): string {
  return identifier.slice(identifier.lastIndexOf('/') + 1)
}

export interface MatrixPagesContext extends MatrixPagesOpenInput {
  agentPrincipal: string
  agentName: string
  /** These pages describe this Mac's profile, never a remote machine's copy. */
  local: true
  jobsRunHere: boolean
}

export interface MatrixPagesState {
  viewId: string
  status: 'loading' | 'ready' | 'error' | 'destroyed'
  error?: string
}

export interface MatrixPagesBridge {
  open(input: MatrixPagesOpenInput): Promise<MatrixPagesResult<{ viewId: string }>>
  setBounds(input: {
    viewId: string
    bounds: { x: number; y: number; width: number; height: number }
  }): Promise<MatrixPagesResult<{ ok: true }>>
  setVisibility(input: {
    viewId: string
    visible: boolean
    overlayActive: boolean
  }): Promise<MatrixPagesResult<{ ok: true }>>
  focus(viewId: string): Promise<MatrixPagesResult<{ ok: true }>>
  close(viewId: string): Promise<MatrixPagesResult<{ ok: true }>>
  onState(listener: (state: MatrixPagesState) => void): () => void
}

/** Accepted only from the currently owned bundled pages webContents. Main validates
 * a fixed route/method/body allowlist and pins the backend's default profile. */
export interface MatrixPagesRequest {
  path: string
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
}

export interface MatrixHermesPagesBridge {
  context(): Promise<MatrixPagesResult<MatrixPagesContext>>
  /** Re-resolve this native scope between the two bundled connection pages. */
  navigateConnections(page: 'connections' | 'providers'): Promise<MatrixPagesContext>
  api<T = unknown>(request: MatrixPagesRequest): Promise<T>
  close(): Promise<void>
  openExternal(url: string): Promise<void>
  /** Scoped to this agent's home, no arbitrary filesystem or bearer URLs. */
  readMedia(path: string): Promise<string>
}
