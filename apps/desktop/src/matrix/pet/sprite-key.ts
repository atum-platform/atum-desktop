import type { PetInfo } from '../../../shared/pet'

/**
 * What makes two sprite payloads the same companion to the stage: every field but the sheet's
 * bytes, which its revision (`mtime_ns:size`) and length stand for. Every window focus re-reads
 * the pet over IPC and gets a new object with this same identity; keying the engine on the object
 * restarted it, snapping her back to an old resting place, on every focus (0.19.3 diagnosis §2.3).
 */
export function petSpriteKey(info: PetInfo): string {
  const { spritesheetBase64, ...rest } = info

  return JSON.stringify([rest, spritesheetBase64?.length ?? null])
}
