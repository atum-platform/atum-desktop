import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as AppSurfaces from '@/lib/atum-app-surfaces'
import type { AppConnectionStatus, AppSurfaceResult, ConnectCandidateStatus } from '@/lib/atum-app-surfaces'

type AppSurfaceModule = typeof AppSurfaces
type Candidate = AppSurfaceResult<{ status: ConnectCandidateStatus }>
type Lifecycle = AppSurfaceResult<AppConnectionStatus>

const connectStatus = vi.fn<(app: string) => Promise<Lifecycle>>()
const connectCandidate = vi.fn<(app: string) => Promise<Candidate>>()
const connectStart = vi.fn<(app: string) => Promise<AppSurfaceResult<{ opened: true }>>>()
const connectDismiss = vi.fn<(app: string) => Promise<Candidate>>()

vi.mock('@/lib/atum-app-surfaces', async () => {
  const actual = await vi.importActual<AppSurfaceModule>('@/lib/atum-app-surfaces')

  return {
    ...actual,
    atumAppSurfaceClient: () => ({
      intakeStatus: vi.fn(),
      submitIntake: vi.fn(),
      connectStatus,
      connectCandidate,
      connectStart,
      connectDismiss
    })
  }
})

const { DmConnectCard, LINKED_RECEIPT_MS, resetDmConnectCardSessionState } = await import('./dm-connect-card')

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  resetDmConnectCardSessionState()
  connectStatus.mockResolvedValue({ status: 'never_linked' })
  connectStart.mockResolvedValue({ opened: true })
  connectDismiss.mockResolvedValue({ status: 'dismissed' })
})

function mount(enabled = true) {
  return render(<DmConnectCard accountId="atum-user" appId="moon" appName="Moon" enabled={enabled} />)
}

describe('DmConnectCard', () => {
  it('offers manual Connect without searching for matching accounts', async () => {
    mount()
    expect(await screen.findByRole('button', { name: 'Connect' })).toBeTruthy()
    expect(connectCandidate).not.toHaveBeenCalled()
    expect(connectStart).not.toHaveBeenCalled()
  })

  it('offers Reconnect after withdrawal', async () => {
    connectStatus.mockResolvedValue({
      status: 'unlinked',
      connectionRequired: true,
      available: true,
      readiness: 'not_linked'
    })
    mount()
    expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull()
  })

  it('keeps remote sign-out unconfirmed until the existing unlink receipt arrives', async () => {
    connectStatus.mockResolvedValue({
      status: 'unlinked',
      connectionRequired: true,
      available: true,
      readiness: 'not_linked',
      cleanup: 'pending'
    })
    mount()
    await screen.findByRole('button', { name: 'Reconnect' })
    expect(screen.getByRole('status').textContent).toContain('still unconfirmed')
    connectStatus.mockResolvedValue({
      status: 'unlinked',
      connectionRequired: true,
      available: true,
      readiness: 'not_linked',
      cleanup: 'complete'
    })
    await act(async () => {
      fireEvent.focus(window)
    })
    expect(screen.getByRole('status').textContent).toContain('sign-out is complete')
    expect(connectStart).not.toHaveBeenCalled()
  })

  it('keeps a ready connection out of the transcript', async () => {
    connectStatus.mockResolvedValue({ status: 'linked', connectionRequired: true, available: true, readiness: 'ready' })
    const { container } = mount()
    await waitFor(() => expect(container.firstChild).toBeNull())
  })

  it('shows a retry when authority is unavailable', async () => {
    connectStatus.mockResolvedValue({ error: 'link_state_unavailable' })
    mount()
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('Atum could not check this connection. Please try again.')
    connectStatus.mockResolvedValue({ status: 'never_linked' })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: 'Connect' })).toBeTruthy()
    expect(connectStart).not.toHaveBeenCalled()
  })

  it('does not authorize while the initial check is unresolved', async () => {
    connectStatus.mockReturnValue(new Promise(() => {}))
    mount()
    const checking = screen.getByRole('button', { name: 'Checking…' }) as HTMLButtonElement
    expect(checking.disabled).toBe(true)
    fireEvent.click(checking)
    expect(connectStart).not.toHaveBeenCalled()
  })

  it('does not read while the account is unusable', () => {
    mount(false)
    expect(connectStatus).not.toHaveBeenCalled()
  })

  it('opens the browser once and confirms only after a fresh authority read', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    await screen.findByRole('button', { name: 'Check connection' })
    expect(connectStart).toHaveBeenCalledOnce()
    expect(screen.queryByText('Moon is connected.')).toBeNull()
    connectStatus.mockResolvedValue({ status: 'linked', connectionRequired: true, available: true, readiness: 'ready' })
    await act(async () => {
      fireEvent.focus(window)
    })
    expect(screen.getByText('Moon is connected.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByText('Moon is connected.')).toBeNull()
  })

  it('keeps checking a browser handoff until a verified success arrives', async () => {
    mount()
    await screen.findByRole('button', { name: 'Connect' })

    try {
      vi.useFakeTimers()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
      })
      expect(screen.getByRole('status').textContent).toBe(
        'Finish signing in to the app in your browser, then come back here.'
      )
      expect(screen.queryByText('Moon is connected.')).toBeNull()
      let checks = 0
      connectStatus.mockResolvedValue({
        status: 'never_linked'
      })
      connectStatus.mockImplementation(async () => {
        checks += 1

        return checks < 7
          ? { status: 'never_linked' }
          : { status: 'linked', connectionRequired: true, available: true, readiness: 'ready' }
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(90_000)
      })
      expect(checks).toBeGreaterThan(5)
      expect(screen.getByText('Moon is connected.')).toBeTruthy()
      act(() => vi.advanceTimersByTime(LINKED_RECEIPT_MS))
      expect(screen.queryByText('Moon is connected.')).toBeNull()
      expect(connectStart).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for provider readiness after consent without another browser hop', async () => {
    connectStatus.mockResolvedValue({
      status: 'linked',
      connectionRequired: true,
      available: true,
      readiness: 'pending'
    })
    mount()
    expect(await screen.findByRole('button', { name: 'Check connection' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('Moon')
    expect(screen.queryByText('Moon is connected.')).toBeNull()
    expect(connectStart).not.toHaveBeenCalled()
  })

  it('restores an initiated browser handoff from Discover', async () => {
    connectStatus.mockResolvedValue({ status: 'never_linked', browserStep: 'in_progress' })
    mount()
    expect(await screen.findByRole('button', { name: 'Check connection' })).toBeTruthy()
    expect(connectStart).not.toHaveBeenCalled()
  })

  it('does not offer Connect when server eligibility is withdrawn', async () => {
    connectStatus.mockResolvedValue({
      status: 'never_linked',
      connectionRequired: true,
      available: false,
      readiness: 'not_linked'
    })
    mount()
    expect(await screen.findByRole('button', { name: 'Check connection' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
  })

  it('shows browser launch failure without pretending a connection exists', async () => {
    connectStart.mockResolvedValue({ error: 'app_surface_failed' })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    expect((await screen.findByRole('alert')).textContent).toContain('could not')
    expect(screen.queryByText('Moon is connected.')).toBeNull()
  })

  it('coalesces a manual check and focus read while the request is pending', async () => {
    let resolve!: (value: Lifecycle) => void
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    await screen.findByRole('button', { name: 'Check connection' })
    connectStatus.mockReturnValue(
      new Promise(done => {
        resolve = done
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Check connection' }))
    fireEvent.focus(window)
    expect(connectStatus).toHaveBeenCalledTimes(2)
    await act(async () => {
      resolve({ status: 'linked' })
    })
    expect(screen.getByText('Moon is connected.')).toBeTruthy()
  })

  it('ignores a late browser response after switching accounts', async () => {
    let resolve!: (value: AppSurfaceResult<{ opened: true }>) => void
    connectStart.mockReturnValue(
      new Promise(done => {
        resolve = done
      })
    )
    const { rerender } = mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }))
    rerender(<DmConnectCard accountId="another-user" appId="moon" appName="Moon" enabled />)
    await screen.findByRole('button', { name: 'Connect' })
    await act(async () => {
      resolve({ opened: true })
    })
    expect(screen.queryByRole('button', { name: 'Check connection' })).toBeNull()
  })

  it('coalesces initial authority reads under StrictMode', async () => {
    render(
      <StrictMode>
        <DmConnectCard accountId="atum-user" appId="moon" appName="Moon" enabled />
      </StrictMode>
    )
    await screen.findByRole('button', { name: 'Connect' })
    expect(connectStatus).toHaveBeenCalledOnce()
  })

  it('removes focus listeners when the card unmounts', async () => {
    const { unmount } = mount()
    await screen.findByRole('button', { name: 'Connect' })
    unmount()
    fireEvent.focus(window)
    expect(connectStatus).toHaveBeenCalledOnce()
  })
})

it.each(['pending', 'unavailable'] as const)(
  'keeps legacy linked chat free of a false %s readiness banner',
  async readiness => {
    connectStatus.mockResolvedValue({ status: 'linked', connectionRequired: false, available: true, readiness })
    const { container } = mount()
    await waitFor(() => expect(container.firstChild).toBeNull())
    expect(connectStart).not.toHaveBeenCalled()
  }
)

it('hides Connect outside rollout without claiming that a legacy app is unavailable', async () => {
  connectStatus.mockResolvedValue({
    status: 'never_linked',
    connectionRequired: false,
    available: true,
    readiness: 'not_linked',
    connectAvailable: false
  })
  const { container } = mount()
  await waitFor(() => expect(container.firstChild).toBeNull())
  expect(connectStart).not.toHaveBeenCalled()
})

it('offers only status retry when required-mode enrollment is closed', async () => {
  connectStatus.mockResolvedValue({
    status: 'never_linked',
    connectionRequired: true,
    available: true,
    readiness: 'not_linked',
    connectAvailable: false
  })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Check connection' }))
  expect(connectStart).not.toHaveBeenCalled()
})
