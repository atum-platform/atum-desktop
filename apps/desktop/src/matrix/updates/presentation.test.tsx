import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { AtumUpdateState, AtumUpdateStatus } from '../../../shared/atum-update-flow'

import { SoftwareUpdate, UpdateAffordance } from './presentation'

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

  it('shows progress only in Settings and keeps the rail quiet until ready', () => {
    const calls = actions()
    const downloading = status('downloading', { progress: 42 })
    const { container } = render(
      <>
        <SoftwareUpdate
          busy={false} checkNow={calls.checkNow} currentVersion="1.0.0" locale="en"
          openDownload={calls.openDownload} restart={calls.restart} setChannel={calls.setChannel} status={downloading}
        />
        <UpdateAffordance
          busy={false} checkNow={calls.checkNow} locale="en" openDownload={calls.openDownload}
          openUpdates={calls.openUpdates} restart={calls.restart} status={downloading}
        />
      </>
    )
    expect(container.querySelector('[data-update-progress] progress')).toBeTruthy()
    expect(container.querySelector('[data-update-attention]')).toBeNull()
    expect(container.querySelector('[data-update-warning]')).toBeNull()
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

describe('UpdateAffordance', () => {
  it('keeps check failures in Settings and warns in the rail only for download or install failures', () => {
    const calls = actions()
    const view = render(
      <UpdateAffordance
        busy={false} checkNow={calls.checkNow} locale="en" openDownload={calls.openDownload}
        openUpdates={calls.openUpdates} restart={calls.restart}
        status={status('error', { error: { code: 'transport', message: 'network', stage: 'check' } as any })}
      />
    )
    expect(view.container.querySelector('[data-update-warning]')).toBeNull()
    view.rerender(
      <UpdateAffordance
        busy={false} checkNow={calls.checkNow} locale="en" openDownload={calls.openDownload}
        openUpdates={calls.openUpdates} restart={calls.restart}
        status={status('error', { error: { code: 'hash_mismatch', message: 'hash', stage: 'download' } as any })}
      />
    )
    expect(view.container.querySelector('[data-update-warning]')).toBeTruthy()
  })

  it('renders at most three plain-text release notes and one Restart action', () => {
    const calls = actions()
    const { container } = render(
      <UpdateAffordance
        busy={false} checkNow={calls.checkNow} locale="en" openDownload={calls.openDownload}
        openUpdates={calls.openUpdates} restart={calls.restart}
        status={status('downloaded', {
          notes: ['<script>alert("text only")</script>', 'Second', 'Third', 'Fourth'], version: '1.1.0'
        })}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Update ready — restart to install' }))
    const notes = container.ownerDocument.querySelector('[data-update-notes]') as HTMLElement
    expect(notes.querySelectorAll('li')).toHaveLength(3)
    expect(notes.querySelector('script')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Restart' })).toHaveLength(1)
  })

  it('disables Restart while busy and reports a rejected restart', async () => {
    const calls = actions()
    render(
      <UpdateAffordance
        busy checkNow={calls.checkNow} locale="en" openDownload={calls.openDownload}
        openUpdates={calls.openUpdates} restart={calls.restart}
        status={status('downloaded', { version: '1.1.0' })}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Update ready — restart to install' }))
    expect((screen.getByRole('button', { name: 'Restart' }) as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    calls.restart.mockResolvedValueOnce(false)
    render(
      <UpdateAffordance
        busy={false} checkNow={calls.checkNow} locale="en" openDownload={calls.openDownload}
        openUpdates={calls.openUpdates} restart={calls.restart}
        status={status('downloaded', { version: '1.1.0' })}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Update ready — restart to install' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
    expect(await screen.findByText('The update could not restart Atum. Please try again.')).toBeTruthy()
  })
})

it('explains required disk space and disables Check while preparing', () => {
  const error = settings({ status: status('error', { error: { code: 'disk_space', stage: 'download', message: '', requiredBytes: 5.4e9 } }) })
  expect(error.container.textContent).toContain('This update needs 5.4 GB free')
  error.unmount()
  const preparing = settings({ status: status('preparing') })
  expect(preparing.container.textContent).toContain('Preparing update…')
  expect(preparing.container.querySelector('progress')).toBeNull()
  expect(preparing.container.querySelector('button')?.disabled).toBe(true)
})
