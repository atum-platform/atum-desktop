import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type {
  MatrixAgentRoutine,
  MatrixAgentRoutinesSnapshot,
  MatrixRoutineMutationResult
} from '../../../shared/agent-routines'
import type { MatrixAgentView, MatrixUiBridge } from '../../../shared/matrix'

import { assistantCardCopies } from './copy'
import { RoutinesRow } from './routines-panel'

const PRINCIPAL = '00000000-0000-4000-8000-af16785cab34'
const ROUTINE = '00000000-0000-4000-8000-c9f98e2c65c7'

function routine(overrides: Partial<MatrixAgentRoutine> = {}): MatrixAgentRoutine {
  return {
    id: ROUTINE,
    title: 'Bản tin sáng',
    instruction: 'Tóm tắt việc quan trọng hôm nay.',
    schedule: { kind: 'daily', hour: 8, minute: 0 },
    timezone: 'Asia/Ho_Chi_Minh',
    enabled: true,
    notifications: true,
    revision: 2,
    nextRunAt: Date.now() + 86_400_000,
    lastRun: null,
    ...overrides
  }
}

function snapshot(routines: MatrixAgentRoutine[], legacyState: MatrixAgentRoutinesSnapshot['legacyState'] = 'clear'): MatrixAgentRoutinesSnapshot {
  return {
    assistantId: '00000000-0000-4000-8000-5b3379da4cd1',
    assistantPrincipal: PRINCIPAL,
    serverTime: Date.now(),
    legacyState,
    routines
  }
}

const agent: MatrixAgentView = {
  principal: PRINCIPAL,
  userId: `@${PRINCIPAL}:atum.chat`,
  name: 'Lan',
  isDefault: false,
  ready: true,
  hermes: 'ready',
  atumModel: true,
  answering: 'cloud'
}

let routines: {
  read: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  runs: ReturnType<typeof vi.fn>
  ownerZone: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  routines = {
    read: vi.fn(async () => ({ ok: true, snapshot: snapshot([routine()]) })),
    create: vi.fn(async () => ({ ok: true, routine: routine() })),
    update: vi.fn(async () => ({ ok: true, routine: routine({ enabled: false, revision: 3 }) })),
    run: vi.fn(async () => ({ ok: true, routine: routine({ revision: 3 }) })),
    delete: vi.fn(async () => ({ ok: true, deleted: { id: ROUTINE, revision: 2 } })),
    runs: vi.fn(async () => ({ ok: true, snapshot: { routineId: ROUTINE, runs: [] } })),
    ownerZone: vi.fn(async () => undefined)
  }
  window.atumMatrix = { routines } as unknown as MatrixUiBridge
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'atumMatrix')
})

function renderRow(
  locale: 'vi' | 'en' = 'vi',
  options: { agent?: MatrixAgentView; onMoveToCloud?: () => void } = {}
) {
  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <RoutinesRow
        agent={options.agent ?? agent}
        copy={assistantCardCopies[locale]}
        locale={locale}
        onMoveToCloud={options.onMoveToCloud}
      />
    </I18nProvider>
  )
}

async function openPanel() {
  await waitFor(() => expect(screen.getByText('Lịch tự động')).toBeTruthy())
  fireEvent.click(screen.getByText('Lịch tự động'))
  await waitFor(() => expect(document.querySelector('[data-routines-panel]')).toBeTruthy())
}

async function openRoutine() {
  await openPanel()
  fireEvent.click(screen.getByText('Bản tin sáng'))
  await waitFor(() => expect(window.document.querySelector('[data-routine-dialog]')).toBeTruthy())
}

describe('Run now', () => {
  it('runs the saved routine directly when the form has no edits', async () => {
    renderRow()
    await openRoutine()

    fireEvent.click(window.document.querySelector('[data-routine-run]') as HTMLButtonElement)

    await waitFor(() =>
      expect(routines.run).toHaveBeenCalledWith({
        principal: PRINCIPAL,
        routineId: ROUTINE,
        expectedRevision: 2
      })
    )
    expect(routines.update).not.toHaveBeenCalled()
    expect(routines.create).not.toHaveBeenCalled()
  })

  it('saves valid edits once and runs the returned revision', async () => {
    routines.update.mockResolvedValue({
      ok: true,
      routine: routine({ instruction: 'Tóm tắt cả lịch hôm nay.', revision: 7 })
    })
    routines.run.mockResolvedValue({
      ok: true,
      routine: routine({ instruction: 'Tóm tắt cả lịch hôm nay.', revision: 7 })
    })
    renderRow()
    await openRoutine()

    fireEvent.change(window.document.querySelector('[data-routine-instruction]') as HTMLTextAreaElement, {
      target: { value: 'Tóm tắt cả lịch hôm nay.' }
    })
    expect((window.document.querySelector('[data-routine-run]') as HTMLButtonElement).textContent).toBe('Lưu và chạy ngay')
    fireEvent.click(window.document.querySelector('[data-routine-run]') as HTMLButtonElement)

    await waitFor(() =>
      expect(routines.update).toHaveBeenCalledWith(
        expect.objectContaining({
          routineId: ROUTINE,
          expectedRevision: 2,
          instruction: 'Tóm tắt cả lịch hôm nay.'
        })
      )
    )
    await waitFor(() =>
      expect(routines.run).toHaveBeenCalledWith({
        principal: PRINCIPAL,
        routineId: ROUTINE,
        expectedRevision: 7
      })
    )
    expect(routines.update.mock.invocationCallOrder[0]).toBeLessThan(routines.run.mock.invocationCallOrder[0]!)
  })

  it('names a server refusal as a run failure, never a save failure', async () => {
    routines.run.mockResolvedValue({ ok: false, error: 'invalid' })
    renderRow()
    await openRoutine()

    fireEvent.click(window.document.querySelector('[data-routine-run]') as HTMLButtonElement)

    await waitFor(() => expect(window.document.querySelector('[data-routine-notice="run-invalid"]')).toBeTruthy())
    expect(screen.getByText('Lịch đã lưu này không thể chạy.')).toBeTruthy()
    expect(screen.queryByText('Chưa lưu được. Thay đổi của bạn vẫn còn đây.')).toBeNull()
  })

  it('says the cloud is unreachable when Run now is offline', async () => {
    routines.run.mockResolvedValue({ ok: false, error: 'offline' })
    renderRow()
    await openRoutine()

    fireEvent.click(window.document.querySelector('[data-routine-run]') as HTMLButtonElement)

    await waitFor(() => expect(window.document.querySelector('[data-routine-notice="run-offline"]')).toBeTruthy())
    expect(screen.getByText('Không kết nối được với đám mây. Hãy thử chạy lại.')).toBeTruthy()
  })

  it('refreshes and retries one stale unchanged routine without another click', async () => {
    routines.run
      .mockResolvedValueOnce({ ok: false, error: 'conflict' })
      .mockResolvedValueOnce({ ok: true, routine: routine({ revision: 4 }) })
    routines.read
      .mockResolvedValueOnce({ ok: true, snapshot: snapshot([routine()]) })
      .mockResolvedValueOnce({ ok: true, snapshot: snapshot([routine({ revision: 3 })]) })
    renderRow()
    await openRoutine()

    fireEvent.click(window.document.querySelector('[data-routine-run]') as HTMLButtonElement)

    await waitFor(() => expect(routines.run).toHaveBeenCalledTimes(2))
    expect(routines.run.mock.calls[1]![0]).toMatchObject({ expectedRevision: 3 })
    expect(window.document.querySelector('[data-routine-notice="run-conflict"]')).toBeNull()
  })
})

describe('the routines row', () => {
  it('shows the count and every kind in plain words', async () => {
    routines.read.mockResolvedValue({
      ok: true,
      snapshot: snapshot([
        routine({ id: '00000000-0000-4000-8000-bd7662a5eeb4', title: 'Bản tin sáng' }),
        routine({
          id: '00000000-0000-4000-8000-b454f82c5857',
          title: 'Họp tuần',
          schedule: { kind: 'weekly', hour: 9, minute: 0, weekdays: [1, 3, 5] },
          nextRunAt: null,
          enabled: false
        }),
        routine({
          id: '00000000-0000-4000-8000-f6222a1106ee',
          title: 'Tổng kết tháng',
          schedule: { kind: 'monthly', day: 5, hour: 9, minute: 0 }
        }),
        routine({
          id: '00000000-0000-4000-8000-f1d11edf5c5c',
          title: 'Nhắc một lần',
          schedule: { kind: 'once', runAt: '2026-10-21T08:00:00.000Z' }
        }),
        routine({
          id: '00000000-0000-4000-8000-fbfe405ca65f',
          title: 'Kiểm tra hàng giờ',
          schedule: { kind: 'interval', everyHours: 2 }
        })
      ])
    })
    renderRow()

    await waitFor(() => expect(screen.getByText('5 việc')).toBeTruthy())
    await openPanel()

    expect(screen.getByText('Hằng ngày lúc 8:00')).toBeTruthy()
    expect(screen.getByText('Thứ 2, 4, 6 lúc 9:00')).toBeTruthy()
    expect(screen.getByText('Ngày 5 hằng tháng lúc 9:00')).toBeTruthy()
    expect(screen.getByText('Một lần, 21/10 15:00')).toBeTruthy()
    expect(screen.getByText('Mỗi 2 giờ')).toBeTruthy()
    expect(screen.getByText(/Đã tạm dừng/)).toBeTruthy()
  })

  it('renders the schedule in the row’s zone only when it differs from this device', async () => {
    const zone = 'Europe/Paris'

    routines.read.mockResolvedValue({ ok: true, snapshot: snapshot([routine({ timezone: zone })]) })
    renderRow()

    await waitFor(() => expect(screen.getByText('1 việc')).toBeTruthy())
    await openPanel()

    expect(screen.getByText(new RegExp(`\\(${zone}\\)`))).toBeTruthy()
  })

  it('sends a switch as enabled with the revision it read', async () => {
    routines.read.mockResolvedValue({ ok: true, snapshot: snapshot([routine({ title: 'Hỏi thăm' })]) })
    renderRow()
    await waitFor(() => expect(screen.getByText('1 việc')).toBeTruthy())
    await openPanel()

    fireEvent.click(screen.getByRole('switch'))

    await waitFor(() =>
      expect(routines.update).toHaveBeenCalledWith(
        expect.objectContaining({
          principal: PRINCIPAL,
          routineId: ROUTINE,
          expectedRevision: 2,
          enabled: false,
          notifications: true,
          title: 'Hỏi thăm'
        })
      )
    )
  })

  it('keeps the draft after a revision conflict and says so', async () => {
    routines.create.mockResolvedValue({ ok: false, error: 'conflict' } as MatrixRoutineMutationResult)
    renderRow()
    await waitFor(() => expect(screen.getByText('1 việc')).toBeTruthy())
    await openPanel()

    fireEvent.click(screen.getByText('Thêm lịch'))
    const instruction = document.querySelector('[data-routine-instruction]') as HTMLTextAreaElement
    fireEvent.change(instruction, { target: { value: 'Chuẩn bị bản tin cho ngày mai.' } })
    fireEvent.click(document.querySelector('[data-routine-save]') as HTMLButtonElement)

    await waitFor(() => expect(document.querySelector('[data-routine-notice="conflict"]')).toBeTruthy())
    expect((document.querySelector('[data-routine-instruction]') as HTMLTextAreaElement).value).toBe(
      'Chuẩn bị bản tin cho ngày mai.'
    )
    expect(document.querySelector('[data-routine-form]')).toBeTruthy()
  })

  it('keeps an interval or unknown kind in the list and read-only', async () => {
    routines.read.mockResolvedValue({
      ok: true,
      snapshot: snapshot([
        routine({
          id: '00000000-0000-4000-8000-bd7662a5eeb4',
          title: 'Mỗi hai giờ',
          schedule: { kind: 'interval', everyHours: 2 }
        }),
        routine({
          id: '00000000-0000-4000-8000-b454f82c5857',
          title: 'Lịch mới',
          schedule: { kind: 'unsupported', kindName: 'fortnightly' }
        })
      ])
    })
    renderRow()
    await waitFor(() => expect(screen.getByText('2 việc')).toBeTruthy())
    await openPanel()

    expect(screen.getByText('Mỗi hai giờ')).toBeTruthy()
    expect(screen.getByText('Lịch mới')).toBeTruthy()
    expect(screen.getAllByText(/Chỉ xem/)).toHaveLength(2)
    expect(screen.queryByRole('switch')).toBeNull()

    fireEvent.click(screen.getByText('Mỗi hai giờ'))
    expect(document.querySelector('[data-routine-form]')).toBeNull()
  })

  it('says it is moving old schedules and offers no add', async () => {
    routines.read.mockResolvedValue({ ok: true, snapshot: snapshot([routine()], 'present') })
    renderRow()
    await waitFor(() => expect(screen.getByText('1 việc')).toBeTruthy())
    await openPanel()

    expect(document.querySelector('[data-routines-legacy="present"]')).toBeTruthy()
    expect(screen.queryByText('Thêm lịch')).toBeNull()
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true)
  })

  it('fills the form from the empty state’s suggestion', async () => {
    routines.read.mockResolvedValue({ ok: true, snapshot: snapshot([]) })
    renderRow()
    await waitFor(() => expect(screen.getByText('Chưa có')).toBeTruthy())
    await openPanel()

    fireEvent.click(screen.getByText('Bản tin sáng'))

    expect((document.querySelector('[data-routine-instruction]') as HTMLTextAreaElement).value).toBe(
      'Tóm tắt những việc quan trọng hôm nay và gửi cho tôi.'
    )
  })

  it('offers a retry when the list cannot load', async () => {
    routines.read.mockResolvedValueOnce({ ok: false, error: 'offline' })
    renderRow()

    await waitFor(() => expect(screen.getByText('Thử lại')).toBeTruthy())
    fireEvent.click(screen.getByText('Lịch tự động'))
    expect(screen.getByText('Không tải được lịch tự động của Lan.')).toBeTruthy()

    fireEvent.click(screen.getAllByText('Thử lại').at(-1)!)
    await waitFor(() => expect(screen.getByText('1 việc')).toBeTruthy())
  })

  it('passes the bridge only a principal and a closed draft, never a credential', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    renderRow()
    await waitFor(() => expect(screen.getByText('1 việc')).toBeTruthy())
    await openPanel()

    fireEvent.click(screen.getByText('Thêm lịch'))
    fireEvent.change(document.querySelector('[data-routine-instruction]') as HTMLTextAreaElement, {
      target: { value: 'Nhắc tôi uống nước.' }
    })
    fireEvent.click(document.querySelector('[data-routine-save]') as HTMLButtonElement)

    await waitFor(() => expect(routines.create).toHaveBeenCalled())
    const call = routines.create.mock.calls[0]![0] as Record<string, unknown>

    expect(Object.keys(call).sort()).toEqual([
      'enabled',
      'instruction',
      'notifications',
      'principal',
      'schedule',
      'timezone',
      'title'
    ])
    expect(JSON.stringify(call)).not.toMatch(/token|authorization|bearer/iu)
    expect(fetch).not.toHaveBeenCalled()
    expect(routines.read).toHaveBeenCalledWith(PRINCIPAL)
  })
})

describe('the coordinator’s round-2 review', () => {
  it('renders and counts the authoritative Hỏi thăm routine exactly once', async () => {
    routines.read.mockResolvedValue({ ok: true, snapshot: snapshot([routine({ title: 'Hỏi thăm' })]) })
    renderRow('vi')
    await waitFor(() => expect(screen.getByText('1 việc')).toBeTruthy())
    await openPanel()

    const list = window.document.querySelector('[data-routines-list]') as HTMLElement

    expect(list.querySelectorAll('[data-routine-row]')).toHaveLength(1)
    expect(within(list).getByText('Hỏi thăm')).toBeTruthy()
    expect(window.document.querySelector('[data-routine-check-ins]')).toBeNull()
  })

  it('edits the clock with 24-hour hour and minute selects in every locale', async () => {
    renderRow('vi')
    await waitFor(() => expect(screen.getByText('1 việc')).toBeTruthy())
    await openPanel()
    fireEvent.click(screen.getByText('Thêm lịch'))
    fireEvent.change(document.querySelector('[data-routine-instruction]') as HTMLTextAreaElement, {
      target: { value: 'Nhắc tôi uống nước.' }
    })

    const hour = document.querySelector('[data-routine-hour]') as HTMLSelectElement
    const minute = document.querySelector('[data-routine-minute]') as HTMLSelectElement

    expect(hour.tagName).toBe('SELECT')
    expect(hour.value).toBe('8')
    expect(hour.options[8]!.textContent).toBe('08')
    expect(hour.options[23]!.textContent).toBe('23')
    expect(minute.options[30]!.textContent).toBe('30')
    expect(document.querySelector('input[type="time"]')).toBeNull()

    fireEvent.change(hour, { target: { value: '18' } })
    fireEvent.change(minute, { target: { value: '30' } })
    fireEvent.click(document.querySelector('[data-routine-save]') as HTMLButtonElement)

    await waitFor(() =>
      expect(routines.create).toHaveBeenCalledWith(expect.objectContaining({ schedule: { kind: 'daily', hour: 18, minute: 30 } }))
    )
  })

  it('has one footer, Hủy and Lưu, and no second Xong inside the form', async () => {
    renderRow()
    await waitFor(() => expect(screen.getByText('1 việc')).toBeTruthy())
    await openPanel()
    fireEvent.click(screen.getByText('Bản tin sáng'))

    const form = document.querySelector('[data-routine-form]') as HTMLElement
    const save = document.querySelector('[data-routine-save]') as HTMLButtonElement

    expect(within(form).queryByRole('button', { name: 'Xong' })).toBeNull()
    expect(within(form).getByRole('button', { name: 'Hủy' })).toBeTruthy()
    expect(save.disabled).toBe(true)
    expect(screen.getByText('Sửa lịch')).toBeTruthy()

    fireEvent.change(document.querySelector('[data-routine-instruction]') as HTMLTextAreaElement, {
      target: { value: 'Tóm tắt việc quan trọng hôm nay cho tôi.' }
    })
    expect(save.disabled).toBe(false)

    fireEvent.click(within(form).getByRole('button', { name: 'Hủy' }))
    expect(document.querySelector('[data-routine-form]')).toBeNull()
  })

  it('prefills the name and saves an edited one', async () => {
    routines.read.mockResolvedValue({ ok: true, snapshot: snapshot([routine({ title: 'Hỏi thăm' })]) })
    renderRow()
    await waitFor(() => expect(screen.getByText('1 việc')).toBeTruthy())
    await openPanel()
    fireEvent.click(screen.getByText('Hỏi thăm'))

    const name = document.querySelector('[data-routine-name]') as HTMLInputElement
    expect(name.value).toBe('Hỏi thăm')

    fireEvent.change(name, { target: { value: 'Bản tin tuần' } })
    fireEvent.click(document.querySelector('[data-routine-save]') as HTMLButtonElement)

    await waitFor(() => expect(routines.update).toHaveBeenCalledWith(expect.objectContaining({ title: 'Bản tin tuần' })))
  })

  it('falls back to the instruction’s first words when the name is empty', async () => {
    renderRow()
    await waitFor(() => expect(screen.getByText('1 việc')).toBeTruthy())
    await openPanel()
    fireEvent.click(screen.getByText('Thêm lịch'))
    fireEvent.change(document.querySelector('[data-routine-instruction]') as HTMLTextAreaElement, {
      target: { value: 'Nhắc tôi uống nước mỗi ngày.' }
    })

    expect((document.querySelector('[data-routine-name]') as HTMLInputElement).value).toBe('')
    fireEvent.click(document.querySelector('[data-routine-save]') as HTMLButtonElement)

    await waitFor(() =>
      expect(routines.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Nhắc tôi uống nước mỗi ngày.' }))
    )
  })

  it('offers delete in red ink with the full name and still confirms first', async () => {
    renderRow()
    await waitFor(() => expect(screen.getByText('1 việc')).toBeTruthy())
    await openPanel()
    fireEvent.click(screen.getByText('Bản tin sáng'))

    const remove = document.querySelector('[data-routine-delete]') as HTMLButtonElement
    expect(remove.textContent).toBe('Xóa lịch')
    expect(remove.className).toContain('text-destructive')

    fireEvent.click(remove)
    expect(routines.delete).not.toHaveBeenCalled()

    const confirmation = document.querySelector('[data-routine-delete-confirm]') as HTMLElement
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Xóa' }))

    await waitFor(() =>
      expect(routines.delete).toHaveBeenCalledWith(expect.objectContaining({ routineId: ROUTINE, expectedRevision: 2 }))
    )
  })

  it('says routines only run while the assistant answers in the cloud, with a way there', async () => {
    const onMoveToCloud = vi.fn()
    renderRow('vi', { agent: { ...agent, macRole: 'answering' }, onMoveToCloud })
    await waitFor(() => expect(screen.getByText('1 việc')).toBeTruthy())
    await openPanel()

    const panel = document.querySelector('[data-routines-panel]') as HTMLElement
    const warning = document.querySelector('[data-routines-cloud]') as HTMLElement

    expect(panel.firstElementChild).toBe(warning)
    expect(warning.textContent).toContain('Lịch chỉ chạy khi trợ lý trả lời trên đám mây.')
    fireEvent.click(screen.getByText('Chuyển lên đám mây'))
    expect(onMoveToCloud).toHaveBeenCalledOnce()
  })

  it('says nothing about the cloud while the cloud answers', async () => {
    renderRow('vi', { onMoveToCloud: vi.fn() })
    await waitFor(() => expect(screen.getByText('1 việc')).toBeTruthy())
    await openPanel()

    expect(document.querySelector('[data-routines-cloud]')).toBeNull()
  })
})

describe('the coordinator’s round-3 review', () => {
  it('creates a new routine in the owner’s zone rather than this device’s', async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      calendar: 'gregory',
      locale: 'en-US',
      numberingSystem: 'latn',
      timeZone: 'America/Los_Angeles'
    })
    routines.ownerZone.mockResolvedValue('Asia/Tokyo')
    renderRow()
    await waitFor(() => expect(screen.getByText('1 việc')).toBeTruthy())
    await openPanel()
    await waitFor(() => expect(routines.ownerZone).toHaveBeenCalled())
    await act(async () => {})

    fireEvent.click(screen.getByText('Thêm lịch'))
    fireEvent.change(document.querySelector('[data-routine-instruction]') as HTMLTextAreaElement, {
      target: { value: 'Nhắc tôi uống nước.' }
    })
    fireEvent.click(document.querySelector('[data-routine-save]') as HTMLButtonElement)

    await waitFor(() =>
      expect(routines.create).toHaveBeenCalledWith(expect.objectContaining({ timezone: 'Asia/Tokyo' }))
    )
    expect(routines.create).not.toHaveBeenCalledWith(expect.objectContaining({ timezone: 'America/Los_Angeles' }))
  })

  it('does not count an invalid draft as changed', async () => {
    renderRow()
    await waitFor(() => expect(screen.getByText('1 việc')).toBeTruthy())
    await openPanel()
    fireEvent.click(screen.getByText('Bản tin sáng'))

    const form = document.querySelector('[data-routine-form]') as HTMLElement
    const save = document.querySelector('[data-routine-save]') as HTMLButtonElement

    expect(form.getAttribute('data-routine-changed')).toBe('false')
    fireEvent.click(screen.getByText('Hằng tuần'))

    for (const day of [1, 2, 3, 4, 5]) {
      fireEvent.click(document.querySelector(`[data-routine-weekday="${day}"]`) as HTMLButtonElement)
    }

    expect(form.getAttribute('data-routine-changed')).toBe('false')
    expect(save.disabled).toBe(true)

    fireEvent.click(document.querySelector('[data-routine-weekday="2"]') as HTMLButtonElement)
    expect(form.getAttribute('data-routine-changed')).toBe('true')
    expect(save.disabled).toBe(false)
  })
})

describe('the coordinator’s round-4 review', () => {
  const macPolicy = {
    policy: {
      profile: 'atum.execution-policy/1',
      agentPrincipal: PRINCIPAL,
      revision: 1,
      source: 'saved',
      order: ['cloud', 'mac:00000000-0000-4000-8000-b454f82c5857'],
      disabled: []
    },
    status: {
      profile: 'atum.execution-status/1',
      agentPrincipal: PRINCIPAL,
      policyRevision: 1,
      asOf: Date.now(),
      state: 'working',
      current: 'mac:00000000-0000-4000-8000-b454f82c5857',
      desired: 'mac:00000000-0000-4000-8000-b454f82c5857',
      order: ['cloud', 'mac:00000000-0000-4000-8000-b454f82c5857'],
      disabled: [],
      destinations: {
        cloud: { state: 'ready', observedAt: Date.now() },
        'mac:00000000-0000-4000-8000-b454f82c5857': { state: 'working', observedAt: Date.now() }
      }
    },
    stale: false,
    deviceNames: {
      '00000000-0000-4000-8000-b454f82c5857': { displayName: "Example's MacBook Air", thisMac: true }
    }
  } as unknown as MatrixAgentView['executionPolicy']

  it('opens the edit dialog from a row and the add dialog from Thêm lịch', async () => {
    renderRow()
    await waitFor(() => expect(screen.getByText('1 việc')).toBeTruthy())
    await openPanel()

    fireEvent.click(screen.getByText('Bản tin sáng'))
    await waitFor(() => expect(document.querySelector('[data-routine-dialog]')).toBeTruthy())

    expect(screen.getByText('Sửa lịch')).toBeTruthy()
    expect(screen.getByText('Trợ lý tự làm việc này theo lịch, rồi nhắn kết quả cho bạn.')).toBeTruthy()
    expect((document.querySelector('[data-routine-runs-on]') as HTMLSelectElement).value).toBe('Đám mây')
    expect(document.querySelector('[data-routine-instruction]')).toBeTruthy()

    fireEvent.click(document.querySelector('[data-routine-cancel]') as HTMLButtonElement)
    await waitFor(() => expect(document.querySelector('[data-routine-dialog]')).toBeNull())

    fireEvent.click(screen.getByText('Thêm lịch'))
    await waitFor(() => expect(document.querySelector('[data-routine-dialog]')).toBeTruthy())
    expect(
      within(document.querySelector('[data-routine-dialog]') as HTMLElement).getByText('Thêm lịch')
    ).toBeTruthy()
  })

  it('closes on Hủy without writing anything', async () => {
    renderRow()
    await waitFor(() => expect(screen.getByText('1 việc')).toBeTruthy())
    await openPanel()
    fireEvent.click(screen.getByText('Thêm lịch'))
    fireEvent.change(document.querySelector('[data-routine-instruction]') as HTMLTextAreaElement, {
      target: { value: 'Nhắc tôi uống nước.' }
    })

    fireEvent.click(document.querySelector('[data-routine-cancel]') as HTMLButtonElement)

    await waitFor(() => expect(document.querySelector('[data-routine-dialog]')).toBeNull())
    expect(routines.create).not.toHaveBeenCalled()
    expect(routines.update).not.toHaveBeenCalled()
  })

  it('saves the Đang bật switch from the dialog', async () => {
    renderRow()
    await waitFor(() => expect(screen.getByText('1 việc')).toBeTruthy())
    await openPanel()
    fireEvent.click(screen.getByText('Bản tin sáng'))

    const toggle = document.querySelector('[data-routine-enabled-toggle]') as HTMLElement
    fireEvent.click(toggle)
    fireEvent.click(document.querySelector('[data-routine-save]') as HTMLButtonElement)

    await waitFor(() =>
      expect(routines.update).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, routineId: ROUTINE }))
    )
  })

  it('shows Lặp lại but keeps it disabled until interval ships', async () => {
    renderRow()
    await waitFor(() => expect(screen.getByText('1 việc')).toBeTruthy())
    await openPanel()
    fireEvent.click(screen.getByText('Thêm lịch'))

    const repeat = screen.getByRole('radio', { name: /Lặp lại/ }) as HTMLButtonElement

    expect(repeat.disabled).toBe(true)
    expect(repeat.textContent).toContain('Sắp có')
    expect(screen.getByRole('radio', { name: 'Vào lúc' }).getAttribute('aria-checked')).toBe('true')
  })

  it('names the Mac it runs on and offers the way to the cloud', async () => {
    const onMoveToCloud = vi.fn()
    renderRow('vi', {
      agent: { ...agent, macRole: 'answering', executionPolicy: macPolicy },
      onMoveToCloud
    })
    await waitFor(() => expect(screen.getByText('1 việc')).toBeTruthy())
    await openPanel()
    fireEvent.click(screen.getByText('Thêm lịch'))

    const runsOn = document.querySelector('[data-routine-runs-on]') as HTMLSelectElement

    expect(runsOn.value).toContain('MacBook Air')
    expect(runsOn.value).toContain('(máy này)')
    expect(document.querySelector('[data-routine-cloud-note]')?.textContent).toContain(
      'Lịch chỉ chạy khi trợ lý trả lời trên đám mây.'
    )

    fireEvent.click(within(document.querySelector('[data-routine-dialog]') as HTMLElement).getByText('Chuyển lên đám mây'))
    expect(onMoveToCloud).toHaveBeenCalledOnce()
  })

  it('keeps Chạy ngay and the collapsed history below the form', async () => {
    routines.runs.mockResolvedValue({
      ok: true,
      snapshot: {
        routineId: ROUTINE,
        runs: [
          {
            occurrenceId: '00000000-0000-4000-8000-e8d95748107a',
            scheduledAt: Date.now() - 86_400_000,
            state: 'completed',
            outcome: 'answered',
            publishedEvent: '$routine-result'
          }
        ]
      }
    })
    renderRow()
    await waitFor(() => expect(screen.getByText('1 việc')).toBeTruthy())
    await openPanel()
    fireEvent.click(screen.getByText('Bản tin sáng'))

    const dialog = document.querySelector('[data-routine-dialog]') as HTMLElement
    const history = dialog.querySelector('[data-routine-history]') as HTMLDetailsElement

    expect(within(dialog).getByText('Chạy ngay')).toBeTruthy()
    expect(history.tagName).toBe('DETAILS')
    expect(history.hasAttribute('open')).toBe(false)
    await waitFor(() => expect(history.querySelector('[data-routine-runs]')).toBeTruthy())
    expect(dialog.querySelector('[data-routine-delete]')?.textContent).toBe('Xóa lịch')
  })
})
