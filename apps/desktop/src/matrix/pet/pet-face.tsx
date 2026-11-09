import { useEffect, useRef } from 'react'

import { PawPrint } from '@/lib/icons'
import { cn } from '@/lib/utils'

import type { PetInfo } from '../../../shared/pet'

/**
 * The pet's face in its chat: a circle, as every face is (STYLE.md §5), cut from its own
 * idle frame. It reads the sprite the stage already holds, so it needs no image URL (the
 * popped-out window allows only data images) and stays the pet you see walking.
 */
export function PetFace({ sprite, size, className }: { sprite?: PetInfo; size: number; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const base64 = sprite?.spritesheetBase64
  const mime = sprite?.mime
  const frameW = sprite?.frameW ?? 192
  const frameH = sprite?.frameH ?? 208
  const row = Math.max(0, sprite?.stateRows?.indexOf('idle') ?? 0)
  const bounds = sprite?.bounds?.idle

  useEffect(() => {
    const element = canvas.current

    if (!element || !base64) {
      return
    }

    const image = new Image()
    let current = true

    image.onload = () => {
      const context = current ? element.getContext('2d') : null

      if (!context) {
        return
      }

      // The opaque part of the first idle frame, centred in a square so the pet fills the circle.
      const area = bounds ?? opaqueArea(image, row * frameH, frameW, frameH)
      const side = Math.max(area.width, area.height) * 1.08
      const scale = (size * window.devicePixelRatio) / side
      element.width = Math.round(size * window.devicePixelRatio)
      element.height = element.width
      context.clearRect(0, 0, element.width, element.height)
      context.imageSmoothingQuality = 'high'
      context.drawImage(
        image,
        area.x,
        row * frameH + area.y,
        area.width,
        area.height,
        ((side - area.width) / 2) * scale,
        ((side - area.height) / 2) * scale,
        area.width * scale,
        area.height * scale
      )
    }

    image.src = `data:${mime ?? 'image/webp'};base64,${base64}`

    return () => {
      current = false
    }
  }, [base64, bounds, frameH, frameW, mime, row, size])

  return (
    <span
      aria-hidden
      className={cn('grid shrink-0 place-items-center overflow-hidden rounded-full bg-(--ak-fill-quiet)', className)}
      data-pet-face
      style={{ width: size, height: size }}
    >
      {base64 ? <canvas className="size-full" ref={canvas} /> : <PawPrint className="size-[55%] text-(--ak-ink-2)" />}
    </span>
  )
}

/** The frame's painted pixels, when the sprite does not carry its own bounds. */
function opaqueArea(image: HTMLImageElement, top: number, width: number, height: number) {
  const whole = { x: 0, y: 0, width, height }
  const scratch = window.document.createElement('canvas')
  scratch.width = width
  scratch.height = height
  const context = scratch.getContext('2d', { willReadFrequently: true })

  if (!context) {
    return whole
  }

  context.drawImage(image, 0, top, width, height, 0, 0, width, height)
  let pixels: Uint8ClampedArray

  try {
    pixels = context.getImageData(0, 0, width, height).data
  } catch {
    return whole
  }

  let left = width
  let right = -1
  let upper = height
  let lower = -1

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3]! > 16) {
        left = Math.min(left, x)
        right = Math.max(right, x)
        upper = Math.min(upper, y)
        lower = Math.max(lower, y)
      }
    }
  }

  return right < 0 ? whole : { x: left, y: upper, width: right - left + 1, height: lower - upper + 1 }
}
