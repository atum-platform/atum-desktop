// atum_vibrancy.mm — panel-local behind-window material for the Atum
// floating-glass surfaces.
//
// Why this exists: Chromium's backdrop-filter can only blur DOM content painted
// inside the window. It cannot sample pixels owned by other applications, so a
// transparent BrowserWindow ships tint-only "glass" where text behind the app
// stays sharply readable. These native views sit BEHIND the web content inside
// the transparent window — one per top-level frosted surface (rim, rail,
// roster, chat, workspace, auth, startup) — so the window server supplies the
// optical substrate. A separate, panel-subtracted view is masked into
// EVERYTHING THE PANELS DO NOT COVER — the outer gutter and the inter-panel
// seams — so the shell reads as plates floating on glass instead of plates
// floating on holes, without painting a tint canvas or stacking another
// material over the calibrated panel surfaces.
//
// TWO SUBSTRATES, ONE GEOMETRY CONTRACT
//
//   1. macOS 26+ (Liquid Glass). `NSGlassEffectView` is Apple's real
//      refracting/lensing material: it bends and re-samples what is behind the
//      window instead of only diffusing it. Every top-level surface and the
//      seam treatment use it. When `NSGlassEffectContainerView` is also
//      present, all of those glass views are hosted inside one container so
//      AppKit coordinates adjacent surfaces in a single rendering pass; its
//      spacing is pinned to 0 so neighbouring panels never fuse across the
//      10px seam and erase the seam treatment.
//
//   2. Everything older. The original `NSVisualEffectView` behaviour is
//      preserved: menu/sidebar/popover density bands per panel
//      plus one low-alpha, even-odd masked seam lens.
//
// SDK / RUNTIME STRATEGY
//
// The addon is built against the macOS 14.5 SDK, which has no declarations for
// the Liquid Glass classes. Everything about them is therefore resolved at
// runtime: `NSClassFromString` for the classes, `NSSelectorFromString` +
// `instancesRespondToSelector:`/`respondsToSelector:` for every selector, and
// explicitly-typed `objc_msgSend` casts for the calls. Only public-looking
// API is used (style, cornerRadius, contentView, spacing); no underscored or
// otherwise private selector is referenced. The material comes entirely from
// the window server: nothing here captures the screen, requests a
// screen-recording permission, or runs a custom desktop-sampling shader.
//
// The addon keeps no Objective-C-side global state beyond memoized capability
// probes: the views are tagged members of the window's own view hierarchy, so
// window teardown destroys them automatically and a stale handle can never
// resurrect a deallocated view.
//
// N-API surface:
//   attach(handle)                       -> boolean  (validate the window)
//   setRegions(handle, regions, dark)    -> boolean  (reconcile glass views)
//   detach(handle)                       -> undefined (remove every glass view)
//
// `handle` is Electron's win.getNativeWindowHandle() buffer (an NSView* on macOS).
// `regions` are top-left-origin points relative to the window's content area:
// [{ x, y, width, height, radius, material }]. Geometry and the material
// ordinal are validated/clamped on the JS side; this layer re-checks the
// invariants it depends on.

#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/message.h>
#import <objc/runtime.h>

#include <node_api.h>

// ─── view classes we own ────────────────────────────────────────────
//
// The Liquid Glass classes cannot be subclassed at compile time (no SDK
// declarations), so hit-test transparency is enforced one level up: AppKit
// walks `hitTest:` from the top of a subtree downwards, and a nil result stops
// the walk before any descendant is consulted. `AtumGlassRootView` therefore
// makes the ENTIRE native substrate non-interactive, including every
// runtime-instantiated glass view inside it.

@interface AtumGlassRootView : NSView
/** `NSGlassEffectContainerView` when available, otherwise nil. */
@property (nonatomic, strong) NSView *glassContainer;
/** Where the individual glass surfaces live (the container's contentView when
 *  there is a container, otherwise a direct child of the root). */
@property (nonatomic, strong) NSView *stage;
@end

@interface AtumGlassStageView : NSView
@end

/** Wrapper that carries the even-odd seam mask on its own layer, so the mask
 *  is applied to a view we fully control rather than to a system effect view's
 *  internal layer tree. */
@interface AtumSeamGlassHostView : NSView
@end

/** Empty, transparent contentView for a glass surface. Apple's glass views are
 *  content hosts; giving each one an explicit empty child keeps the layout
 *  defined without ever taking ownership of Chromium's view. */
@interface AtumGlassFillerView : NSView
@end

/** Legacy (pre-26) per-panel behind-window blur. */
@interface AtumGlassEffectView : NSVisualEffectView
@end

/** Legacy (pre-26) seam lens. */
@interface AtumSeamEffectView : NSVisualEffectView
@end

@implementation AtumGlassRootView
// Glass is a visual layer only — it must never intercept input meant for the
// Chromium content above it. Returning nil here also covers every descendant.
- (NSView *)hitTest:(NSPoint)point {
  return nil;
}
@end

@implementation AtumGlassStageView
- (NSView *)hitTest:(NSPoint)point {
  return nil;
}
@end

@implementation AtumSeamGlassHostView
- (NSView *)hitTest:(NSPoint)point {
  return nil;
}
@end

@implementation AtumGlassFillerView
- (NSView *)hitTest:(NSPoint)point {
  return nil;
}
@end

@implementation AtumGlassEffectView
- (NSView *)hitTest:(NSPoint)point {
  return nil;
}
@end

@implementation AtumSeamEffectView
- (NSView *)hitTest:(NSPoint)point {
  return nil;
}
@end

// ─── tuning constants ───────────────────────────────────────────────

// Pre-26 fallback only. Public AppKit before Liquid Glass has no geometric
// refraction control, so the seam is a truthful, neutral approximation: real
// behind-window diffusion from the window server, blended lightly enough that
// the desktop remains recognizable. There is no CSS or native colour fill.
static const CGFloat AtumSeamLensAlpha = 0.18;

// macOS 26+ seam. Real Liquid Glass in its clear style is already a
// near-transparent lens, so it runs at full strength; damping it the way the
// blur fallback is damped would erase the refraction entirely.
static const CGFloat AtumSeamGlassAlpha = 1.0;

// Zero spacing keeps NSGlassEffectContainerView in coordination mode: adjacent
// surfaces render in one pass, but they never merge across the 10px seam. Any
// positive value would fuse the panels into a single blob and delete the seam
// treatment this file exists to draw.
static const CGFloat AtumGlassContainerSpacing = 0.0;

/** Default product radius (`--atum-r-surface`) when a region omits one. */
static const CGFloat AtumDefaultSurfaceRadius = 14.0;

// `NSGlassEffectView.Style` is a two-member enum: the default `regular` and the
// minimally-tinted `clear`. Only these two ordinals are ever sent, so an
// ordering surprise can still only select a real member of the enum.
static const NSInteger AtumGlassStyleRegular = 0;
static const NSInteger AtumGlassStyleClear = 1;

// ─── runtime capability probes ──────────────────────────────────────

static Class AtumGlassEffectClass(void) {
  static Class cls = Nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    cls = NSClassFromString(@"NSGlassEffectView");
  });
  return cls;
}

static Class AtumGlassContainerClass(void) {
  static Class cls = Nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    cls = NSClassFromString(@"NSGlassEffectContainerView");
  });
  return cls;
}

static SEL AtumSetStyleSelector(void) { return NSSelectorFromString(@"setStyle:"); }
static SEL AtumSetCornerRadiusSelector(void) { return NSSelectorFromString(@"setCornerRadius:"); }
static SEL AtumSetContentViewSelector(void) { return NSSelectorFromString(@"setContentView:"); }
static SEL AtumSetSpacingSelector(void) { return NSSelectorFromString(@"setSpacing:"); }

/**
 * True only when the real Liquid Glass material is present AND exposes every
 * public-looking selector this file drives. A partial match falls back rather
 * than half-configuring an unknown view.
 */
static BOOL AtumLiquidGlassAvailable(void) {
  static BOOL available = NO;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    Class glass = AtumGlassEffectClass();
    if (glass == Nil || ![glass isSubclassOfClass:[NSView class]]) {
      return;
    }
    available = [glass instancesRespondToSelector:AtumSetStyleSelector()] &&
                [glass instancesRespondToSelector:AtumSetCornerRadiusSelector()] &&
                [glass instancesRespondToSelector:AtumSetContentViewSelector()];
  });
  return available;
}

/** The container is optional: it improves coordination of adjacent glass, but
 *  panel-local glass is complete without it. */
static BOOL AtumGlassContainerAvailable(void) {
  static BOOL available = NO;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    Class container = AtumGlassContainerClass();
    if (container == Nil || ![container isSubclassOfClass:[NSView class]]) {
      return;
    }
    available = [container instancesRespondToSelector:AtumSetContentViewSelector()] &&
                [container instancesRespondToSelector:AtumSetSpacingSelector()];
  });
  return available;
}

// ─── typed runtime messaging ────────────────────────────────────────
//
// Every call goes through one of these three helpers. Each casts objc_msgSend
// to the exact function-pointer signature of the selector it sends (an
// uncast/variadic objc_msgSend is undefined behaviour on arm64) and refuses to
// send at all unless the receiver actually responds. All three selectors are
// void-returning setters, so there is no unmanaged +1 return to reason about
// and ARC ownership stays trivial.

static void AtumSendCGFloat(id target, SEL selector, CGFloat value) {
  if (target == nil || selector == nullptr || ![target respondsToSelector:selector]) {
    return;
  }
  reinterpret_cast<void (*)(id, SEL, CGFloat)>(objc_msgSend)(target, selector, value);
}

static void AtumSendInteger(id target, SEL selector, NSInteger value) {
  if (target == nil || selector == nullptr || ![target respondsToSelector:selector]) {
    return;
  }
  reinterpret_cast<void (*)(id, SEL, NSInteger)>(objc_msgSend)(target, selector, value);
}

static void AtumSendObject(id target, SEL selector, id value) {
  if (target == nil || selector == nullptr || ![target respondsToSelector:selector]) {
    return;
  }
  reinterpret_cast<void (*)(id, SEL, id)>(objc_msgSend)(target, selector, value);
}

// ─── N-API helpers ──────────────────────────────────────────────────

static NSWindow *AtumWindowFromHandle(napi_env env, napi_value handle) {
  bool isBuffer = false;
  if (napi_is_buffer(env, handle, &isBuffer) != napi_ok || !isBuffer) {
    return nil;
  }
  void *data = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(env, handle, &data, &length) != napi_ok || length < sizeof(void *)) {
    return nil;
  }
  // Electron's getNativeWindowHandle() on macOS carries the window's NSView*,
  // not an NSWindow*. Read it as a non-retained pointer and then obtain the
  // owning window through an explicit __strong ARC reference so the view
  // hierarchy stays alive while we touch it.
  NSView *view = *reinterpret_cast<NSView * __unsafe_unretained *>(data);
  if (view == nil || ![view isKindOfClass:[NSView class]]) {
    return nil;
  }
  __strong NSWindow *window = [view window];
  if (window == nil || ![window isKindOfClass:[NSWindow class]] || window.contentView == nil) {
    return nil;
  }
  return window;
}

static bool AtumReadDoubleProperty(napi_env env, napi_value object, const char *name, double *out) {
  napi_value value = nullptr;
  if (napi_get_named_property(env, object, name, &value) != napi_ok || value == nullptr) {
    return false;
  }
  return napi_get_value_double(env, value, out) == napi_ok;
}

// ─── shared material vocabulary ─────────────────────────────────────

// Density bands, thin -> thick. These ordinals are the wire contract with
// electron/atum-vibrancy.ts (ATUM_VIBRANCY_MATERIALS); keep them in step.
//
// Why not one material for everything: `NSVisualEffectMaterialUnderWindowBackground`
// is AppKit's densest, most desaturated recipe — it exists to sit under an
// OPAQUE window background. On a transparent window it paints a near-solid
// neutral sheet, which is why every Atum panel rendered as the same flat gray
// and none of the backdrop's warm/ambient colour reached the tint above it.
// The three materials below are the translucent, colour-transmitting family
// (menu / sidebar / popover), and they reproduce the Kimi artifact's opacity
// hierarchy in the native layer: rail+rim thinnest, roster/workspace mid,
// transcript most present.
static NSVisualEffectMaterial AtumMaterialForOrdinal(int ordinal) {
  switch (ordinal) {
    case 0:
      // Thin: the lid and the rail. Most desktop showing through.
      return NSVisualEffectMaterialMenu;
    case 2:
      // Thick: long-form reading surfaces and full-plate overlays, where
      // legibility outranks transmission.
      return NSVisualEffectMaterialPopover;
    default:
      // Regular: navigation-weight panels.
      return NSVisualEffectMaterialSidebar;
  }
}

// Liquid Glass exposes two styles rather than a density ramp, so the thinnest
// band maps to `clear` and the navigation/reading bands to `regular`. The rest
// of the approved hierarchy is unchanged because it has always lived in the
// CSS tint/ambient/opacity values painted above this substrate — the native
// layer supplies the optical substrate only, never a colour wash.
static NSInteger AtumGlassStyleForOrdinal(int ordinal) {
  return ordinal == 0 ? AtumGlassStyleClear : AtumGlassStyleRegular;
}

static NSAppearance *AtumAppearance(BOOL dark) {
  // Pin the material to the app's own theme, not the system appearance, so a
  // renderer light/dark flip and the glass never disagree.
  return [NSAppearance appearanceNamed:dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
}

// ─── seam geometry (shared by both substrates) ──────────────────────

/**
 * The envelope is the window's whole content area, so the outer gutter carries
 * the same lens as the inter-panel seams and the panels float on glass rather
 * than on a hole.
 *
 * The gutter used to be left raw for one specific reason: a square-cornered
 * envelope meeting the transparent NSWindow mask rasterizes as a dark stepped
 * exterior outline. That is a corner-radius problem, not an argument for an
 * empty margin, so the radius is derived rather than guessed. The panels are
 * inset from the content edge by the shell's own gutter, so offsetting the
 * panel radius outward by that same inset produces the concentric curve the
 * gutter would have if it were drawn as a rounded frame around them.
 *
 * That value is strictly greater than any window corner radius AppKit
 * currently uses, which is the property that matters. An envelope corner that
 * curves *inside* the window mask leaves a hairline of the corner untreated;
 * one that curves outside gets clipped into the stepped contour. Erring inward
 * is invisible, erring outward is the artifact — so the derivation is chosen to
 * always err inward, and no window radius is read or assumed.
 *
 * `content` is the window's content bounds. When the panels reach the content
 * edge (auth and startup are one full plate) the inset is zero, the radius
 * falls back to the panel radius, and the even-odd mask comes out empty —
 * exactly as before.
 */
static BOOL AtumSeamEnvelope(NSRect content,
                             NSArray<NSValue *> *frames,
                             NSArray<NSNumber *> *radii,
                             NSRect *outEnvelope,
                             CGFloat *outRadius) {
  if (frames.count == 0) {
    return NO;
  }

  NSRect panels = frames[0].rectValue;
  CGFloat panelRadius = radii.count > 0 ? radii[0].doubleValue : AtumDefaultSurfaceRadius;
  for (NSUInteger i = 1; i < frames.count; i++) {
    panels = NSUnionRect(panels, frames[i].rectValue);
    if (i < radii.count) {
      panelRadius = MAX(panelRadius, radii[i].doubleValue);
    }
  }

  // The smallest of the four margins. A panel that overhangs an edge (a drawer
  // mid-animation) yields a negative gap, which clamps to zero rather than
  // pulling the envelope radius below the panel radius.
  CGFloat inset = MIN(MIN(NSMinX(panels) - NSMinX(content), NSMaxX(content) - NSMaxX(panels)),
                      MIN(NSMinY(panels) - NSMinY(content), NSMaxY(content) - NSMaxY(panels)));
  if (!isfinite(inset) || inset < 0.0) {
    inset = 0.0;
  }

  *outEnvelope = content;
  *outRadius = panelRadius + inset;
  return YES;
}

/**
 * Even-odd mask: one rounded outer envelope minus every rounded panel. The only
 * pixels left are the outer gutter and the narrow gaps BETWEEN surfaces. Panel
 * tint/opacity remains exactly the Kimi recipe, and auth/startup (one full
 * plate) still produce an empty mask rather than a lens stacked under a plate.
 */
static void AtumApplySeamMask(NSView *view,
                              NSRect envelope,
                              CGFloat envelopeRadius,
                              NSArray<NSValue *> *frames,
                              NSArray<NSNumber *> *radii) {
  CGMutablePathRef maskPath = CGPathCreateMutable();
  CGRect localEnvelope = CGRectMake(0, 0, envelope.size.width, envelope.size.height);
  CGPathAddRoundedRect(maskPath, nullptr, localEnvelope, envelopeRadius, envelopeRadius);

  for (NSUInteger i = 0; i < frames.count; i++) {
    NSRect frame = frames[i].rectValue;
    CGFloat radius = i < radii.count ? radii[i].doubleValue : AtumDefaultSurfaceRadius;
    CGRect localFrame = CGRectMake(
      frame.origin.x - envelope.origin.x,
      frame.origin.y - envelope.origin.y,
      frame.size.width,
      frame.size.height
    );
    CGPathAddRoundedRect(maskPath, nullptr, localFrame, radius, radius);
  }

  CAShapeLayer *maskLayer = [CAShapeLayer layer];
  maskLayer.frame = view.bounds;
  maskLayer.fillColor = NSColor.whiteColor.CGColor;
  maskLayer.fillRule = kCAFillRuleEvenOdd;
  maskLayer.path = maskPath;
  view.layer.mask = maskLayer;
  CGPathRelease(maskPath);
}

// ─── macOS 26+ : Liquid Glass substrate ─────────────────────────────

/** Instantiate one `NSGlassEffectView` with an empty, transparent content
 *  host. Returns nil if the runtime class refuses to initialize. */
static NSView *AtumCreateGlassSurface(void) {
  Class glassClass = AtumGlassEffectClass();
  if (glassClass == Nil) {
    return nil;
  }

  // The cast is only to disambiguate `initWithFrame:` for the compiler (the
  // class has no SDK declaration); the runtime class is still what allocates,
  // and the isKindOfClass: check below is what actually validates it.
  NSView *glass = [(NSView *)[glassClass alloc] initWithFrame:NSZeroRect];
  if (glass == nil || ![glass isKindOfClass:[NSView class]]) {
    return nil;
  }

  AtumGlassFillerView *filler = [[AtumGlassFillerView alloc] initWithFrame:NSZeroRect];
  filler.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  AtumSendObject(glass, AtumSetContentViewSelector(), filler);

  return glass;
}

static void AtumConfigureGlassSurface(NSView *glass, NSRect frame, CGFloat radius, int material, BOOL dark) {
  glass.frame = frame;
  AtumSendCGFloat(glass, AtumSetCornerRadiusSelector(), radius);
  AtumSendInteger(glass, AtumSetStyleSelector(), AtumGlassStyleForOrdinal(material));
  glass.appearance = AtumAppearance(dark);
  // No native tint is ever applied. Liquid Glass supplies the optical
  // substrate; CSS keeps sole ownership of the approved Kimi
  // tint/ambient/opacity values painted above it.
}

static AtumGlassRootView *AtumFindGlassRoot(NSView *content) {
  for (NSView *subview in content.subviews) {
    if ([subview isKindOfClass:[AtumGlassRootView class]]) {
      return (AtumGlassRootView *)subview;
    }
  }
  return nil;
}

/**
 * Build (once per window) the substrate host:
 *
 *   content
 *   └─ AtumGlassRootView            hit-test transparent, bottom-most
 *      └─ [NSGlassEffectContainerView]        optional, spacing 0
 *         └─ AtumGlassStageView               the container's contentView
 *            ├─ AtumSeamGlassHostView         even-odd masked seam glass
 *            └─ NSGlassEffectView × N         one per top-level surface
 *
 * Without the container the stage is a direct child of the root; nothing else
 * changes. Chromium's own content view is never reparented or adopted.
 */
static AtumGlassRootView *AtumEnsureGlassRoot(NSView *content) {
  AtumGlassRootView *root = AtumFindGlassRoot(content);
  if (root != nil) {
    return root;
  }

  root = [[AtumGlassRootView alloc] initWithFrame:content.bounds];
  root.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;

  AtumGlassStageView *stage = [[AtumGlassStageView alloc] initWithFrame:root.bounds];
  stage.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;

  if (AtumGlassContainerAvailable()) {
    Class containerClass = AtumGlassContainerClass();
    NSView *container = [(NSView *)[containerClass alloc] initWithFrame:root.bounds];
    if (container != nil && [container isKindOfClass:[NSView class]]) {
      container.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
      AtumSendCGFloat(container, AtumSetSpacingSelector(), AtumGlassContainerSpacing);
      AtumSendObject(container, AtumSetContentViewSelector(), stage);
      [root addSubview:container];

      // Ownership check, not decoration: if setting contentView did not adopt
      // the stage into the container's own hierarchy, the container is not
      // usable here. Drop it and host the stage directly rather than shipping
      // an unparented stage and losing all glass.
      if (stage.superview == nil) {
        [container removeFromSuperview];
      } else {
        root.glassContainer = container;
      }
    }
  }

  if (root.glassContainer == nil) {
    [root addSubview:stage];
  }

  root.stage = stage;
  // The whole substrate is the bottom-most native layer; all Chromium content
  // remains above it.
  [content addSubview:root positioned:NSWindowBelow relativeTo:nil];

  return root;
}

static void AtumReconcileGlass(NSView *content,
                               NSArray<NSValue *> *frames,
                               NSArray<NSNumber *> *radii,
                               NSArray<NSNumber *> *materials,
                               BOOL dark) {
  // An empty region set (collapse, shell swap, `legacy-solid` recovery) strips
  // the entire substrate rather than leaving an orphaned window-sized host.
  if (frames.count == 0) {
    [AtumFindGlassRoot(content) removeFromSuperview];
    return;
  }

  AtumGlassRootView *root = AtumEnsureGlassRoot(content);
  NSView *stage = root.stage;
  if (stage == nil) {
    return;
  }

  root.appearance = AtumAppearance(dark);

  AtumSeamGlassHostView *seamHost = nil;
  NSMutableArray<NSView *> *existing = [NSMutableArray array];
  for (NSView *subview in [NSArray arrayWithArray:stage.subviews]) {
    if ([subview isKindOfClass:[AtumSeamGlassHostView class]]) {
      seamHost = (AtumSeamGlassHostView *)subview;
    } else {
      [existing addObject:subview];
    }
  }

  NSRect envelope = NSZeroRect;
  CGFloat envelopeRadius = AtumDefaultSurfaceRadius;
  AtumSeamEnvelope(content.bounds, frames, radii, &envelope, &envelopeRadius);

  if (seamHost == nil) {
    seamHost = [[AtumSeamGlassHostView alloc] initWithFrame:envelope];
    NSView *seamGlass = AtumCreateGlassSurface();
    if (seamGlass != nil) {
      seamGlass.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
      [seamHost addSubview:seamGlass];
    }
    // The seam lens is the bottom-most glass surface; panel glass sits above
    // it, and the even-odd mask keeps the two from ever covering one pixel
    // twice.
    [stage addSubview:seamHost positioned:NSWindowBelow relativeTo:nil];
  }

  seamHost.frame = envelope;
  seamHost.wantsLayer = YES;
  seamHost.alphaValue = AtumSeamGlassAlpha;
  seamHost.appearance = AtumAppearance(dark);
  for (NSView *seamGlass in seamHost.subviews) {
    seamGlass.frame = seamHost.bounds;
    AtumSendCGFloat(seamGlass, AtumSetCornerRadiusSelector(), envelopeRadius);
    // Neutral, minimally-tinted refraction: the gaps keep the real background,
    // seen through a lens, in both themes.
    AtumSendInteger(seamGlass, AtumSetStyleSelector(), AtumGlassStyleClear);
    seamGlass.appearance = AtumAppearance(dark);
  }
  AtumApplySeamMask(seamHost, envelope, envelopeRadius, frames, radii);

  // Reconcile by position: reuse views in order, create the missing, remove
  // the surplus.
  NSUInteger index = 0;
  for (NSUInteger i = 0; i < frames.count; i++) {
    NSRect frame = frames[i].rectValue;
    CGFloat radius = i < radii.count ? radii[i].doubleValue : AtumDefaultSurfaceRadius;
    int material = i < materials.count ? materials[i].intValue : 1;

    NSView *glass = nil;
    if (index < existing.count) {
      glass = existing[index];
    } else {
      glass = AtumCreateGlassSurface();
      if (glass == nil) {
        continue;
      }
      [stage addSubview:glass positioned:NSWindowAbove relativeTo:seamHost];
    }

    AtumConfigureGlassSurface(glass, frame, radius, material, dark);
    index++;
  }

  for (NSUInteger i = index; i < existing.count; i++) {
    [existing[i] removeFromSuperview];
  }
}

// ─── pre-26 fallback : NSVisualEffectView substrate ─────────────────
//
// Preserves the material, blending, alpha, and geometry behavior that shipped
// before Liquid Glass. Nothing below this line consults the glass runtime.

static void AtumConfigureVibrancyView(AtumGlassEffectView *view, NSRect frame, CGFloat radius, int material, BOOL dark) {
  view.frame = frame;
  // The per-surface tint, sheen, and hairline of the approved material stay in
  // CSS on top of this; the native layer owns only the blur and its density.
  view.material = AtumMaterialForOrdinal(material);
  view.blendingMode = NSVisualEffectBlendingModeBehindWindow;
  view.state = NSVisualEffectStateActive;
  // Radius-clip the effect to the panel's shape instead of frosting rectangles.
  view.wantsLayer = YES;
  view.layer.cornerRadius = radius;
  view.layer.masksToBounds = YES;
  view.appearance = AtumAppearance(dark);
}

static void AtumConfigureSeamView(AtumSeamEffectView *view,
                                  NSRect content,
                                  NSArray<NSValue *> *frames,
                                  NSArray<NSNumber *> *radii,
                                  BOOL dark) {
  NSRect envelope = NSZeroRect;
  CGFloat envelopeRadius = AtumDefaultSurfaceRadius;

  if (!AtumSeamEnvelope(content, frames, radii, &envelope, &envelopeRadius)) {
    [view removeFromSuperview];
    return;
  }

  view.frame = envelope;
  view.material = NSVisualEffectMaterialMenu;
  view.blendingMode = NSVisualEffectBlendingModeBehindWindow;
  view.state = NSVisualEffectStateActive;
  view.alphaValue = AtumSeamLensAlpha;
  view.appearance = AtumAppearance(dark);
  view.wantsLayer = YES;

  AtumApplySeamMask(view, envelope, envelopeRadius, frames, radii);
}

static void AtumReconcileVibrancy(NSView *content,
                                  NSArray<NSValue *> *frames,
                                  NSArray<NSNumber *> *radii,
                                  NSArray<NSNumber *> *materials,
                                  BOOL dark) {
  NSMutableArray<AtumGlassEffectView *> *existing = [NSMutableArray array];
  AtumSeamEffectView *seamView = nil;
  for (NSView *subview in [NSArray arrayWithArray:content.subviews]) {
    if ([subview isKindOfClass:[AtumGlassEffectView class]]) {
      [existing addObject:(AtumGlassEffectView *)subview];
    } else if ([subview isKindOfClass:[AtumSeamEffectView class]]) {
      seamView = (AtumSeamEffectView *)subview;
    }
  }

  if (frames.count > 0 && seamView == nil) {
    seamView = [[AtumSeamEffectView alloc] initWithFrame:NSZeroRect];
    // The seam lens is the bottom-most native material. Panel-local glass
    // and all Chromium content remain above it.
    [content addSubview:seamView positioned:NSWindowBelow relativeTo:nil];
  }

  // Reconcile by position: reuse views in order, create the missing, remove
  // the surplus. An empty region array therefore strips all glass — collapse,
  // drawer close, and shell swap all converge on this one path.
  NSUInteger index = 0;
  for (NSUInteger i = 0; i < frames.count; i++) {
    NSRect frame = frames[i].rectValue;
    CGFloat radius = i < radii.count ? radii[i].doubleValue : AtumDefaultSurfaceRadius;
    int material = i < materials.count ? materials[i].intValue : 1;

    AtumGlassEffectView *view = nil;
    if (index < existing.count) {
      view = existing[index];
    } else {
      view = [[AtumGlassEffectView alloc] initWithFrame:frame];
      // Above the seam lens but below Chromium: panel glass and the neutral
      // gap lens never stack over the same pixels because of the even-odd
      // mask, while all native material remains behind web content.
      [content addSubview:view positioned:NSWindowAbove relativeTo:seamView];
    }
    AtumConfigureVibrancyView(view, frame, radius, material, dark);
    index++;
  }

  for (NSUInteger i = index; i < existing.count; i++) {
    [existing[i] removeFromSuperview];
  }

  if (seamView != nil) {
    AtumConfigureSeamView(seamView, content.bounds, frames, radii, dark);
  }
}

// ─── N-API entry points ─────────────────────────────────────────────

static napi_value AtumAttach(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  bool ok = false;
  if (argc >= 1) {
    NSWindow *window = AtumWindowFromHandle(env, args[0]);
    ok = window != nil && window.contentView != nil;
  }

  napi_value result;
  napi_get_boolean(env, ok, &result);
  return result;
}

static napi_value AtumSetRegions(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  napi_value result;
  napi_get_boolean(env, false, &result);

  if (argc < 3) {
    return result;
  }

  NSWindow *window = AtumWindowFromHandle(env, args[0]);
  if (!window) {
    return result;
  }

  bool isArray = false;
  if (napi_is_array(env, args[1], &isArray) != napi_ok || !isArray) {
    return result;
  }
  uint32_t count = 0;
  napi_get_array_length(env, args[1], &count);

  bool dark = false;
  napi_get_value_bool(env, args[2], &dark);

  @autoreleasepool {
    NSView *content = window.contentView;
    if (!content) {
      return result;
    }
    const CGFloat contentHeight = content.bounds.size.height;

    NSMutableArray<NSValue *> *frames = [NSMutableArray array];
    NSMutableArray<NSNumber *> *radii = [NSMutableArray array];
    NSMutableArray<NSNumber *> *materials = [NSMutableArray array];

    for (uint32_t i = 0; i < count; i++) {
      napi_value entry = nullptr;
      if (napi_get_element(env, args[1], i, &entry) != napi_ok || entry == nullptr) {
        continue;
      }
      double x = 0, y = 0, width = 0, height = 0, radius = 0;
      if (!AtumReadDoubleProperty(env, entry, "x", &x) || !AtumReadDoubleProperty(env, entry, "y", &y) ||
          !AtumReadDoubleProperty(env, entry, "width", &width) || !AtumReadDoubleProperty(env, entry, "height", &height)) {
        continue;
      }
      AtumReadDoubleProperty(env, entry, "radius", &radius);
      if (!(width > 0) || !(height > 0)) {
        continue;
      }

      // Density band. JS already allowlists this to 0..2; re-clamp here so a
      // stale or hand-crafted payload can only ever select a real material.
      double materialValue = 1;
      AtumReadDoubleProperty(env, entry, "material", &materialValue);
      int material = 1;
      if (materialValue >= 0 && materialValue <= 2) {
        material = static_cast<int>(materialValue);
      }

      // Renderer geometry is top-left-origin points; AppKit's content view is
      // bottom-left-origin. Convert per call against the CURRENT content size
      // so live resizes never pin glass to a stale frame.
      NSRect frame = NSMakeRect(x, contentHeight - y - height, width, height);
      [frames addObject:[NSValue valueWithRect:frame]];
      [radii addObject:@(radius)];
      [materials addObject:@(material)];
    }

    if (AtumLiquidGlassAvailable()) {
      AtumReconcileGlass(content, frames, radii, materials, dark ? YES : NO);
    } else {
      AtumReconcileVibrancy(content, frames, radii, materials, dark ? YES : NO);
    }
  }

  napi_get_boolean(env, true, &result);
  return result;
}

static napi_value AtumDetach(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  if (argc >= 1) {
    NSWindow *window = AtumWindowFromHandle(env, args[0]);
    if (window) {
      @autoreleasepool {
        // Both substrates are torn down unconditionally: a window that somehow
        // hosted one and then the other still ends up empty.
        for (NSView *subview in [NSArray arrayWithArray:window.contentView.subviews]) {
          if ([subview isKindOfClass:[AtumGlassRootView class]] ||
              [subview isKindOfClass:[AtumGlassEffectView class]] ||
              [subview isKindOfClass:[AtumSeamEffectView class]]) {
            [subview removeFromSuperview];
          }
        }
      }
    }
  }

  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value AtumInit(napi_env env, napi_value exports) {
  napi_value attachFn = nullptr;
  napi_value setRegionsFn = nullptr;
  napi_value detachFn = nullptr;
  napi_create_function(env, "attach", NAPI_AUTO_LENGTH, AtumAttach, nullptr, &attachFn);
  napi_create_function(env, "setRegions", NAPI_AUTO_LENGTH, AtumSetRegions, nullptr, &setRegionsFn);
  napi_create_function(env, "detach", NAPI_AUTO_LENGTH, AtumDetach, nullptr, &detachFn);
  napi_set_named_property(env, exports, "attach", attachFn);
  napi_set_named_property(env, exports, "setRegions", setRegionsFn);
  napi_set_named_property(env, exports, "detach", detachFn);
  return exports;
}

NAPI_MODULE(atum_vibrancy, AtumInit)
