import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Structural guard: every renderer surface that portals or paints a fixed
 * layer can overlap an app view, and a native `WebContentsView` would paint
 * over it. Each such surface — per occurrence, not per file — must hold the
 * app-view overlay token: either `<AppViewOverlayHold />` mounted inside the
 * element (within the next lines of the same JSX element) or
 * `useAppViewOverlayHold()` called in the enclosing component, which covers
 * every branch that component renders. Anything else must be justified below
 * for the named component, and a stale justification fails the test.
 * Default-deny: a new overlay is overlapping until proven held.
 *
 * `useAppViewOverlayHoldWhenOverlapping(ref)` counts as a hold too. It is not
 * an exemption: it takes the SAME token, and takes it whenever the surface's
 * measured box actually lands on a native view — which is the invariant this
 * guard exists to protect. What it declines to do is detach a view the surface
 * never reaches, which is why a tooltip anywhere in the window no longer tears
 * down the PDF viewer. A surface using it must measure its own painted box.
 */
const ROOT = join(process.cwd(), 'src')
const HOOK = /\buseAppViewOverlayHold(?:WhenOverlapping)?\(/u
const MOUNTED_HOLD = /<AppViewOverlayHold\s*\/>|<TooltipAppViewHold\b/u
/** Fallback span (lines either side) for occurrences outside any JSX return block. */
const HOLD_WINDOW = 15

const OVERLAY_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: 'portal', pattern: /createPortal\(|<[A-Za-z][A-Za-z0-9.]*Portal\b/gu },
  // Any className expression (quoted, template, cn(...)) that positions a
  // full-screen fixed layer: `fixed` with `inset-0`, or all four edges.
  { kind: 'full-screen', pattern: /\bfixed\b(?=[^\n]*\binset-0\b)|\binset-0\b(?=[^\n]*\bfixed\b)|\bfixed\b(?=[^\n]*\btop-0\b)(?=[^\n]*\bbottom-0\b)(?=[^\n]*\bleft-0\b)(?=[^\n]*\bright-0\b)/gu },
  // Partial fixed layers: any string literal carrying the `fixed` utility
  // (multiline cn(...) branches included, whatever supplies the offsets) or
  // an inline `position: 'fixed'` — still above the workspace, so inventoried.
  { kind: 'fixed', pattern: /['"`][^'"`\n]*(?<![-\w])fixed\b(?![-:])(?=[^'"`\n]*\b(?:z-|inset-|top-|bottom-|left-|right-|w-|h-|translate-|pointer-events-|max-w-)[^'"`\n]*['"`])[^'"`\n]*['"`]|position:\s*['"]fixed['"]/gu },
]

/**
 * Overlays that cannot overlap an app view, keyed `file#Component`, with the
 * reason. The component must exist and contain the occurrence.
 */
const NOT_OVERLAPPING: Record<string, string> = {
  'app/shell/titlebar-controls.tsx#TitlebarControls': 'titlebar clusters live in the band above every app view (APP_VIEW_TOP_INSET_DIPS)',
  'components/ui/sidebar.tsx#Sidebar': 'the sidebar rail sits beside the workspace; app-view bounds come from the tab element, which excludes it',
  'app/floating-hud.ts#HUD_POSITION': 'class constant, not a surface; its consumers (command palette, session switcher) hold',
  'components/notifications.tsx#REGION_BASE': 'class constant, not a surface; both notification regions in this file hold',
  'lib/drag-ghost.ts#createDragGhost': 'transient drag image that follows the pointer for the length of a drag; a native view above it hides only the ghost and intercepts nothing the ghost owned',
  'app/right-sidebar/terminal/persistent.tsx#PersistentTerminal': 'positioned over its own right-sidebar slot rectangle, outside the workspace',
  'components/pet/floating-pet.tsx#FloatingPet': 'returns null while $attachedAppViews > 0 (asserted below); a view stays counted until main acknowledges its detachment (trackAppViewAttachment)',
  'matrix/company-space-tabs.tsx#CompanySpaceTabs': 'portals the Chat/Board/Marketplace tabs into the title-bar header host; it sits in the header strip, never over the app view',
  'matrix/drive.tsx#MatrixDrive': 'portals its sync status and view controls into the title bar\'s page slots (data-atum-page-status / -actions); they sit in the header strip, never over the app view',
  'matrix/store/discover-view.tsx#MatrixDiscoverView': 'portals the Protons balance into the title bar\'s page actions slot; it sits in the header strip, never over the app view',
  'components/ui/context-menu.tsx#ContextMenuPortal': 'passthrough portal; ContextMenuContent and SubContent hold',
  'components/ui/dialog.tsx#DialogPortal': 'passthrough portal; DialogOverlay and DialogContent hold',
  'components/ui/sheet.tsx#SheetPortal': 'passthrough portal; SheetOverlay and SheetContent hold',
  'components/ui/dropdown-menu.tsx#DropdownMenuPortal': 'passthrough portal; DropdownMenuContent and SubContent hold',
  'matrix/playground/entry.tsx#Playground': 'the design playground bar: dev only, served by Vite alone, and the playground has no native views',
  'matrix/app.tsx#MatrixAccountView': 'the skip link to the message box: fixed only while it has keyboard focus, inside the 48px titlebar band (top-2) above every app view, and not rendered while an app is open',
}

function walk(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry)

    if (statSync(full).isDirectory()) {walk(full, found)} else if (/\.tsx?$/u.test(entry) && !/\.test\.tsx?$/u.test(entry)) {found.push(full)}
  }

  return found
}

type Segment = { name: string; start: number; end: number }

/** Top-level component/function segments by declaration line; the file tail belongs to the last one. */
function segments(lines: string[]): Segment[] {
  const found: Segment[] = []
  const declaration = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*[:=])/u

  lines.forEach((line, index) => {
    const match = declaration.exec(line)

    if (match) {found.push({ name: match[1] ?? match[2] ?? 'anonymous', start: index, end: lines.length })}
  })
  found.forEach((segment, index) => { segment.end = found[index + 1]?.start ?? lines.length })

  return found
}

function enclosing(found: Segment[], line: number): Segment | undefined {
  return [...found].reverse().find(segment => segment.start <= line && line < segment.end)
}

/**
 * The JSX block the occurrence is rendered in: from the nearest preceding
 * `return (` to its closing `)` at the same indentation. Branches of one
 * component are separate blocks, so a hold in another branch never counts.
 */
function renderBlock(lines: string[], line: number, limit: number): [number, number] {
  for (let index = line; index >= limit; index -= 1) {
    const match = /^(\s*)return\s*\(\s*$/u.exec(lines[index])

    if (!match) {continue}
    const indent = match[1]
    const close = new RegExp(`^${indent}\\)`, 'u')
    let end = index + 1

    while (end < lines.length && !close.test(lines[end])) {end += 1}

    return [index, end]
  }

  return [Math.max(0, line - HOLD_WINDOW), line + HOLD_WINDOW]
}

describe('app-view overlay inventory', () => {
  it('every portaled or fixed surface holds the overlay token per occurrence, or is justified per component', () => {
    const offenders: string[] = []
    const used = new Set<string>()

    for (const file of walk(ROOT)) {
      const source = readFileSync(file, 'utf8')
      const path = relative(ROOT, file)

      if (path === 'store/use-app-view-overlay.ts') {continue}
      const lines = source.split('\n')
      const found = segments(lines)

      lines.forEach((line, index) => {
        if (/^\s*(?:\/\/|\*|\/\*)/u.test(line) || /\bimport\b/u.test(line)) {return}

        for (const { kind, pattern } of OVERLAY_PATTERNS) {
          pattern.lastIndex = 0

          if (!pattern.test(line)) {continue}
          const segment = enclosing(found, index)
          const key = `${path}#${segment?.name ?? 'anonymous'}`
          const [blockStart, blockEnd] = renderBlock(lines, index, segment?.start ?? 0)
          const block = lines.slice(blockStart, blockEnd + 1).join('\n')
          const componentBody = segment ? lines.slice(segment.start, segment.end).join('\n') : ''

          if (MOUNTED_HOLD.test(block) || HOOK.test(componentBody)) {break}

          if (NOT_OVERLAPPING[key]) {
            used.add(key)

            break
          }

          offenders.push(`${path}:${index + 1} (${kind} in ${segment?.name ?? 'anonymous'})`)

          break
        }
      })
    }

    expect(offenders, 'overlay occurrences without a hold in the element or a hook in the component (add the hold, or justify the component in NOT_OVERLAPPING)').toEqual([])
    // Justifications that rest on behaviour are pinned to the code that provides it.
    expect(readFileSync(join(ROOT, 'components/pet/floating-pet.tsx'), 'utf8')).toMatch(/\|\| appViewsAttached > 0\) \{\s*return null/u)
    expect(readFileSync(join(ROOT, 'app/chat/composer/index.tsx'), 'utf8')).toMatch(/\{poppedOut \? <AppViewOverlayHold \/> : null\}/u)
    const appView = readFileSync(join(ROOT, 'app/atum/app-view.tsx'), 'utf8')

    expect(appView).toMatch(/trackAppViewAttachment\(viewId, attached, \(\) =>\s*bridge\.setVisibility\(/u)
    expect(appView).not.toMatch(/markAppViewAttached\(/u)
    expect([...Object.keys(NOT_OVERLAPPING)].filter(key => !used.has(key)), 'stale justifications (component or occurrence no longer exists)').toEqual([])
  })
})
