import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { expect, onTestFinished, test } from 'vitest'

import type { AtumCloudMemory, AtumSkillBundle } from '../shared/atum-agent-content'
import type { AtumAssistantDefinitionSnapshot } from '../shared/atum-agent-portability'

import { AtumAssistantPortabilityService } from './atum-agent-portability'
import { AtumAgentSync } from './atum-agent-sync'
import { AccountRootAuthority } from './atum-messaging/account-roots'
import { SafeStorageAuthStorage } from './atum-messaging/credential-vault'
import { AtumUtilities } from './atum-utilities'

/** Opt in with the repository Python environment; exercises real tickets/files, no model or network. */
test.skipIf(!process.env.ATUM_SYNC_PYTHON).each([false, true])('two main coordinators restore skills and memory (default=%s)', async isDefault => {
  const scratch = mkdtempSync(join(tmpdir(), 'atum-two-computers-'))
  const account = '00000000-0000-4000-8000-303617b97302'
  const id = '00000000-0000-4000-8000-00f765af1c54'
  const identity = '00000000-0000-4000-8000-50d86b120e98'

  const assistant = { id, identityId: identity, displayName: 'Writer', avatar: '', avatarUrl: null, isDefault,
    lifecycleRevision: 1, identityRevision: 1, definitionRevision: 0, status: 'active' as const }

  let cloud: AtumAssistantDefinitionSnapshot | null = null
  let memory: AtumCloudMemory = { assistantId: id, enabled: false, revision: 0, snapshot: { memory: [], user: [] } }
  const bundles = new Map<string, AtumSkillBundle>()
  // One backend per computer, as in the app. Starting Python for every ticket
  // repeatedly imports the auth/skills/memory dependency trees and races the
  // whole-test deadline on loaded runners (especially the default adoption path).
  const backends: ReturnType<typeof backend>[] = []

  function backend(home: string) {
    const child = spawn(process.env.ATUM_SYNC_PYTHON!, ['-u', '-c', `
import json, sys
from pathlib import Path
from hermes_cli.atum_content_sync import content_ticket
from hermes_cli.atum_portability import materialize_ticket
from hermes_cli.profiles import adopt_profile_identity

for line in sys.stdin:
    request = json.loads(line)
    try:
        if request["operation"] == "adopt":
            result = adopt_profile_identity(Path(sys.argv[1]), request["identity"])
        else:
            fn = {"content": content_ticket, "materialize": materialize_ticket}[request["operation"]]
            result = fn(Path(request["tickets"]), request["ticket_id"])
        response = {"result": result}
    except Exception as exc:
        response = {"error": repr(exc)}
    print(json.dumps(response), flush=True)
`, home], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      env: { ...process.env, HERMES_HOME: home }, stdio: ['pipe', 'pipe', 'pipe']
    })

    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => { stderr += error.message })
    child.stdin.on('error', error => { stderr += error.message; child.kill('SIGKILL') })
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()

    return {
      async request(input: Record<string, string>) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Python backend exited: ${stderr}`)
        }

        child.stdin.write(`${JSON.stringify(input)}\n`)
        const line = await lines.next()

        if (line.done) { throw new Error(`Python backend closed during ${input.operation}: ${stderr}`) }
        const response = JSON.parse(line.value)

        if (response.error) { throw new Error(`${input.operation}: ${response.error}`) }

        return response.result
      },
      async stop() {
        child.kill('SIGKILL')
        await closed
      }
    }
  }

  // Also runs on a test timeout: terminate and reap both backends before removing files.
  onTestFinished(async () => {
    await Promise.all(backends.map(child => child.stop()))
    rmSync(scratch, { recursive: true, force: true })
  })

  function computer(name: string) {
    const data = join(scratch, name)
    const roots = new AccountRootAuthority(data); roots.commit(account, 1)
    const home = roots.pathsForAccount(account).hermesStateRoot
    const accountRoot = roots.pathsForAccount(account).root

    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value).reverse(),
      decryptString: (value: Buffer) => Buffer.from(value).reverse().toString()
    }

    const createUtilities = () => new AtumUtilities({
      account: () => ({ accountId: account, generation: 1, root: accountRoot }), safeStorage, google: null,
      apple: { available: { calendar: false }, calendar: async () => { throw new Error('not used') } },
      fetchImpl: async () => { throw new Error('no provider call in this test') }, openExternal: async () => {}
    })

    let utilities = createUtilities()
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'config.yaml'), 'model:\n  provider: atum-managed\n  default: binh-minh\n')
    const marker = join(data, 'ticket-marker')
    const list = async () => [{ ...assistant, definitionRevision: cloud?.definitionRevision ?? 0 }]

    const get = async () => { if (!cloud) {throw new Error('missing');}

 return structuredClone(cloud) }

    const put = async (_id: string, input: any) => {
      expect(input.expectedDefinitionRevision).toBe(cloud?.definitionRevision ?? 0)
      cloud = { assistant, definition: structuredClone(input.definition), definitionRevision: (cloud?.definitionRevision ?? 0) + 1, identityRevision: 1 }

      return structuredClone(cloud)
    }

    const python = backend(home)
    backends.push(python)

    const call = (operation: string, body: { ticket_id: string }) => python.request({
      operation, tickets: readFileSync(marker, 'utf8').trim(), ticket_id: body.ticket_id
    })

    const service = new AtumAssistantPortabilityService({ accountRoots: roots, session: () => ({ user: { id: account } }),
      listAssistants: list, getAssistantDefinition: get, putAssistantDefinition: put,
      content: body => call('content', body),
      materialize: body => call('materialize', body),
      exportLegacy: async () => ({ ok: false, status: 'legacy_source_absent' }),
      getSkill: async (_id, sha) => { const bundle = bundles.get(sha);

 if (!bundle) {throw new Error('missing');}

 return bundle },
      legacyHome: join(data, 'legacy'), ticketRootMarkerPath: marker })

    service.activateAccount(account)

    const sync = new AtumAgentSync({ accountRoots: roots, session: () => ({ user: { id: account } }), portability: service,
      workspaceProtected: () => utilities.workspaceProtected(),
      listAssistants: list, getDefinition: get, putDefinition: put,
      putSkill: async (_id, bundle) => { bundles.set(bundle.sha256, structuredClone(bundle)) },
      getMemory: async () => structuredClone(memory), putMemory: async (_id, input) => {
        expect(input.expected_revision).toBe(memory.revision)
        memory = { ...memory, enabled: input.enabled, revision: memory.revision + 1, snapshot: structuredClone(input.snapshot) }

        return structuredClone(memory)
      }, changed: () => {} })

    return { sync, home, service, adopt: () => python.request({ operation: 'adopt', identity }), protect: () => {
      // Persisted state after a Google disconnect; no token, model or provider call.
      new SafeStorageAuthStorage(join(accountRoot, 'utilities.credentials.json'), safeStorage).setItem('connections', JSON.stringify({
        version: 3, accounts: [], sources: [], appleConnected: false, workspaceProtected: true
      }))
      utilities = createUtilities()
    } }
  }

  {
    const a = computer('a'); const b = computer('b')
    const source = isDefault ? a.home : join(a.home, 'profiles', 'writer')
    mkdirSync(join(source, 'skills', 'writing', 'đường'), { recursive: true })
    writeFileSync(join(source, 'profile.yaml'), `identity_id: ${identity}\nmanaged_by: ${isDefault ? "''" : 'atum'}\ndisplay_name: Writer\navatar: ''\n`)
    writeFileSync(join(source, 'SOUL.md'), 'Write clearly.')
    writeFileSync(join(source, 'config.yaml'), 'model:\n  provider: atum-managed\n  default: binh-minh\n')
    writeFileSync(join(source, 'skills', 'writing', 'SKILL.md'), '# Writing\n')
    writeFileSync(join(source, 'skills', 'writing', 'đường', '✨.bin'), Buffer.from([0, 1, 255]))
    mkdirSync(join(source, 'memories')); writeFileSync(join(source, 'memories', 'MEMORY.md'), 'Prefers concise answers.\n')
    await a.sync.sync()
    expect(a.sync.statuses()[0].skills).toBe('synced')
    expect(memory.enabled).toBe(true); expect(memory.snapshot.memory).toEqual(['Prefers concise answers.'])
    // Source no longer participates; B gets everything from the uploaded objects.
    await b.sync.sync()

    if (isDefault) {
      expect(b.sync.statuses()[0].skills).toBe('pending')
      expect(existsSync(join(b.home, 'profiles', `agent-${identity}`))).toBe(false)
      // Hosted registration returns adopt; use the real Hermes adoption path.
      await b.adopt()
      // Sync can now restore the pristine adopted root automatically.
      await b.sync.sync()
      expect(existsSync(join(b.home, 'profiles', `agent-${identity}`))).toBe(false)
    }

    expect(b.sync.statuses()[0].skills).toBe('synced')
    const target = isDefault ? b.home : join(b.home, 'profiles', `agent-${identity}`)
    expect(readFileSync(join(target, 'skills', 'writing', 'đường', '✨.bin'))).toEqual(Buffer.from([0, 1, 255]))
    await b.sync.sync()
    expect(b.sync.statuses()[0].memory).toBe('synced')
    expect(readFileSync(join(target, 'memories', 'MEMORY.md'), 'utf8')).toContain('Prefers concise answers.')

    const savedCloud = structuredClone(cloud)
    const savedMemory = structuredClone(memory)
    const savedBundles = structuredClone(bundles)
    a.protect()
    writeFileSync(join(source, 'memories', 'MEMORY.md'), 'Synthetic Google-derived memory.\n')
    writeFileSync(join(source, 'SOUL.md'), 'Synthetic Google-derived instructions.')
    writeFileSync(join(source, 'skills', 'writing', 'SKILL.md'), '# Synthetic Google-derived skill\n')
    await a.sync.sync()
    await b.sync.sync()
    expect(a.sync.statuses()[0]).toMatchObject({ memory: 'local_only', skills: 'local_only', workspaceProtected: true })
    expect(cloud).toEqual(savedCloud)
    expect(memory).toEqual(savedMemory)
    expect(bundles).toEqual(savedBundles)
    expect(readFileSync(join(source, 'memories', 'MEMORY.md'), 'utf8')).toContain('Synthetic Google-derived memory.')
    expect(readFileSync(join(target, 'memories', 'MEMORY.md'), 'utf8')).not.toContain('Google-derived')
    expect(readFileSync(join(target, 'SOUL.md'), 'utf8')).toBe('Write clearly.')
    expect(readFileSync(join(target, 'skills', 'writing', 'SKILL.md'), 'utf8')).toBe('# Writing\n')
  }
}, 30_000)
