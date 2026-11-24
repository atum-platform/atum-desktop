import { createHash } from 'node:crypto'

import type { MatrixNativeSshView as NativeSshView, MatrixNativeSshSetupStep as SetupStep } from '../../../shared/matrix-native-mac'

/** Native Hermes SSH route. No device frames or tool schemas are involved. */
import { type DeviceEnrollmentRecord, DeviceRegistryError } from './enrollment'

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
  | { operation: 'ssh_authorized_keys' }
export interface NativeSshSystem {
  ready(): Promise<{ remoteLogin: boolean; user: string; hostKey: string }>
  enableRemoteLogin(): Promise<void>
  token(id: string): Promise<string | null>
  saveToken(id: string, token: string): Promise<void>
  removeToken(id: string): Promise<void>
  start(id: string): Promise<void>
  stop(): Promise<void>
  keys(keys: string[]): Promise<void>
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

// Platform default: prefix + opaque registry label + suffix; never derive from UUID.
export function nativeSshHost(value: unknown): value is string {
  return typeof value === 'string' && /^mac-[a-f0-9]{32}\.atumplatform\.com$(?![\s\S])/.test(value)
}

const tokenDigest = (token: string) => createHash('sha256').update(token).digest('hex')

const OS_CODES = new Set(['EACCES', 'EEXIST', 'EIO', 'ENOENT', 'ENOSPC', 'ENOTDIR', 'EPERM', 'EROFS', 'ETIMEDOUT'])

const SETUP_CODES = new Set([
  'invalid_device',
  'invalid_host',
  'invalid_keys',
  'invalid_prepare',
  'invalid_ssh_block',
  'invalid_ssh_key',
  'matrix_s1_authentication',
  'native_ssh_cleanup_pending',
  'native_ssh_file_failed',
  'native_ssh_route_recovery_required',
  'native_ssh_symlink',
  'tunnel_stop_failed'
])

const REGISTRY_REASONS = new Set(['invalid', 'mac_route_unavailable'])

/** Allow fixed codes only. Even a short error message or registry reason can contain a secret. */
function nativeSshFailureCode(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'unknown'
  }

  if (error instanceof DeviceRegistryError && (error.status === 0 || (Number.isInteger(error.status) && error.status >= 100 && error.status <= 599))) {
    const reason = error.reason && REGISTRY_REASONS.has(error.reason) ? `_${error.reason}` : ''

    return `device_registry_${error.status}${reason}`
  }

  const code = (error as NodeJS.ErrnoException).code

  if (code && OS_CODES.has(code)) {
    return code
  }

  return SETUP_CODES.has(error.message) ? error.message : 'unknown'
}

const BEGIN = '# BEGIN ATUM MANAGED SSH KEYS'
const END = '# END ATUM MANAGED SSH KEYS'

/** Preserve all bytes outside the block; refuse ambiguous/corrupt markers. */
export function managedKeys(current: string, keys: string[], command?: (key: string) => string): string {
  if (!keys.every(sshPublicKey)) {
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

  if (command && keys.some(key => /[\r\n\0]/.test(command(key)))) {
    throw new Error('invalid_ssh_key')
  }

  const block = keys.length
    ? `${BEGIN}\n${[...new Set(keys)].map(key => `no-agent-forwarding,no-port-forwarding,no-X11-forwarding${command ? `,no-user-rc,command="${command(key).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : ''} ${key}`).join('\n')}\n${END}\n`
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
      enrollment(): DeviceEnrollmentRecord | null
      call(body: NativeSshRequest): Promise<unknown>
      setPlanFactsEnabled?(deviceServiceId: string, enabled: boolean): Promise<void>
      system: NativeSshSystem
      settings: {
        getItem(key: string): string | null
        setItem(key: string, value: string): void
      }
      /** The main log; overridden only in tests. */
      log?(line: string): void
    }
  ) {}
  private log(line: string): void {
    if (this.deps.log) {
      this.deps.log(line)
    } else {
      console.warn(`[Matrix] ${line}`)
    }
  }
  status(): NativeSshView {
    this.syncAccountScope(this.deps.enrollment())
    const acknowledged = this.hintEnrollmentKey && this.deps.settings.getItem(this.hintEnrollmentKey) === 'acknowledged'

    return {
      ...this.view,
      status: ['connected', 'set_up'].includes(this.view.status) && !acknowledged ? 'needs_full_disk_access_hint' : this.view.status
    }
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn)
    this.chain = result.catch(() => undefined)

    return result
  }
  private syncAccountScope(record: DeviceEnrollmentRecord | null): void {
    if (!record) {
      return
    }

    const scope = `${record.ownerUserId}:${record.matrixDeviceId}`

    if (scope !== this.accountScope) {
      const saved = this.deps.settings.getItem(this.disconnectKey(scope))

      this.accountScope = scope
      this.disconnected = saved === 'off' || saved === 'cleanup_pending'

      if (saved === 'cleanup_pending') {
        this.view = this.cleanupPendingView()
      } else if (this.disconnected || this.view.status === 'not_connected' || this.view.reason === 'native_ssh_cleanup_pending') {
        this.view = { status: this.disconnected ? 'not_connected' : 'tunnel_down', settingsUrl: REMOTE_LOGIN_SETTINGS }
      }
    }
  }
  private disconnectKey(scope: string): string {
    return `native-ssh:connection:${scope}`
  }
  async start(explicit = false): Promise<void> {
    await this.serial(async () => {
      const record = this.deps.enrollment()

      this.syncAccountScope(record)

      if (explicit && this.disconnected) {
        if (this.view.reason === 'native_ssh_cleanup_pending') {
          return
        }

        if (record && this.accountScope) {
          const key = this.disconnectKey(this.accountScope)

          if (this.deps.settings.getItem(key) === 'off') {
            try {
              await this.deps.setPlanFactsEnabled?.(record.deviceServiceId, true)
              this.deps.settings.setItem(key, 'on')
            } catch {
              throw new Error('native_ssh_reconnect_pending')
            }
          }
        }

        this.disconnected = false
      }

      if (!this.disconnected) {
        this.timer ??= setInterval(() => {
          void this.refresh()
        }, 60_000)
        this.timer.unref?.()
      }
    })

    return this.refresh()
  }
  /** Only an explicit UI action may invoke the macOS administrator prompt. */
  enableRemoteLogin(): Promise<void> {
    return this.serial(async () => {
      try {
        await this.deps.system.enableRemoteLogin()
      } catch {
        throw new Error('native_ssh_remote_login_failed')
      }
    }).then(() => this.start(true))
  }
  fullDiskAccessHint(): NativeSshView {
    return this.status()
  }
  /** Acknowledge only the enrollment whose successful setup offered the reminder. */
  acknowledgeFullDiskAccessHint(): void {
    const record = this.deps.enrollment()

    if (
      ['connected', 'set_up'].includes(this.view.status) &&
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
      let step: SetupStep = 'prepare'

      try {
        const record = this.deps.enrollment()

        this.syncAccountScope(record)

        if (this.disconnected) {
          if (this.id && record && this.id !== record.deviceServiceId) {
            await this.cleanup()
          }

          return
        }

        if (!record || record.state !== 'active') {
          if (this.id) {
            await this.cleanup()
          } else {
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

        step = 'authorized_keys'
        const rows = await this.deps.call({ operation: 'ssh_authorized_keys' })

        // The plain platform projection is shell-only. Tolerate extra purpose rows from
        // older servers without installing their keys or destroying a working tunnel.
        if (!Array.isArray(rows)) { throw new Error('invalid_keys') }

        const shell = rows.filter(row => {
          if (row && typeof row === 'object' && row.purpose !== undefined && row.purpose !== 'shell') {
            this.log('native-ssh ignored non-shell authorized key row')

            return false
          }

          return true
        })

        if (!shell.every(row => row && sshPublicKey(row.publicKey))) { throw new Error('invalid_keys') }
        const keys = shell.map(row => row.publicKey)

        step = 'write_keys'
        await this.deps.system.keys(keys)
        step = 'start_tunnel'
        await this.deps.system.start(this.id)
        const epoch = `${this.id}:${record.enrollmentEpoch}:${host}:${ready.user}:${ready.hostKey}`

        if (this.enrolled !== epoch) {
          step = 'enroll'
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
          status: 'set_up',
          settingsUrl: REMOTE_LOGIN_SETTINGS
        }
      } catch (error) {
        // Never propagate HTTP/process errors: they may contain credentials.
        const code = recoveryRequired ? 'native_ssh_route_recovery_required' : nativeSshFailureCode(error)

        this.log(`native-ssh setup failed at ${step}: ${code}`)
        await this.deps.system.keys([]).catch(() => undefined)
        await this.deps.system.stop().catch(() => undefined)
        this.enrolled = undefined
        this.view = {
          status: 'error',
          reason: recoveryRequired ? 'native_ssh_route_recovery_required' : 'native_ssh_setup_failed',
          step,
          code,
          settingsUrl: REMOTE_LOGIN_SETTINGS
        }
      }
    })
  }
  private async cleanup(): Promise<void> {

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
  private cleanupPendingView(): NativeSshView {
    return {
      status: 'error',
      reason: 'native_ssh_cleanup_pending',
      code: 'native_ssh_cleanup_pending',
      settingsUrl: REMOTE_LOGIN_SETTINGS
    }
  }
  disconnect({ accountConnection = false } = {}): Promise<void> {
    return this.serial(async () => {
      const record = this.deps.enrollment()

      this.syncAccountScope(record)
      this.disconnected = true
      clearInterval(this.timer)
      this.timer = undefined
      this.id ??= record?.deviceServiceId

      try {
        const key = accountConnection && this.accountScope ? this.disconnectKey(this.accountScope) : undefined

        const results = await Promise.allSettled([
          Promise.resolve().then(() => {
            if (key) {
              this.deps.settings.setItem(key, 'cleanup_pending')
            }
          }),
          Promise.resolve().then(() => this.cleanup()),
          Promise.resolve().then(() => {
            if (accountConnection && record) {
              return this.deps.setPlanFactsEnabled?.(record.deviceServiceId, false)
            }
          })
        ])

        if (results.some(result => result.status === 'rejected')) {
          throw new Error('native_ssh_cleanup_pending')
        }

        if (key) {
          this.deps.settings.setItem(key, 'off')
        }

        this.view = { status: 'not_connected', settingsUrl: REMOTE_LOGIN_SETTINGS }
      } catch {
        this.view = this.cleanupPendingView()
        throw new Error('native_ssh_cleanup_pending')
      }
    })
  }
}
