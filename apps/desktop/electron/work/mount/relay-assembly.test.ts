import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import type { MatrixAgentDefinitionSnapshot } from '../../matrix/agent-definition'
import type { T3Port, WorkPlatform } from '../gate/ports'
import { WorkSync } from '../gate/sync'
import { ACCOUNT, DEVICE, type Harness, LUNA, makeHarness } from '../gate/test-support'

import { claudeRelaySettings, RELAY_INSTRUCTION_FILES, RelayAssembly, relayProtectedRoots } from './relay-assembly'

let h: Harness
let root: string
afterEach(async () => {
  await h?.cleanup()

  if (root) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  h = makeHarness()
  root = mkdtempSync(join(tmpdir(), 'relay-home-'))
  let revision = 1
  let now = 100_000
  const projects: { id: string; workspaceRoot: string }[] = []

  const createProject = vi.fn(async (_token: string, input: { title: string; workspaceRoot: string }) => {
    const project = { ...input, id: `assistant-project-${projects.length + 1}` }
    projects.push(project)

    return { transport: 'ok' as const, status: 200, data: project }
  })

  const options = {
    ledger: h.ledger,
    assistantsRoot: join(root, 'Assistants'),
    definition: async () =>
      ({
        assistant: { id: LUNA, principal: LUNA, status: 'active', displayName: 'Assistant' },
        definitionRevision: revision,
        definition: { soul: `Persona ${revision}` }
      }) as MatrixAgentDefinitionSnapshot,
    ownerToken: async () => 'decoy-owner',
    fresh: () => true,
    now: () => now,
    t3: {
      projects: async () => ({ transport: 'ok', status: 200, data: { projects, nextCursor: null } }),
      createProject
    } as unknown as T3Port
  }

  return {
    assembly: new RelayAssembly(options),
    options,
    createProject,
    revision: (v: number) => {
      revision = v
    },
    now: (v: number) => {
      now = v
    }
  }
}

const page = () => ({
  accountId: ACCOUNT,
  deviceServiceId: DEVICE,
  issuedAt: 100_000,
  fromSeq: 0,
  headSeq: 0,
  entitled: [LUNA],
  changes: [],
  hasMore: false,
  consent: {
    provider: 'codex' as const,
    state: 'on' as const,
    revision: 2,
    agents: [LUNA],
    alsoWhenScheduled: false,
    grantedAt: 1
  },
  selections: [
    { agentPrincipal: LUNA, selection: { provider: 'atum-work', plan: 'codex', model: 'test', revision: 7 } }
  ]
})

function sync(platform: Partial<WorkPlatform>) {
  return new WorkSync({
    gate: h.gate,
    ledger: h.ledger,
    platform: {
      ack: async () => {},
      macEvent: async () => {},
      carryGrant: async () => {},
      ...platform
    } as WorkPlatform,
    accountId: ACCOUNT,
    deviceServiceId: DEVICE,
    socketPath: () => '',
    now: () => 100_000
  })
}

it('applies selection and consent before ack; a stale selection reads disconnected', async () => {
  const f = fixture()

  const ack = vi.fn(async () => {
    expect(h.ledger.consent()?.revision).toBe(2)
    expect(f.assembly.selection(LUNA)?.revision).toBe(7)
  })

  const client = sync({
    pull: async input => {
      expect(input.contract).toBe('1.3')

      return page()
    },
    ack
  })

  expect(await client.tick()).toBe('ok')
  expect(ack).toHaveBeenCalledOnce()
  f.now(100_000 + 24 * 3600_000)
  expect(f.assembly.selection(LUNA)).toBeUndefined()
  f.now(100_000)
  expect(new RelayAssembly({ ...f.options, fresh: () => false }).selection(LUNA)).toBeUndefined()
})
it('falls back to 1.2 on explicit 400 and clears the old relay choice', async () => {
  fixture()
  h.ledger.setMeta('relay_selections', '[{}]')
  const pulls: unknown[] = []

  const client = sync({
    pull: async input => {
      pulls.push(input.contract)

      if (input.contract === '1.3') {
        throw Object.assign(new Error('unsupported'), { status: 400 })
      }

      const { selections: _selections, ...legacy } = page()

      return legacy
    }
  })

  expect(await client.tick()).toBe('ok')
  expect(pulls).toEqual(['1.3', '1.2'])
  expect(h.ledger.meta('relay_selections')).toBe('[]')
})
it('rejects a regressed snapshot without restoring connection', async () => {
  const f = fixture()
  const client = sync({ pull: async () => page() })
  expect(await client.tick()).toBe('ok')
  h.ledger.setMeta('relay_selection_issued_at', 100_001)
  expect(await client.tick()).toBe('regressed')
  expect(h.gate.entitlementsFresh()).toBe(false)
  expect(new RelayAssembly({ ...f.options, fresh: () => h.gate.entitlementsFresh() }).selection(LUNA)).toBeUndefined()
})
it('resumes the original persona after a new native thread starts with a newer revision (RT11)', async () => {
  const f = fixture()
  expect(await f.assembly.provision(LUNA, 'native-1')).toEqual({ projectId: 'assistant-project-1', personaRevision: 1 })
  f.revision(2)
  const resumed = new RelayAssembly(f.options)
  expect(await resumed.provision(LUNA, 'native-2')).toEqual({ projectId: 'assistant-project-2', personaRevision: 2 })
  expect(await resumed.provision(LUNA, 'native-1')).toEqual({ projectId: 'assistant-project-1', personaRevision: 1 })
  const [first, second] = f.createProject.mock.calls.map(([, input]) => input.workspaceRoot)
  expect(first).not.toBe(second)

  for (const file of RELAY_INSTRUCTION_FILES) {
    expect(readFileSync(join(first, file), 'utf8')).toBe('<!-- Atum persona revision: 1 -->\nPersona 1\n')
    expect(readFileSync(join(second, file), 'utf8')).toBe('<!-- Atum persona revision: 2 -->\nPersona 2\n')
  }
})

it('recovers the original persona when a project was created before the ledger pin', async () => {
  const f = fixture()
  const setMeta = vi.spyOn(h.ledger, 'setMeta').mockImplementationOnce(() => {
    throw new Error('lost before the persona pin')
  })
  await expect(f.assembly.provision(LUNA, 'native-1')).rejects.toThrow('lost before the persona pin')
  setMeta.mockRestore()
  f.revision(2)
  const resumed = new RelayAssembly(f.options)
  expect(await resumed.provision(LUNA, 'native-1')).toEqual({ projectId: 'assistant-project-1', personaRevision: 1 })
  expect(f.createProject).toHaveBeenCalledOnce()
  expect(readdirSync(f.options.assistantsRoot)).toHaveLength(1)
})

it('writes each native harness its own read-only instructions and settings once, at session creation', async () => {
  const f = fixture()
  const roots = ['/mnt/person/.ssh', '/mnt/person/Library/Keychains']
  const assembly = new RelayAssembly({ ...f.options, protectedRoots: roots })
  await assembly.provision(LUNA, 'native-1')
  const [folder] = f.createProject.mock.calls.map(([, input]) => input.workspaceRoot)
  const settings = join(folder, '.claude', 'settings.json')
  const written = readFileSync(settings, 'utf8')

  expect(JSON.parse(written)).toEqual(claudeRelaySettings({ folder, protectedRoots: roots }))
  expect(JSON.parse(written).sandbox).toMatchObject({
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    filesystem: { denyRead: roots, allowRead: [folder] }
  })
  expect(JSON.parse(written).permissions.deny).toEqual(
    expect.arrayContaining(['Read(//mnt/person/.ssh/**)', `Edit(/${join(folder, 'CLAUDE.md')})`])
  )

  for (const file of [...RELAY_INSTRUCTION_FILES, '.claude/settings.json']) {
    expect(statSync(join(folder, file)).mode & 0o222).toBe(0)
  }

  // A resume, a re-provision and a newer definition revision leave every file as it was.
  f.revision(5)
  await new RelayAssembly({ ...f.options, protectedRoots: ['/elsewhere'] }).provision(LUNA, 'native-1')
  expect(readFileSync(settings, 'utf8')).toBe(written)
  expect(readFileSync(join(folder, 'GEMINI.md'), 'utf8')).toBe('<!-- Atum persona revision: 1 -->\nPersona 1\n')
})

it('protects the O16 stores and every assistant folder, and keeps the session\'s own folder readable', () => {
  const roots = relayProtectedRoots('/mnt/person', '/mnt/person/Atum/Assistants')

  expect(roots).toEqual(
    expect.arrayContaining([
      '/mnt/person/.ssh',
      '/mnt/person/.aws',
      '/mnt/person/.codex',
      '/mnt/person/Library/Keychains',
      '/mnt/person/Atum/Assistants'
    ])
  )
  const folder = '/mnt/person/Atum/Assistants/abc'
  expect(claudeRelaySettings({ folder, protectedRoots: roots }).sandbox.filesystem.allowRead).toEqual([folder])
})
