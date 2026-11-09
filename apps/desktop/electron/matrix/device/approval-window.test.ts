import { describe, expect, it, vi } from 'vitest'

import { APPROVAL_WINDOW_MS, ApprovalWindow, OWNER_AWAY_MS } from './approval-window'
import type { ApprovalResult } from './approvals'
import type { DeviceProtectedCapability } from './contracts'
import { ASKING_CAPABILITIES, SILENT_CAPABILITIES } from './policy'

const approved = (hash = 'H'.repeat(43)): ApprovalResult =>
  ({ outcome: 'approved', record: {} as never, kid: 'k', sig: 's', approvalHash: hash })

const denied: ApprovalResult = { outcome: 'denied', reason: 'approval_denied' }

describe('ApprovalWindow', () => {
  it('asks once, then answers from the window for that agent and capability only', async () => {
    const window = new ApprovalWindow(() => 0)
    const ask = vi.fn(async () => approved())

    expect(await window.obtain('a', 'sudo', ask)).toMatchObject({ outcome: 'approved', leader: true, fromWindow: false })
    expect(await window.obtain('a', 'sudo', ask)).toMatchObject({ outcome: 'approved', leader: false, fromWindow: true })
    expect(ask).toHaveBeenCalledTimes(1)

    await window.obtain('b', 'sudo', ask)
    await window.obtain('a', 'keychain', ask)
    expect(ask).toHaveBeenCalledTimes(3)
  })

  it('expires after the window (30 minutes by default) and asks again', async () => {
    let now = 1_000
    const window = new ApprovalWindow(() => now)
    const ask = vi.fn(async () => approved())
    await window.obtain('a', 'keychain', ask)

    now += APPROVAL_WINDOW_MS - 1
    expect(window.covers('a', 'keychain')).not.toBeNull()

    now += 1
    expect(window.covers('a', 'keychain')).toBeNull()
    await window.obtain('a', 'keychain', ask)
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('after a sheet timed out with nobody there, the same ask is answered at once instead of raising another sheet', async () => {
    let now = 0
    const window = new ApprovalWindow(() => now)
    const timedOut: ApprovalResult = { outcome: 'denied', reason: 'approval_timeout' }
    const ask = vi.fn(async () => timedOut)

    expect(await window.obtain('a', 'keychain', ask)).toMatchObject({ outcome: 'denied', reason: 'approval_timeout', leader: true })
    expect(window.away('a', 'keychain')).toBe(true)

    // Retries while the owner is away: told so plainly, no new sheet.
    now += 60_000
    expect(await window.obtain('a', 'keychain', ask)).toMatchObject({ outcome: 'denied', reason: 'approval_timeout', leader: false })
    expect(ask).toHaveBeenCalledTimes(1)

    // Another agent or capability is not affected.
    expect(window.away('b', 'keychain')).toBe(false)
    expect(window.away('a', 'cloud_cli')).toBe(false)

    // The owner is given another chance after the away period, and an approval clears it for good.
    now += OWNER_AWAY_MS
    expect(window.away('a', 'keychain')).toBe(false)
    const approve = vi.fn(async () => approved())
    expect(await window.obtain('a', 'keychain', approve)).toMatchObject({ outcome: 'approved' })
    expect(window.away('a', 'keychain')).toBe(false)
  })

  it('a refusal (not a timeout) never marks the owner away', async () => {
    const window = new ApprovalWindow(() => 0)
    await window.obtain('a', 'keychain', async () => denied)
    expect(window.away('a', 'keychain')).toBe(false)
  })

  it('a standing grant made on the sheet answers the asking command and opens the window', async () => {
    const window = new ApprovalWindow(() => 0)
    const ask = vi.fn(async () => ({ outcome: 'approved' as const, approvalHash: 'G'.repeat(43), standingGrantId: 'grant-1' }))

    expect(await window.obtain('a', 'keychain', ask)).toMatchObject({ outcome: 'approved', approvalHash: 'G'.repeat(43), leader: true })
    expect(window.covers('a', 'keychain')).toBe('G'.repeat(43))
  })

  it('a denial opens no window', async () => {
    const window = new ApprovalWindow(() => 0)
    const ask = vi.fn(async () => denied)
    expect(await window.obtain('a', 'sudo', ask)).toMatchObject({ outcome: 'denied', leader: true })
    expect(window.covers('a', 'sudo')).toBeNull()
    await window.obtain('a', 'sudo', ask)
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('simultaneous callers share one prompt; only the first is the leader', async () => {
    const window = new ApprovalWindow(() => 0)
    let finish!: (result: ApprovalResult) => void
    const ask = vi.fn(() => new Promise<ApprovalResult>(resolve => (finish = resolve)))

    const first = window.obtain('a', 'sudo', ask)
    expect(window.asking('a', 'sudo')).toBe(true)
    const second = window.obtain('a', 'sudo', ask)
    finish(approved())

    expect(await first).toMatchObject({ outcome: 'approved', leader: true })
    expect(await second).toMatchObject({ outcome: 'approved', leader: false })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(window.asking('a', 'sudo')).toBe(false)
  })

  it('clear() (the Stop fence) ends every window and voids an approval that lands afterwards', async () => {
    const window = new ApprovalWindow(() => 0)
    await window.obtain('a', 'sudo', async () => approved())
    window.clear()
    expect(window.covers('a', 'sudo')).toBeNull()

    let finish!: (result: ApprovalResult) => void
    const late = window.obtain('a', 'keychain', () => new Promise<ApprovalResult>(resolve => (finish = resolve)))
    window.clear()
    finish(approved())
    await late
    expect(window.covers('a', 'keychain')).toBeNull()
  })
})

describe('the local approval policy', () => {
  it('puts every protected capability on exactly one side: silent or asking', () => {
    const all: DeviceProtectedCapability[] = [
      'ssh_agent', 'keychain', 'browser_store', 'cloud_cli', 'persistence', 'network_new_host', 'sudo',
      'other_agent_write', 'exec_downloaded', 'bulk_destructive', 'gui_upload'
    ]

    for (const capability of all) {
      expect(SILENT_CAPABILITIES.has(capability) !== ASKING_CAPABILITIES.has(capability), capability).toBe(true)
    }

    expect([...ASKING_CAPABILITIES].sort()).toEqual(['browser_store', 'bulk_destructive', 'cloud_cli', 'keychain', 'sudo'])
  })
})
