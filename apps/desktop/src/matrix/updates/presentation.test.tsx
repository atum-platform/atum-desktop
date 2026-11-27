import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { AtumUpdateState, AtumUpdateStatus } from '../../../shared/atum-update-flow'

import { SoftwareUpdate } from './presentation'

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => vi.stubGlobal('ResizeObserver', TestResizeObserver))
afterEach(() => {cleanup(); vi.restoreAllMocks()})

const baseStatus: AtumUpdateStatus = {
  armed: true, channel: 'latest', checkedAt: null, error: null, notes: [], packaged: true,
  progress: null, requiredBelow: null, state: 'idle', version: null
}

function status(state: AtumUpdateState, patch: Partial<AtumUpdateStatus> = {}): AtumUpdateStatus {
  return { ...baseStatus, state, ...patch }
}

function actions() {
  return {
    checkNow: vi.fn(async () => true), openDownload: vi.fn(async () => true), openUpdates: vi.fn(),
    restart: vi.fn(async () => true), setChannel: vi.fn(async () => true)
  }
}

function settings(props: Partial<React.ComponentProps<typeof SoftwareUpdate>> = {}) {
  const calls = actions()

  return {
    calls,
    ...render(
      <SoftwareUpdate
        busy={false}
        checkNow={calls.checkNow}
        currentVersion="1.0.0"
        locale="en"
        openDownload={calls.openDownload}
        restart={calls.restart}
        setChannel={calls.setChannel}
        status={baseStatus}
        {...props}
      />
    )
  }
}

describe('SoftwareUpdate', () => {
  it.each([
    ['unavailable', 'Updates are unavailable for this build.'],
    ['checking', 'Checking for updates…'],
    ['downloading', 'Downloading update… 42%'],
    ['preparing', 'Preparing update…'],
    ['downloaded', 'Update ready'],
    ['error', 'Could not reach the update server.']
  ] as const satisfies readonly [AtumUpdateState, string][])('renders the %s state', (state, label) => {
    const error = state === 'error'
      ? { code: 'transport' as const, message: 'Could not reach the update server.', stage: 'check' as const }
      : null
    const { container } = settings({ status: status(state, { error, progress: state === 'downloading' ? 42 : null }) })

    expect(container.querySelector('[data-update-status]')?.textContent).toContain(label)
  })

  it('shows download progress in Settings', () => {
    const { container } = settings({ status: status('downloading', { progress: 42 }) })

    expect(container.querySelector('[data-update-progress] progress')).toBeTruthy()
  })

  it('shows honest mapped errors and a retry action without legacy cleanup copy', async () => {
    const { calls } = settings({
      status: status('error', {
        error: { code: 'hash_mismatch', message: 'The downloaded update could not be verified.', stage: 'download' }
      })
    })
    expect(screen.getByRole('status').textContent).toContain('The downloaded update could not be verified.')
    expect(screen.queryByText(/clear the previous update safely/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(calls.checkNow).toHaveBeenCalledOnce())
  })

  it('offers the existing manual download instead of a dead Retry after stock staging stalls', async () => {
    const { calls } = settings({
      status: status('error', {
        error: {
          code: 'failed', message: 'ignored', recovery: 'manual_download', stage: 'download'
        }
      })
    })
    expect(screen.getByRole('status').textContent).toContain('Update stalled. Download Atum to continue.')
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Download Atum' }))
    await waitFor(() => expect(calls.openDownload).toHaveBeenCalledOnce())
    expect(calls.checkNow).not.toHaveBeenCalled()
  })

  it('says plainly that a Restart did not finish and offers Try again', async () => {
    const view = settings({
      status: status('error', { error: { code: 'failed', message: 'ignored', stage: 'install' } })
    })
    expect(screen.getByRole('status').textContent).toContain('The update didn’t finish. Please try again.')
    expect(screen.getByRole('status').textContent).not.toContain('Could not download')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(view.calls.checkNow).toHaveBeenCalledOnce())
  })

  it('uses check-stage copy for an unclassified check failure', () => {
    settings({
      locale: 'vi',
      status: status('error', {
        error: { code: 'failed', message: 'ignored', stage: 'check' }
      })
    })
    expect(screen.getByRole('status').textContent).toContain('Chưa kiểm tra được bản cập nhật. Hãy thử lại.')
    expect(screen.getByRole('status').textContent).not.toContain('Chưa tải được bản cập nhật.')
  })

  it.each([
    ['en', 'Could not reach the update server.', 'The downloaded update could not be verified.'],
    ['vi', 'Chưa kết nối được với máy chủ cập nhật.', 'Không thể xác minh bản cập nhật đã tải xuống.'],
    ['ja', 'アップデートサーバーに接続できませんでした。', 'ダウンロードしたアップデートを検証できませんでした。'],
    ['zh', '无法连接更新服务器。', '无法验证已下载的更新。'],
    ['zh-hant', '無法連線更新伺服器。', '無法驗證已下載的更新。']
  ] as const)('localizes updater error codes in %s without rendering main-process copy', (locale, transport, hash) => {
    const view = settings({
      locale,
      status: status('error', {
        error: { code: 'transport', message: 'UNTRUSTED MAIN COPY', stage: 'check' } as any
      })
    })
    expect(screen.getByRole('status').textContent).toContain(transport)
    expect(screen.queryByText(/UNTRUSTED MAIN COPY/)).toBeNull()
    view.rerender(
      <SoftwareUpdate
        busy={false} checkNow={view.calls.checkNow} currentVersion="1.0.0" locale={locale}
        openDownload={view.calls.openDownload} restart={view.calls.restart} setChannel={view.calls.setChannel}
        status={status('error', { error: { code: 'hash_mismatch', message: 'WRONG', stage: 'download' } as any })}
      />
    )
    expect(screen.getByRole('status').textContent).toContain(hash)
  })

  it('shows restarting instead of the busy restart explanation after Restart is accepted', () => {
    settings({ busy: true, status: status('restarting' as AtumUpdateState, { version: '1.1.0' }) })
    expect(screen.getByRole('status').textContent).toContain('Restarting Atum…')
    expect(screen.queryByText('Finish current work to restart.')).toBeNull()
  })

  it('waits for authoritative channel readback and disables channel changes during download', async () => {
    const { calls, rerender } = settings({ status: status('idle') })
    const beta = screen.getByRole('switch', { name: 'Try beta updates' })
    fireEvent.click(beta)
    await waitFor(() => expect(calls.setChannel).toHaveBeenCalledWith('beta'))
    expect(beta.getAttribute('data-state')).toBe('unchecked')
    rerender(
      <SoftwareUpdate
        busy={false} checkNow={calls.checkNow} currentVersion="1.0.0" locale="en"
        openDownload={calls.openDownload} restart={calls.restart} setChannel={calls.setChannel}
        status={status('idle', { channel: 'beta' })}
      />
    )
    expect(screen.getByRole('switch', { name: 'Try beta updates' }).getAttribute('data-state')).toBe('checked')
    rerender(
      <SoftwareUpdate
        busy={false} checkNow={calls.checkNow} currentVersion="1.0.0" locale="en"
        openDownload={calls.openDownload} restart={calls.restart} setChannel={calls.setChannel}
        status={status('downloading', { channel: 'beta', progress: 10 })}
      />
    )
    expect((screen.getByRole('switch', { name: 'Try beta updates' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('busy-gates both Check now and the single Restart to update action', () => {
    const calls = actions()
    const { rerender } = render(
      <SoftwareUpdate
        busy checkNow={calls.checkNow} currentVersion="1.0.0" locale="en"
        openDownload={calls.openDownload} restart={calls.restart} setChannel={calls.setChannel} status={status('idle')}
      />
    )
    expect((screen.getByRole('button', { name: 'Check for updates' }) as HTMLButtonElement).disabled).toBe(true)
    rerender(
      <SoftwareUpdate
        busy checkNow={calls.checkNow} currentVersion="1.0.0" locale="en"
        openDownload={calls.openDownload} restart={calls.restart} setChannel={calls.setChannel}
        status={status('downloaded', { version: '1.1.0' })}
      />
    )
    expect(screen.getAllByRole('button', { name: 'Restart to update' })).toHaveLength(1)
    expect((screen.getByRole('button', { name: 'Restart to update' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
