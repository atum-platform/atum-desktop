# Porting the launch eclipse to the phone

For the agent working in `atum-platform/atum-mobile` (Xcode 27). The desktop is the
reference: `engine.ts` (the motion, pure and tested) and `renderer.ts` (one fragment
shader). The approved look is the "Atum Launch Motion" artifact (Totality).

## What to build

- **Shader:** port `FRAG` in `renderer.ts` to a Metal fragment function (SwiftUI
  `ShaderLibrary` with `.colorEffect`/`.layerEffect`, or an `MTKView`). It is plain math
  (value noise, 5-octave fbm, exponentials); port it line for line. Keep the constants:
  the sun `#EFEEEA`, the moon `#141311`, the mark geometry (`MARK` in `engine.ts`) and the
  tone mapping `1 - exp(-glow * 1.25)`. Uniforms are listed in `UNIFORMS`.
- **Motion:** port `engine.ts` to Swift as a value type stepped at 240 Hz from a
  `TimelineView(.animation)` (or `CADisplayLink`), catching up with the clock when frames
  drop. Springs are `x'' = k (target − x) − c x'` with `c = 2 ζ √k`; keep every stiffness
  and damping ratio as written. Run `engine.test.ts`'s cases as XCTest against the port.
- **Inputs:** the phone's launch facts map onto `EclipseInputs`: five checks (`settled`,
  `current`), `blocked`, then `lit` and `leaving`. Use the same timing (`ECLIPSE_TIMING`):
  hold 0.9 s, the short finale for launches ready within 1.2 s.
- **Landing:** fly to the assistant's face in the chat header and dissolve into it over the
  last 300 ms, as on the desktop (the face hidden until then).
- **Reduce Motion** (`accessibilityReduceMotion`): no travel, still corona, a fade.

## Done when

Side by side with the artifact (Totality, Warm and 30 s), the phone and the desktop show the
same frames at the same times, light and dark, with Reduce Motion on and off.
