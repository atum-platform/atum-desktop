import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixSnapshot } from '../../shared/matrix'
import { matrixApprovalCopy } from '../../shared/matrix-approval-copy'
import type { MatrixApprovalNumbers, MatrixApprovalView } from '../../shared/matrix-security'

import { MATRIX_APPROVAL_SLOW_MS, MatrixApprovalSheet } from './device-approval'
import { RecoveryKeyPanel, VerificationPrompt } from './security-panel'

const SAS: MatrixApprovalNumbers = [1036, 4349, 6060]

const base: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@fixture-owner:atumplatform.com', deviceId: 'ATUM_newmac' },
  rooms: [],
  roomId: null,
  messages: [],
  error: null
}

function bridge() {
  const approval = {
    accept: vi.fn(async () => {}),
    pick: vi.fn(async () => {}),
    decline: vi.fn(async () => {}),
    signOutDevice: vi.fn(async () => {}),
    dismiss: vi.fn(async () => {}),
    confirm: vi.fn(async () => {}),
    retry: vi.fn(async () => {})
  }

  const value = { approval, command: vi.fn(async () => null) }
  Object.defineProperty(window, 'atumMatrix', { configurable: true, value })

  return value
}

function withApproval(approval: MatrixApprovalView): MatrixSnapshot {
  return { ...base, security: { recovery: 'idle', storage: 'present', approval } }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe('the approving device: one tap on the number code the new device shows', () => {
  const compare: MatrixApprovalView = {
    role: 'approve',
    state: 'compare',
    since: 1,
    deviceName: 'Atum · Mac mini mẫu',
    choices: [[SAS[0], 2011, 3322], SAS, [SAS[0], 7488, 8190]]
  }

  function sheet(approval: MatrixApprovalView, locale: 'vi' | 'en' = 'vi') {
    return render(
      <I18nProvider configClient={null} initialLocale={locale}>
        <MatrixApprovalSheet snapshot={withApproval(approval)} />
      </I18nProvider>
    )
  }

  it('asks in plain words, with three complete number codes, none of these, and “This wasn’t me”', async () => {
    const native = bridge()
    sheet(compare)

    const dialog = await screen.findByRole('dialog', { name: 'Bạn vừa đăng nhập trên một máy mới?' })
    expect(within(dialog).getByText('Atum · Mac mini mẫu')).toBeTruthy()
    expect(within(dialog).getByText(/Chọn mã số đang hiện trên máy đó/)).toBeTruthy()
    expect(within(dialog).getByText('Atum không bao giờ gọi điện hay nhắn tin bảo bạn chọn mã số.')).toBeTruthy()

    // Each complete code is one button, named by its three values in order.
    const rows = within(dialog).getAllByRole('button', { name: /^1036, / })
    expect(rows.map(row => row.getAttribute('aria-label'))).toEqual([
      '1036, 2011, 3322',
      '1036, 4349, 6060',
      '1036, 7488, 8190'
    ])
    fireEvent.click(within(dialog).getByRole('button', { name: '1036, 4349, 6060' }))
    await waitFor(() => expect(native.approval.pick).toHaveBeenCalledWith(1))

    fireEvent.click(within(dialog).getByRole('button', { name: 'Không hàng nào khớp' }))
    await waitFor(() => expect(native.approval.pick).toHaveBeenCalledWith(null))

    fireEvent.click(within(dialog).getByRole('button', { name: 'Không phải tôi' }))
    await waitFor(() => expect(native.approval.decline).toHaveBeenCalledOnce())
  })

  it('asks the person first, so only the device they are at takes the request', async () => {
    const native = bridge()
    sheet({ role: 'approve', state: 'asked', since: 1, deviceName: 'Atum · Mac mini mẫu' })

    const dialog = await screen.findByRole('dialog', { name: 'Bạn vừa đăng nhập trên một máy mới?' })
    expect(within(dialog).getByText('Máy đó đang xin quyền đọc tin nhắn và dùng trợ lý của bạn.')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: /^1036, / })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Đúng, là tôi' }))
    await waitFor(() => expect(native.approval.accept).toHaveBeenCalledOnce())
    expect(native.approval.pick).not.toHaveBeenCalled()
  })

  it('offers to sign a declined device out, and never shows a device ID', async () => {
    const native = bridge()
    const { container } = sheet({ role: 'approve', state: 'declined', since: 1 })

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Một máy mới')).toBeTruthy()
    expect(within(dialog).getByText(/hãy đổi mật khẩu Google rồi đăng xuất máy đó/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Đăng xuất máy đó' }))
    await waitFor(() => expect(native.approval.signOutDevice).toHaveBeenCalledOnce())
    fireEvent.click(within(dialog).getByRole('button', { name: 'Đóng' }))
    await waitFor(() => expect(native.approval.dismiss).toHaveBeenCalledOnce())
    expect(container.ownerDocument.body.textContent).not.toContain('ATUM_')
  })

  it('says the device is approved, and that a wrong code approved nothing and offers to sign it out', async () => {
    const native = bridge()
    const done = sheet({ role: 'approve', state: 'done', since: 1, deviceName: 'Atum · Mac mini' }, 'en')
    expect(await screen.findByText('Atum · Mac mini is approved.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign that device out' })).toBeNull()
    done.unmount()

    sheet({ role: 'approve', state: 'mismatch', since: 1 }, 'en')
    expect(
      await screen.findByText(
        'That didn’t match, so the device wasn’t approved. If it wasn’t you, change your Google password and sign that device out.'
      )
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign that device out' }))
    await waitFor(() => expect(native.approval.signOutDevice).toHaveBeenCalledOnce())
  })

  it('when it did not finish, says what happened by its reason, with one button and no step on that device', async () => {
    const native = bridge()

    // This Mac approved the phone, but it never finished there.
    const { unmount } = sheet({
      role: 'approve',
      state: 'failed',
      failure: 'there',
      since: 1,
      deviceName: 'iPhone mẫu'
    })

    let dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText('Đã cho phép iPhone mẫu, nhưng tin nhắn cũ có thể chưa mở được ở đó.')
    ).toBeTruthy()
    // Never the new Mac's own words ("from your other device"), no jargon, no button to press
    // on the phone, and no promise that this Mac asks again.
    expect(within(dialog).queryByText('Chưa nhận được khóa từ máy kia.')).toBeNull()
    expect(dialog.textContent).not.toMatch(/khóa|xác minh|thiết bị|phiên|Thử lại|hỏi lại/i)
    expect(
      within(dialog)
        .getAllByRole('button')
        .map(button => button.textContent)
    ).toEqual(['Đóng'])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Đóng' }))
    await waitFor(() => expect(native.approval.dismiss).toHaveBeenCalledOnce())
    unmount()

    // This Mac's own part did not finish (or no reason came): it says so, by that device's name.
    const second = sheet({ role: 'approve', state: 'failed', failure: 'here', since: 1, deviceName: 'iPhone mẫu' })
    dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Chưa cho phép được iPhone mẫu. Hãy thử lại sau ít phút.')).toBeTruthy()
    expect(dialog.textContent).not.toMatch(/khóa|xác minh|thiết bị|phiên|hỏi lại/i)
    second.unmount()

    // A device without a name of its own.
    sheet({ role: 'approve', state: 'failed', since: 1 })
    expect(await screen.findByText('Chưa cho phép được máy đó. Hãy thử lại sau ít phút.')).toBeTruthy()
  })

  it('says every locale’s two failure lines apart, naming the device', () => {
    for (const locale of ['en', 'vi', 'ja', 'zh', 'zh-hant'] as const) {
      const copy = matrixApprovalCopy(locale)
      expect(copy.approveFailed('iPhone 15')).toContain('iPhone 15')
      expect(copy.approveUnfinished('iPhone 15')).toContain('iPhone 15')
      expect(copy.approveUnfinished('iPhone 15')).not.toEqual(copy.approveFailed('iPhone 15'))
      expect(copy.approveFailed(undefined).length).toBeGreaterThan(0)
      expect(copy.approveUnfinished(undefined).length).toBeGreaterThan(0)
      expect(copy.actionFailed.length).toBeGreaterThan(0)
    }
  })

  it('a button that did not go through says so in the sheet’s own words', async () => {
    const native = bridge()
    native.approval.accept.mockRejectedValueOnce(new Error('matrix_approval_stale'))
    sheet({ role: 'approve', state: 'asked', since: 1, deviceName: 'iPhone mẫu' })

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Đúng, là tôi' }))
    expect(await within(dialog).findByText('Chưa làm được. Hãy thử lại.')).toBeTruthy()
    expect(within(dialog).queryByText('Chưa nhận được khóa từ máy kia.')).toBeNull()
  })

  it('after the right code, hides the rows and says to confirm that code on the new device', async () => {
    const native = bridge()

    const { unmount } = sheet(
      { role: 'approve', state: 'compare', since: 1, deviceName: 'Atum · Mac mini', picked: true },
      'en'
    )

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Now tap “I picked this code” on Atum · Mac mini.')).toBeTruthy()
    expect(within(dialog).queryAllByRole('button', { name: /^1036, / })).toHaveLength(0)
    expect(within(dialog).queryByRole('button', { name: 'None of these match' })).toBeNull()
    // "This wasn't me" stays until it finishes.
    expect(within(dialog).getByRole('button', { name: 'This wasn’t me' })).toBeTruthy()
    expect(native.approval.pick).not.toHaveBeenCalled()
    unmount()

    // A device without a name of its own, in Vietnamese.
    sheet({ role: 'approve', state: 'compare', since: 1, picked: true })
    expect(await screen.findByText('Giờ hãy bấm “Tôi đã chọn mã này” trên máy đó.')).toBeTruthy()
  })

  it('a comparison that took too long says so calmly, and Try again compares again', async () => {
    const native = bridge()
    sheet({ role: 'approve', state: 'timeout', since: 1, deviceName: 'Atum · Mac mini' }, 'en')

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('That took too long — try again.')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(native.approval.retry).toHaveBeenCalledOnce())
    expect(within(dialog).queryByRole('button', { name: 'Sign that device out' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(native.approval.dismiss).toHaveBeenCalledOnce())
  })

  it('stays closed on the new Mac itself and when nothing is asked', () => {
    bridge()
    sheet({ role: 'request', state: 'waiting', since: 1 })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('the new Mac: approved from another device, the key one quiet link away', () => {
  function panel(approval: MatrixApprovalView, locale: 'vi' | 'en' = 'vi') {
    return render(
      <I18nProvider configClient={null} initialLocale={locale}>
        <RecoveryKeyPanel intent="restore" launch snapshot={withApproval(approval)} />
      </I18nProvider>
    )
  }

  it('names the device to open, and says what it needs once the wait is slow', () => {
    vi.useFakeTimers()
    bridge()
    panel({ role: 'request', state: 'waiting', since: Date.now(), deviceName: 'Atum · MacBook Pro mẫu' })

    expect(screen.getByText('Mở Atum trên Atum · MacBook Pro mẫu. Một yêu cầu sẽ hiện ở đó.')).toBeTruthy()
    expect(screen.queryByText(/Chưa thấy máy kia trả lời/)).toBeNull()

    act(() => {
      vi.advanceTimersByTime(MATRIX_APPROVAL_SLOW_MS)
    })
    expect(screen.getByText('Chưa thấy máy kia trả lời. Máy đó cần đang bật, có mạng và mở Atum.')).toBeTruthy()
  })

  it('shows the complete standard three-part number code', () => {
    bridge()
    const { container } = panel({ role: 'request', state: 'compare', since: 1, numbers: SAS }, 'en')

    expect(screen.getByText('Open Atum on your other device and pick this number code within a minute:')).toBeTruthy()
    expect(screen.getByRole('group', { name: '1036, 4349, 6060' }).textContent).toBe('103643496060')
    expect(container.querySelectorAll('[data-matrix-approval-code] .atum-approval-number')).toHaveLength(3)
  })

  it('a new Mac with nothing to check against confirms only after the person picked its code', async () => {
    const native = bridge()
    const { unmount } = panel({ role: 'request', state: 'compare', since: 1, numbers: SAS }, 'en')

    // Confirmed by itself (it trusts the person's identity): nothing to tap.
    expect(screen.queryByRole('button', { name: 'I picked this code' })).toBeNull()
    expect(screen.queryByText(/tap “I picked this code” within a minute/)).toBeNull()
    unmount()

    // The tap has about a minute after the pick there, and the card says so in plain words.
    panel({ role: 'request', state: 'compare', since: 1, numbers: SAS, confirm: true }, 'en')
    expect(screen.getByText('Then come back and tap “I picked this code” within a minute.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'I picked this code' }))
    await waitFor(() => expect(native.approval.confirm).toHaveBeenCalledOnce())
  })

  it('says a key kept here stopped working because the account was changed elsewhere', () => {
    bridge()
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <RecoveryKeyPanel
          intent="restore"
          launch
          snapshot={{ ...base, security: { recovery: 'idle', storage: 'present', kept: true, keyStale: true } }}
        />
      </I18nProvider>
    )

    expect(
      screen.getByText(
        'Your account’s security was changed from another device or sign-in. If that wasn’t you, change your Google password.'
      )
    ).toBeTruthy()
    expect(screen.getByLabelText('Recovery key')).toBeTruthy()
  })

  it('offers Try again after a refusal or a timeout, and the key instead', async () => {
    const native = bridge()
    const late = panel({ role: 'request', state: 'timeout', since: 1 })

    // Calm: it just took too long.
    expect(screen.getByText('Mất quá lâu — hãy thử lại.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }))
    await waitFor(() => expect(native.approval.retry).toHaveBeenCalledOnce())
    late.unmount()

    panel({ role: 'request', state: 'mismatch', since: 1 })

    expect(screen.getByText('Không khớp, nên Mac này chưa được cho phép.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }))
    await waitFor(() => expect(native.approval.retry).toHaveBeenCalledTimes(2))

    fireEvent.click(screen.getByRole('button', { name: 'Dùng khóa khôi phục' }))
    expect(screen.getByLabelText('Khóa khôi phục')).toBeTruthy()
  })

  it('with no other device, asks for the key and says where it usually is', () => {
    bridge()
    panel({ role: 'request', state: 'waiting', since: Date.now() })

    fireEvent.click(screen.getByRole('button', { name: 'Tôi không còn máy nào khác' }))
    expect(screen.getByText(/thường trong trình quản lý mật khẩu hoặc ghi chú/)).toBeTruthy()
    expect(screen.getByLabelText('Khóa khôi phục')).toBeTruthy()
  })

  it('leaves the comparison to the approval, never to the generic verification prompt', () => {
    bridge()
    const snapshot = withApproval({ role: 'request', state: 'compare', since: 1, numbers: SAS })
    snapshot.security!.verification = {
      id: 'v',
      userId: base.identity!.userId,
      deviceId: 'ATUM_macbook',
      incoming: false,
      state: 'compare',
      decimals: SAS
    }

    const { container } = render(
      <I18nProvider configClient={null} initialLocale="en">
        <VerificationPrompt snapshot={snapshot} />
      </I18nProvider>
    )

    expect(container.textContent).toBe('')
  })
})
