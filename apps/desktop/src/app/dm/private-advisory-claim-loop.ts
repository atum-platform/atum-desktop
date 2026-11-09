/** Polls for owner-authorized slots. A claim never starts a new discussion round. */
export function startPrivateAdvisoryClaimLoop(options: {
  canClaim: () => Promise<boolean>
  claim: (operationId: string) => Promise<{ jobId: string | null }>
  subscribeWake?: (wake: () => void) => () => void
}): () => void {
  let stopped = false
  let running = false
  let wakePending = false
  let delay = 5_000
  let timer: ReturnType<typeof setTimeout> | undefined

  const tick = async () => {
    if (stopped || running) {return}
    running = true
    wakePending = false
    let worked = false
    try {
      if (await options.canClaim() && !stopped) {
        worked = (await options.claim(crypto.randomUUID())).jobId !== null
      }
    } catch {
      // Network/authority failure leaves the durable job queued for a later claim.
    } finally {
      running = false
      if (!stopped) {
        const next = wakePending ? 0 : worked ? 5_000 : delay
        delay = worked || wakePending ? 5_000 : Math.min(60_000, delay * 2)
        timer = setTimeout(() => void tick(), next)
      }
    }
  }

  const unsubscribe = options.subscribeWake?.(() => {
    delay = 5_000
    wakePending = true
    clearTimeout(timer)
    void tick()
  })
  void tick()

  return () => {
    stopped = true
    unsubscribe?.()
    clearTimeout(timer)
  }
}
