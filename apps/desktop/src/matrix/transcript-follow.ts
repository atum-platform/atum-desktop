/**
 * A ref for the area that holds a chat's transcript. The box under it grows — a staged
 * file, a question waiting above it, a second line — and the area shrinks; while the
 * transcript is following its end, the latest message stays in view instead of sliding
 * under the box. (The transcript's scroll owner follows its content's growth, not its
 * viewport's shrinking.) Returns the observer's cleanup, as React 19 ref callbacks may.
 */
export function followTranscriptEnd(area: HTMLElement | null): (() => void) | undefined {
  if (!area || typeof ResizeObserver === 'undefined') {
    return undefined
  }

  let height = area.clientHeight

  const observer = new ResizeObserver(() => {
    const next = area.clientHeight
    const scroller = area.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]')

    if (next < height && scroller?.dataset.following === 'true') {
      scroller.scrollTop = scroller.scrollHeight
    }

    height = next
  })

  observer.observe(area)

  return () => observer.disconnect()
}
