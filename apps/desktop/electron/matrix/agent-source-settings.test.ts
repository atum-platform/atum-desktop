import { expect, it, vi } from 'vitest'

import type { AgentSourceGates } from '../../../../packages/device-protocol/agent-source-gates'
import { MATRIX_AGENT_SOURCES_IPC } from '../../shared/matrix-agent-sources'

import {
  type MatrixAccountSourceFacts,
  MatrixAgentSourceSettings,
  type MatrixAgentSourceSettingsDependencies,
  registerMatrixAgentSourcesIpc
} from './agent-source-settings'

const accountA = { accountKey: 'a'.repeat(64), generation: 1 }

const allOn = (): AgentSourceGates => ({
  google: true,
  folders: true,
  messages: true,
  browser: true,
  location: true,
  team_spaces: true
})

const macFacts = (overrides: Partial<MatrixAccountSourceFacts> = {}): MatrixAccountSourceFacts => ({
  mac: true,
  fullDisk: 'granted',
  googleConnected: true,
  ...overrides
})

function harness(overrides: Partial<MatrixAgentSourceSettingsDependencies> = {}) {
  let gates = allOn()
  let facts = macFacts()
  let scope: { accountKey: string; generation: number } | null = accountA
  const order: string[] = []

  const settings = new MatrixAgentSourceSettings({
    scope: () => scope,
    gates: () => ({ ...gates }),
    facts: () => facts,
    commit: (gate, enabled) => {
      order.push(`commit:${gate}:${enabled}`)
      gates = { ...gates, [gate]: enabled }

      return gates
    },
    sync: () => void order.push('sync'),
    ...overrides
  })

  return {
    settings,
    order,
    setGates: (next: AgentSourceGates) => void (gates = next),
    setFacts: (next: MatrixAccountSourceFacts) => void (facts = next),
    setScope: (next: typeof scope) => void (scope = next)
  }
}

it('shows the account choice exactly, whatever the source can do on this Mac', async () => {
  const h = harness()
  h.setGates({ ...allOn(), messages: false })
  h.setFacts(macFacts({ mac: false, fullDisk: 'not-granted', googleConnected: false }))

  const view = await h.settings.read()

  // Availability never flips a switch: every gate is the saved account record.
  expect(view.gates).toEqual({ ...allOn(), messages: false })
  expect(view.sources.map(source => [source.optOutGate, source.status])).toEqual([
    ['google', 'not_connected'],
    ['folders', 'needs_mac'],
    ['messages', 'needs_mac'],
    ['browser', 'needs_mac'],
    ['location', 'needs_mac'],
    ['team_spaces', 'ready']
  ])
})

it('says what works where today: Mac-only reads, a missing permission, a missing connection', async () => {
  const h = harness()
  h.setFacts(macFacts({ fullDisk: 'not-granted', googleConnected: false }))

  const byGate = Object.fromEntries((await h.settings.read()).sources.map(source => [source.optOutGate, source]))

  expect(byGate.google).toMatchObject({ status: 'not_connected', grantable: true })
  expect(byGate.folders).toMatchObject({ status: 'ready', grantable: true })
  expect(byGate.messages).toMatchObject({ status: 'needs_permission', permission: 'fullDisk', grantable: true })
  expect(byGate.browser).toMatchObject({ status: 'needs_permission', permission: 'fullDisk', grantable: true })
  expect(byGate.location).toMatchObject({ status: 'mac_only', grantable: true })
  expect(byGate.team_spaces).toMatchObject({ status: 'ready', grantable: true })

  h.setFacts(macFacts())
  const granted = Object.fromEntries((await h.settings.read()).sources.map(source => [source.optOutGate, source]))
  expect(granted.messages).toMatchObject({ status: 'mac_only' })
  expect(granted.messages).not.toHaveProperty('permission')
  expect(granted.google).toMatchObject({ status: 'ready' })
})

it('revokes locally before starting the full-snapshot synchronizer and answers from the saved record', async () => {
  const h = harness()

  const view = await h.settings.set('folders', false)

  expect(h.order).toEqual(['commit:folders:false', 'sync'])
  expect(view.gates.folders).toBe(false)
})

it('lets the owner turn a switch on even where the source cannot work yet', async () => {
  const h = harness()
  h.setGates({ ...allOn(), messages: false })
  h.setFacts(macFacts({ fullDisk: 'not-granted' }))

  const view = await h.settings.set('messages', true)

  expect(view.gates.messages).toBe(true)
  expect(view.sources.find(source => source.optOutGate === 'messages')?.status).toBe('needs_permission')
})

it('confirms from the authoritative record, not from what the caller asked for', async () => {
  // A commit that the store normalises (here: refuses to open) must be reported as saved.
  const h = harness({ commit: () => allOn() })
  h.setGates({ ...allOn(), browser: false })

  const view = await h.settings.set('browser', true)

  expect(view.gates.browser).toBe(false)
})

it('needs no assistant: reads and writes work with no chat or assistant selected', async () => {
  const h = harness()

  await expect(h.settings.read()).resolves.toMatchObject({ gates: allOn() })
  await expect(h.settings.set('location', false)).resolves.toMatchObject({ gates: { location: false } })
})

it('fences only an account change, never anything about the open chat', async () => {
  const h = harness({
    commit: () => {
      h.setScope({ accountKey: 'b'.repeat(64), generation: 1 })

      return allOn()
    }
  })

  await expect(h.settings.set('folders', false)).rejects.toThrow('matrix_agent_sources_stale')
  h.setScope(null)
  await expect(h.settings.read()).rejects.toThrow('matrix_agent_sources_unavailable')
})

it('rejects gates outside the account record', async () => {
  const h = harness()

  await expect(h.settings.set('private' as never, true)).rejects.toThrow('matrix_agent_sources_invalid_request')
  expect(h.order).toEqual([])
})

it('exposes a fixed trusted bridge with no account or assistant selector', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const assertTrusted = vi.fn()
  const settings = { read: vi.fn(async () => ({ gates: allOn(), sources: [] })), set: vi.fn() }

  registerMatrixAgentSourcesIpc({ handle: (name, handler) => void handlers.set(name, handler) } as never, {
    assertTrusted,
    settings: settings as never
  })

  const event = { sender: {} } as never
  await expect(handlers.get(MATRIX_AGENT_SOURCES_IPC.read)!(event)).resolves.toMatchObject({ sources: [] })
  settings.set.mockResolvedValueOnce({ gates: { ...allOn(), folders: false }, sources: [] })
  await expect(handlers.get(MATRIX_AGENT_SOURCES_IPC.set)!(event, 'folders', false)).resolves.toMatchObject({
    gates: { folders: false }
  })
  expect(settings.set).toHaveBeenCalledExactlyOnceWith('folders', false)
  expect(() => handlers.get(MATRIX_AGENT_SOURCES_IPC.read)!(event, '00000000-0000-4000-8000-c35136147a93')).toThrow(
    'matrix_agent_sources_invalid_request'
  )
  expect(() => handlers.get(MATRIX_AGENT_SOURCES_IPC.set)!(event, 'private', false)).toThrow(
    'matrix_agent_sources_invalid_request'
  )
  expect(() => handlers.get(MATRIX_AGENT_SOURCES_IPC.set)!(event, 'folders', 'off')).toThrow(
    'matrix_agent_sources_invalid_request'
  )
  expect(assertTrusted).toHaveBeenCalledTimes(5)
})
