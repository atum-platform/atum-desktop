import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { NativeConnector } from './native'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const root = () => { const path = mkdtempSync(join(tmpdir(), 'native-host-')); roots.push(path); return path }
const grant = (agent: string, mac = 'mac') => ({ clientId: `client-${agent}`, enabled: true,
  expiresAt: Date.now() + 86400_000, binding: { owner: 'owner', agent, mac, generation: '1', consent_revision: 1 } })

it('routes each agent and refuses foreign Macs and account changes', async () => {
  let live = true
  const calls: string[] = []
  const native = new NativeConnector(root(), 'mac', { current: () => live,
    agents: async () => ['a', 'b'], request: async (agent, path) => {
      calls.push(`${agent}${path}`)
      return path === '/native-consent' ? { grants: [grant(agent), grant('foreign', 'other')] } : { agent }
    } })
  expect((await native.consent()).grants).toHaveLength(2)
  expect(native.renewal()).toBe('soon')
  expect(await native.handle('/tools', 'POST', { binding: grant('b').binding })).toEqual({ agent: 'b' })
  await expect(native.handle('/tools', 'POST', { binding: grant('a', 'other').binding })).rejects.toThrow('foreign')
  live = false
  await expect(native.handle('/tools', 'POST', { binding: grant('a').binding })).rejects.toThrow('account_changed')
  expect(calls).toContain('b/tools')
})

it('retains revoked client membership across restarts and isolates an unavailable profile', async () => {
  const directory = root()
  let offline = false
  const ports = { current: () => true, agents: async () => ['a', 'b'],
    request: async (agent: string) => {
      if (offline && agent === 'a') {throw new Error('offline')}
      return { grants: [grant(agent)] }
    } }
  const native = new NativeConnector(directory, 'mac', ports)
  await native.consent()
  offline = true
  const rows = (await native.consent()).grants
  expect(rows.find(row => row.clientId === 'client-a')?.enabled).toBe(false)
  expect(rows.find(row => row.clientId === 'client-b')?.enabled).toBe(true)
  native.revoke()
  expect(JSON.parse(readFileSync(native.forwardFile, 'utf8')).every((row: { enabled: boolean }) => !row.enabled)).toBe(true)
  const restarted = new NativeConnector(directory, 'mac', ports)
  expect(JSON.parse(readFileSync(restarted.forwardFile, 'utf8'))).toHaveLength(2)
  expect(restarted.renewal()).toBe('needed')
})

it('keeps the local Mac switch off even when S2 still reports an enabled grant', async () => {
  let enabled = true
  const native = new NativeConnector(root(), 'mac', { current: () => true, enabled: () => enabled,
    agents: async () => ['a'], request: async () => ({ grants: [{ ...grant('a'), sessionExpiresAt: Date.now() + 30 * 86400_000 }] }) })
  await native.consent()
  expect(native.renewal()).toBe('current')
  enabled = false
  native.revoke()
  expect(native.renewal()).toBe('current')
  expect((await native.consent()).grants[0]?.enabled).toBe(false)
  await expect(native.handle('/tools', 'POST', { binding: grant('a').binding })).rejects.toThrow('disabled')
  enabled = true
  expect((await native.consent()).grants[0]?.enabled).toBe(true)
})
