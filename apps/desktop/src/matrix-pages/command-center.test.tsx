import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixCommandCenterClient, MatrixCommandStatus } from '../../shared/matrix-command-center'
import { matrixCommandCenterCopy } from '../../shared/matrix-command-center-copy'
import type { MatrixPagesRequest } from '../../shared/matrix-pages'

import { MatrixCommandCenter } from './command-center'
import { createMatrixCommandCenterClient } from './command-center-client'

function fixture(): MatrixCommandCenterClient {
  return {
    status: vi.fn(async () => ({
      version: '0.17.0',
      gatewayRunning: false,
      activeSessions: 2,
      overall: 'degraded' as const,
      components: [{ name: 'storage' as const, status: 'ok' as const }]
    })),
    logs: vi.fn(async () => ({ file: 'agent' as const, lines: ['first', 'second'], truncated: false })),
    usage: vi.fn(async days => ({
      days,
      totals: { sessions: 1, calls: 2, input: 17, output: 4 },
      daily: [{ day: '2026-10-02', input: 17, output: 4 }],
      models: [{ name: 'fixture-model', input: 17, output: 4 }]
    })),
    curator: vi.fn(async () => ({
      enabled: false,
      paused: true,
      intervalHours: 24,
      lastRunAt: null,
      lastRunKnown: true
    }))
  }
}

function draw(client: MatrixCommandCenterClient, name = 'Ada') {
  return (
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixCommandCenter agentName={name} client={client} />
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
it('reads on demand and refreshes only the selected panel without action requests', async () => {
  const client = fixture()
  render(draw(client))
  await screen.findByText('0.17.0')
  expect(client.status).toHaveBeenCalledOnce()
  expect(client.logs).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Logs' }))
  await screen.findByText('first')
  expect(client.logs).toHaveBeenCalledExactlyOnceWith('agent', 'ALL')
  fireEvent.change(screen.getByRole('textbox', { name: 'Search these log lines' }), { target: { value: 'second' } })
  expect(screen.queryByText('first')).toBeNull()
  expect(screen.getByText('second')).toBeTruthy()
  expect(client.logs).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(client.logs).toHaveBeenCalledTimes(2))
  fireEvent.click(screen.getByRole('button', { name: 'Usage' }))
  await screen.findByText('fixture-model')
  expect(client.usage).toHaveBeenCalledExactlyOnceWith(30)
  fireEvent.change(screen.getByRole('combobox', { name: 'Days' }), { target: { value: '7' } })
  await waitFor(() => expect(client.usage).toHaveBeenLastCalledWith(7))
  fireEvent.click(screen.getByRole('button', { name: 'Curator' }))
  await screen.findByText('No recorded run')
  expect(client.curator).toHaveBeenCalledOnce()
  expect(globalThis.document.body.textContent).not.toMatch(/Restart|Doctor|Backup|Debug share/)
})
it('keeps errors generic and recovers through explicit refresh', async () => {
  const client = fixture()
  vi.mocked(client.status).mockRejectedValueOnce(new Error('api_key=private'))
  render(draw(client))
  await screen.findByRole('alert')
  expect(globalThis.document.body.textContent).not.toMatch(/api_key|private/)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await screen.findByText('0.17.0')
  expect(screen.queryByRole('alert')).toBeNull()
})
it('retires late results on selected-agent/client change', async () => {
  const first = fixture()
  let resolve!: (value: MatrixCommandStatus) => void
  vi.mocked(first.status).mockReturnValue(
    new Promise(done => {
      resolve = done
    })
  )
  const view = render(draw(first))
  const next = fixture()
  view.rerender(draw(next, 'Babbage'))
  await screen.findByText('0.17.0')
  await act(async () => {
    resolve({ version: '99.0.0', gatewayRunning: true, activeSessions: 999, overall: 'ok', components: [] })
  })
  expect(screen.queryByText('99.0.0')).toBeNull()
  expect(globalThis.document.body.textContent).toContain('Babbage')
})
it('client emits only the four synthetic GETs', async () => {
  const request = vi.fn(async (_value: MatrixPagesRequest) => ({}) as never)
  const client = createMatrixCommandCenterClient(request)
  await client.status()
  await client.logs('errors', 'ERROR')
  await client.usage(90)
  await client.curator()
  expect(request.mock.calls.map(([value]) => value)).toEqual([
    { path: '/api/command-center/status' },
    { path: '/api/command-center/logs?file=errors&level=ERROR' },
    { path: '/api/command-center/usage?days=90' },
    { path: '/api/command-center/curator' }
  ])
})
describe.each(Object.keys(matrixCommandCenterCopy) as (keyof typeof matrixCommandCenterCopy)[])('locale %s', locale => {
  it('renders localized navigation and selected-agent context', async () => {
    const client = fixture()
    render(
      <I18nProvider configClient={null} initialLocale={locale}>
        <MatrixCommandCenter agentName="Ada" client={client} />
      </I18nProvider>
    )
    await screen.findByText('0.17.0')
    expect(screen.getByRole('heading', { name: matrixCommandCenterCopy[locale].title })).toBeTruthy()
    expect(screen.getByRole('button', { name: matrixCommandCenterCopy[locale].curator })).toBeTruthy()
  })
})
