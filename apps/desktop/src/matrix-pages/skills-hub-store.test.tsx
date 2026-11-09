// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MatrixStoreItem } from '@/../shared/matrix-store'
import { type SkillsPageClient, SkillsPresentation } from '@/app/skills/presentation'
import { I18nProvider } from '@/i18n'
import type { ActionResponse, ActionStatusResponse, SkillHubSearchResponse } from '@/types/hermes'

import listings from '../../electron/matrix/__fixtures__/store-hub-listings.json'
import { createMatrixPagesHubScope } from '../../electron/matrix/pages-hub'
import { matrixHubSkillName } from '../../shared/matrix-pages'
import { hubSkillRequest, isHubSkill } from '../matrix/store/hub-skill'

import { MatrixSkillsHub, type MatrixSkillsHubClient } from './skills-hub'

afterEach(cleanup)

const IDENTIFIER = 'official/creative/pixel-art'
const ACTION = 'skills-install-official-creative-pixel-art-0a1b2c3d'

const result = {
  name: 'pixel-art',
  identifier: IDENTIFIER,
  description: 'Pixel art in classic palettes',
  source: 'official',
  trust_level: 'builtin',
  repo: null,
  tags: []
}

/** The Hub the Store's hand-off opens, as the pages entry composes it, over the real native scope. */
function openHubFromStore(accepted: boolean) {
  const item = (listings.items as unknown as MatrixStoreItem[]).find(value => value.itemId === `skill/${IDENTIFIER}`)!
  expect(isHubSkill(item)).toBe(true)
  // What the Store asks for; main admits it as the page context's `hub` (shared/matrix-pages.ts).
  const { hub } = hubSkillRequest(item.install!, 'principal-a')

  const confirm = vi.fn().mockResolvedValue(accepted)

  const forward = vi.fn(async (request: { path: string }) => {
    if (request.path.startsWith('/api/skills/hub/search')) {
      return { results: [result], source_counts: {}, timed_out: [], installed: {} } satisfies SkillHubSearchResponse
    }

    if (request.path.startsWith('/api/skills/hub/preview')) {
      return { ...result, files: ['SKILL.md'], skill_md: '# Pixel art' }
    }

    if (request.path.startsWith('/api/skills/hub/install')) {
      return { ok: true, pid: 7, name: ACTION } satisfies ActionResponse
    }

    return { name: ACTION, pid: 7, running: false, exit_code: 0, lines: ['Installed'] } satisfies ActionStatusResponse
  })

  const scope = createMatrixPagesHubScope({ confirm, forward, isCurrent: () => true })

  const request = <T,>(path: string, body?: unknown) =>
    scope.request(body === undefined ? { path } : { path, method: 'POST', body }) as Promise<T>

  const client: MatrixSkillsHubClient = {
    getSources: vi.fn().mockResolvedValue({
      sources: [{ id: 'official', label: 'Official', searchable: true }],
      installed: {},
      featured: [],
      index_available: true
    }),
    search: (query, source) => request(`/api/skills/hub/search?${new URLSearchParams({ q: query, source, limit: '20' })}`),
    preview: identifier => request(`/api/skills/hub/preview?${new URLSearchParams({ identifier })}`),
    scan: identifier => request(`/api/skills/hub/scan?${new URLSearchParams({ identifier })}`),
    install: identifier => request('/api/skills/hub/install', { identifier }),
    uninstall: vi.fn(),
    update: vi.fn(),
    status: name => request(`/api/actions/${encodeURIComponent(name)}/status?lines=200`)
  }

  const skills: SkillsPageClient = {
    getSkills: vi.fn().mockResolvedValue([]),
    getToolsets: vi.fn().mockResolvedValue([]),
    toggleSkill: vi.fn(),
    toggleToolset: vi.fn()
  }

  const onInstalled = vi.fn()
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <I18nProvider configClient={null} initialLocale="en">
      <QueryClientProvider client={cache}>
        <SkillsPresentation
          client={skills}
          initialHubQuery={matrixHubSkillName(hub)}
          renderHub={(query, refresh) => (
            <MatrixSkillsHub
              client={client}
              focus={hub}
              onInstalled={() => {
                onInstalled()
                refresh()
              }}
              query={query}
            />
          )}
        />
      </QueryClientProvider>
    </I18nProvider>
  )

  return { confirm, forward, onInstalled }
}

describe('a Store listing handed to the Skills Hub', () => {
  it('opens on the Hub at that skill, and installs only after the native confirmation', async () => {
    const { confirm, forward, onInstalled } = openHubFromStore(true)

    // Searched by the skill's name; the detail opens on the exact identifier, nothing is sent.
    const detail = await screen.findByRole('dialog')
    expect(within(detail).getByText(IDENTIFIER)).toBeTruthy()
    expect(forward).toHaveBeenCalledWith({
      path: '/api/skills/hub/search?q=pixel-art&source=official&limit=20&profile=default',
      method: 'GET'
    })
    expect(confirm).not.toHaveBeenCalled()
    expect(forward.mock.calls.some(([value]) => value.path.startsWith('/api/skills/hub/install'))).toBe(false)

    fireEvent.click(within(detail).getByRole('button', { name: 'Install' }))

    await waitFor(() => expect(confirm).toHaveBeenCalledWith(IDENTIFIER, 'install'))
    await waitFor(() =>
      expect(forward).toHaveBeenCalledWith({
        path: '/api/skills/hub/install?profile=default',
        method: 'POST',
        body: { identifier: IDENTIFIER }
      })
    )
    await waitFor(() => expect(onInstalled).toHaveBeenCalled())
  })

  it('sends nothing to install when the person declines the confirmation', async () => {
    const { confirm, forward, onInstalled } = openHubFromStore(false)
    const detail = await screen.findByRole('dialog')

    fireEvent.click(within(detail).getByRole('button', { name: 'Install' }))

    await waitFor(() => expect(confirm).toHaveBeenCalledWith(IDENTIFIER, 'install'))
    await waitFor(() => expect(onInstalled).toHaveBeenCalled())
    expect(forward.mock.calls.some(([value]) => value.path.startsWith('/api/skills/hub/install'))).toBe(false)
    expect(forward.mock.calls.some(([value]) => value.path.startsWith('/api/actions/'))).toBe(false)
  })
})
