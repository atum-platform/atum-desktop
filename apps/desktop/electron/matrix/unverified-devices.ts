import { type MatrixUnverifiedOwnDevice, matrixUnverifiedOwnDevices } from '../../shared/matrix-device-trust'
import type { MatrixOwnDevices, MatrixSecurity } from '../../shared/matrix-security'

interface Options<Host extends object> {
  /** The person's own devices, through this host's SDK (`ownDevices`). */
  read(host: Host): Promise<MatrixOwnDevices | null>
  /** The list changed: publish the window's state again. */
  changed(): void
  /** Starts the standard Matrix comparison with a known unverified device. The comparison still
   * requires the person on both devices; this only removes the Settings scavenger hunt. */
  verify?(host: Host, deviceId: string): Promise<void>
  now?(): number
}

/**
 * Which of the person's own devices the window reminds them to verify (owner finding 1a,
 * 2026-10-06): read from the human SDK when this Mac starts, when the SDK hears the person's
 * device list change, when a verification here moves, and when an assistant refused a message
 * from one of their devices that isn't verified. Display facts only; nothing here changes what an
 * assistant accepts. One read at a time; a reason that arrives during a read reads once more.
 */
export class MatrixUnverifiedDevices<Host extends object> {
  private host: Host | undefined
  private seen: string | undefined
  private own: MatrixOwnDevices | null = null
  private devices: MatrixUnverifiedOwnDevice[] = []
  private running = false
  private again = false
  private requested = new Set<string>()
  private verifying = new Set<string>()

  constructor(private readonly options: Options<Host>) {}

  /** The human host's snapshot: a new host starts over; a moved device-list count or
   * verification reads again. */
  observe(host: Host, security: MatrixSecurity | undefined, ready: boolean): void {
    if (host !== this.host) {
      this.host = host
      this.seen = undefined
      this.own = null
      this.set([])
    }

    if (!ready || !security) {
      return
    }

    const verification = security.verification
    const seen = `${security.ownDevicesChanges ?? 0}|${security.identityChanges ?? 0}|${verification?.id ?? ''}:${verification?.state ?? ''}`

    if (seen !== this.seen) {
      this.seen = seen
      this.refresh()
    }
  }

  /** An assistant refused a message from one of the person's unverified devices: the device
   * may be new to this Mac, or only just active again. */
  denied(host: Host, deviceId?: string): void {
    if (host === this.host) {
      this.refresh()

      // A message from a device already identified by the trusted owner SDK is the most useful
      // moment to begin verification. Never sign it here: Matrix still shows the symbol
      // comparison on both devices and requires the person's confirmation.
      if (deviceId && this.options.verify) {
        this.requested.add(deviceId)
        this.verifyRequested(host, deviceId)
      }
    }
  }

  /** Signed out, or the human host is gone. */
  clear(): void {
    this.host = undefined
    this.seen = undefined
    this.own = null
    this.requested.clear()
    this.verifying.clear()
    this.set([])
  }

  view(host: Host | undefined): MatrixUnverifiedOwnDevice[] | undefined {
    return host && host === this.host && this.devices.length ? structuredClone(this.devices) : undefined
  }

  /** The unfiltered list this host last read (new-sign-in-alert.ts): the person's own devices,
   * including signed and verified ones the reminder above deliberately ignores. */
  ownDevices(host: Host | undefined): MatrixOwnDevices | undefined {
    return host && host === this.host && this.own ? structuredClone(this.own) : undefined
  }

  private refresh(): void {
    if (this.running) {
      this.again = true

      return
    }

    const host = this.host

    if (!host) {
      return
    }

    this.running = true
    this.again = false

    void this.options
      .read(host)
      .then(
        read => {
          if (host === this.host) {
            this.apply(read)
          }
        },
        // A failed read keeps what was known; the next reason reads again.
        () => {}
      )
      .finally(() => {
        this.running = false

        if (this.again) {
          this.refresh()
        }
      })
  }

  private apply(read: MatrixOwnDevices | null): void {
    const changed = JSON.stringify(read) !== JSON.stringify(this.own)

    this.own = read ? structuredClone(read) : null
    this.set(matrixUnverifiedOwnDevices(read, (this.options.now ?? Date.now)()), changed)
  }

  private set(devices: MatrixUnverifiedOwnDevice[], ownChanged = false): void {
    const current = new Set(devices.map(device => device.deviceId))
    const changed = JSON.stringify(devices) !== JSON.stringify(this.devices)

    for (const deviceId of this.verifying) {
      if (!current.has(deviceId)) {
        this.verifying.delete(deviceId)
      }
    }

    if (changed) {
      this.devices = devices
    }

    for (const deviceId of this.requested) {
      if (current.has(deviceId) && this.host) {
        this.verifyRequested(this.host, deviceId)
      } else {
        // The trusted owner SDK did not identify the sender as one of this account's devices.
        this.requested.delete(deviceId)
      }
    }

    if (changed || ownChanged) {
      this.options.changed()
    }
  }

  private verifyRequested(host: Host, deviceId: string): void {
    if (
      host !== this.host ||
      !this.options.verify ||
      !this.devices.some(device => device.deviceId === deviceId) ||
      this.verifying.has(deviceId)
    ) {
      return
    }

    this.requested.delete(deviceId)
    this.verifying.add(deviceId)
    void this.options.verify(host, deviceId).catch(() => this.verifying.delete(deviceId))
  }
}
