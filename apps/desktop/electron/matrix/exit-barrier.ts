/**
 * Runs `kill` synchronously as the main process ends, however it ends: `will-quit` after
 * an ordinary or update quit, and Node's `exit` for `app.exit()` and fatal paths that skip
 * it. `kill` must be synchronous and idempotent (MatrixLocalBrain.killNow).
 */
export function installMatrixExitBarrier(input: {
  app: { on(event: 'will-quit', listener: () => void): unknown }
  process: { on(event: 'exit', listener: () => void): unknown }
  kill: () => void
  log?: (message: string) => void
}) {
  const run = () => {
    try {
      input.kill()
    } catch {
      input.log?.('[Matrix] exit_barrier_failed')
    }
  }

  input.app.on('will-quit', run)
  input.process.on('exit', run)
}
