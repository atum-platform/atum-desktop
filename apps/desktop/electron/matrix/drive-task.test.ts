import { describe, expect, it, vi } from 'vitest'

import type { MatrixDriveTaskInput } from '../../shared/matrix-drive'
import type { MatrixTaskFilesPromise } from '../../shared/matrix-task-files'

import { type NativeCloudFileGrant, parseDriveTaskInput, sendDriveTask } from './drive-task'
import { parseMatrixCommand } from './ipc-policy'

const ids = ['00000000-0000-4000-8000-11e594f48195', '00000000-0000-4000-8000-e79acd97ac88']
const input: MatrixDriveTaskInput = {
  roomId: '!room:test',
  body: 'Read the notes and write the summary',
  revision: 3,
  selections: [
    { id: ids[0], mode: 'read' as const },
    { id: ids[1], mode: 'create' as const, leafName: 'summary.txt' }
  ]
}
function fixture() {
  const order: string[] = []
  return {
    input,
    agentPrincipal: ids[0],
    current: vi.fn(),
    ready: vi.fn(async () => true),
    metadata: vi.fn(async (_id: string, mode: string) => {
      order.push('metadata')
      return {
        resource: { storage: 'storage', space: 'personal', opaque: mode === 'create' ? 'folder' : 'notes' },
        ...(mode === 'create' ? {} : { etag: 'v1', size: 10 })
      }
    }),
    send: vi.fn(async (_promise: MatrixTaskFilesPromise) => {
      order.push('send')
      return '$ack'
    }),
    issue: vi.fn(async (_grant: NativeCloudFileGrant) => {
      order.push('issue')
    }),
    order
  }
}

describe('owner selected Drive task send', () => {
  it('sends one promise after native metadata and issues exact ACK grants without exposing metadata in the event', async () => {
    const f = fixture()
    expect(await sendDriveTask(f)).toEqual({ state: 'sent', eventId: '$ack' })
    expect(f.order).toEqual(['metadata', 'metadata', 'send', 'issue', 'issue'])
    expect(f.send).toHaveBeenCalledOnce()
    const promise = f.send.mock.calls[0][0] as unknown as { version: number; requestIds: string[] }
    expect(Object.keys(promise).sort()).toEqual(['requestIds', 'version'])
    expect(new Set(promise.requestIds).size).toBe(2)
    const grants = f.issue.mock.calls.map(call => call[0]) as unknown as Array<Record<string, unknown>>
    expect(grants.map(grant => grant.requestId)).toEqual(promise.requestIds)
    expect(
      grants.every(
        grant => grant.roomId === '!room:test' && grant.eventId === '$ack' && grant.agentPrincipal === ids[0]
      )
    ).toBe(true)
    expect(grants[0]).toMatchObject({ mode: 'read', etag: 'v1', size: 10 })
    expect(grants[1]).toMatchObject({ mode: 'create', leafName: 'summary.txt', size: 5242880 })
    expect(grants[1]).not.toHaveProperty('etag')
  })

  it('retains an exact replacement ETag and existing size as its output ceiling', async () => {
    const f = fixture()
    f.input = { ...input, selections: [{ id: ids[0], mode: 'replace' }] }
    await sendDriveTask(f)
    expect(f.issue).toHaveBeenCalledWith(expect.objectContaining({ mode: 'replace', etag: 'v1', size: 10 }))
  })

  it('does not send when cloud file capability or native selection is unavailable', async () => {
    const f = fixture()
    f.ready.mockResolvedValue(false)
    expect(await sendDriveTask(f)).toEqual({ state: 'not_sent' })
    expect(f.send).not.toHaveBeenCalled()
    expect(f.metadata).not.toHaveBeenCalled()
    f.ready.mockResolvedValue(true)
    f.metadata.mockRejectedValue(new Error('stale row'))
    expect(await sendDriveTask(f)).toEqual({ state: 'not_sent' })
    expect(f.send).not.toHaveBeenCalled()
    expect(f.issue).not.toHaveBeenCalled()
  })

  it('rechecks readiness and custody after metadata before sending', async () => {
    const f = fixture()
    f.ready.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    expect(await sendDriveTask(f)).toEqual({ state: 'not_sent' })
    expect(f.send).not.toHaveBeenCalled()
  })

  it('seals ambiguous delivery without issuing grants or retrying a message', async () => {
    const f = fixture()
    f.send.mockRejectedValue(new Error('lost ACK'))
    expect(await sendDriveTask(f)).toEqual({ state: 'send_unknown' })
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.issue).not.toHaveBeenCalled()
  })

  it('reports partial grant failure after ACK without throwing or a second event', async () => {
    const f = fixture()
    f.issue.mockRejectedValueOnce(new Error('lost reply'))
    expect(await sendDriveTask(f)).toEqual({ state: 'grant_failed_after_ack', eventId: '$ack' })
    expect(f.issue).toHaveBeenCalledTimes(2)
    expect(f.send).toHaveBeenCalledOnce()
  })

  it('withdraws grants on an account change after the ACK without resending', async () => {
    const f = fixture()
    f.send.mockImplementation(async () => {
      f.current.mockImplementation(() => {
        throw new Error('owner changed')
      })
      return '$ack'
    })
    expect(await sendDriveTask(f)).toEqual({ state: 'grant_failed_after_ack', eventId: '$ack' })
    expect(f.issue).not.toHaveBeenCalled()
    expect(f.send).toHaveBeenCalledOnce()
  })

  it('rejects renderer resources, paths, duplicate rows and malformed output names', () => {
    for (const value of [
      { ...input, resource: {} },
      { ...input, selections: [{ id: ids[0], mode: 'read', path: '/private/file' }] },
      { ...input, selections: [input.selections[0], input.selections[0]] },
      { ...input, selections: [{ id: ids[1], mode: 'create', leafName: '../out' }] }
    ]) {
      expect(() => parseDriveTaskInput(value)).toThrow('invalid')
    }
    expect(() =>
      parseMatrixCommand({
        kind: 'sendTaskFiles',
        roomId: input.roomId,
        body: input.body,
        taskFiles: { version: 1, requestIds: [ids[0]] }
      })
    ).toThrow()
  })
})
