import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { MATRIX_DEVICE_WAIT_LIMITS, MatrixDeviceWaitKernel } from './matrix-device-wait-kernel'

const contract = JSON.parse(
  readFileSync(new URL('../../../packages/device-protocol/fixtures/agent-turns/contract.json', import.meta.url), 'utf8')
) as {
  parameters: {
    device_step_progress_ms: number
    waiting_device_timeout_ms: number
    touch_id_timeout_ms: number
  }
}

describe('agent-turns/1.3 device-wait kernel', () => {
  it('uses the exact vendored contract bounds', () => {
    expect(MATRIX_DEVICE_WAIT_LIMITS).toEqual({
      progressMs: contract.parameters.device_step_progress_ms,
      unreachableTimeoutMs: contract.parameters.waiting_device_timeout_ms,
      touchIdTimeoutMs: contract.parameters.touch_id_timeout_ms
    })
  })

  it('cannot announce a wait before the router selects a real Mac', () => {
    const kernel = new MatrixDeviceWaitKernel()
    expect(kernel.unreachable(0)).toEqual({ action: 'none' })
    expect(kernel.requireTouchId(0)).toEqual({ action: 'none' })
    expect(kernel.current()).toBe('idle')
  })

  it('cannot start after the turn ends before routing', () => {
    const kernel = new MatrixDeviceWaitKernel()
    kernel.end()
    kernel.selectMac('Mac mini')
    expect(kernel.current()).toBe('ended')
    expect(kernel.start(0)).toEqual({ action: 'none' })
  })

  it('keeps an ordinary Mac step quiet until five seconds', () => {
    const kernel = new MatrixDeviceWaitKernel()
    kernel.selectMac('Mac mini')
    kernel.start(10_000)
    expect(kernel.tick(10_000 + MATRIX_DEVICE_WAIT_LIMITS.progressMs - 1)).toEqual({ action: 'none' })
    expect(kernel.tick(10_000 + MATRIX_DEVICE_WAIT_LIMITS.progressMs)).toMatchObject({
      action: 'progress', state: 'working', kind: 'device', device: 'Mac mini'
    })
    expect(kernel.tick(20_000)).toEqual({ action: 'none' })
  })

  it('names the selected Mac, expires an unreachable follow-up, and never says it waited in the past', () => {
    const kernel = new MatrixDeviceWaitKernel()
    kernel.selectMac('MacBook Air M2')
    kernel.start(0)
    const waiting = kernel.unreachable(2_000)
    expect(waiting).toMatchObject({
      action: 'progress', state: 'waiting_unreachable', phase: 'waiting', device: 'MacBook Air M2',
      expiresAt: 2_000 + MATRIX_DEVICE_WAIT_LIMITS.unreachableTimeoutMs
    })
    expect(kernel.tick(2_000 + MATRIX_DEVICE_WAIT_LIMITS.unreachableTimeoutMs - 1)).toEqual({ action: 'none' })
    expect(kernel.tick(2_000 + MATRIX_DEVICE_WAIT_LIMITS.unreachableTimeoutMs)).toMatchObject({
      action: 'expired', state: 'expired', device: 'MacBook Air M2'
    })
  })

  it('rejects a non-finite clock before entering an unreachable wait', () => {
    const kernel = new MatrixDeviceWaitKernel()
    kernel.selectMac('Mac mini')
    kernel.start(0)
    expect(kernel.unreachable(Number.NaN)).toEqual({ action: 'none' })
    expect(kernel.current()).toBe('working')
    expect(kernel.unreachable(1_000)).toMatchObject({ state: 'waiting_unreachable' })
  })

  it('resumes the same selected Mac after reconnect', () => {
    const kernel = new MatrixDeviceWaitKernel()
    kernel.selectMac('Mac mini')
    kernel.start(0)
    kernel.unreachable(1_000)
    expect(kernel.reconnect()).toMatchObject({ action: 'progress', state: 'resumed', device: 'Mac mini' })
    expect(kernel.start(2_000)).toEqual({ action: 'none' })
    expect(kernel.current()).toBe('working')
  })

  it('bounds Touch ID at sixty seconds and ignores every event after expiry', () => {
    const kernel = new MatrixDeviceWaitKernel()
    kernel.selectMac('Mac mini')
    kernel.start(0)
    const waiting = kernel.requireTouchId(500)
    expect(waiting).toMatchObject({ kind: 'touch_id', expiresAt: 500 + MATRIX_DEVICE_WAIT_LIMITS.touchIdTimeoutMs })
    expect(kernel.tick(500 + MATRIX_DEVICE_WAIT_LIMITS.touchIdTimeoutMs)).toMatchObject({
      action: 'expired', state: 'expired', kind: 'touch_id'
    })
    expect(kernel.approveTouchId()).toEqual({ action: 'none' })
    expect(kernel.start(100_000)).toEqual({ action: 'none' })
  })

  it('rejects a non-finite clock before entering a Touch ID wait', () => {
    const kernel = new MatrixDeviceWaitKernel()
    kernel.selectMac('Mac mini')
    kernel.start(0)
    expect(kernel.requireTouchId(Number.POSITIVE_INFINITY)).toEqual({ action: 'none' })
    expect(kernel.current()).toBe('working')
    expect(kernel.requireTouchId(500)).toMatchObject({ state: 'waiting_touch_id' })
  })
})
