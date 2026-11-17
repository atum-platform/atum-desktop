/** Native Hermes SSH route. No device frames or tool schemas are involved. */
import type { DeviceEnrollmentRecord } from './enrollment'

export const REMOTE_LOGIN_SETTINGS =
  'x-apple.systempreferences:com.apple.Sharing-Settings.extension?Services_RemoteLogin'
export type NativeSshStatus =
  'connected' | 'needs_remote_login' | 'needs_full_disk_access_hint' | 'tunnel_down' | 'error'
export interface NativeSshView {
  status: NativeSshStatus
  settingsUrl: string
  reason?: string
}
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
  healthy(): Promise<boolean>
  keys(keys: string[]): Promise<void>
}
export function sshPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(value)) return false
  const bytes = Buffer.from(value.slice(12), 'base64')
  return (
    bytes.length === 51 &&
    bytes.readUInt32BE(0) === 11 &&
    bytes.subarray(4, 15).toString() === 'ssh-ed25519' &&
    bytes.readUInt32BE(15) === 32
  )
}
const BEGIN = '# BEGIN ATUM MANAGED SSH KEYS'
const END = '# END ATUM MANAGED SSH KEYS'
/** Preserve all bytes outside the block; refuse ambiguous/corrupt markers. */
export function managedKeys(current: string, keys: string[]): string {
  if (!keys.every(sshPublicKey)) throw new Error('invalid_ssh_key')
  const begin = current.indexOf(BEGIN),
    end = current.indexOf(END)
  if (
    begin < 0 !== end < 0 ||
    (begin >= 0 &&
      (end < begin ||
        current.indexOf(BEGIN, begin + 1) >= 0 ||
        current.indexOf(END, end + 1) >= 0 ||
        (begin > 0 && current[begin - 1] !== '\n')))
  )
    throw new Error('invalid_ssh_block')
  const block = keys.length
    ? `${BEGIN}\n${[...new Set(keys)].map(key => `no-agent-forwarding,no-port-forwarding,no-X11-forwarding ${key}`).join('\n')}\n${END}\n`
    : ''
  if (begin < 0) return current + (block && current && !current.endsWith('\n') ? '\n' : '') + block
  const tail = end + END.length
  if (current[tail] && current[tail] !== '\n') throw new Error('invalid_ssh_block')
  return current.slice(0, begin) + block + current.slice(tail + (current[tail] === '\n' ? 1 : 0))
}

export class NativeMacSsh {
  private view: NativeSshView = { status: 'tunnel_down', settingsUrl: REMOTE_LOGIN_SETTINGS }
  private chain: Promise<unknown> = Promise.resolve()
  private timer?: ReturnType<typeof setInterval>
  private id?: string
  private enrolled?: string
  private disconnected = false
  private accountScope?: string
  constructor(
    private readonly deps: {
      enrollment(): DeviceEnrollmentRecord | null
      call(body: NativeSshRequest): Promise<unknown>
      system: NativeSshSystem
    }
  ) {}
  status(): NativeSshView {
    return { ...this.view }
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn)
    this.chain = result.catch(() => undefined)
    return result
  }
  start(explicit = false): Promise<void> {
    const record = this.deps.enrollment()
    const scope = record ? `${record.ownerUserId}:${record.matrixDeviceId}` : undefined
    if (scope && this.accountScope && scope !== this.accountScope) this.disconnected = false
    this.accountScope = scope ?? this.accountScope
    if (explicit) this.disconnected = false
    if (this.disconnected) return Promise.resolve()
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
    this.view = { status: 'needs_full_disk_access_hint', settingsUrl: REMOTE_LOGIN_SETTINGS }
    return this.status()
  }
  refresh(): Promise<void> {
    return this.serial(async () => {
      try {
        const record = this.deps.enrollment()
        if (!record || record.state !== 'active') {
          if (this.id) await this.cleanup()
          else {
            await this.deps.system.keys([])
            await this.deps.system.stop()
          }
          this.view = { status: 'error', settingsUrl: REMOTE_LOGIN_SETTINGS }
          return
        }
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.deviceServiceId))
          throw new Error('invalid_device')
        if (this.id && this.id !== record.deviceServiceId) await this.cleanup()
        this.id = record.deviceServiceId
        const ready = await this.deps.system.ready()
        if (!ready.remoteLogin) {
          await this.deps.system.keys([])
          await this.deps.system.stop()
          this.enrolled = undefined
          this.view = { status: 'needs_remote_login', settingsUrl: REMOTE_LOGIN_SETTINGS }
          return
        }
        if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(ready.user) || !sshPublicKey(ready.hostKey))
          throw new Error('invalid_host')
        const host = `${this.id}.mac.atumplatform.com`
        if (!(await this.deps.system.token(this.id))) {
          const prepared = (await this.deps.call({ operation: 'ssh_prepare', deviceServiceId: this.id })) as Record<
            string,
            unknown
          >
          if (
            prepared.deviceServiceId !== this.id ||
            prepared.host !== host ||
            typeof prepared.tunnelToken !== 'string' ||
            !/^[A-Za-z0-9+/_=.-]{1,16384}$/.test(prepared.tunnelToken)
          )
            throw new Error('invalid_prepare')
          await this.deps.system.saveToken(this.id, prepared.tunnelToken)
        }
        const rows = await this.deps.call({ operation: 'ssh_authorized_keys' })
        if (
          !Array.isArray(rows) ||
          !rows.every(
            row =>
              row &&
              typeof row.agentId === 'string' &&
              Number.isSafeInteger(row.updatedAt) &&
              sshPublicKey(row.publicKey)
          )
        )
          throw new Error('invalid_keys')
        await this.deps.system.keys(rows.map(row => row.publicKey))
        if (!(await this.deps.system.healthy())) await this.deps.system.start(this.id)
        const epoch = `${this.id}:${record.enrollmentEpoch}:${ready.user}:${ready.hostKey}`
        if (this.enrolled !== epoch) {
          const response = (await this.deps.call({
            operation: 'ssh_enroll',
            deviceServiceId: this.id,
            enrollmentEpoch: record.enrollmentEpoch,
            host,
            user: ready.user,
            hostKey: ready.hostKey
          })) as Record<string, any>
          if (
            response.deviceServiceId !== this.id ||
            response.nativeSsh?.host !== host ||
            response.nativeSsh?.user !== ready.user ||
            response.nativeSsh?.epoch !== record.enrollmentEpoch ||
            response.nativeSsh?.knownHost !== ready.hostKey
          )
            throw new Error('invalid_enroll')
          this.enrolled = epoch
        }
        this.view = {
          status: (await this.deps.system.healthy()) ? 'connected' : 'tunnel_down',
          settingsUrl: REMOTE_LOGIN_SETTINGS
        }
      } catch {
        // Never propagate HTTP/process errors: they may contain credentials.
        await this.deps.system.keys([]).catch(() => undefined)
        await this.deps.system.stop().catch(() => undefined)
        this.enrolled = undefined
        this.view = { status: 'error', reason: 'native_ssh_setup_failed', settingsUrl: REMOTE_LOGIN_SETTINGS }
      }
    })
  }
  private async cleanup(): Promise<void> {
    const results = await Promise.allSettled([
      this.id ? this.deps.call({ operation: 'ssh_revoke', deviceServiceId: this.id }) : Promise.resolve(),
      this.deps.system.stop(),
      this.deps.system.keys([]),
      this.id ? this.deps.system.removeToken(this.id) : Promise.resolve()
    ])
    this.enrolled = undefined
    if (results.some(result => result.status === 'rejected')) throw new Error('native_ssh_cleanup_pending')
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
