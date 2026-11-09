import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { expect, it } from 'vitest'

import { AwarenessReader } from './reader'
import type { AwarenessReaderOptions } from './reader'
import { awarenessFileStore } from './store'
import type { AwarenessEnvelope, AwarenessRevision, AwarenessTransport } from './types'

const test = process.platform === 'win32' ? it.skip : it

test('real reader + atomic file store preserve unknown receipt and permanent withdrawals across restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'atum-awareness-reader-'))

  try {
    const file = path.join(directory, 'private-owner', 'metadata.json')
    let lost = true
    const sent: AwarenessEnvelope[] = []

    const revision: AwarenessRevision = {
      source: { kind: 'human_dm', id: '!test:atum.example' },
      object: { kind: 'message', id: '$one', revision: 1 },
      author: { kind: 'human', id: '@test:atum.example' },
      eventTime: 1,
      content: { text: 'synthetic fact, not a credential or live message', attachments: [] }
    }

    const transport: AwarenessTransport = {
      async prepare() {},
      async ingest(envelope) {
        sent.push(structuredClone(envelope))

        if (lost) {
          lost = false
          throw new Error('lost_ack')
        }

        return {
          operationId: envelope.operationId,
          source: envelope.source,
          object: envelope.object,
          state: 'duplicate',
          acceptedRevision: 1
        }
      },
      async withdraw(request) {
        return {
          withdrawalId: request.withdrawalId,
          state: 'recorded',
          recordedAt: 10,
          purgeBy: 100,
          suppressionIds: ['00000000-0000-4000-8000-d63d65f98f72']
        }
      },
      async fence(notice) {
        return { active: true, since: notice.since }
      },
      async coverage() {}
    }

    const options: AwarenessReaderOptions = {
      create: true,
      binding: 'isolated-account/device',
      destination: 'managed',
      store: awarenessFileStore(file),
      transport,
      live: () => true,
      now: () => 10,
      readAccess: () => ({ active: true, keysAvailable: true, visibility: 'joined', readable: () => true })
    }

    const first = await AwarenessReader.open(options)
    await first.register(revision.source)
    expect(
      await first.ingest({ source: revision.source, revisions: [revision], after: null, through: 1, complete: true })
    ).toMatchObject({ state: 'offline' })
    first.stop()
    const second = await AwarenessReader.open({ ...options, create: false })
    expect(second.replayHint(revision.source)).toEqual(revision.object)
    expect(
      await second.ingest({ source: revision.source, revisions: [revision], after: null, through: 1, complete: true })
    ).toMatchObject({ state: 'ready' })
    expect(sent[1]).toEqual(sent[0])
    await second.withdraw({ kind: 'object', source: revision.source, objectId: '$one' }, 'forget')
    second.stop()
    const third = await AwarenessReader.open({ ...options, create: false })
    await third.ingest({ source: revision.source, revisions: [revision], after: null, through: 1, complete: true })
    expect(sent).toHaveLength(2)
    const bytes = await readFile(file, 'utf8')
    expect(bytes).not.toContain(revision.content.text)
    expect(bytes).not.toContain('attachments')
    expect(bytes).toContain('00000000-0000-4000-8000-d63d65f98f72')
    await expect(
      AwarenessReader.open({ ...options, create: false, binding: 'different-owner/device' })
    ).rejects.toThrow('awareness_store_invalid')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
