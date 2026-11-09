// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import type {
  SkillHubPreview,
  SkillHubScanResult,
  SkillHubSearchResponse,
  SkillHubSourcesResponse
} from '@/types/hermes'

import { type HubClient, HubPresentation } from './hub-presentation'

const result = {
  description: 'Creates concept diagrams',
  identifier: 'official/creative/concept-diagrams',
  name: 'Concept diagrams',
  repo: null,
  source: 'official',
  tags: [],
  trust_level: 'builtin'
}

function sources(overrides: Partial<SkillHubSourcesResponse> = {}): SkillHubSourcesResponse {
  return {
    featured: [result],
    index_available: true,
    installed: {},
    sources: [
      { id: 'official', label: 'Official' },
      { id: 'community', label: 'Community' }
    ],
    ...overrides
  }
}

function client(overrides: Partial<HubClient> = {}): HubClient {
  return {
    getSources: vi.fn().mockResolvedValue(sources()),
    preview: vi
      .fn()
      .mockResolvedValue({ ...result, files: ['SKILL.md'], skill_md: '# Concept diagrams' } satisfies SkillHubPreview),
    search: vi.fn().mockResolvedValue({
      installed: {},
      results: [result],
      source_counts: {},
      timed_out: []
    } satisfies SkillHubSearchResponse),
    ...overrides
  }
}

function renderHub(props: Partial<ComponentProps<typeof HubPresentation>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const content = (overrides: Partial<ComponentProps<typeof HubPresentation>>) => (
    // English names below; Vietnamese, the default, has its own words for the hub now.
    <I18nProvider configClient={null} initialLocale="en">
      <QueryClientProvider client={queryClient}>
        <HubPresentation
          actions={{}}
          client={client()}
          installedOverrides={{}}
          onInstall={vi.fn().mockResolvedValue(undefined)}
          query=""
          queryKeyPrefix={['native', 'agent-a']}
          {...overrides}
        />
      </QueryClientProvider>
    </I18nProvider>
  )

  const view = render(content(props))

  return { ...view, changeHost: (onScan: ComponentProps<typeof HubPresentation>['onScan']) =>
    view.rerender(content({ ...props, onScan })) }
}

function scanResult(identifier = result.identifier): SkillHubScanResult {
  return {
    name: result.name,
    identifier,
    source: 'community',
    trust_level: 'community',
    verdict: 'dangerous',
    policy: 'block',
    policy_reason: 'Real upstream policy',
    summary: 'Upstream summary',
    severity_counts: { critical: 1 },
    findings: [
      {
        severity: 'critical',
        category: 'supply_chain',
        file: 'SKILL.md',
        line: 3,
        description: 'Download-and-execute finding'
      }
    ]
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void

  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })

  return { promise, resolve, reject }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('HubPresentation', () => {
  it('shows the supplied safety verdict and findings through the existing preview UI', async () => {
    const onScan = vi.fn().mockResolvedValue(scanResult())
    const onInstall = vi.fn()
    renderHub({ onScan, onInstall })
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }))
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }))
    expect(await screen.findByText(/Download-and-execute finding/)).toBeTruthy()
    expect(onScan).toHaveBeenCalledWith(result.identifier)
    expect(onInstall).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'] as const)('ignores a late %s after the same preview closes and reopens', async kind => {
    const pending = deferred<SkillHubScanResult>()
    const onScan = vi.fn(() => pending.promise)
    const onActionError = vi.fn()
    renderHub({ onScan, onActionError })
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }))
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }))
    // Two clicks in the same frame must still issue only one request.
    fireEvent.click(screen.getByRole('button', { name: 'Scanning...' }))
    expect(onScan).toHaveBeenCalledOnce()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await act(async () => {
      if (kind === 'resolve') {
        pending.resolve(scanResult())
      } else {
        pending.reject(new Error('Late source failure'))
      }
    })
    expect(screen.queryByText(/Download-and-execute finding/)).toBeNull()
    expect(screen.queryByText('Late source failure')).toBeNull()
    expect(onActionError).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Scan' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('cancellation produces no verdict or alarming error and a real failure can be retried', async () => {
    const onScan = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('Cancelled', 'AbortError'))
      .mockRejectedValueOnce(new Error('Source unavailable'))
      .mockResolvedValueOnce(scanResult())

    renderHub({ onScan })
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }))
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Scan' }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByText('Cancelled')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }))
    expect(await screen.findByText('Source unavailable')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }))
    expect(await screen.findByText(/Download-and-execute finding/)).toBeTruthy()
    expect(screen.queryByText('Source unavailable')).toBeNull()
  })

  it('does not attribute another skill’s response to this preview', async () => {
    renderHub({ onScan: vi.fn().mockResolvedValue(scanResult('community/other')) })
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }))
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }))
    expect(await screen.findByText('Skill action failed')).toBeTruthy()
    expect(screen.queryByText(/Download-and-execute finding/)).toBeNull()
  })

  it('changing the scan host releases busy state and ignores the previous host’s reply', async () => {
    const pending = deferred<SkillHubScanResult>()
    const { changeHost } = renderHub({ onScan: vi.fn(() => pending.promise) })
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }))
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }))
    const nextScan = vi.fn().mockResolvedValue(scanResult())
    changeHost(nextScan)
    await waitFor(() => expect((screen.getByRole('button', { name: 'Scan' }) as HTMLButtonElement).disabled).toBe(false))
    await act(async () => pending.resolve(scanResult()))
    expect(screen.queryByText(/Download-and-execute finding/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }))
    expect(await screen.findByText(/Download-and-execute finding/)).toBeTruthy()
    expect(nextScan).toHaveBeenCalledWith(result.identifier)
  })

  it('preserves legacy immediate uninstall while its installed map is refreshing', async () => {
    const onUninstall = vi.fn().mockResolvedValue(undefined)
    renderHub({ installedOverrides: { [result.identifier]: true }, onUninstall })
    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall' }))
    await waitFor(() => expect(onUninstall).toHaveBeenCalledWith(result.identifier, result.name))
  })

  it('offers an installed skill update with its exact installed name', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined)
    renderHub({
      client: client({
        getSources: vi.fn().mockResolvedValue(
          sources({
            installed: {
              [result.identifier]: { name: 'installed-concept-diagrams', scan_verdict: null, trust_level: null }
            }
          })
        )
      }),
      onUpdate
    })
    fireEvent.click((await screen.findAllByRole('button')).at(-1)!)
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith(result.identifier, 'installed-concept-diagrams'))
  })

  it('does not offer a selected update when the server record has no installed name', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined)
    renderHub({
      client: client({
        getSources: vi.fn().mockResolvedValue(
          sources({
            installed: { [result.identifier]: { name: null, scan_verdict: null, trust_level: null } }
          })
        )
      }),
      onUpdate
    })
    await screen.findByText('Concept diagrams')
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('offers the optional installed batch update control without changing legacy adapters', async () => {
    const onUpdateAll = vi.fn().mockResolvedValue(undefined)
    renderHub({
      client: client({
        getSources: vi.fn().mockResolvedValue(
          sources({
            installed: { [result.identifier]: { name: result.name, scan_verdict: null, trust_level: null } }
          })
        )
      }),
      onUpdateAll
    })
    fireEvent.click((await screen.findAllByRole('button'))[0]!)
    await waitFor(() => expect(onUpdateAll).toHaveBeenCalledOnce())
  })

  it('fans a search out per source and previews through its injected client', async () => {
    const hub = client()
    renderHub({ client: hub, query: 'diagrams' })

    await screen.findByText('Concept diagrams')
    await waitFor(() => expect(hub.search).toHaveBeenCalledWith('diagrams', 'official'))
    expect(hub.search).toHaveBeenCalledWith('diagrams', 'community')

    fireEvent.click(screen.getAllByRole('button', { name: 'Preview' })[0]!)
    expect(await screen.findByText('# Concept diagrams')).toBeTruthy()
    expect(hub.preview).toHaveBeenCalledWith(result.identifier)
  })

  it('shows pending and failed install state without exposing unsupported controls', async () => {
    renderHub({
      actions: { [result.identifier]: { exitCode: 3, lines: ['permission denied'], running: false } },
      client: client({
        getSources: vi.fn().mockResolvedValue(
          sources({
            installed: { [result.identifier]: { name: result.name, scan_verdict: null, trust_level: null } }
          })
        )
      })
    })

    expect(await screen.findByText('Skill action failed')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Uninstall' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Update installed' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByText('# Concept diagrams')
    expect(screen.queryByRole('button', { name: 'Scan' })).toBeNull()
  })
})
