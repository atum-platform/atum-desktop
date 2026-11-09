import { createHash } from 'node:crypto'

import { expect, it, vi } from 'vitest'

import { MatrixPagesDebugShareScope } from './pages-debug-share'

const prefix = '/api/command-center/debug-share/'

function fixture() {
  let current = true
  const text = 'selected-only café\nprivate conversation preview'

  const captured = {
    profile_scoped: true,
    token: 'a'.repeat(32),
    expires_at: Date.now() / 1000 + 600,
    files: [
      { label: 'report', text, bytes: Buffer.byteLength(text), digest: createHash('sha256').update(text).digest('hex') }
    ]
  }

  let status = {
    profile_scoped: true,
    state: 'unknown',
    destination: null as string | null,
    urls: [] as { label: string; url: string }[],
    uncertain_label: null
  }

  const forward = vi.fn(async (value: { path: string; body?: unknown }) => {
    if (value.path.includes('/preview?')) {
      return structuredClone(captured)
    }

    if (value.path.includes('/status?')) {
      return structuredClone(status)
    }

    if (value.path.includes('/upload?')) {
      status = {
        ...status,
        state: 'succeeded',
        destination: 'paste.rs',
        urls: [{ label: 'report', url: 'https://paste.rs/fixture' }]
      }

      return structuredClone(status)
    }

    throw new Error('unexpected-private-source')
  })

  const confirm = vi.fn(async () => true)
  const open = vi.fn(async (_url: string) => {})
  const copy = vi.fn(async (_url: string) => {})
  const scope = new MatrixPagesDebugShareScope({ isCurrent: () => current, forward, confirm, open, copy })

  return {
    scope,
    forward,
    confirm,
    open,
    copy,
    captured,
    retire: () => {
      current = false
    },
    setStatus: (v: typeof status) => {
      status = v
    }
  }
}

const capture = { path: prefix + 'preview', method: 'POST' }
const upload = { path: prefix + 'upload', method: 'POST', body: { destination: 'paste.rs', labels: ['report'] } }
it('preview shows exact UTF-8 bytes but no native token; confirmation then publishes those labels', async () => {
  const f = fixture()
  const preview = await f.scope.request(capture)
  expect(preview).toEqual({
    files: [{ label: 'report', text: f.captured.files[0].text, bytes: f.captured.files[0].bytes }]
  })
  expect(JSON.stringify(preview)).not.toContain(f.captured.token)
  await f.scope.request(upload)
  expect(f.confirm).toHaveBeenCalledWith({
    destination: 'paste.rs',
    files: [{ label: 'report', bytes: f.captured.files[0].bytes }]
  })
  expect(f.forward).toHaveBeenLastCalledWith({
    path: '/api/debug-share/upload?profile=default',
    method: 'POST',
    body: { token: f.captured.token, destination: 'paste.rs', labels: ['report'] }
  })
  await expect(f.scope.request(upload)).rejects.toThrow('matrix_debug_preview_expired')
  expect(f.forward.mock.calls.filter(([r]) => r.path.includes('/upload?'))).toHaveLength(1)
})
it('cancel, expiry, old backend and retirement cannot upload', async () => {
  const cancelled = fixture()
  await cancelled.scope.request(capture)
  cancelled.confirm.mockResolvedValue(false)
  expect(await cancelled.scope.request(upload)).toEqual({ status: 'cancelled' })
  expect(cancelled.forward.mock.calls.some(([r]) => r.path.includes('/upload?'))).toBe(false)
  const expired = fixture()
  expired.captured.expires_at = 1
  await expect(expired.scope.request(capture)).rejects.toThrow('matrix_debug_share_invalid_response')
  const old = fixture()
  await old.scope.request(capture)
  old.forward.mockResolvedValue({ state: 'unknown' } as never)
  await expect(old.scope.request(upload)).rejects.toThrow('matrix_debug_share_invalid_response')
  expect(old.confirm).not.toHaveBeenCalled()
  const retired = fixture()
  await retired.scope.request(capture)
  retired.confirm.mockImplementation(async () => {
    retired.retire()

    return true
  })
  await expect(retired.scope.request(upload)).rejects.toThrow('matrix_pages_agent_unavailable')
  expect(retired.forward.mock.calls.some(([r]) => r.path.includes('/upload?'))).toBe(false)
})
it.each([
  { path: prefix + 'preview?profile=other', method: 'POST' },
  { path: prefix + 'preview', method: 'GET' },
  { path: prefix + 'preview', method: 'POST', body: {} },
  { path: prefix + 'status', headers: {} },
  { ...upload, body: { ...upload.body, token: 'b'.repeat(32) } },
  { ...upload, body: { destination: 'attacker.test', labels: ['report'] } },
  { ...upload, body: { destination: 'paste.rs', labels: ['report', 'report'] } },
  { ...upload, body: { destination: 'paste.rs', labels: ['/private/file'] } },
  { path: prefix + 'open/report?url=https://attacker.test', method: 'POST' },
  { path: prefix + '%70review', method: 'POST' },
  { path: prefix + 'preview/../upload', method: 'POST' },
  { path: prefix + 'open', method: 'POST' }
])('denies forged authority or routes before capture/upload: %j', async value => {
  const f = fixture()
  await expect(f.scope.request(value)).rejects.toThrow('matrix_pages_request_denied')
  expect(f.forward).not.toHaveBeenCalled()
})
it('rejects digest/size corruption rather than displaying different bytes', async () => {
  const f = fixture()
  f.captured.files[0].text += 'unapproved'
  await expect(f.scope.request(capture)).rejects.toThrow('matrix_debug_share_invalid_response')
})
it.each([
  'https://paste.rs/a\n',
  'http://paste.rs/a',
  'https://paste.rs.evil.test/a',
  'https://paste.rs/a?token=private',
  'https://paste.rs/a#private',
  'https://fixture-4ed95f6b8d@example.invalid/a',
  'https://paste.rs:443/a',
  'https://paste.rs/%61',
  'https://paste.rs/a/b'
])('never projects or opens forged public URL %s', async url => {
  const f = fixture()
  f.setStatus({
    profile_scoped: true,
    state: 'succeeded',
    destination: 'paste.rs',
    urls: [{ label: 'report', url }],
    uncertain_label: null
  })
  await expect(f.scope.request({ path: prefix + 'open/report', method: 'POST' })).rejects.toThrow(
    'matrix_debug_share_invalid_response'
  )
  expect(f.open).not.toHaveBeenCalled()
})
it('copies and opens only fresh, verified receipt labels on explicit request', async () => {
  const f = fixture()
  await f.scope.request(capture)
  await f.scope.request(upload)
  expect(f.copy).not.toHaveBeenCalled()
  expect(f.open).not.toHaveBeenCalled()
  await f.scope.request({ path: prefix + 'copy/report', method: 'POST' })
  await f.scope.request({ path: prefix + 'open/report', method: 'POST' })
  expect(f.copy).toHaveBeenCalledExactlyOnceWith('https://paste.rs/fixture')
  expect(f.open).toHaveBeenCalledExactlyOnceWith('https://paste.rs/fixture')
})
it('busy rejection cannot release another in-flight consent fence', async () => {
  const f = fixture()
  await f.scope.request(capture)
  let finish!: (v: boolean) => void
  f.confirm.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const first = f.scope.request(upload)
  await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce())
  await expect(f.scope.request(capture)).rejects.toThrow('pages_agent_busy')
  await expect(f.scope.request(capture)).rejects.toThrow('pages_agent_busy')
  finish(false)
  await first
})
it('an unknown POST outcome consumes consent and cannot be blindly retried', async () => {
  const f = fixture()
  await f.scope.request(capture)
  const before = f.forward.getMockImplementation()!
  f.forward.mockImplementation(async value => {
    if (value.path.includes('/upload?')) {
      throw new Error('secret-url-private')
    }

    return before(value)
  })
  await expect(f.scope.request(upload)).rejects.toThrow('matrix_debug_share_failed')
  await expect(f.scope.request(upload)).rejects.toThrow('matrix_debug_preview_expired')
  expect(f.forward.mock.calls.filter(([r]) => r.path.includes('/upload?'))).toHaveLength(1)
})
