/**
 * The main-process half of the panel-local glass bridge: renderer geometry is
 * normalized and clamped before any native call, malformed IPC can never reach
 * the addon, the native module is probed lazily with a CSS-fallback path, and
 * window teardown detaches exactly once.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test, vi } from 'vitest'

import {
  ATUM_VIBRANCY_IPC_CHANNEL,
  ATUM_VIBRANCY_MATERIALS,
  type AtumVibrancyBridge,
  type AtumVibrancyWindow,
  createAtumVibrancyController,
  DEFAULT_VIBRANCY_MATERIAL,
  DEFAULT_VIBRANCY_RADIUS,
  loadAtumVibrancyBridge,
  MAX_VIBRANCY_REGIONS,
  normalizeVibrancyRegions,
  registerAtumVibrancyIpc,
  vibrancyBinaryCandidates
} from './atum-vibrancy'

const CONTENT = { height: 800, width: 1200 }

const NATIVE_SOURCE = readFileSync(
  fileURLToPath(new URL('../native/atum-vibrancy/src/atum_vibrancy.mm', import.meta.url)),
  'utf8'
)

function makeWindow(overrides: Partial<AtumVibrancyWindow> = {}): AtumVibrancyWindow {
  return {
    getContentSize: () => [CONTENT.width, CONTENT.height],
    getNativeWindowHandle: () => Buffer.from('window-handle'),
    isDestroyed: () => false,
    ...overrides
  }
}

function makeBridge(overrides: Partial<AtumVibrancyBridge> = {}): AtumVibrancyBridge {
  return {
    attach: vi.fn(() => true),
    detach: vi.fn(),
    setRegions: vi.fn(() => true),
    ...overrides
  }
}

// ─── geometry normalization ─────────────────────────────────────────

test('normalizeVibrancyRegions passes a well-formed frame through rounded and dark-aware', () => {
  const frame = normalizeVibrancyRegions(
    {
      dark: true,
      regions: [
        { height: 40, material: 'thin', radius: 14, width: 1180.1234, x: 10, y: 10 },
        { height: 700, material: 'thick', radius: 14, width: 58, x: 10.0009, y: 60 }
      ]
    },
    CONTENT
  )

  assert.deepEqual(frame, {
    dark: true,
    regions: [
      { height: 40, material: ATUM_VIBRANCY_MATERIALS.thin, radius: 14, width: 1180.123, x: 10, y: 10 },
      { height: 700, material: ATUM_VIBRANCY_MATERIALS.thick, radius: 14, width: 58, x: 10.001, y: 60 }
    ]
  })
})

// ─── material band ──────────────────────────────────────────────────

test('normalizeVibrancyRegions maps each density band to its wire ordinal', () => {
  const frame = normalizeVibrancyRegions(
    {
      regions: [
        { height: 10, material: 'thin', radius: 1, width: 10, x: 0, y: 0 },
        { height: 10, material: 'regular', radius: 1, width: 10, x: 0, y: 0 },
        { height: 10, material: 'thick', radius: 1, width: 10, x: 0, y: 0 }
      ]
    },
    CONTENT
  )

  // Ordinals are thin -> thick and are the contract with AtumMaterialForOrdinal
  // in native/atum-vibrancy/src/atum_vibrancy.mm.
  assert.deepEqual(
    frame?.regions.map(region => region.material),
    [0, 1, 2]
  )
})

test('an unknown, missing, or non-string material falls back to the mid band', () => {
  const frame = normalizeVibrancyRegions(
    {
      regions: [
        { height: 10, radius: 1, width: 10, x: 0, y: 0 }, // older renderer
        { height: 10, material: 'ultrathin', radius: 1, width: 10, x: 0, y: 0 },
        { height: 10, material: 2, radius: 1, width: 10, x: 0, y: 0 },
        // Inherited keys must not resolve to a material.
        { height: 10, material: 'constructor', radius: 1, width: 10, x: 0, y: 0 },
        { height: 10, material: 'toString', radius: 1, width: 10, x: 0, y: 0 }
      ]
    },
    CONTENT
  )

  assert.deepEqual(
    frame?.regions.map(region => region.material),
    Array.from({ length: 5 }, () => DEFAULT_VIBRANCY_MATERIAL)
  )
})

test('normalizeVibrancyRegions clamps offscreen edges and drops fully-outside rects', () => {
  const frame = normalizeVibrancyRegions(
    {
      regions: [
        { height: 100, radius: 14, width: 100, x: -40, y: -20 }, // clamps to origin
        { height: 100, radius: 14, width: 400, x: 1000, y: 700 }, // clamps to 200x100
        { height: 100, radius: 14, width: 50, x: 5000, y: 10 }, // fully outside → dropped
        { height: 100, radius: 14, width: 50, x: 10, y: -500 } // fully outside → dropped
      ]
    },
    CONTENT
  )

  assert.deepEqual(frame?.regions, [
    { height: 80, material: DEFAULT_VIBRANCY_MATERIAL, radius: 14, width: 60, x: 0, y: 0 },
    { height: 100, material: DEFAULT_VIBRANCY_MATERIAL, radius: 14, width: 200, x: 1000, y: 700 }
  ])
})

test('normalizeVibrancyRegions drops degenerate and non-finite entries but keeps siblings', () => {
  const frame = normalizeVibrancyRegions(
    {
      regions: [
        null,
        'nope',
        { height: 0, radius: 14, width: 100, x: 10, y: 10 },
        { height: -5, radius: 14, width: 100, x: 10, y: 10 },
        { height: 100, radius: 14, width: Number.NaN, x: 10, y: 10 },
        { height: 100, radius: 14, width: 100, x: Number.POSITIVE_INFINITY, y: 10 },
        [1, 2, 3],
        { height: 100, radius: 14, width: 100, x: 10, y: 10 }
      ]
    },
    CONTENT
  )

  assert.deepEqual(frame?.regions, [
    { height: 100, material: DEFAULT_VIBRANCY_MATERIAL, radius: 14, width: 100, x: 10, y: 10 }
  ])
})

test('normalizeVibrancyRegions caps the radius at half the smaller edge', () => {
  const frame = normalizeVibrancyRegions({ regions: [{ height: 40, radius: 999, width: 1180, x: 10, y: 10 }] }, CONTENT)

  assert.equal(frame?.regions[0]?.radius, 20)
})

test('normalizeVibrancyRegions falls back to the product radius for a missing or invalid one', () => {
  const missing = normalizeVibrancyRegions({ regions: [{ height: 40, width: 100, x: 10, y: 10 }] }, CONTENT)

  const garbage = normalizeVibrancyRegions(
    { regions: [{ height: 40, radius: 'fourteen', width: 100, x: 10, y: 10 }] },
    CONTENT
  )

  assert.equal(missing?.regions[0]?.radius, DEFAULT_VIBRANCY_RADIUS)
  assert.equal(garbage?.regions[0]?.radius, DEFAULT_VIBRANCY_RADIUS)
})

test('normalizeVibrancyRegions caps the region count instead of rejecting the frame', () => {
  const regions = Array.from({ length: MAX_VIBRANCY_REGIONS + 10 }, (_, i) => ({
    height: 10,
    radius: 1,
    width: 10,
    x: i,
    y: i
  }))

  const frame = normalizeVibrancyRegions({ regions }, CONTENT)

  assert.equal(frame?.regions.length, MAX_VIBRANCY_REGIONS)
})

test('normalizeVibrancyRegions treats a truthy non-boolean dark flag as light', () => {
  const frame = normalizeVibrancyRegions({ dark: 'yes', regions: [] }, CONTENT)

  assert.equal(frame?.dark, false)
})

// ─── malformed IPC ──────────────────────────────────────────────────

test('normalizeVibrancyRegions rejects structurally invalid payloads', () => {
  for (const payload of [null, undefined, 42, 'regions', [], { regions: 'nope' }, { regions: {} }]) {
    assert.equal(normalizeVibrancyRegions(payload, CONTENT), null, JSON.stringify(payload))
  }
})

test('malformed IPC never reaches the native bridge', () => {
  const bridge = makeBridge()

  const controller = createAtumVibrancyController({
    getWindow: makeWindow,
    isMac: true,
    isOwnerSender: () => true,
    loadBridge: () => bridge
  })

  for (const payload of [null, undefined, 42, 'x', {}, { regions: 'bad' }]) {
    assert.deepEqual(controller.handleSetRegions({ sender: {} }, payload), { error: 'invalid-payload', ok: false })
  }

  assert.equal(vi.mocked(bridge.attach).mock.calls.length, 0)
  assert.equal(vi.mocked(bridge.setRegions).mock.calls.length, 0)
})

test('non-mac platforms and non-owner senders are refused before any native work', () => {
  const bridge = makeBridge()
  const win = makeWindow()

  const linux = createAtumVibrancyController({
    getWindow: () => win,
    isMac: false,
    isOwnerSender: () => true,
    loadBridge: () => bridge
  })

  assert.equal(linux.handleSetRegions({ sender: {} }, { regions: [] }).error, 'unsupported-platform')

  const stranger = createAtumVibrancyController({
    getWindow: () => win,
    isMac: true,
    isOwnerSender: () => false,
    loadBridge: () => bridge
  })

  assert.equal(stranger.handleSetRegions({ sender: {} }, { regions: [] }).error, 'not-main-window')

  const destroyed = createAtumVibrancyController({
    getWindow: () => makeWindow({ isDestroyed: () => true }),
    isMac: true,
    isOwnerSender: () => true,
    loadBridge: () => bridge
  })

  assert.equal(destroyed.handleSetRegions({ sender: {} }, { regions: [] }).error, 'not-main-window')

  assert.equal(vi.mocked(bridge.attach).mock.calls.length, 0)
})

// ─── fallback ───────────────────────────────────────────────────────

test('a missing native module degrades to native-unavailable and logs once', () => {
  const log = vi.fn()

  const controller = createAtumVibrancyController({
    getWindow: makeWindow,
    isMac: true,
    isOwnerSender: () => true,
    loadBridge: () => null,
    log
  })

  const payload = { regions: [{ height: 40, radius: 14, width: 100, x: 10, y: 10 }] }
  assert.equal(controller.handleSetRegions({ sender: {} }, payload).error, 'native-unavailable')
  assert.equal(controller.handleSetRegions({ sender: {} }, payload).error, 'native-unavailable')
  assert.equal(log.mock.calls.length, 1)
})

test('loadAtumVibrancyBridge skips missing candidates and broken exports', () => {
  assert.equal(loadAtumVibrancyBridge(['/does/not/exist-a.node', '/does/not/exist-b.node']), null)

  // Existing file that is not a loadable addon must fall through, not throw.
  const packageJson = fileURLToPath(new URL('../package.json', import.meta.url))
  assert.equal(loadAtumVibrancyBridge([packageJson]), null)
})

test('vibrancyBinaryCandidates prefers the staged dist copy, then the in-tree build', () => {
  const candidates = vibrancyBinaryCandidates('/base')

  assert.equal(candidates[0], resolve('/base', 'node_modules/atum-vibrancy/build/Release/atum_vibrancy.node'))
  assert.equal(candidates[1], resolve('/base', '../native/atum-vibrancy/build/Release/atum_vibrancy.node'))
})

test('native shell lens is neutral, low-alpha, panel-masked, and shaped inside the window mask', () => {
  assert.match(NATIVE_SOURCE, /@interface AtumSeamEffectView : NSVisualEffectView/u)
  assert.match(NATIVE_SOURCE, /AtumSeamLensAlpha = 0\.18/u)
  assert.match(NATIVE_SOURCE, /view\.material = NSVisualEffectMaterialMenu/u)
  assert.match(NATIVE_SOURCE, /maskLayer\.fillRule = kCAFillRuleEvenOdd/u)
  assert.match(NATIVE_SOURCE, /CGPathAddRoundedRect\(maskPath, nullptr, localFrame/u)
  assert.match(NATIVE_SOURCE, /\[content addSubview:seamView positioned:NSWindowBelow relativeTo:nil\]/u)
  // There is deliberately no custom colour fill: public AppKit supplies real
  // behind-window diffusion, while CSS remains fully transparent in the gaps.
  assert.doesNotMatch(NATIVE_SOURCE, /seamView\.(?:layer\.)?backgroundColor/u)
})

test('the lens envelope is the content area, with a radius that always curves inside the window mask', () => {
  // The gutter is part of the lens: the envelope is the window's content
  // bounds, not the union of the panels. The union is still computed — it is
  // what the concentric radius is derived from — but it is no longer the shape.
  assert.match(NATIVE_SOURCE, /static BOOL AtumSeamEnvelope\(NSRect content,/u)
  assert.match(NATIVE_SOURCE, /panels = NSUnionRect\(panels, frames\[i\]\.rectValue\)/u)
  assert.match(NATIVE_SOURCE, /\*outEnvelope = content;/u)
  assert.match(NATIVE_SOURCE, /\*outRadius = panelRadius \+ inset;/u)

  // Why a derived radius rather than a window radius: an envelope corner that
  // curves outside the transparent NSWindow mask is clipped into the dark
  // stepped exterior outline this geometry exists to avoid. Offsetting the
  // panel radius by the gutter always lands inside it, so no private window
  // metric is read and no constant can go stale under a new macOS.
  assert.match(NATIVE_SOURCE, /inset = MIN\(MIN\(NSMinX\(panels\) - NSMinX\(content\)/u)
  assert.match(NATIVE_SOURCE, /if \(!isfinite\(inset\) \|\| inset < 0\.0\) \{\s*inset = 0\.0;/u)
  assert.doesNotMatch(NATIVE_SOURCE, /_cornerRadius/u)

  // Both substrates share the one helper, so the blur fallback and Liquid Glass
  // can never disagree about the shape.
  assert.match(NATIVE_SOURCE, /AtumSeamEnvelope\(content\.bounds, frames, radii, &envelope, &envelopeRadius\)/u)
  assert.match(NATIVE_SOURCE, /AtumSeamEnvelope\(content, frames, radii, &envelope, &envelopeRadius\)/u)
})

// ─── Liquid Glass substrate (macOS 26+) ─────────────────────────────
//
// The addon is compiled against the macOS 14.5 SDK, which declares neither
// NSGlassEffectView nor NSGlassEffectContainerView. These assertions are the
// standing contract for that: the classes and every selector must stay behind
// runtime lookup + capability guards, only public-looking API may be used, and
// the pre-26 NSVisualEffectView path must survive untouched.

/** Every runtime-resolved selector name in the addon, in source order. */
const RUNTIME_SELECTORS = [...NATIVE_SOURCE.matchAll(/NSSelectorFromString\(@"([^"]+)"\)/gu)].map(m => m[1]!)

/** Every runtime-resolved class name in the addon. */
const RUNTIME_CLASSES = [...NATIVE_SOURCE.matchAll(/NSClassFromString\(@"([^"]+)"\)/gu)].map(m => m[1]!)

test('Liquid Glass classes are resolved at runtime, never linked against the SDK', () => {
  assert.deepEqual([...new Set(RUNTIME_CLASSES)].sort(), ['NSGlassEffectContainerView', 'NSGlassEffectView'])

  // No SDK-time reference may exist, or the addon stops compiling on 14.5.
  assert.doesNotMatch(NATIVE_SOURCE, /@interface\s+\w+\s*:\s*NSGlassEffect/u)
  assert.doesNotMatch(NATIVE_SOURCE, /\[NSGlassEffect\w*\s+class\]/u)
  assert.doesNotMatch(NATIVE_SOURCE, /#import <AppKit\/NSGlassEffect/u)
})

test('the glass substrate is gated on a memoized capability probe, not a version string', () => {
  assert.match(NATIVE_SOURCE, /static BOOL AtumLiquidGlassAvailable\(void\)/u)
  assert.match(NATIVE_SOURCE, /static BOOL AtumGlassContainerAvailable\(void\)/u)

  // Class identity AND every selector this file drives must be present.
  assert.match(NATIVE_SOURCE, /if \(glass == Nil \|\| !\[glass isSubclassOfClass:\[NSView class\]\]\)/u)
  assert.match(NATIVE_SOURCE, /if \(container == Nil \|\| !\[container isSubclassOfClass:\[NSView class\]\]\)/u)
  assert.equal([...NATIVE_SOURCE.matchAll(/\[[^\]\n]+ instancesRespondToSelector:/gu)].length, 5)

  // Both probes are computed once and cached.
  assert.equal([...NATIVE_SOURCE.matchAll(/dispatch_once\(&once, \^\{/gu)].length, 4)

  // The single dispatch point: glass when available, the original blur otherwise.
  assert.match(
    NATIVE_SOURCE,
    /if \(AtumLiquidGlassAvailable\(\)\) \{\s*AtumReconcileGlass\([\s\S]{0,120}?\} else \{\s*AtumReconcileVibrancy\(/u
  )
})

test('only public-looking selectors are messaged — no private/underscored API', () => {
  assert.deepEqual(
    [...new Set(RUNTIME_SELECTORS)].sort(),
    ['setContentView:', 'setCornerRadius:', 'setSpacing:', 'setStyle:']
  )

  for (const selector of RUNTIME_SELECTORS) {
    assert.equal(selector.startsWith('_'), false, selector)
  }

  // The specific private selectors this material is known to expose.
  assert.doesNotMatch(NATIVE_SOURCE, /_contentLensing|_variant|_groupIdentifier/u)
  // No underscored Objective-C literal of any kind, and no runtime surgery.
  assert.doesNotMatch(NATIVE_SOURCE, /@"_/u)
  assert.doesNotMatch(NATIVE_SOURCE, /objc_allocateClassPair|class_addMethod|method_exchangeImplementations|setValue:forKey:/u)
})

test('every objc_msgSend is explicitly typed and guarded by respondsToSelector', () => {
  // A bare `objc_msgSend(...)` call is undefined behaviour on arm64.
  assert.doesNotMatch(NATIVE_SOURCE, /objc_msgSend\(/u)

  const casts = [...NATIVE_SOURCE.matchAll(/reinterpret_cast<void \(\*\)\(id, SEL, [^)]+\)>\(objc_msgSend\)/gu)]
  assert.equal(casts.length, 3)

  // Each helper refuses to send unless the receiver really implements it.
  assert.equal([...NATIVE_SOURCE.matchAll(/!\[target respondsToSelector:selector\]/gu)].length, 3)

  // All three signatures return void, so no unmanaged +1 result ever crosses
  // the ARC boundary.
  assert.doesNotMatch(NATIVE_SOURCE, /reinterpret_cast<id \(\*\)/u)
})

test('glass surfaces never adopt Chromium content and stay hit-test transparent', () => {
  // setContentView: is sent exactly twice, both times to a view this file owns.
  assert.match(NATIVE_SOURCE, /AtumSendObject\(glass, AtumSetContentViewSelector\(\), filler\)/u)
  assert.match(NATIVE_SOURCE, /AtumSendObject\(container, AtumSetContentViewSelector\(\), stage\)/u)
  assert.equal([...NATIVE_SOURCE.matchAll(/AtumSendObject\([^,]+, AtumSetContentViewSelector\(\)/gu)].length, 2)

  // The window's own contentView is only ever read/parented into, never handed
  // to a glass view.
  assert.doesNotMatch(NATIVE_SOURCE, /AtumSetContentViewSelector\(\), content\)/u)

  // The substrate root is bottom-most and stops hit testing for its whole
  // subtree, which is how the un-subclassable glass views stay non-interactive.
  assert.match(NATIVE_SOURCE, /\[content addSubview:root positioned:NSWindowBelow relativeTo:nil\]/u)
  assert.equal([...NATIVE_SOURCE.matchAll(/- \(NSView \*\)hitTest:\(NSPoint\)point \{\s*return nil;/gu)].length, 6)
})

test('the glass container coordinates adjacent surfaces without fusing them', () => {
  assert.match(NATIVE_SOURCE, /AtumGlassContainerSpacing = 0\.0/u)
  assert.match(NATIVE_SOURCE, /AtumSendCGFloat\(container, AtumSetSpacingSelector\(\), AtumGlassContainerSpacing\)/u)
  // The container is optional; a failed adoption must not strand the stage.
  assert.match(NATIVE_SOURCE, /if \(stage\.superview == nil\) \{\s*\[container removeFromSuperview\];/u)
  assert.match(NATIVE_SOURCE, /if \(root\.glassContainer == nil\) \{\s*\[root addSubview:stage\];/u)
})

test('glass seam keeps the even-odd subtraction and never paints an unmasked canvas', () => {
  // Shared geometry: one helper feeds both substrates, so the lens envelope and
  // the panel subtraction can never drift apart.
  assert.match(NATIVE_SOURCE, /static BOOL AtumSeamEnvelope\(/u)
  assert.match(NATIVE_SOURCE, /static void AtumApplySeamMask\(/u)
  assert.match(NATIVE_SOURCE, /AtumApplySeamMask\(seamHost, envelope, envelopeRadius, frames, radii\)/u)
  assert.match(NATIVE_SOURCE, /AtumApplySeamMask\(view, envelope, envelopeRadius, frames, radii\)/u)

  // The envelope now spans the content area, so the even-odd subtraction is the
  // only thing keeping glass from stacking under a panel. Both hosts must stay
  // masked — an unmasked content-sized lens is the flat grey slab this material
  // system was built to avoid.
  assert.doesNotMatch(NATIVE_SOURCE, /seamHost\.layer\.mask = nil/u)
  assert.doesNotMatch(NATIVE_SOURCE, /view\.layer\.mask = nil/u)

  // Auth/startup (one full plate) leave an empty mask, and an empty frame set
  // strips the host outright: no state leaves a bare lens behind the content.
  assert.match(
    NATIVE_SOURCE,
    /if \(frames\.count == 0\) \{\s*\[AtumFindGlassRoot\(content\) removeFromSuperview\];\s*return;/u
  )

  // The seam is neutral clear glass at full strength; the 0.18 damping belongs
  // to the blur fallback only.
  assert.match(NATIVE_SOURCE, /AtumSeamGlassAlpha = 1\.0/u)
  assert.match(NATIVE_SOURCE, /AtumSendInteger\(seamGlass, AtumSetStyleSelector\(\), AtumGlassStyleClear\)/u)
  assert.match(NATIVE_SOURCE, /\[stage addSubview:seamHost positioned:NSWindowBelow relativeTo:nil\]/u)
})

test('the native layer supplies optics only — no tint, wash, or captured desktop', () => {
  // tintColor exists on NSGlassEffectView and is deliberately never sent: the
  // approved Kimi tint/ambient/opacity values stay in CSS.
  assert.doesNotMatch(NATIVE_SOURCE, /tintColor/iu)
  assert.doesNotMatch(NATIVE_SOURCE, /\.backgroundColor/u)
  assert.doesNotMatch(
    NATIVE_SOURCE,
    /ScreenCaptureKit|SCStream|SCShareableContent|CGDisplayStream|CGWindowListCreateImage|CIFilter/u
  )
})

test('the pre-26 NSVisualEffectView fallback is preserved intact', () => {
  assert.match(NATIVE_SOURCE, /@interface AtumGlassEffectView : NSVisualEffectView/u)
  assert.match(NATIVE_SOURCE, /static void AtumReconcileVibrancy\(/u)
  assert.match(NATIVE_SOURCE, /view\.blendingMode = NSVisualEffectBlendingModeBehindWindow/u)
  assert.match(NATIVE_SOURCE, /case 0:[\s\S]{0,120}?return NSVisualEffectMaterialMenu;/u)
  assert.match(NATIVE_SOURCE, /case 2:[\s\S]{0,160}?return NSVisualEffectMaterialPopover;/u)
  assert.match(NATIVE_SOURCE, /default:[\s\S]{0,120}?return NSVisualEffectMaterialSidebar;/u)
  // The fallback path must not consult the glass runtime at all.
  assert.doesNotMatch(
    NATIVE_SOURCE.slice(
      NATIVE_SOURCE.indexOf('static void AtumReconcileVibrancy('),
      NATIVE_SOURCE.indexOf('static napi_value AtumAttach')
    ),
    /AtumLiquidGlassAvailable|AtumGlassEffectClass/u
  )
})

test('detach tears down both substrates and leaves no orphan host', () => {
  const detach = NATIVE_SOURCE.slice(
    NATIVE_SOURCE.indexOf('static napi_value AtumDetach'),
    NATIVE_SOURCE.indexOf('static napi_value AtumInit')
  )

  for (const cls of ['AtumGlassRootView', 'AtumGlassEffectView', 'AtumSeamEffectView']) {
    assert.match(detach, new RegExp(`isKindOfClass:\\[${cls} class\\]`, 'u'), cls)
  }

  assert.match(detach, /\[subview removeFromSuperview\]/u)
  // Ownership stays in the window's own view tree: no file-scope view cache
  // can resurrect a deallocated view.
  assert.doesNotMatch(NATIVE_SOURCE, /^static\s+(?:NSView|AtumGlass\w+)\s*\*\s*\w+\s*=/mu)
})

// ─── lifecycle ──────────────────────────────────────────────────────

test('the controller attaches once per window handle and forwards normalized regions', () => {
  const bridge = makeBridge()
  const win = makeWindow()

  const controller = createAtumVibrancyController({
    getWindow: () => win,
    isMac: true,
    isOwnerSender: () => true,
    loadBridge: () => bridge
  })

  const payload = { dark: true, regions: [{ height: 40, material: 'thin', radius: 14, width: 1180, x: 10, y: 10 }] }
  assert.deepEqual(controller.handleSetRegions({ sender: {} }, payload), { ok: true, regions: 1 })
  assert.deepEqual(controller.handleSetRegions({ sender: {} }, payload), { ok: true, regions: 1 })

  assert.equal(vi.mocked(bridge.attach).mock.calls.length, 1)
  assert.equal(vi.mocked(bridge.setRegions).mock.calls.length, 2)

  const [handle, regions, dark] = vi.mocked(bridge.setRegions).mock.calls[0]!
  assert.equal(handle.toString(), 'window-handle')
  assert.deepEqual(regions, [
    { height: 40, material: ATUM_VIBRANCY_MATERIALS.thin, radius: 14, width: 1180, x: 10, y: 10 }
  ])
  assert.equal(dark, true)
})

test('a new window handle re-attaches instead of writing into the old window', () => {
  const bridge = makeBridge()
  let handle = Buffer.from('window-a')

  const controller = createAtumVibrancyController({
    getWindow: () => makeWindow({ getNativeWindowHandle: () => handle }),
    isMac: true,
    isOwnerSender: () => true,
    loadBridge: () => bridge
  })

  const payload = { regions: [] }
  controller.handleSetRegions({ sender: {} }, payload)
  handle = Buffer.from('window-b')
  controller.handleSetRegions({ sender: {} }, payload)

  assert.equal(vi.mocked(bridge.attach).mock.calls.length, 2)
})

test('detach forwards to native exactly once and resets the attachment', () => {
  const bridge = makeBridge()

  const controller = createAtumVibrancyController({
    getWindow: makeWindow,
    isMac: true,
    isOwnerSender: () => true,
    loadBridge: () => bridge
  })

  controller.handleSetRegions({ sender: {} }, { regions: [] })
  controller.detach()
  controller.detach() // idempotent: a second close path must not double-call

  assert.equal(vi.mocked(bridge.detach).mock.calls.length, 1)
  assert.equal(vi.mocked(bridge.detach).mock.calls[0]?.[0].toString(), 'window-handle')

  // After teardown the next frame re-attaches (window recreated from the dock).
  controller.handleSetRegions({ sender: {} }, { regions: [] })
  assert.equal(vi.mocked(bridge.attach).mock.calls.length, 2)
})

test('detach without a prior attach is a safe no-op', () => {
  const bridge = makeBridge()

  const controller = createAtumVibrancyController({
    getWindow: makeWindow,
    isMac: true,
    isOwnerSender: () => true,
    loadBridge: () => bridge
  })

  controller.detach()
  assert.equal(vi.mocked(bridge.detach).mock.calls.length, 0)
})

test('a throwing native call surfaces as native-error and never escapes the IPC handler', () => {
  const bridge = makeBridge({ setRegions: vi.fn(() => { throw new Error('boom') }) })
  const log = vi.fn()

  const controller = createAtumVibrancyController({
    getWindow: makeWindow,
    isMac: true,
    isOwnerSender: () => true,
    loadBridge: () => bridge,
    log
  })

  assert.equal(controller.handleSetRegions({ sender: {} }, { regions: [] }).error, 'native-error')
  assert.equal(log.mock.calls.length, 1)
})

test('registerAtumVibrancyIpc wires the channel and unregisters cleanly', () => {
  const handlers = new Map<string, (...args: any[]) => unknown>()

  const ipc = {
    handle(channel: string, listener: (...args: any[]) => unknown) {
      handlers.set(channel, listener)
    },
    removeHandler(channel: string) {
      handlers.delete(channel)
    }
  }

  const controller = createAtumVibrancyController({
    getWindow: makeWindow,
    isMac: true,
    isOwnerSender: () => true,
    loadBridge: () => makeBridge()
  })

  const unregister = registerAtumVibrancyIpc(ipc, controller)

  assert.deepEqual([...handlers.keys()], [ATUM_VIBRANCY_IPC_CHANNEL])
  assert.deepEqual(handlers.get(ATUM_VIBRANCY_IPC_CHANNEL)!({ sender: {} }, { regions: [] }), { ok: true, regions: 0 })

  unregister()
  assert.equal(handlers.size, 0)
})
