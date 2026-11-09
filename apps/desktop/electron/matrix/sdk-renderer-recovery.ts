/** Bounded restart of a replaceable Matrix SDK renderer (R4); main retains Hermes and authority. */

export const MATRIX_SDK_RENDERER_RETRY_MS = [1_000, 5_000, 15_000] as const

interface MatrixSdkRendererRecoveryOptions<K> {
  eligible(key: K): boolean
  start(key: K): Promise<boolean>
  recovered(key: K): void
  exhausted(key: K): void
  retrying?(key: K, attempt: number): void
  delays?: readonly number[]
}

export class MatrixSdkRendererRecovery<K> {
  private readonly timers = new Map<K, ReturnType<typeof setTimeout>>()

  constructor(private readonly options: MatrixSdkRendererRecoveryOptions<K>) {}

  restart(key: K): void {
    this.cancel(key)
    this.schedule(key, 0)
  }

  cancel(key: K): void {
    const timer = this.timers.get(key)

    if (timer) {
      clearTimeout(timer)
      this.timers.delete(key)
    }
  }

  private schedule(key: K, attempt: number): void {
    const delays = this.options.delays ?? MATRIX_SDK_RENDERER_RETRY_MS
    const delay = delays[attempt]

    if (delay === undefined) {
      this.options.exhausted(key)

      return
    }

    this.options.retrying?.(key, attempt + 1)
    const timer = setTimeout(() => {
      this.timers.delete(key)

      if (!this.options.eligible(key)) {
        return
      }

      void this.options
        .start(key)
        .catch(() => false)
        .then(recovered => {
          if (recovered) {
            this.options.recovered(key)
          } else if (this.options.eligible(key)) {
            this.schedule(key, attempt + 1)
          }
        })
    }, delay)
    timer.unref?.()
    this.timers.set(key, timer)
  }
}
