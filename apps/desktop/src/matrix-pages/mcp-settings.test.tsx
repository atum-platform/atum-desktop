import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'
import { TRANSLATIONS } from '@/i18n/catalog'

import { MatrixPagesMcpScope } from '../../electron/matrix/pages-mcp'
import type { MatrixMcpResult, MatrixMcpSettingsClient, MatrixMcpSnapshot } from '../../shared/matrix-mcp-settings'

import { createMatrixMcpSettingsClient } from './mcp-client'
import { mcpSettingsCopy } from './mcp-copy'
import { MatrixMcpSettings } from './mcp-settings'

const initial: MatrixMcpSnapshot = {
  servers: [{ name: 'demo', transport: 'http', auth: 'oauth', enabled: true }],
  catalog: [
    {
      name: 'catalog-demo',
      description: 'Example server',
      transport: 'stdio',
      auth: 'api_key',
      installed: false,
      enabled: false,
      needsInstall: false,
      requiredEnv: [{ name: 'DEMO_KEY', prompt: 'New catalog key', required: true }]
    }
  ]
}

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(next => {
    resolve = next
  })

  return { resolve, promise }
}

function client(overrides: Partial<MatrixMcpSettingsClient> = {}): MatrixMcpSettingsClient {
  return {
    snapshot: vi.fn().mockResolvedValue(initial),
    add: vi.fn().mockResolvedValue({ status: 'applied' }),
    remove: vi.fn().mockResolvedValue({ status: 'applied' }),
    test: vi.fn().mockResolvedValue({ status: 'tested', ok: true, toolCount: 3, prompts: 1, resources: 2 }),
    authenticate: vi.fn().mockResolvedValue({ status: 'applied' }),
    authStatus: vi.fn().mockResolvedValue({ status: 'operation', operationId: 'operation', state: 'applied' }),
    cancelAuth: vi.fn().mockResolvedValue({ status: 'cancelled' }),
    setEnabled: vi.fn().mockResolvedValue({ status: 'applied' }),
    install: vi.fn().mockResolvedValue({ status: 'applied' }),
    installStatus: vi.fn(),
    reload: vi.fn().mockResolvedValue({ status: 'applied' }),
    ...overrides
  }
}

function mount(value = client(), locale: Locale = 'en') {
  return {
    client: value,
    ...render(
      <I18nProvider initialLocale={locale}>
        <MatrixMcpSettings agentName="Ada" client={value} />
      </I18nProvider>
    )
  }
}

async function ready() {
  await waitFor(() => expect(screen.getByText('demo')).toBeTruthy())
}

beforeAll(() => Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('selected-agent MCP page', () => {
  it('performs only a display read on open, without automatic probes/auth/reload', async () => {
    const value = client()
    mount(value)
    await ready()
    expect(value.snapshot).toHaveBeenCalledOnce()

    for (const action of [value.test, value.authenticate, value.reload, value.add, value.install]) {
      expect(action).not.toHaveBeenCalled()
    }

    expect(screen.getByText(mcpSettingsCopy.en.privateSettings)).toBeTruthy()
  })

  it('composes the real native adapter/client and shared MCP controls without leaking saved inputs', async () => {
    const confirm = vi.fn().mockResolvedValue(true)

    let servers = [
      {
        name: 'demo',
        transport: 'http',
        auth: 'oauth',
        enabled: true,
        url: 'https://private.example',
        env: { SECRET: 'private-key' }
      }
    ]

    const forward = vi.fn(async request => {
      if (request.method === 'GET' && request.path.startsWith('/api/mcp/servers?')) {
        return { servers }
      }

      if (request.path.startsWith('/api/mcp/catalog?')) {
        return { entries: [] }
      }

      if (request.path.includes('/test?')) {
        return { ok: true, tools: [{ name: 'private-tool-name', description: 'private-description' }] }
      }

      if (request.method === 'DELETE') {
        servers = []

        return { ok: true }
      }

      return { ok: true }
    })

    const reload = vi.fn().mockResolvedValue({ status: 'reloaded' })
    const scope = new MatrixPagesMcpScope({ forward, confirm, reload, isCurrent: () => true, openExternal: vi.fn() })
    mount(createMatrixMcpSettingsClient(request => scope.request(request)))
    await ready()
    expect(globalThis.document.body.textContent).not.toMatch(/private-/)
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(screen.getByText('1 tools enabled')).toBeTruthy())
    expect(confirm).toHaveBeenCalledWith({ kind: 'mcp-test', name: 'demo' })
    expect(globalThis.document.body.textContent).not.toMatch(/private-/)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.queryByText('demo')).toBeNull())
    expect(reload).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reload MCP' }))
    await waitFor(() => expect(reload).toHaveBeenCalledOnce())
    expect(confirm).toHaveBeenLastCalledWith({ kind: 'mcp-reload' })
    scope.stop()
  })

  it('keeps mutation inputs separate from saved data and clears the form after confirmed add/readback', async () => {
    const value = client({
      snapshot: vi
        .fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValue({
          ...initial,
          servers: [...initial.servers, { name: 'new-server', transport: 'stdio', auth: 'none', enabled: true }]
        })
    })

    mount(value)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'New server' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'new-server' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'example-command' } })
    fireEvent.change(screen.getByLabelText('Arguments (JSON array)'), { target: { value: '["--example"]' } })
    fireEvent.change(screen.getByLabelText('Environment inputs (JSON object)'), {
      target: { value: '{"DEMO_KEY":"new-secret"}' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save server' }))
    await waitFor(() =>
      expect(value.add).toHaveBeenCalledWith({
        name: 'new-server',
        transport: 'stdio',
        command: 'example-command',
        args: ['--example'],
        env: { DEMO_KEY: 'new-secret' }
      })
    )
    await waitFor(() => expect(screen.getByText('new-server')).toBeTruthy())
    expect(screen.queryByLabelText('Command')).toBeNull()
    expect(globalThis.document.body.textContent).not.toContain('new-secret')
    expect(value.reload).not.toHaveBeenCalled()
  })

  it('requires valid JSON/provisioning input and offers an explicit cancel without sending', async () => {
    const value = client()
    mount(value)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'New server' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'new-server' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'example-command' } })
    fireEvent.change(screen.getByLabelText('Arguments (JSON array)'), { target: { value: '{"bad":true}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save server' }))
    expect(screen.getByRole('alert').textContent).toBe(mcpSettingsCopy.en.invalid)
    expect(value.add).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Command')).toBeNull()
  })

  it('uses only newly supplied catalog credential inputs and clears them after install', async () => {
    const value = client()
    mount(value)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    const input = screen.getByLabelText('New catalog key') as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.value).toBe('')
    expect(screen.getByRole('button', { name: 'Install' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(input, { target: { value: 'new-catalog-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(value.install).toHaveBeenCalledWith('catalog-demo', { DEMO_KEY: 'new-catalog-secret' }))
    await waitFor(() => expect(screen.queryByLabelText('New catalog key')).toBeNull())
    expect(value.reload).not.toHaveBeenCalled()
  })

  it('handles native denial and busy rejection as no started action', async () => {
    const value = client({
      test: vi.fn().mockResolvedValueOnce({ status: 'cancelled' }).mockRejectedValueOnce(new Error('pages_agent_busy'))
    })

    mount(value)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(screen.getByText(mcpSettingsCopy.en.cancelled)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(screen.getByText(mcpSettingsCopy.en.busy)).toBeTruthy())
    expect(value.snapshot).toHaveBeenCalledOnce()
    expect(screen.queryByText(mcpSettingsCopy.en.applied)).toBeNull()
  })

  it('requires authoritative refresh after uncertain writes and never exposes errors', async () => {
    const value = client({
      snapshot: vi
        .fn()
        .mockResolvedValueOnce(initial)
        .mockRejectedValueOnce(new Error('private-token'))
        .mockResolvedValueOnce(initial)
    })

    mount(value)
    await ready()
    fireEvent.click(screen.getByRole('switch', { name: 'Disable demo' }))
    await waitFor(() => expect(screen.getByText(mcpSettingsCopy.en.uncertain)).toBeTruthy())
    expect(screen.getByRole('button', { name: 'New server' }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByText(mcpSettingsCopy.en.applied)).toBeNull()
    expect(globalThis.document.body.textContent).not.toContain('private-token')
    fireEvent.click(screen.getByRole('button', { name: mcpSettingsCopy.en.refresh }))
    await waitFor(() => expect(screen.queryByText(mcpSettingsCopy.en.uncertain)).toBeNull())
    expect(screen.getByRole('button', { name: 'New server' }).hasAttribute('disabled')).toBe(false)
  })

  it('synchronously stops watching sign-in and drops a late approved result', async () => {
    const status = deferred<MatrixMcpResult>()

    const value = client({
      authenticate: vi.fn().mockResolvedValue({ status: 'operation', operationId: 'original', state: 'starting' }),
      authStatus: vi.fn(() => status.promise)
    })

    mount(value)
    await ready()
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Authenticate' }))
    await act(async () => {})
    expect(screen.getByRole('button', { name: mcpSettingsCopy.en.cancelWatching })).toBeTruthy()
    await act(() => vi.advanceTimersByTimeAsync(1500))
    expect(value.authStatus).toHaveBeenCalledWith('original')
    fireEvent.click(screen.getByRole('button', { name: mcpSettingsCopy.en.cancelWatching }))
    expect(screen.getByText(mcpSettingsCopy.en.stoppedWatching)).toBeTruthy()
    expect(screen.queryByRole('button', { name: mcpSettingsCopy.en.cancelWatching })).toBeNull()
    await act(async () => status.resolve({ status: 'operation', operationId: 'original', state: 'applied' }))
    expect(value.cancelAuth).toHaveBeenCalledWith('original')
    expect(value.snapshot).toHaveBeenCalledOnce()
    expect(screen.queryByText(mcpSettingsCopy.en.applied)).toBeNull()
  })

  it('drops pending old-agent writes when the client/agent changes without remounting', async () => {
    const write = deferred<MatrixMcpResult>()
    const original = client({ remove: vi.fn(() => write.promise) })

    const next = client({
      snapshot: vi.fn().mockResolvedValue({
        servers: [{ name: 'other-agent-server', transport: 'stdio', auth: 'none', enabled: true }],
        catalog: []
      })
    })

    const view = mount(original)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    view.rerender(
      <I18nProvider initialLocale="en">
        <MatrixMcpSettings agentName="Other" client={next} />
      </I18nProvider>
    )
    await waitFor(() => expect(screen.getByText('other-agent-server')).toBeTruthy())
    await act(async () => write.resolve({ status: 'applied' }))
    expect(screen.queryByText('demo')).toBeNull()
    expect(screen.queryByText(mcpSettingsCopy.en.applied)).toBeNull()
    expect(next.snapshot).toHaveBeenCalledOnce()
  })

  it.each<Locale>(['en', 'vi', 'ja', 'zh', 'zh-hant'])(
    'renders management and shared action labels in %s',
    async locale => {
      mount(client(), locale)
      await ready()
      const copy = mcpSettingsCopy[locale]
      expect(screen.getByRole('heading', { name: copy.title })).toBeTruthy()
      expect(screen.getByRole('button', { name: copy.refresh })).toBeTruthy()
      expect(screen.getByRole('button', { name: TRANSLATIONS[locale].settings.mcp.test })).toBeTruthy()
    }
  )
})
