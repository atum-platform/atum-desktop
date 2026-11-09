import { useEffect, useRef, useState } from 'react'

/**
 * One creation at a time for a dialog that can be dismissed while it works (a direct
 * conversation, a group). It lives outside the dialog's content, so closing and reopening
 * neither starts a second identical request nor loses the failure; an answer that arrives
 * after the account's roster is gone (an account switch remounts it) changes nothing.
 */
export function useCreationAction() {
  const live = useRef(true)
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    live.current = true

    return () => {
      live.current = false
    }
  }, [])

  /** `task` resolves true when something was made, false when the person declined. */
  const run = (task: () => Promise<boolean>, done: () => void) => {
    if (busy.current) {
      return
    }

    busy.current = true
    setPending(true)
    setFailed(false)
    void task()
      .then(made => {
        if (live.current && made) {
          done()
        }
      })
      .catch(() => {
        if (live.current) {
          setFailed(true)
        }
      })
      .finally(() => {
        busy.current = false

        if (live.current) {
          setPending(false)
        }
      })
  }

  return { pending, failed, run, clearFailure: () => setFailed(false) }
}
