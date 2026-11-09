import { execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomUUID } from 'node:crypto'
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { EncryptedStore } from '../encrypted-store'

import {
  DRIVE_MAC_DELIVERABLES,
  macDeliverablesFence,
  MacDriveDeliverables,
  projectMacDeliverablesIssue
} from './drive-deliverables'
import {
  type MacBrokerFence,
  type MacBrokerPort,
  type MacDeliverableInput,
  type MacWriterContext
} from './drive-deliverables-contract'
import { snapshotMacDeliverables } from './drive-deliverables-source'
import { FakeMacDriveBroker } from './drive-deliverables.fake'

const roots: string[] = []
const taskId = '00000000-0000-4000-8000-4221c20a3939'
const safeStorageKey = Buffer.alloc(32, 73)
const safeStorageIv = Buffer.alloc(16, 19)

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => {
    const cipher = createCipheriv('aes-256-cbc', safeStorageKey, safeStorageIv)

    return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  },
  decryptString: (value: Buffer) => {
    const decipher = createDecipheriv('aes-256-cbc', safeStorageKey, safeStorageIv)

    return Buffer.concat([decipher.update(value), decipher.final()]).toString('utf8')
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function temp(name = 'atum-deliverables-'): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), name)))
  roots.push(root)

  return root
}

function write(root: string, relative: string, value: Buffer | string): void {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
  writeFileSync(path.join(root, relative), value)
}

function context(overrides: Partial<MacWriterContext> = {}): MacWriterContext {
  return {
    accountKey: 'account-a',
    agentPrincipal: 'agent-a',
    deviceId: 'mac-a',
    epoch: 1,
    generation: 1,
    answeringMode: 'local',
    allowLocalWriter: true,
    ...overrides
  }
}

function store(root = temp()): EncryptedStore {
  return new EncryptedStore(path.join(root, 'attempts.json'), safeStorage)
}

function input(
  files: readonly { path: string; baseEtag?: string | null }[],
  dependencies?: MacDeliverableInput['dependencies']
): MacDeliverableInput {
  return { taskId, files, dependencies }
}

function createPublisher(options: {
  source: string
  current: () => MacWriterContext | null
  broker?: MacBrokerPort
  attempts?: EncryptedStore
  enabled?: boolean
}) {
  const currentFence = () => {
    const value = options.current()

    return value ? macDeliverablesFence(value) : macDeliverablesFence(context({ allowLocalWriter: false }))
  }

  const broker = options.broker ?? new FakeMacDriveBroker({ current: currentFence })

  return {
    broker,
    publisher: new MacDriveDeliverables({
      enabled: options.enabled ?? true,
      broker,
      store: options.attempts ?? store(),
      sourceRoot: () => options.source,
      driveRoots: () => [],
      context: options.current
    })
  }
}

async function stageAndCommit(
  broker: FakeMacDriveBroker,
  fence: MacBrokerFence,
  options: {
    path?: string
    bytes?: Buffer | string
    baseEtag?: string | null
    dependencies?: readonly { path: string; etag: string }[]
  } = {}
) {
  const bytes = Buffer.from(options.bytes ?? 'draft')
  const baseEtag = options.baseEtag ?? null
  const artifactId = randomUUID()
  const hash = createHash('sha256').update(bytes).digest('hex')

  const staged = await broker.stage({
    path: options.path ?? 'brief.md',
    baseEtag,
    bytes,
    sha256: hash,
    fence,
    taskId,
    artifactId
  })

  expect(staged).toEqual({ staged: true, artifactId })

  return broker.commit({
    fence,
    taskId,
    dependencies: options.dependencies ?? [],
    placements: [
      {
        path: options.path ?? 'brief.md',
        mode: baseEtag === null ? 'create' : 'replace',
        baseEtag,
        artifactId,
        sha256: hash
      }
    ]
  })
}

describe('FakeMacDriveBroker', () => {
  it('keeps a quota refusal terminal even if room becomes available before a repeated commit', async () => {
    const fence = macDeliverablesFence(context())
    const options = { current: () => fence, quotaBytes: 2 }
    const broker = new FakeMacDriveBroker(options)
    const first = await stageAndCommit(broker, fence, { bytes: 'draft' })
    expect(first.result).toBe('drive_full')
    options.quotaBytes = 20
    const second = await broker.commit(broker.commitCalls[0]!)
    expect(second.result).toBe('drive_full')
    expect(broker.placementCount).toBe(0)
    expect(broker.files.size).toBe(0)
  })

  it('matches the frozen v1 placement decisions where the native broker has a corresponding operation', async () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          '../../../../packages/device-protocol/fixtures/workspace-transactions/fixtures/placement.vectors.json',
          import.meta.url
        ),
        'utf8'
      )
    ) as {
      vectors: Array<{
        name: string
        output: { path: string; mode: 'create' | 'replace'; baseEtag: string | null }
        server: { present: boolean; etag?: string; excluded?: boolean }
        inputChanged: boolean
        decision: 'place' | 'sibling' | 'refused'
        siblingPath: string | null
      }>
    }

    for (const vector of fixture.vectors.filter(vector => vector.decision !== 'refused')) {
      const active = context()
      const remote: Record<string, { bytes: string; etag: string }> = {}

      if (vector.server.present) {
        remote[vector.output.path] = { bytes: 'server', etag: vector.server.etag! }
      }

      remote['input.md'] = { bytes: 'input', etag: vector.inputChanged ? '"changed"' : '"input"' }
      const broker = new FakeMacDriveBroker({ current: () => macDeliverablesFence(active), files: remote })
      const bytes = Buffer.from('draft')
      const artifactId = randomUUID()
      const hash = createHash('sha256').update(bytes).digest('hex')
      await broker.stage({
        ...vector.output,
        bytes,
        sha256: hash,
        fence: macDeliverablesFence(active),
        taskId,
        artifactId
      })

      const reply = await broker.commit({
        fence: macDeliverablesFence(active),
        taskId,
        dependencies: [{ path: 'input.md', etag: '"input"' }],
        placements: [{ ...vector.output, artifactId, sha256: hash }]
      })

      const output = reply.outputs[0]
      expect(output?.state, vector.name).toBe(vector.decision === 'place' ? 'placed' : 'sibling')
      expect(output?.siblingPath, vector.name).toBe(vector.siblingPath)
    }
  })

  it('uses one exact sibling name, refuses a sibling collision without writes, and records a lost acknowledgement once', async () => {
    const active = context()
    const fence = macDeliverablesFence(active)
    const sibling = 'brief (T 2026-10-04 00000000).md'

    const collision = new FakeMacDriveBroker({
      current: () => fence,
      files: { 'brief.md': { bytes: 'server', etag: '"server"' }, [sibling]: 'occupied' }
    })

    const refused = await stageAndCommit(collision, fence)
    expect(refused).toMatchObject({ result: 'unknown', outputs: [{ state: 'not_attempted' }] })
    expect(collision.placementCount).toBe(0)

    const lost = new FakeMacDriveBroker({ current: () => fence, loseAckAfterPlacement: true })
    const first = await stageAndCommit(lost, fence)
    const second = await lost.commit(lost.commitCalls[0]!)
    expect(first.result).toBe('unknown')
    expect(second.result).toBe('unknown')
    expect(lost.files.get('brief.md')?.bytes.toString()).toBe('draft')
    expect(lost.placementCount).toBe(1)
  })

  it('checks bytes and fences at staging and quota from final byte deltas at commit', async () => {
    const active = context()
    const fence = macDeliverablesFence(active)

    const broker = new FakeMacDriveBroker({
      current: () => fence,
      quotaBytes: 12,
      files: { 'brief.md': { bytes: '0123456789', etag: '"old"' } }
    })

    const replacement = await stageAndCommit(broker, fence, { bytes: '0123456789ab', baseEtag: '"old"' })
    expect(replacement.result).toBe('committed')
    expect(broker.files.get('brief.md')?.bytes.length).toBe(12)

    const invalid = await broker.stage({
      path: 'bad.md',
      baseEtag: null,
      bytes: Buffer.from('bad'),
      sha256: 'not-a-hash',
      fence,
      taskId,
      artifactId: randomUUID()
    })

    expect(invalid).toEqual({ reason: 'failed' })
    expect(
      await broker.stage({
        path: 'bad.md',
        baseEtag: null,
        bytes: Buffer.from('bad'),
        sha256: createHash('sha256').update('bad').digest('hex'),
        fence,
        taskId,
        artifactId: 'not-a-uuid'
      })
    ).toEqual({ reason: 'failed' })
    const staleFence = { ...fence, generation: fence.generation + 1 }
    expect(
      await broker.stage({
        path: 'bad.md',
        baseEtag: null,
        bytes: Buffer.from('bad'),
        sha256: createHash('sha256').update('bad').digest('hex'),
        fence: staleFence,
        taskId,
        artifactId: 'stale'
      })
    ).toEqual({ reason: 'fenced' })

    const full = new FakeMacDriveBroker({ current: () => fence, quotaBytes: 2 })
    const fullReply = await stageAndCommit(full, fence, { bytes: 'abc' })
    expect(fullReply).toMatchObject({ result: 'drive_full', outputs: [{ state: 'not_attempted' }] })
    expect(full.files.size).toBe(0)
  })

  it('binds its construction scope and refuses cloud, moving, or cross-scope calls without writes', async () => {
    let active = context()
    const broker = new FakeMacDriveBroker({ current: () => macDeliverablesFence(active) })
    const bytes = Buffer.from('draft')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const localFence = macDeliverablesFence(active)

    const staged = {
      path: 'brief.md',
      baseEtag: null,
      bytes,
      sha256,
      fence: localFence,
      taskId,
      artifactId: randomUUID()
    }

    await expect(broker.stage(staged)).resolves.toEqual({ staged: true, artifactId: staged.artifactId })

    active = context({ answeringMode: 'cloud' })
    await expect(
      broker.stage({ ...staged, fence: macDeliverablesFence(active), artifactId: 'cloud-artifact' })
    ).resolves.toEqual({ reason: 'fenced' })
    active = context({ answeringMode: 'moving' })
    await expect(
      broker.stage({ ...staged, fence: macDeliverablesFence(active), artifactId: 'moving-artifact' })
    ).resolves.toEqual({ reason: 'fenced' })
    active = context({ accountKey: 'account-b', agentPrincipal: 'agent-b' })
    const foreignFence = macDeliverablesFence(active)
    await expect(broker.stage({ ...staged, fence: foreignFence, artifactId: 'foreign-artifact' })).resolves.toEqual({
      reason: 'fenced'
    })
    await expect(
      broker.commit({
        fence: foreignFence,
        taskId,
        dependencies: [],
        placements: [{ path: staged.path, mode: 'create', baseEtag: null, artifactId: staged.artifactId, sha256 }]
      })
    ).resolves.toMatchObject({ result: 'fenced', outputs: [{ state: 'not_attempted' }] })
    expect(broker.placementCount).toBe(0)
    expect(broker.files).toEqual(new Map())
  })
})

describe('MacDriveDeliverables', () => {
  it('publishes spaced Unicode names using a separate opaque resource identity', async () => {
    const root = temp()
    const name = 'báo cáo draft.md'
    write(root, name, 'draft')
    const active = context()
    const broker = new FakeMacDriveBroker({ current: () => macDeliverablesFence(active) })
    const { publisher } = createPublisher({ source: root, current: () => active, broker })
    expect((await publisher.publish(input([{ path: name }]))).state).toBe('committed')
    expect(broker.files.get(name)?.bytes.toString()).toBe('draft')
    expect(readFileSync(path.join(root, name), 'utf8')).toBe('draft')
  })

  it('exposes unknown during an in-flight commit, then reads its durable success without placing again', async () => {
    const root = temp()
    write(root, 'brief.md', 'draft')
    const active = context()
    const broker = new FakeMacDriveBroker({ current: () => macDeliverablesFence(active) })
    let release!: () => void
    let entered!: () => void

    const gate = new Promise<void>(resolve => {
      release = resolve
    })

    const started = new Promise<void>(resolve => {
      entered = resolve
    })

    const commit = broker.commit.bind(broker)

    broker.commit = async request => {
      entered()
      await gate

      return commit(request)
    }

    const { publisher } = createPublisher({ source: root, current: () => active, broker })
    const request = input([{ path: 'brief.md' }])
    const pending = publisher.publish(request)
    await started
    const overlapping = await publisher.publish(request)
    release()
    expect(overlapping.state).toBe('unknown')
    expect((await pending).state).toBe('committed')
    expect((await publisher.publish(request)).state).toBe('committed')
    expect(broker.stageCalls).toHaveLength(1)
    expect(broker.commitCalls).toHaveLength(1)
    expect(broker.placementCount).toBe(1)
  })

  it('maps stale_inputs to terminal unknown and never retries it', async () => {
    const root = temp()
    write(root, 'brief.md', 'draft')
    const active = context()
    let commits = 0

    const broker: MacBrokerPort = {
      stage: async request => ({ staged: true, artifactId: request.artifactId }),
      commit: async request => {
        commits += 1

        return {
          result: 'stale_inputs',
          outputs: request.placements.map(placement => ({
            path: placement.path,
            state: 'not_attempted',
            placed: null,
            siblingPath: null
          }))
        }
      }
    }

    const { publisher } = createPublisher({ source: root, current: () => active, broker })
    const request = input([{ path: 'brief.md' }])
    expect((await publisher.publish(request)).state).toBe('unknown')
    expect((await publisher.publish(request)).state).toBe('unknown')
    expect(commits).toBe(1)
  })

  it('rejects a placed resource which exceeds the frozen resource bound', async () => {
    const root = temp()
    write(root, 'brief.md', 'draft')
    const active = context()

    const broker: MacBrokerPort = {
      stage: async request => ({ staged: true, artifactId: request.artifactId }),
      commit: async request => ({
        result: 'committed',
        outputs: request.placements.map(placement => ({
          path: placement.path,
          state: 'placed',
          placed: { resource: { storage: 'fake', space: 'fake', opaque: 'x'.repeat(300) }, etag: '"ok"' },
          siblingPath: null
        }))
      })
    }

    const { publisher } = createPublisher({ source: root, current: () => active, broker })
    expect((await publisher.publish(input([{ path: 'brief.md' }]))).state).toBe('unknown')
  })

  it('is disabled by default without inspecting context, source, store or broker', async () => {
    const root = temp()
    let contextCalls = 0

    const broker: MacBrokerPort = {
      stage: async () => {
        throw new Error('unexpected stage')
      },
      commit: async () => {
        throw new Error('unexpected commit')
      }
    }

    const publisher = new MacDriveDeliverables({
      broker,
      store: store(),
      sourceRoot: () => {
        throw new Error('unexpected source')
      },
      driveRoots: () => [],
      context: () => {
        contextCalls += 1
        throw new Error('unexpected context')
      }
    })

    expect(DRIVE_MAC_DELIVERABLES).toBe(false)
    await expect(publisher.publish(input([{ path: 'brief.md' }]))).resolves.toMatchObject({
      state: 'disabled',
      placed: 0,
      siblings: 0,
      unsaved: 0
    })
    expect(contextCalls).toBe(0)
    expect(root).toBeTruthy()
  })

  it('stages explicit source bytes, handles create/replace/dependency conflicts, and never creates a Drive Agents source path', async () => {
    const root = temp()
    write(root, 'brief.md', 'draft')
    write(root, 'nested/report.md', 'report')
    let active = context()

    const broker = new FakeMacDriveBroker({
      current: () => macDeliverablesFence(active),
      files: { 'brief.md': { bytes: 'old', etag: '"old"' }, 'input.md': { bytes: 'changed', etag: '"changed"' } }
    })

    const { publisher } = createPublisher({ source: root, current: () => active, broker })

    const delivered = await publisher.publish(
      input(
        [{ path: 'brief.md', baseEtag: '"old"' }, { path: 'nested/report.md' }],
        [{ path: 'input.md', etag: '"input"' }]
      )
    )

    expect(delivered).toMatchObject({ state: 'committed_with_siblings', placed: 0, siblings: 2, unsaved: 0 })
    expect(broker.files.get('brief.md')?.bytes.toString()).toBe('old')
    expect(broker.files.get('brief (T 2026-10-04 00000000).md')?.bytes.toString()).toBe('draft')
    expect(broker.files.get('nested/report (T 2026-10-04 00000000).md')?.bytes.toString()).toBe('report')
    expect(readFileSync(path.join(root, 'brief.md'), 'utf8')).toBe('draft')
    expect([...broker.files.keys()].some(file => file.includes('Drive Agents'))).toBe(false)
  })

  it('reports a quota refusal without changing the remote original or source, and projects its issue without discarding existing issues', async () => {
    const root = temp()
    write(root, 'brief.md', 'newer')
    let active = context()

    const broker = new FakeMacDriveBroker({
      current: () => macDeliverablesFence(active),
      quotaBytes: 3,
      files: { 'brief.md': { bytes: 'old', etag: '"old"' } }
    })

    const { publisher } = createPublisher({ source: root, current: () => active, broker })
    const outcome = await publisher.publish(input([{ path: 'brief.md', baseEtag: '"old"' }]))
    expect(outcome).toMatchObject({
      state: 'drive_full',
      placed: 0,
      siblings: 0,
      unsaved: 1,
      issue: { code: 'drive_full', count: 1 }
    })
    expect(broker.files.get('brief.md')?.bytes.toString()).toBe('old')
    expect(readFileSync(path.join(root, 'brief.md'), 'utf8')).toBe('newer')
    const view = { issues: [{ id: 'old', code: 'offline' }] }
    expect(projectMacDeliverablesIssue(view as never, outcome).issues).toEqual([
      { id: 'old', code: 'offline' },
      outcome.issue
    ])
  })

  it('never calls a broker after an unknown acknowledgement, including a reconstructed store or changed epoch', async () => {
    const root = temp()
    write(root, 'brief.md', 'draft')
    const state = temp()
    const attemptsPath = path.join(state, 'attempts.json')
    const attempts = new EncryptedStore(attemptsPath, safeStorage)
    let active = context()
    const broker = new FakeMacDriveBroker({ current: () => macDeliverablesFence(active), loseAckAfterPlacement: true })
    const first = createPublisher({ source: root, current: () => active, broker, attempts }).publisher
    await expect(first.publish(input([{ path: 'brief.md' }]))).resolves.toMatchObject({ state: 'unknown', unsaved: 1 })
    expect(broker.placementCount).toBe(1)
    active = context({ epoch: 2, generation: 9 })

    // Reopen the actual encrypted file; the durable key intentionally excludes epoch/generation.
    const resumed = new MacDriveDeliverables({
      enabled: true,
      broker,
      store: new EncryptedStore(attemptsPath, safeStorage),
      sourceRoot: () => root,
      driveRoots: () => [],
      context: () => active
    })

    await expect(resumed.publish(input([{ path: 'brief.md' }]))).resolves.toMatchObject({
      state: 'unknown',
      unsaved: 1
    })
    expect(broker.placementCount).toBe(1)
    expect(broker.stageCalls).toHaveLength(1)
  })

  it('places concurrent same-task publication once and treats a malformed full reply as unknown', async () => {
    const root = temp()
    write(root, 'brief.md', 'draft')
    let active = context()
    const broker = new FakeMacDriveBroker({ current: () => macDeliverablesFence(active) })
    const { publisher } = createPublisher({ source: root, current: () => active, broker })

    const [first, second] = await Promise.all([
      publisher.publish(input([{ path: 'brief.md' }])),
      publisher.publish(input([{ path: 'brief.md' }]))
    ])

    expect([first.state, second.state]).toContain('committed')

    for (const outcome of [first, second]) {
      expect(['committed', 'unknown']).toContain(outcome.state)
    }

    expect(broker.placementCount).toBe(1)

    const malformed: MacBrokerPort = {
      stage: async request => ({ staged: true, artifactId: request.artifactId }),
      commit: async request => ({
        result: 'drive_full',
        outputs: request.placements.map(placement => ({
          path: placement.path,
          state: 'placed' as const,
          placed: { resource: { storage: 'x', space: 'x', opaque: 'x' }, etag: '"x"' },
          siblingPath: null
        }))
      })
    }

    const another = temp()
    write(another, 'second.md', 'draft')
    const malformedPublisher = createPublisher({ source: another, current: () => active, broker: malformed }).publisher
    await expect(malformedPublisher.publish(input([{ path: 'second.md' }]))).resolves.toMatchObject({
      state: 'unknown',
      unsaved: 1
    })
  })

  it('freezes caller input before awaits and fails closed when its durable attempt history is unreadable', async () => {
    const root = temp()
    write(root, 'brief.md', 'draft')
    let active = context()
    let reads = 0
    const request = input([{ path: 'brief.md' }])
    const broker = new FakeMacDriveBroker({ current: () => macDeliverablesFence(active) })

    const { publisher } = createPublisher({
      source: root,
      broker,
      current: () => {
        reads += 1

        if (reads === 2) {
          ;(request.files as Array<{ path: string }>)[0]!.path = 'retargeted.md'
        }

        return active
      }
    })

    await expect(publisher.publish(request)).resolves.toMatchObject({ state: 'committed' })
    expect(broker.stageCalls[0]?.path).toBe('brief.md')

    const history = store()

    const key = createHash('sha256')
      .update(JSON.stringify([active.accountKey, active.agentPrincipal, taskId]))
      .digest('hex')

    history.scope('drive-deliverables:').setItem(key, '{broken')
    const unavailable = createPublisher({ source: root, current: () => active, attempts: history }).publisher
    await expect(unavailable.publish(input([{ path: 'brief.md' }]))).resolves.toMatchObject({ state: 'unavailable' })
  })

  it('rejects malformed ETags and non-array dependencies before it contacts the broker', async () => {
    const root = temp()
    write(root, 'brief.md', 'draft')
    const active = context()
    const broker = new FakeMacDriveBroker({ current: () => macDeliverablesFence(active) })
    const { publisher } = createPublisher({ source: root, current: () => active, broker })
    await expect(
      publisher.publish({ taskId, files: [{ path: 'brief.md', baseEtag: 42 }], dependencies: [] } as never)
    ).resolves.toMatchObject({ state: 'invalid', unsaved: 1 })
    await expect(
      publisher.publish({
        taskId,
        files: [{ path: 'brief.md' }],
        dependencies: { path: 'input.md', etag: '"one"' }
      } as never)
    ).resolves.toMatchObject({ state: 'invalid' })
    expect((await publisher.publish(input([{ path: 'Brief.md' }, { path: 'brIEf.md' }]))).state).toBe('invalid')
    expect(broker.stageCalls).toHaveLength(0)
    expect(broker.commitCalls).toHaveLength(0)
  })

  it('blocks stale fences after stage and suppresses a late account reset from projecting an issue', async () => {
    const root = temp()
    write(root, 'brief.md', 'draft')
    let active: MacWriterContext | null = context()
    const broker = new FakeMacDriveBroker({ current: () => macDeliverablesFence(active!) })
    const stage = broker.stage.bind(broker)

    broker.stage = async request => {
      const reply = await stage(request)
      active = context({ generation: 2 })

      return reply
    }

    const { publisher } = createPublisher({ source: root, current: () => active, broker })
    const stale = await publisher.publish(input([{ path: 'brief.md' }]))
    expect(stale).toMatchObject({ state: 'unknown', unsaved: 1 })
    expect(broker.commitCalls).toHaveLength(0)

    active = context()
    const fenced = new FakeMacDriveBroker({ current: () => macDeliverablesFence(context({ generation: 99 })) })
    const fencedPublisher = createPublisher({ source: root, current: () => active, broker: fenced }).publisher
    await expect(fencedPublisher.publish(input([{ path: 'brief.md' }]))).resolves.toMatchObject({
      state: 'blocked',
      unsaved: 1
    })
    expect(fenced.commitCalls).toHaveLength(0)

    active = context()
    const full = new FakeMacDriveBroker({ current: () => macDeliverablesFence(active!), stageFailure: 'drive_full' })
    const stageFull = full.stage.bind(full)

    full.stage = async request => {
      const reply = await stageFull(request)
      active = context({ accountKey: 'account-b' })

      return reply
    }

    const resetPublisher = createPublisher({ source: root, current: () => active, broker: full }).publisher
    const reset = await resetPublisher.publish(input([{ path: 'brief.md' }]))
    expect(reset.state).toBe('unknown')
    expect(projectMacDeliverablesIssue({ issues: [] } as never, reset).issues).toEqual([])
  })
})

describe('snapshotMacDeliverables', () => {
  it('rejects traversal, private names, directories, links and hard links without reading outside the explicit root', async () => {
    const root = temp()
    write(root, 'good.md', 'ok')
    write(root, '.env', 'secret')
    mkdirSync(path.join(root, 'folder'))
    const outside = path.join(root, 'outside')
    writeFileSync(outside, 'outside')
    symlinkSync(outside, path.join(root, 'link.md'))
    linkSync(path.join(root, 'good.md'), path.join(root, 'hard.md'))

    for (const file of ['../outside', '.env', 'folder', 'link.md', 'hard.md']) {
      await expect(snapshotMacDeliverables(root, [], [{ path: file }])).rejects.toThrow('mac_deliverables_invalid')
    }
  })

  it('rejects sources inside protected Drive roots, including a symlink alias, parent links and FIFOs', async () => {
    const root = temp()
    write(root, 'brief.md', 'draft')
    await expect(snapshotMacDeliverables(root, [root], [{ path: 'brief.md' }])).rejects.toThrow(
      'mac_deliverables_invalid'
    )

    const aliases = temp()
    const alias = path.join(aliases, 'drive-alias')
    symlinkSync(root, alias)
    await expect(snapshotMacDeliverables(root, [alias], [{ path: 'brief.md' }])).rejects.toThrow(
      'mac_deliverables_invalid'
    )

    const external = temp()
    write(external, 'outside.md', 'outside')
    symlinkSync(external, path.join(root, 'linked-parent'))
    await expect(snapshotMacDeliverables(root, [], [{ path: 'linked-parent/outside.md' }])).rejects.toThrow(
      'mac_deliverables_invalid'
    )

    if (process.platform !== 'win32') {
      execFileSync('mkfifo', [path.join(root, 'stream')])
      await expect(snapshotMacDeliverables(root, [], [{ path: 'stream' }])).rejects.toThrow('mac_deliverables_invalid')
    }
  })

  it('uses the frozen actual count and byte limits, and snapshots bytes before callers can mutate their request', async () => {
    const root = temp()
    await expect(snapshotMacDeliverables(root, [], [])).rejects.toThrow('mac_deliverables_invalid')

    for (let index = 0; index < 17; index += 1) {
      write(root, `file-${index}.md`, 'x')
    }

    await expect(
      snapshotMacDeliverables(
        root,
        [],
        Array.from({ length: 17 }, (_, index) => ({ path: `file-${index}.md` }))
      )
    ).rejects.toThrow('mac_deliverables_invalid')
    const tooLarge = Buffer.alloc(32 * 1024 * 1024 + 1, 1)
    write(root, 'large.md', tooLarge)
    await expect(snapshotMacDeliverables(root, [], [{ path: 'large.md' }])).rejects.toThrow('mac_deliverables_invalid')

    write(root, 'first.bin', Buffer.alloc(32 * 1024 * 1024, 1))
    write(root, 'second.bin', Buffer.alloc(32 * 1024 * 1024, 2))
    write(root, 'third.bin', 'x')
    await expect(
      snapshotMacDeliverables(root, [], [{ path: 'first.bin' }, { path: 'second.bin' }, { path: 'third.bin' }])
    ).rejects.toThrow('mac_deliverables_invalid')

    write(root, 'frozen.md', 'first')
    const copies = await snapshotMacDeliverables(root, [], [{ path: 'frozen.md' }])
    write(root, 'frozen.md', 'second')
    expect(copies[0]?.bytes.toString()).toBe('first')
  })
})
