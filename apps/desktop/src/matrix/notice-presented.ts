import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react'

/** How long a disclosure must be on screen, in a focused window, before it counts as presented. */
export const MATRIX_NOTICE_PRESENTED_MS = 1_000

/**
 * O2 "shown, never accepted": calls `onPresented` once, after the surface has stayed visible in a
 * focused, foreground window for a full second. Losing focus, hiding the window or scrolling the
 * surface away restarts the second. Main refuses an unfocused acknowledgement as well.
 */
export function useNoticePresented(
  active: boolean,
  onPresented: () => void,
  target?: RefObject<Element | null>
): void {
  const callback = useRef(onPresented)

  useLayoutEffect(() => {
    callback.current = onPresented
  })

  useEffect(() => {
    if (!active) {
      return
    }

    const document = window.document
    let timer: ReturnType<typeof setTimeout> | undefined
    let done = false
    let onScreen = true

    const visible = () => onScreen && document.visibilityState === 'visible' && document.hasFocus()

    const arm = () => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }

      if (done || !visible()) {
        return
      }

      timer = setTimeout(() => {
        timer = undefined

        if (!done && visible()) {
          done = true
          callback.current()
        }
      }, MATRIX_NOTICE_PRESENTED_MS)
    }

    const element = target?.current

    const observer =
      element && typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(entries => {
            onScreen = entries.some(entry => entry.isIntersecting)
            arm()
          })
        : undefined

    if (observer && element) {
      onScreen = false
      observer.observe(element)
    }

    window.addEventListener('focus', arm)
    window.addEventListener('blur', arm)
    document.addEventListener('visibilitychange', arm)
    arm()

    return () => {
      done = true
      observer?.disconnect()
      window.removeEventListener('focus', arm)
      window.removeEventListener('blur', arm)
      document.removeEventListener('visibilitychange', arm)

      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }
  }, [active, target])
}
