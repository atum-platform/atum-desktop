import { type RefObject, useEffect } from 'react'

import type { MatrixWorkBridge, MatrixWorkRect } from '../../../shared/matrix-work'

function rectOf(node: HTMLElement): MatrixWorkRect {
  const box = node.getBoundingClientRect()

  return {
    x: Math.max(0, Math.round(box.left)),
    y: Math.max(0, Math.round(box.top)),
    width: Math.max(0, Math.round(box.width)),
    height: Math.max(0, Math.round(box.height))
  }
}

function same(left: MatrixWorkRect | null, right: MatrixWorkRect): boolean {
  return Boolean(
    left && left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
  )
}

/**
 * One job: keep main's owner view over the host region while it may show, and off the window otherwise.
 * Main paints a native view above the page, so anything that must sit over the region (a modal, the
 * account menu) makes `visible` false first.
 */
export function useWorkViewPlacement(
  bridge: Pick<MatrixWorkBridge, 'hide' | 'show'>,
  host: RefObject<HTMLElement | null>,
  visible: boolean
): void {
  useEffect(() => {
    const node = host.current

    if (!visible || !node) {
      void bridge.hide().catch(() => {})

      return
    }

    let last: MatrixWorkRect | null = null
    let frame = 0

    const place = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const rect = rectOf(node)

        if (!same(last, rect)) {
          last = rect
          void bridge.show(rect).catch(() => {})
        }
      })
    }

    place()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    observer?.observe(node)
    window.addEventListener('resize', place)

    return () => {
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', place)
      void bridge.hide().catch(() => {})
    }
  }, [bridge, host, visible])
}
