/** agent-turns/1.3 device-wait decisions; copy and Matrix publication stay with the host. */
export const MATRIX_DEVICE_WAIT_LIMITS = {
  progressMs: 5_000,
  unreachableTimeoutMs: 7_200_000,
  touchIdTimeoutMs: 60_000
} as const

export type MatrixDeviceWaitState =
  | 'idle'
  | 'routed'
  | 'working'
  | 'waiting_unreachable'
  | 'waiting_touch_id'
  | 'resumed'
  | 'expired'
  | 'ended'

export type MatrixDeviceWaitDecision =
  | { action: 'none' }
  | {
      action: 'progress' | 'expired'
      state: MatrixDeviceWaitState
      kind: 'device' | 'touch_id'
      phase: 'working' | 'waiting'
      device: string
      expiresAt?: number
    }

function deviceName(value: string): string | null {
  const clean = value
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .trim()

  return clean ? [...clean].slice(0, 80).join('') : null
}

export class MatrixDeviceWaitKernel {
  private state: MatrixDeviceWaitState = 'idle'
  private device?: string
  private workStartedAt?: number
  private expiresAt?: number
  private progressShown = false

  selectMac(name: string): MatrixDeviceWaitDecision {
    if (this.state !== 'idle') return { action: 'none' }
    const selected = deviceName(name)
    if (!selected) return { action: 'none' }
    this.device = selected
    this.state = 'routed'

    return { action: 'none' }
  }

  start(now: number): MatrixDeviceWaitDecision {
    if (!this.device || !['routed', 'resumed'].includes(this.state) || !Number.isFinite(now)) {
      return { action: 'none' }
    }

    this.state = 'working'
    this.workStartedAt = now
    this.expiresAt = undefined
    this.progressShown = false

    return { action: 'none' }
  }

  tick(now: number): MatrixDeviceWaitDecision {
    if (!this.device || !Number.isFinite(now)) return { action: 'none' }

    if (this.state === 'working' && !this.progressShown && this.workStartedAt !== undefined && now - this.workStartedAt >= MATRIX_DEVICE_WAIT_LIMITS.progressMs) {
      this.progressShown = true

      return { action: 'progress', state: this.state, kind: 'device', phase: 'working', device: this.device }
    }

    if (['waiting_unreachable', 'waiting_touch_id'].includes(this.state) && this.expiresAt !== undefined && now >= this.expiresAt) {
      const kind = this.state === 'waiting_touch_id' ? 'touch_id' : 'device'
      this.state = 'expired'

      return { action: 'expired', state: this.state, kind, phase: 'waiting', device: this.device }
    }

    return { action: 'none' }
  }

  unreachable(now: number): MatrixDeviceWaitDecision {
    if (this.state !== 'working' || !this.device || !Number.isFinite(now)) return { action: 'none' }
    this.state = 'waiting_unreachable'
    this.expiresAt = now + MATRIX_DEVICE_WAIT_LIMITS.unreachableTimeoutMs

    return {
      action: 'progress', state: this.state, kind: 'device', phase: 'waiting',
      device: this.device, expiresAt: this.expiresAt
    }
  }

  requireTouchId(now: number): MatrixDeviceWaitDecision {
    if (this.state !== 'working' || !this.device || !Number.isFinite(now)) return { action: 'none' }
    this.state = 'waiting_touch_id'
    this.expiresAt = now + MATRIX_DEVICE_WAIT_LIMITS.touchIdTimeoutMs

    return {
      action: 'progress', state: this.state, kind: 'touch_id', phase: 'waiting',
      device: this.device, expiresAt: this.expiresAt
    }
  }

  reconnect(): MatrixDeviceWaitDecision {
    if (this.state !== 'waiting_unreachable' || !this.device) return { action: 'none' }
    this.state = 'resumed'
    this.expiresAt = undefined

    return { action: 'progress', state: this.state, kind: 'device', phase: 'working', device: this.device }
  }

  approveTouchId(): MatrixDeviceWaitDecision {
    if (this.state !== 'waiting_touch_id' || !this.device) return { action: 'none' }
    this.state = 'resumed'
    this.expiresAt = undefined

    return { action: 'progress', state: this.state, kind: 'touch_id', phase: 'working', device: this.device }
  }

  end(): MatrixDeviceWaitDecision {
    if (['expired', 'ended'].includes(this.state)) return { action: 'none' }
    this.state = 'ended'
    this.expiresAt = undefined

    return { action: 'none' }
  }

  current(): MatrixDeviceWaitState {
    return this.state
  }
}
