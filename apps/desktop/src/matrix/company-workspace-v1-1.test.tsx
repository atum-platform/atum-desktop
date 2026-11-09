import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type {
  MatrixCompanyBridge,
  MatrixCompanyChannelDirectory11,
  MatrixCompanyDirectory11,
  MatrixCompanyInvitation11,
  MatrixCompanyRequest,
  MatrixCompanySnapshot11
} from '../../shared/matrix-company'

import { MatrixCompanyWorkspace } from './company-workspace'

afterEach(cleanup)

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', TestResizeObserver)

const company = { id: '00000000-0000-4000-8000-2a39c7cf131c', displayName: 'Atum Studio',
  role: 'admin' as const, authorityGeneration: 1 }

const companyId = company.id
const channelId = '00000000-0000-4000-8000-c52538d87a60'
const roomId = '!company-general:example.invalid'
const linhRef = 'nkYQgariaJkLsqK5DOjopVirD0bIPbklFbIRgDxrgew'
const baoRef = 'DBmU8tVC5nRl7iK9TD1_HUAMix4-Oxfk7bPM6--O_T8'
const chiRef = 'Qb4yOWEGhKxrTtmzGJA-6CVFxwxjxoEvcX3R2mHddaU'
const removedRef = 'zCKifP-gRbcTfvfkPTU5D2RQFZUXphRuXqmRiJNlDW4'
const selfRef = 'RiUVmyo5zEPwmNwDTzUkOZ9pssoNpuFAbofjwAsJyS8'
const noPending = () => Promise.resolve({ ok: true as const, request: null })

const directory11 = (companies = [company], invitations: MatrixCompanyInvitation11[] = [],
  canCreate = true): MatrixCompanyDirectory11 => ({ schemaVersion: 2, companies, invitations, canCreate })

const snapshot11 = (members: MatrixCompanySnapshot11['members'], defaultChannelId: string | null = channelId):
  MatrixCompanySnapshot11 => ({ schemaVersion: 2, company, members, projects: [], defaultChannelId })

const self = { memberRef: selfRef, role: 'admin' as const, state: 'active' as const, self: true,
  handle: 'minh', displayName: 'Minh' }

const linh = { memberRef: linhRef, role: 'member' as const, state: 'active' as const, self: false,
  handle: 'lan_nguyen', displayName: 'Lan Nguyễn' }

const channels11 = (ready = true): MatrixCompanyChannelDirectory11 => ({
  schemaVersion: 2,
  channels: [{
    schemaVersion: 2,
    channel: { id: channelId, companyId, displayName: 'general', visibility: 'company',
      state: ready ? 'active' : 'provisioning', projectId: null, authorityGeneration: 1,
      channelGeneration: 1, systemKey: 'default' },
    memberCount: 1,
    room: ready ? { state: 'ready', roomId } : { state: 'provisioning', roomId: null }
  }]
})

function renderWorkspace(props: Partial<ComponentProps<typeof MatrixCompanyWorkspace>> = {},
  locale: 'en' | 'vi' = 'vi') {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixCompanyWorkspace accountKey="account-a" bridge={props.bridge!} convergenceAttempts={6}
        convergenceDelayMs={5} ensureDefaultChannels={false} onOpenChannel={vi.fn(async () => {})}
        overviewFallback {...props} />
    </I18nProvider>
  )
}

async function openInvite() {
  fireEvent.keyDown(await screen.findByRole('button', { name: 'Atum Studio' }), { key: 'Enter' })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Mời đồng nghiệp' }))
}

describe('company workspace 1.1', () => {
  it('makes one company the page title and shows no switcher or creation form', async () => {
    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => {
        if (input.action === 'list') { return { ok: true as const, value: directory11() } }

        if (input.action === 'read') { return { ok: true as const, value: snapshot11([self]) } }

        if (input.action === 'list-channels') { return { ok: true as const, value: channels11() } }

        return { ok: false as const, error: 'invalid' as const }
      })
    }

    renderWorkspace({ bridge })
    expect(await screen.findByRole('heading', { name: 'Atum Studio' })).toBeTruthy()
    expect(screen.queryByRole('navigation', { name: 'Công ty của bạn' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Atum Studio · Quản trị viên' })).toBeNull()
    expect(screen.queryByLabelText('Tên công ty')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Làm mới' })).toBeNull()
  })

  it('shows the company switcher when a second company exists', async () => {
    const second = { ...company, id: '00000000-0000-4000-8000-345447196296', displayName: 'Lotus Co' }

    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => {
        if (input.action === 'list') { return { ok: true as const, value: directory11([company, second]) } }

        if (input.action === 'read') {
          return { ok: true as const, value: { ...snapshot11([self]), company: second } }
        }

        if (input.action === 'list-channels') { return { ok: true as const, value: channels11() } }

        return { ok: false as const, error: 'invalid' as const }
      })
    }

    renderWorkspace({ bridge })
    const trigger = await screen.findByRole('button', { name: 'Atum Studio' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(await screen.findByRole('menuitemradio', { name: 'Atum Studio · Quản trị viên' })).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: 'Lotus Co · Quản trị viên' })).toBeTruthy()
  })

  it('creates into the seeded default channel without a manual refresh', async () => {
    const requests: MatrixCompanyRequest[] = []
    let opens = 0
    const onOpenChannel = vi.fn(async () => { if (++opens === 1) {throw new Error('not synced')} })
    let channelReads = 0

    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => {
        requests.push(input)

        if (input.action === 'list') {
          return { ok: true as const, value: directory11(requests.some(entry => entry.action === 'create') ? [company] : []) }
        }

        if (input.action === 'create') {
          return { ok: true as const, value: snapshot11([self]) }
        }

        if (input.action === 'list-channels') {
          channelReads += 1

          return { ok: true as const, value: channels11(channelReads > 1) }
        }

        return { ok: false as const, error: 'invalid' as const }
      })
    }

    renderWorkspace({ bridge, onOpenChannel })
    fireEvent.click(await screen.findByRole('button', { name: 'Tạo công ty' }))
    const dialog = await screen.findByRole('dialog', { name: 'Công ty mới' })
    fireEvent.change(within(dialog).getByLabelText('Tên công ty'), { target: { value: 'Atum Studio' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tiếp' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Bỏ qua' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Bỏ qua' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Bỏ qua' }))
    expect(await screen.findByRole('button', { name: 'Mở # chung' })).toBeTruthy()
    expect(screen.queryByLabelText('Tên công ty')).toBeNull()
    // The first open throws (not yet synced), so wait for the retry itself, not just a call with roomId.
    await waitFor(() => expect(onOpenChannel).toHaveBeenCalledTimes(2), { timeout: 3000 })
    expect(onOpenChannel).toHaveBeenLastCalledWith(roomId, expect.any(Function))
    expect(requests.filter(entry => entry.action === 'create')).toHaveLength(1)
  })

  it('invites one @handle and reports the one normalized result', async () => {
    const requests: MatrixCompanyRequest[] = []

    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => {
        requests.push(input)

        if (input.action === 'list') { return { ok: true as const, value: directory11() } }

        if (input.action === 'read') { return { ok: true as const, value: snapshot11([self]) } }

        if (input.action === 'list-channels') { return { ok: true as const, value: channels11() } }

        if (input.action === 'invite') {
          return { ok: true as const, value: snapshot11([self,
            { memberRef: linhRef, role: 'member', state: 'invited', self: false,
              handle: 'lan_nguyen', displayName: null }]) }
        }

        return { ok: false as const, error: 'invalid' as const }
      })
    }

    renderWorkspace({ bridge })
    await screen.findByRole('heading', { name: 'Atum Studio' })
    await openInvite()
    fireEvent.change(screen.getByLabelText('Tên, @tên người dùng hoặc email'), { target: { value: '@Lan_Nguyen' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Thêm @lan_nguyen' }))
    expect(await screen.findByText('Đã mời @lan_nguyen. Họ sẽ thấy lời mời trong Atum.')).toBeTruthy()
    expect(requests).toContainEqual({ action: 'invite', companyId, requestId: expect.any(String),
      memberHandle: '@Lan_Nguyen', role: 'member' })
    expect(await screen.findByText('Đang mời')).toBeTruthy()
  })

  it('shows the same unavailable copy for every refused handle', async () => {
    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => {
        if (input.action === 'list') { return { ok: true as const, value: directory11() } }

        if (input.action === 'read') { return { ok: true as const, value: snapshot11([self]) } }

        if (input.action === 'list-channels') { return { ok: true as const, value: channels11() } }

        if (input.action === 'invite') { return { ok: false as const, error: 'missing' as const } }

        return { ok: false as const, error: 'invalid' as const }
      })
    }

    renderWorkspace({ bridge })
    await screen.findByRole('heading', { name: 'Atum Studio' })
    await openInvite()
    fireEvent.change(screen.getByLabelText('Tên, @tên người dùng hoặc email'), { target: { value: '@missing_person' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Thêm @missing_person' }))
    expect(await screen.findByText('Không tìm thấy người dùng này. Hãy kiểm tra lại tên người dùng.')).toBeTruthy()
  })

  it('keeps a 429 look-up limit calm and retryable', async () => {
    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => {
        if (input.action === 'list') { return { ok: true as const, value: directory11() } }

        if (input.action === 'read') { return { ok: true as const, value: snapshot11([self]) } }

        if (input.action === 'list-channels') { return { ok: true as const, value: channels11() } }

        if (input.action === 'invite') { return { ok: false as const, error: 'limit' as const } }

        return { ok: false as const, error: 'invalid' as const }
      })
    }

    renderWorkspace({ bridge })
    await screen.findByRole('heading', { name: 'Atum Studio' })
    await openInvite()
    fireEvent.change(screen.getByLabelText('Tên, @tên người dùng hoặc email'), { target: { value: '@lan_nguyen' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Thêm @lan_nguyen' }))
    expect(await screen.findByText('Bạn đã thử quá nhiều lần. Hãy thử lại sau ít phút.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeTruthy()
  })

  it('lists roles and states, cancels an invitation, and removes only after the confirm sheet', async () => {
    const requests: MatrixCompanyRequest[] = []
    let linhState: 'active' | 'revoking' = 'active'
    let baoState: 'invited' | 'revoking' = 'invited'

    const bao = { memberRef: baoRef, role: 'member' as const, state: baoState, self: false,
      handle: 'bao_tran', displayName: null }
    const chi = { memberRef: chiRef, role: 'member' as const, state: 'revoking' as const, self: false,
      handle: 'chi', displayName: 'Chi' }
    const removedMember = { memberRef: removedRef, role: 'member' as const, state: 'removed' as const,
      self: false, handle: null, displayName: null }

    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => {
        requests.push(input)

        if (input.action === 'list') { return { ok: true as const, value: directory11() } }

        if (input.action === 'read') {
          return { ok: true as const, value: snapshot11([self,
            { ...linh, state: linhState }, { ...bao, state: baoState }, chi, removedMember]) }
        }

        if (input.action === 'list-channels') { return { ok: true as const, value: channels11() } }

        if (input.action === 'remove-member') {
          if (input.memberRef === linhRef) {linhState = 'revoking'}

          if (input.memberRef === baoRef) {baoState = 'revoking'}

          return { ok: true as const, value: { schemaVersion: 2 as const, companyId,
            memberRef: input.memberRef, state: 'revoking' as const, authorityGeneration: 2 } }
        }

        return { ok: false as const, error: 'invalid' as const }
      })
    }

    renderWorkspace({ bridge })
    await screen.findByRole('heading', { name: 'Atum Studio' })
    expect(document.querySelector('[data-member-state="removed"]')).toBeNull()

    const invited = (await screen.findByText('@bao_tran')).closest('li')!
    expect(within(invited).getByText('Đang mời')).toBeTruthy()
    expect(within(invited).queryByRole('button', { name: 'Gỡ khỏi công ty' })).toBeNull()
    fireEvent.click(within(invited).getByRole('button', { name: 'Hủy lời mời' }))
    await waitFor(() => expect(requests).toContainEqual({ action: 'remove-member', companyId,
      requestId: expect.any(String), memberRef: baoRef }))
    await waitFor(() => {
      const current = screen.getByText('@bao_tran').closest('li')!

      expect(current.getAttribute('data-member-state')).toBe('revoking')
      expect(within(current).queryByRole('button')).toBeNull()
    })

    const revoking = screen.getByText('Chi').closest('li')!
    expect(within(revoking).getByText('Đang gỡ quyền')).toBeTruthy()
    expect(within(revoking).queryByRole('button')).toBeNull()

    const row = (await screen.findByText('Lan Nguyễn')).closest('li')!
    expect(within(row).getByText('Thành viên')).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: 'Gỡ khỏi công ty' }))
    expect(screen.getByText('Người này mất tin mới; tin cũ vẫn hiển thị.')).toBeTruthy()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Gỡ khỏi công ty' }))
    await waitFor(() => expect(requests).toContainEqual({ action: 'remove-member', companyId,
      requestId: expect.any(String), memberRef: linhRef }))
    await waitFor(() => {
      const current = screen.getByText('Lan Nguyễn').closest('li')!

      expect(current.getAttribute('data-member-state')).toBe('revoking')
    })
  })

  it('keeps a leave request until the acknowledgement says removed', async () => {
    let leaveCalls = 0

    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => {
        if (input.action === 'list') {
          return { ok: true as const, value: directory11(leaveCalls > 0 ? [] : [company]) }
        }

        if (input.action === 'read') { return { ok: true as const, value: snapshot11([self, linh]) } }

        if (input.action === 'list-channels') { return { ok: true as const, value: channels11() } }

        if (input.action === 'leave') {
          leaveCalls += 1

          return { ok: true as const, value: { schemaVersion: 2 as const, companyId, state: 'revoking' as const,
            retired: false, authorityGeneration: 2 } }
        }

        return { ok: false as const, error: 'invalid' as const }
      })
    }

    renderWorkspace({ bridge })
    await screen.findByRole('heading', { name: 'Atum Studio' })
    fireEvent.click(await screen.findByRole('button', { name: 'Rời công ty' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Rời' }))
    await waitFor(() => expect(leaveCalls).toBeGreaterThan(1))
    expect(await screen.findByText('Tạo công ty của bạn')).toBeTruthy()

    const leaves = (bridge.request as ReturnType<typeof vi.fn>).mock.calls
      .map(call => call[0] as MatrixCompanyRequest)
      .filter(entry => entry.action === 'leave')

    expect(new Set(leaves.map(entry => entry.requestId)).size).toBe(1)
  })

  it('warns the last active member that leaving closes the company', async () => {
    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => {
        if (input.action === 'list') { return { ok: true as const, value: directory11() } }

        if (input.action === 'read') { return { ok: true as const, value: snapshot11([self]) } }

        if (input.action === 'list-channels') { return { ok: true as const, value: channels11() } }

        return { ok: false as const, error: 'invalid' as const }
      })
    }

    renderWorkspace({ bridge })
    fireEvent.click(await screen.findByRole('button', { name: 'Rời công ty' }))
    expect(within(screen.getByRole('dialog')).getByText(
      'Công ty sẽ đóng khi thành viên cuối cùng rời đi. Muốn quay lại cần lời mời mới.'
    )).toBeTruthy()
  })

  it('shows the funded-wallet refusal inline with its tooltip and no workspace banner', async () => {
    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => {
        if (input.action === 'list') { return { ok: true as const, value: directory11() } }

        if (input.action === 'read') { return { ok: true as const, value: snapshot11([self]) } }

        if (input.action === 'list-channels') { return { ok: true as const, value: channels11() } }

        if (input.action === 'leave') {
          return { ok: false as const, error: 'conflict' as const, reason: 'company_wallet_not_empty' as const }
        }

        return { ok: false as const, error: 'invalid' as const }
      })
    }

    renderWorkspace({ bridge })
    fireEvent.click(await screen.findByRole('button', { name: 'Rời công ty' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rời' }))

    const refusal = await within(dialog).findByText('Ví công ty vẫn còn Protons, nên chưa thể rời công ty.')
    const alerts = screen.getAllByRole('alert')

    expect(alerts).toHaveLength(1)
    expect(dialog.contains(alerts[0]!)).toBe(true)
    fireEvent.pointerMove(refusal, { pointerType: 'mouse' })
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      'Hãy dùng hoặc chuyển Protons trước, hoặc nhờ một thành viên khác ở lại làm chủ sở hữu.'
    )
  })

  it('replays a pending leave after a restart without a user retry', async () => {
    const pendingLeave = { action: 'leave' as const, companyId,
      requestId: '00000000-0000-4000-8000-175097128f22' }

    let removed = false

    const bridge: MatrixCompanyBridge = {
      pending: vi.fn(async () => ({ ok: true as const, request: pendingLeave })),
      request: vi.fn(async input => {
        if (input.action === 'leave') {
          removed = true

          return { ok: true as const, value: { schemaVersion: 2 as const, companyId, state: 'removed' as const,
            retired: false, authorityGeneration: 3 } }
        }

        if (input.action === 'list') {
          return { ok: true as const, value: directory11(removed ? [] : [company]) }
        }

        return { ok: false as const, error: 'invalid' as const }
      })
    }

    renderWorkspace({ bridge })
    expect(await screen.findByText('Tạo công ty của bạn')).toBeTruthy()
    expect(bridge.request).toHaveBeenCalledWith(pendingLeave)
    expect(screen.queryByRole('button', { name: 'Thử lại' })).toBeNull()
  })

  it('degrades to the v1 wire and hides 1.1-only actions', async () => {
    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => {
        if (input.action === 'list') {
          return { ok: true as const, value: { schemaVersion: 1 as const, companies: [company], invitations: [] } }
        }

        if (input.action === 'read') {
          return { ok: true as const, value: { schemaVersion: 1 as const, company,
            members: [{ principal: '00000000-0000-4000-8000-0e2995a7c133', role: 'admin' as const, state: 'active' as const },
              { principal: '00000000-0000-4000-8000-3ce144c9fd70', role: 'member' as const, state: 'active' as const }],
            projects: [] } }
        }

        if (input.action === 'list-channels') {
          return { ok: true as const, value: { schemaVersion: 1 as const, channels: [] } }
        }

        return { ok: false as const, error: 'invalid' as const }
      })
    }

    renderWorkspace({ bridge }, 'en')
    await screen.findByRole('heading', { name: 'Atum Studio' })
    expect(document.querySelector('[data-matrix-company-members]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Leave company' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull()
  })

  it('shows no default encryption notice in the workspace sidebar', async () => {
    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => {
        if (input.action === 'list') { return { ok: true as const, value: directory11() } }

        if (input.action === 'read') { return { ok: true as const, value: snapshot11([self]) } }

        if (input.action === 'list-channels') { return { ok: true as const, value: channels11() } }

        return { ok: false as const, error: 'invalid' as const }
      })
    }

    renderWorkspace({ bridge })
    await screen.findByRole('heading', { name: 'Atum Studio' })
    expect(document.querySelector('[data-matrix-company-not-encrypted]')).toBeNull()
  })

  it('joins from the invitation banner and opens the default channel', async () => {
    let joined = false
    const onOpenChannel = vi.fn(async () => {})

    const invitation = { id: '00000000-0000-4000-8000-55301f2eb1d3',
      companyId: '00000000-0000-4000-8000-345447196296', displayName: 'Lotus Co',
      role: 'member' as const, inviter: { handle: 'minh', displayName: 'Minh' } }

    const bridge: MatrixCompanyBridge = {
      pending: noPending,
      request: vi.fn(async input => {
        if (input.action === 'list') {
          return { ok: true as const, value: directory11(joined ? [company] : [], joined ? [] : [invitation]) }
        }

        if (input.action === 'accept') {
          joined = true

          return { ok: true as const, value: snapshot11([{ ...self, role: 'member' as const }]) }
        }

        if (input.action === 'list-channels') { return { ok: true as const, value: channels11() } }

        return { ok: false as const, error: 'invalid' as const }
      })
    }

    renderWorkspace({ bridge, onOpenChannel })
    expect(await screen.findByText('Minh mời bạn vào công ty Lotus Co')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Tham gia' }))
    await waitFor(() => expect(onOpenChannel).toHaveBeenCalledWith(roomId, expect.any(Function)))
    expect((bridge.request as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0]))
      .toContainEqual({ action: 'accept', companyId: invitation.companyId,
        invitationId: invitation.id, requestId: expect.any(String) })
  })
})
