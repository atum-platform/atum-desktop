// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import type { SkillHubScanResult } from '@/types/hermes'

import { createMatrixPagesHubScope } from '../../electron/matrix/pages-hub'

import { MatrixSkillsHub, type MatrixSkillsHubClient } from './skills-hub'

afterEach(cleanup)

describe('actual Matrix adapter / shared presentation / native Hub scope composition', () => {
  it.each([true, false])('confirms a selected-agent scan and preserves its cancellation/verdict semantics (%s)', async accepted => {
    const result = {
      name: 'Demo', identifier: 'fixture/demo', description: 'Offline demo',
      source: 'community', trust_level: 'community', repo: null, tags: []
    }

    const verdict: SkillHubScanResult = {
      ...result, verdict: 'dangerous', policy: 'block', summary: 'Offline supplied source verdict',
      policy_reason: 'Blocked', severity_counts: { critical: 1 },
      findings: [{ severity: 'critical', category: 'supply_chain', file: 'SKILL.md', line: 3,
        description: 'Fixture download-and-execute finding' }]
    }

    const confirm = vi.fn().mockResolvedValue(accepted)
    const forward = vi.fn().mockResolvedValue(verdict)
    const scope = createMatrixPagesHubScope({ confirm, forward, isCurrent: () => true })

    const client: MatrixSkillsHubClient = {
      getSources: vi.fn().mockResolvedValue({ sources: [], installed: {}, featured: [result], index_available: true }),
      search: vi.fn(), preview: vi.fn().mockResolvedValue({ ...result, files: ['SKILL.md'], skill_md: '# Demo' }),
      scan: identifier => scope.request({ path: `/api/skills/hub/scan?${new URLSearchParams({ identifier })}` }) as Promise<SkillHubScanResult>,
      install: vi.fn(), uninstall: vi.fn(), update: vi.fn(), status: vi.fn()
    }

    const onInstalled = vi.fn()
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // English names below; Vietnamese, the default, has its own words for the hub now.
    render(<I18nProvider configClient={null} initialLocale="en"><QueryClientProvider client={cache}>
      <MatrixSkillsHub client={client} onInstalled={onInstalled} query="" />
    </QueryClientProvider></I18nProvider>)
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }))
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }))
    await waitFor(() => expect(confirm).toHaveBeenCalledWith('fixture/demo', 'scan'))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Scan' }) as HTMLButtonElement).disabled).toBe(false))

    if (accepted) {
      expect(await screen.findByText(/Fixture download-and-execute finding/)).toBeTruthy()
      expect(forward).toHaveBeenCalledWith({ path: '/api/skills/hub/scan?identifier=fixture%2Fdemo&profile=default', method: 'GET' })
    } else {
      expect(forward).not.toHaveBeenCalled()
      expect(screen.queryByText(/Fixture download-and-execute finding/)).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
    }

    expect(client.install).not.toHaveBeenCalled()
    expect(client.status).not.toHaveBeenCalled()
    expect(onInstalled).not.toHaveBeenCalled()
  })
})
