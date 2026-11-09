/**
 * Panel-local glass geometry for the macOS behind-window blur bridge.
 *
 * Chromium's `backdrop-filter` only blurs DOM painted inside the window, so on
 * macOS the frosted Atum surfaces are mirrored to the main process as plain
 * rectangles; the native bridge places one radius-clipped NSVisualEffectView
 * per surface BEHIND the web content, which diffuses the real desktop.
 * The native addon also derives one low-alpha, neutral shell lens from those
 * same rectangles: an even-odd mask keeps real behind-window diffusion in
 * everything the panels do not cover — the outer gutter and the gaps between
 * them — so the plates float on glass rather than on holes. The lens spans the
 * content area, with a radius offset concentrically outward from the panel
 * radius; that keeps its corners inside the NSWindow mask, which is what stops
 * a square envelope rasterizing into a dark stepped exterior outline.
 *
 * This module is the only renderer code that knows the bridge exists. When
 * the preload exposes no bridge (every non-macOS platform, or an older
 * runtime), nothing here runs and the CSS-only material remains as-is.
 */

/**
 * The density band a surface asks the native material for.
 *
 * The Kimi artifact does NOT use one recipe for every panel — the rail is the
 * thinnest glass (0.22 tint), the roster/workspace sit in the middle
 * (0.32/0.34), and the transcript is the most present (0.40). A single native
 * material collapses that hierarchy into one flat sheet, so the tier travels
 * with each region and the addon picks the matching NSVisualEffectMaterial.
 */
export type AtumGlassMaterial = 'regular' | 'thick' | 'thin'

export interface AtumGlassRegion {
  height: number
  material: AtumGlassMaterial
  radius: number
  width: number
  x: number
  y: number
}

export interface AtumVibrancyFrame {
  dark: boolean
  regions: AtumGlassRegion[]
}

export interface AtumVibrancyClient {
  setRegions: (frame: AtumVibrancyFrame) => Promise<{ error?: string; ok: boolean }>
}

/**
 * Every discrete frosted surface of the floating-glass material, grouped by the
 * density band it asks the native material for. Order within the table is
 * priority order for tier resolution, not paint order — the native reconcile
 * re-syncs wholesale, and regions are emitted in document order.
 *
 * Only TOP-LEVEL floating surfaces appear here. Native glass is placed BEHIND
 * all web content, so an interior surface (the composer, which sits inside the
 * transcript plate) would stack a native material under two painted CSS tints
 * and read as an opaque slab — and the native view could not blur the
 * transcript scrolling above it anyway. Interior surfaces stay on the CSS
 * `backdrop-filter`, which is exactly what the Kimi artifact does.
 *
 * Drawers reuse the same hooks (`data-atum-roster` / `data-atum-workspace`), so
 * compact and drawer layouts need no special cases. The full rectangle set is
 * also the native seam lens's subtraction mask; no extra renderer region or
 * CSS tint is needed.
 */
const ATUM_GLASS_TIERS: ReadonlyArray<readonly [AtumGlassMaterial, string]> = [
  // The lid: the thinnest band, most desktop showing through.
  ['thin', '[data-atum-rim]'],
  // Navigation-weight panels. The rail no longer emits its own region:
  // rail+roster sit 2px apart across the fused seam, and two 14px-radius
  // native views that close leave diamond holes at the seam corners, so they
  // emit ONE union region. The CSS plates stay separate and keep their own
  // tints — the rail's thinner tint is what keeps it visibly lighter.
  ['regular', '[data-atum-sidebar-union],[data-atum-rail][data-atum-solo],[data-atum-workspace],[data-atum-workspace-loading]'],
  // Long-form reading surfaces and full-plate overlays: the most present band,
  // where legibility outranks transmission.
  ['thick', '.atum-plate-chat,.atum-auth-plate,.atum-startup-plate']
]

const ATUM_GLASS_SELECTOR = ATUM_GLASS_TIERS.map(([, selector]) => selector).join(',')

/** First matching tier wins; a surface that somehow matches none is mid-band. */
function surfaceMaterial(el: Element): AtumGlassMaterial {
  for (const [material, selector] of ATUM_GLASS_TIERS) {
    if (el.matches(selector)) {
      return material
    }
  }

  return 'regular'
}

/** `--atum-r-surface`; the read falls back here when a computed style is odd. */
const FALLBACK_RADIUS = 14

const round3 = (value: number): number => Math.round(value * 1000) / 1000

function surfaceRadius(el: Element): number {
  const raw = getComputedStyle(el).borderTopLeftRadius
  const parsed = Number.parseFloat(raw)

  if (!Number.isFinite(parsed) || raw.trim() === '') {
    return FALLBACK_RADIUS
  }

  return parsed
}

/** Measure every currently-visible frosted surface in viewport (CSS-point)
 *  coordinates, which map 1:1 onto the window's content area on macOS. */
export function collectAtumGlassRegions(root: ParentNode): AtumGlassRegion[] {
  // The retained solid recovery material paints an opaque canvas — native
  // glass behind it would be invisible spend, so report nothing.
  if (root.querySelector(".atum-shell[data-atum-material='legacy-solid']")) {
    return []
  }

  // Reduce transparency: every plate takes its opaque projection (styles.css),
  // so a native lens would be invisible spend that still tints the gutter.
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-transparency: reduce)').matches) {
    return []
  }

  const regions: AtumGlassRegion[] = []

  for (const el of root.querySelectorAll(ATUM_GLASS_SELECTOR)) {
    const rect = el.getBoundingClientRect()

    if (rect.width <= 0 || rect.height <= 0) {
      continue
    }

    // A plate mid-fade (startup overlay leaving) must not leave a crisp blur
    // rectangle behind its transparent pixels.
    if (getComputedStyle(el).opacity === '0') {
      continue
    }

    regions.push({
      height: round3(rect.height),
      material: surfaceMaterial(el),
      radius: round3(surfaceRadius(el)),
      width: round3(rect.width),
      x: round3(rect.x),
      y: round3(rect.y)
    })
  }

  return regions
}

/**
 * Root attribute the CSS material reads to learn that native glass is really on
 * screen (`on`) or that this run is CSS-only (`off`/absent).
 *
 * This is not telemetry — it is load-bearing. When the native material is live,
 * the natively-glassed plates must DROP their `backdrop-filter`: Chromium can
 * only sample DOM painted inside the window, so behind a floating panel the
 * filter has nothing to blur, yet it still promotes the plate to its own
 * backdrop-root compositing surface, which paints over the NSVisualEffectView
 * sitting behind it. That double material is what turns the panels into flat
 * opaque gray. Native blurs; CSS tints. Never both on the same surface.
 */
export const ATUM_NATIVE_GLASS_ATTRIBUTE = 'data-atum-native-glass'

function markNativeGlass(active: boolean): void {
  document.documentElement.setAttribute(ATUM_NATIVE_GLASS_ATTRIBUTE, active ? 'on' : 'off')
}

interface SyncState {
  frame: number
  lastKey: string
  mutations: MutationObserver
  observed: Set<Element>
  resize: ResizeObserver | null
}

let syncState: SyncState | null = null

/**
 * Start (idempotently) pushing glass geometry to the native bridge.
 *
 * Triggers: element ResizeObserver per surface (fires per frame during the
 * collapse/open and split-drag transitions, so native regions track CSS
 * motion instead of snapping at the end), a MutationObserver for
 * mount/unmount and theme flips, and window resize. Payloads are rAF-coalesced
 * and diffed — an unchanged layout costs zero IPC.
 */
export function ensureAtumVibrancySync(): void {
  if (syncState) {
    return
  }

  const bridge = window.hermesDesktop?.atumVibrancy

  if (!bridge) {
    return
  }

  const schedule = () => {
    if (syncState && !syncState.frame) {
      syncState.frame = requestAnimationFrame(sync)
    }
  }

  const sync = () => {
    const state = syncState

    if (!state) {
      return
    }

    state.frame = 0

    const elements = new Set(document.querySelectorAll(ATUM_GLASS_SELECTOR))

    if (state.resize) {
      for (const el of state.observed) {
        if (!elements.has(el)) {
          state.resize.unobserve(el)
          state.observed.delete(el)
        }
      }

      for (const el of elements) {
        if (!state.observed.has(el)) {
          state.resize.observe(el)
          state.observed.add(el)
        }
      }
    }

    const frame: AtumVibrancyFrame = {
      dark: document.documentElement.classList.contains('dark'),
      regions: collectAtumGlassRegions(document)
    }

    const key = JSON.stringify(frame)

    if (key === state.lastKey) {
      return
    }

    state.lastKey = key
    // A rejected frame (older runtime, mid-teardown window) must never break
    // rendering — it just puts the CSS-only material back in charge, which is
    // the complete Kimi recipe including its own blur.
    void bridge
      .setRegions(frame)
      .then(result => markNativeGlass(result?.ok === true))
      .catch(() => markNativeGlass(false))
  }

  syncState = {
    frame: 0,
    lastKey: '',
    mutations: new MutationObserver(schedule),
    observed: new Set(),
    resize: typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
  }

  // Mount/unmount anywhere (shell ↔ auth gate, drawers, the startup overlay)
  // and light/dark flips on the root element both re-measure.
  syncState.mutations.observe(document.body, { childList: true, subtree: true })
  syncState.mutations.observe(document.documentElement, { attributeFilter: ['class'], attributes: true })
  window.addEventListener('resize', schedule)

  schedule()
}

/** Test seam: stop the singleton and forget the last payload. */
export function stopAtumVibrancySync(): void {
  if (!syncState) {
    return
  }

  if (syncState.frame) {
    cancelAnimationFrame(syncState.frame)
  }

  syncState.mutations.disconnect()
  syncState.resize?.disconnect()
  syncState = null
  document.documentElement.removeAttribute(ATUM_NATIVE_GLASS_ATTRIBUTE)
}
