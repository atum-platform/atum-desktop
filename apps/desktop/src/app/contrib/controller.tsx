import { useStore } from '@nanostores/react'
import { computed } from 'nanostores'
import { type CSSProperties, type ReactElement, type PointerEvent as ReactPointerEvent, useRef } from 'react'

import { $atumStartupHolding, atumStartupOwnsWindow } from '@/app/atum/startup-ownership'
import { SessionStatusDot } from '@/app/chat/session-status-dot'
import { PALETTE_AREA, type PaletteContribution } from '@/app/command-palette/contrib'
import { type StatusbarItem } from '@/app/shell/statusbar-controls'
import { IdleMount } from '@/components/idle-mount'
import { toggleLayoutEditMode } from '@/components/pane-shell/edit-mode'
import { allPaneIds, group, split } from '@/components/pane-shell/tree/model'
import { LayoutTreeRoot } from '@/components/pane-shell/tree/renderer'
import type { DoubleTapContext } from '@/components/pane-shell/tree/renderer/drag-session'
import {
  $layoutTree,
  bindTreeSideVisibility,
  declareDefaultTree,
  dismissTreePane,
  markCollapsePane,
  mirrorLayoutTree,
  paneRootSide,
  registerLayoutResetHandler,
  registerPaneCloser,
  registerPaneOpener,
  resetLayoutTree,
  setPaneCollapsed,
  setTreePaneHidden,
  watchContributedPanes
} from '@/components/pane-shell/tree/store'
import { SidebarProvider } from '@/components/ui/sidebar'
import { discoverBundledPlugins } from '@/contrib/plugins'
import { Slot } from '@/contrib/react/slot'
import { useContributions } from '@/contrib/react/use-contributions'
import { registry } from '@/contrib/registry'
import { discoverRuntimePlugins, mayDiscoverRuntimePlugins } from '@/contrib/runtime-loader'
import { sessionTitle as storedSessionTitle } from '@/lib/chat-runtime'
import { LayoutDashboard } from '@/lib/icons'
import { type KeybindContribution, KEYBINDS_AREA } from '@/lib/keybinds/actions'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { $atumShellEnabled } from '@/store/atum-shell'
import { $desktopBoot } from '@/store/boot'
import { $gatewaySwitching } from '@/store/gateway-switch'
import {
  $fileBrowserOpen,
  $panesFlipped,
  $sidebarOpen,
  FILE_BROWSER_DEFAULT_WIDTH,
  FILE_BROWSER_MAX_WIDTH,
  FILE_BROWSER_MIN_WIDTH,
  setFileBrowserOpen,
  setSidebarOpen,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH
} from '@/store/layout'
import { $reviewOpen, closeReview, REVIEW_PANE_ID } from '@/store/review'
import { $currentCwd, $gatewayState, $selectedStoredSessionId, $sessions, sessionMatchesStoredId } from '@/store/session'
import { openWorkspaceTextFileTab } from '@/store/workspace-text-files'

import { AtumShellRoot } from '../atum/shell'
import type { SessionDragPayload } from '../chat/composer/inline-refs'
import { watchRouteTiles } from '../chat/route-tile'
import { startSessionDrag } from '../chat/session-drag'
import {
  SessionTileCloseConfirm,
  stackSessionTilesIntoMain,
  watchSessionTiles,
  WorkspaceTabMenu
} from '../chat/session-tile'
import { watchWorkbenchResourceTabs } from '../chat/workbench-resource-pane'
import { watchWorkspaceTextFileTabs } from '../chat/workspace-text-file-pane'
import { $terminalTakeover, setTerminalTakeover } from '../right-sidebar/store'
import { $workspaceIsPage } from '../routes'

import { FilesPane, LogsPane, ReviewPaneContent } from './panes'
import { ContribWiring, WiredPane } from './wiring'

/**
 * Stripped-down app root (bb/contrib-areas) on the layout TREE model, mounting
 * the REAL app surfaces. The title bar and status bar sit OUTSIDE the grid
 * (fixed chrome) but are fully composable: title bar renders `titleBar.left/
 * right` slots; the status bar consumes `statusBar.left/right` DATA
 * contributions (payload = StatusbarItem). Core registers its items through
 * the same calls a plugin would use.
 */

// ---------------------------------------------------------------------------
// Pane contributions. `data.placement` = semantic role for grid presets;
// `data.minWidth/maxWidth/minHeight/maxHeight` = the SAME clamps the app's
// `Pane` props declare — the layout tree sizes zones by weight (percentage)
// but a zone never shrinks/grows past its active pane's clamp.
// Headers are contextual (tree-side): a pane alone in a zone shows no
// header/tab by default; stacked panes show chips. Double-click a zone
// toggles its header either way.
// ---------------------------------------------------------------------------

// ONE render identity for the workspace pane — syncWorkspaceTitle re-registers
// the contribution (new title) and a fresh closure would remount the chat.
const renderWorkspacePane = () => <WiredPane part="chatRoutes" />

// Boot-hidden panes mount behind display:none (instant-toggle contract) — defer
// them to idle so they're off the first-paint path, warm before reveal.
const idle = (node: ReactElement) => <IdleMount>{node}</IdleMount>
// The main tab carries the same session context menu as tile tabs (targets
// the loaded primary session; no menu on a fresh draft).
const wrapWorkspaceTab = (tab: ReactElement) => <WorkspaceTabMenu>{tab}</WorkspaceTabMenu>

/** The `@session` payload for the workspace tab — the loaded primary session,
 *  or null on a fresh draft / full-page view (nothing to link). */
const workspaceDragPayload = (): SessionDragPayload | null => {
  const selected = $selectedStoredSessionId.get()

  if (!selected || $workspaceIsPage.get()) {
    return null
  }

  const stored = $sessions.get().find(s => sessionMatchesStoredId(s, selected))

  return { id: selected, profile: stored?.profile ?? '', title: stored ? storedSessionTitle(stored) : '' }
}

// The main tab drags like a session tile — drop it on a composer to link the
// chat, on a zone/edge to stack/split. Defers (`false`) to the generic pane
// move when there's no loaded session to carry.
const workspaceTabDrag = (event: ReactPointerEvent<HTMLElement>, onTap: () => void, double?: DoubleTapContext) => {
  const payload = workspaceDragPayload()

  if (!payload) {
    return false
  }

  startSessionDrag(payload, event, { double, onTap })

  return true
}

registry.registerMany([
  {
    id: 'sessions',
    area: 'panes',
    title: 'sessions',
    // Collapsible: leaves the grid on narrow viewports (edge overlay instead).
    // dock: where a RE-ADOPTED pane lands (healed from a stale dismissal) —
    // its default-ish spot beside main, not a random same-placement stack.
    data: {
      placement: 'left',
      collapsible: true,
      dock: { pane: 'workspace', pos: 'left' },
      revealAliases: ['chat-sidebar'],
      width: `${SIDEBAR_DEFAULT_WIDTH}px`,
      minWidth: `${SIDEBAR_DEFAULT_WIDTH}px`,
      maxWidth: `${SIDEBAR_MAX_WIDTH}px`
    },
    render: () => <WiredPane part="sidebar" />
  },
  {
    id: 'workspace',
    area: 'panes',
    // Live-retitled to the loaded session by syncWorkspaceTitle below.
    title: 'New session',
    data: {
      placement: 'main',
      minWidth: '22vw',
      tabDrag: workspaceTabDrag,
      tabWrap: wrapWorkspaceTab,
      uncloseable: true
    },
    render: renderWorkspacePane
  },
  {
    id: 'terminal',
    area: 'panes',
    title: 'terminal',
    // revealOnPreset: choosing a layout that places the terminal (e.g.
    // "Terminal deck") turns takeover on so the zone actually shows, instead of
    // staying collapsed behind the ⌃` toggle. height sizes the fixed track (a
    // single-pane zone declaring a height is a fixed track — the preset weight
    // is moot): a short deck, not a third of the window.
    data: { placement: 'bottom', height: '20vh', minHeight: '7.5rem', maxHeight: '80vh', revealOnPreset: true },
    render: () => <WiredPane part="terminal" />
  },
  {
    id: 'files',
    area: 'panes',
    title: 'files',
    // dock: re-adoption target after a stale dismissal (see sessions).
    data: {
      placement: 'right',
      collapsible: true,
      dock: { pane: 'workspace', pos: 'right' },
      revealAliases: ['file-browser'],
      width: FILE_BROWSER_DEFAULT_WIDTH,
      minWidth: FILE_BROWSER_MIN_WIDTH,
      maxWidth: FILE_BROWSER_MAX_WIDTH
    },
    render: () => idle(<FilesPane />)
  },
  {
    id: 'review',
    area: 'panes',
    title: 'review',
    // The second right sidebar: hidden until ⌘G ($reviewOpen) — bound below
    // like the other chrome toggles; its zone collapses while hidden.
    data: {
      placement: 'right',
      collapsible: true,
      revealAliases: [REVIEW_PANE_ID],
      width: FILE_BROWSER_DEFAULT_WIDTH,
      minWidth: FILE_BROWSER_MIN_WIDTH,
      maxWidth: FILE_BROWSER_MAX_WIDTH
    },
    render: () => idle(<ReviewPaneContent />)
  },
  {
    // Optional chrome — in NO default layout. Adoption stacks it with the
    // terminal; $logsOpen (default off, ⌘K "Toggle logs") reveals it.
    id: 'logs',
    area: 'panes',
    title: 'logs',
    // revealOnPreset: the Quad layout places logs, so applying it turns the
    // logs pane on (like a ⌘K "Toggle logs") instead of leaving it collapsed.
    data: { placement: 'bottom', height: '20vh', minHeight: '7.5rem', maxHeight: '80vh', revealOnPreset: true },
    render: () => idle(<LogsPane />)
  }
])

// ---------------------------------------------------------------------------
// Chrome contributions. The title bar and status bar are fixed chrome outside
// the grid, composable through these areas. Everything real lives in the real
// components (TitlebarControls / useStatusbarItems). Sample PLUGIN
// contributions don't live here — they're their own files under `src/plugins/`,
// auto-discovered by discoverBundledPlugins() below.
// ---------------------------------------------------------------------------

registry.registerMany([
  // Titlebar center stays empty on purpose: session title lives in tabs +
  // sidebar; place/cwd lives in the sidebar project tree. Center is drag
  // chrome (plugins can still contribute to titleBar.center if needed).
  // Layout edit mode registers through the SAME declarative surfaces plugins
  // use: a rebindable keybind (collision-checked in the panel) + a ⌘K row
  // whose hotkey hint tracks the live binding.
  {
    id: 'layout.editMode',
    area: KEYBINDS_AREA,
    data: {
      id: 'layout.editMode',
      label: 'Toggle layout edit mode',
      defaults: ['mod+shift+\\'],
      run: toggleLayoutEditMode
    } satisfies KeybindContribution
  },
  {
    id: 'layout.editMode',
    area: PALETTE_AREA,
    data: {
      id: 'layout.editMode',
      label: 'Toggle layout edit mode',
      action: 'layout.editMode',
      icon: LayoutDashboard,
      keywords: ['layout', 'zones', 'panes', 'edit', 'rearrange'],
      run: toggleLayoutEditMode
    } satisfies PaletteContribution
  },
  // The managed opaque-filesystem surface intentionally has no raw-path
  // runtime plugin door, so do not publish a command that cannot act there.
  ...(mayDiscoverRuntimePlugins()
    ? [
        {
          id: 'plugins.reload',
          area: PALETTE_AREA,
          data: {
            id: 'plugins.reload',
            label: 'Reload desktop plugins',
            keywords: ['plugins', 'reload', 'refresh', 'desktop'],
            run: () => void discoverRuntimePlugins()
          } satisfies PaletteContribution
        }
      ]
    : []),
  {
    id: 'layout.reset',
    area: PALETTE_AREA,
    data: {
      id: 'layout.reset',
      label: 'Reset layout',
      icon: LayoutDashboard,
      keywords: ['layout', 'reset', 'default', 'panes'],
      run: resetLayoutTree
    } satisfies PaletteContribution
  },
  // The keybind panel's non-titlebar door (the keyboard icon is gone).
  {
    id: 'keybinds.panel',
    area: PALETTE_AREA,
    data: {
      id: 'keybinds.panel',
      label: 'Keyboard shortcuts',
      keywords: ['keybinds', 'shortcuts', 'hotkeys', 'keyboard'],
      run: () => window.dispatchEvent(new CustomEvent('hermes:open-keybinds'))
    } satisfies PaletteContribution
  },
  {
    id: 'workspace.openTextFile',
    area: PALETTE_AREA,
    data: {
      id: 'workspace.openTextFile',
      label: 'Open text or Markdown file',
      keywords: ['file', 'markdown', 'text', 'editor', 'open'],
      run: () => void openWorkspaceTextFileTab()
    } satisfies PaletteContribution
  }
])

// ---------------------------------------------------------------------------
// Layout presets — CHAT (main) always dominates.
// ---------------------------------------------------------------------------

// The REAL default: sessions left, chat main, and review/files at the edge.
// Resource panes register dynamically and dock into the main workspace group.
const DEFAULT_TREE = split(
  'row',
  [
    group(['sessions'], { id: 'grp-sessions' }),
    group(['workspace'], { id: 'grp-main' }),
    split(
      'column',
      [
        split(
          'row',
          [
            group(['review'], { id: 'grp-review' }),
            group(['files'], { id: 'grp-files' })
          ],
          [1, 1.2],
          'spl-rail'
        ),
        group(['terminal'], { id: 'grp-terminal' })
      ],
      [1.6, 1],
      'spl-right'
    )
  ],
  [1, 3.4, 1.25],
  'spl-root'
)

const FOCUS_TREE = split(
  'row',
  [group(['sessions']), group(['workspace', 'files', 'review', 'terminal'])],
  [1, 4.6]
)

const TERMINAL_TREE = split(
  'column',
  [
    split('row', [group(['sessions']), group(['workspace']), group(['files', 'review'])], [1, 3.2, 1.2]),
    group(['terminal'])
  ],
  [3, 1]
)

const QUAD_TREE = split(
  'column',
  [
    split('row', [group(['sessions', 'files']), group(['workspace'])], [1, 3]),
    split('row', [group(['terminal']), group(['review', 'logs'])], [1.4, 1])
  ],
  [3, 1]
)

registry.registerMany([
  { id: 'default', area: 'layouts', title: 'Default', order: 0, data: DEFAULT_TREE },
  { id: 'focus', area: 'layouts', title: 'Focus', order: 10, data: FOCUS_TREE },
  { id: 'terminal-deck', area: 'layouts', title: 'Terminal deck', order: 20, data: TERMINAL_TREE },
  { id: 'quad', area: 'layouts', title: 'Quad', order: 30, data: QUAD_TREE }
])

declareDefaultTree(DEFAULT_TREE)

// Bundled plugins load AFTER core, so a same-id contribution from a plugin
// deliberately overrides the core default (last writer wins). Third-party
// runtime plugins will flow through the same discovery seam.
discoverBundledPlugins()

// Plugin panes join the tree by their `placement` hint the moment they
// register — incl. runtime plugins arriving seconds after boot.
watchContributedPanes()

// Session + route (page) tiles: persisted splits register panes docked beside
// main.
watchSessionTiles()
watchRouteTiles()
watchWorkspaceTextFileTabs()
watchWorkbenchResourceTabs()

// The main tab reads as its SESSION (the loaded title, "New session" on a
// fresh draft) — a stack of main + tiles is then just a row of session names.
// register() replaces same-id in place; the render fn is the shared constant
// above, so the pane content never remounts.
const syncWorkspaceTitle = () => {
  const selected = $selectedStoredSessionId.get()
  const stored = selected ? $sessions.get().find(s => sessionMatchesStoredId(s, selected)) : null

  registry.register({
    id: 'workspace',
    area: 'panes',
    title: stored ? storedSessionTitle(stored) : 'New session',
    data: {
      // The tab's status dot — the SAME primitive the sidebar row and session
      // tiles render, so the main tab never disagrees with its sidebar row. No
      // dot on a fresh draft (no session yet).
      tabLead: selected ? () => <SessionStatusDot session={stored} storedSessionId={selected} /> : undefined,
      // Pages aren't tab-able: the main zone's bar stands down while one shows.
      headerVeto: $workspaceIsPage.get(),
      placement: 'main',
      minWidth: '22vw',
      tabDrag: workspaceTabDrag,
      tabWrap: wrapWorkspaceTab,
      uncloseable: true
    },
    render: renderWorkspacePane
  })
}

$selectedStoredSessionId.listen(syncWorkspaceTitle)
$sessions.listen(syncWorkspaceTitle)
$workspaceIsPage.listen(syncWorkspaceTitle)

// Layout reset collapses every session tile into main as a tab (after the
// workspace) instead of re-scattering them — pre-placed before adoption.
registerLayoutResetHandler(stackSessionTilesIntoMain)

// ---------------------------------------------------------------------------
// Titlebar chrome toggles -> tree. The TitlebarControls buttons keep their
// store semantics ($sidebarOpen / $fileBrowserOpen / $panesFlipped); the tree
// reacts — a hidden pane's zone collapses (content stays mounted), the flip
// toggle mirrors the root row.
// ---------------------------------------------------------------------------

function bindPaneVisibility(
  paneId: string,
  $open: { get(): boolean; listen(fn: (open: boolean) => void): void },
  close?: () => void,
  open?: () => void
) {
  setTreePaneHidden(paneId, !$open.get())
  $open.listen(isOpen => setTreePaneHidden(paneId, !isOpen))

  // The tab menu's Close routes through the owning store (never dismissal),
  // so the pane's toggle buttons stay truthful.
  if (close) {
    registerPaneCloser(paneId, close)
  }

  // The opener is the mirror: preset application (revealOnPreset) shows the
  // pane through the same store, so the toggle stays truthful.
  if (open) {
    registerPaneOpener(paneId, open)
  }
}

// TOOL PANELS (terminal, logs): like bindPaneVisibility but the toggle COLLAPSES
// the zone to a persistent rail (tab stays) instead of hiding it — the
// IntelliJ/VS-Code tool-window model. Restore routes back through `open` (rail
// click / chevron) so ⌃`/the button stay truthful; the tab's ✕ removes it.
function bindPaneCollapse(
  paneId: string,
  $open: { get(): boolean; listen(fn: (open: boolean) => void): void },
  close: () => void,
  open: () => void
) {
  markCollapsePane(paneId)
  setPaneCollapsed(paneId, !$open.get())
  $open.listen(isOpen => setPaneCollapsed(paneId, !isOpen))
  registerPaneCloser(paneId, close)
  registerPaneOpener(paneId, open)
}

// SIDES have one source of truth: the TREE. The legacy $panesFlipped flag is
// DERIVED from where the sessions zone actually sits (TitlebarControls maps
// its left/right buttons through it), so dragging sessions across — or
// applying a mirrored preset — remaps the buttons automatically. The flip
// action (⌘\ / titlebar) mirrors the tree only when they disagree.
const sessionsOnRight = () => {
  const tree = $layoutTree.get()

  if (!tree) {
    return null
  }

  const order = allPaneIds(tree)
  const sessions = order.indexOf('sessions')
  const main = order.indexOf('workspace')

  return sessions >= 0 && main >= 0 ? sessions > main : null
}

$layoutTree.subscribe(() => {
  const flipped = sessionsOnRight()

  if (flipped !== null && flipped !== $panesFlipped.get()) {
    $panesFlipped.set(flipped)
  }
})

$panesFlipped.listen(flipped => {
  const current = sessionsOnRight()

  if (current !== null && current !== flipped) {
    mirrorLayoutTree()
  }
})

// POSITIONAL side toggles (titlebar buttons, ⌘B / ⌘J): $sidebarOpen ≙ the
// LEFT side of the main zone, $fileBrowserOpen ≙ the RIGHT — everything on
// that side hides together, whatever panes have been rearranged there.
bindTreeSideVisibility('left', $sidebarOpen, setSidebarOpen)
bindTreeSideVisibility('right', $fileBrowserOpen, setFileBrowserOpen)

// Workspace-scoped surfaces: the file tree and git diff only mean something
// inside a project. A detached chat (no cwd) hides them — their zones
// collapse and the chat absorbs the width; picking a project brings them
// back. The terminal is NOT workspace-gated: unlike the old shell (where it
// rode the rail's row and vanished with it), its zone stands on its own.
const $hasWorkspace = computed($currentCwd, cwd => Boolean(cwd.trim()))

bindPaneVisibility('files', $hasWorkspace)
// ⌘G — the review sidebar appears/disappears (and comes to the front).
bindPaneVisibility(
  'review',
  computed([$reviewOpen, $hasWorkspace], (open, workspace) => open && workspace),
  closeReview
)
// ⌃` / statusbar toggle — the terminal COLLAPSES to a rail (tab stays), not
// hides; PTYs stay alive while collapsed (see PersistentTerminal).
bindPaneCollapse(
  'terminal',
  $terminalTakeover,
  () => setTerminalTakeover(false),
  () => setTerminalTakeover(true)
)

// Logs are optional chrome: off by default, toggled from ⌘K, persisted.
const $logsOpen = persistentAtom('hermes.desktop.logsOpen', false, Codecs.bool)

bindPaneCollapse(
  'logs',
  $logsOpen,
  () => $logsOpen.set(false),
  () => $logsOpen.set(true)
)
registry.register({
  id: 'logs.toggle',
  area: PALETTE_AREA,
  data: {
    id: 'logs.toggle',
    label: 'Toggle logs',
    keywords: ['logs', 'agent log', 'tail', 'debug'],
    run: () => $logsOpen.set(!$logsOpen.get())
  } satisfies PaletteContribution
})

// Sessions/files Close = collapse their SIDE (⌘B/⌘J truthful, titlebar button
// flips back) — but only while the pane actually lives in that root side
// column. Dragged next to main, a side collapse can't hide it (the collapse
// skips main-bearing children), so Close falls back to dismissal there —
// otherwise ⌘W/Close silently no-op.
registerPaneCloser('sessions', () =>
  paneRootSide('sessions') === 'left' ? setSidebarOpen(false) : dismissTreePane('sessions')
)
registerPaneCloser('files', () =>
  paneRootSide('files') === 'right' ? setFileBrowserOpen(false) : dismissTreePane('files')
)

// ---------------------------------------------------------------------------

interface TitlebarSlotProps {
  area: 'titleBar.center' | 'titleBar.left' | 'titleBar.right'
  className: string
  style?: CSSProperties
}

function TitlebarSlot({ area, className, style }: TitlebarSlotProps) {
  const items = useContributions(area)

  if (items.length === 0) {
    return null
  }

  return (
    <div className={className} style={style}>
      <Slot area={area} />
    </div>
  )
}

export function ContribController() {
  const sidebarOpen = useStore($sidebarOpen)
  // The Atum product shell replaces the chrome ONLY — it mounts inside
  // ContribWiring, so contributions, keybinds, overlays, dialogs, the command
  // palette, notifications, and boot surfaces are identical either way. With
  // the flag off the legacy Hermes chrome renders verbatim.
  const atumShell = useStore($atumShellEnabled)
  const boot = useStore($desktopBoot)
  const gatewayState = useStore($gatewayState)
  const gatewaySwitching = useStore($gatewaySwitching)
  const startupHolding = useStore($atumStartupHolding)
  // Once cold boot has completed once, startup can never reclaim the window —
  // a post-boot socket drop must leave the shell up (see startup-ownership.ts).
  const coldBootDoneRef = useRef(false)

  if (!boot.running && boot.progress >= 100 && !boot.error) {
    coldBootDoneRef.current = true
  }

  // Atum's ONE startup surface is the Atum mark/rings plate. While it owns the
  // window, the product shell and the sign-in gate are not mounted at all, so
  // the translucent plate has no application pixels to reveal and no
  // pre-hydration welcome copy can flash in the wrong locale. Computed
  // synchronously from the same facts the overlay uses, so the very first
  // frame is already correct — an effect would paint the shell once first.
  const startupOwnsWindow =
    atumShell &&
    (startupHolding ||
      atumStartupOwnsWindow({
        bootError: boot.error,
        bootProgress: boot.progress,
        bootRunning: boot.running,
        bootVisible: boot.visible,
        coldBootDone: coldBootDoneRef.current,
        gatewayState,
        gatewaySwitching
      }))

  const atumContent = startupOwnsWindow ? null : <AtumShellRoot />

  return (
    <SidebarProvider
      className={atumShell ? 'h-screen min-h-0 flex-col bg-transparent' : 'h-screen min-h-0 flex-col bg-background'}
      onOpenChange={setSidebarOpen}
      open={sidebarOpen}
      style={{ '--sidebar-width': '100%' } as CSSProperties}
    >
      <ContribWiring>{atumShell ? atumContent : <LegacyHermesChrome />}</ContribWiring>
    </SidebarProvider>
  )
}

/** The Hermes shell chrome: 34px titlebar with contribution slots, the pane
 *  tree, and the real statusbar. Unchanged — moved verbatim out of
 *  `ContribController` so the Atum shell could branch beside it. */
function LegacyHermesChrome() {
  return (
    <div
      className="flex h-screen min-h-0 w-screen flex-col bg-(--ui-bg-chrome) text-(--ui-text-primary)"
      style={{ '--titlebar-height': '0px' } as CSSProperties}
    >
      {/* Title bar: fixed chrome outside the grid, composable via slots.
              Layout contract (no contribution can break it):
                - a full-bar DRAG BASE underneath (pointer-events-none, like
                  AppShell's drag strips) — everywhere without content drags
                  the window;
                - each slot region is width-fit, no-drag, pointer-events-auto,
                  so every contribution is clickable by construction;
                - LEFT/RIGHT slots align to the MAIN PANE's geometry via the
                  tree-published --workspace-left/right vars (pure CSS, no rect
                  threading), clamped to clear the REAL TitlebarControls
                  clusters (fixed, z-70); center is truly window-centered. */}
      <div className="relative flex h-[34px] shrink-0 items-center border-b border-(--ui-stroke-tertiary) text-xs">
        {/* Drag strips, AppShell-style: cut to AVOID the fixed control
                clusters instead of overlapping them — Electron's no-drag
                carve-out of fixed/transformed elements is unreliable, so a
                full-bar drag base kills their clicks. In-flow slot content
                still carves via its own no-drag wrapper (the same pattern as
                the app's session-title button). */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-(--titlebar-controls-left,14px) [-webkit-app-region:drag]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-[calc(var(--titlebar-controls-left,14px)+(var(--titlebar-control-size,1.25rem)*2)+0.75rem)] right-[calc(var(--titlebar-tools-right,0.75rem)+var(--titlebar-tools-width,5.5rem)+0.75rem)] [-webkit-app-region:drag]"
        />
        <TitlebarSlot
          area="titleBar.left"
          className="pointer-events-auto absolute z-10 flex w-max items-center gap-2 [-webkit-app-region:no-drag]"
          style={{
            left: 'max(calc(var(--workspace-left, 0px) + 0.5rem), calc(var(--titlebar-controls-left, 14px) + 2 * var(--titlebar-control-size, 1.25rem) + 1rem))'
          }}
        />
        <TitlebarSlot
          area="titleBar.center"
          className="pointer-events-auto absolute left-1/2 top-1/2 z-10 flex w-max -translate-x-1/2 -translate-y-1/2 items-center gap-2 [-webkit-app-region:no-drag]"
        />
        <TitlebarSlot
          area="titleBar.right"
          className="pointer-events-auto absolute z-10 flex w-max items-center gap-2 [-webkit-app-region:no-drag]"
          style={{
            right:
              'max(calc(var(--workspace-right, 0px) + 0.5rem), calc(var(--titlebar-tools-right, 0.75rem) + 4 * (var(--titlebar-control-size, 1.25rem) + 0.25rem) + 0.5rem))'
          }}
        />
      </div>

      <LayoutTreeRoot />

      {/* "Close running tab?" — the busy/input-blocked tile close gate. */}
      <SessionTileCloseConfirm />

      {/* The REAL statusbar (model pill, command center, agents, …) with
              statusBar.left/right contributions merged in. */}
      <WiredPane part="statusbar" />
    </div>
  )
}

// Referenced type kept for plugin authors' reference (payload shape of
// statusBar.* contributions).
export type { StatusbarItem }
