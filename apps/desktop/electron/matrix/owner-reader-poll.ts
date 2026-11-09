/** While an owner_reader enrollment is provisioning or awaiting trust, the
 * handoff window is short, so the desktop checks often. */
export const OWNER_READER_PENDING_POLL_MS = 10_000
/** First wait after a check found nothing to do (no enrollment, cloud off, shell error). */
export const OWNER_READER_IDLE_POLL_MS = 60_000
/** Idle checks double up to this cap: about 150 checks a day instead of 8,640. */
export const OWNER_READER_IDLE_POLL_MAX_MS = 600_000

/** Delay before the next check. Fast only while an enrollment is pending; otherwise back off. */
export function nextOwnerReaderPollDelay(previous: number | undefined, pending: boolean): number {
  if (pending) {
    return OWNER_READER_PENDING_POLL_MS
  }

  if (previous === undefined || previous < OWNER_READER_IDLE_POLL_MS) {
    return OWNER_READER_IDLE_POLL_MS
  }

  return Math.min(previous * 2, OWNER_READER_IDLE_POLL_MAX_MS)
}

export interface OwnerReaderTrustPoller {
  /** Check now unless a check is in flight or the host is inactive; then re-arm. */
  run(): void
  /** Cancel the next check and forget the backoff (sign-out, SDK stop). */
  stop(): void
}

/**
 * One owner-reader trust check at a time. `check` resolves whether an enrollment is
 * pending; a rejected check counts as not pending. Nothing re-arms while inactive.
 */
export function createOwnerReaderTrustPoller(input: {
  active: () => boolean
  check: () => Promise<boolean>
}): OwnerReaderTrustPoller {
  let timer: ReturnType<typeof setTimeout> | undefined
  let flight: Promise<void> | undefined
  let delay: number | undefined

  const run = (): void => {
    if (flight || !input.active()) {
      return
    }

    flight = (async () => {
      let pending = false

      try {
        pending = await input.check()
      } catch {
        pending = false
      }

      flight = undefined
      clearTimeout(timer)
      delay = nextOwnerReaderPollDelay(delay, pending)

      if (input.active()) {
        timer = setTimeout(run, delay)
      }
    })()
  }

  return {
    run,
    stop() {
      clearTimeout(timer)
      timer = undefined
      delay = undefined
    }
  }
}

/**
 * The owner reader reads plain rooms without the trust hand-off (0.20), but it waits for the
 * awareness controls room, which only the hand-off used to make. Whenever this account has a
 * reader, prepare that room (an idempotent SDK command). Resolves true once it is prepared, so the
 * caller asks once per signed-in session. One closed line per outcome; no IDs.
 */
export async function prepareOwnerReaderControls(input: {
  reader(): Promise<string>
  prepare(): Promise<unknown>
  current(): boolean
  log(line: string): void
}): Promise<boolean> {
  try {
    if ((await input.reader()) === 'none' || !input.current()) {
      return false
    }

    await input.prepare()
    input.log('[Matrix] owner reader controls outcome=prepared')

    return true
  } catch (error) {
    const code = error instanceof Error && /^[a-z_]{1,64}$/.test(error.message) ? error.message : 'unexpected'
    input.log(`[Matrix] owner reader controls outcome=failed code=${code}`)

    return false
  }
}
