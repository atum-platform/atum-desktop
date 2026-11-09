/**
 * shared/app-view/ipc.ts
 *
 * The renderer ↔ main contract for app views (slice 3 of the app-launch
 * design). The renderer opens a view from `{app, route_id}` and afterwards
 * only reports geometry and visibility for an opaque `viewId`. No payload in
 * either direction carries an origin, a path, a launch URL, a redirect URL,
 * or a response header: main resolves and navigates, the renderer hosts.
 */

export const APP_VIEW_IPC = {
  open: 'atum:app-view:open',
  bounds: 'atum:app-view:bounds',
  visibility: 'atum:app-view:visibility',
  focus: 'atum:app-view:focus',
  reload: 'atum:app-view:reload',
  back: 'atum:app-view:back',
  external: 'atum:app-view:external',
  close: 'atum:app-view:close',
  /** main → renderer */
  state: 'atum:app-view:state'
} as const

export interface AppViewOpenInput {
  app: string
  route_id: string
  /** Host-owned panel keyboard navigation, absent for standalone views. */
  panelNavigation?: boolean
}

export interface AppViewOpenResult {
  viewId: string
}

export interface AppViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface AppViewBoundsInput {
  viewId: string
  bounds: AppViewBounds
}

export interface AppViewVisibilityInput {
  viewId: string
  /** The hosting tab is the active one and its host element is on screen. */
  visible: boolean
  /** A renderer-owned surface (modal, popover, drawer scrim) overlaps the host. */
  overlayActive: boolean
}

/**
 * Typed failure vocabulary shown in the tab body. Platform launch refusals
 * arrive verbatim; Moon's landing header maps onto the same set; transport
 * and policy outcomes are named here.
 */
export type AppViewError =
  | 'not_linked'
  | 'unlinked'
  | 'membership_inactive'
  | 'app_unavailable'
  | 'app_version_incompatible'
  | 'route_unknown'
  | 'route_session_not_required'
  | 'temporarily_unavailable'
  | 'rate_limited'
  | 'security_failure'
  | 'navigation_blocked'
  | 'load_failed'
  | 'account_unavailable'

export type AppViewStatus = 'launching' | 'ready' | 'error' | 'destroyed'

export interface AppViewState {
  viewId: string
  panelCommand?: 'focus-chat' | number
  canGoBack?: boolean
  matchedRouteId?: string | null
  atRouteRoot?: boolean
  status: AppViewStatus
  error?: AppViewError
  /** For `rate_limited` and `temporarily_unavailable`: when a retry may be offered. */
  retryAfterMs?: number
}

export interface AppViewResultFailure {
  error: string
}

export type AppViewResult<T> = AppViewResultFailure | T

/** Narrow renderer capability; Matrix may inject this without depending on preload globals. */
export interface AppViewBridge {
  open: (input: AppViewOpenInput) => Promise<AppViewResult<AppViewOpenResult>>
  setBounds: (input: AppViewBoundsInput) => Promise<AppViewResult<{ ok: true }>>
  setVisibility: (input: AppViewVisibilityInput) => Promise<AppViewResult<{ ok: true }>>
  focus: (viewId: string) => Promise<AppViewResult<{ ok: true }>>
  back?: (viewId: string) => Promise<AppViewResult<{ ok: true }>>
  external?: (viewId: string) => Promise<AppViewResult<{ ok: true }>>
  reload: (viewId: string) => Promise<AppViewResult<{ ok: true }>>
  close: (viewId: string) => Promise<AppViewResult<{ ok: true }>>
  onState: (callback: (state: AppViewState) => void) => () => void
}
