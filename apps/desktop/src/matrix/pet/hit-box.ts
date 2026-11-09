import { petDrawScale, type PetInfo, type PetState } from '../../../shared/pet'

/** Bounds are atlas pixels. Only the painted current row receives pointers. */
export function petHitBox(info: PetInfo, pose: PetState, zoom: number, mirror = false) {
  const aliases: Partial<Record<PetState, string>> = { wave: 'waving', run: 'running', jump: 'jumping' }
  const bounds = info.bounds?.[pose] ?? info.bounds?.[aliases[pose] ?? pose] ?? info.bounds?.idle
  const frameW = info.frameW ?? 192
  const frameH = info.frameH ?? 208
  const area = bounds ?? { x: 0, y: 0, width: frameW, height: frameH }
  const scale = petDrawScale(info) * zoom

  return {
    left: (mirror ? frameW - area.x - area.width : area.x) * scale,
    top: area.y * scale,
    width: area.width * scale,
    height: area.height * scale
  }
}
