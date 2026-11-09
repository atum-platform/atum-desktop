export type QuitTeardownTask = () => Promise<unknown> | unknown

export interface QuitTeardownCoordinatorOptions {
  readonly onComplete: () => void
  readonly setTimer?: typeof setTimeout
  readonly timeoutMilliseconds: number
}

/**
 * Own one bounded async pause in Electron's synchronous `before-quit` event.
 * Re-entrant quit events join the first pause; the completion callback fires
 * once even when a task rejects or never settles.
 */
export class QuitTeardownCoordinator {
  readonly #options: QuitTeardownCoordinatorOptions
  #complete = false
  #started = false

  constructor(options: QuitTeardownCoordinatorOptions) {
    this.#options = options
  }

  defer(tasks: readonly QuitTeardownTask[]): boolean {
    if (this.#complete || tasks.length === 0) {
      return false
    }

    if (!this.#started) {
      this.#started = true
      const setTimer = this.#options.setTimer ?? setTimeout

      const timeout = new Promise<void>(resolve => {
        setTimer(resolve, this.#options.timeoutMilliseconds)
      })

      const settled = Promise.allSettled(tasks.map(task => Promise.resolve().then(task))).then(() => undefined)

      void Promise.race([settled, timeout]).finally(() => {
        this.#complete = true

        try {
          this.#options.onComplete()
        } catch {
          // The coordinator is a quit fail-safe. Completion is terminal even
          // if the host callback itself is unexpectedly not total.
        }
      })
    }

    return true
  }
}
