import gigiSheet from '../../../assets/pets/gigi/spritesheet.webp?inline'
import type { PetInfo } from '../../../shared/pet'

/** The welcome companion is bundled with the renderer so she can appear before sign-in,
 * without waiting for Matrix, Hermes, or the pet catalog. */
export const BUNDLED_GIGI: PetInfo = {
  enabled: true,
  slug: 'gigi',
  displayName: 'Gigi',
  mime: 'image/webp',
  spritesheetBase64: gigiSheet.slice(gigiSheet.indexOf(',') + 1),
  frameW: 192,
  frameH: 208,
  framesPerState: 6,
  framesByState: {
    idle: 6,
    wave: 4,
    run: 6,
    failed: 6,
    review: 6,
    jump: 5,
    waiting: 6,
    lounging: 6,
    sleep: 6,
    carried: 4
  },
  framesByRow: {
    idle: 6,
    'running-right': 8,
    'running-left': 8,
    waving: 4,
    jumping: 5,
    failed: 8,
    waiting: 6,
    running: 6,
    review: 6,
    lounging: 6,
    'look-0': 8,
    'look-1': 7,
    sleep: 6,
    carried: 4
  },
  loopMs: 1100,
  // Derived from the sheet by `hermes_cli.atum_pet_sprite` (agent.pet.payload._pet_opaque_geometry), the same
  // geometry the signed-in app receives: the foot baseline is the idle row's lowest opaque pixel (paws, not the
  // frame's transparent bottom), and each pose's painted bounds are its pointer target.
  anchor: { footY: 195, centerX: 95.5 },
  bounds: {
    idle: { x: 26, y: 76, width: 139, height: 119 },
    'running-right': { x: 21, y: 66, width: 145, height: 129 },
    'running-left': { x: 26, y: 66, width: 145, height: 129 },
    waving: { x: 26, y: 71, width: 139, height: 129 },
    jumping: { x: 26, y: 49, width: 139, height: 156 },
    failed: { x: 26, y: 81, width: 139, height: 124 },
    waiting: { x: 26, y: 75, width: 145, height: 130 },
    running: { x: 26, y: 66, width: 145, height: 129 },
    review: { x: 26, y: 76, width: 139, height: 119 },
    lounging: { x: 26, y: 103, width: 139, height: 98 },
    'look-0': { x: 20, y: 79, width: 145, height: 116 },
    'look-1': { x: 26, y: 79, width: 139, height: 116 },
    sleep: { x: 26, y: 103, width: 139, height: 98 },
    carried: { x: 26, y: 82, width: 139, height: 121 }
  },
  scale: 1,
  size: 1,
  stateRows: [
    'idle',
    'running-right',
    'running-left',
    'waving',
    'jumping',
    'failed',
    'waiting',
    'running',
    'review',
    'lounging',
    'look-0',
    'look-1',
    'sleep',
    'carried'
  ]
}
