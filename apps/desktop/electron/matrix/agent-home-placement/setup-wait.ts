/**
 * Placement shares an agent's operation slot with its launch-time set-up, so a catalogue read or
 * a target materialization waits for that set-up instead of reporting the owner's press as
 * `matrix_connected_model_busy`. The caller's abort is the bound; a set-up that failed needs no
 * special answer here, because the read that follows finds out what exists.
 */
export function waitForAgentSetup(setup: Promise<void> | undefined, signal: AbortSignal): Promise<void> {
  if (!setup || signal.aborted) {
    return Promise.resolve()
  }

  return new Promise<void>(resolve => {
    const done = () => {
      signal.removeEventListener('abort', done)
      resolve()
    }

    signal.addEventListener('abort', done, { once: true })
    void setup.catch(() => undefined).finally(done)
  })
}
