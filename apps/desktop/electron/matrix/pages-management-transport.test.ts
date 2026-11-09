import { describe, expect, it, vi } from 'vitest'

import type { MatrixHermesConnection } from './hermes-runtime'
import { MatrixPagesManagementTransport } from './pages-management-transport'
import { MatrixHermesTurnLock } from './turn-lock'

function fixture() {
  const abort = new AbortController()
  const pages = vi.fn(async (_value: unknown) => ({ ok: true }))
  const request = vi.fn(async (..._args: unknown[]) => ({ status: 'reloaded' }))
  const original = { signal: abort.signal, pages, gateway: { request } } as unknown as MatrixHermesConnection
  let connection: MatrixHermesConnection | undefined = original
  let current = true
  let busy = false
  const lock = new MatrixHermesTurnLock()

  const connect = vi.fn(async () => {
    connection = original
  })

  const transport = new MatrixPagesManagementTransport({
    isCurrent: () => current,
    connection: () => connection,
    busy: () => busy,
    connect,
    lock
  })

  return {
    abort,
    pages,
    request,
    original,
    lock,
    connect,
    transport,
    setConnection: (value: MatrixHermesConnection | undefined) => {
      connection = value
    },
    setCurrent: (value: boolean) => {
      current = value
    },
    setBusy: (value: boolean) => {
      busy = value
    }
  }
}

const read = { path: '/api/mcp/servers?profile=default', method: 'GET' as const }
const write = { path: '/api/mcp/servers?profile=default', method: 'POST' as const, body: { name: 'fixture' } }

describe('actual management transport lifetime and shared turn lock', () => {
  it('cancels OAuth created after its page retired before rejecting the stale start result', async () => {
    const f = fixture()
    let finish!: (value: unknown) => void
    f.pages.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )

    const pending = f.transport.forward({
      path: '/api/providers/oauth/anthropic/start?profile=default',
      method: 'POST'
    })

    await vi.waitFor(() => expect(f.pages).toHaveBeenCalledOnce())
    f.transport.retire()
    finish({ session_id: 'late-session', flow: 'pkce' })
    await expect(pending).rejects.toThrow('pages_agent_unavailable')
    expect(f.pages).toHaveBeenLastCalledWith({
      path: '/api/providers/oauth/sessions/late-session?profile=default',
      method: 'DELETE'
    })
  })
  it('cancels retained OAuth only on the pinned process after view retirement, never a replacement', async () => {
    const f = fixture()
    await f.transport.cancelOAuth('early')
    expect(f.pages).not.toHaveBeenCalled()
    expect(f.connect).not.toHaveBeenCalled()
    await f.transport.forward(read)
    f.transport.retire()
    const replacement = vi.fn()
    f.setConnection({ ...f.original, pages: replacement })
    await f.transport.cancelOAuth('owned-session')
    expect(f.pages).toHaveBeenLastCalledWith({
      path: '/api/providers/oauth/sessions/owned-session?profile=default',
      method: 'DELETE'
    })
    expect(replacement).not.toHaveBeenCalled()
    expect(f.connect).not.toHaveBeenCalled()
    await f.transport.cancelOAuth('../bad')
    expect(f.pages).toHaveBeenCalledTimes(2)
  })
  it('starts once, uses the owned pages transport and rejects a replacement backend without reconnecting', async () => {
    const f = fixture()
    f.setConnection(undefined)
    await Promise.all([f.transport.forward(read), f.transport.forward(read)])
    expect(f.connect).toHaveBeenCalledOnce()
    expect(f.pages).toHaveBeenCalledTimes(2)
    f.setConnection({ ...f.original } as MatrixHermesConnection)
    await expect(f.transport.forward(write)).rejects.toThrow('pages_agent_unavailable')
    expect(f.connect).toHaveBeenCalledOnce()
    expect(f.pages).toHaveBeenCalledTimes(2)
  })

  it.each(['turn', 'operation'] as const)('does not mutate or reload during a selected agent %s', async kind => {
    const f = fixture()
    const release = kind === 'turn' ? await f.lock.acquire('room', 'local') : undefined
    f.setBusy(kind === 'operation')
    await expect(f.transport.forward(write)).rejects.toThrow('pages_agent_busy')
    await expect(f.transport.reload()).rejects.toThrow('pages_agent_busy')
    expect(f.pages).not.toHaveBeenCalled()
    expect(f.request).not.toHaveBeenCalled()
    await f.transport.forward(read)
    expect(f.pages).toHaveBeenCalledOnce()
    release?.()
  })

  it('holds the same turn lock through a write and releases it after failure', async () => {
    const f = fixture()
    let reject!: (reason: Error) => void
    f.pages.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )
    const operation = f.transport.forward(write)
    await vi.waitFor(() => expect(f.pages).toHaveBeenCalledOnce())
    expect(f.lock.holder?.label).toBe('management')
    await expect(f.transport.reload()).rejects.toThrow('pages_agent_busy')
    reject(new Error('fixture failure'))
    await expect(operation).rejects.toThrow('fixture failure')
    expect(f.lock.holder).toBeUndefined()
    await f.transport.reload()
    expect(f.request).toHaveBeenCalledExactlyOnceWith('reload.mcp', { confirm: true }, 60_000, f.original.signal)
  })

  it('settles an OAuth start IPC pending on the owned backend when that backend dies', async () => {
    const f = fixture()
    f.pages.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          f.abort.signal.addEventListener('abort', () => reject(f.abort.signal.reason), { once: true })
        })
    )

    const pending = f.transport.forward({
      path: '/api/providers/oauth/openai-codex/start?profile=default',
      method: 'POST'
    })

    await vi.waitFor(() => expect(f.pages).toHaveBeenCalledOnce())
    expect(f.lock.holder?.label).toBe('management')
    f.abort.abort(new Error('backend exited'))

    await expect(pending).rejects.toThrow('backend exited')
    expect(f.lock.holder).toBeUndefined()
  })

  it.each(['account', 'view', 'process'] as const)('fences a late response after %s retirement', async kind => {
    const f = fixture()
    let finish!: (value: { ok: boolean }) => void
    f.pages.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const operation = f.transport.forward(read)
    await vi.waitFor(() => expect(f.pages).toHaveBeenCalledOnce())

    if (kind === 'account') {
      f.setCurrent(false)
    }

    if (kind === 'view') {
      f.transport.retire()
    }

    if (kind === 'process') {
      f.abort.abort()
    }

    finish({ ok: true })
    await expect(operation).rejects.toThrow('pages_agent_unavailable')
    await expect(f.transport.reload()).rejects.toThrow('pages_agent_unavailable')
    expect(f.request).not.toHaveBeenCalled()
  })
})
