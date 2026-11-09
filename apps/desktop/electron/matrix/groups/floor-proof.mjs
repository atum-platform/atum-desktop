/** Native group composition proof: relevance, parallel work, A -> B -> A, and correction. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

assert.ok(process.argv[2], 'pass the exact proposed desktop assembly')
const desktop = resolve(process.argv[2])
const { build } = createRequire(join(desktop, 'package.json'))('esbuild')
const root = mkdtempSync(join(tmpdir(), 'groups-conversation-proof-'))
const realNow = Date.now

try {
  await build({
    stdin: {
      contents: `export { invokeMatrixHermes } from './electron/matrix/invocation';
        export { prepareGroupFloor, GroupRoomQueue } from './electron/matrix/groups/floor';
        export { prepareGroupChain } from './electron/matrix/groups/chain';
        export { groupCorrectionTarget, GroupTurnCorrections } from './electron/matrix/groups/correction';
        export { localInvocationRecords } from './electron/matrix/local-authority';
        export { EncryptedStore } from './electron/encrypted-store';`,
      resolveDir: desktop
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: join(root, 'native.mjs')
  })
  const {
    invokeMatrixHermes,
    prepareGroupFloor,
    GroupRoomQueue,
    prepareGroupChain,
    groupCorrectionTarget,
    GroupTurnCorrections,
    localInvocationRecords,
    EncryptedStore
  } = await import(pathToFileURL(join(root, 'native.mjs')))

  let now = realNow()
  Date.now = () => now
  const acceptedAt = now
  const timestamp = now - 30_000
  const ownerId = '@owner:groups.test'
  const roomId = '!room:groups.test'
  const eventId = '$owner-request'
  const ids = ['@finance:groups.test', '@writer:groups.test', '@research:groups.test', '@ops:groups.test']
  const selected = [ids[0], ids[2]]
  const members = [ownerId, ...ids].map(userId => ({ userId, displayName: userId, membership: 'join' }))
  const policy = { v: 1, dailyTurns: 30, agents: Object.fromEntries(ids.map(id => [id, { mode: 'joins' }])) }
  const usage = { v: 1, day: new Date(now).toISOString().slice(0, 10), turns: 0 }
  const ownerMessage = {
    roomId,
    eventId,
    wireType: 'm.room.encrypted',
    sender: ownerId,
    senderDevice: 'PHONE',
    senderVerified: true,
    timestamp,
    related: false,
    content: { msgtype: 'm.text', body: 'Check the launch budget and supporting market evidence.' }
  }
  const snapshot = async () => ({ policy, usage, members, ownAgentIds: ids })
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: text => Buffer.from(`fixture:${text}`),
    decryptString: bytes => bytes.toString().slice(8)
  }
  const queue = new GroupRoomQueue()
  const models = []
  const claims = []
  const published = []
  const contexts = []
  let releaseModels
  const bothModelsEntered = new Promise(resolve => {
    releaseModels = resolve
  })

  const run = async agentId => {
    const admission = await prepareGroupFloor(
      { roomId, eventId, ownerId, agentId, since: timestamp - 1, acceptedAt },
      {
        ownerEvent: async () => ownerMessage,
        snapshot,
        replySender: async () => undefined,
        relevance: async ({ candidateIds }) => {
          assert.deepEqual(candidateIds, ids)
          return selected
        },
        now: () => now
      }
    )

    if (admission.state !== 'ready') {
      return admission.state
    }

    return queue.run(`${roomId}\n${agentId}`, async () => {
      const group = await admission.finish()
      contexts.push({ agentId, priorAnswers: published.length })
      group.recent = {
        roomId,
        viewerAgentId: agentId,
        members,
        context: { status: 'ok', lines: [], gaps: 0, omitted: 0 }
      }
      const human = { userId: ownerId, deviceId: 'MAC' }
      const principal = randomUUID()
      const agent = {
        issuer: 'https://groups.test',
        subject: ownerId,
        principal,
        agentPrincipal: randomUUID(),
        executorId: randomUUID(),
        userId: agentId,
        deviceId: 'AGENT',
        expiresAt: now + 3_600_000
      }
      const store = new EncryptedStore(join(root, `${ids.indexOf(agentId)}.json`), safeStorage)
      const records = localInvocationRecords(store, {
        principal,
        agentPrincipal: agent.agentPrincipal,
        deviceId: agent.deviceId
      })
      const grant = {
        invocationId: randomUUID(),
        state: 'claimed',
        expiresAt: now + 1_800_000,
        owner: principal,
        payer: principal,
        capability: 'local-hermes-turn',
        agentPrincipal: agent.agentPrincipal,
        agentDevice: agent.deviceId,
        transactionId: null,
        publishedEvent: null
      }

      return invokeMatrixHermes(
        {
          context: () => ({ human, agent }),
          store,
          group,
          groupLease: { leaseToken: randomUUID() },
          groupClaimed: async () => {
            usage.turns++
          },
          local: { records, lease: { notBefore: acceptedAt + 5000, turnLimitMs: 1_800_000 } },
          watch: { id: 'group', roomId, sender: human, since: timestamp - 1, until: acceptedAt + 1_800_000 },
          read: async command => {
            if (command.kind === 'readInvocation') {
              return ownerMessage
            }
            assert.equal(command.kind, 'publishResult')
            published.push(agentId)
            return `$answer-${ids.indexOf(agentId)}`
          },
          authorize: async input => {
            assert.deepEqual([input.protocol, input.admission, input.group?.mode], [2, 'automatic', 'meeting'])
            if (input.operation === 'claim') {
              claims.push(agentId)
            }
            if (input.operation === 'dispatch') {
              grant.state = 'dispatched'
            }
            if (input.operation === 'complete') {
              grant.state = 'completed'
              grant.transactionId ??= randomUUID()
            }
            if (input.operation === 'published') {
              grant.publishedEvent = input.publishedEvent
            }
            return { ...input, ...grant }
          },
          confirm: async () => true,
          prepare: async () => true,
          execute: async () => {
            models.push(agentId)
            if (models.length === selected.length) {
              releaseModels()
            }
            await bothModelsEntered
            return { text: `answer from ${agentId}`, storedSession: `fixed-${agentId}` }
          }
        },
        { roomId, eventId },
        new AbortController().signal
      )
    })
  }

  const results = await Promise.all(ids.map(run))
  assert.deepEqual(new Set(models), new Set(selected))
  assert.deepEqual(new Set(claims), new Set(selected))
  assert.equal(results.filter(result => result === 'ignored').length, 2)
  assert.equal(results.filter(result => result.state === 'published').length, 2)
  assert.deepEqual(
    contexts.map(context => context.priorAnswers),
    [0, 0],
    'both selected assistants reached model work before either published'
  )

  const chainEvents = new Map()
  const chainMessage = (id, sender, at, content) => ({
    roomId,
    eventId: id,
    wireType: 'm.room.encrypted',
    sender,
    senderDevice: 'VERIFIED',
    senderVerified: true,
    timestamp: at,
    related: false,
    content
  })
  chainEvents.set(
    '$chain-origin',
    chainMessage('$chain-origin', ownerId, now - 1000, {
      msgtype: 'm.text',
      body: 'Work this through together.',
      mentionedUserIds: [ids[0]]
    })
  )
  chainEvents.set(
    '$chain-a',
    chainMessage('$chain-a', ids[0], now - 800, {
      msgtype: 'm.text',
      body: 'Research, what evidence supports this?',
      mentionedUserIds: [ids[2]],
      chain: { origin: '$chain-origin', parent: '$chain-origin', depth: 1 }
    })
  )
  chainEvents.set(
    '$chain-b',
    chainMessage('$chain-b', ids[2], now - 600, {
      msgtype: 'm.text',
      body: 'Finance, can you apply this?',
      mentionedUserIds: [ids[0]],
      chain: { origin: '$chain-origin', parent: '$chain-a', depth: 2 }
    })
  )
  const handoff = await prepareGroupChain(
    { roomId, eventId: '$chain-b', ownerId, agentId: ids[0], since: now - 2000, acceptedAt: now },
    {
      read: async id => chainEvents.get(id),
      snapshot: async () => ({
        policy: { ...policy, agents: { ...policy.agents, [ids[0]]: { mode: 'addressed' } } },
        usage,
        members,
        ownAgentIds: ids
      }),
      now: () => now
    }
  )
  assert.deepEqual((await handoff.finish()).chain, { origin: '$chain-origin', parent: '$chain-a', depth: 2 })

  const corrections = new GroupTurnCorrections()
  const active = selected.map(() => new AbortController())
  active.forEach(controller => corrections.track({ roomId, eventId, abort: controller }))
  const correction = {
    ...ownerMessage,
    eventId: '$correction',
    timestamp: now - 100,
    related: true,
    content: { msgtype: 'm.text', body: 'Use the revised figures instead.', replyTo: eventId }
  }
  const corrected = groupCorrectionTarget(correction, {
    roomId,
    eventId: correction.eventId,
    ownerId,
    since: timestamp - 1,
    acceptedAt: now
  })
  assert.equal(corrected, eventId)
  assert.equal(corrections.apply(roomId, corrected), 2)
  assert.ok(active.every(controller => controller.signal.aborted))

  console.log(
    JSON.stringify({
      candidates: ids.length,
      selectedAgents: selected.length,
      ignoredAgents: 2,
      parallelIndependentWork: true,
      canonicalClaims: claims.length,
      publishedOnce: published.length,
      handoffBackToFirstAgent: true,
      correctedRunningTurns: active.length
    })
  )
} finally {
  Date.now = realNow
  rmSync(root, { recursive: true, force: true })
}
