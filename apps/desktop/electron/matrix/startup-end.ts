/**
 * How a launch that did not finish ends (plan G1-13).
 *
 * A quit, or the window closing, while the window's first page is still loading destroys
 * that page, and Electron then rejects `loadURL` with `ERR_FAILED (-2)` (its load promise
 * treats the contents' destruction as a failed load). That is the person, macOS or an
 * installer ending the launch, most often while macOS asks for Keychain access before the
 * window can appear, not a failure. It used to be reported as "could not start" in a modal
 * alert, which also held the quit open until someone dismissed it (09-28, twice in
 * main.log: "lease stopped" from the quit, then the failed load 70 ms later).
 *
 * A launch the person or macOS ended quits quietly, with one line in main.log saying which
 * ended it. Anything else is still a failure: reported, logged and explained before the app
 * quits. Only a launch that fails before its window loads reaches here: everything after
 * that has its own error handling in main's start().
 */
export interface MatrixStartupEnd {
  /** A quit has been asked for (before-quit has fired, or shutdown has begun). */
  quitRequested(): boolean
  /** The window was made and has since been destroyed. Closing the window mid-load can
   * end its load before the quit that follows it is asked for. */
  windowClosed(): boolean
  describe(error: unknown): string
  report(error: unknown): void
  log(line: string): void
  alert(): void
  quit(): void
}

export function endMatrixStartup(error: unknown, end: MatrixStartupEnd): 'quit' | 'failed' {
  const endedBy = end.quitRequested() ? 'a quit' : end.windowClosed() ? 'its window closing' : undefined

  if (endedBy) {
    end.log(`[Matrix] startup ended by ${endedBy} before the window loaded: ${end.describe(error)}`)
    end.quit()

    return 'quit'
  }

  end.report(error)
  end.log(`[Matrix] candidate startup failed: ${end.describe(error)}`)
  end.alert()
  end.quit()

  return 'failed'
}

/**
 * Whether a quit has been asked for, known the moment before-quit fires. The quit handler's
 * own shutdown (and its `closing` flag) starts asynchronously, after a mid-load quit may
 * already have failed the window's load. Every before-quit listener runs, even when another
 * one holds the quit open, so the order of registration does not matter.
 */
export function trackMatrixQuit(app: { on(event: 'before-quit', listener: () => void): unknown }): () => boolean {
  let requested = false

  app.on('before-quit', () => {
    requested = true
  })

  return () => requested
}
