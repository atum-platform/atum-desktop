/**
 * Keep-awake — hold a single machine-global power-save blocker.
 *
 * `prevent-app-suspension` stops the system from sleeping (long overnight
 * agent runs keep going) while still letting the display dim. The generic
 * desktop surface mirrors its renderer preference here; the Atum Matrix
 * surface owns a separate main-process preference and shares one blocker
 * across its reasons. Electron auto-releases either blocker on quit.
 */

export type KeepAwakeType = 'prevent-app-suspension' | 'prevent-display-sleep'

/** The slice of Electron's `powerSaveBlocker` we use (injected for testing). */
export interface PowerSaveBlockerLike {
  start(type: KeepAwakeType): number
  stop(id: number): void
  isStarted(id: number): boolean
}

export interface KeepAwake {
  /** Turn the blocker on/off (idempotent). Returns the resulting state. */
  set(on: boolean): boolean
  isActive(): boolean
}

export type AtumKeepAwakeReason = 'listening' | 'cloud_device' | 'failover_chain'
export type AtumKeepAwakeTransitionReason = AtumKeepAwakeReason | 'setting_off' | 'battery' | 'quit'

export interface AtumKeepAwake {
  /** The one device-local switch over every reason. */
  setEnabled(enabled: boolean): boolean
  /** A capability asks the one blocker to stay on; reasons never own blockers. */
  setReason(reason: AtumKeepAwakeReason, active: boolean): boolean
  /** A MacBook on battery stops holding the sleep blocker (the battery is not drained to stay awake)
   * without changing the person's switch, and without taking the Mac out of anything else. */
  setOnBattery(onBattery: boolean): boolean
  /** Whether this Mac answers and joins failover: the person's switch only (owner decision 2026-10-20,
   * was also "plugged in"): a MacBook on battery that is awake still answers; only the sleep blocker
   * stays off, so a closed lid still ends it. */
  isEligible(): boolean
  isActive(): boolean
  stop(): void
}

export interface AtumKeepAwakeOptions {
  enabled?: boolean
  onBattery?: boolean
  type?: KeepAwakeType
  onTransition?(active: boolean, reason: AtumKeepAwakeTransitionReason): void
}

export function createKeepAwake(
  blocker: PowerSaveBlockerLike,
  type: KeepAwakeType = 'prevent-app-suspension'
): KeepAwake {
  let id: null | number = null

  const isActive = () => id !== null && blocker.isStarted(id)

  return {
    isActive,
    set(on) {
      if (on && !isActive()) {
        id = blocker.start(type)
      } else if (!on && id !== null) {
        if (blocker.isStarted(id)) {
          blocker.stop(id)
        }

        id = null
      }

      return isActive()
    }
  }
}

/** One blocker shared by listening, the cloud-device hub and the future failover chain. */
export function createAtumKeepAwake(blocker: PowerSaveBlockerLike, options: AtumKeepAwakeOptions = {}): AtumKeepAwake {
  const native = createKeepAwake(blocker, options.type)
  const reasons = new Set<AtumKeepAwakeReason>()
  let enabled = options.enabled ?? true
  let onBattery = options.onBattery ?? false

  const firstReason = (): AtumKeepAwakeReason => reasons.values().next().value ?? 'listening'

  const reconcile = (reason: AtumKeepAwakeTransitionReason): boolean => {
    const was = native.isActive()
    const active = native.set(enabled && !onBattery && reasons.size > 0)

    if (active !== was) {
      options.onTransition?.(active, reason)
    }

    return active
  }

  return {
    isActive: () => native.isActive(),
    isEligible: () => enabled,
    setEnabled(next) {
      enabled = next

      return reconcile(next ? firstReason() : 'setting_off')
    },
    setOnBattery(next) {
      onBattery = next

      return reconcile(next ? 'battery' : firstReason())
    },
    setReason(reason, active) {
      if (active) {
        reasons.add(reason)
      } else {
        reasons.delete(reason)
      }

      return reconcile(reason)
    },
    stop() {
      reasons.clear()
      const was = native.isActive()
      native.set(false)

      if (was) {
        options.onTransition?.(false, 'quit')
      }
    }
  }
}
