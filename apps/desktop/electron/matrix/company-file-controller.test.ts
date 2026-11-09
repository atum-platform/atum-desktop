import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import type { MatrixCompanyFilePending } from './account'
import {
  type MatrixCompanyFileControllerPorts,
  readCompanyFile,
  recoverCompanyFile,
  sendCompanyFile
} from './company-file-controller'
import { MatrixCompanyFileError, type MatrixCompanyFileRequest, type MatrixCompanyFileValue } from './company-files'

const companyId = '00000000-0000-4000-8000-8c031eadb7f3'
const channelId = '00000000-0000-4000-8000-01670d853f95'
const fileId = '00000000-0000-4000-8000-f739b2d7b3b6'
const requestId = '00000000-0000-4000-8000-46dfc9f2c745'
const roomId = '!company:matrix.test'
const bytes = new TextEncoder().encode('brief')
const sha256 = createHash('sha256').update(bytes).digest('hex')
const file = {
  v: 1 as const,
  company_id: companyId,
  channel_id: channelId,
  file_id: fileId,
  revision: 1 as const,
  name: 'brief.txt',
  content_type: 'text/plain',
  size: bytes.byteLength,
  sha256
}

function fixture(answers: MatrixCompanyFileValue[], pending: MatrixCompanyFilePending | null = null) {
  const writes: MatrixCompanyFilePending[] = []
  const platform = vi.fn(async (_input: MatrixCompanyFileRequest) => {
    const answer = answers.shift()
    if (!answer) {
      throw new Error('unexpected platform call')
    }
    return answer
  })
  const sdk = vi.fn(async command =>
    command.kind === 'companyFileContext'
      ? {
          companyId,
          target: { kind: 'channel' as const, channelId },
          roomId,
          ...('threadRootId' in command && command.threadRootId
            ? { threadRootId: command.threadRootId, replyTo: command.replyTo ?? command.threadRootId }
            : {})
        }
      : command.kind === 'companyFileSend'
        ? '$file-event'
        : file
  )
  const ports: MatrixCompanyFileControllerPorts = {
    pending: () => pending,
    remember: value => {
      pending = value
      writes.push(value)
    },
    clear: () => {
      pending = null
    },
    platform,
    sdk,
    current: () => true,
    upload: vi.fn(async () => {}),
    download: vi.fn(async () => bytes),
    requestId: () => requestId
  }
  return { ports, platform, sdk, writes, pending: () => pending }
}

const reserved = {
  schemaVersion: 1 as const,
  state: 'reserved' as const,
  requestId,
  file,
  serverUrl: 'https://drive.example',
  uploadGrant: { nativeGrant: 'A'.repeat(43), expiresAtMs: Date.now() + 60_000 }
}
const published = {
  schemaVersion: 1 as const,
  state: 'published' as const,
  file,
  roomId,
  eventId: '$file-event',
  matrixTransactionId: `atum-cf-${requestId}`
}

describe('company file controller', () => {
  it('journals before I/O, keeps grants out, uploads once, sends one reference and publishes it', async () => {
    const f = fixture([reserved, published])
    await expect(
      sendCompanyFile(
        { roomId, name: file.name, contentType: file.content_type, bytes },
        f.ports,
        new AbortController().signal
      )
    ).resolves.toBe('$file-event')
    expect(f.platform.mock.calls.map(call => call[0].action)).toEqual(['reserve', 'publish'])
    expect(f.ports.upload).toHaveBeenCalledTimes(1)
    expect(f.sdk.mock.calls.map(call => call[0].kind)).toEqual(['companyFileContext', 'companyFileSend'])
    expect(f.writes.map(value => value.phase)).toEqual(['reserved', 'writing', 'ready', 'published'])
    expect(JSON.stringify(f.writes)).not.toContain('A'.repeat(43))
    expect(JSON.stringify(f.writes)).not.toContain('https://drive.example')
    expect(f.pending()).toBeNull()
  })

  it('reconciles an unknown upload by request id before sending, without another reserve', async () => {
    const ready = {
      schemaVersion: 1 as const,
      state: 'ready' as const,
      requestId,
      file,
      resource: { storage: 's', space: 'p', opaque: 'o' },
      etag: 'e'
    }
    const f = fixture([reserved, { schemaVersion: 1, state: 'unknown', requestId, file }, ready, published])
    f.ports.upload = vi.fn(async () => {
      throw new MatrixCompanyFileError('unavailable')
    })
    vi.useFakeTimers()

    try {
      const sending = sendCompanyFile(
        { roomId, name: file.name, contentType: file.content_type, bytes },
        f.ports,
        new AbortController().signal
      )
      await vi.runAllTimersAsync()
      await expect(sending).resolves.toBe('$file-event')
      expect(f.platform.mock.calls.map(call => call[0].action)).toEqual(['reserve', 'status', 'status', 'publish'])
      expect(f.ports.upload).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for an asynchronous reservation to become ready instead of failing the attachment', async () => {
    const ready = {
      schemaVersion: 1 as const,
      state: 'ready' as const,
      requestId,
      file,
      resource: { storage: 's', space: 'p', opaque: 'o' },
      etag: 'e'
    }
    const f = fixture([
      { schemaVersion: 1, state: 'writing', requestId, file },
      { schemaVersion: 1, state: 'unknown', requestId, file },
      ready,
      published
    ])
    vi.useFakeTimers()

    try {
      const sending = sendCompanyFile(
        { roomId, name: file.name, contentType: file.content_type, bytes },
        f.ports,
        new AbortController().signal
      )
      await vi.runAllTimersAsync()
      await expect(sending).resolves.toBe('$file-event')
      expect(f.platform.mock.calls.map(call => call[0].action)).toEqual(['reserve', 'status', 'status', 'publish'])
      expect(f.ports.upload).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconciles a lost publish reply by the same request id without sending another Matrix event', async () => {
    const f = fixture([])
    f.platform
      .mockResolvedValueOnce(reserved)
      .mockRejectedValueOnce(new MatrixCompanyFileError('unavailable'))
      .mockResolvedValueOnce(published)

    await expect(
      sendCompanyFile(
        { roomId, name: file.name, contentType: file.content_type, bytes },
        f.ports,
        new AbortController().signal
      )
    ).resolves.toBe('$file-event')
    expect(f.platform.mock.calls.map(call => call[0].action)).toEqual(['reserve', 'publish', 'status'])
    expect(f.sdk.mock.calls.filter(call => call[0].kind === 'companyFileSend')).toHaveLength(1)
  })

  it('clears a terminal cancelled reservation and reports version drift consistently', async () => {
    const f = fixture([{ schemaVersion: 1, state: 'cancelled', requestId, file }])
    await expect(
      sendCompanyFile(
        { roomId, name: file.name, contentType: file.content_type, bytes },
        f.ports,
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(f.platform.mock.calls.map(call => call[0].action)).toEqual(['reserve'])
    expect(f.pending()).toBeNull()
  })

  it('stops after a native transfer when the owning host changes', async () => {
    const f = fixture([reserved])
    let current = true
    f.ports.current = () => current
    f.ports.upload = vi.fn(async () => {
      current = false
    })
    await expect(
      sendCompanyFile(
        { roomId, name: file.name, contentType: file.content_type, bytes },
        f.ports,
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(f.sdk.mock.calls.map(call => call[0].kind)).toEqual(['companyFileContext'])
    expect(f.platform.mock.calls.map(call => call[0].action)).toEqual(['reserve'])
  })

  it('resumes a Matrix-acknowledged journal at publish and refuses a different staged file', async () => {
    const pending: MatrixCompanyFilePending = {
      schemaVersion: 1,
      phase: 'published',
      requestId,
      companyId,
      channelId,
      roomId,
      name: file.name,
      contentType: file.content_type,
      size: file.size,
      sha256,
      transactionId: `atum-cf-${requestId}`,
      fileId,
      revision: 1,
      eventId: '$file-event'
    }
    const ready = {
      schemaVersion: 1 as const,
      state: 'ready' as const,
      requestId,
      file,
      resource: { storage: 's', space: 'p', opaque: 'o' },
      etag: 'e'
    }
    const f = fixture([ready, published], pending)
    await expect(
      sendCompanyFile(
        { roomId, name: file.name, contentType: file.content_type, bytes },
        f.ports,
        new AbortController().signal
      )
    ).resolves.toBe('$file-event')
    expect(f.sdk.mock.calls.map(call => call[0].kind)).toEqual(['companyFileContext'])
    expect(f.platform.mock.calls.map(call => call[0].action)).toEqual(['status', 'publish'])

    const conflict = fixture(
      [
        {
          schemaVersion: 1,
          state: 'unknown',
          requestId,
          file
        }
      ],
      pending
    )
    await expect(
      sendCompanyFile(
        { roomId, name: 'other.txt', contentType: file.content_type, bytes },
        conflict.ports,
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(conflict.platform.mock.calls.map(call => call[0].action)).toEqual(['status'])
  })

  it('finishes a ready restart journal without the original local bytes', async () => {
    const pending: MatrixCompanyFilePending = {
      schemaVersion: 1,
      phase: 'ready',
      requestId,
      companyId,
      channelId,
      roomId,
      name: file.name,
      contentType: file.content_type,
      size: file.size,
      sha256,
      transactionId: `atum-cf-${requestId}`,
      fileId,
      revision: 1
    }
    const ready = {
      schemaVersion: 1 as const,
      state: 'ready' as const,
      requestId,
      file,
      resource: { storage: 's', space: 'p', opaque: 'o' },
      etag: 'e'
    }
    const f = fixture([ready, published], pending)
    await expect(recoverCompanyFile(f.ports, new AbortController().signal)).resolves.toEqual({
      state: 'complete',
      eventId: '$file-event'
    })
    expect(f.sdk.mock.calls.map(call => call[0].kind)).toEqual(['companyFileContext', 'companyFileSend'])
    expect(f.platform.mock.calls.map(call => call[0].action)).toEqual(['status', 'publish'])
    expect(f.pending()).toBeNull()
  })

  it('downloads through a fresh native grant and exposes only name and verified bytes', async () => {
    const f = fixture([
      {
        schemaVersion: 1,
        state: 'ready',
        file,
        serverUrl: 'https://drive.example',
        downloadGrant: { nativeGrant: 'B'.repeat(43), expiresAtMs: Date.now() + 60_000 }
      }
    ])
    await expect(readCompanyFile(file, f.ports, new AbortController().signal)).resolves.toEqual({
      name: 'brief.txt',
      bytes
    })
    expect(f.platform).toHaveBeenCalledWith(
      {
        action: 'download',
        companyId,
        channelId,
        fileId,
        revision: 1
      },
      expect.any(AbortSignal)
    )
  })
})
