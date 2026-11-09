import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type {
  MatrixCommandCenterOpsClient,
  MatrixLocalAction,
  MatrixLocalActionStatus
} from '../../shared/matrix-command-center-ops'
import { matrixMaintenanceConfirmationCopy, matrixMaintenanceCopy } from '../../shared/matrix-command-center-ops-copy'

import { MatrixCommandCenterOps } from './command-center-ops'
import { createMatrixCommandCenterOpsClient } from './command-center-ops-client'

const value = (
  action: MatrixLocalAction,
  state: MatrixLocalActionStatus['state'] = 'unknown'
): MatrixLocalActionStatus => ({ action, state, lines: [], truncated: false, backupAvailable: false })

function fixture(): MatrixCommandCenterOpsClient {
  return {
    status: vi.fn(async action => value(action)),
    run: vi.fn(async action => ({ status: 'started' as const, value: value(action, 'succeeded') })),
    revealBackup: vi.fn(async () => ({ revealed: true as const }))
  }
}

function draw(client: MatrixCommandCenterOpsClient, name = 'Ada') {
  return (
    <I18nProvider configClient={null} initialLocale="en">
      <MatrixCommandCenterOps agentName={name} client={client} />
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
it('reads both selected-home statuses on open and explicit refresh only', async () => {
  const f = fixture()
  render(draw(f))
  await waitFor(() => expect(f.status).toHaveBeenCalledTimes(2))
  expect(f.run).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Check status' }))
  await waitFor(() => expect(f.status).toHaveBeenCalledTimes(4))
  expect(f.run).not.toHaveBeenCalled()
})
it('blocks double-click and treats cancellation as cancellation without polling', async () => {
  const f = fixture()
  let resolve!: (v: { status: 'cancelled' }) => void
  vi.mocked(f.run).mockImplementation(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  render(draw(f))
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Run · Doctor' }) as HTMLButtonElement).disabled).toBe(false)
  )
  const button = screen.getByRole('button', { name: 'Run · Doctor' })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(f.run).toHaveBeenCalledExactlyOnceWith('doctor')
  await act(async () => {
    resolve({ status: 'cancelled' })
  })
  expect(screen.getByText('Cancelled.')).toBeTruthy()
  expect(f.status).toHaveBeenCalledTimes(2)
})
it('does not publish a previous agent’s late operation result', async () => {
  const f = fixture()
  let resolve!: (v: Awaited<ReturnType<MatrixCommandCenterOpsClient['run']>>) => void
  vi.mocked(f.run).mockImplementation(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  const view = render(draw(f))
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Run · Backup' }) as HTMLButtonElement).disabled).toBe(false)
  )
  fireEvent.click(screen.getByRole('button', { name: 'Run · Backup' }))
  const next = fixture()
  view.rerender(draw(next, 'Turing'))
  await waitFor(() => expect(next.status).toHaveBeenCalledTimes(2))
  await act(async () => {
    resolve({
      status: 'started',
      value: { ...value('backup', 'succeeded'), backupAvailable: true, lines: ['old agent'] }
    })
  })
  expect(screen.queryByText('old agent')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Show backup in Finder' })).toBeNull()
})
it('stops bounded polling at the deadline without reporting success or launching again', async () => {
  const f = fixture()
  render(draw(f))
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Run · Doctor' }) as HTMLButtonElement).disabled).toBe(false)
  )
  vi.useFakeTimers()
  vi.mocked(f.run).mockResolvedValue({ status: 'started', value: value('doctor', 'running') })
  vi.mocked(f.status).mockImplementation(async action => value(action, 'running'))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Run · Doctor' }))
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(301000)
  })
  expect(screen.getByText(matrixMaintenanceCopy.en.timeout)).toBeTruthy()
  expect(f.run).toHaveBeenCalledOnce()
  const count = vi.mocked(f.status).mock.calls.length
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000)
  })
  expect(f.status).toHaveBeenCalledTimes(count)
})
it('reveals only through the fixed native command after current status says available', async () => {
  const f = fixture()
  vi.mocked(f.status).mockImplementation(async action => ({
    ...value(action, 'succeeded'),
    backupAvailable: action === 'backup'
  }))
  render(draw(f))
  fireEvent.click(await screen.findByRole('button', { name: 'Show backup in Finder' }))
  await waitFor(() => expect(f.revealBackup).toHaveBeenCalledOnce())
  expect(f.run).not.toHaveBeenCalled()
})
it('emits no profile, archive, PID, output path or raw endpoint', async () => {
  const request = vi.fn(async () => ({}))
  const client = createMatrixCommandCenterOpsClient(request as never)
  await client.status('doctor')
  await client.run('backup')
  await client.revealBackup()
  expect(request.mock.calls).toEqual([
    [{ path: '/api/command-center/maintenance/doctor/status' }],
    [{ path: '/api/command-center/maintenance/backup/run', method: 'POST' }],
    [{ path: '/api/command-center/maintenance/backup/reveal', method: 'POST' }]
  ])
})
it('uses the selected agent and matching operation privacy copy in native consent for every locale', () => {
  for (const [locale, copy] of Object.entries(matrixMaintenanceCopy)) {
    for (const action of ['doctor', 'backup'] as const) {
      const consent = matrixMaintenanceConfirmationCopy(locale, 'Ada', action)
      expect(consent.detail).toContain('Ada')
      expect(consent.detail).toContain(copy[action])
      expect(consent.detail).toContain(action === 'doctor' ? copy.doctorHelp : copy.backupHelp)
      expect(consent.cancel).toEqual(copy.cancel)
    }
  }
})
