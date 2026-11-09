// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'

import type {
  MatrixRuntimeSettingsClient,
  MatrixRuntimeSnapshot,
  MatrixRuntimeWriteResult
} from '../../shared/matrix-runtime-settings'

import { computerUseGrantCopy } from './computer-use-grant-copy'
import { computerUseStatusCopy } from './computer-use-status-copy'
import { MatrixRuntimeSettings } from './runtime-settings'
import { runtimeSettingsCopy } from './runtime-settings-copy'

// The shared model card measures itself (Radix); jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

const initialSnapshot: MatrixRuntimeSnapshot = {
  main: { provider: 'openai', model: 'gpt-current', contextLength: 128_000 },
  modelEditable: true,
  models: ['gpt-current', 'gpt-next'],
  memory: {
    active: 'mem-ready',
    providers: [
      { name: 'mem-ready', description: 'Ready local memory', status: 'ready' },
      { name: 'mem-config', description: 'Needs configuration', status: 'needs_config' },
      { name: 'mem-offline', description: 'Offline', status: 'unavailable' }
    ]
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(next => {
    resolve = next
  })

  return { promise, resolve }
}

function setup({
  client: clientOverrides = {},
  locale = 'en',
  snapshot = initialSnapshot
}: {
  client?: Partial<MatrixRuntimeSettingsClient>
  locale?: Locale
  snapshot?: MatrixRuntimeSnapshot
} = {}) {
  const client: MatrixRuntimeSettingsClient = {
    snapshot: vi.fn().mockResolvedValue(snapshot),
    setMemory: vi.fn().mockResolvedValue({ status: 'applied', kind: 'memory', active: '' }),
    setModel: vi
      .fn()
      .mockResolvedValue({ status: 'applied', kind: 'model', provider: 'openai', model: 'gpt-next', staleAux: false }),
    ...clientOverrides
  }

  const view = render(
    <I18nProvider initialLocale={locale}>
      <MatrixRuntimeSettings agentName="Ada" client={client} />
    </I18nProvider>
  )

  return { client, ...view }
}

async function waitForSnapshot() {
  await waitFor(() => expect(screen.getByTestId('runtime-current-model')).toBeTruthy())
}

/** The main model is chosen in the shared model card; its trigger is named for the field. */
const mainModelTrigger = () => screen.queryByRole('button', { name: new RegExp(`^${runtimeSettingsCopy.en.mainModel}`) })

async function choose(label: string, option: string) {
  if (label === runtimeSettingsCopy.en.mainModel) {
    fireEvent.click(mainModelTrigger()!)
    const card = await screen.findByRole('dialog', { name: label })
    fireEvent.click(card.querySelector<HTMLElement>(`[data-matrix-model-route$=":${option}"]`)!)

    return
  }

  fireEvent.click(screen.getByRole('combobox', { name: label }))
  fireEvent.click(await screen.findByRole('option', { name: option }))
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('MatrixRuntimeSettings', () => {
  it('clears earlier grant claims on a lost request and shows a failed fresh read without optimistic success', async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce({
        platform: 'darwin',
        installed: true,
        ready: true,
        accessibility: true,
        screenRecording: true,
        screenRecordingCapturable: true
      })
      .mockRejectedValueOnce(new Error('private fresh-read failure'))

    const start = vi.fn().mockResolvedValue({ status: 'unknown' })

    const client: MatrixRuntimeSettingsClient = {
      snapshot: vi.fn().mockResolvedValue(initialSnapshot),
      setModel: vi.fn(),
      setMemory: vi.fn()
    }

    render(
      <I18nProvider initialLocale="en">
        <MatrixRuntimeSettings
          agentName="Ada"
          client={client}
          computerUseClient={{ status }}
          computerUseGrantClient={{ start, operationStatus: vi.fn() }}
        />
      </I18nProvider>
    )
    await waitFor(() => expect(within(globalThis.document.querySelector('[data-matrix-computer-use-status]') as HTMLElement).getByText(computerUseStatusCopy.en.ready)).toBeTruthy())
    expect(screen.getAllByText(computerUseStatusCopy.en.granted)).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: computerUseGrantCopy.en.request }))
    expect(await screen.findByText(computerUseStatusCopy.en.statusError)).toBeTruthy()
    expect(status).toHaveBeenCalledTimes(2)
    expect(start).toHaveBeenCalledOnce()
    expect(within(globalThis.document.querySelector('[data-matrix-computer-use-status]') as HTMLElement).queryByText(computerUseStatusCopy.en.ready)).toBeNull()
    expect(screen.queryByText(computerUseStatusCopy.en.granted)).toBeNull()
    expect(screen.getByTestId('runtime-current-model').textContent).toBe('gpt-current')
    expect(globalThis.document.body.textContent).not.toContain('private fresh-read failure')
  })

  it('retires the pending pre-request read before fresh reconciliation can publish new facts', async () => {
    const old = deferred<unknown>()

    const status = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce({
      platform: 'darwin',
      installed: true,
      ready: false,
      accessibility: false,
      screenRecording: false,
      screenRecordingCapturable: null
    })

    const client: MatrixRuntimeSettingsClient = {
      snapshot: vi.fn().mockResolvedValue(initialSnapshot),
      setModel: vi.fn(),
      setMemory: vi.fn()
    }

    render(
      <I18nProvider initialLocale="en">
        <MatrixRuntimeSettings
          agentName="Ada"
          client={client}
          computerUseClient={{ status }}
          computerUseGrantClient={{ start: vi.fn().mockResolvedValue({ status: 'unknown' }), operationStatus: vi.fn() }}
        />
      </I18nProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: computerUseGrantCopy.en.request }))
    await waitFor(() => expect(within(globalThis.document.querySelector('[data-matrix-computer-use-status]') as HTMLElement).getByText(computerUseStatusCopy.en.notReady)).toBeTruthy())
    expect(status).toHaveBeenCalledTimes(2)
    await act(async () =>
      old.resolve({
        platform: 'darwin',
        installed: true,
        ready: true,
        accessibility: true,
        screenRecording: true,
        screenRecordingCapturable: true
      })
    )
    expect(screen.getAllByText(computerUseStatusCopy.en.notGranted)).toHaveLength(2)
    expect(screen.queryByText(computerUseStatusCopy.en.granted)).toBeNull()
    expect(within(globalThis.document.querySelector('[data-matrix-computer-use-status]') as HTMLElement).queryByText(computerUseStatusCopy.en.ready)).toBeNull()
  })

  it('keeps existing Runtime controls usable when the independent Computer Use read fails', async () => {
    const client: MatrixRuntimeSettingsClient = {
      snapshot: vi.fn().mockResolvedValue(initialSnapshot),
      setModel: vi.fn(),
      setMemory: vi.fn()
    }

    render(
      <I18nProvider initialLocale="en">
        <MatrixRuntimeSettings
          agentName="Ada"
          client={client}
          computerUseClient={{ status: vi.fn().mockRejectedValue(new Error('private diagnostic')) }}
        />
      </I18nProvider>
    )
    await waitForSnapshot()
    expect(await screen.findByText(computerUseStatusCopy.en.statusError)).toBeTruthy()
    expect(screen.getByTestId('runtime-current-model').textContent).toBe('gpt-current')
    expect(mainModelTrigger()).toBeTruthy()
    expect(screen.queryByText('private diagnostic')).toBeNull()
  })

  it('reads Computer Use independently when the model and memory snapshot is unavailable', async () => {
    const client: MatrixRuntimeSettingsClient = {
      snapshot: vi.fn().mockRejectedValue(new Error('private config')),
      setModel: vi.fn(),
      setMemory: vi.fn()
    }

    render(
      <I18nProvider initialLocale="en">
        <MatrixRuntimeSettings
          agentName="Ada"
          client={client}
          computerUseClient={{
            status: vi.fn().mockResolvedValue({
              platform: 'darwin',
              installed: false,
              ready: null,
              accessibility: null,
              screenRecording: null,
              screenRecordingCapturable: null
            })
          }}
        />
      </I18nProvider>
    )
    expect(await screen.findByText(computerUseStatusCopy.en.notInstalled)).toBeTruthy()
    expect(screen.queryByText('private config')).toBeNull()
  })

  it('shows a generic initial read error and supports a successful reload', async () => {
    const { client } = setup({
      client: {
        snapshot: vi.fn().mockRejectedValueOnce(new Error('private-endpoint')).mockResolvedValueOnce(initialSnapshot)
      }
    })

    await waitFor(() => expect(screen.getByText(runtimeSettingsCopy.en.requestError)).toBeTruthy())
    expect(screen.queryByText('private-endpoint')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: runtimeSettingsCopy.en.reload }))
    await waitForSnapshot()
    expect(client.snapshot).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(runtimeSettingsCopy.en.requestError)).toBeNull()
  })

  it('reports an unknown main model without offering a model picker', async () => {
    setup({ snapshot: { ...initialSnapshot, main: null, modelEditable: false } })
    await waitForSnapshot()
    expect(screen.getByTestId('runtime-current-model').textContent).toBe(runtimeSettingsCopy.en.unknown)
    expect(mainModelTrigger()).toBeNull()
  })

  it('retains the generic auxiliary-model warning after a successful normalized reread', async () => {
    setup({
      client: {
        setModel: vi.fn().mockResolvedValue({
          status: 'applied',
          kind: 'model',
          provider: 'openai',
          model: 'gpt-next',
          staleAux: true
        })
      }
    })
    await waitForSnapshot()
    await choose(runtimeSettingsCopy.en.mainModel, 'gpt-next')
    await waitFor(() => expect(screen.getByText(runtimeSettingsCopy.en.applied)).toBeTruthy())
    expect(screen.getByText(runtimeSettingsCopy.en.staleAux)).toBeTruthy()
  })

  it('does not claim success or paint an optimistic model when the post-write reread fails', async () => {
    setup({
      client: {
        snapshot: vi.fn().mockResolvedValueOnce(initialSnapshot).mockRejectedValueOnce(new Error('private-endpoint'))
      }
    })
    await waitForSnapshot()
    await choose(runtimeSettingsCopy.en.mainModel, 'gpt-next')
    await waitFor(() => expect(screen.getByText(runtimeSettingsCopy.en.refreshError)).toBeTruthy())
    expect(screen.queryByText(runtimeSettingsCopy.en.applied)).toBeNull()
    expect(screen.queryByText('private-endpoint')).toBeNull()
    expect(screen.getByTestId('runtime-current-model').textContent).toBe('gpt-current')
  })

  it('limits model selection to the selected agent’s current provider and refreshes normalized truth after apply', async () => {
    const normalized: MatrixRuntimeSnapshot = {
      ...initialSnapshot,
      main: { provider: 'openai', model: 'gpt-normalized', contextLength: 64_000 }
    }

    const { client } = setup({
      client: {
        snapshot: vi.fn().mockResolvedValueOnce(initialSnapshot).mockResolvedValueOnce(normalized)
      }
    })

    await waitForSnapshot()

    expect(screen.getByText('openai')).toBeTruthy()
    expect(screen.queryByText(/provider setup/i)).toBeNull()
    await choose(runtimeSettingsCopy.en.mainModel, 'gpt-next')

    await waitFor(() => expect(client.setModel).toHaveBeenCalledWith('openai', 'gpt-next'))
    await waitFor(() => expect(screen.getByTestId('runtime-current-model').textContent).toBe('gpt-normalized'))
    expect(client.snapshot).toHaveBeenCalledTimes(2)
    expect(screen.getByText(runtimeSettingsCopy.en.applied)).toBeTruthy()
  })

  it('shows pending and treats a native cancellation as no successful change', async () => {
    const request = deferred<MatrixRuntimeWriteResult>()
    const { client } = setup({ client: { setMemory: vi.fn(() => request.promise) } })
    await waitForSnapshot()

    await choose(runtimeSettingsCopy.en.activeMemory, runtimeSettingsCopy.en.builtInMemory)
    expect(screen.getByText(runtimeSettingsCopy.en.pending)).toBeTruthy()
    expect(mainModelTrigger()!.hasAttribute('disabled')).toBe(true)

    await act(async () => request.resolve({ status: 'cancelled' }))
    await waitFor(() => expect(screen.getByText(runtimeSettingsCopy.en.cancelled)).toBeTruthy())
    expect(client.snapshot).toHaveBeenCalledOnce()
    expect(screen.queryByText(runtimeSettingsCopy.en.applied)).toBeNull()
  })

  it('uses a generic, non-secret error after a failed request', async () => {
    setup({ client: { setModel: vi.fn().mockRejectedValue(new Error('token=not-for-display')) } })
    await waitForSnapshot()

    await choose(runtimeSettingsCopy.en.mainModel, 'gpt-next')
    await waitFor(() => expect(screen.getByText(runtimeSettingsCopy.en.requestError)).toBeTruthy())
    expect(screen.queryByText('token=not-for-display')).toBeNull()
  })

  it('makes the current provider model read-only when native says it is not editable', async () => {
    setup({ snapshot: { ...initialSnapshot, modelEditable: false } })
    await waitForSnapshot()

    expect(screen.getByText(runtimeSettingsCopy.en.modelReadOnly)).toBeTruthy()
    expect(mainModelTrigger()).toBeNull()
  })

  it('allows only ready memory providers and maps built-in memory to the empty native selection', async () => {
    const { client } = setup()
    await waitForSnapshot()
    fireEvent.click(screen.getByRole('combobox', { name: runtimeSettingsCopy.en.activeMemory }))

    expect((await screen.findByRole('option', { name: /mem-ready/i })).getAttribute('aria-disabled')).not.toBe('true')
    expect(screen.getByRole('option', { name: /mem-config/i }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('option', { name: /mem-offline/i }).getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(screen.getByRole('option', { name: runtimeSettingsCopy.en.builtInMemory }))

    await waitFor(() => expect(client.setMemory).toHaveBeenCalledWith(''))
  })

  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)('uses runtime copy for %s', async locale => {
    setup({ locale })
    await waitForSnapshot()

    expect(screen.getByText(runtimeSettingsCopy[locale].title)).toBeTruthy()
    expect(screen.getByText(runtimeSettingsCopy[locale].modelDescription)).toBeTruthy()
    expect(screen.getByText(runtimeSettingsCopy[locale].memoryDescription)).toBeTruthy()
  })

  it('drops a completion after unmount instead of refreshing or painting stale state', async () => {
    const request = deferred<MatrixRuntimeWriteResult>()
    const { client, unmount } = setup({ client: { setModel: vi.fn(() => request.promise) } })
    await waitForSnapshot()
    await choose(runtimeSettingsCopy.en.mainModel, 'gpt-next')
    unmount()

    await act(async () =>
      request.resolve({ status: 'applied', kind: 'model', provider: 'openai', model: 'gpt-next', staleAux: true })
    )
    expect(client.snapshot).toHaveBeenCalledOnce()
  })
})
