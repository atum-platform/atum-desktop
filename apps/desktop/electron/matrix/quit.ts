/** Document persistence may refuse quit. Once committed, service withdrawal is
 * bounded: a stuck network call or child must not hold Squirrel open forever. */
export function createMatrixQuitHandler(
  close: () => Promise<void>,
  quit: () => void,
  afterClose: (success: boolean) => 'quit' | 'handled' | 'retry' = () => 'quit',
  options: {
    prepare?: () => Promise<void>
    deadlineMs?: number
    forceCleanup?: () => void
    forceExit?: () => void
    log?: (line: string) => void
  } = {}
) {
  let closing = false
  let ready = false

  return (event: { preventDefault(): void }) => {
    if (ready) {
      return
    }

    event.preventDefault()

    if (closing) {
      return
    }

    closing = true

    const finish = (success: boolean) => {
      ready = true
      const disposition = afterClose(success)

      if (disposition === 'retry') {
        ready = false
        closing = false
      }

      if (disposition !== 'retry' && options.forceExit) {
        // The native updater closes windows before quitting; a renderer's
        // beforeunload must not leave an invisible app holding ShipIt open.
        setTimeout(options.forceExit, 10_000).unref()
      }

      if (disposition === 'quit') {
        quit()
      }
    }
    void (async () => {
      try {
        await options.prepare?.()
      } catch {
        finish(false)

        return
      }

      let timer: ReturnType<typeof setTimeout> | undefined

      const deadline = new Promise<'deadline'>(resolve => {
        timer = setTimeout(() => resolve('deadline'), options.deadlineMs ?? 30_000)
      })

      // A rejection from one service cannot skip retirement of the other owners.
      try {
        const outcome = await Promise.race([Promise.resolve().then(close).then(() => 'closed'), deadline])
        if (outcome === 'deadline') {options.log?.('[Matrix] quit service deadline reached; retiring remaining children')}
      } catch {
        options.log?.('[Matrix] quit service failed; retiring remaining children')
      } finally {
        clearTimeout(timer)
      }

      try {
        options.forceCleanup?.()
      } catch {
        /* Exit barrier retries synchronously. */
      }

      finish(true)
    })()
  }
}
