import { createHash } from 'node:crypto'

import type { MatrixNativeSshView as NativeSshView } from '../../../shared/matrix-native-mac'

import type { RelaySshBinding } from './chatgpt-relay'
/** Native Hermes SSH route. No device frames or tool schemas are involved. */
import type { DeviceEnrollmentRecord } from './enrollment'

export const REMOTE_LOGIN_SETTINGS =
  'x-apple.systempreferences:com.apple.Sharing-Settings.extension?Services_RemoteLogin'
export type {
  MatrixNativeSshStatus as NativeSshStatus,
  MatrixNativeSshView as NativeSshView
} from '../../../shared/matrix-native-mac'
export type NativeSshRequest =
  | { operation: 'ssh_prepare'; deviceServiceId: string }
  | {
      operation: 'ssh_enroll'
      deviceServiceId: string
      enrollmentEpoch: number
      host: string
      user: string
      hostKey: string
    }
  | { operation: 'ssh_revoke'; deviceServiceId: string }
  | { operation: 'ssh_authorized_keys'; purposes: true }
export interface NativeSshSystem {
  ready(): Promise<{ remoteLogin: boolean; user: string; hostKey: string }>
  enableRemoteLogin(): Promise<void>
  token(id: string): Promise<string | null>
  saveToken(id: string, token: string): Promise<void>
  removeToken(id: string): Promise<void>
  start(id: string): Promise<void>
  stop(): Promise<void>
  keys(keys: (string | RelayAuthorizedKey)[]): Promise<void>
}

export function sshPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(value)) {
    return false
  }

  const bytes = Buffer.from(value.slice(12), 'base64')

  return (
    bytes.length === 51 &&
    bytes.readUInt32BE(0) === 11 &&
    bytes.subarray(4, 15).toString() === 'ssh-ed25519' &&
    bytes.readUInt32BE(15) === 32
  )
}

export interface RelayAuthorizedKey extends RelaySshBinding {
  publicKey: string
  purpose: 'relay'
}
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/

export function relayKeyLine(row: RelayAuthorizedKey, helper: string): string {
  if (!sshPublicKey(row.publicKey) || !UUID.test(row.ownerPrincipal) || !UUID.test(row.agentPrincipal) ||
      !Number.isSafeInteger(row.connectionEpoch) || row.connectionEpoch < 1 || !/^\/[A-Za-z0-9_./ -]+$/.test(helper)) {
    throw new Error('invalid_relay_key')
  }

  return `command="'${helper}' ${row.ownerPrincipal} ${row.agentPrincipal} ${row.connectionEpoch}",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty,no-user-rc ${row.publicKey}`
}

// Platform default: prefix + opaque registry label + suffix; never derive from UUID.
export function nativeSshHost(value: unknown): value is string {
  return typeof value === 'string' && /^mac-[a-f0-9]{32}\.atumplatform\.com$(?![\s\S])/.test(value)
}

const tokenDigest = (token: string) => createHash('sha256').update(token).digest('hex')

const BEGIN = '# BEGIN ATUM MANAGED SSH KEYS'
const END = '# END ATUM MANAGED SSH KEYS'

/** Preserve all bytes outside the block; refuse ambiguous/corrupt markers. */
export function managedKeys(current: string, keys: (string | RelayAuthorizedKey)[], helper = ''): string {
  if (!keys.every(key => typeof key === 'string' ? sshPublicKey(key) : key.purpose === 'relay')) {
    throw new Error('invalid_ssh_key')
  }

  const begin = current.indexOf(BEGIN),
    end = current.indexOf(END)

  if (
    begin < 0 !== end < 0 ||
    (begin >= 0 &&
      (end < begin ||
        current.indexOf(BEGIN, begin + 1) >= 0 ||
        current.indexOf(END, end + 1) >= 0 ||
        (begin > 0 && current[begin - 1] !== '\n')))
  ) {
    throw new Error('invalid_ssh_block')
  }

  const block = keys.length
    ? `${BEGIN}\n${[...new Set(keys)].map(key => typeof key === 'string' ? `no-agent-forwarding,no-port-forwarding,no-X11-forwarding ${key}` : relayKeyLine(key, helper)).join('\n')}\n${END}\n`
    : ''

  if (begin < 0) {
    return current + (block && current && !current.endsWith('\n') ? '\n' : '') + block
  }

  const tail = end + END.length

  if (current[tail] && current[tail] !== '\n') {
    throw new Error('invalid_ssh_block')
  }

  return current.slice(0, begin) + block + current.slice(tail + (current[tail] === '\n' ? 1 : 0))
}

export class NativeMacSsh {
  private bindings: RelaySshBinding[] = []
  relayBindings(): readonly RelaySshBinding[] { return this.bindings }
  private view: NativeSshView = { status: 'tunnel_down', settingsUrl: REMOTE_LOGIN_SETTINGS }
  private chain: Promise<unknown> = Promise.resolve()
  private timer?: ReturnType<typeof setInterval>
  private id?: string
  private routeKey?: string
  private enrolled?: string
  private hintEnrollmentKey?: string
  private disconnected = false
  private accountScope?: string
  constructor(
    private readonly deps: {
      ownerPrincipal?(): string | undefined
      enrollment(): DeviceEnrollmentRecord | null
      call(body: NativeSshRequest): Promise<unknown>
      system: NativeSshSystem
      settings: {
        getItem(key: string): string | null
        setItem(key: string, value: string): void
      }
    }
  ) {}
  status(): NativeSshView {
    const acknowledged = this.hintEnrollmentKey && this.deps.settings.getItem(this.hintEnrollmentKey) === 'acknowledged'

    return {
      ...this.view,
      status: this.view.status === 'connected' && !acknowledged ? 'needs_full_disk_access_hint' : this.view.status
    }
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn)
    this.chain = result.catch(() => undefined)

    return result
  }
  start(explicit = false): Promise<void> {
    const record = this.deps.enrollment()
    const scope = record ? `${record.ownerUserId}:${record.matrixDeviceId}` : undefined

    if (scope && this.accountScope && scope !== this.accountScope) {
      this.disconnected = false
    }

    this.accountScope = scope ?? this.accountScope

    if (explicit) {
      this.disconnected = false
    }

    if (this.disconnected) {
      return Promise.resolve()
    }

    this.timer ??= setInterval(() => {
      void this.refresh()
    }, 60_000)
    this.timer.unref?.()

    return this.refresh()
  }
  /** Only an explicit UI action may invoke the macOS administrator prompt. */
  enableRemoteLogin(): Promise<void> {
    return this.serial(async () => {
      await this.deps.system.enableRemoteLogin()
    }).then(() => this.start(true))
  }
  fullDiskAccessHint(): NativeSshView {
    return this.status()
  }
  /** Acknowledge only the enrollment whose successful setup offered the reminder. */
  acknowledgeFullDiskAccessHint(): void {
    const record = this.deps.enrollment()

    if (
      this.view.status === 'connected' &&
      record?.state === 'active' &&
      this.hintEnrollmentKey === this.enrollmentHintKey(record)
    ) {
      try {
        this.deps.settings.setItem(this.hintEnrollmentKey, 'acknowledged')
      } catch {
        throw new Error('native_ssh_hint_save_failed')
      }
    }
  }
  private enrollmentHintKey(record: DeviceEnrollmentRecord): string {
    return `native-ssh:full-disk-access-hint:${record.deviceServiceId}:${record.enrollmentEpoch}`
  }
  refresh(): Promise<void> {
    return this.serial(async () => {
      let recoveryRequired = false

      try {
        const record = this.deps.enrollment()

        if (!record || record.state !== 'active') {
          if (this.id) {
            await this.cleanup()
          } else {
            this.bindings = []
            await this.deps.system.keys([])
            await this.deps.system.stop()
          }

          this.view = { status: 'error', settingsUrl: REMOTE_LOGIN_SETTINGS }

          return
        }

        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.deviceServiceId)) {
          throw new Error('invalid_device')
        }

        if (this.id && this.id !== record.deviceServiceId) {
          await this.cleanup()
        }

        this.id = record.deviceServiceId

        const ready = await this.deps.system.ready()

        if (!ready.remoteLogin) {
          this.bindings = []
          await this.deps.system.keys([])
          await this.deps.system.stop()
          this.enrolled = undefined
          this.view = { status: 'needs_remote_login', settingsUrl: REMOTE_LOGIN_SETTINGS }

          return
        }

        // macOS login names can contain uppercase ASCII. Preserve OS spelling.
        if (!/^[A-Za-z_][A-Za-z0-9_-]{0,31}$(?![\s\S])/.test(ready.user) || !sshPublicKey(ready.hostKey)) {
          throw new Error('invalid_host')
        }

        // Bind persisted metadata to both the account/device scope and exact token.
        const routeKey = `native-ssh:route:${record.ownerUserId}:${record.matrixDeviceId}:${this.id}`
        this.routeKey = routeKey
        const token = await this.deps.system.token(this.id)
        let host: string

        if (token) {
          recoveryRequired = true
          const route = JSON.parse(this.deps.settings.getItem(routeKey) ?? 'null')

          if (!route || !nativeSshHost(route.host) || route.tokenDigest !== tokenDigest(token)) {
            // prepare rotates a connector; it is not a metadata GET. Retain the
            // credential for explicit disconnect/reconnect recovery instead.
            throw new Error('native_ssh_route_recovery_required')
          }

          recoveryRequired = false
          host = route.host
        } else {
          const prepared = await this.deps.call({ operation: 'ssh_prepare', deviceServiceId: this.id }) as Record<string, unknown>

          if (
            !prepared ||
            prepared.deviceServiceId !== this.id ||
            !nativeSshHost(prepared.host) ||
            typeof prepared.tunnelToken !== 'string' ||
            !/^[A-Za-z0-9+/_=.-]{1,16384}$(?![\s\S])/.test(prepared.tunnelToken)
          ) {
            throw new Error('invalid_prepare')
          }

          host = prepared.host
          await this.deps.system.saveToken(this.id, prepared.tunnelToken)
          this.deps.settings.setItem(routeKey, JSON.stringify({ host, tokenDigest: tokenDigest(prepared.tunnelToken) }))
        }

        const rows = await this.deps.call({ operation: 'ssh_authorized_keys', purposes: true })

        if (!Array.isArray(rows) || !rows.every(row => row && sshPublicKey(row.publicKey) && (row.purpose === undefined || row.purpose === 'shell' || row.purpose === 'relay'))) {
          throw new Error('invalid_keys')
        }

        if (rows.some(row => row.purpose === 'relay' && rows.some(other =>
            other.publicKey === row.publicKey && other.purpose !== 'relay'))) {
          throw new Error('relay_shell_key_collision')
        }

        const keys = rows.map(row => row.purpose === 'relay' ? {
          purpose: 'relay' as const, publicKey: row.publicKey,
          ownerPrincipal: this.deps.ownerPrincipal?.() ?? '', agentPrincipal: row.agentId,
          connectionEpoch: record.enrollmentEpoch
        } : row.publicKey)

        // Validate before replacing either purpose's block.
        for (const key of keys) { if (typeof key !== 'string') { relayKeyLine(key, '/validate') } }
        await this.deps.system.keys(keys)
        this.bindings = keys.filter((key): key is RelayAuthorizedKey => typeof key !== 'string')
        await this.deps.system.start(this.id)
        const epoch = `${this.id}:${record.enrollmentEpoch}:${host}:${ready.user}:${ready.hostKey}`

        if (this.enrolled !== epoch) {
          await this.deps.call({
            operation: 'ssh_enroll',
            deviceServiceId: this.id,
            enrollmentEpoch: record.enrollmentEpoch,
            host,
            user: ready.user,
            hostKey: ready.hostKey
          })
          this.enrolled = epoch
        }

        this.hintEnrollmentKey = this.enrollmentHintKey(record)
        this.view = {
          status: 'connected',
          settingsUrl: REMOTE_LOGIN_SETTINGS
        }
      } catch {
        // Never propagate HTTP/process errors: they may contain credentials.
        this.bindings = []
        await this.deps.system.keys([]).catch(() => undefined)
        await this.deps.system.stop().catch(() => undefined)
        this.enrolled = undefined
        this.view = { status: 'error', reason: recoveryRequired ? 'native_ssh_route_recovery_required' : 'native_ssh_setup_failed', settingsUrl: REMOTE_LOGIN_SETTINGS }
      }
    })
  }
  private async cleanup(): Promise<void> {
    this.bindings = []

    const results = await Promise.allSettled([
      this.id ? this.deps.call({ operation: 'ssh_revoke', deviceServiceId: this.id }) : Promise.resolve(),
      this.deps.system.stop(),
      this.deps.system.keys([]),
      Promise.resolve().then(() => {
        const record = this.deps.enrollment()
        const key = this.routeKey ?? (record && `native-ssh:route:${record.ownerUserId}:${record.matrixDeviceId}:${this.id}`)

        if (key) {
          this.deps.settings.setItem(key, 'null')
        }
      }),
      this.id ? this.deps.system.removeToken(this.id) : Promise.resolve()
    ])

    this.enrolled = undefined

    if (results.some(result => result.status === 'rejected')) {
      throw new Error('native_ssh_cleanup_pending')
    }

    this.routeKey = undefined
    this.id = undefined
  }
  disconnect(): Promise<void> {
    this.disconnected = true
    clearInterval(this.timer)
    this.timer = undefined

    return this.serial(async () => {
      this.id ??= this.deps.enrollment()?.deviceServiceId

      try {
        await this.cleanup()
        this.view = { status: 'tunnel_down', settingsUrl: REMOTE_LOGIN_SETTINGS }
      } catch {
        this.view = { status: 'error', reason: 'native_ssh_cleanup_pending', settingsUrl: REMOTE_LOGIN_SETTINGS }
        throw new Error('native_ssh_cleanup_pending')
      }
    })
  }
}
